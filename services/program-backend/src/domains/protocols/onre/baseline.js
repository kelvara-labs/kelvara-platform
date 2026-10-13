import { encodeBase58 } from "../../../platform/solana/base58.js";

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function decimalString(raw, decimals) {
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, "") : "";
  return fraction ? `${whole}.${fraction}` : whole;
}

function requireAccount(account, owner, minimumLength) {
  if (!account || account.owner !== owner) throw new Error(`unexpected_account_owner:${account?.owner || "missing"}`);
  if (!(account.data instanceof Uint8Array) || account.data.length < minimumLength) throw new Error("account_data_too_short");
}

export function decodeUpgradeableProgram(account) {
  requireAccount(account, UPGRADEABLE_LOADER, 36);
  if (account.data.readUInt32LE(0) !== 2) throw new Error("not_upgradeable_program_state");
  if (!account.executable) throw new Error("program_not_executable");
  return { programDataAddress: encodeBase58(account.data.subarray(4, 36)), loader: account.owner, executable: true };
}

export function decodeProgramData(account) {
  requireAccount(account, UPGRADEABLE_LOADER, 13);
  if (account.data.readUInt32LE(0) !== 3) throw new Error("not_programdata_state");
  const deploymentSlotBig = account.data.readBigUInt64LE(4);
  if (deploymentSlotBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("deployment_slot_unsafe_integer");
  const option = account.data[12];
  if (option !== 0 && option !== 1) throw new Error("invalid_upgrade_authority_option");
  if (option === 1 && account.data.length < 45) throw new Error("programdata_authority_truncated");
  const upgradeAuthority = option === 1 ? encodeBase58(account.data.subarray(13, 45)) : null;
  return { deploymentSlot: Number(deploymentSlotBig), upgradeAuthority, immutable: upgradeAuthority === null };
}

function decodeCOptionKey(data, offset) {
  const option = data.readUInt32LE(offset);
  if (option !== 0 && option !== 1) throw new Error("invalid_coption_pubkey");
  return option === 1 ? encodeBase58(data.subarray(offset + 4, offset + 36)) : null;
}

export function decodeSplMint(account) {
  requireAccount(account, TOKEN_PROGRAM, 82);
  const rawSupply = account.data.readBigUInt64LE(36).toString();
  const decimals = account.data[44];
  return {
    rawSupply,
    decimals,
    supply: decimalString(rawSupply, decimals),
    initialized: account.data[45] === 1,
    mintAuthority: decodeCOptionKey(account.data, 0),
    freezeAuthority: decodeCOptionKey(account.data, 46),
    tokenProgram: account.owner,
  };
}

function normalizedFingerprint(value) {
  return JSON.stringify({
    program: value.program,
    token: value.token,
  });
}

export async function buildOnreBaseline({ programId, mint, rpcs, observedAt }) {
  const sources = await Promise.all(rpcs.map(async rpc => {
    try {
      const programAccount = await rpc.getAccount(programId);
      const program = decodeUpgradeableProgram(programAccount);
      const [programDataAccount, mintAccount] = await Promise.all([
        rpc.getAccount(program.programDataAddress),
        rpc.getAccount(mint),
      ]);
      return {
        name: rpc.name,
        status: "ok",
        value: {
          program: { programId, ...program, ...decodeProgramData(programDataAccount), sourceSlot: programAccount.slot },
          token: { mint, ...decodeSplMint(mintAccount), sourceSlot: mintAccount.slot },
        },
      };
    } catch (error) {
      return { name: rpc.name, status: "failed", error: error.message };
    }
  }));
  const successful = sources.filter(source => source.status === "ok");
  if (!successful.length) throw new Error("all_rpc_sources_failed");
  const agreement = new Set(successful.map(source => normalizedFingerprint(source.value))).size === 1;
  const sourceStatus = successful.length < sources.length
    ? "degraded"
    : !agreement
      ? "disagreement"
      : successful.length < 2
        ? "single_source"
        : "verified";
  const controlStatus = sourceStatus === "verified" ? "active" : "degraded";
  return {
    protocol: "ONRE",
    observedAt,
    sourceStatus,
    sources: sources.map(({ value, ...source }) => source),
    program: successful[0].value.program,
    token: successful[0].value.token,
    conclusion: sourceStatus === "verified" ? "No monitored control condition is currently breached." : "Control state requires review because sources did not fully agree.",
    monitors: [
      { id: "program-control", status: controlStatus, reason: sourceStatus === "verified" ? "program and ProgramData decoded; RPC sources agree" : `RPC source status: ${sourceStatus}` },
      { id: "token-control", status: controlStatus, reason: sourceStatus === "verified" ? "mint authorities and supply decoded; RPC sources agree" : `RPC source status: ${sourceStatus}` },
      { id: "protocol-nav", status: "unavailable", reason: "NAV source not yet attached and freshness-verified" },
      { id: "market-price", status: "unavailable", reason: "market source not yet attached and freshness-verified" },
      { id: "capital-movement", status: "unavailable", reason: "capital accounts not yet verified for this baseline" },
      { id: "assisted-exit", status: "unavailable", reason: "canonical holder exit path not yet verified" },
    ],
  };
}

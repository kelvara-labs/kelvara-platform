import { createHash } from "node:crypto";
import { encodeBase58 } from "../../src/platform/solana/base58.js";
import { ONRE_PROGRAM_ID, ONYC_MINT } from "../../src/domains/discovery/wallet.js";

const BASE_TIME = 1_795_000_000;
const BASE_SLOT = 1000;
const AUTHORITY_A = "11111111111111111111111111111111";
const AUTHORITY_B = "SysvarRent111111111111111111111111111111111";
const VAULT = "SysvarC1ock11111111111111111111111111111111";
const CONFIG = "SysvarRecentB1ockHashes11111111111111111111";
const SIGNER = "Vote111111111111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const FIXTURE_HOLDER = "4g7kC6haaE6MzUx428DRdfrgHmwo7Sj5XYAqkx4ys3Rt";
export const FIXTURE_TOKEN_ACCOUNT = "FrnmPoRJ33vJhDd68jCQt7nMiV6gRsrjvTHoM5JtzNzx";

export const fixtureScenarios = Object.freeze([
  "upgrade-authority-transfer", "upgrade-authority-remove", "mint-authority-transfer",
  "freeze-authority-change", "supply-increase", "nav-jump", "nav-stale", "vault-outflow",
  "first-seen-destination", "pause", "redemption-failure", "multi-condition-incident",
]);

function bytes(label, length) {
  const output = Buffer.alloc(length); let offset = 0; let counter = 0;
  while (offset < length) { const digest = createHash("sha256").update(`${label}:${counter++}`).digest(); const size = Math.min(digest.length, length - offset); digest.copy(output, offset, 0, size); offset += size; }
  return output;
}
function signature(label) { return encodeBase58(bytes(label, 64)); }
function instructionData(name) { return encodeBase58(bytes(`instruction:${name}`, 16)); }
function clone(value) { return structuredClone(value); }
function decodeBase58(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let number = 0n;
  for (const char of value) { const digit = alphabet.indexOf(char); if (digit < 0) throw new Error("invalid_base58"); number = number * 58n + BigInt(digit); }
  const output = []; while (number > 0n) { output.push(Number(number % 256n)); number /= 256n; } output.reverse();
  let leading = 0; while (value[leading] === "1") leading += 1;
  return Buffer.from([...new Array(leading).fill(0), ...output]);
}
function binaryAccount(owner, data, executable = false) { return { data: [data.toString("base64"), "base64"], executable, lamports: 1_000_000, owner, rentEpoch: 0, space: data.length }; }
function programBinary() { const data = Buffer.alloc(36); data.writeUInt32LE(2, 0); decodeBase58(CONFIG).copy(data, 4); return data; }
function programDataBinary(state) { const present = state.program.upgradeAuthority !== null; const data = Buffer.alloc(present ? 45 : 13); data.writeUInt32LE(3, 0); data.writeBigUInt64LE(BigInt(state.program.deploymentSlot), 4); data[12] = present ? 1 : 0; if (present) decodeBase58(state.program.upgradeAuthority).copy(data, 13); return data; }
function mintBinary(state) { const data = Buffer.alloc(82); data.writeUInt32LE(state.token.mintAuthority ? 1 : 0, 0); if (state.token.mintAuthority) decodeBase58(state.token.mintAuthority).copy(data, 4); data.writeBigUInt64LE(BigInt(state.token.rawSupply), 36); data[44] = state.token.decimals; data[45] = 1; data.writeUInt32LE(state.token.freezeAuthority ? 1 : 0, 46); if (state.token.freezeAuthority) decodeBase58(state.token.freezeAuthority).copy(data, 50); return data; }
function tokenAccountValue(state) { return { data: { program: "spl-token", parsed: { type: "account", info: { mint: ONYC_MINT, owner: FIXTURE_HOLDER, tokenAmount: { amount: state.fixtureHolder.rawAmount, decimals: state.token.decimals, uiAmountString: state.fixtureHolder.amount } } }, space: 165 }, executable: false, lamports: 2_039_280, owner: TOKEN_PROGRAM, rentEpoch: 0 }; }

function transaction(name, slot, blockTime, state) {
  const sig = signature(`${slot}:${name}`);
  return { signature: sig, slot, blockTime, err: null, memo: null, confirmationStatus: "confirmed", mode: "fixture_simulation", scenario: name, transaction: { slot, blockTime, meta: { err: null, fee: 5000, preBalances: [10_000_000, 1_000_000], postBalances: [9_995_000, 1_000_000], innerInstructions: [], logMessages: [`Program ${ONRE_PROGRAM_ID} invoke [1]`, `Program log: PROTOCOL_FIXTURE:${name}`, `Program ${ONRE_PROGRAM_ID} success`], preTokenBalances: [], postTokenBalances: [], rewards: [], status: { Ok: null } }, transaction: { signatures: [sig], message: { accountKeys: [{ pubkey: SIGNER, signer: true, writable: true, source: "transaction" }, { pubkey: ONRE_PROGRAM_ID, signer: false, writable: false, source: "transaction" }, { pubkey: CONFIG, signer: false, writable: true, source: "transaction" }], recentBlockhash: signature(`block:${slot}`).slice(0, 44), instructions: [{ program: "protocol-fixture", programId: ONRE_PROGRAM_ID, parsed: { type: name, info: { mode: "fixture_simulation", stateVersion: state.version } }, data: instructionData(name), accounts: [CONFIG] }] } }, version: "legacy" } };
}

function baseline() {
  const state = { label: "fixture-only-not-chain-data", mode: "fixture_simulation", cluster: "devnet", slot: BASE_SLOT, blockTime: BASE_TIME, version: 1,
    program: { programId: ONRE_PROGRAM_ID, upgradeAuthority: AUTHORITY_A, immutable: false, deploymentSlot: BASE_SLOT },
    token: { mint: ONYC_MINT, mintAuthority: AUTHORITY_A, freezeAuthority: AUTHORITY_A, rawSupply: "100000000000000", decimals: 6 },
    protocol: { nav: 1, navUpdatedAt: new Date(BASE_TIME * 1000).toISOString(), vault: VAULT, vaultRawBalance: "50000000000000", lastDestination: VAULT, paused: false, redemptionHealthy: true },
    fixtureHolder: { wallet: FIXTURE_HOLDER, tokenAccount: FIXTURE_TOKEN_ACCOUNT, mint: ONYC_MINT, rawAmount: "1000000000000", amount: "1000000" }, transactions: [] };
  state.transactions.push(transaction("baseline", BASE_SLOT, BASE_TIME, state)); return state;
}

function mutate(state, name) {
  switch (name) {
    case "upgrade-authority-transfer": state.program.upgradeAuthority = AUTHORITY_B; break;
    case "upgrade-authority-remove": state.program.upgradeAuthority = null; state.program.immutable = true; break;
    case "mint-authority-transfer": state.token.mintAuthority = AUTHORITY_B; break;
    case "freeze-authority-change": state.token.freezeAuthority = AUTHORITY_B; break;
    case "supply-increase": state.token.rawSupply = "110000000000000"; break;
    case "nav-jump": state.protocol.nav = 1.25; break;
    case "nav-stale": state.protocol.navUpdatedAt = "2026-11-14T22:13:20.000Z"; break;
    case "vault-outflow": state.protocol.vaultRawBalance = "25000000000000"; break;
    case "first-seen-destination": state.protocol.lastDestination = AUTHORITY_B; break;
    case "pause": state.protocol.paused = true; break;
    case "redemption-failure": state.protocol.redemptionHealthy = false; break;
    case "multi-condition-incident": state.protocol.paused = true; state.protocol.redemptionHealthy = false; state.protocol.vaultRawBalance = "10000000000000"; break;
    default: throw new Error("unknown_scenario");
  }
}

export function createFixtureLab() {
  let state = baseline();
  function snapshot() { return clone(state); }
  function evidence() { return { id: `fixture-evidence:${state.slot}:${state.version}`, mode: state.mode, cluster: state.cluster, observedAt: new Date(state.blockTime * 1000).toISOString(), slot: state.slot, source: { id: "protocol-fixture-lab", type: "fixture_rpc" }, uncertainty: "fixture_only", value: { ...clone(state.program), ...clone(state.token), ...clone(state.protocol) } }; }
  return {
    snapshot, evidence,
    reset() { state = baseline(); return snapshot(); },
    trigger(name) { if (!fixtureScenarios.includes(name)) throw new Error("unknown_scenario"); state.slot += 1; state.blockTime += 1; state.version += 1; mutate(state, name); state.transactions.push(transaction(name, state.slot, state.blockTime, state)); return { scenario: name, state: snapshot(), transaction: clone(state.transactions.at(-1)) }; },
    signatures(options = {}) { const limit = options.limit ?? 1000; const beforeIndex = options.before ? state.transactions.findIndex(row => row.signature === options.before) : state.transactions.length; const end = beforeIndex < 0 ? state.transactions.length : beforeIndex; return state.transactions.slice(0, end).reverse().slice(0, limit).map(({ signature: sig, slot, blockTime, err, memo, confirmationStatus }) => ({ signature: sig, slot, blockTime, err, memo, confirmationStatus })); },
    transaction(sig) { return clone(state.transactions.find(row => row.signature === sig)?.transaction ?? null); },
    tokenAccounts(wallet, programId) { return wallet === FIXTURE_HOLDER && programId === TOKEN_PROGRAM ? [{ pubkey: FIXTURE_TOKEN_ACCOUNT, account: tokenAccountValue(state) }] : []; },
    account(address, encoding) { if (address === FIXTURE_TOKEN_ACCOUNT && encoding === "jsonParsed") return tokenAccountValue(state); if (address === ONRE_PROGRAM_ID) return binaryAccount("BPFLoaderUpgradeab1e11111111111111111111111", programBinary(), true); if (address === CONFIG) return binaryAccount("BPFLoaderUpgradeab1e11111111111111111111111", programDataBinary(state)); if (address === ONYC_MINT) return binaryAccount(TOKEN_PROGRAM, mintBinary(state)); return null; },
    programAccounts() { return [{ pubkey: CONFIG, account: binaryAccount(ONRE_PROGRAM_ID, bytes("config", 128)) }, { pubkey: VAULT, account: binaryAccount(ONRE_PROGRAM_ID, bytes("vault", 128)) }]; },
  };
}

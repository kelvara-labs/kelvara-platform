export const ONYC_MINT = "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5";
export const ONRE_PROGRAM_ID = "onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = 58n;

function decodeBase58(value) {
  let number = 0n;
  for (const char of value) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error("invalid base58");
    number = number * BASE + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.push(Number(number % 256n));
    number /= 256n;
  }
  bytes.reverse();
  let leading = 0;
  while (leading < value.length && value[leading] === "1") leading += 1;
  return new Uint8Array([...new Array(leading).fill(0), ...bytes]);
}

export function validateSolanaAddress(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  try { return decodeBase58(value).length === 32; } catch { return false; }
}

function decimalString(raw, decimals) {
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, "") : "";
  return fraction ? `${whole}.${fraction}` : whole;
}

function normalizeRows(rows, wallet) {
  return rows
    .filter(row => row?.parsed?.owner === wallet)
    .map(row => ({ ...row, parsed: { ...row.parsed, amount: String(row.parsed.amount), decimals: Number(row.parsed.decimals) } }))
    .sort((a, b) => a.pubkey.localeCompare(b.pubkey));
}

function fingerprint(rows, wallet) {
  return JSON.stringify(normalizeRows(rows, wallet).map(row => [row.pubkey, row.program, row.parsed.mint, row.parsed.amount, row.parsed.decimals]));
}

export async function discoverWallet(wallet, { rpcs, tokenPrograms }) {
  if (!validateSolanaAddress(wallet)) throw new Error("invalid_wallet");
  const sources = await Promise.all(rpcs.map(async rpc => {
    try {
      const batches = await Promise.all(tokenPrograms.map(program => rpc.getTokenAccounts(wallet, program)));
      return { name: rpc.name, status: "ok", rows: batches.flat() };
    } catch (error) {
      return { name: rpc.name, status: "failed", error: error.message, rows: [] };
    }
  }));
  const successful = sources.filter(source => source.status === "ok");
  if (successful.length === 0) throw new Error("all_rpc_sources_failed");
  const fingerprints = new Set(successful.map(source => fingerprint(source.rows, wallet)));
  const sourceStatus = successful.length < sources.length
    ? "degraded"
    : fingerprints.size > 1
      ? "disagreement"
      : successful.length < 2
        ? "single_source"
        : "verified";
  const selectedRows = normalizeRows(successful[0].rows, wallet);
  const onyc = selectedRows.filter(row => row.parsed.mint === ONYC_MINT && BigInt(row.parsed.amount) > 0n);
  let positions = [];
  if (onyc.length) {
    const decimals = onyc[0].parsed.decimals;
    const consistentDecimals = onyc.every(row => row.parsed.decimals === decimals);
    if (!consistentDecimals) throw new Error("onyc_decimals_disagreement");
    const raw = onyc.reduce((sum, row) => sum + BigInt(row.parsed.amount), 0n).toString();
    positions = [{
      id: `onyc:${wallet}`,
      asset: "ONYC",
      mint: ONYC_MINT,
      rawAmount: raw,
      decimals,
      amount: decimalString(raw, decimals),
      tokenAccounts: onyc.map(row => ({ address: row.pubkey, program: row.program, rawAmount: row.parsed.amount })),
      protocol: { id: "onre", name: "ONRE", programId: ONRE_PROGRAM_ID },
      relationship: { confidence: "verified-registry", evidence: "exact ONYC mint matched curated ONRE registry" },
      coverage: sourceStatus === "verified" ? "supported" : "degraded",
    }];
  }
  return { wallet, sourceStatus, sources: sources.map(({ rows, ...source }) => source), positions };
}

export async function discoverAddress(address, options) {
  if (!validateSolanaAddress(address)) throw new Error("invalid_wallet");
  if (address === ONYC_MINT) {
    return {
      inputAddress: address,
      inputType: "monitored_mint",
      wallet: null,
      sourceStatus: "registry",
      sources: [],
      positions: [],
      monitoredAsset: {
        asset: "ONYC",
        mint: ONYC_MINT,
        protocol: { id: "onre", name: "ONRE", programId: ONRE_PROGRAM_ID },
        relationship: { confidence: "verified-registry", evidence: "exact mint matched curated registry" },
      },
    };
  }
  const resolutions = await Promise.all(options.rpcs.map(async rpc => {
    try {
      return { status: "ok", account: await rpc.getTokenAccount(address) };
    } catch {
      return { status: "failed", account: null };
    }
  }));
  const tokenAccount = resolutions.find(result => result.account?.parsed?.mint === ONYC_MINT)?.account;
  const wallet = tokenAccount?.parsed?.owner || address;
  const discovery = await discoverWallet(wallet, options);
  return {
    ...discovery,
    inputAddress: address,
    inputType: tokenAccount ? "token_account" : "wallet",
  };
}

const DEFAULTS = Object.freeze({
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
});

function rpcList(value) {
  return (value ?? "").split(",").map(item => item.trim()).filter(Boolean);
}

function validateUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("invalid_rpc_url");
  }
  if (!new Set(["https:", "http:"]).has(url.protocol)) throw new TypeError("invalid_rpc_url_protocol");
  return url;
}

function checkKnownMismatch(cluster, url) {
  const host = url.hostname.toLowerCase();
  if (cluster === "devnet" && host.includes("mainnet")) throw new TypeError("cluster_rpc_mismatch");
  if (cluster === "mainnet-beta" && host.includes("devnet")) throw new TypeError("cluster_rpc_mismatch");
}

export function networkProfile(env = process.env) {
  const cluster = env.KELVARA_NETWORK || "mainnet-beta";
  if (!(cluster in DEFAULTS)) throw new TypeError("unsupported_network");
  const variable = cluster === "devnet" ? "KELVARA_DEVNET_RPC_URLS" : "KELVARA_MAINNET_RPC_URLS";
  const configured = rpcList(env[variable]);
  const rpcUrls = configured.length ? configured : [DEFAULTS[cluster]];
  for (const value of rpcUrls) checkKnownMismatch(cluster, validateUrl(value));
  return Object.freeze({
    cluster,
    rpcUrls: Object.freeze([...new Set(rpcUrls)]),
    source: configured.length ? "environment" : "default",
  });
}

export function redactRpcUrl(value) {
  const url = validateUrl(value);
  const hasSensitiveParts = Boolean(url.username || url.password || url.search || (url.pathname && url.pathname !== "/"));
  return hasSensitiveParts ? `${url.origin}/[redacted]` : url.origin;
}

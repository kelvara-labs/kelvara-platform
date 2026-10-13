import { resolveProtectionProfile } from "./protection-profiles.js";

const MAX_TARGET_STRING = 256;
const MAX_DECIMAL_STRING = 128;
function validText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TARGET_STRING && !/[\u0000-\u001f\u007f]/.test(value);
}
function validDecimal(value, positive = false) {
  if (typeof value !== "string" || value.length > MAX_DECIMAL_STRING || !/^\d+(?:\.\d+)?$/.test(value)) return false;
  if (positive && /^0(?:\.0*)?$/.test(value)) return false;
  return true;
}

function normalizeDiscovered(result, protocol) {
  if (!result || typeof result !== "object" || !Array.isArray(result.positions)) throw new Error("kamino_discovery_malformed");
  const targets = protocol.targets;
  if (!Array.isArray(targets) || targets.length !== protocol.targetIds?.length) throw new Error("kamino_targets_malformed");
  const byAddress = new Map();
  const byId = new Map();
  for (const target of targets) {
    if (!target || typeof target !== "object" || !validText(target.id) || !validText(target.address) || target.address !== target.address.trim() || !validText(target.displayName) || target.displayName !== target.displayName.trim() || target.network !== "mainnet-beta") throw new Error("kamino_targets_malformed");
    if (byAddress.has(target.address) || byId.has(target.id)) throw new Error("kamino_targets_malformed");
    byAddress.set(target.address, target); byId.set(target.id, target);
  }
  const seen = new Set();
  const positions = result.positions.map(item => {
    if (!item || typeof item !== "object" || typeof item.vault !== "string" || !byAddress.has(item.vault) || seen.has(item.vault)) throw new Error("kamino_discovery_malformed");
    if (!validDecimal(item.totalShares, true) || !validDecimal(item.tokensPerShare, true) || !validDecimal(item.underlyingAmount, true)) throw new Error("kamino_discovery_malformed");
    if (item.apy7d !== null && item.apy7d !== undefined && !validDecimal(String(item.apy7d))) throw new Error("kamino_discovery_malformed");
    const target = byAddress.get(item.vault); seen.add(item.vault);
    let profile=null;try{profile=resolveProtectionProfile(target.id)}catch{}
    const details = { vault: item.vault, totalShares: item.totalShares, ...(item.stakedShares !== undefined ? { stakedShares: item.stakedShares } : {}), ...(item.unstakedShares !== undefined ? { unstakedShares: item.unstakedShares } : {}), tokensPerShare: item.tokensPerShare, underlyingAmount: item.underlyingAmount, apy7d: item.apy7d ?? null, ...(profile?{sharesMint:profile.sharesMint,underlyingMint:profile.underlyingMint}:{}) };
    for (const key of ["stakedShares", "unstakedShares"]) if (details[key] !== undefined && !validDecimal(details[key])) throw new Error("kamino_discovery_malformed");
    for (const key of ["asset", "sharesMint", "underlyingMint"]) if (item[key] !== undefined) { if (!validText(item[key])) throw new Error("kamino_discovery_malformed"); if(profile&&["sharesMint","underlyingMint"].includes(key)&&item[key]!==profile[key])throw new Error("kamino_discovery_malformed");details[key] = item[key]; }
    return { targetId: target.id, protocol: "kamino", adapterId: protocol.discoveryAdapterId || "kamino", adapterVersion: protocol.discoveryAdapterVersion ?? 1, display: target.displayName, details };
  });
  return { ...result, positions };
}

export function createKaminoPortfolioAdapter({ inspector }) {
  if (!inspector || (typeof inspector.inspect !== "function" && typeof inspector.discoverPositions !== "function")) throw new TypeError("kamino_inspector_required");
  return { async discover(wallet, protocol = {}) {
    if (typeof inspector.discoverPositions === "function" && Array.isArray(protocol.targets)) return normalizeDiscovered(await inspector.discoverPositions(wallet, protocol.targets), protocol);
    const result = await inspector.inspect(wallet);
    if (!result?.position) return result;
    const legacy = result.position;
    const { name, protocol: _protocol, ...details } = legacy;
    return { ...result, position: { targetId: protocol.targetIds?.[0] || legacy.targetId || null, protocol: "kamino", adapterId: protocol.discoveryAdapterId || "kamino", adapterVersion: protocol.discoveryAdapterVersion ?? 1, display: name || "Kamino position", details } };
  } };
}

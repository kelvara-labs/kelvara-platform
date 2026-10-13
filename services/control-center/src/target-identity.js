const SEGMENT = /^[a-z][a-z0-9-]{0,31}$/;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodeBase58(value) {
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new TypeError('canonical_target_id');
    number = number * 58n + BigInt(digit);
  }
  let bytes = number === 0n ? [] : [];
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n; }
  for (const char of value) { if (char === '1') bytes.unshift(0); else break; }
  return bytes;
}

export function parseCanonicalTargetId(value) {
  if (typeof value !== 'string' || value.length > 256) throw new TypeError('canonical_target_id');
  const parts = value.split(':');
  if (parts.length !== 5 || parts.slice(0, 4).some(part => !SEGMENT.test(part))) throw new TypeError('canonical_target_id');
  const [chain, network, protocolId, resourceType, address] = parts;
  if (chain === 'solana') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) || decodeBase58(address).length !== 32) throw new TypeError('canonical_target_id');
  } else if (!/^[a-z][a-z0-9-]{0,127}$/.test(address)) {
    throw new TypeError('canonical_target_id');
  }
  return { targetId: value, chain, network, protocolId, resourceType, address };
}

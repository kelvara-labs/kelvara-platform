import { createHash } from 'node:crypto';

export const KAMINO_METRICS_ADAPTER = Object.freeze({ id: 'kamino-kvault-metrics', version: 1, source: 'kamino-kvault-metrics@1' });

const DECIMAL_RE = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const MAX_DECIMAL_DIGITS = 1000;
const MAX_DECIMAL_EXPONENT = 1000;

function decimal(value, field) {
  if (value === undefined) throw new Error(`metrics_${field}_missing`);
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value;
  const match = typeof text === 'string' ? DECIMAL_RE.exec(text) : null;
  if (!match) throw new Error(`metrics_${field}_${typeof value === 'number' && !Number.isFinite(value) ? 'nonfinite' : 'negative_or_invalid'}`);
  const whole = match[1];
  const fraction = match[2] ?? '';
  const exponent = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_DECIMAL_EXPONENT || whole.length + fraction.length > MAX_DECIMAL_DIGITS) {
    throw new Error(`metrics_${field}_negative_or_invalid`);
  }
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
  const scale = fraction.length - exponent;
  if (scale < 0 && digits.length - scale > MAX_DECIMAL_DIGITS) throw new Error(`metrics_${field}_negative_or_invalid`);
  if (scale > MAX_DECIMAL_DIGITS) throw new Error(`metrics_${field}_negative_or_invalid`);
  return { integer: BigInt(scale < 0 ? digits + '0'.repeat(-scale) : digits), scale: Math.max(0, scale) };
}

function sumDecimal(a, b) {
  const scale = Math.max(a.scale, b.scale);
  const value = a.integer * 10n ** BigInt(scale - a.scale) + b.integer * 10n ** BigInt(scale - b.scale);
  if (value === 0n) return '0';
  let digits = value.toString().padStart(scale + 1, '0');
  if (!scale) return digits;
  digits = digits.replace(/0+$/, '');
  const split = Math.max(1, digits.length - scale);
  return `${digits.slice(0, split)}.${digits.slice(split)}`;
}

export function createKaminoMetricsAdapter({ fetchImpl = fetch, baseUrl = 'https://api.kamino.finance', maxBodyBytes = 64 * 1024 } = {}) {
  return {
    id: KAMINO_METRICS_ADAPTER.id,
    version: KAMINO_METRICS_ADAPTER.version,
    async fetch(input, signal) {
      if (!input?.address) throw new TypeError('metrics_address_required');
      const response = await fetchImpl(`${baseUrl}/kvaults/${encodeURIComponent(input.address)}/metrics`, { method: 'GET', headers: { accept: 'application/json' }, signal });
      if (!response.ok) throw new Error(`metrics_http_${response.status}`);
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('metrics_content_type_invalid');
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > maxBodyBytes) throw new Error('metrics_body_too_large');
      let parsed;
      try { parsed = JSON.parse(body); } catch { throw new Error('metrics_body_malformed'); }
      const available = decimal(parsed?.tokensAvailableUsd, 'tokens_available_usd');
      const invested = decimal(parsed?.tokensInvestedUsd, 'tokens_invested_usd');
      const observedAt = new Date().toISOString();
      return { adapter: KAMINO_METRICS_ADAPTER.source, tvl: { value: sumDecimal(available, invested), currency: 'USD' }, observedAt, responseDigest: createHash('sha256').update(body).digest('hex') };
    }
  };
}

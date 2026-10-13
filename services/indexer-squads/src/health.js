const MAX_RESPONSE_BYTES = 64 * 1024;

export async function getHealth(rpcUrl, { timeoutMs = 10_000 } = {}) {
  if (typeof rpcUrl !== 'string' || !rpcUrl.startsWith('https://')) throw new TypeError('rpcUrl must use HTTPS');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }), signal: controller.signal });
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('health response exceeds limit');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('health response body unavailable');
    const chunks = []; let total = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('health response exceeds limit'); } chunks.push(value); }
    let body; try { body = JSON.parse(Buffer.concat(chunks.map(Buffer.from)).toString()); } catch { throw new Error('health response is not valid JSON'); }
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    if (body.error) throw new Error(`RPC ${body.error.message || 'health failed'}`);
    if (body.result !== 'ok') throw new Error('RPC health is not ok');
    return { healthy: true };
  } catch (error) { if (error.name === 'AbortError') throw new Error('health request timed out'); throw error; }
  finally { clearTimeout(timer); }
}

import { createServer } from 'node:http';

export function createDiagnosticsServer({ host = '127.0.0.1', port = 0, getStatus = () => ({ status: 'degraded' }) } = {}) {
  return createServer((request, response) => {
    if (request.method !== 'GET' || !['/health/live', '/health/ready'].includes(new URL(request.url, 'http://localhost').pathname)) { response.writeHead(404); return response.end(); }
    let status; try { status = getStatus(); } catch { status = { status: 'degraded' }; }
    const ready = status?.status === 'ready';
    const body = JSON.stringify({ status: ready ? 'ready' : 'degraded' });
    response.writeHead(request.url.startsWith('/health/ready') && !ready ? 503 : 200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }); response.end(body);
  }).listen(port, host);
}

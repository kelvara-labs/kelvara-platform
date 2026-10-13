import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  response.end(payload);
}

export function createDashboardServer({ getStatus }) {
  return createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health/live') return json(response, 200, { status: 'live' });
    if (request.method === 'GET' && url.pathname === '/health/ready') {
      const status = getStatus();
      return json(response, ['healthy', 'paused'].includes(status.overall) ? 200 : 503, { status: status.overall === 'healthy' ? 'ready' : status.overall });
    }
    if (request.method === 'GET' && (url.pathname === '/api/status' || url.pathname.endsWith('/api/status'))) {
      return json(response, 200, getStatus());
    }
    if (request.method !== 'GET') return json(response, 405, { error: 'method_not_allowed' });
    const name = url.pathname.endsWith('/styles.css') ? 'styles.css' : url.pathname.endsWith('/app.js') ? 'app.js' : 'index.html';
    const path = join(WEB_ROOT, name);
    if (name === 'index.html') {
      const initial = JSON.stringify(getStatus()).replaceAll('<', '\\u003c');
      const payload = readFileSync(path, 'utf8').replace('<script src="./app.js?v=7"></script>', `<script>window.__INITIAL_STATUS__=${initial}</script><script src="./app.js?v=7"></script>`);
      response.writeHead(200, { 'content-type': TYPES[extname(path)], 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-cache' });
      return response.end(payload);
    }
    const stat = statSync(path);
    response.writeHead(200, { 'content-type': TYPES[extname(path)], 'content-length': stat.size, 'cache-control': 'public, max-age=3600' });
    createReadStream(path).pipe(response);
  });
}

import { createServer } from 'node:http';

const PROXY_PATH = /^\/internal\/v1\/admin\/onboarding-proposals(?:\/(?:preflight|validate|activate|pause|retire))?$/;
const VIEWER_PATH = /^\/api\/velocity\/(protocol|accounts(?:\/[^/]+)?|transactions|actions|failures|upgrades)$/;
const MAX_PROXY_RESPONSE = 1_000_000;

async function proxyViewer(request, response, url, config) {
  if (!config?.url || typeof config.token !== 'string' || config.token.length < 32) { response.writeHead(503, {'content-type':'application/json'}); return response.end(JSON.stringify({error:'observation_hub_unavailable'})); }
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const upstream = await fetch(new URL(url.pathname + url.search, config.url), { headers: { 'X-Kelvara-Authorization': `Bearer ${config.token}` }, signal: controller.signal });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > MAX_PROXY_RESPONSE) { response.writeHead(502, {'content-type':'application/json'}); return response.end(JSON.stringify({error:'upstream_response_too_large'})); }
    const type = upstream.headers.get('content-type') || '';
    if (!type.includes('json')) { response.writeHead(502, {'content-type':'application/json'}); return response.end(JSON.stringify({error:'upstream_invalid_json'})); }
    try { JSON.parse(bytes.toString('utf8')); } catch { response.writeHead(502, {'content-type':'application/json'}); return response.end(JSON.stringify({error:'upstream_invalid_json'})); }
    response.writeHead(upstream.status, {'content-type':'application/json','cache-control':'no-store'}); return response.end(bytes);
  } catch { response.writeHead(502, {'content-type':'application/json'}); return response.end(JSON.stringify({error:'observation_hub_unreachable'})); } finally { clearTimeout(timer); }
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 100_000) throw new RangeError('request body exceeds 100000 bytes');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Velocity Protocol Viewer</title><style>body{font:16px system-ui;max-width:1200px;margin:auto;padding:1rem;color:#172033}nav{display:flex;gap:.4rem;flex-wrap:wrap;margin:1rem 0}button{padding:.55rem .8rem;border:1px solid #ccd;border-radius:6px;background:white;cursor:pointer}button[aria-current=true]{background:#172033;color:white}.pane{border:1px solid #d8dee9;border-radius:10px;padding:1rem;margin:1rem 0}.error{color:#a00}.unknown{color:#775500}.technical{font: .85rem monospace;word-break:break-all}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.5rem;border-bottom:1px solid #eee}a{color:inherit}</style></head><body><header><h1>Velocity Protocol Viewer</h1><p id="viewer-state" class="unknown">Loading…</p></header><nav id="nav" aria-label="Monitoring"><button data-pane="overview">Overview</button><button data-pane="accounts">Tracked accounts</button><button data-pane="transactions">Transactions</button><button data-pane="actions">Actions</button><button data-pane="failures">Failures</button><button data-pane="upgrades">Upgrades</button></nav><main id="monitor"></main><p>Observed freshness</p><p>Technical evidence</p><p>Target lifecycle</p><section id="admin" class="pane"><h2>Admin</h2><p>Operator onboarding and lifecycle controls.</p><form id="onboard"><label>Account <input name="address" required></label><button>Add account</button></form><div id="actions"><button type="button" data-lifecycle="validate">Validate</button><button type="button" data-lifecycle="activate">Activate</button><button type="button" data-lifecycle="pause">Pause</button><button type="button" data-lifecycle="retire">Retire</button></div></section><script>
const auth=()=>sessionStorage.getItem('kelvara-token')||'';const headers=()=>({'content-type':'application/json','X-Kelvara-Authorization':'Bearer '+auth()});
const ingressBase=()=>{const p=location.pathname,m='/api/hassio_ingress/';const i=p.indexOf(m);if(i<0)return '';const r=p.slice(i+m.length),s=r.indexOf('/');return s<0?p.slice(0,i+m.length+r.length):p.slice(0,i+m.length+s+1)};const apiPath=p=>ingressBase()+(p.startsWith('/')?p.slice(1):p);
async function control(action,body){const suffix=action?'/'+action:'';return fetch(apiPath('internal/v1/admin/onboarding-proposals'+suffix),{method:'POST',headers:{...headers(),'idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)})}async function preflight(body){const r=await fetch(apiPath('internal/v1/admin/onboarding-proposals/preflight'),{method:'POST',headers:headers(),body:JSON.stringify(body)});const d=await safeJson(r);if(!r.ok)throw Error(d?.error?.message||'preflight failed');return d}
async function safeJson(r){try{return await r.json()}catch{return {error:'invalid_json'}}}function text(v,f='Unknown'){return v===null||v===undefined||v===''?f:String(v)}function cell(v,cls=''){const e=document.createElement('span');e.textContent=text(v);if(cls)e.className=cls;return e}function row(k,v){const d=document.createElement('div');d.append(cell(k+': ','technical'));d.append(cell(v));return d}
const panes={overview:{title:'Protocol overview',path:'/api/velocity/protocol'},accounts:{title:'Tracked accounts',path:'/api/velocity/accounts'},transactions:{title:'Transactions',path:'/api/velocity/transactions'},actions:{title:'Actions',path:'/api/velocity/actions'},failures:{title:'Failures',path:'/api/velocity/failures'},upgrades:{title:'Upgrades',path:'/api/velocity/upgrades'}};
function frame(title){const s=document.createElement('section');s.className='pane';const h=document.createElement('h2');h.textContent=title;s.append(h);return s}function unavailable(s,p){s.append(cell('Current activity unavailable: '+text(p?.reason||p?.error?.message||p?.error,'endpoint unavailable'),'error'))}
function valueText(v){if(v&&typeof v==='object'){return Object.entries(v).map(([k,x])=>k+': '+valueText(x)).join('; ')}return text(v)}
function renderOverview(s,d){for(const [k,v] of Object.entries({Protocol:d.protocol,Network:d.network,'Program address':d.programObservation?.address,'Program status':d.programObservation?.status,'Tracked count':d.trackedCount,'Latest slot':d.latestSlot,'Latest time':d.latestTime,Freshness:d.freshness,Provenance:d.programObservation?.provenance}))s.append(row(k,valueText(v)))}
function renderAccounts(s,d){const a=Array.isArray(d)?d:(d.items||[]);if(!a.length){s.append(cell('No account records reported.','unknown'));return}const t=document.createElement('table');const h=document.createElement('tr');['Address','Status','Slot','Time'].forEach(x=>{const e=document.createElement('th');e.textContent=x;h.append(e)});t.append(h);a.forEach(x=>{const tr=document.createElement('tr');tr.tabIndex=0;tr.dataset.address=x.address||x.owner||'';[x.address||x.owner,x.status,x.slot||x.latestSlot,x.time||x.observedAt].forEach(v=>{const e=document.createElement('td');e.append(cell(valueText(v)));tr.append(e)});tr.onclick=()=>loadAccount(tr.dataset.address);t.append(tr)});s.append(t)}
function renderDetail(s,d){const x=d.latest||{};for(const [k,v] of Object.entries({Owner:x.owner,Executable:x.executable,'Data length':x.dataLength,'Data hash':x.dataHash,Status:d.status,Provenance:x.provenance,Token:x.tokenFacts||x.token}))s.append(row(k,valueText(v)));if(Array.isArray(d.history)){const h=document.createElement('h3');h.textContent='Bounded history';s.append(h);d.history.slice(0,50).forEach(x=>s.append(row(x.slot||'event',valueText(x))))}}
async function loadAccount(address){if(!address)return;history.replaceState(null,'','?address='+encodeURIComponent(address));const s=frame('Account detail');s.append(cell('Loading…','unknown'));document.querySelector('#monitor').replaceChildren(s);try{const r=await fetch(apiPath('/api/velocity/accounts/'+encodeURIComponent(address)));const d=await safeJson(r);s.replaceChildren();s.append(Object.assign(document.createElement('h2'),{textContent:'Account detail'}));if(!r.ok)unavailable(s,d);else renderDetail(s,d)}catch(e){s.replaceChildren();s.append(cell('Error loading account: '+text(e.message),'error'))}}
async function loadPane(name){const p=panes[name],s=frame(p.title);s.append(cell('Loading…','unknown'));document.querySelector('#monitor').replaceChildren(s);document.querySelectorAll('#nav button').forEach(b=>b.setAttribute('aria-current',b.dataset.pane===name));try{const r=await fetch(apiPath(p.path));const d=await safeJson(r);s.replaceChildren();s.append(Object.assign(document.createElement('h2'),{textContent:p.title}));if(!r.ok){unavailable(s,d);return}if(name==='overview')renderOverview(s,d);else if(name==='accounts')renderAccounts(s,d);else if(Array.isArray(d)||d.items||d.records){const items=Array.isArray(d)?d:(d.items||d.records);if(!items.length)s.append(cell('No activity reported.','unknown'));else items.slice(0,100).forEach(x=>s.append(row('Record',typeof x==='object'?JSON.stringify(x):x)))}else unavailable(s,d)}catch(e){s.replaceChildren();s.append(Object.assign(document.createElement('h2'),{textContent:p.title}));s.append(cell('Error loading pane: '+text(e.message),'error'))}}
document.querySelectorAll('#nav button').forEach(b=>b.onclick=()=>loadPane(b.dataset.pane));const refresh=()=>loadPane(new URLSearchParams(location.search).has('address')?'accounts':'overview');document.querySelectorAll('[data-lifecycle]').forEach(b=>b.onclick=async()=>{try{const address=new URLSearchParams(location.search).get('address')||new FormData(document.querySelector('#onboard')).get('address');const r=await control(b.dataset.lifecycle,{address,targetId:'solana:mainnet-beta:velocity:state:'+address});if(!r.ok)throw Error('lifecycle action failed');await refresh()}catch(error){document.querySelector('#viewer-state').textContent=error.message}});document.querySelector('#onboard').addEventListener('submit',async e=>{e.preventDefault();const address=new FormData(e.target).get('address');const base={chain:'solana',network:'mainnet-beta',protocol:'velocity',kind:'state',address,targetId:'solana:mainnet-beta:velocity:state:'+address};try{const receipt=await preflight(base);const r=await control('',{...base,proposalId:crypto.randomUUID(),indexerId:'velocity-mainnet',display:{name:address},ruleBindings:[{id:'velocity-default',ruleId:'velocity-default',version:1}],preflightReceiptId:receipt.receiptId,reason:'operator onboarding'});if(!r.ok)throw Error('proposal failed');await refresh()}catch(error){document.querySelector('#viewer-state').textContent=error.message}});const q=new URLSearchParams(location.search);loadPane(q.has('address')?'accounts':'overview');if(q.has('address'))loadAccount(q.get('address'));
</script></body></html>`;

export function createVelocityRuntimeServer({ getStatus, controlPlane = null, viewer = null }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'POST' && PROXY_PATH.test(url.pathname)) {
      if (!controlPlane?.url || typeof controlPlane.token !== 'string' || controlPlane.token.length < 32) {
        response.writeHead(503, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: 'control_plane_unavailable' }));
      }
      try {
        const body = await readRequestBody(request);
        const headers = { 'content-type': request.headers['content-type'] || 'application/json', authorization: `Bearer ${controlPlane.token}` };
        for (const name of ['idempotency-key']) if (request.headers[name]) headers[name] = request.headers[name];
        const upstream = await fetch(new URL(url.pathname + url.search, controlPlane.url), { method: request.method, headers, body });
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
        return response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        response.writeHead(502, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: 'control_plane_unreachable' }));
      }
    }
    if (request.method === 'GET' && VIEWER_PATH.test(url.pathname)) {
      return proxyViewer(request, response, url, viewer);
    }
    if (request.method === 'GET' && url.pathname === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return response.end(JSON.stringify({ status: 'live' }));
    }
    if (request.method === 'GET' && url.pathname === '/health/ready') {
      const status = getStatus();
      const ready = ['observing', 'paused', 'healthy', 'ready'].includes(status?.status || status?.overall);
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return response.end(JSON.stringify({ status: ready ? (status?.status || status?.overall) : 'starting' }));
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname.endsWith('/'))) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return response.end(html);
    }
    if (request.method === 'GET' && (url.pathname === '/api/status' || url.pathname.endsWith('/api/status'))) {
      const payload = JSON.stringify(getStatus()); response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); return response.end(payload);
    }
    response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'not_found' }));
  });
}

export async function fetchVelocityAssignments(config, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.backendUrl}/internal/indexers/${config.indexerId}/desired-targets`, { headers: { 'X-Kelvara-Authorization': `Bearer ${config.backendToken}` } });
  if (!response.ok) throw new Error(`assignment_fetch_${response.status}`);
  return (await response.json()).targets || [];
}

export async function reportVelocityReconciliation(config, body, fetchImpl = fetch) {
  return fetchImpl(`${config.backendUrl}/internal/indexers/${config.indexerId}/reconciliation`, { method: 'POST', headers: { 'X-Kelvara-Authorization': `Bearer ${config.backendToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ indexerId: config.indexerId, ...body }) });
}

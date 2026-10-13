const endpoint=document.body.dataset.statusEndpoint||'./api/status';
const $=(id)=>document.getElementById(id);
const text=(id,value)=>{const node=$(id);if(node)node.textContent=value??'—'};
const number=(value)=>Number.isFinite(value)?new Intl.NumberFormat().format(value):'—';
const duration=(ms)=>{if(!Number.isFinite(ms))return'—';if(ms<1000)return`${Math.round(ms)} ms`;let s=Math.floor(ms/1000);const d=Math.floor(s/86400);s%=86400;const h=Math.floor(s/3600);s%=3600;const m=Math.floor(s/60);s%=60;if(d)return`${d}d ${h}h`;if(h)return`${h}h ${m}m`;if(m)return`${m}m ${s}s`;return`${s}s`};
const ago=(iso)=>{if(!iso)return'Never';const delta=Math.max(0,Date.now()-Date.parse(iso));if(delta<5000)return'just now';if(delta<60000)return`${Math.floor(delta/1000)}s ago`;if(delta<3600000)return`${Math.floor(delta/60000)}m ago`;return`${Math.floor(delta/3600000)}h ago`};
const stamp=(iso)=>iso?new Date(iso).toLocaleString():'—';
const state=(value)=>String(value||'unknown').toUpperCase();
function applyTheme(theme){const chosen=['light','dark','system'].includes(theme)?theme:'system';document.documentElement.dataset.theme=chosen;try{localStorage.setItem('kelvara-theme',chosen)}catch{}document.querySelectorAll('[data-theme]').forEach(button=>{button.classList.toggle('active',button.dataset.theme===chosen);button.setAttribute('aria-pressed',String(button.dataset.theme===chosen))})}
function dot(id,kind){const node=$(id);node.className=`dot ${kind}`}
function renderHeader(data){
 const overall=data.overall||'unknown';text('overall',state(overall));$('overall').className=`state ${overall}`;text('freshness',data.observedAt?`Observed ${ago(data.observedAt)}`:'Awaiting first cycle');
 text('indexer-id',data.indexerId);text('network',data.network);text('version',data.version);
 const attention=$('attention');attention.className=`alert-strip ${overall}`;
 const failed=(data.targets||[]).filter(t=>t.status==='error').length;
 text('attention-title',overall==='healthy'?'All monitored targets operational':overall==='starting'?'Initializing worker':`${failed||'Worker'} requires attention`);
 text('attention-copy',overall==='healthy'?`Last cycle completed ${ago(data.observedAt)} with no target failures.`:overall==='starting'?'No completed observation yet.':failed?`${failed} target${failed===1?'':'s'} failed the latest cycle.`:'Review dependency and cycle status.');
}
function renderKpis(data){
 const metrics=data.metrics||{};const cycles=metrics.cycles||{};const targets=data.targets||[];const healthy=targets.filter(t=>t.status==='healthy').length;const slots=targets.map(t=>t.slot).filter(Number.isFinite);
 text('uptime',duration(metrics.uptimeMs));text('started-at',metrics.startedAt?`Started ${stamp(metrics.startedAt)}`:'Started —');
 text('success-rate',Number.isFinite(cycles.successRate)?`${cycles.successRate.toFixed(cycles.successRate%1?1:0)}%`:'—');text('cycle-ok',number(cycles.succeeded));text('cycle-total',number(cycles.total));
 text('target-health',targets.length?`${Math.round(healthy/targets.length*100)}%`:'—');text('target-ok',number(healthy));text('target-total',number(targets.length));
 text('rpc-latency',Number.isFinite(metrics.rpc?.averageLatencyMs)?`${number(metrics.rpc.averageLatencyMs)} ms`:'—');text('rpc-samples',number(metrics.rpc?.samples));
 text('last-slot',slots.length?number(Math.max(...slots)):'—');text('last-cycle',data.observedAt?`Finalized ${ago(data.observedAt)}`:'No completed cycle');
 text('history-days',Number.isFinite(data.backfillDays)?`${data.backfillDays} days`:'—');
 text('cycles-total',number(cycles.total));text('cycles-failed',number(cycles.failed));text('avg-duration',duration(cycles.averageDurationMs));text('last-duration',duration(cycles.lastDurationMs));
 text('canary-count',number(metrics.triggers?.canary));text('change-count',number(metrics.triggers?.rpcChange));text('poll-rate',`${duration(data.pollIntervalMs)} INTERVAL`);
 text('nav-target-count',number(targets.length));text('nav-failure-count',number(cycles.failed));
}
function renderDependencies(data){
 const live=data.live||{};text('live-state',live.connected?'CONNECTED':live.configured?'DISCONNECTED':'NOT SET');text('live-detail',live.connected?'Account-change subscription active':live.configured?'Configured; fallback polling remains active':'No WebSocket endpoint configured');dot('live-dot',live.connected?'ok':live.configured?'bad':'warn');
 const backend=data.backend||{};const backendOk=backend.mode==='connected'||backend.mode==='backend';text('backend-state',backendOk?'CONNECTED':backend.mode==='standalone'?'STANDALONE':state(backend.mode));text('backend-detail',backend.error|| (backendOk?'Cursor and evidence delivery enabled':'Local monitoring only'));dot('backend-dot',backendOk?'ok':backend.mode==='error'?'bad':'warn');
 const notify=data.notifications||{};text('notify-state',notify.error?'ERROR':notify.configured?'ARMED':'NOT SET');text('notify-detail',notify.error|| (notify.configured?'Status transitions POST to configured webhook':'No alert webhook configured'));dot('notify-dot',notify.error?'bad':notify.configured?'ok':'warn');
 text('canary-state',data.canaryMode?'ENABLED':'DISABLED');text('canary-detail',data.canaryMode?`Scheduled every ${duration(data.pollIntervalMs)}`:'Scheduled verification disabled');
}
function renderTargets(data){
 const body=$('target-rows');body.replaceChildren();const targets=data.targets||[];if(!targets.length){const row=body.insertRow();const cell=row.insertCell();cell.colSpan=7;cell.className='empty';cell.textContent='Awaiting first cycle.';return}
 for(const target of targets){const row=body.insertRow();const name=row.insertCell();name.className='target-name';name.textContent=target.displayName||target.id||'Unknown target';const address=document.createElement('span');address.className='target-address';address.textContent=target.address||target.id||'—';name.append(address);const status=row.insertCell();const badge=document.createElement('span');badge.className=`badge ${target.status||'unknown'}`;badge.textContent=state(target.status);status.append(badge);row.insertCell().textContent=number(target.slot);row.insertCell().textContent=target.provider||'—';row.insertCell().textContent=Number.isFinite(target.latencyMs)?`${target.latencyMs} ms`:'—';row.insertCell().textContent=target.observedAt?ago(target.observedAt):'—';row.insertCell().textContent=target.backendCommitted?'COMMITTED':data.backend?.mode==='standalone'?'LOCAL':'PENDING';}
}
function renderContinuity(data){
 const entries=data.metrics?.continuity||[];text('continuity-count',`${entries.length} RECORD${entries.length===1?'':'S'}`);const chart=$('continuity-chart');chart.replaceChildren();for(const entry of entries.slice(-80)){const bar=document.createElement('span');bar.className=`bar ${entry.status||'unknown'}`;bar.title=`${stamp(entry.at)} · ${entry.status} · ${entry.reason}`;chart.append(bar)}
 const body=$('continuity-rows');body.replaceChildren();if(!entries.length){const row=body.insertRow();const cell=row.insertCell();cell.colSpan=4;cell.className='empty';cell.textContent='No completed cycles.';return}for(const entry of [...entries].reverse()){const row=body.insertRow();row.insertCell().textContent=stamp(entry.at);const result=row.insertCell();const badge=document.createElement('span');badge.className=`badge ${entry.status}`;badge.textContent=state(entry.status);result.append(badge);row.insertCell().textContent=String(entry.reason||'—').toUpperCase();row.insertCell().textContent=duration(entry.durationMs)}
}
function render(data){renderHeader(data);renderKpis(data);renderDependencies(data);renderTargets(data);renderContinuity(data)}
async function refresh(){try{const response=await fetch(endpoint,{cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);render(await response.json())}catch(error){text('overall','UNREACHABLE');$('overall').className='state error';$('attention').className='alert-strip error';text('attention-title','Status endpoint unavailable');text('attention-copy',error.message)}}
function selectPane(name,updateHash=true){document.querySelectorAll('[data-pane-panel]').forEach(panel=>{const active=panel.dataset.panePanel===name;panel.hidden=!active;panel.classList.toggle('active',active)});document.querySelectorAll('[data-pane]').forEach(button=>{const active=button.dataset.pane===name;button.classList.toggle('active',active);if(active)button.scrollIntoView({block:'nearest',inline:'nearest'})});if(updateHash)history.replaceState(null,'',`#monitoring/${name}`)}
document.querySelectorAll('[data-pane]').forEach(button=>button.addEventListener('click',()=>selectPane(button.dataset.pane)));document.querySelectorAll('[data-theme]').forEach(button=>button.addEventListener('click',()=>applyTheme(button.dataset.theme)));applyTheme(document.documentElement.dataset.theme||'system');$('refresh').addEventListener('click',refresh);selectPane(location.hash.split('/')[1]||'overview',false);if(window.__INITIAL_STATUS__)render(window.__INITIAL_STATUS__);refresh();setInterval(refresh,15000);

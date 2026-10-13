const $ = (selector) => document.querySelector(selector);
const state = { overview: null, indexers: [], targets: [], evacuations: [] };

function safe(value) { return String(value ?? 'Unknown'); }
function fmt(value) { return Number.isFinite(Number(value)) ? new Intl.NumberFormat().format(Number(value)) : 'Unknown'; }
function time(value) { if (!value) return 'Never'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'Unknown' : date.toLocaleString(); }
function age(value) { if (!value) return 'Never observed'; const seconds = Math.max(0, (Date.now() - new Date(value).valueOf()) / 1000); if (seconds < 90) return `${Math.round(seconds)}s ago`; if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`; if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`; return `${Math.round(seconds / 86400)}d ago`; }
function set(selector, value) { const node = $(selector); if (node) node.textContent = safe(value); }
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = safe(text); return node; }
function field(label, value) { const wrap = element('div'); wrap.append(element('span', '', label), element('strong', '', value)); return wrap; }
function badge(status) { const node = element('span', `badge ${safe(status).toLowerCase()}`); node.append(element('i'), document.createTextNode(safe(status))); return node; }
function empty(container, message) { container.replaceChildren(element('p', 'empty', message)); }
async function json(path) { const response = await fetch(path, { cache: 'no-store', headers: { accept: 'application/json' } }); const body = await response.json(); if (!response.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`); return body; }

function renderOverview() {
  const data = state.overview;
  set('#system-state', 'Available');
  set('#system-detail', `Generated ${age(data.generatedAt)}`);
  set('#healthy-indexers', `${fmt(data.indexers.healthy)} / ${fmt(data.indexers.total)}`);
  set('#indexer-detail', data.indexers.attention ? `${fmt(data.indexers.attention)} require attention` : 'All registered workers healthy');
  set('#enabled-targets', `${fmt(data.targets.enabled)} / ${fmt(data.targets.total)}`);
  set('#target-detail', 'Enabled protocol targets');
  set('#snapshot-count', fmt(data.evidence.snapshotCount));
  set('#latest-evidence', data.evidence.latestObservedAt ? `Latest ${age(data.evidence.latestObservedAt)}` : 'No evidence stored');
  set('#evacuation-count', fmt(data.evacuations.total));
  set('#evacuation-detail', `${fmt(data.evacuations.statuses.EVACUATED)} evacuated · ${fmt(data.evacuations.statuses.ERROR)} errors · ${fmt(data.evacuations.statuses.BROADCAST_PENDING)} pending`);
  const attention = $('#attention-list'); attention.replaceChildren();
  const issues = state.indexers.filter((item) => item.status !== 'healthy');
  if (!issues.length) {
    const article = element('article', 'clear'); const copy = element('div');
    copy.append(element('strong', '', 'No worker requires attention'), element('small', '', 'All registered indexers report healthy.'));
    article.append(element('span', '', '✓'), copy); attention.append(article);
  }
  for (const item of issues) {
    const article = element('article'); const copy = element('div');
    copy.append(element('strong', '', item.id), element('small', '', item.lastErrorMessage || `Worker reports ${item.status}`));
    article.append(element('span', '', '!'), copy); attention.append(article);
  }
  set('#incident-badge', fmt(issues.length));
}

function renderIndexers() {
  const grid = $('#indexer-grid'); grid.replaceChildren();
  if (!state.indexers.length) return empty(grid, 'No indexers registered.');
  for (const item of state.indexers) {
    const cursor = item.snapshotCursor; const card = element('article', 'entity-card'); const header = element('header'); const title = element('div');
    title.append(element('p', 'eyebrow', `${safe(item.protocol)} · ${safe(item.network)}`), element('h2', '', item.id)); header.append(title, badge(item.status));
    const metrics = element('div', 'metrics'); metrics.append(field('Version', item.version), field('Targets', fmt(item.targetCount)), field('Snapshots', fmt(item.snapshotCount)), field('Heartbeat', age(item.lastHeartbeatAt)));
    const cursorNode = element('div', 'cursor'); cursorNode.append(element('span', '', 'Account snapshot cursor'), element('strong', '', cursor ? `Slot ${fmt(cursor.slot)}` : 'Not established'), element('small', '', cursor ? `Acknowledged ${age(cursor.updatedAt)}` : 'Worker has not committed a cursor.'));
    card.append(header, metrics, cursorNode); if (item.lastErrorMessage) card.append(element('p', 'error-copy', item.lastErrorMessage)); grid.append(card);
  }
}

function renderTargets() {
  const list = $('#target-list'); const evidence = $('#evidence-list'); list.replaceChildren(); evidence.replaceChildren();
  if (!state.targets.length) { empty(list, 'No targets registered.'); empty(evidence, 'No snapshot evidence stored.'); return; }
  for (const target of state.targets) {
    const snapshot = target.latestSnapshot; const cursor = target.snapshotCursor; const row = element('article', 'target-row'); const identity = element('div');
    identity.append(element('strong', '', target.displayName), element('code', '', target.address), element('small', '', target.curator));
    row.append(identity, element('span', '', target.indexerId), element('span', '', snapshot ? `Slot ${fmt(snapshot.slot)} · ${age(snapshot.observedAt)}` : 'No snapshot'), badge(target.enabled ? 'enabled' : 'disabled')); list.append(row);
    const card = element('article', 'evidence-card'); const title = element('div'); const details = element('dl');
    title.append(element('p', 'eyebrow', `${safe(target.protocol)} · ${safe(target.kind)}`), element('h2', '', target.displayName), element('code', '', target.address));
    for (const [label, value] of [['Latest snapshot', snapshot ? time(snapshot.observedAt) : 'Never'], ['RPC slot', snapshot ? fmt(snapshot.slot) : 'Unknown'], ['Acknowledged cursor', cursor ? fmt(cursor.slot) : 'Unknown'], ['Source', snapshot?.source], ['Decoder', snapshot?.decoderVersion]]) { const item = element('div'); item.append(element('dt', '', label), element('dd', '', value)); details.append(item); }
    card.append(title, details); evidence.append(card);
  }
}

function renderEvacuations() {
  const list = $('#evacuation-list'); list.replaceChildren();
  if (!state.evacuations.length) return empty(list, 'No evacuation evidence stored.');
  for (const item of state.evacuations) {
    const card = element('article', 'evidence-card'); const title = element('div'); const details = element('dl');
    title.append(element('p', 'eyebrow', `${safe(item.network)} · ${safe(item.eventId)}`), element('h2', '', item.walletAddress), badge(item.status), element('small', '', item.triggerReason));
    for (const [label, value] of [['Observed', time(item.observedAt)], ['Confirmation', item.confirmationStatus], ['Slot', item.confirmationSlot == null ? 'Unknown' : fmt(item.confirmationSlot)], ['Signature', item.signature || 'Not available']]) { const fieldNode = element('div'); fieldNode.append(element('dt', '', label), element('dd', '', value)); details.append(fieldNode); }
    card.append(title, details); list.append(card);
  }
}

function setConnection(kind, label) { const node = $('#connection-state'); node.className = `connection ${kind}`; node.replaceChildren(element('i'), document.createTextNode(label)); }
async function refresh() {
  const button = $('#refresh'); button.disabled = true;
  try {
    const [overview, indexers, targets, evacuations] = await Promise.all([json('./api/operations/overview'), json('./api/operations/indexers'), json('./api/operations/targets'), json('./api/operations/evacuations')]);
    state.overview = overview; state.indexers = indexers.indexers || []; state.targets = targets.targets || []; state.evacuations = evacuations.evacuations || [];
    renderOverview(); renderIndexers(); renderTargets(); renderEvacuations(); setConnection('available', 'Live');
  } catch (error) { set('#system-state', 'Unavailable'); set('#system-detail', error.message); setConnection('unavailable', 'Unavailable'); }
  finally { set('#last-refresh', new Date().toLocaleTimeString()); button.disabled = false; }
}

const panes = new Set(['overview', 'incidents', 'indexers', 'targets', 'evidence', 'clients']);
function showPane(name) { const pane = panes.has(name) ? name : 'overview'; document.querySelectorAll('[data-view]').forEach((node) => node.classList.toggle('hidden', node.dataset.view !== pane)); let active; document.querySelectorAll('[data-pane]').forEach((node) => { node.classList.toggle('active', node.dataset.pane === pane); if (node.dataset.pane === pane) active = node; }); if (innerWidth <= 760) requestAnimationFrame(() => active?.scrollIntoView({ inline: 'center', block: 'nearest' })); history.replaceState(null, '', `#monitoring/${pane}`); }
function showMode(mode) { const admin = mode === 'admin'; $('#monitoring-shell').classList.toggle('hidden', admin); $('#admin-shell').classList.toggle('hidden', !admin); $('#monitoring-tab').classList.toggle('active', !admin); $('#admin-tab').classList.toggle('active', admin); if (admin) history.replaceState(null, '', '#admin'); }
document.querySelectorAll('[data-pane]').forEach((node) => node.onclick = () => { showMode('monitoring'); showPane(node.dataset.pane); });
$('#monitoring-tab').onclick = () => { showMode('monitoring'); showPane('overview'); }; $('#admin-tab').onclick = () => showMode('admin'); $('#refresh').onclick = refresh;
const initial = location.hash.slice(1); if (initial === 'admin') showMode('admin'); else { showMode('monitoring'); showPane(initial.startsWith('monitoring/') ? initial.split('/')[1] : 'overview'); }
refresh(); setInterval(refresh, 15_000);

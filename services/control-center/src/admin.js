(() => {
  'use strict';
  let token = null;
  let identity = null;
  const $ = id => document.getElementById(id);
  const log = value => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    $('response-log').textContent = text;
    if (!$('app').hidden) return;
    $('auth-status').textContent = text;
  };
  const remember = value => { token = value.trim(); sessionStorage.setItem('kelvara-admin-token', token); };
  const forget = () => { token = null; identity = null; sessionStorage.removeItem('kelvara-admin-token'); $('app').hidden = true; $('auth-panel').hidden = false; };
  const ingressBase = (() => {
    if (!location.pathname.includes('/api/hassio_ingress/')) return '';
    const marker = '/api/hassio_ingress/';
    const suffix = location.pathname.slice(location.pathname.indexOf(marker) + marker.length);
    return marker + suffix.split('/')[0];
  })();
  const apiUrl = path => ingressBase ? ingressBase + path : path;
  function createIdempotencyKey(cryptoApi = globalThis.crypto) {
    if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
    if (typeof cryptoApi?.getRandomValues !== 'function') throw new Error('Secure random number generation is unavailable.');
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  async function request(path, options = {}) {
    const requestUrl = apiUrl(path);
    const headers = { 'content-type': 'application/json', 'X-Kelvara-Authorization': 'Bearer ' + token, ...(options.headers || {}) };
    let response;
    try { response = await fetch(requestUrl, { ...options, headers }); }
    catch (error) {
      const details = { stage: 'fetch', requestUrl, pageUrl: location.href, ingressBase, errorName: error.name, errorMessage: error.message };
      console.error('kelvara_auth_debug', details); log(details); throw Object.assign(new Error('Network request failed'), { details });
    }
    const rawBody = await response.text();
    let body;
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = { nonJsonBody: rawBody.slice(0, 4000) }; }
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const details = { stage: 'response', requestUrl, finalUrl: response.url, pageUrl: location.href, ingressBase, status: response.status, statusText: response.statusText, responseHeaders, body, rawBody: rawBody.slice(0, 4000) };
    log(details);
    if (!response.ok) {
      console.error('kelvara_auth_debug', details);
      throw Object.assign(new Error(body.error?.message || 'HTTP ' + response.status), { details });
    }
    return body;
  }
  let rulesByVault = null;
  let rulesLoaded = false;
  function renderSelectedVault() {
    const id = $('vault-selector').value;
    const vault = rulesByVault?.vaults?.find(item => item.vaultId === id);
    $('vault-identity').textContent = vault ? `${vault.vaultName || 'Unnamed vault'} — Vault ID: ${vault.vaultId}` : 'Friendly name and full Vault ID appear here.';
    $('rules-view').textContent = vault ? JSON.stringify({ activeRevision: rulesByVault.activeRevision, vault }, null, 2) : 'Select a vault to inspect its draft and active rules.';
  }
  async function loadRules() {
    try {
      rulesByVault = await request('/internal/v1/admin/rules-by-vault');
      const selector = $('vault-selector');
      selector.replaceChildren(new Option('Select a vault', ''));
      for (const vault of rulesByVault.vaults || []) selector.add(new Option(`${vault.vaultName || 'Unnamed vault'} — ${vault.vaultId}`, vault.vaultId));
      rulesLoaded = true;
      renderSelectedVault();
    } catch (error) { $('rules-view').textContent = error.message; }
  }
  async function loadProposals() {
    try {
      const body = await request('/internal/v1/admin/operations/proposals');
      const table = $('proposals-table'); table.replaceChildren();
      for (const item of body.proposals || []) {
        const card = document.createElement('article'); card.className = 'agent-access-card';
        card.textContent = `${item.requester} | ${item.destinationService} | ${item.operation} | risk=${item.risk} | expires ${item.expiresAt} | ${item.status} | envelope ${item.envelopeDigest}`;
        if (item.risk === 'critical') { const warning = document.createElement('strong'); warning.textContent = ' CRITICAL ACTIVATION: dedicated approval required. No execution occurs here.'; card.append(warning); }
        if (item.status === 'pending_approval') for (const action of ['approve', 'reject']) { const button = document.createElement('button'); button.textContent = action === 'approve' ? 'Approve' : 'Deny'; button.addEventListener('click', async () => { await request(`/internal/v1/admin/operations/proposals/${encodeURIComponent(item.proposalId)}/${action}`, { method: 'POST', body: JSON.stringify({ proposalRevision: item.revision, envelopeDigest: item.envelopeDigest, reason: action + 'd by operator' }) }); loadProposals(); }); card.append(button); }
        table.append(card);
      }
      if (!table.children.length) table.textContent = 'No proposals loaded.';
    } catch (error) { $('proposals-table').textContent = error.message; }
  }
  let managerProjection = null;
  function renderManagerWalletList() {
    const list = $('manager-wallet-list'); list.replaceChildren();
    const query = ($('manager-search')?.value || '').trim().toLowerCase();
    const wallets = (managerProjection?.wallets || []).filter(item => item.walletId.toLowerCase().includes(query));
    for (const wallet of wallets) { const button=document.createElement('button'); button.textContent=`${wallet.walletId} — signed permit — ${wallet.status}`; button.addEventListener('click',()=>renderManagerWallet(wallet)); list.append(button); }
    if (!list.children.length) list.textContent = query ? 'No wallets match this search.' : 'No signed evacuation enrollments found. New enrollments appear after a permit is securely stored.';
  }
  async function loadManager() {
    try {
      managerProjection = await request('/internal/v1/admin/manager/projection');
      renderManagerWalletList();
      $('manager-onboarding').textContent = `Signed enrollments: ${managerProjection.wallets.length}`;
      if (managerProjection.wallets[0]) renderManagerWallet(managerProjection.wallets[0]);
    } catch (error) { $('manager-wallet-list').textContent = error.message; }
  }
  const detail = (value) => {
    const dl = document.createElement('dl');
    for (const [label, content] of Object.entries(value || {})) { const dt=document.createElement('dt'); dt.textContent=label; const dd=document.createElement('dd'); dd.textContent=content == null ? '—' : typeof content === 'object' ? JSON.stringify(content) : String(content); dl.append(dt,dd); }
    return dl;
  };
  function renderRows(node, rows, empty='None recorded.') { node.replaceChildren(); if (!rows?.length) { node.textContent=empty; return; } for (const row of rows) { const article=document.createElement('article'); article.className='manager-row'; article.append(detail(row)); node.append(article); } }
  function renderManagerWallet(wallet) {
    $('manager-detail').hidden=false; $('manager-wallet-id').replaceChildren(detail({ 'Wallet ID': wallet.walletId, Status: wallet.status }));
    renderRows($('manager-positions'), wallet.enrollments, 'No active enrollments.');
    renderRows($('manager-general-safeguards'), wallet.safeguards.general.items, wallet.safeguards.general.status === 'not_configured' ? 'Not configured.' : 'No general safeguards.');
    renderRows($('manager-custom-safeguards'), wallet.safeguards.custom.items, wallet.safeguards.custom.status === 'not_configured' ? 'Not configured.' : 'No custom safeguards.');
    renderRows($('manager-protection-history'), wallet.protectionHistory);
    $('manager-freshness').replaceChildren(detail({ Status: wallet.freshness.status, Source: wallet.freshness.source }));
    renderRows($('manager-audit'), wallet.audit);
  }
  async function loadAgentAccess() {
    try {
      const body = await request('/internal/v1/admin/agent-access');
      const table = $('agent-access-table'); table.replaceChildren();
      for (const item of body.requests || []) {
        const card = document.createElement('article'); card.className = 'agent-access-card';
        card.textContent = `Request ${item.id || item.requestId} | ${(item.scopes || []).join(', ')} | ${item.reason} | ${item.durationMinutes} min | expires ${new Date(item.expiresAt).toISOString()} | ${item.status}`;
        if (item.status === 'pending') for (const action of ['approve', 'deny']) { const button = document.createElement('button'); button.textContent = action[0].toUpperCase() + action.slice(1); button.addEventListener('click', async () => { await request(`/internal/v1/admin/agent-access/${item.id || item.requestId}/${action}`, { method: 'POST' }); loadAgentAccess(); }); card.append(button); }
        if (['approved', 'delivered', 'exchanged'].includes(item.status)) { const button = document.createElement('button'); button.textContent = 'Revoke'; button.addEventListener('click', async () => { await request(`/internal/v1/admin/agent-access/${item.id || item.requestId}/revoke`, { method: 'POST' }); loadAgentAccess(); }); card.append(button); }
        table.append(card);
      }
      if (!table.children.length) table.textContent = 'No requests loaded.';
    } catch (error) { $('agent-access-table').textContent = error.message; }
  }
  function openPane(name, updateHash = true) {
    document.querySelectorAll('[data-pane-panel]').forEach(pane => { pane.hidden = pane.dataset.panePanel !== name; pane.classList.toggle('active', !pane.hidden); });
    if (name === 'manager') loadManager();
    if (name === 'rules' && !rulesLoaded) loadRules();
    if (name === 'agent-access') loadAgentAccess();
    if (name === 'proposals') loadProposals();
    document.querySelectorAll('[data-pane]').forEach(button => button.classList.toggle('active', button.dataset.pane === name));
    if (updateHash) history.replaceState(null, '', '#admin/' + name);
    document.querySelector(`[data-pane="${name}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  function showApp() {
    $('auth-panel').hidden = true; $('app').hidden = false;
    $('role-badge').textContent = identity.role.toUpperCase();
    $('identity-state').textContent = identity.role;
    $('actor-state').textContent = identity.actorId;
    openPane(location.hash.replace('#admin/', '') || 'overview', false);
  }
  async function verify(value) {
    token = value.trim();
    identity = await request('/internal/v1/admin/session');
    if (!['administrator', 'operator', 'auditor', 'reader'].includes(identity.role)) throw new Error('unsupported credential role');
    remember(token); showApp();
  }
  $('auth-form').addEventListener('submit', async event => {
    event.preventDefault(); const value = $('admin-token').value.trim();
    if (value.length < 32) return log('Token must contain at least 32 characters.');
    try { await verify(value); $('admin-token').value = ''; }
    catch (error) { token = null; log({ error: 'Token rejected', message: error.message, ...(error.details || {}) }); }
  });
  $('sign-out').addEventListener('click', forget);
  $('clear-log').addEventListener('click', () => log('Ready.'));
  document.querySelectorAll('[data-pane]').forEach(button => button.addEventListener('click', () => openPane(button.dataset.pane)));
  document.querySelectorAll('form.mutation').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const payload = JSON.parse(form.elements.payload.value);
      payload.reason ||= window.prompt('Reason for this audited change:') || '';
      if (!payload.reason.trim()) throw new Error('Reason is required.');
      await request('/internal/v1/admin/' + form.dataset.path, { method: 'POST', headers: { 'Idempotency-Key': createIdempotencyKey() }, body: JSON.stringify(payload) });
    } catch (error) { log({ error: error.message }); }
  }));
  $('load-snapshot').addEventListener('click', async () => {
    if (identity.role !== 'reader') return log({ error: 'Snapshot access requires the dedicated read credential.' });
    try { const data = await request('/internal/v1/config/snapshot'); $('snapshot-view').textContent = JSON.stringify(data, null, 2); $('revision-metric').textContent = data.revisionId ?? data.revision ?? 'Active'; } catch (error) { $('snapshot-view').textContent = error.message; }
  });
  $('manager-refresh').addEventListener('click', loadManager);
  $('manager-search')?.addEventListener('input', renderManagerWalletList);
  $('vault-selector').addEventListener('change', renderSelectedVault);
  $('load-rules').addEventListener('click', loadRules);
  $('load-audit').addEventListener('click', async () => { try { $('audit-view').textContent = JSON.stringify(await request('/internal/v1/admin/audit'), null, 2); } catch (error) { $('audit-view').textContent = error.message; } });
  $('load-agent-access').addEventListener('click', loadAgentAccess);
  $('load-proposals').addEventListener('click', loadProposals);
  const saved = sessionStorage.getItem('kelvara-admin-token');
  if (saved) verify(saved).catch(() => forget());
})();

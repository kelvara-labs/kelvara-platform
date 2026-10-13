import { timingSafeEqual } from 'node:crypto';
import { verifyOwnerAuthorityReceipt } from '../../contracts/src/owner-authority-receipt.js';
import { validateControlBaselineRead } from '../../contracts/src/control-baseline-read-v1.js';
import { validateGovernanceBindingsRead } from '../../contracts/src/governance-bindings-read-v1.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreflightService } from './preflight.js';
import { createAgentAccessService } from './agent-access.js';

const MIN_TOKEN_LENGTH = 32;
const PERMIT_ATTESTATION_FIELDS = ['enrollmentId', 'walletId', 'targetId', 'actionType', 'policyVersion', 'policyRevision', 'policyHash', 'transactionFingerprint', 'network', 'mint', 'destination', 'signedCapRaw', 'issuedAt', 'expiresAt', 'vaultAttestationId', 'vaultAttestationSource', 'vaultAttestationVersion'];
const DEFAULT_PERMIT_ATTESTATION_TIMEOUT_MS = 10_000;

function sendJson(response, status, body) {
  if (response.headersSent) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  });
  response.end(payload);
}

function tokenMatches(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new TypeError('application/json is required');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 100_000) throw new RangeError('request body exceeds 100000 bytes');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SyntaxError('request body must be valid JSON'); }
}

function bearer(request) {
  const value = request.headers['x-kelvara-authorization'] ?? request.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice(7) : null;
}

function normalizeCredentials({ credentials, readToken, adminToken }) {
  const source = credentials ?? [
    { token: readToken, role: 'reader', actorId: 'program-backend' },
    { token: adminToken, role: 'administrator', actorId: 'administrator' }
  ];
  if (!Array.isArray(source) || source.length < 2) throw new TypeError('at least two scoped credentials are required');
  const allowedRoles = new Set(['reader', 'administrator', 'operator', 'auditor', 'bridge', 'wallet-safeguard', 'owner-reader']);
  const normalized = source.map((credential, index) => {
    if (typeof credential?.token !== 'string' || credential.token.length < MIN_TOKEN_LENGTH) {
      throw new TypeError(`credential ${index} token must contain at least ${MIN_TOKEN_LENGTH} characters`);
    }
    if (!allowedRoles.has(credential.role)) throw new TypeError(`credential ${index} has invalid role`);
    if (typeof credential.actorId !== 'string' || credential.actorId.trim() === '') throw new TypeError(`credential ${index} actorId is required`);
    const capabilities=credential.capabilities??[];if(!Array.isArray(capabilities)||capabilities.some(value=>!['governance-bindings:read','eligible-position-enrollments:reconcile'].includes(value))||new Set(capabilities).size!==capabilities.length)throw new TypeError(`credential ${index} capabilities are invalid`);
    return { token: credential.token, role: credential.role, actorId: credential.actorId.trim(), capabilities:[...capabilities] };
  });
  if (!normalized.some(item => item.role === 'reader')) throw new TypeError('reader credential is required');
  if (!normalized.some(item => item.role === 'administrator')) throw new TypeError('administrator credential is required');
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized.some((item, other) => other !== index && tokenMatches(item.token, normalized[index].token))) {
      throw new TypeError('credential tokens must differ');
    }
  }
  return normalized;
}

function authenticate(request, credentials, agentAccess, { allowAgent = true } = {}) {
  const token = bearer(request);
  if (!token) return null;
  const identity = credentials.find(credential => tokenMatches(token, credential.token));
  if (identity || !allowAgent) return identity;
  const url = new URL(request.url, 'http://localhost');
  const agent = agentAccess?.authenticateAgent(token, request.method, url.pathname);
  return agent ? { role: 'agent', actorId: `agent:${agent.requestId}`, agent: true, scope: agent.scope, requestId: agent.requestId, scopeDenied: agent.status === 'scope_denied' } : null;
}

function requireStaticRoles(request, response, credentials, roles) {
  const identity = authenticate(request, credentials, null, { allowAgent: false });
  if (!identity) {
    sendJson(response, 401, { error: { code: 'unauthorized', message: 'valid bearer token required' } });
    return null;
  }
  if (!roles.includes(identity.role)) {
    sendJson(response, 403, { error: { code: 'role_mismatch', message: `${roles.join(' or ')} role required` } });
    return null;
  }
  return identity;
}

function validPathId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\/\u0000-\u001f\u007f]/.test(value);
}

export function validateWalletAuthReceipt(receipt, { now = Date.now(), issuer = 'kelvara-program-backend', audience = 'kelvara-control-plane' } = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new TypeError('wallet auth receipt is required');
  const fields = ['issuer', 'audience', 'walletId', 'nonce', 'issuedAt', 'expiresAt'];
  if (Object.keys(receipt).some(key => !fields.includes(key))) throw new TypeError('wallet auth receipt fields are invalid');
  for (const field of fields) if (typeof receipt[field] !== 'string' || receipt[field].trim() === '') throw new TypeError(`wallet auth receipt ${field} is required`);
  if (receipt.issuer !== issuer || receipt.audience !== audience) throw new Error('wallet_auth_receipt_binding_invalid');
  if (!validPathId(receipt.walletId) || !validPathId(receipt.nonce)) throw new TypeError('wallet auth receipt identity is invalid');
  const issued = Date.parse(receipt.issuedAt); const expires = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || issued > now || expires <= now) throw new Error('wallet_auth_receipt_expired');
  return Object.freeze({ walletId: receipt.walletId, issuer: receipt.issuer, audience: receipt.audience, nonce: receipt.nonce, issuedAt: receipt.issuedAt, expiresAt: receipt.expiresAt });
}

function requireRoles(request, response, credentials, roles, agentAccess) {
  const identity = authenticate(request, credentials, agentAccess);
  if (!identity) {
    sendJson(response, 401, { error: { code: 'unauthorized', message: 'valid bearer token required' } });
    return null;
  }
  if (identity.agent) {
    if (identity.scopeDenied) {
      sendJson(response, 403, { error: { code: 'scope_denied', message: 'agent scope does not permit this route' } });
      return null;
    }
    return identity;
  }
  if (!roles.includes(identity.role)) {
    sendJson(response, 403, { error: { code: 'role_mismatch', message: `${roles.join(' or ')} role required` } });
    return null;
  }
  return identity;
}

async function verifyPermitAttestation(verifier, attestation, timeoutMs = DEFAULT_PERMIT_ATTESTATION_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const verification = Promise.resolve().then(() => verifier(attestation, { signal: controller.signal }));
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('permit_attestation_timeout')); }, timeoutMs); });
  try {
    return await Promise.race([verification, timeout]);
  } catch (error) {
    // Do not await an uncooperative verifier after timeout; HTTP must fail closed promptly.
    throw error;
  } finally { clearTimeout(timer); }
}

function mutationError(response, error) {
  const reconciliationCodes=new Set(['mapping_missing','mapping_unverified','position_mismatch','network_mismatch','governance_evidence_missing','governance_evidence_stale','subject_mismatch','governance_evidence_identity_mismatch','upstream_unavailable']);
  if(reconciliationCodes.has(error.message))return sendJson(response,error.message==='upstream_unavailable'?503:409,{error:{code:error.message,message:'governance baseline reconciliation failed'}});
  if (error.message === 'permit_attestation_invalid') return sendJson(response, 400, { error: { code: 'permit_attestation_invalid', message: 'permit attestation is invalid' } });
  if (error.message === 'permit_attestation_timeout') return sendJson(response, 503, { error: { code: 'permit_vault_verifier_timeout', message: 'permit vault verifier unavailable' } });
  if (error.message === 'idempotency_conflict') return sendJson(response, 409, { error: { code: 'idempotency_conflict', message: error.message } });
  if (error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError) {
    return sendJson(response, 400, { error: { code: 'invalid_admin_request', message: error.message } });
  }
  return sendJson(response, 409, { error: { code: 'mutation_conflict', message: 'mutation could not be applied' } });
}

const ADMIN_ASSET_DIR = dirname(fileURLToPath(import.meta.url));
const ADMIN_ASSETS = new Map([
  ['/', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin/', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin/index.html', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/admin/admin.css', ['admin.css', 'text/css; charset=utf-8']]
]);

async function sendAdminAsset(response, pathname) {
  const asset = ADMIN_ASSETS.get(pathname);
  if (!asset) return false;
  try {
    const body = await readFile(resolve(join(ADMIN_ASSET_DIR, asset[0])));
    response.writeHead(200, { 'content-type': asset[1], 'content-length': body.length, 'cache-control': 'no-store' });
    response.end(body);
  } catch { sendJson(response, 404, { error: { code: 'not_found', message: 'admin asset not found' } }); }
  return true;
}

export function createControlPlaneServer(options) {
  const { store } = options;
  if (!store) throw new TypeError('store is required');
  const credentials = normalizeCredentials(options);
  const agentAccess = options.agentAccess ?? createAgentAccessService({ store });
  const ownerReceiptReplay = options.ownerReceiptReplay ?? new Set();

  const onboardingMutation = async (request, response, identity, action) => {
    try {
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !key.trim()) throw new TypeError('idempotency-key is required');
      const requestBody = await readJson(request); const body = { ...requestBody, actorId: identity.actorId };
      const result = store.executeAdminRequest({ idempotencyKey: key, request: { method: request.method, path: new URL(request.url, 'http://localhost').pathname, actorId: identity.actorId, body }, execute: () => ({ statusCode: action.statusCode ?? 201, response: action.run(body) }) });
      return sendJson(response, result.replay ? 200 : result.statusCode, result.response);
    } catch (error) { return mutationError(response, error); }
  };

  const mutations = new Map([
    ['/internal/v1/admin/onboarding-proposals', { roles: ['administrator', 'operator'], action: body => store.createOnboardingProposal(body) }],
    ['/internal/v1/admin/onboarding-proposals/validate', { roles: ['administrator', 'operator'], statusCode: 200, action: body => store.validateOnboardingProposal(body.proposalId, body) }],
    ['/internal/v1/admin/onboarding-proposals/activate', { roles: ['administrator'], action: body => store.activateOnboardingProposal(body.proposalId, body) }],
    ['/internal/v1/admin/onboarding-proposals/pause', { roles: ['administrator', 'operator'], action: body => store.pauseOnboardingProposal(body.proposalId, body) }],
    ['/internal/v1/admin/onboarding-proposals/retire', { roles: ['administrator'], action: body => store.retireOnboardingProposal(body.proposalId, body) }],
    ['/internal/v1/admin/assignment-outbox/ack', { roles: ['administrator', 'operator'], statusCode: 200, action: body => store.ackAssignmentOutbox(body.eventId) }],
    ['/internal/v1/admin/policy-rules', { roles: ['administrator', 'operator'], action: body => store.createPolicyRuleWithinTransaction(body) }],
    ['/internal/v1/admin/protocols', { roles: ['administrator', 'operator'], action: body => store.createProtocolWithinTransaction(body) }],
    ['/internal/v1/admin/targets', { roles: ['administrator', 'operator'], action: body => store.createTargetWithinTransaction(body) }],
    ['/internal/v1/admin/rules', { roles: ['administrator', 'operator'], action: body => store.createRuleDefinitionWithinTransaction(body) }],
    ['/internal/v1/admin/rule-versions', { roles: ['administrator', 'operator'], action: body => store.createRuleVersionWithinTransaction(body) }],
    ['/internal/v1/admin/bindings', { roles: ['administrator', 'operator'], action: body => store.createBindingWithinTransaction(body) }],
    ['/internal/v1/admin/wallets', { roles: ['administrator', 'operator'], action: body => store.createWalletWithinTransaction(body) }],
    ['/internal/v1/admin/activate', { roles: ['administrator'], action: body => store.activateDraftWithinTransaction(body) }],
    ['/internal/v1/admin/validate', { roles: ['administrator'], statusCode: 200, action: body => store.validateDraftWithinTransaction(body) }],
    ['/internal/v1/admin/enrollments', { roles: ['administrator', 'operator'], action: body => store.enrollWalletWithinTransaction(body) }]
  ]);

  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && await sendAdminAsset(response, url.pathname)) return;
      if (request.method === 'POST' && url.pathname === '/internal/v1/control-baselines/drafts') {
        const identity=requireStaticRoles(request,response,credentials,['administrator','operator']);if(!identity)return;if(!options.baselineStore)return sendJson(response,503,{error:{code:'baseline_store_unavailable',message:'baseline store unavailable'}});
        try{return sendJson(response,201,options.baselineStore.createDraft({...await readJson(request),actorId:identity.actorId}))}catch(error){return sendJson(response,400,{error:{code:'invalid_control_baseline',message:error.message}})}
      }
      const baselineMutation=request.method==='POST'&&/^\/internal\/v1\/control-baselines\/([^/]+)\/(validate|activate)$/.exec(url.pathname);
      if(baselineMutation){const identity=requireStaticRoles(request,response,credentials,baselineMutation[2]==='activate'?['administrator']:['administrator','operator']);if(!identity)return;if(!options.baselineStore)return sendJson(response,503,{error:{code:'baseline_store_unavailable',message:'baseline store unavailable'}});try{const body=await readJson(request),result=baselineMutation[2]==='validate'?options.baselineStore.validate(decodeURIComponent(baselineMutation[1]),{actorId:identity.actorId}):options.baselineStore.activate(decodeURIComponent(baselineMutation[1]),{actorId:identity.actorId,ackType:body.ackType});return sendJson(response,200,result)}catch(error){return sendJson(response,409,{error:{code:'control_baseline_transition_failed',message:error.message}})}}
      const baselineMatch = request.method === 'GET' && /^\/internal\/v1\/wallets\/([^/]+)\/control-baseline$/.exec(url.pathname);
      if (baselineMatch) {
        const identity = requireStaticRoles(request, response, credentials, ['owner-reader']); if (!identity) return;
        let walletId; try { walletId=decodeURIComponent(baselineMatch[1]); } catch { return sendJson(response,400,{error:{code:'invalid_wallet_id',message:'wallet ID is malformed'}}); }
        if (identity.actorId !== walletId && !(identity.actorId === 'program-backend' && await options.authorizeControlBaselineRead?.({actorId:identity.actorId,walletId}))) return sendJson(response,403,{error:{code:'forbidden',message:'wallet access forbidden'}});
        const network=url.searchParams.get('network');
        try { const value=await options.readControlBaseline?.({walletId,network,actorId:identity.actorId}); const result=value??{schemaVersion:'control-baseline-read/v1',network,wallet:walletId,state:'not_configured',positions:[]}; validateControlBaselineRead(result); if(result.wallet!==walletId||result.network!==network)throw new TypeError('baseline binding mismatch'); return sendJson(response,200,result); }
        catch { return sendJson(response,502,{error:{code:'control_baseline_invalid',message:'control baseline unavailable'}}); }
      }
      const enrollmentReconcileMatch = request.method === 'POST' && /^\/internal\/v1\/wallets\/([^/]+)\/eligible-position-enrollments\/reconcile$/.exec(url.pathname);
      if (enrollmentReconcileMatch) {
        const identity=authenticate(request,credentials,null,{allowAgent:false});if(!identity)return sendJson(response,401,{error:{code:'unauthorized',message:'valid bearer token required'}});
        if(identity.actorId!=='program-backend'||!identity.capabilities.includes('eligible-position-enrollments:reconcile'))return sendJson(response,403,{error:{code:'forbidden',message:'reconciliation capability required'}});
        let walletId;try{walletId=decodeURIComponent(enrollmentReconcileMatch[1])}catch{return sendJson(response,400,{error:{code:'invalid_wallet_id',message:'wallet ID is malformed'}})}
        try{const body=await readJson(request);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['network','positions'].includes(key)))throw new TypeError('request fields are invalid');const input={walletId,network:body.network,positions:body.positions,source:'eligible-position',actorId:identity.actorId};const value=options.reconcileEligiblePositions?await options.reconcileEligiblePositions(input):store.reconcileEligiblePositionEnrollments(input);const result=Array.isArray(value)?value:value.enrollments;return sendJson(response,200,{walletId,network:body.network,enrollments:result})}catch(error){return mutationError(response,error)}
      }
      const governanceBindingsMatch = request.method === 'GET' && /^\/internal\/v1\/wallets\/([^/]+)\/governance-bindings$/.exec(url.pathname);
      if (governanceBindingsMatch) {
        const identity = authenticate(request, credentials, null, { allowAgent: false });
        if (!identity) return sendJson(response,401,{error:{code:'unauthorized',message:'valid bearer token required'}});
        if (identity.role!=='owner-reader'&&!identity.capabilities.includes('governance-bindings:read')) return sendJson(response,403,{error:{code:'role_mismatch',message:'owner-reader role or governance-bindings:read capability required'}});
        let walletId; try { walletId=decodeURIComponent(governanceBindingsMatch[1]); } catch { return sendJson(response,400,{error:{code:'invalid_wallet_id',message:'wallet ID is malformed'}}); }
        const network=url.searchParams.get('network');
        if (identity.actorId !== walletId && !(identity.actorId === 'program-backend' && await options.authorizeGovernanceBindingsRead?.({actorId:identity.actorId,walletId,network}))) return sendJson(response,403,{error:{code:'forbidden',message:'wallet access forbidden'}});
        try { const value=await options.readGovernanceBindings?.({walletId,network,actorId:identity.actorId}); const result=value??{schemaVersion:'governance-bindings-read/v1',network,wallet:walletId,state:'not_configured',bindings:[]}; validateGovernanceBindingsRead(result); if(result.wallet!==walletId||result.network!==network)throw new TypeError('governance binding mismatch'); return sendJson(response,200,result); }
        catch { return sendJson(response,502,{error:{code:'governance_bindings_invalid',message:'governance bindings unavailable'}}); }
      }
      if (request.method === 'GET' && url.pathname === '/health/live') return sendJson(response, 200, { status: 'live' });
      if (request.method === 'GET' && url.pathname === '/health/ready') {
        try { store.getActiveSnapshot(); return sendJson(response, 200, { status: 'ready' }); }
        catch { return sendJson(response, 503, { status: 'not_ready' }); }
      }

      if (request.method === 'POST' && url.pathname === '/internal/v1/operations/proposals') {
        const identity = requireStaticRoles(request, response, credentials, ['bridge']);
        if (!identity) return;
        try {
          const body = await readJson(request);
          if (body && Object.prototype.hasOwnProperty.call(body, 'requester') && body.requester !== identity.actorId) {
            return sendJson(response, 403, { error: { code: 'requester_mismatch', message: 'requester must match bridge credential actor' } });
          }
          const result = store.submitOperationsProposal({ ...body, requester: identity.actorId }, { now: options.clock ?? (() => Date.now()) });
          return sendJson(response, result.status === 'approved' ? 200 : 201, result);
        } catch (error) { return mutationError(response, error); }
      }
      if (request.method === 'GET' && url.pathname === '/internal/v1/admin/operations/proposals') {
        const identity = requireStaticRoles(request, response, credentials, ['administrator']);
        if (!identity) return;
        return sendJson(response, 200, { proposals: store.listOperationsProposals({ now: options.clock ?? (() => Date.now()) }) });
      }
      const adminProposal = /^\/internal\/v1\/admin\/operations\/proposals\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
      if (request.method === 'POST' && adminProposal) {
        const identity = requireStaticRoles(request, response, credentials, ['administrator']);
        if (!identity) return;
        try {
          const body = await readJson(request);
          const result = store.decideOperationsProposal(decodeURIComponent(adminProposal[1]), { ...body, approverId: identity.actorId, decision: adminProposal[2] }, { now: options.clock ?? (() => Date.now()) });
          return sendJson(response, 200, result);
        } catch (error) { return mutationError(response, error); }
      }
      const operationProposal = /^\/internal\/v1\/operations\/proposals\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && operationProposal) {
        const identity = requireStaticRoles(request, response, credentials, ['bridge']);
        if (!identity) return;
        const result = store.getOperationsProposal(decodeURIComponent(operationProposal[1]), { now: options.clock ?? (() => Date.now()) });
        return result ? sendJson(response, 200, result) : sendJson(response, 404, { error: { code: 'not_found', message: 'proposal not found' } });
      }
      if (request.method === 'POST' && url.pathname === '/internal/v1/agent-access/requests') {
        try { return sendJson(response, 201, agentAccess.request(await readJson(request))); } catch (error) { return mutationError(response, error); }
      }
      if (request.method === 'POST' && url.pathname === '/internal/v1/agent-access/exchange') {
        try { const body=await readJson(request); if(!body||typeof body.exchangeSecret!=='string') throw new TypeError('exchangeSecret is required'); return sendJson(response,200,agentAccess.exchange(body.exchangeSecret)); } catch(error){ return mutationError(response,error); }
      }
      if (request.method === 'POST' && url.pathname === '/internal/v1/agent-access/retrieve') {
        try { const body=await readJson(request); if(!body||typeof body.requestId!=='string'||typeof body.retrievalSecret!=='string') throw new TypeError('requestId and retrievalSecret are required'); return sendJson(response,200,agentAccess.retrieve(body.requestId,body.retrievalSecret)); } catch(error){ return mutationError(response,error); }
      }
      if (url.pathname === '/internal/v1/admin/agent-access' && request.method === 'GET') {
        const identity=requireStaticRoles(request,response,credentials,['administrator']); if(!identity)return; return sendJson(response,200,{requests:agentAccess.list()});
      }
      const agentAction=/^\/internal\/v1\/admin\/agent-access\/([^/]+)\/(approve|deny|revoke)$/.exec(url.pathname);
      if (request.method==='POST'&&agentAction) { const identity=requireStaticRoles(request,response,credentials,['administrator']); if(!identity)return; try { const id=agentAction[1], action=agentAction[2]; return sendJson(response,200,action==='approve'?agentAccess.approve(id,identity.actorId):action==='deny'?agentAccess.deny(id,identity.actorId):agentAccess.revoke(id,identity.actorId)); } catch(error){ return mutationError(response,error); } }

      if (url.pathname === '/internal/v1/admin/assignment-outbox' && request.method === 'GET') {
        const identity = requireRoles(request, response, credentials, ['administrator', 'operator'], agentAccess);
        if (!identity) return;
        return sendJson(response, 200, { events: store.listAssignmentOutbox().filter(event => !event.acknowledgedAt) });
      }

      if (url.pathname === '/internal/v1/admin/manager/projection' && request.method === 'GET') {
        const identity = requireRoles(request, response, credentials, ['administrator', 'operator', 'auditor'], agentAccess);
        if (!identity) return;
        try {
          const permits = options.permitVault ? await options.permitVault.listEnrollments() : [];
          const grouped = new Map();
          for (const permit of permits) {
            const key = [permit.wallet, permit.network, permit.protocol, permit.action].join('\u0000');
            if (!grouped.has(key)) grouped.set(key, { walletId: permit.wallet, status: 'signed', authority: 'signed_permit', enrollments: [], safeguards: { general: { status: 'not_configured', items: [] }, custom: { status: 'not_configured', items: [] } }, protectionHistory: [], freshness: { status: 'unknown', source: 'permit_vault' }, audit: [], privatePositions: { status: 'unavailable', reason: 'private positions are not provided by Permit Vault' } });
            const wallet = grouped.get(key);
            if (!wallet.enrollments.some(item => item.permitFingerprint === permit.fingerprint)) wallet.enrollments.push({ permitFingerprint: permit.fingerprint, lifecycle: permit.lifecycle, readiness: permit.readiness, network: permit.network, protocol: permit.protocol, action: permit.action, createdAt: permit.createdAt, updatedAt: permit.updatedAt });
          }
          return sendJson(response, 200, { activeRevision: null, revisionActivatedAt: null, wallets: [...grouped.values()] });
        } catch { return sendJson(response, 503, { error: { code: 'permit_vault_unavailable', message: 'signed evacuation enrollment unavailable' } }); }
      }

      if (url.pathname === '/internal/v1/admin/session' && request.method === 'GET') {
        const identity = authenticate(request, credentials, agentAccess);
        if (!identity) return sendJson(response, 401, { error: { code: 'unauthorized', message: 'valid bearer token required' } });
        return sendJson(response, 200, { actorId: identity.actorId, role: identity.role });
      }

      if (url.pathname === '/internal/v1/admin/audit' && request.method === 'GET') {
        const identity = requireRoles(request, response, credentials, ['administrator', 'auditor'], agentAccess);
        if (!identity) return;
        return sendJson(response, 200, { events: store.listAuditEvents() });
      }

      const suspendWallet = /^\/internal\/v1\/admin\/wallets\/([^/]+)\/suspend$/.exec(url.pathname);
      if (request.method === 'POST' && suspendWallet) {
        const identity = requireRoles(request, response, credentials, ['administrator', 'operator'], agentAccess);
        if (!identity) return;
        let walletId;
        try { walletId = decodeURIComponent(suspendWallet[1]); } catch { return sendJson(response, 400, { error: { code: 'invalid_wallet_id', message: 'wallet ID is malformed' } }); }
        if (!validPathId(walletId)) return sendJson(response, 400, { error: { code: 'invalid_wallet_id', message: 'wallet ID is invalid' } });
        try {
          const idempotencyKey = request.headers['idempotency-key'];
          if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') throw new TypeError('idempotency-key is required');
          const requestBody = await readJson(request);
          const body = { ...requestBody, walletId, actorId: identity.actorId };
          const result = store.executeAdminRequest({ idempotencyKey, request: { method: request.method, path: url.pathname, actorId: identity.actorId, body }, execute: () => ({ statusCode: 200, response: store.suspendWalletWithinTransaction(body) }) });
          return sendJson(response, result.replay ? 200 : result.statusCode, result.response);
        } catch (error) { return mutationError(response, error); }
      }

      if (url.pathname === '/internal/v1/admin/onboarding-proposals/preflight' && request.method === 'POST') {
        const identity = requireRoles(request, response, credentials, ['administrator', 'operator'], agentAccess);
        if (!identity) return;
        try {
          const body = await readJson(request);
          const service = options.preflight?.validate ? options.preflight : createPreflightService(options.preflight ?? {});
          const receipt = await service.validate(body);
          store.storePreflightReceipt(receipt);
          return sendJson(response, 200, receipt);
        } catch (error) { return mutationError(response, error); }
      }

      if (request.method === 'GET' && url.pathname === '/internal/v1/admin/rules-by-vault') {
        const identity = requireRoles(request, response, credentials, ['administrator', 'operator', 'auditor'], agentAccess);
        if (!identity) return;
        return sendJson(response, 200, store.getRulesByVault());
      }
      if (url.pathname.startsWith('/internal/v1/admin/')) {
        const mutation = mutations.get(url.pathname);
        if (!mutation || request.method !== 'POST') {
          const identity = requireRoles(request, response, credentials, ['administrator', 'operator', 'auditor'], agentAccess);
          if (!identity) return;
          return sendJson(response, 404, { error: { code: 'not_found', message: 'admin route not implemented' } });
        }
        const identity = requireRoles(request, response, credentials, mutation.roles, agentAccess);
        if (!identity) return;
        try {
          const idempotencyKey = request.headers['idempotency-key'];
          if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') throw new TypeError('idempotency-key is required');
          const requestBody = await readJson(request);
          const body = { ...requestBody, actorId: identity.actorId };
          const result = store.executeAdminRequest({
            idempotencyKey,
            request: { method: request.method, path: url.pathname, actorId: identity.actorId, body },
            execute: () => ({ statusCode: mutation.statusCode ?? 201, response: mutation.action(body) })
          });
          return sendJson(response, result.replay ? 200 : result.statusCode, result.response);
        } catch (error) { return mutationError(response, error); }
      }

      const targetPolicy = /^\/internal\/v1\/targets\/([^/]+)\/policy$/.exec(url.pathname);
      if (request.method === 'GET' && targetPolicy) {
        const identity = requireRoles(request, response, credentials, ['reader'], agentAccess);
        if (!identity) return;
        let targetId;
        try { targetId = decodeURIComponent(targetPolicy[1]); } catch { return sendJson(response, 400, { error: { code: 'invalid_target_id', message: 'target ID is malformed' } }); }
        if (!validPathId(targetId)) return sendJson(response, 400, { error: { code: 'invalid_target_id', message: 'target ID is invalid' } });
        const policy = store.getTargetPolicy(targetId);
        return policy ? sendJson(response, 200, policy) : sendJson(response, 404, { error: { code: 'target_not_found', message: 'target policy not found' } });
      }
      if (request.method === 'POST' && url.pathname === '/internal/v1/config/batch-read') {
        const identity = requireRoles(request, response, credentials, ['reader'], agentAccess);
        if (!identity) return;
        try {
          const body = await readJson(request);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'targetIds')) throw new TypeError('request fields are invalid');
          if (!Array.isArray(body.targetIds) || body.targetIds.length < 1 || body.targetIds.length > 100) throw new RangeError('targetIds must contain 1 to 100 IDs');
          const targetIds = body.targetIds.map((targetId, index) => {
            if (typeof targetId !== 'string' || !validPathId(targetId)) throw new TypeError(`targetIds[${index}] is invalid`);
            return targetId;
          });
          if (new Set(targetIds).size !== targetIds.length) throw new TypeError('targetIds must be unique');
          const resolvedTargetIds = targetIds.map(targetId => store.resolveTarget(targetId)?.targetId ?? targetId);
          if (new Set(resolvedTargetIds).size !== resolvedTargetIds.length) throw new TypeError('targetIds must be unique by canonical identity');
          const result = store.getBatchPolicy(targetIds);
          return result ? sendJson(response, 200, result) : sendJson(response, 404, { error: { code: 'target_not_found', message: 'one or more targets not found' } });
        } catch (error) { return mutationError(response, error); }
      }
      if (request.method === 'POST' && url.pathname === '/internal/v1/onboarding-evidence') {
        const identity = requireRoles(request, response, credentials, ['administrator', 'operator'], agentAccess);
        if (!identity) return;
        try {
          const body = await readJson(request);
          const allowed = ['targetId', 'cursor', 'firstObservationAt', 'tvl', 'requiredReceipts'];
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key)) || typeof body.targetId !== 'string') throw new TypeError('evidence request fields are invalid');
          const { targetId, ...evidence } = body;
          const idempotencyKey = request.headers['idempotency-key'];
          if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') throw new TypeError('idempotency-key is required');
          const result = store.executeAdminRequest({
            idempotencyKey,
            request: { method: request.method, path: url.pathname, actorId: identity.actorId, body },
            execute: () => ({ statusCode: 201, response: store.recordOnboardingEvidence(targetId, evidence, { actorId: identity.actorId, reason: 'onboarding evidence received' }) })
          });
          return sendJson(response, result.replay ? 200 : 201, result.response);
        } catch (error) { return mutationError(response, error); }
      }
      if (request.method === 'GET' && url.pathname === '/internal/v1/config/supported-positions') {
        const identity = requireRoles(request, response, credentials, ['reader'], agentAccess);
        if (!identity) return;
        const network = url.searchParams.get('network');
        if (!['mainnet-beta', 'devnet'].includes(network) || url.searchParams.get('network') === null) return sendJson(response, 400, { error: { code: 'unsupported_network', message: 'network must be mainnet-beta or devnet' } });
        try { return sendJson(response, 200, store.getSupportedPositions(network)); }
        catch (error) { return mutationError(response, error); }
      }
      if (request.method === 'GET' && url.pathname === '/internal/v1/config/discovery-manifest') {
        const identity = requireRoles(request, response, credentials, ['reader'], agentAccess);
        if (!identity) return;
        try {
          const manifest = store.getDiscoveryManifest();
          return manifest ? sendJson(response, 200, manifest) : sendJson(response, 404, { error: { code: 'no_active_revision', message: 'no active configuration revision' } });
        } catch (error) { return mutationError(response, error); }
      }
      if (request.method === 'GET' && url.pathname === '/internal/v1/admin/rules-by-vault') {
        const identity = requireRoles(request, response, credentials, ['administrator', 'operator', 'auditor'], agentAccess);
        if (!identity) return;
        return sendJson(response, 200, store.getRulesByVault());
      }
      if (request.method === 'GET' && url.pathname === '/internal/v1/config/snapshot') {
        const identity = requireRoles(request, response, credentials, ['reader'], agentAccess);
        if (!identity) return;
        const active = store.getActiveSnapshot();
        return active ? sendJson(response, 200, active) : sendJson(response, 404, { error: { code: 'no_active_revision', message: 'no active configuration revision' } });
      }
      if (request.method === 'POST' && url.pathname === '/internal/v1/private/wallet-safeguards') {
        const identity = requireStaticRoles(request, response, credentials, ['owner-reader']);
        if (!identity) return;
        try {
          const body = await readJson(request);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !body.receipt) throw new TypeError('receipt is required');
          if (!options.ownerReceiptPublicKey || typeof options.getOwnerSafeguards !== 'function') return sendJson(response, 503, { error: { code: 'owner_safeguard_unavailable', message: 'owner safeguard unavailable' } });
          const receipt = verifyOwnerAuthorityReceipt(body.receipt, options.ownerReceiptPublicKey, { now: (options.clock ?? (() => Date.now()))() });
          if (ownerReceiptReplay.has(receipt.nonce)) return sendJson(response, 404, { error: { code: 'not_found', message: 'resource not found' } });
          ownerReceiptReplay.add(receipt.nonce);
          const result = await options.getOwnerSafeguards(receipt.walletId);
          if (!result || result.walletId !== receipt.walletId || !Array.isArray(result.enrollments)) return sendJson(response, 404, { error: { code: 'not_found', message: 'resource not found' } });
          return sendJson(response, 200, { walletId: receipt.walletId, enrollments: result.enrollments });
        } catch { return sendJson(response, 404, { error: { code: 'not_found', message: 'resource not found' } }); }
      }
      if (request.method === 'POST' && url.pathname === '/internal/v1/wallet-protection/enroll') {
        const identity = requireStaticRoles(request, response, credentials, ['bridge']);
        if (!identity) return;
        try {
          const key = request.headers['idempotency-key'];
          if (typeof key !== 'string' || !/^[-A-Za-z0-9_:.]{1,128}$/.test(key)) throw new TypeError('idempotency-key is invalid');
          const body = await readJson(request);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['walletId', 'policy', 'reason', 'walletAuthReceipt'].includes(key))) throw new TypeError('request fields are invalid');
          if (typeof options.walletAuthVerifier !== 'function') return sendJson(response, 503, { error: { code: 'wallet_auth_verifier_unavailable', message: 'wallet receipt verifier unavailable' } });
          let receipt;
          try { receipt = await options.walletAuthVerifier(body.walletAuthReceipt); } catch { return sendJson(response, 401, { error: { code: 'unauthorized', message: 'valid wallet session required' } }); }
          if (!receipt || receipt.walletId !== body.walletId) return sendJson(response, 403, { error: { code: 'owner_mismatch', message: 'wallet owner authentication mismatch' } });
          const result = store.executeAdminRequest({ idempotencyKey: key, request: { method: request.method, path: url.pathname, actorId: receipt.walletId, body: { walletId: body.walletId, policy: body.policy, reason: body.reason } }, execute: () => ({ statusCode: 201, response: store.createWalletProtectionEnrollmentWithinTransaction({ ...body, actorId: receipt.walletId }) }) });
          return sendJson(response, result.replay ? 200 : result.statusCode, result.response);
        } catch (error) { return mutationError(response, error); }
      }
      if (request.method === 'POST' && url.pathname === '/internal/wallet-safeguard-identity') {
        const identity = requireStaticRoles(request, response, credentials, ['wallet-safeguard']);
        if (!identity) return;
        try {
          const body = await readJson(request);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'identityRef')) throw new TypeError('request fields are invalid');
          if (typeof body.identityRef !== 'string' || body.identityRef.length < 1 || body.identityRef.length > 256 || /[\u0000-\u001f\u007f]/.test(body.identityRef)) throw new TypeError('identityRef is invalid');
          const resolved = store.getWalletSafeguardIdentity(body.identityRef);
          return resolved ? sendJson(response, 200, resolved) : sendJson(response, 404, { error: { code: 'not_found', message: 'resource not found' } });
        } catch (error) { return mutationError(response, error); }
      }
      const ownerProtection = /^\/internal\/v1\/wallet-protection\/wallets\/([^/]+)\/(status|audit|permit\/validate|permit\/store|arm|revoke|expire|position-absent)$/.exec(url.pathname);
      if (ownerProtection) {
        const identity = requireStaticRoles(request, response, credentials, ['bridge']);
        if (!identity) return;
        if (request.method !== 'POST') return sendJson(response, 404, { error: { code: 'not_found', message: 'route not found' } });
        let walletId;
        try { walletId = decodeURIComponent(ownerProtection[1]); } catch { return sendJson(response, 400, { error: { code: 'invalid_wallet_id', message: 'wallet ID is malformed' } }); }
        if (!validPathId(walletId)) return sendJson(response, 400, { error: { code: 'invalid_wallet_id', message: 'wallet ID is invalid' } });
        if (typeof options.walletAuthVerifier !== 'function') return sendJson(response, 503, { error: { code: 'wallet_auth_verifier_unavailable', message: 'wallet receipt verifier unavailable' } });
        try {
          const body = await readJson(request);
          const action = ownerProtection[2];
          const allowed = action === 'status' || action === 'audit' ? ['walletAuthReceipt'] : action.startsWith('permit/') || action === 'arm' ? ['walletAuthReceipt', 'enrollmentId', 'permit', 'attestation', 'reason'] : ['walletAuthReceipt', 'enrollmentId', 'reason'];
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new TypeError('request fields are invalid');
          let receipt;
          try { receipt = await options.walletAuthVerifier(body.walletAuthReceipt); } catch { return sendJson(response, 401, { error: { code: 'unauthorized', message: 'valid wallet session required' } }); }
          if (!receipt || receipt.walletId !== walletId) return sendJson(response, 404, { error: { code: 'not_found', message: 'resource not found' } });
          if (action !== 'status' && action !== 'audit' && (typeof body.reason !== 'string' || body.reason.trim() === '')) throw new TypeError('reason is required');
          const enrollment = store.getWalletProtectionEnrollment(walletId, walletId);
          if (!enrollment) return sendJson(response, 404, { error: { code: 'not_found', message: 'resource not found' } });
          if (action === 'status') return sendJson(response, 200, store.getWalletProtectionOwnerProjection(walletId, walletId));
          if (action === 'audit') return sendJson(response, 200, { walletId, events: store.listWalletProtectionLifecycleAuditForOwner(walletId, walletId) });
          const key = request.headers['idempotency-key'];
          if (typeof key !== 'string' || !/^[-A-Za-z0-9_:.]{1,128}$/.test(key)) throw new TypeError('idempotency-key is invalid');
          if (body.enrollmentId !== undefined && body.enrollmentId !== walletId && body.enrollmentId !== enrollment.enrollmentId) return sendJson(response, 404, { error: { code: 'not_found', message: 'resource not found' } });
          const canonicalBody = { ...body, enrollmentId: enrollment.enrollmentId };
          const requestIdentity = { method: request.method, path: url.pathname, actorId: walletId, body: canonicalBody };
          const replay = store.getIdempotentRequest(key, requestIdentity);
          if (replay) return sendJson(response, replay.statusCode, replay.response);
          const permitAction = action.startsWith('permit/') || action === 'arm';
          const states = { revoke: 'revoked', expire: 'expired', 'position-absent': 'inactive_position_absent' };
          let verifiedPermit;
          if (permitAction) {
            if (typeof options.permitVaultAttestationVerifier !== 'function') return sendJson(response, 503, { error: { code: 'permit_vault_verifier_unavailable', message: 'permit vault verifier unavailable' } });
            const permit = body.permit;
            if (!permit || permit.enrollmentId !== enrollment.enrollmentId || permit.walletId !== walletId) return sendJson(response, 404, { error: { code: 'not_found', message: 'resource not found' } });
            let verified;
            try { verified = await verifyPermitAttestation(options.permitVaultAttestationVerifier, body.attestation ?? permit, options.permitVaultAttestationTimeoutMs ?? DEFAULT_PERMIT_ATTESTATION_TIMEOUT_MS); } catch (error) { if (error.message === 'permit_attestation_timeout') throw error; throw new Error('permit_attestation_invalid'); }
            if (!verified || verified.verified !== true || PERMIT_ATTESTATION_FIELDS.some(field => verified[field] !== permit[field]) || Object.keys(verified).some(field => field !== 'verified' && !PERMIT_ATTESTATION_FIELDS.includes(field))) throw new Error('permit_attestation_invalid');
            verifiedPermit = permit;
          }
          const result = store.executeAdminRequest({
            idempotencyKey: key,
            request: requestIdentity,
            execute: () => ({ statusCode: 200, response: permitAction
              ? (action === 'permit/validate' ? store.validateWalletProtectionPermit(verifiedPermit, { actorId: walletId, withinTransaction: true })
                : action === 'permit/store' ? store.storeWalletProtectionPermit(verifiedPermit, { actorId: walletId, reason: body.reason, withinTransaction: true })
                : store.armWalletProtectionEnrollment(verifiedPermit, { actorId: walletId, reason: body.reason, withinTransaction: true }))
              : store.transitionWalletProtectionEnrollment(enrollment.enrollmentId, { actorId: walletId, toState: states[action], reason: body.reason, withinTransaction: true }) })
          });
          return sendJson(response, result.replay ? 200 : result.statusCode, result.response);
        } catch (error) { return mutationError(response, error); }
      }
      const enrollment = /^\/internal\/v1\/wallets\/([^/]+)\/enrollments$/.exec(url.pathname);
      if (request.method === 'GET' && enrollment) {
        const identity = requireRoles(request, response, credentials, ['reader'], agentAccess);
        if (!identity) return;
        let walletId;
        try { walletId = decodeURIComponent(enrollment[1]); } catch { return sendJson(response, 400, { error: { code: 'invalid_wallet_id', message: 'wallet ID is malformed' } }); }
        if (!validPathId(walletId)) return sendJson(response, 400, { error: { code: 'invalid_wallet_id', message: 'wallet ID is invalid' } });
        return sendJson(response, 200, { walletId, enrollments: store.listWalletEnrollments(walletId) });
      }
      return sendJson(response, 404, { error: { code: 'not_found', message: 'route not found' } });
    })().catch(error => {
      console.error('control_plane_request_failed', error);
      sendJson(response, 500, { error: { code: 'internal_error', message: 'request failed' } });
    });
  });
}

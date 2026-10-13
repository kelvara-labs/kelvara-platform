import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readGovernanceActions } from './governance-action-read.js';
import { readGovernanceDetections } from './governance-detection-store.js';

import { ingestObservationBatch } from './ingest-batch.js';
import { getWalletSafeguardObservation, recordWalletSafeguardObservation } from './wallet-safeguard-observations.js';
import { recordScenarioCapsuleObservation } from './scenario-capsule-observations.js';
import { evaluateWalletSafeguardReceipt } from '@kelvara/contracts/wallet-safeguard-receipt';
import { verifyOwnerAuthorityReceipt } from '@kelvara/contracts/owner-authority-receipt';
import { listLatestEvaluationReceiptsByIdentity } from './evaluation-receipts.js';
import { listEvacuationEvents, recordEvacuationEvent } from './evacuation-events.js';
import { listLatestEvaluationReceipts, recordEvaluationReceipt } from './evaluation-receipts.js';
import { getOperationsEvacuations, getOperationsIndexers, getOperationsOverview, getOperationsTargets } from './operations.js';
import { listCursors, recordHeartbeat, registerWorker, upsertTargets } from './worker-control.js';
import { assignDesiredTarget, listDesiredTargets, registerDesiredTarget, recordReconciliationStatus } from './desired-targets.js';
import { parseGovernanceReadQuery, readGovernance, readSubjectGovernance, governanceCors } from './governance-read.js';
import { listVelocityObservations, recordVelocityObservation } from './velocity-observations.js';
import { velocityProtocolProjection, velocityAccountsProjection, velocityAccountProjection, unavailableVelocityReadModel } from './velocity-read-model.js';
import { recordVelocityTransaction, listVelocityTransactions, listVelocityActions, getVelocityTransaction } from './velocity-activity.js';
import { createVelocityTransactionStore } from './velocity-transaction-ingest.js';
import { createOperationsDatabase } from './database.js';

const WEB_ASSETS = new Map([
  ['/operations/', ['../web/index.html', 'text/html; charset=utf-8']],
  ['/operations/app.js', ['../web/app.js', 'text/javascript; charset=utf-8']],
  ['/operations/styles.css', ['../web/styles.css', 'text/css; charset=utf-8']]
]);

const MAX_BODY_BYTES = 1_000_000;
const MIN_TOKEN_LENGTH = 32;

function requireStrongToken(value, name) {
  if (typeof value !== 'string' || value.length < MIN_TOKEN_LENGTH) throw new TypeError(`${name} must contain at least ${MIN_TOKEN_LENGTH} characters`);
  return value;
}
const REGISTER_ROUTE = '/internal/indexers/register';
const HEARTBEAT_ROUTE = /^\/internal\/indexers\/([^/]+)\/heartbeat$/;
const TARGETS_ROUTE = /^\/internal\/indexers\/([^/]+)\/targets$/;
const CURSORS_ROUTE = /^\/internal\/indexers\/([^/]+)\/cursors$/;
const DESIRED_ROUTE = /^\/internal\/indexers\/([^/]+)\/desired-targets$/;
const RECONCILIATION_ROUTE = /^\/internal\/indexers\/([^/]+)\/reconciliation$/;
const BATCH_ROUTE = /^\/internal\/indexers\/([^/]+)\/batches$/;

function sendJson(response, status, body) {
  if (response.headersSent || response.writableEnded) return false;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  response.end(payload);
}

async function sendAsset(response, pathname) {
  const asset = WEB_ASSETS.get(pathname);
  if (!asset) return false;
  const [relativePath, contentType] = asset;
  try {
    const body = await readFile(new URL(relativePath, import.meta.url));
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': body.length,
      'cache-control': 'no-store'
    });
    response.end(body);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      sendJson(response, 404, { error: { code: 'asset_not_found', message: 'asset not found' } });
      return true;
    }
    sendJson(response, 500, { error: { code: 'asset_unavailable', message: 'asset unavailable' } });
    return true;
  }
  return true;
}

function tokenMatches(received, expected) {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authenticate(request, tokens) {
  const authorization = request.headers['x-kelvara-authorization'] || request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return null;
  const received = authorization.slice(7);
  for (const [indexerId, token] of tokens) {
    if (tokenMatches(received, token)) return indexerId;
  }
  return null;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RangeError('request body exceeds 1000000 bytes');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SyntaxError('request body must be valid JSON');
  }
}

export function createBackendServer({ db, tokens, evacuationToken, evaluationToken, walletSafeguardToken, revalidationToken, resolveWalletSafeguardIdentity, observationTokens = new Map(), observationProducerId, observationProducerSources, scenarioRegistry, readGovernanceAuthorization, governanceAvailability, velocityViewerToken, ownerReceiptPublicKey, privateReceiptToken, assignmentToken = evaluationToken, now = () => new Date() }) {
  if (!(tokens instanceof Map)) throw new TypeError('tokens must be a Map');
  if (velocityViewerToken !== undefined) requireStrongToken(velocityViewerToken, 'velocityViewerToken');
  if (observationTokens.size > 0 && (!(observationProducerSources instanceof Map) || observationProducerSources.size !== observationTokens.size || [...observationTokens.keys()].some(id => !observationProducerSources.has(id)))) throw new TypeError('observationProducerSources must explicitly map every producer');
  requireStrongToken(evacuationToken, 'evacuationToken');
  requireStrongToken(evaluationToken, 'evaluationToken');
  if (privateReceiptToken !== undefined && privateReceiptToken !== '') requireStrongToken(privateReceiptToken, 'privateReceiptToken');
  if (ownerReceiptPublicKey && !privateReceiptToken) throw new TypeError('privateReceiptToken is required with ownerReceiptPublicKey');
  if (walletSafeguardToken !== undefined && walletSafeguardToken !== '') requireStrongToken(walletSafeguardToken, 'walletSafeguardToken');
  if (resolveWalletSafeguardIdentity !== undefined && typeof resolveWalletSafeguardIdentity !== 'function') throw new TypeError('resolveWalletSafeguardIdentity must be a function');
  const allTokens = [evaluationToken, walletSafeguardToken, evacuationToken, revalidationToken, ...tokens.values()].filter(Boolean);
  let transactionDb = db;
  try { transactionDb.prepare('SELECT 1').get(); } catch { transactionDb = createOperationsDatabase(':memory:'); }
  const velocityTransactionStore = createVelocityTransactionStore(transactionDb);
  if (new Set(allTokens).size !== allTokens.length) throw new TypeError('service tokens must be distinct');
  for (const token of tokens.values()) requireStrongToken(token, 'indexerToken');
  if (!Number.isFinite(now().valueOf())) throw new TypeError('now must return a valid date');
  requireStrongToken(assignmentToken, 'assignmentToken');

  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/internal/v1/assignments') {
      const received = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      if (!tokenMatches(received, assignmentToken)) return sendJson(response, 401, { error: { code: 'unauthorized', message: 'assignment token required' } });
      try {
        const event = await readJson(request); const payload = event.payload ?? event;
        const result = registerDesiredTarget(db, { targetId: payload.targetId, chain: payload.chain, network: payload.network, protocol: payload.protocol, kind: payload.kind, address: payload.address, status: event.eventType === 'assignment.activated' ? 'activated' : event.eventType === 'assignment.paused' ? 'paused' : 'retired', revision: payload.revision ?? 1 }, now());
        if (event.eventType === 'assignment.activated') { if (typeof payload.indexerId !== 'string' || !payload.indexerId) throw new TypeError('indexerId is required'); assignDesiredTarget(db, { targetId: payload.targetId, indexerId: payload.indexerId, protocol: payload.protocol, network: payload.network }, now()); }
        return sendJson(response, result.created ? 201 : 200, { ...result, eventId: event.eventId });
      } catch (error) {
        if (error.message === 'target_identity_conflict') return sendJson(response, 409, { error: { code: 'idempotency_conflict', message: error.message } });
        if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return sendJson(response, 400, { error: { code: 'invalid_assignment', message: error.message } });
        return sendJson(response, 409, { error: { code: 'assignment_conflict', message: error.message } });
      }
    }

    if (['GET', 'POST'].includes(request.method) && url.pathname === '/internal/evacuation-events') {
      const authorization = request.headers.authorization || '';
      if (!evacuationToken || !tokenMatches(authorization.startsWith('Bearer ') ? authorization.slice(7) : '', evacuationToken)) {
        return sendJson(response, 401, { error: { code: 'unauthorized', message: 'evacuation token required' } });
      }
      try {
        if (request.method === 'GET') {
          return sendJson(response, 200, listEvacuationEvents(db, {
            limit: url.searchParams.get('limit') ?? 50,
            cursor: url.searchParams.get('cursor')
          }));
        }
        const body = await readJson(request);
        const result = recordEvacuationEvent(db, body, now());
        return sendJson(response, result.inserted ? 201 : 200, result);
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) {
          const code = request.method === 'GET' ? 'invalid_pagination' : 'invalid_evacuation_event';
          return sendJson(response, 400, { error: { code, message: error.message } });
        }
        return sendJson(response, 500, { error: { code: 'internal_error', message: 'internal server error' } });
      }
    }
    if (request.method === 'POST' && url.pathname === '/internal/scenario-capsule-observations') {
      const producerId = authenticate(request, observationTokens);
      if (!producerId) return sendJson(response, 401, { error: { code: 'unauthorized', message: 'valid observation producer token required' } });
      if (observationProducerSources.get(producerId) !== 'scenario-capsule-devnet') return sendJson(response, 403, { error: { code: 'forbidden', message: 'producer is not authorized for Scenario Capsule observations' } });
      try {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'evidence')) throw new TypeError('request fields are invalid');
        const result = recordScenarioCapsuleObservation(db, body, scenarioRegistry, now());
        return sendJson(response, result.inserted ? 201 : 200, result);
      } catch (error) {
        if (error.message === 'observation_conflict' || error.message === 'receipt_idempotency_conflict' || error.message === 'receipt_id_conflict') return sendJson(response, 409, { error: { code: 'observation_conflict', message: error.message } });
        if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return sendJson(response, 400, { error: { code: 'invalid_scenario_capsule_observation', message: error.message } });
        return sendJson(response, 500, { error: { code: 'internal_error', message: 'internal server error' } });
      }
    }
    if (request.method === 'POST' && url.pathname === '/internal/wallet-safeguard-observations') {
      const producerId = authenticate(request, observationTokens);
      if (!producerId) return sendJson(response, 401, { error: { code: 'unauthorized', message: 'valid observation producer token required' } });
      try {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['evidenceRef', 'targetId', 'evidence'].includes(key))) throw new TypeError('request fields are invalid');
        const result = recordWalletSafeguardObservation(db, { ...body, producerId }, now().toISOString());
        return sendJson(response, result.inserted ? 201 : 200, result);
      } catch (error) {
        if (error.message === 'observation_conflict') return sendJson(response, 409, { error: { code: 'observation_conflict', message: error.message } });
        if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return sendJson(response, 400, { error: { code: 'invalid_wallet_safeguard_observation', message: error.message } });
        return sendJson(response, 500, { error: { code: 'internal_error', message: 'internal server error' } });
      }
    }
    if (request.method === 'POST' && url.pathname === '/internal/wallet-safeguard-revalidations') {
      if (!revalidationToken || !tokenMatches(request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '', revalidationToken)) {
        return sendJson(response, revalidationToken ? 401 : 503, { error: { code: revalidationToken ? 'unauthorized' : 'revalidation_unavailable', message: 'revalidation service unavailable' } });
      }
      try {
        const body = await readJson(request);
        const allowed = new Set(['identityRef', 'eventId', 'bindingId', 'targetId', 'policyRevision', 'policyHash', 'policyVersion', 'actionType', 'ruleId', 'ruleVersion', 'evaluatorVersion', 'sourceId']);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.has(key))) throw new TypeError('request fields are invalid');
        if (typeof body.identityRef !== 'string' || body.identityRef.length < 1 || body.identityRef.length > 256 || /[\u0000-\u001f\u007f]/.test(body.identityRef)) throw new TypeError('identityRef is invalid');
        for (const key of ['eventId', 'bindingId', 'targetId', 'ruleId', 'evaluatorVersion', 'sourceId']) if (typeof body[key] !== 'string' || !body[key]) throw new TypeError(`${key} is invalid`);
        for (const key of ['policyRevision', 'policyVersion', 'ruleVersion']) if (!Number.isSafeInteger(body[key]) || body[key] < 1) throw new TypeError(`${key} is invalid`);
        if (typeof body.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.policyHash) || typeof body.actionType !== 'string' || !body.actionType) throw new TypeError('policy identity is invalid');
        const identity = await resolveWalletSafeguardIdentity?.(body.identityRef);
        if (!identity || identity.bindingId !== body.bindingId || identity.policy.targetId !== body.targetId || identity.policy.policyRevision !== body.policyRevision || identity.policy.policyHash !== body.policyHash || identity.policy.policyVersion !== body.policyVersion || identity.policy.actionType !== body.actionType || identity.ruleId !== body.ruleId || identity.ruleVersion !== body.ruleVersion || identity.policy.evaluatorVersion !== body.evaluatorVersion || identity.policy.expectedEvidenceSource !== body.sourceId) return sendJson(response, 404, { error: { code: 'not_found', message: 'revalidation identity not found' } });
        const observation = db.prepare(`SELECT evidence_ref,target_id,evidence_json FROM wallet_safeguard_observations WHERE producer_id=? AND target_id=? ORDER BY observed_at DESC, evidence_ref DESC LIMIT 1`).get(observationProducerId, identity.policy.targetId);
        if (!observation) return sendJson(response, 404, { error: { code: 'not_found', message: 'authoritative observation not found' } });
        const evidence = JSON.parse(observation.evidence_json);
        const receipt = evaluateWalletSafeguardReceipt({ ...identity, idempotencyKey: `revalidation:${body.eventId}`, evidenceRef: observation.evidence_ref, evidence, receiptId: `wallet-safeguard-revalidation:${createHash('sha256').update(`${body.identityRef}:${body.eventId}`).digest('hex')}`, now: now().toISOString() });
        return sendJson(response, 201, { receipt: { ...receipt, provenance: { ...receipt.provenance, sourceId: body.sourceId } } });
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return sendJson(response, 400, { error: { code: 'invalid_revalidation', message: error.message } });
        return sendJson(response, 409, { error: { code: 'revalidation_failed', message: 'authoritative revalidation failed' } });
      }
    }
    if (request.method === 'POST' && url.pathname === '/internal/wallet-safeguard-evaluations') {
      if (!walletSafeguardToken || typeof resolveWalletSafeguardIdentity !== 'function') return sendJson(response, 503, { error: { code: 'resolver_unavailable', message: 'wallet safeguard resolver unavailable' } });
      if (!tokenMatches(request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '', walletSafeguardToken)) {
        return sendJson(response, 401, { error: { code: 'unauthorized', message: 'wallet safeguard token required' } });
      }
      try {
        const body = await readJson(request);
        const allowed = new Set(['identityRef', 'idempotencyKey', 'evidenceRef']);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.has(key))) throw new TypeError('request fields are invalid');
        if (typeof body.identityRef !== 'string' || body.identityRef.length < 1 || body.identityRef.length > 256 || /[\u0000-\u001f\u007f]/.test(body.identityRef)) throw new TypeError('identityRef is invalid');
        if (typeof resolveWalletSafeguardIdentity !== 'function') return sendJson(response, 503, { error: { code: 'resolver_unavailable', message: 'wallet safeguard resolver unavailable' } });
        const identity = await resolveWalletSafeguardIdentity(body.identityRef);
        if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return sendJson(response, 404, { error: { code: 'not_found', message: 'wallet safeguard identity not found' } });
        if (typeof body.evidenceRef !== 'string' || body.evidenceRef.length < 1 || body.evidenceRef.length > 256) throw new TypeError('evidenceRef is invalid');
        const producerId = observationProducerId;
        if (!producerId || !observationProducerSources.has(producerId) || observationProducerSources.get(producerId) !== identity.policy.expectedEvidenceSource) return sendJson(response, 404, { error: { code: 'not_found', message: 'wallet safeguard observation not found' } });
        const observation = getWalletSafeguardObservation(db, { evidenceRef: body.evidenceRef, producerId, targetId: identity.policy.targetId });
        if (!observation) return sendJson(response, 404, { error: { code: 'not_found', message: 'wallet safeguard observation not found' } });
        const receipt = evaluateWalletSafeguardReceipt({ ...identity, idempotencyKey: body.idempotencyKey, evidenceRef: body.evidenceRef, evidence: observation.evidence, receiptId: `wallet-safeguard:${createHash('sha256').update(`${body.identityRef}:${body.idempotencyKey}`).digest('hex')}`, now: now().toISOString() });
        const result = recordEvaluationReceipt(db, receipt, now());
        return sendJson(response, result.inserted ? 201 : 200, { inserted: result.inserted, receiptId: result.receiptId, policyRevision: result.policyRevision });
      } catch (error) {
        if (error.message === 'receipt_idempotency_conflict' || error.message === 'receipt_id_conflict') return sendJson(response, 409, { error: { code: 'idempotency_conflict', message: error.message } });
        if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return sendJson(response, 400, { error: { code: 'invalid_wallet_safeguard_evaluation', message: error.message } });
        return sendJson(response, 500, { error: { code: 'internal_error', message: 'internal server error' } });
      }
    }
    if (request.method === 'POST' && url.pathname === '/internal/evaluation-receipts') {
      if (!evaluationToken || !tokenMatches(request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '', evaluationToken)) {
        return sendJson(response, 401, { error: { code: 'unauthorized', message: 'evaluation receipt token required' } });
      }
      try {
        const result = recordEvaluationReceipt(db, await readJson(request), now());
        return sendJson(response, result.inserted ? 201 : 200, result);
      } catch (error) {
        if (error.message === 'receipt_idempotency_conflict' || error.message === 'receipt_id_conflict') return sendJson(response, 409, { error: { code: 'idempotency_conflict', message: error.message } });
        if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return sendJson(response, 400, { error: { code: 'invalid_evaluation_receipt', message: error.message } });
        return sendJson(response, 500, { error: { code: 'internal_error', message: 'internal server error' } });
      }
    }
    if (request.method === 'POST' && url.pathname === '/internal/evaluation-receipts/private-exact') {
      const authorization = request.headers.authorization || '';
      if (!privateReceiptToken || !tokenMatches(authorization.startsWith('Bearer ') ? authorization.slice(7) : '', privateReceiptToken)) return sendJson(response, 401, { error: { code: 'unauthorized', message: 'private receipt token required' } });
      try {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || !body.receipt || Object.keys(body).some(key => !['receipt', 'policyRevision', 'identities'].includes(key))) throw new TypeError('request fields are invalid');
        const identity = verifyOwnerAuthorityReceipt(body.receipt, ownerReceiptPublicKey);
        if (!Array.isArray(body.identities)) throw new TypeError('identities must be an array');
        const receipts = listLatestEvaluationReceiptsByIdentity(db, { policyRevision: body.policyRevision, identities: body.identities });
        return sendJson(response, 200, { policyRevision: body.policyRevision, receipts });
      } catch (error) { return sendJson(response, 404, { error: { code: 'not_found', message: 'resource not found' } }); }
    }
    if (request.method === 'POST' && url.pathname === '/internal/evaluation-receipts/batch-read') {
      if (!evaluationToken || !tokenMatches(request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '', evaluationToken)) {
        return sendJson(response, 401, { error: { code: 'unauthorized', message: 'evaluation receipt token required' } });
      }
      try {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['policyRevision', 'targetIds'].includes(key))) throw new TypeError('request fields are invalid');
        const receipts = listLatestEvaluationReceipts(db, body);
        return sendJson(response, 200, { policyRevision: body.policyRevision, receipts });
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return sendJson(response, 400, { error: { code: 'invalid_evaluation_receipt_read', message: error.message } });
        return sendJson(response, 500, { error: { code: 'internal_error', message: 'internal server error' } });
      }
    }
    const subjectGovernanceMatch=request.method==='GET'&&/^\/internal\/v1\/wallets\/([^/]+)\/subjects\/([^/]+)\/governance-control$/.exec(url.pathname);
    if(subjectGovernanceMatch){
      const producer=authenticate(request,observationTokens); if(!producer)return sendJson(response,401,{error:{code:'unauthorized',message:'valid governance reader token required'}});
      let walletId,subjectAddress; try{walletId=decodeURIComponent(subjectGovernanceMatch[1]);subjectAddress=decodeURIComponent(subjectGovernanceMatch[2])}catch{return sendJson(response,400,{error:{code:'invalid_identity',message:'identity is malformed'}})}
      if(!await readGovernanceAuthorization?.({producer,walletId,subjectAddress,network:url.searchParams.get('network')}))return sendJson(response,403,{error:{code:'forbidden',message:'subject access forbidden'}});
      try{const network=url.searchParams.get('network'),monitoring=await governanceAvailability?.({walletId,subjectAddress,network});return sendJson(response,200,readSubjectGovernance(db,{walletId,subjectAddress,network,monitoring}))}catch{return sendJson(response,502,{error:{code:'governance_control_unavailable',message:'governance control unavailable'}})}
    }
    if(request.method==='POST'&&url.pathname==='/internal/v1/governance/action-projection'){
      const producer=authenticate(request,observationTokens);if(!producer)return sendJson(response,401,{error:{code:'unauthorized',message:'valid observation token required'}});if(observationProducerSources.get(producer)!=='governance-action-read')return sendJson(response,403,{error:{code:'forbidden',message:'governance action read scope required'}});
      try{const query=await readJson(request);if(query.schemaVersion!=='governance-action-query/v1')throw new TypeError('query schema invalid');return sendJson(response,200,readGovernanceActions(db,query))}catch(error){if(error instanceof TypeError||error instanceof RangeError)return sendJson(response,400,{error:{code:'invalid_governance_action_query',message:error.message}});return sendJson(response,502,{error:{code:'governance_action_projection_unavailable',message:'governance action projection unavailable'}})}
    }
    if(request.method==='POST'&&url.pathname==='/internal/v1/governance/detection-projection'){
      const producer=authenticate(request,observationTokens);if(!producer)return sendJson(response,401,{error:{code:'unauthorized',message:'valid observation token required'}});if(observationProducerSources.get(producer)!=='governance-detection-read')return sendJson(response,403,{error:{code:'forbidden',message:'governance detection read scope required'}});
      try{const query=await readJson(request);if(query.schemaVersion!=='governance-detection-query/v1')throw new TypeError('query schema invalid');return sendJson(response,200,readGovernanceDetections(db,query))}catch(error){if(error instanceof TypeError||error instanceof RangeError)return sendJson(response,400,{error:{code:'invalid_governance_detection_query',message:error.message}});return sendJson(response,502,{error:{code:'governance_detection_projection_unavailable',message:'governance detection projection unavailable'}})}
    }
    if (url.pathname === '/api/governance') {
      governanceCors(response);
      if (request.method === 'OPTIONS') { response.writeHead(204); return response.end(); }
      if (request.method !== 'GET') return sendJson(response, 405, { error: { code: 'method_not_allowed', message: 'GET required' } });
      const producer = authenticate(request, observationTokens);
      if (!producer) return sendJson(response, 401, { error: { code: 'unauthorized', message: 'valid observation producer token required' } });
      try { return sendJson(response, 200, readGovernance(db, parseGovernanceReadQuery(url.searchParams))); }
      catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) return sendJson(response, 400, { error: { code: 'invalid_governance_query', message: error.message } });
        return sendJson(response, 502, { error: { code: 'governance_unavailable', message: 'governance read unavailable' } });
      }
    }
    if (request.method === 'GET' && url.pathname !== '/api/velocity/observations' && url.pathname.startsWith('/api/velocity/')) {
      if (!velocityViewerToken || !tokenMatches((request.headers['x-kelvara-authorization'] || '').replace(/^Bearer /, ''), velocityViewerToken)) return sendJson(response, 401, { error: { code: 'unauthorized', message: 'valid velocity viewer token required' } });
      try {
        if (url.pathname === '/api/velocity/protocol') return sendJson(response, 200, velocityProtocolProjection(db));
        if (url.pathname === '/api/velocity/accounts') return sendJson(response, 200, velocityAccountsProjection(db, { limit:url.searchParams.get('limit') || '50' }));
        const match = url.pathname.match(/^\/api\/velocity\/accounts\/([^/]+)$/);
        if (match) return sendJson(response, 200, velocityAccountProjection(db, decodeURIComponent(match[1]), { limit:url.searchParams.get('limit') || '50' }));
        if (url.pathname === '/api/velocity/transactions') return sendJson(response, 200, listVelocityTransactions(db, {limit:url.searchParams.get('limit')}));
        const transactionMatch = url.pathname.match(/^\/api\/velocity\/transactions\/([^/]+)$/);
        if (transactionMatch) { const transaction = getVelocityTransaction(db, decodeURIComponent(transactionMatch[1])); return transaction ? sendJson(response, 200, transaction) : sendJson(response, 404, { error: { code: 'not_found', message: 'transaction not found' } }); }
        if (url.pathname === '/api/velocity/actions') return sendJson(response, 200, listVelocityActions(db, {limit:url.searchParams.get('limit')}));
        if (['failures','upgrades'].some(x => url.pathname === `/api/velocity/${x}`)) return sendJson(response, 200, unavailableVelocityReadModel());
      } catch (error) { return sendJson(response, 400, { error: { code:'invalid_query', message:error.message } });
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/velocity/observations') {
      if (!velocityViewerToken || !tokenMatches((request.headers['x-kelvara-authorization'] || '').replace(/^Bearer /, ''), velocityViewerToken)) return sendJson(response, 401, { error: { code: 'unauthorized', message: 'valid velocity viewer token required' } });
      try { return sendJson(response, 200, listVelocityObservations(db, { address: url.searchParams.get('address'), limit: url.searchParams.get('limit') })); }
      catch (error) { return sendJson(response, 400, { error: { code: 'invalid_query', message: error.message } }); }
    }
    const transactionMatch = url.pathname.match(/^\/internal\/indexers\/([^/]+)\/transactions$/);
    const cursorMatch = url.pathname.match(/^\/internal\/indexers\/([^/]+)\/cursors$/);
    if (request.method === 'GET' && cursorMatch && !url.searchParams.has('stream')) {
      const cursorIndexerId = decodeURIComponent(cursorMatch[1]);
      const cursorToken = tokens.get(cursorIndexerId);
      const received = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      if (!cursorToken || !tokenMatches(received, cursorToken)) return sendJson(response, 401, { error: { code: 'unauthorized', message: 'valid bearer token required' } });
      return sendJson(response, 200, { cursor: velocityTransactionStore.cursor(cursorIndexerId, url.searchParams.get('targetId')) });
    }
    if (request.method === 'POST' && transactionMatch) {
      const indexerId = decodeURIComponent(transactionMatch[1]);
      const token = tokens.get(indexerId);
      const received = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      if (!token || !tokenMatches(received, token)) return sendJson(response, 401, { error: { code: 'unauthorized', message: 'valid bearer token required' } });
      try { const body = await readJson(request); const result = velocityTransactionStore.ingest(body); return sendJson(response, result.replay ? 200 : 201, result); }
      catch (error) { if (error.code === 'cursor_before_conflict' || error.code === 'transaction_conflict') return sendJson(response, 409, { error: { code: error.code, message: error.message } }); return sendJson(response, 400, { error: { code: 'invalid_transaction', message: error.message } }); }
    }
    if (request.method === 'POST' && url.pathname === '/internal/velocity/observations') {
      const producer = authenticate(request, observationTokens);
      if (!producer) return sendJson(response, 401, { error: { code: 'unauthorized', message: 'valid observation producer token required' } });
      if (!observationProducerSources?.has(producer) || observationProducerSources.get(producer) !== 'velocity') return sendJson(response, 403, { error: { code: 'forbidden', message: 'producer is not authorized for velocity observations' } });
      try { return sendJson(response, 201, recordVelocityObservation(db, await readJson(request))); }
      catch (error) { if (error.message === 'velocity_observation_conflict') return sendJson(response, 409, { error: { code: 'observation_conflict', message: error.message } }); return sendJson(response, 400, { error: { code: 'invalid_observation', message: error.message } }); }
    }
    if (request.method === 'GET' && url.pathname === '/health/live') {
      return sendJson(response, 200, { status: 'live' });
    }
    if (request.method === 'GET' && url.pathname === '/health/ready') {
      try {
        db.prepare('SELECT 1').get();
        return sendJson(response, 200, { status: 'ready' });
      } catch {
        return sendJson(response, 503, { status: 'not_ready' });
      }
    }
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(302, { location: './operations/' });
      return response.end();
    }
    if (request.method === 'GET' && await sendAsset(response, url.pathname)) return;
    if (request.method === 'GET' && ['/api/operations/overview', '/operations/api/operations/overview'].includes(url.pathname)) {
      return sendJson(response, 200, getOperationsOverview(db, now()));
    }
    if (request.method === 'GET' && ['/api/operations/indexers', '/operations/api/operations/indexers'].includes(url.pathname)) {
      return sendJson(response, 200, getOperationsIndexers(db));
    }
    if (request.method === 'GET' && ['/api/operations/targets', '/operations/api/operations/targets'].includes(url.pathname)) {
      return sendJson(response, 200, getOperationsTargets(db));
    }
    if (request.method === 'GET' && ['/api/operations/evacuations', '/operations/api/operations/evacuations'].includes(url.pathname)) {
      return sendJson(response, 200, getOperationsEvacuations(db));
    }

    const batchMatch = BATCH_ROUTE.exec(url.pathname);
    const heartbeatMatch = HEARTBEAT_ROUTE.exec(url.pathname);
    const targetsMatch = TARGETS_ROUTE.exec(url.pathname);
    const cursorsMatch = CURSORS_ROUTE.exec(url.pathname);
    const desiredMatch = DESIRED_ROUTE.exec(url.pathname);
    const reconciliationMatch = RECONCILIATION_ROUTE.exec(url.pathname);
    const isRegistration = url.pathname === REGISTER_ROUTE;
    const methodAllowed = (request.method === 'POST' && (batchMatch || heartbeatMatch || isRegistration || reconciliationMatch))
      || (request.method === 'PUT' && targetsMatch)
      || (request.method === 'GET' && (cursorsMatch || desiredMatch));
    if (!methodAllowed) {
      return sendJson(response, 404, { error: { code: 'not_found', message: 'route not found' } });
    }

    const authenticatedIndexer = authenticate(request, tokens);
    if (!authenticatedIndexer) {
      return sendJson(response, 401, { error: { code: 'unauthorized', message: 'valid bearer token required' } });
    }
    const scopedMatch = batchMatch || heartbeatMatch || targetsMatch || cursorsMatch || desiredMatch || reconciliationMatch;
    if (scopedMatch) {
      const pathIndexer = decodeURIComponent(scopedMatch[1]);
      if (authenticatedIndexer !== pathIndexer) {
        return sendJson(response, 403, { error: { code: 'indexer_scope_mismatch', message: 'token is not scoped to path indexer' } });
      }
    }

    try {
      if (desiredMatch) {
        return sendJson(response, 200, { indexerId: authenticatedIndexer, targets: listDesiredTargets(db, authenticatedIndexer) });
      }
      if (cursorsMatch) {
        return sendJson(response, 200, listCursors(db, authenticatedIndexer, url.searchParams.get('stream') || 'account_snapshot'));
      }
      const body = await readJson(request);
      if (body.indexerId !== authenticatedIndexer) {
        return sendJson(response, 403, { error: { code: 'indexer_scope_mismatch', message: 'token is not scoped to request indexer' } });
      }
      if (isRegistration) {
        const result = registerWorker(db, body, now());
        return sendJson(response, result.created ? 201 : 200, result);
      }
      if (heartbeatMatch) {
        return sendJson(response, 200, recordHeartbeat(db, body, now()));
      }
      if (reconciliationMatch) {
        const result = recordReconciliationStatus(db, authenticatedIndexer, body, now());
        return sendJson(response, 200, result);
      }
      if (targetsMatch) {
        return sendJson(response, 200, upsertTargets(db, body, now()));
      }
      const stream = body.stream ?? 'account_snapshot';
      const result = ingestObservationBatch(db, body, stream);
      return sendJson(response, result.duplicate ? 200 : 201, result);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) {
        return sendJson(response, 400, { error: { code: 'invalid_batch', message: error.message } });
      }
      if (error.message === 'governance payload conflict') {
        return sendJson(response, 409, { error: { code: 'governance_payload_conflict', message: error.message } });
      }
      if (error.message === 'cursorBefore does not match committed cursor') {
        return sendJson(response, 409, { error: { code: 'cursor_conflict', message: error.message } });
      }
      return sendJson(response, 500, { error: { code: 'internal_error', message: 'internal server error' } });
    }
  });
}

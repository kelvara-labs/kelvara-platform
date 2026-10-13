import { translateV4, normalizeGovernanceBatch } from './v4.js';
import { selectDecoder, unsupportedGovernanceEvidence, invalidGovernanceEvidence } from './registry.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const NETWORKS = new Set(['mainnet-beta', 'devnet', 'testnet', 'localnet']);
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;

async function fetchWithTimeout(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`${label} timed out`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response, label) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error(`${label} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  if (!response.body?.getReader) throw new Error(`${label} response body is unavailable`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`${label} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')); } catch { throw new Error(`${label} response is not valid JSON`); }
}

async function rpc(rpcUrl, method, params, timeoutMs) {
  const response = await fetchWithTimeout(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  }, timeoutMs, 'RPC request');
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await readJson(response, 'RPC');
  if (body.error) throw new Error(`RPC ${body.error.message}`);
  return body.result;
}

async function getCursor(hubUrl, indexerId, token, targetId, timeoutMs) {
  const response = await fetchWithTimeout(`${hubUrl}/internal/indexers/${encodeURIComponent(indexerId)}/cursors?stream=governance_control`, {
    headers: { authorization: `Bearer ${token}` }
  }, timeoutMs, 'Observation Hub cursor request');
  if (!response.ok) throw new Error(`Observation Hub cursor HTTP ${response.status}`);
  const body = await readJson(response, 'Observation Hub cursor');
  if (!body || body.indexerId !== indexerId || body.stream !== 'governance_control' || !Array.isArray(body.cursors) || body.cursors.length > 1) throw new Error('Observation Hub cursor response is malformed');
  const row = body.cursors.find((item) => item?.indexerId === indexerId && item?.stream === 'governance_control' && item?.targetId === targetId);
  const cursor = row?.cursor ?? { slot: 0, signature: null };
  if (!cursor || !Number.isSafeInteger(cursor.slot) || cursor.slot < 0 || (cursor.signature !== null && typeof cursor.signature !== 'string')) throw new Error('Observation Hub cursor response is malformed');
  return cursor;
}

async function postBatch(hubUrl, indexerId, token, batch, timeoutMs) {
  const response = await fetchWithTimeout(`${hubUrl}/internal/indexers/${encodeURIComponent(indexerId)}/batches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(batch)
  }, timeoutMs, 'Observation Hub request');
  const body = await readJson(response, 'Observation Hub');
  if (!response.ok) throw new Error(`Observation Hub HTTP ${response.status}: ${body?.error?.message ?? 'request failed'}`);
  return { status: response.status, body };
}

function requireAddress(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} is required`);
}

export async function runOneCycle({ rpcUrl, hubUrl, token, indexerId, network, subjectAddress, multisigAddress, programId, authorityIndex, cursorBefore, timeoutMs = DEFAULT_TIMEOUT_MS, observedAt = new Date().toISOString() }) {
  if (typeof token !== 'string' || token.length < 32) throw new TypeError('token is required');
  for (const [name, value] of Object.entries({ rpcUrl, hubUrl, indexerId, subjectAddress, multisigAddress, programId })) requireAddress(value, name);
  if (!NETWORKS.has(network)) throw new TypeError('network is required and must be supported');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError('timeoutMs is invalid');
  if (!Number.isInteger(authorityIndex) || authorityIndex < 0 || authorityIndex > 255) throw new TypeError('authorityIndex is invalid');
  const acknowledgedCursor = await getCursor(hubUrl, indexerId, token, subjectAddress, timeoutMs);
  if (cursorBefore && (!Number.isSafeInteger(cursorBefore.slot) || cursorBefore.slot < acknowledgedCursor.slot)) throw new RangeError('cursorBefore regressed');
  cursorBefore = acknowledgedCursor;
  const accounts = await rpc(rpcUrl, 'getMultipleAccounts', [[subjectAddress, multisigAddress], { encoding: 'base64', commitment: 'finalized', minContextSlot: cursorBefore.slot }], timeoutMs);
  if (!Number.isSafeInteger(accounts?.context?.slot)) throw new Error('accounts unavailable at one finalized context');
  if (accounts.context.slot < (cursorBefore?.slot ?? 0)) throw new RangeError('evidence slot regressed');
  if (!Array.isArray(accounts.value) || accounts.value.length !== 2) throw new Error('accounts unavailable at one finalized context');
  const [subject, multisig] = accounts.value;
  if (subject && (subject.owner !== SYSTEM_PROGRAM || subject.data?.[0] !== '' || subject.executable !== false)) throw new Error('subject is not a finalized system-owned empty account');
  if (!multisig?.data || multisig.data[1] !== 'base64' || multisig.owner !== programId) throw new Error('multisig account unavailable');
  const accountBytes = Buffer.from(multisig.data[0], 'base64');
  const discriminator = accountBytes.subarray(0, 8).toString('hex');
  const layout = `multisig-v4-${accountBytes.length}`;
  const entry = selectDecoder({ chain: 'solana', network, programId, discriminator, layout });
  let evidence;
  if (!entry) {
    evidence = unsupportedGovernanceEvidence({ subjectAddress, network, slot: accounts.context.slot, observedAt, reason: 'unsupported decoder selection', accountBytes });
  } else {
    try {
      evidence = translateV4({ network, subjectAddress, multisigAddress, programId, slot: accounts.context.slot, observedAt, accountBytes, decoded: entry.decoder(accountBytes, { owner: multisig.owner, programId, authorityIndex }) });
    } catch (error) {
      evidence = invalidGovernanceEvidence({ subjectAddress, network, slot: accounts.context.slot, observedAt, reason: error.message, accountBytes, decoder: entry });
    }
  }
  const batch = normalizeGovernanceBatch({ evidence, indexerId, targetId: subjectAddress, cursorBefore });
  return postBatch(hubUrl, indexerId, token, batch, timeoutMs);
}

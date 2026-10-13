const MAX_LIMIT = 50;
const NETWORKS = new Set(['mainnet-beta', 'devnet', 'testnet', 'localnet']);

export function parseGovernanceReadQuery(searchParams) {
  const network = searchParams.get('network');
  if (!NETWORKS.has(network)) throw new TypeError('network is not registered');
  const rawLimit = searchParams.get('history_limit') ?? '10';
  if (!/^\d+$/.test(rawLimit)) throw new TypeError('history_limit must be an integer');
  const historyLimit = Number(rawLimit);
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 1 || historyLimit > MAX_LIMIT) throw new RangeError('history_limit must be between 1 and 50');
  const cursor = searchParams.get('cursor');
  if (cursor !== null && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) throw new TypeError('cursor is invalid');
  return { network, historyLimit, cursor: cursor === null ? null : Number(cursor) };
}

function publicObservation(row) {
  const evidence = JSON.parse(row.canonical_json);
  const identity = {
    vaultAddress: evidence.subjectAddress,
    provider: evidence.provider,
    generation: evidence.generation,
    network: evidence.network,
    finalizedSlot: row.finalized_slot,
    status: evidence.status,
  };
  const membership = evidence.status === 'verified' ? { threshold: evidence.threshold, memberCount: evidence.members.length } : {};
  return {
    id: row.observation_id,
    finalizedSlot: row.finalized_slot,
    observedAt: row.observed_at,
    identity,
    membership,
    requiresAttention: evidence.status === 'verified' ? [] : [{ status: evidence.status, reason: evidence.providerData.reason }],
    currentActions: [],
    recentChanges: [],
  };
}

export function readGovernance(db, { network, historyLimit, cursor }) {
  const rows = db.prepare(`SELECT observation_id, canonical_json, finalized_slot, observed_at
    FROM governance_control_observations WHERE network=? AND finalized_slot < ?
    ORDER BY finalized_slot DESC, observation_id DESC LIMIT ?`).all(network, cursor ?? Number.MAX_SAFE_INTEGER, historyLimit + 1);
  const page = rows.slice(0, historyLimit);
  const nextCursor = rows.length > historyLimit ? String(page[page.length - 1].finalized_slot) : null;
  const vaults = page.map(publicObservation);
  return {
    schemaVersion: 'observation-hub-governance/v1', network,
    freshness: { state: vaults.length ? 'fresh' : 'empty', finalizedSlot: vaults.length ? Math.max(...vaults.map(v => v.finalizedSlot)) : null, observedAt: vaults[0]?.observedAt ?? null },
    wallets: vaults.length ? [{ address: vaults[0].identity.vaultAddress, vaults }] : [],
    nextHistoryCursor: nextCursor,
  };
}

export function readSubjectGovernance(db,{walletId,subjectAddress,network,monitoring}) {
  if (!NETWORKS.has(network)||typeof walletId!=='string'||!walletId||typeof subjectAddress!=='string'||!subjectAddress) throw new TypeError('subject governance identity is invalid');
  const rows=db.prepare(`SELECT observation_id, canonical_json, finalized_slot, observed_at FROM governance_control_observations WHERE network=? AND subject_address=? ORDER BY finalized_slot DESC, observation_id DESC LIMIT 50`).all(network,subjectAddress);
  const observations=rows.map(row=>({id:row.observation_id,evidence:JSON.parse(row.canonical_json)}));
  const latest=observations[0]??null,verified=observations.find(item=>item.evidence.status==='verified')??null;
  const availability=observations.length?(monitoring?.availability??'unavailable'):'never_observed';
  if (!['healthy','stale','unavailable','not_monitored','never_observed'].includes(availability)) throw new TypeError('monitoring availability is invalid');
  return {schemaVersion:'governance-control-read/v1',network,wallet:walletId,subjectAddress,monitoring:{availability,checkedAt:monitoring?.checkedAt??null,...(monitoring?.reason?{reason:monitoring.reason}:{})},lastObservation:latest?{evidenceStatus:latest.evidence.status,evidence:latest.evidence}:null,lastVerified:verified?{evidenceStatus:'verified',evidence:verified.evidence}:null};
}

export function governanceCors(response) {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  response.setHeader('access-control-allow-headers', 'authorization, content-type, x-kelvara-authorization');
}

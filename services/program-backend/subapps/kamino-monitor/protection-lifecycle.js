import { createHash } from 'node:crypto';

const clone = value => structuredClone(value);
const idFor = (record) => record.protectionId || (record.metadata && createHash('sha256').update(JSON.stringify(record.metadata)).digest('hex'));
function bundle(record, state) {
  const protectionId = idFor(record);
  if (!protectionId) throw new Error('protectionId required');
  if (!Array.isArray(record.variants) || record.variants.length !== 3) throw new Error('exactly 3 variants required');
  return { ...clone(record), protectionId, state, variants: clone(record.variants), revocationRequired: record.revocationRequired ? [...record.revocationRequired] : [] };
}
export function migrateProtectionRecord(record) {
  if (!record || typeof record !== 'object') throw new Error('malformed legacy record');
  if (record.schemaVersion === 2) return validate(clone(record));
  const b = bundle(record, record.completedAt ? 'completed' : 'active');
  const out = { schemaVersion: 2, activeBundle: b.state === 'active' ? b : null, completedBundles: b.state === 'completed' ? [b] : [] };
  return validate(out);
}
function validate(state) {
  if (state.schemaVersion !== 2 || (state.activeBundle !== null && !state.activeBundle) || !Array.isArray(state.completedBundles)) throw new Error('malformed lifecycle state');
  const bundles = state.activeBundle ? [state.activeBundle, ...state.completedBundles] : [...state.completedBundles];
  const ids = new Set(), accounts = new Set();
  for (const b of bundles) {
    if (!b.protectionId || ids.has(b.protectionId)) throw new Error('duplicate protection ID'); ids.add(b.protectionId);
    if (!Array.isArray(b.variants) || b.variants.length !== 3) throw new Error('exactly 3 variants required');
    const ownAccounts = new Set();
    for (const v of b.variants) { if (!v.nonceAccount || ownAccounts.has(v.nonceAccount) || accounts.has(v.nonceAccount)) throw new Error('account reuse'); ownAccounts.add(v.nonceAccount); accounts.add(v.nonceAccount); }
    const cleanup = b.revocationRequired || [];
    if (cleanup.length === 0 && b.state === 'completed') throw new Error('empty cleanup');
    if (new Set(cleanup).size !== cleanup.length || cleanup.some(a => !a || !ownAccounts.has(a))) throw new Error('invalid cleanup accounts');
    const winner = b.variants.find(v => v.signature === b.winner)?.nonceAccount;
    if (winner && cleanup.includes(winner)) throw new Error('winner cleanup account');
  }
  return state;
}
export function publicProjection(state) {
  const s = validate(migrateProtectionRecord(state));
  const p = b => ({ protectionId: b.protectionId, state: b.state, resources: b.variants.map(v => ({ nonceAccount: v.nonceAccount, classification: b.state === 'completed' && b.revocationRequired.includes(v.nonceAccount) ? 'RELEASABLE_AFTER_EVACUATION' : 'IN_USE' })) });
  return { schemaVersion: 2, activeBundle: s.activeBundle ? p(s.activeBundle) : null, completedBundles: s.completedBundles.map(p) };
}
export function resolveScopedAccounts(state, scope) {
  const s = validate(migrateProtectionRecord(state));
  if (!scope || !['active', 'completed'].includes(scope.mode)) throw new Error('mode invalid');
  if (scope.mode === 'active') { if (!s.activeBundle || s.activeBundle.protectionId !== scope.protectionId) throw new Error('scope stale'); return s.activeBundle.variants.map(v => v.nonceAccount); }
  const b = s.completedBundles.find(x => x.protectionId === scope.protectionId);
  if (!b) throw new Error('scope stale');
  if (!b.revocationRequired?.length) throw new Error('empty cleanup');
  return [...b.revocationRequired];
}

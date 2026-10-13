import { createVaultSnapshot } from './snapshot.js';
import { normalizeSnapshotBatch } from './normalize.js';

function targetWatermark(targets, cursors) {
  const slots = targets.filter(target => target.enabled).map(target => Number(cursors.get(target.id)?.slot || 0));
  return slots.length ? Math.min(...slots) : 0;
}

function rpcResult(observation) {
  return { context: { slot: observation.slot }, value: observation.account };
}

export function createKaminoLiveRunner({ config, targets, cursors, transport, ingest, snapshot = createVaultSnapshot, normalize = normalizeSnapshotBatch, now = () => new Date() }) {
  let state = { continuity: 'unverified', watermark: targetWatermark(targets, cursors) };
  const byAddress = new Map(targets.filter(target => target.enabled).map(target => [target.address, target]));
  async function onObservation(observation) {
    const target = byAddress.get(observation.address);
    if (!target) return;
    const cursorBefore = cursors.get(target.id) || { signature: null, slot: 0 };
    if (Number(observation.slot) <= Number(cursorBefore.slot || 0)) return;
    const vault = snapshot({ address: target.address, programId: target.programId, rpcResult: rpcResult(observation) });
    const batch = normalize({ snapshot: vault, indexerId: config.indexerId, targetId: target.id, network: target.network, cursorBefore, observedAt: now().toISOString() });
    batch.transportProvenance = { provider: observation.sourceProvider };
    const acknowledgment = await ingest(batch);
    cursors.set(target.id, acknowledgment?.committedCursor || batch.cursorAfter);
  }
  return Object.freeze({
    async run() {
      state = { ...state, continuity: 'unverified' };
      try {
        const result = await transport.live.accounts({ addresses: [...byAddress.keys()], watermark: state.watermark, onObservation, onContinuity(event) { state = { ...state, continuity: event.status, watermark: event.watermark ?? state.watermark, gap: event.gap, error: event.error }; } });
        state = { ...state, ...transport.status(), continuity: result.continuity, watermark: result.watermark };
        return { ...state };
      } catch (error) {
        state = { ...state, ...transport.status(), continuity: 'degraded', error: error.message };
        throw error;
      }
    },
    status() { return { ...state, ...transport.status(), continuity: state.continuity }; }
  });
}

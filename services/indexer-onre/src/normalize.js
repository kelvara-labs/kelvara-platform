import { createHash } from 'node:crypto';

function requireSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1) throw new TypeError('unsupported snapshot');
  if (!Number.isSafeInteger(snapshot.slot) || snapshot.slot < 0) throw new TypeError('snapshot slot must be a non-negative safe integer');
  if (typeof snapshot.accountHash !== 'string') throw new TypeError('snapshot accountHash is required');
}

export function normalizeSnapshotBatch({ snapshot, indexerId, targetId, network, cursorBefore, observedAt }) {
  requireSnapshot(snapshot);
  const state = snapshot.state;
  const record = {
    type: 'vault_snapshot',
    slot: snapshot.slot,
    accountHash: snapshot.accountHash,
    source: snapshot.source,
    decoderVersion: state.decoderVersion,
    vaultAdminAuthority: state.vaultAdminAuthority,
    allocationAdmin: state.allocationAdmin ?? null,
    pendingAdmin: state.pendingAdmin,
    tokenMint: state.tokenMint,
    sharesMint: state.sharesMint,
    tokenAvailable: state.tokenAvailable,
    sharesIssued: state.sharesIssued,
    previousAumScaled: state.previousAumScaled,
    pendingFeesScaled: state.pendingFeesScaled,
    performanceFeeBps: state.performanceFeeBps,
    managementFeeBps: state.managementFeeBps,
    allocations: state.allocations.map((allocation) => ({
      reserve: allocation.reserve,
      targetAllocationWeight: allocation.targetAllocationWeight,
      ctokenAllocation: allocation.ctokenAllocation,
      tokenAllocationCap: allocation.tokenAllocationCap,
      ctokenAllocationCap: allocation.ctokenAllocationCap,
      tokenTargetAllocationScaled: allocation.tokenTargetAllocationScaled
    }))
  };
  const identity = JSON.stringify({ indexerId, targetId, slot: snapshot.slot, accountHash: snapshot.accountHash });
  return {
    schemaVersion: 1,
    batchId: `sha256:${createHash('sha256').update(identity).digest('hex')}`,
    indexerId,
    targetId,
    network,
    cursorBefore,
    cursorAfter: { signature: null, slot: snapshot.slot },
    observedAt,
    records: [record]
  };
}

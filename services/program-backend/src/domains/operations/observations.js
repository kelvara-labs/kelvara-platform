const ALLOWED_KEYS = new Set([
  "schemaVersion", "service", "event", "observationId", "walletId", "observedAt",
  "latencyMs", "success", "positionFound", "sourceStatus", "authorityStatus", "signature", "actionStatus", "provider",
  "evacuationSignatures", "paymentId", "paidAmount", "paidAsset", "paymentStatus", "paymentSignature",
]);
const KAMINO_VAULT = "BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5";

function boundedString(value, name, max = 256) {
  if (typeof value !== "string" || !value || value.length > max) throw new TypeError(`invalid_${name}`);
  return value;
}

function validateObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid_observation");
  for (const key of Object.keys(value)) if (!ALLOWED_KEYS.has(key)) throw new TypeError("unknown_observation_field");
  if (value.schemaVersion !== 1 || value.service !== "kamino-monitor" || !["wallet_inspection", "protection_armed", "evacuation_submitted", "evacuation_confirmed"].includes(value.event)) throw new TypeError("unsupported_observation");
  boundedString(value.observationId, "observation_id");
  boundedString(value.walletId, "wallet_id");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.walletId)) throw new TypeError("invalid_wallet_id");
  if (!Number.isSafeInteger(value.observedAt) || value.observedAt < 0) throw new TypeError("invalid_observed_at");
  if (!Number.isFinite(value.latencyMs) || value.latencyMs < 0 || value.latencyMs > 3_600_000) throw new TypeError("invalid_latency_ms");
  if (typeof value.success !== "boolean") throw new TypeError("invalid_observation_state");
  if (value.event === "wallet_inspection" && typeof value.positionFound !== "boolean") throw new TypeError("invalid_observation_state");
  boundedString(value.sourceStatus, "source_status");
  if (value.authorityStatus !== null && value.authorityStatus !== undefined) boundedString(value.authorityStatus, "authority_status");
  if (value.signature !== undefined) boundedString(value.signature, "signature", 128);
  if (value.actionStatus !== undefined) boundedString(value.actionStatus, "action_status", 64);
  if (value.provider !== undefined) boundedString(value.provider, "provider", 64);
  if (value.evacuationSignatures !== undefined) {
    if (!Array.isArray(value.evacuationSignatures) || value.evacuationSignatures.length !== 3) throw new TypeError("invalid_evacuation_signatures");
    value.evacuationSignatures.forEach(signature => boundedString(signature, "evacuation_signature", 128));
  }
  if (value.paymentId !== undefined) boundedString(value.paymentId, "payment_id");
  if (value.paidAmount !== undefined && !/^\d+(\.\d+)?$/.test(value.paidAmount)) throw new TypeError("invalid_paid_amount");
  if (value.paidAsset !== undefined) boundedString(value.paidAsset, "paid_asset", 32);
  if (value.paymentStatus !== undefined) boundedString(value.paymentStatus, "payment_status", 64);
  if (value.paymentSignature !== undefined) boundedString(value.paymentSignature, "payment_signature", 128);
  return value;
}

export function createOperationsObservationRecorder({ store }) {
  return observation => {
    const value = validateObservation(observation);
    const { targetId } = store.linkPosition(value.walletId, {
      cluster: "mainnet-beta",
      protocol: "kamino",
      kind: "vault",
      address: KAMINO_VAULT,
    });
    store.recordEvidence({
      id: value.observationId,
      targetId,
      observedAt: value.observedAt,
      fetchedAt: value.observedAt,
      value: {
        event: value.event,
        positionFound: value.positionFound ?? null,
        sourceStatus: value.sourceStatus,
        authorityStatus: value.authorityStatus ?? null,
        actionStatus: value.actionStatus ?? null,
        signature: value.signature ?? null,
      },
      availability: value.success ? "available" : "unavailable",
      source: value.provider ?? "unknown-rpc",
      latencyMs: value.latencyMs,
    });
    const activity = {
      id: value.observationId,
      walletId: value.walletId,
      targetId,
      event: value.event,
      status: value.actionStatus ?? (value.success ? "observed" : "failed"),
      observedAt: value.observedAt,
      detail: {
        positionFound: value.positionFound ?? null,
        sourceStatus: value.sourceStatus,
        authorityStatus: value.authorityStatus ?? null,
        signature: value.signature ?? null,
      },
    };
    if (value.event === "wallet_inspection") store.recordInspectionObservation(activity);
    else {
      store.recordClientActivity(activity);
      store.linkPosition(value.walletId, {
        cluster: "mainnet-beta", protocol: "kamino", kind: "vault", address: KAMINO_VAULT,
      });
      for (const signature of value.evacuationSignatures ?? []) store.recordEvacuationTransaction({ walletId: value.walletId, signature, status: "signed", observedAt: value.observedAt });
      if (value.signature && value.event.startsWith("evacuation_")) store.recordEvacuationTransaction({ walletId: value.walletId, signature: value.signature, status: value.actionStatus ?? "submitted", observedAt: value.observedAt });
      if (value.paymentId && value.paidAmount && value.paidAsset && value.paymentStatus) store.recordPayment({ id: value.paymentId, walletId: value.walletId, amount: value.paidAmount, asset: value.paidAsset, status: value.paymentStatus, paidAt: value.observedAt, signature: value.paymentSignature ?? null });
    }
    return { accepted: true };
  };
}

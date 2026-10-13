function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function drainAssignmentOutbox({ store, hubUrl, token, fetchImpl = fetch, maxAttempts = 3, retryDelayMs = 250 }) {
  if (!store || typeof store.listAssignmentOutbox !== 'function') throw new TypeError('store is required');
  if (typeof hubUrl !== 'string' || !hubUrl.trim()) throw new TypeError('hubUrl is required');
  if (typeof token !== 'string' || token.length < 32) throw new TypeError('token must be at least 32 characters');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new TypeError('maxAttempts must be from 1 to 10');
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60_000) throw new TypeError('retryDelayMs must be from 0 to 60000');
  let delivered = 0;
  for (const event of store.listAssignmentOutbox().filter(item => !item.acknowledgedAt)) {
    let response;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        response = await fetchImpl(`${hubUrl.replace(/\/$/, '')}/internal/v1/assignments`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': event.eventId },
          body: JSON.stringify(event)
        });
        if (response.ok) break;
      } catch { /* bounded retry; leave unacknowledged */ }
      if (attempt < maxAttempts) await sleep(retryDelayMs * attempt);
    }
    if (response?.ok) {
      store.ackAssignmentOutbox(event.eventId);
      delivered += 1;
    }
  }
  return { delivered };
}

export function createAssignmentOutboxDelivery({ store, hubUrl, token, fetchImpl = fetch, intervalMs = 5_000, maxAttempts = 3, retryDelayMs = 250 }) {
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 3_600_000) throw new TypeError('intervalMs must be from 100 to 3600000');
  let timer = null;
  let running = false;
  let draining = null;
  const tick = () => {
    if (running) return draining;
    running = true;
    draining = drainAssignmentOutbox({ store, hubUrl, token, fetchImpl, maxAttempts, retryDelayMs })
      .catch(() => ({ delivered: 0 }))
      .finally(() => { running = false; draining = null; });
    return draining;
  };
  return {
    start() { if (!timer) { timer = setInterval(tick, intervalMs); timer.unref?.(); } return tick(); },
    async close() { if (timer) { clearInterval(timer); timer = null; } if (draining) await draining; }
  };
}

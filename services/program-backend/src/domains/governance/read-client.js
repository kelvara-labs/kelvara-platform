const MAX_LIMIT = 50;
export function createGovernanceClient({ baseUrl, token, fetchImpl = fetch, timeoutMs = 2000 }) {
  if (!baseUrl || !token) throw new TypeError('governance client configuration required');
  return async function readGovernance({ network, historyLimit = 10, cursor = null }) {
    if (!['mainnet-beta', 'devnet', 'testnet', 'localnet'].includes(network)) throw new TypeError('network is not registered');
    if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > MAX_LIMIT) throw new RangeError('history_limit is invalid');
    const url = new URL('/api/governance', baseUrl); url.searchParams.set('network', network); url.searchParams.set('history_limit', String(historyLimit)); if (cursor !== null) url.searchParams.set('cursor', String(cursor));
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
      if (!response.ok) throw new Error(`observation_hub_${response.status}`);
      const body = await response.json();
      if (!body || body.schemaVersion !== 'observation-hub-governance/v1' || body.network !== network || !Array.isArray(body.wallets)) throw new Error('invalid_governance_response');
      return body;
    } finally { clearTimeout(timer); }
  };
}

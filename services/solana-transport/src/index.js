import { createSolamiLiveAdapter } from './solami.js';
export { createSolamiLiveAdapter } from './solami.js';

const DEFAULT_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const CLUSTERS = new Set(['mainnet-beta', 'devnet']);

function requiredCluster(cluster) {
  if (!cluster) throw new TypeError('cluster is required');
  if (!CLUSTERS.has(cluster)) throw new TypeError('cluster must be mainnet-beta or devnet');
  return cluster;
}

function requiredHttps(value, name) {
  if (!value) throw new TypeError(`${name} is required`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError(`${name} must be a valid URL`); }
  if (parsed.protocol !== 'https:') throw new TypeError(`${name} must use HTTPS`);
  return value.replace(/\/$/, '');
}

function enabled(value) { return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase()); }

export function loadSolanaTransportConfig(env = process.env, { cluster } = {}) {
  const selectedCluster = requiredCluster(cluster);
  const mainnet = selectedCluster === 'mainnet-beta';
  const primaryName = mainnet ? 'SOLANA_MAINNET_RPC_URL' : 'SOLANA_DEVNET_RPC_URL';
  const primaryUrl = requiredHttps(
    mainnet ? (env.SOLANA_MAINNET_RPC_URL || env.HELIUS_RPC_URL || env.SOLANA_RPC_URL) : env.SOLANA_DEVNET_RPC_URL,
    primaryName
  );
  const liveConfigured = mainnet && Boolean(env.SOLAMI_GRPC_ENDPOINT && env.SOLAMI_GRPC_KEY);
  const publicEnabled = mainnet && enabled(env.SOLANA_PUBLIC_RPC_FALLBACK_ENABLED);
  const publicUrl = publicEnabled ? requiredHttps(env.SOLANA_PUBLIC_RPC_URL || DEFAULT_PUBLIC_RPC, 'SOLANA_PUBLIC_RPC_URL') : null;
  const queryProvider = mainnet ? 'helius' : 'solana-rpc';
  let continuity = 'unverified';
  let liveProvider = mainnet ? 'solami-grpc' : 'solana-rpc';
  let liveStatus = liveConfigured ? 'configured' : (mainnet ? 'unconfigured' : 'polling');
  let rpcStatus = 'configured';
  let fallbackReason = null;
  const config = {
    cluster: selectedCluster,
    live: Object.freeze({ provider: liveProvider, mode: mainnet ? 'grpc' : 'polling', endpoint: liveConfigured ? requiredHttps(env.SOLAMI_GRPC_ENDPOINT, 'SOLAMI_GRPC_ENDPOINT') : null, token: liveConfigured ? env.SOLAMI_GRPC_KEY : null }),
    rpc: Object.freeze({ provider: queryProvider, urls: Object.freeze([primaryUrl, ...(publicUrl ? [publicUrl] : [])]) }),
    emergencyPublicRpcEnabled: publicEnabled,
    setState(next) {
      if (next.continuity) continuity = next.continuity;
      if (next.liveProvider) liveProvider = next.liveProvider;
      if (next.liveStatus) liveStatus = next.liveStatus;
      if (next.rpcStatus) rpcStatus = next.rpcStatus;
      if ('fallbackReason' in next) fallbackReason = next.fallbackReason;
    },
    status() {
      return Object.freeze({
        cluster: selectedCluster,
        queryProvider: rpcStatus === 'degraded' ? 'solana-public-rpc' : queryProvider,
        liveMode: config.live.mode,
        liveProvider, liveStatus,
        rpcProvider: rpcStatus === 'degraded' ? 'solana-public-rpc' : queryProvider, rpcStatus, continuity,
        ...(fallbackReason ? { fallbackReason } : {})
      });
    }
  };
  return Object.freeze(config);
}

async function parseResponse(response) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`rpc_http_${response.status}`);
  if (body.error) throw new Error(`rpc_${body.error.code}: ${body.error.message}`);
  return body.result;
}

function rpcClient(config, fetchImpl) {
  let id = 0;
  async function call(method, params) {
    const failures = [];
    for (let index = 0; index < config.rpc.urls.length; index += 1) {
      const url = config.rpc.urls[index];
      try {
        const result = await parseResponse(await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15_000) }));
        const emergency = index > 0;
        config.setState({ rpcStatus: emergency ? 'degraded' : 'healthy' });
        return { result, provider: emergency ? 'solana-public-rpc' : 'helius-rpc' };
      } catch (error) { failures.push(error.message); }
    }
    config.setState({ rpcStatus: 'error' });
    throw new Error(`${method} failed: ${failures.join('; ')}`);
  }
  return Object.freeze({
    async getAccountInfo(address, options = { encoding: 'base64', commitment: 'finalized' }) { return call('getAccountInfo', [address, options]); },
    async getSignaturesForAddress(address, options = {}) { return call('getSignaturesForAddress', [address, options]); },
    async getTransaction(signature, options = { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }) { return call('getTransaction', [signature, options]); },
    call
  });
}

function canonicalKey(observation) {
  if (!observation || !observation.identity) throw new TypeError('live observation identity is required');
  return String(observation.identity);
}

function isAuthenticationFailure(error) {
  return error?.code === 16 || error?.status === 401 || error?.status === 403 || /unauthenticated|unauthorized|permission denied|invalid.*(?:key|token)|expired.*(?:key|token)/i.test(String(error?.message || ''));
}

export function createSolanaTransport({ cluster, env = process.env, fetchImpl = fetch, liveAdapter = undefined, recovery = null, fallback = null } = {}) {
  const config = loadSolanaTransportConfig(env, { cluster });
  const resolvedLiveAdapter = liveAdapter === undefined && config.live.endpoint ? createSolamiLiveAdapter({ endpoint: config.live.endpoint, token: config.live.token }) : liveAdapter;
  const rpc = rpcClient(config, fetchImpl);
  async function runLive(kind, options) {
    if (!resolvedLiveAdapter?.[kind]) throw new Error(`Solami ${kind} adapter unavailable`);
    let watermark = Number(options.watermark || 0);
    const seen = new Set();
    const emit = async (observation, sourceProvider) => {
      const key = canonicalKey(observation);
      if (seen.has(key)) return false;
      seen.add(key);
      await options.onObservation({ ...observation, sourceProvider });
      return true;
    };
    config.setState({ liveStatus: 'connecting', continuity: 'unverified' });
    try {
      for await (const observation of resolvedLiveAdapter[kind](options)) {
        if (observation?.kind === 'continuity-gap') {
          const gap = { fromSlot: Number(observation.fromSlot), toSlot: Number(observation.toSlot) };
          if (!Number.isSafeInteger(gap.fromSlot) || !Number.isSafeInteger(gap.toSlot) || gap.fromSlot < 0 || gap.toSlot < gap.fromSlot) throw new TypeError('continuity gap is invalid');
          config.setState({ liveStatus: 'healthy', continuity: 'degraded' });
          await options.onContinuity?.({ status: 'degraded', gap });
          try {
            if (!recovery?.[kind]) throw new Error(`${kind} gap recovery unavailable`);
            const recovered = await recovery[kind]({ ...options, ...gap, rpc });
            for (const item of recovered) await emit(item, 'helius-rpc');
          } catch (error) {
            config.setState({ continuity: 'degraded' });
            await options.onContinuity?.({ status: 'degraded', gap, error: error.message });
            throw error;
          }
          continue;
        }
        const slot = Number(observation.slot);
        if (!Number.isSafeInteger(slot) || slot < 0) throw new TypeError('live observation slot is invalid');
        await emit(observation, 'solami-grpc');
        watermark = Math.max(watermark, slot);
        config.setState({ liveStatus: 'healthy', continuity: 'verified' });
        await options.onContinuity?.({ status: 'verified', watermark });
      }
      return { watermark, continuity: config.status().continuity };
    } catch (error) {
      config.setState({ liveStatus: 'degraded', continuity: 'degraded' });
      if (!isAuthenticationFailure(error) || !fallback?.[kind]) throw error;
      const reason = 'solami_authentication_failed';
      config.setState({ liveProvider: 'helius-rpc', liveStatus: 'rpc_fallback', continuity: 'degraded', fallbackReason: reason });
      await options.onContinuity?.({ status: 'degraded', reason, watermark });
      const result = await fallback[kind]({ ...options, watermark, rpc });
      for (const item of result?.observations || []) await emit(item, 'helius-rpc');
      const nextWatermark = Number(result?.watermark ?? watermark);
      if (!Number.isSafeInteger(nextWatermark) || nextWatermark < watermark) throw new TypeError('fallback watermark is invalid');
      watermark = nextWatermark;
      config.setState({ continuity: 'verified' });
      await options.onContinuity?.({ status: 'verified', watermark, provider: 'helius-rpc' });
      return { watermark, continuity: 'verified' };
    }
  }
  return Object.freeze({
    rpc,
    live: Object.freeze({ accounts: options => runLive('accounts', options), transactions: options => runLive('transactions', options) }),
    status: () => config.status()
  });
}

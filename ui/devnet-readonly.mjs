export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PORTFOLIO_KEYS = ['network', 'genesisHash', 'sourceStatus', 'positions', 'safeguards', 'protocolStatuses', 'coverage'];

const DEVNET_SOURCE_STATUSES = new Set(['canonical_devnet_empty_read_only', 'canonical_devnet_live_read_only']);
const MAX_PORTFOLIO_ITEMS = 100;

export function validateAuthenticatedDevnetPortfolio(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('devnet_portfolio_invalid');
  if (Object.keys(value).some(key => !PORTFOLIO_KEYS.includes(key)) || !['network', 'genesisHash', 'sourceStatus', 'positions', 'safeguards', 'protocolStatuses'].every(key => Object.hasOwn(value,key))) throw new TypeError('devnet_portfolio_shape_invalid');
  if (value.network !== 'devnet' || value.genesisHash !== DEVNET_GENESIS || !DEVNET_SOURCE_STATUSES.has(value.sourceStatus)) throw new TypeError('devnet_portfolio_binding_invalid');
  for (const field of ['positions', 'safeguards', 'protocolStatuses']) if (!Array.isArray(value[field]) || value[field].length > MAX_PORTFOLIO_ITEMS) throw new TypeError('devnet_portfolio_shape_invalid');
  if (value.positions.some(position => !position || typeof position !== 'object' || Array.isArray(position) || position.chain !== 'solana' || position.network !== 'devnet' || typeof position.targetId !== 'string' || !position.targetId.startsWith('solana:devnet:') || /mainnet/i.test(JSON.stringify(position)))) throw new TypeError('devnet_portfolio_binding_invalid');
  return value;
}

export function validateDevnetReadOnlyDemo(value) {
  validateAuthenticatedDevnetPortfolio(value);
  if (Object.keys(value).sort().join(',') !== ['network', 'genesisHash', 'sourceStatus', 'positions', 'safeguards', 'protocolStatuses'].sort().join(',') || value.sourceStatus !== 'canonical_devnet_empty_read_only' || value.positions.length || value.safeguards.length || value.protocolStatuses.length) throw new TypeError('devnet_demo_shape_invalid');
  return value;
}

export const validateDevnetPortfolio = validateAuthenticatedDevnetPortfolio;

export function validateDevnetInspect(wallet, value) {
  if (typeof wallet !== 'string' || !wallet || !value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('devnet_inspect_invalid');
  const keys = ['network', 'genesisHash', 'wallet', 'position', 'authority', 'sourceStatus'];
  if (Object.keys(value).sort().join(',') !== keys.slice().sort().join(',')) throw new TypeError('devnet_inspect_shape_invalid');
  if (value.network !== 'devnet' || value.genesisHash !== DEVNET_GENESIS || value.wallet !== wallet || value.position !== null || value.authority !== null || value.sourceStatus !== 'canonical_devnet_empty_read_only') throw new TypeError('devnet_inspect_binding_invalid');
  return value;
}

export function projectDevnetView(portfolio) {
  validateDevnetPortfolio(portfolio);
  return { networkLabel: 'Devnet', positionLabel: '0 positions', emptyLabel: 'No supported Devnet positions found.', accessLabel: 'Read-only', capabilities: { protect: false, evacuate: false, sign: false } };
}

export function devnetRequest(wallet, token) {
  if (typeof wallet !== 'string' || !wallet || wallet.length > 64) throw new TypeError('wallet_required');
  if (typeof token !== 'string' || !token || token.length > 4096) throw new TypeError('token_required');
  return { path: `/api/portfolio/${encodeURIComponent(wallet)}?network=devnet`, headers: { authorization: `Bearer ${token}`, 'x-kelvara-network': 'devnet', 'x-kelvara-genesis': DEVNET_GENESIS } };
}

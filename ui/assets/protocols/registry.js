const PROTOCOL_ICONS = Object.freeze({
  kamino: new URL('./kamino.svg', import.meta.url).href,
  steakhouse: new URL('./steakhouse.svg', import.meta.url).href,
});

const PROTOCOL_ALIASES = Object.freeze({
  'kamino earn': 'kamino',
  'steakhouse financial': 'steakhouse',
  'steakhouse usdg': 'steakhouse',
});

export function protocolIconFor(protocolId, displayName = '') {
  const id = String(protocolId || '').trim().toLowerCase();
  const name = String(displayName || '').trim().toLowerCase();
  const key = PROTOCOL_ICONS[id] ? id : PROTOCOL_ALIASES[id] || PROTOCOL_ALIASES[name];
  return key ? PROTOCOL_ICONS[key] : PROTOCOL_ICONS.kamino;
}

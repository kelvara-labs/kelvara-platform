const NETWORKS = Object.freeze(['mainnet-beta', 'devnet']);

function normalizeNetwork(value) {
  return NETWORKS.includes(value) ? value : null;
}

function requireNetwork(value) {
  const network = normalizeNetwork(value);
  if (!network) throw new Error('invalid_network');
  return network;
}

function networkMatches(left, right) {
  return Boolean(normalizeNetwork(left) && normalizeNetwork(right) && left === right);
}

function switchNetwork(current, next, state) {
  requireNetwork(current);
  const network = requireNetwork(next);
  if (!state || typeof state !== 'object') throw new Error('network_state_required');
  return { network, state: {} };
}

export { NETWORKS, normalizeNetwork, requireNetwork, networkMatches, switchNetwork };

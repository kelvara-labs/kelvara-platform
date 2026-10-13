// Reviewed, immutable protocol capability contract. Target bindings are proposal-specific.
const freeze = value => Object.freeze(value);

export const KAMINO_KVAULT_PROFILE = freeze({
  profileId: 'kamino-kvault-mainnet-beta-v1',
  chain: 'solana',
  network: 'mainnet-beta',
  protocol: 'kamino',
  kind: 'kvault',
  metricsAdapter: freeze({ id: 'kamino-kvault-metrics', version: 1 }),
  discoveryAdapter: freeze({ id: 'kamino-kvault-discovery', version: 1 }),
  mandatoryRules: freeze([freeze({
    ruleId: 'kamino-kvault-freshness',
    version: 1,
    name: 'Kamino kvault freshness',
    evaluatorType: 'freshness',
    evaluatorVersion: '1',
    evidenceSchema: 'freshness-v1',
    parameters: freeze({ maximumAgeMs: 60000 })
  })])
});

export function validateKaminoKvaultProfile(input) {
  const p = KAMINO_KVAULT_PROFILE;
  if (!input || input.chain !== p.chain || input.network !== p.network || input.protocol !== p.protocol || input.kind !== p.kind || typeof input.targetId !== 'string') throw new Error('kamino_rule_profile_target_invalid');
  if (!input.discoveryAdapter || input.discoveryAdapter.id !== p.discoveryAdapter.id || input.discoveryAdapter.version !== p.discoveryAdapter.version) throw new Error('discoveryAdapter_reference_invalid');
  if (!input.metricsAdapter || input.metricsAdapter.id !== p.metricsAdapter.id || input.metricsAdapter.version !== p.metricsAdapter.version) throw new Error('metricsAdapter_reference_invalid');
  if (!Array.isArray(input.ruleBindings) || input.ruleBindings.length !== p.mandatoryRules.length) throw new Error('kamino_rule_profile_invalid');
  const actual = input.ruleBindings.map(binding => ({
    bindingId: binding?.id,
    ruleId: binding?.ruleId,
    version: binding?.version,
    enabled: binding?.enabled,
    targetId: binding?.targetId
  }));
  const same = actual.length === p.mandatoryRules.length && actual.every(binding => {
    const rule = p.mandatoryRules.find(item => item.ruleId === binding.ruleId && item.version === binding.version);
    return rule && typeof binding.bindingId === 'string' && binding.bindingId.length > 0 && binding.enabled === true && binding.targetId === input.targetId;
  });
  if (!same || new Set(actual.map(binding => `${binding.ruleId}@${binding.version}`)).size !== p.mandatoryRules.length) throw new Error('kamino_rule_profile_invalid');
  return true;
}

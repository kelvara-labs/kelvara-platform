const freeze = value => Object.freeze(value);
const profile = (targetId, vault, sharesMint, underlyingMint, underlyingTokenProgram, withdrawDiscriminator) => freeze({ targetId, vault, sharesMint, underlyingMint, underlyingTokenProgram, withdrawDiscriminator, instructionSequence: freeze(["ATA", "Farms", "Farms", "ATA", "Kamino", "TOKEN_PROGRAM"]), withdrawPayload: `${withdrawDiscriminator}ffffffffffffffff` });
export const PROTECTION_PROFILES = freeze({
  steakhouse: profile("solana:mainnet-beta:kamino:kvault:BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5", "BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5", "4hKmkq2SkthLPceEBJXpyvH9m9PvNpFwasoB8mZgJ6rE", "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", "TOKEN_2022", "1383709baadc2239"),
  institutional: profile("solana:mainnet-beta:kamino:kvault:B5pjfZAiKjyUEuqB2694NHrsjcaM67uuJaWqjzTVtzR6", "B5pjfZAiKjyUEuqB2694NHrsjcaM67uuJaWqjzTVtzR6", "2bnxGUrAevL2i9zYtJWwPnAE2RmiPpRxjYnwv886DGCC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "TOKEN_PROGRAM", "b712469c946da122")
});
const byTarget = new Map(Object.values(PROTECTION_PROFILES).map(item => [item.targetId, item]));
export function resolveProtectionProfile(targetId) { if (!targetId) throw new Error("target_id_required"); const value = byTarget.get(targetId); if (!value) throw new Error("unknown_protection_target"); return value; }

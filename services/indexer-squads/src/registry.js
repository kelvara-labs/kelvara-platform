import { createHash, timingSafeEqual } from 'node:crypto';
import { decodePinnedV4 } from './v4.js';

const V4_PROGRAM_ID = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const V4_DISCRIMINATOR = 'e07479ba44a14fec';
const MAINNET_V4_LAYOUTS = new Set(['multisig-v4-495','multisig-v4-528','multisig-v4-627']);
const DEVNET_V4_LAYOUTS = new Set(['multisig-v4-231']);
const V4_PACKAGE_INTEGRITY = 'sha512-5w+NmwHOzl96nI50R/fjSD6uFydRLNUquhoEmmWbGepS4D9DnQyF2TKcUBfTyxV3sgJt00ypBt7SXB3y8WOzUQ==';
const V4_ARTIFACT_HASH = 'sha256:492f3da8b2b78bc017769bf962fbbcda0cf5a53f2ddee884e5a12de2fa09d82a';

function freezeEntry(entry) {
  return Object.freeze({ ...entry, verifyArtifact(artifact) {
    if (!Buffer.isBuffer(artifact)) throw new TypeError('artifact must be bytes');
    const actual = createHash('sha256').update(artifact).digest();
    const expected = Buffer.from(entry.artifactHash.slice(7), 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('artifact integrity mismatch');
    return true;
  } });
}

const v4Entry = (network, layouts, fixtureIdentity) => freezeEntry({
  chain: 'solana', network, provider: 'squads', generation: 'v4',
  programId: V4_PROGRAM_ID, discriminator: V4_DISCRIMINATOR, layouts,
  decoderFamily: 'squads-v4-pinned', decoderVersion: '2.1.4', artifactHash: V4_ARTIFACT_HASH, lockIntegrity: V4_PACKAGE_INTEGRITY,
  fixtureIdentity, decoder: decodePinnedV4
});
export const decoderRegistry = Object.freeze([
  v4Entry('mainnet-beta', MAINNET_V4_LAYOUTS, 'finalized-multisig-7qipzLR9j1JcvdxE1XJEFgvoyFmgBpgw5hMdHBMPcJtM'),
  v4Entry('devnet', DEVNET_V4_LAYOUTS, 'finalized-multisig-CUR3VagHa3wBvYF4HYPnSyhDXTw8bPemCBsR3eF6u67Y')
]);

export function selectDecoder(selection) {
  return decoderRegistry.find((entry) => entry.chain === selection.chain && entry.network === selection.network && entry.programId === selection.programId && entry.discriminator === selection.discriminator && entry.layouts.has(selection.layout)) ?? null;
}

export function unsupportedGovernanceEvidence({ subjectAddress, network, slot, observedAt, reason, accountBytes = Buffer.alloc(0) }) {
  return { schemaVersion: 'governance-control/v1', chain: 'solana', network, subjectAddress, provider: 'squads', generation: 'unknown', programId: null, multisigAddress: null, authorityAddress: null, authorityIndex: null, threshold: null, members: [], timeLockSeconds: null, status: 'unsupported', slot, observedAt, accountHash: `sha256:${createHash('sha256').update(accountBytes).digest('hex')}`, decoderFamily: 'none', decoderVersion: 'none', artifactHash: 'sha256:' + '0'.repeat(64), providerData: { type: 'unsupported', reason } };
}

export function invalidGovernanceEvidence({ subjectAddress, network, slot, observedAt, reason, selection = {}, decoder = null, accountBytes = Buffer.alloc(0) }) {
  const selected = decoder || (typeof selection.decoder === 'function' ? selection : (selection.decoder || selection));
  return { schemaVersion: 'governance-control/v1', chain: 'solana', network, subjectAddress, provider: 'squads', generation: selected.generation || 'unknown', programId: null, multisigAddress: null, authorityAddress: null, authorityIndex: null, threshold: null, members: [], timeLockSeconds: null, status: 'invalid', slot, observedAt, accountHash: `sha256:${createHash('sha256').update(accountBytes).digest('hex')}`, decoderFamily: selected.decoderFamily || 'none', decoderVersion: selected.decoderVersion || 'none', artifactHash: selected.artifactHash || 'sha256:' + '0'.repeat(64), providerData: { type: 'invalid', reason } };
}

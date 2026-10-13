import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { getVaultPda, accounts as squadsAccounts } from '@sqds/multisig';
import { canonicalGovernanceControl } from '@kelvara/contracts/governance-control-v1';

export const SQUADS_V4_PROGRAM_ID = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
export const V4_ARTIFACT_HASH = 'sha256:492f3da8b2b78bc017769bf962fbbcda0cf5a53f2ddee884e5a12de2fa09d82a';
const DISCRIMINATOR = Buffer.from([224, 116, 121, 186, 68, 161, 79, 236]);
const MAX_MEMBERS = 64;
const FINALIZED_ALLOCATION_LENGTHS = new Set([231,495,528,627]);
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const P = (1n << 255n) - 19n;
const POW = (a, e) => { let r = 1n; for (; e; e >>= 1n, a = a * a % P) if (e & 1n) r = r * a % P; return r; };
function decode58(value) { let n = 0n; for (const c of value) { const i = ALPHABET.indexOf(c); if (i < 0) throw new TypeError('invalid base58'); n = n * 58n + BigInt(i); } const out = []; while (n) { out.push(Number(n & 255n)); n >>= 8n; } for (const c of value) { if (c === '1') out.push(0); else break; } if (out.length !== 32) throw new TypeError('invalid Solana address'); return Buffer.from(out.reverse()); }
function encode58(bytes) { let n = 0n; for (const byte of bytes) n = n * 256n + BigInt(byte); let out = ''; while (n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; } for (const byte of bytes) { if (!byte) out = `1${out}`; else break; } return out; }
function isOnCurve(bytes) { const y = BigInt(`0x${Buffer.from(bytes).reverse().toString('hex')}`) & ((1n << 255n) - 1n); if (y >= P) return false; const y2 = y * y % P; const x2 = (y2 - 1n) * POW(121665n * y2 + 1n, P - 2n) % P; let x = POW(x2, (P + 3n) / 8n); if (x * x % P !== x2) x = x * POW(2n, (P - 1n) / 4n) % P; return x * x % P === x2; }
function pda(seeds, programId) { const program = decode58(programId); for (let bump = 255; bump >= 0; bump -= 1) { const hash = createHash('sha256').update(Buffer.concat([...seeds, Buffer.from([bump]), program, Buffer.from('ProgramDerivedAddress')])).digest(); if (!isOnCurve(hash)) return encode58(hash); } throw new Error('unable to derive PDA'); }
export function deriveV4VaultPda({ programId = SQUADS_V4_PROGRAM_ID, multisigAddress, authorityIndex }) { if (!Number.isInteger(authorityIndex) || authorityIndex < 0 || authorityIndex > 255) throw new RangeError('authority index'); return getVaultPda({ multisigPda: new PublicKey(multisigAddress), index: authorityIndex, programId: new PublicKey(programId) })[0].toBase58(); }
function publicKey(bytes, offset) {
  if (offset < 0 || offset + 32 > bytes.length) throw new TypeError('malformed V4 account');
  return encode58(bytes.subarray(offset, offset + 32));
}

export function decodePinnedV4(bytes, { owner, programId = SQUADS_V4_PROGRAM_ID, authorityIndex } = {}) {
  if (!Number.isInteger(authorityIndex) || authorityIndex < 0 || authorityIndex > 255) throw new TypeError('authority index evidence required');
  if (programId !== SQUADS_V4_PROGRAM_ID) throw new Error('unsupported V4 program');
  if (owner !== programId) throw new Error('owner mismatch');
  if (!Buffer.isBuffer(bytes) || bytes.length < 100) throw new TypeError('malformed V4 account');
  if (!bytes.subarray(0, 8).equals(DISCRIMINATOR)) throw new Error('V4 discriminator mismatch');
  if(!FINALIZED_ALLOCATION_LENGTHS.has(bytes.length))throw new Error('V4 layout mismatch');
  let decoded;try{[decoded]=squadsAccounts.Multisig.deserialize(bytes)}catch{throw new Error('V4 layout mismatch')}
  const threshold=decoded.threshold,timeLockSeconds=decoded.timeLock,transactionIndex=Number(decoded.transactionIndex),staleTransactionIndex=Number(decoded.staleTransactionIndex),members=[];const seen=new Set();
  for(const member of decoded.members){const address=member.key.toBase58(),mask=member.permissions.mask;if(!Number.isInteger(mask)||mask<0||mask>7)throw new Error('permission mask unsupported');if(seen.has(address))throw new Error('duplicate member');seen.add(address);members.push({address,permissions:{initiate:Boolean(mask&1),vote:Boolean(mask&2),execute:Boolean(mask&4)},providerData:{type:'squads-v4-member',permissionMask:mask}})}
  if(!members.length||members.length>MAX_MEMBERS||threshold<1||threshold>members.length||timeLockSeconds>31_536_000||transactionIndex>Number.MAX_SAFE_INTEGER||staleTransactionIndex>Number.MAX_SAFE_INTEGER)throw new Error('V4 invariant');
  return{createKey:decoded.createKey.toBase58(),configAuthority:decoded.configAuthority.toBase58(),threshold,authorityIndex,timeLockSeconds,transactionIndex,staleTransactionIndex,rentCollector:decoded.rentCollector?.toBase58()??null,bump:decoded.bump,members};
}
export function translateV4({ network = 'mainnet-beta', subjectAddress, multisigAddress, programId = SQUADS_V4_PROGRAM_ID, slot, observedAt, accountBytes, decoded }) { if (!decoded || !accountBytes?.length) throw new Error('account evidence required'); const derived = deriveV4VaultPda({ programId, multisigAddress, authorityIndex: decoded.authorityIndex }); if (derived !== subjectAddress) throw new Error('vault PDA mismatch'); return canonicalGovernanceControl({ schemaVersion: 'governance-control/v1', chain: 'solana', network, subjectAddress, provider: 'squads', generation: 'v4', programId, multisigAddress, authorityAddress: subjectAddress, authorityIndex: decoded.authorityIndex, threshold: decoded.threshold, members: decoded.members, timeLockSeconds: decoded.timeLockSeconds, status: 'verified', slot, observedAt, accountHash: `sha256:${createHash('sha256').update(accountBytes).digest('hex')}`, decoderFamily: 'squads-v4-pinned', decoderVersion: '2.1.4', artifactHash: V4_ARTIFACT_HASH, providerData: { type: 'squads-v4', vaultPdaProof: { index: decoded.authorityIndex, seeds: ['multisig', multisigAddress, 'vault', String(decoded.authorityIndex)], derivedAddress: derived } } }, { now: new Date(`${observedAt.slice(0, 10)}T23:59:59.999Z`) }); }
export function normalizeGovernanceBatch({ evidence, indexerId, targetId, cursorBefore }) { const payload = JSON.stringify(evidence); if (!cursorBefore || !Number.isSafeInteger(cursorBefore.slot) || cursorBefore.slot < 0) throw new TypeError('cursorBefore is invalid'); if (!Number.isSafeInteger(evidence.slot) || evidence.slot < cursorBefore.slot) throw new RangeError('evidence slot regressed'); return { stream: 'governance_control', schemaVersion: 1, batchId: `sha256:${createHash('sha256').update(payload).digest('hex')}`, indexerId, targetId, network: evidence.network, cursorBefore, cursorAfter: { slot: evidence.slot, signature: null }, observedAt: evidence.observedAt, records: [{ type: 'governance_control', evidence }] }; }
export function emptySubjectObservation({ subjectAddress, slot, observedAt }) { return { status: 'unsupported', subjectAddress, slot, observedAt, reason: 'system-owned empty account requires independent Squads evidence' }; }

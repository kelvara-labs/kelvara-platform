import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePinnedV4, deriveV4VaultPda, SQUADS_V4_PROGRAM_ID, translateV4 } from './v4.js';

export function isDirectEntry(moduleUrl, argvPath = process.argv[1]) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(resolve(argvPath)).href;
}

export const LIVE_SUBJECT = '4JM5vsoGPkMMZCZusMC6rTNZpm4pFweBPQf36vT8yZ8x';
export const LIVE_MULTISIG = '7qipzLR9j1JcvdxE1XJEFgvoyFmgBpgw5hMdHBMPcJtM';
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

function runAsCli() {
  return runFinalizedLiveSmoke({ rpcUrl: process.env.SQUADS_RPC_URL || DEFAULT_RPC_URL });
}

async function rpc(url, method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`RPC ${body.error.message}`);
  return body.result;
}

export async function runFinalizedLiveSmoke({ rpcUrl = DEFAULT_RPC_URL, subjectAddress = LIVE_SUBJECT } = {}) {
  const account = await rpc(rpcUrl, 'getAccountInfo', [subjectAddress, { encoding: 'base64', commitment: 'finalized' }]);
  if (subjectAddress !== LIVE_SUBJECT) throw new Error('live smoke is pinned to supplied subject');
  if (!account?.value || account.value.owner !== '11111111111111111111111111111111' || account.value.data?.[0] !== '' || account.value.executable !== false) throw new Error('subject is not the expected system-owned empty account');
  const multisigAccount = await rpc(rpcUrl, 'getAccountInfo', [LIVE_MULTISIG, { encoding: 'base64', commitment: 'finalized' }]);
  if (!multisigAccount?.value || multisigAccount.value.owner !== SQUADS_V4_PROGRAM_ID || multisigAccount.value.data?.[1] !== 'base64') throw new Error('multisig is not the expected finalized Squads V4 account');
  const multisigBytes = Buffer.from(multisigAccount.value.data[0], 'base64');
  const decoded = decodePinnedV4(multisigBytes, { owner: multisigAccount.value.owner, programId: SQUADS_V4_PROGRAM_ID, authorityIndex: 1 });
  if (decoded.threshold !== 4 || decoded.members.length !== 7 || decoded.timeLockSeconds !== 3600) throw new Error('finalized multisig decoded values mismatch');
  const derived = deriveV4VaultPda({ programId: SQUADS_V4_PROGRAM_ID, multisigAddress: LIVE_MULTISIG, authorityIndex: decoded.authorityIndex });
  const evidence = translateV4({ subjectAddress, multisigAddress: LIVE_MULTISIG, programId: SQUADS_V4_PROGRAM_ID, slot: multisigAccount.context.slot, observedAt: new Date().toISOString(), accountBytes: multisigBytes, decoded });
  if (evidence.subjectAddress !== subjectAddress || evidence.threshold !== 4 || evidence.members.length !== 7 || evidence.timeLockSeconds !== 3600) throw new Error('finalized governance evidence mismatch');
  const signatures = await rpc(rpcUrl, 'getSignaturesForAddress', [subjectAddress, { limit: 100, commitment: 'finalized' }]);
  let execute;
  let transaction;
  for (const candidate of signatures.filter((entry) => entry.confirmationStatus === 'finalized' && !entry.err)) {
    const candidateTransaction = await rpc(rpcUrl, 'getTransaction', [candidate.signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
    const accountKeys = candidateTransaction?.transaction?.message?.accountKeys ?? [];
    const keyStrings = accountKeys.map((key) => typeof key === 'string' ? key : key.pubkey);
    const logs = candidateTransaction?.meta?.logMessages ?? [];
    if (keyStrings.includes(SQUADS_V4_PROGRAM_ID) && logs.includes('Program log: Instruction: VaultTransactionExecute') && keyStrings.includes(LIVE_MULTISIG)) { execute = candidate; transaction = candidateTransaction; break; }
  }
  if (!execute) throw new Error('finalized Squads V4 VaultTransactionExecute evidence missing');
  if (derived !== subjectAddress) throw new Error(`pinned V4 PDA mismatch: derived ${derived}, subject ${subjectAddress}`);
  const subjectAccountHash = `sha256:${createHash('sha256').update(Buffer.alloc(0)).digest('hex')}`;
  const multisigAccountHash = `sha256:${createHash('sha256').update(multisigBytes).digest('hex')}`;
  return { subjectAddress, subjectOwner: account.value.owner, subjectDataLength: 0, executable: false, commitment: 'finalized', subjectSlot: account.context.slot, subjectAccountHash, multisigAddress: LIVE_MULTISIG, multisigOwner: multisigAccount.value.owner, multisigDataLength: multisigBytes.length, multisigSlot: multisigAccount.context.slot, multisigAccountHash, evidenceAccountHash: evidence.accountHash, programId: SQUADS_V4_PROGRAM_ID, authorityIndex: decoded.authorityIndex, threshold: decoded.threshold, memberCount: decoded.members.length, timeLockSeconds: decoded.timeLockSeconds, evidenceGeneration: evidence.generation, derivedVaultPda: derived, signature: execute.signature, signatureSlot: execute.slot };
}

if (isDirectEntry(import.meta.url)) runAsCli().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });

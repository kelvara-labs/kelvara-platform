import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export const MAINNET_PROTECTION_BOOTSTRAP_ROUTES=Object.freeze(new Set([
  '/api/protection/nonce-setup/prepare',
  '/api/protection/nonce-setup/submit',
  '/api/protection/prepare',
  '/api/protection/arm',
  '/api/evacuation/prepare',
]));
export const MAINNET_PROTECTION_EXECUTION_ROUTES=Object.freeze(new Set([
  '/api/protection/fast-close',
  '/api/protection/revoke/prepare',
  '/api/protection/revoke',
  '/api/protection/revoke/finalize',
  '/api/protection/manual-evacuation/finalize',
  '/api/evacuation/submit',
]));
export const MAINNET_PROTECTION_ROUTES=Object.freeze(new Set([
  ...MAINNET_PROTECTION_BOOTSTRAP_ROUTES,
  ...MAINNET_PROTECTION_EXECUTION_ROUTES,
]));
const CHECKS=Object.freeze([
  'programRuntimeMigrated','protectionKeyCompatible','permitVaultIdentityVerified','controllerIdentityVerified',
  'exactTransactionBytesVerified','healthReadinessVerified','armedProtectionReadable',
]);
const SHA=/^[0-9a-f]{40}$/;

export async function resolveMainnetProtectionGate(env=process.env,baseDir='.'){
  const mode=env.MAINNET_PROTECTION_MODE||'disabled';
  if(!['disabled','enabled','demo'].includes(mode))throw new Error('mainnet_protection_mode_invalid');
  const releaseSha=env.KELVARA_RELEASE_SHA;
  if(!SHA.test(releaseSha||''))throw new Error('mainnet_protection_release_invalid');
  if(mode==='disabled')return Object.freeze({enabled:false,protectionMode:'disabled',demoExecutionEnabled:false,productionExecutionAuthorized:false,reason:'mainnet_protection_disabled',releaseSha});
  if(mode==='demo'){
    const wallet=env.DEVNET_DEMO_WALLET,targetId=env.DEMO_POSITION_TARGET_ID,genesisHash=env.DEVNET_GENESIS_HASH||env.DEVNET_GENESIS;
    const prefix='solana:devnet:kelvara-demo:position:';
    if(!wallet||!targetId?.startsWith(prefix)||!targetId.slice(prefix.length)||genesisHash!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw new Error('demo_scope_invalid');
    return Object.freeze({enabled:false,protectionMode:'demo',demoExecutionEnabled:true,productionExecutionAuthorized:false,releaseSha,scope:Object.freeze({network:'devnet',wallet,targetId,genesisHash})});
  }
  const file=env.MAINNET_PROTECTION_GATE_FILE;
  if(!file)throw new Error('mainnet_protection_gate_unavailable');
  let gate;try{gate=JSON.parse(await readFile(resolve(baseDir,file),'utf8'))}catch{throw new Error('mainnet_protection_gate_unavailable')}
  if(gate?.schemaVersion!==1||gate.releaseSha!==releaseSha||typeof gate.verifiedAt!=='string'||!gate.verifiedAt||!gate.checks||CHECKS.some(name=>gate.checks[name]!==true))throw new Error('mainnet_protection_gate_incomplete');
  return Object.freeze({enabled:true,protectionMode:'enabled',demoExecutionEnabled:false,productionExecutionAuthorized:true,releaseSha,verifiedAt:gate.verifiedAt,checks:Object.freeze({...gate.checks})});
}

export function mainnetProtectionBlocked(gate,method,pathname){return method==='POST'&&MAINNET_PROTECTION_ROUTES.has(pathname)&&gate?.protectionMode!=='enabled'}

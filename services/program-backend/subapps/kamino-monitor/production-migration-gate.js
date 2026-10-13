import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export const MAINNET_PROTECTION_ROUTES=Object.freeze(new Set([
  '/api/protection/nonce-setup/prepare',
  '/api/protection/nonce-setup/submit',
  '/api/protection/prepare',
  '/api/protection/arm',
  '/api/protection/fast-close',
  '/api/protection/revoke/prepare',
  '/api/protection/revoke',
  '/api/protection/revoke/finalize',
  '/api/protection/manual-evacuation/finalize',
  '/api/evacuation/prepare',
  '/api/evacuation/submit',
]));
const CHECKS=Object.freeze([
  'programRuntimeMigrated','protectionKeyCompatible','permitVaultIdentityVerified','controllerIdentityVerified',
  'exactTransactionBytesVerified','healthReadinessVerified','armedProtectionReadable',
]);
const SHA=/^[0-9a-f]{40}$/;

export async function resolveMainnetProtectionGate(env=process.env,baseDir='.'){
  const mode=env.MAINNET_PROTECTION_MODE||'disabled';
  if(!['disabled','enabled'].includes(mode))throw new Error('mainnet_protection_mode_invalid');
  const releaseSha=env.KELVARA_RELEASE_SHA;
  if(!SHA.test(releaseSha||''))throw new Error('mainnet_protection_release_invalid');
  if(mode==='disabled')return Object.freeze({enabled:false,reason:'mainnet_protection_disabled',releaseSha});
  const file=env.MAINNET_PROTECTION_GATE_FILE;
  if(!file)throw new Error('mainnet_protection_gate_unavailable');
  let gate;try{gate=JSON.parse(await readFile(resolve(baseDir,file),'utf8'))}catch{throw new Error('mainnet_protection_gate_unavailable')}
  if(gate?.schemaVersion!==1||gate.releaseSha!==releaseSha||typeof gate.verifiedAt!=='string'||!gate.verifiedAt||!gate.checks||CHECKS.some(name=>gate.checks[name]!==true))throw new Error('mainnet_protection_gate_incomplete');
  return Object.freeze({enabled:true,releaseSha,verifiedAt:gate.verifiedAt,checks:Object.freeze({...gate.checks})});
}

export function mainnetProtectionBlocked(gate,method,pathname){return method==='POST'&&MAINNET_PROTECTION_ROUTES.has(pathname)&&gate?.enabled!==true}

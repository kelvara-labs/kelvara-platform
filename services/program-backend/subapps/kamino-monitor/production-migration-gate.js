import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export const MAINNET_PROTECTION_SETUP_ROUTES=Object.freeze(new Set([
  '/api/protection/nonce-setup/prepare',
  '/api/protection/nonce-setup/submit',
  '/api/protection/prepare',
  '/api/protection/arm',
]));
export const MAINNET_PROTECTION_EXECUTION_ROUTES=Object.freeze(new Set([
  '/api/evacuation/prepare',
  '/api/protection/fast-close',
  '/api/protection/revoke/prepare',
  '/api/protection/revoke',
  '/api/protection/revoke/finalize',
  '/api/protection/manual-evacuation/finalize',
  '/api/evacuation/submit',
]));
const MAINNET_WALLET='7sXHKv8RJG4ENmiDSpBEgiEnktJXPaVEmq2a8QBsvEgJ';
const MAINNET_TARGET='solana:mainnet-beta:kamino:kvault:BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5';
const EXECUTION_CHECKS=Object.freeze(['programRuntimeMigrated','protectionKeyCompatible','permitVaultIdentityVerified','controllerIdentityVerified','healthReadinessVerified']);
const CHECKS=EXECUTION_CHECKS;
const setupReady=(checks)=>EXECUTION_CHECKS.every(name=>checks[name]===true);
const SHA=/^[0-9a-f]{40}$/;

export async function resolveMainnetProtectionGate(env=process.env,baseDir='.'){
  const mode=env.MAINNET_PROTECTION_MODE||'disabled';
  if(!['disabled','enabled','demo'].includes(mode))throw new Error('mainnet_protection_mode_invalid');
  const releaseSha=env.KELVARA_RELEASE_SHA;
  if(!SHA.test(releaseSha||''))throw new Error('mainnet_protection_release_invalid');
  if(mode==='disabled')return Object.freeze({enabled:false,protectionMode:'disabled',setupAuthorized:false,manualExecutionAuthorized:false,automaticExecutionAuthorized:false,executionAuthorized:false,demoExecutionEnabled:false,productionExecutionAuthorized:false,reason:'mainnet_protection_disabled',releaseSha});
  if(mode==='demo'){
    const wallet=env.DEVNET_DEMO_WALLET,targetId=env.DEMO_POSITION_TARGET_ID,genesisHash=env.DEVNET_GENESIS_HASH||env.DEVNET_GENESIS;
    const prefix='solana:devnet:kelvara-demo:position:';
    if(!wallet||!targetId?.startsWith(prefix)||!targetId.slice(prefix.length)||genesisHash!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw new Error('demo_scope_invalid');
    return Object.freeze({enabled:false,protectionMode:'demo',setupAuthorized:false,manualExecutionAuthorized:false,automaticExecutionAuthorized:false,executionAuthorized:false,demoExecutionEnabled:true,productionExecutionAuthorized:false,releaseSha,scope:Object.freeze({network:'devnet',wallet,targetId,genesisHash})});
  }
  const file=env.MAINNET_PROTECTION_GATE_FILE;
  if(!file)throw new Error('mainnet_protection_gate_unavailable');
  let gate;try{gate=JSON.parse(await readFile(resolve(baseDir,file),'utf8'))}catch{throw new Error('mainnet_protection_gate_unavailable')}
  if(gate?.schemaVersion!==1||gate.releaseSha!==releaseSha||typeof gate.verifiedAt!=='string'||!gate.verifiedAt||gate.wallet!==MAINNET_WALLET||gate.targetId!==MAINNET_TARGET||!gate.checks||!setupReady(gate.checks))throw new Error(gate?.wallet!==MAINNET_WALLET||gate?.targetId!==MAINNET_TARGET?'mainnet_protection_scope_invalid':'mainnet_protection_gate_incomplete');
  const manualExecutionAuthorized=gate.manualExecutionAuthorized===true;
  const automaticExecutionAuthorized=false;
  return Object.freeze({enabled:true,protectionMode:'enabled',demoExecutionEnabled:false,setupReady:true,setupAuthorized:true,manualExecutionAuthorized,automaticExecutionAuthorized,executionAuthorized:manualExecutionAuthorized,productionExecutionAuthorized:automaticExecutionAuthorized,releaseSha,verifiedAt:gate.verifiedAt,scope:Object.freeze({network:'mainnet-beta',wallet:gate.wallet,targetId:gate.targetId}),checks:Object.freeze({...gate.checks})});
}

export function mainnetProtectionRouteKind(method,pathname){if(method!=='POST')return null;if(MAINNET_PROTECTION_SETUP_ROUTES.has(pathname))return 'setup';if(MAINNET_PROTECTION_EXECUTION_ROUTES.has(pathname))return 'execution';return null}
export function mainnetProtectionBlocked(gate,method,pathname){const kind=mainnetProtectionRouteKind(method,pathname);return Boolean(kind)&&gate?.[kind==='setup'?'setupAuthorized':'executionAuthorized']!==true}
export function mainnetProtectionScopeMismatch(gate,session,input){return gate?.protectionMode==='enabled'&&(session?.wallet!==gate.scope?.wallet||input?.targetId!==gate.scope?.targetId)}
export const MAINNET_PROTECTION_ROUTES=Object.freeze(new Set([...MAINNET_PROTECTION_SETUP_ROUTES,...MAINNET_PROTECTION_EXECUTION_ROUTES]));

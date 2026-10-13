import {join} from 'node:path';
import {createGovernanceSubjectMappingStore} from '../../control-center/src/governance-subject-mapping-store.js';
import {createSquadsAssignmentStore,resolveSquadsAssignments} from './assignments.js';
import {runAssignedProductionCycles} from './main.js';
import {createSubjectLivenessPublisher} from './liveness.js';

function array(env,name){if(typeof env[name]!=='string')throw new TypeError(`${name} is required`);let value;try{value=JSON.parse(env[name])}catch{throw new TypeError(`${name} must be valid JSON`)}if(!Array.isArray(value))throw new TypeError(`${name} must be an array`);return value}
function credentials(env){let value;try{value=JSON.parse(env.SQUADS_CREDENTIALS_JSON)}catch{throw new TypeError('SQUADS_CREDENTIALS_JSON must be valid JSON')}if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('SQUADS_CREDENTIALS_JSON must be an object');return new Map(Object.entries(value))}
function required(env,name){if(typeof env[name]!=='string'||!env[name])throw new TypeError(`${name} is required`);return env[name]}
export function startAssignmentLoop(runtime,{intervalMs=60_000,setTimeoutImpl=setTimeout,clearTimeoutImpl=clearTimeout,onResult=()=>{},onError=()=>{}}={}){
 if(!runtime||typeof runtime.runOnce!=='function'||!Number.isInteger(intervalMs)||intervalMs<5000)throw new TypeError('assignment loop configuration invalid');
 let timer=null,stopped=false;
 const run=async()=>{if(stopped)return;try{onResult(await runtime.runOnce())}catch(error){onError(error)}finally{if(!stopped)timer=setTimeoutImpl(run,intervalMs)}};
 const started=run();
 return{started,stop(){stopped=true;if(timer!==null)clearTimeoutImpl(timer)},get stopped(){return stopped}};
}
export function createProductionAssignmentRuntime({env=process.env,deriveVaultPda,runCycles=runAssignedProductionCycles,publishLiveness}={}){
 const dir=required(env,'SQUADS_DATA_DIR');const mappingStore=createGovernanceSubjectMappingStore({path:join(dir,'governance-subject-mappings.sqlite'),deriveVaultPda});
 const assignmentStore=createSquadsAssignmentStore({path:join(dir,'squads-assignments.sqlite'),mappingStore});
 try{
  for(const mapping of array(env,'SQUADS_VERIFIED_MAPPINGS_JSON'))mappingStore.putVerified(mapping);
  for(const assignment of array(env,'SQUADS_ASSIGNMENTS_JSON'))assignmentStore.put(assignment);
  const assignments=resolveSquadsAssignments(assignmentStore.list(),{credentials:credentials(env)}),networks=new Set(assignments.filter(a=>a.state==='ready').map(a=>a.network)),rpcUrlsByNetwork={};
  for(const network of networks){const name=network==='mainnet-beta'?'SQUADS_RPC_URL_MAINNET':network==='devnet'?'SQUADS_RPC_URL_DEVNET':null;if(!name)throw new TypeError(`RPC configuration unsupported for ${network}`);rpcUrlsByNetwork[network]=required(env,name)}
  const publish=publishLiveness??createSubjectLivenessPublisher({hubUrl:required(env,'KELVARA_OBSERVATION_HUB_URL'),assignmentToken:required(env,'ASSIGNMENT_TOKEN')});
  return Object.freeze({mappingStore,assignmentStore,assignments,async runOnce(){const results=await runCycles({assignments,rpcUrlsByNetwork,hubUrl:required(env,'KELVARA_OBSERVATION_HUB_URL').replace(/\/$/,''),programId:required(env,'SQUADS_PROGRAM_ID'),timeoutMs:Number(env.SQUADS_TIMEOUT_MS||10_000)});await Promise.all(results.map(result=>publish({assignment:assignments.find(a=>a.assignmentId===result.assignmentId),result})));return results.map(({credential,...result})=>result)},close(){assignmentStore.close();mappingStore.close()}});
 }catch(error){assignmentStore.close();mappingStore.close();throw error}
}

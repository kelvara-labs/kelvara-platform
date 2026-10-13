import { loadSquadsConfig } from './config.js';
import { runOneCycle } from './client.js';
import { createDiagnosticsServer } from './diagnostics.js';
import { runAssignmentCycles } from './assignments.js';
import { deriveV4VaultPda } from './v4.js';
import { createProductionAssignmentRuntime, startAssignmentLoop } from './production-assignment-runtime.js';

let state = { status: 'starting' };
export async function runProductionCycle(env = process.env) {
  const config = loadSquadsConfig(env);
  state = { status: 'degraded' };
  const result = await runOneCycle({ ...config, token: config.hubToken });
  state = { status: 'ready', result };
  return result;
}
export async function runAssignedProductionCycles({assignments,rpcUrlsByNetwork,hubUrl,programId,timeoutMs=10_000,runCycle=runOneCycle}={}){
 return runAssignmentCycles(assignments,a=>{const rpcUrl=rpcUrlsByNetwork?.[a.network];if(typeof rpcUrl!=='string'||!rpcUrl)throw new TypeError(`RPC URL unavailable for ${a.network}`);return runCycle({rpcUrl,hubUrl,programId,timeoutMs,indexerId:a.assignmentId,network:a.network,subjectAddress:a.vaultAuthority,multisigAddress:a.multisigAddress,authorityIndex:a.vaultIndex,token:a.credential.token})})
}
const direct = process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;
let diagnostics=null;
if (direct) {
 diagnostics=createDiagnosticsServer({ host: '0.0.0.0', port: Number(process.env.HEALTH_PORT || 7622), getStatus: () => state });
 const assigned=Boolean(process.env.SQUADS_ASSIGNMENTS_JSON);
 let runtime,loop;
 if(assigned){
  runtime=createProductionAssignmentRuntime({deriveVaultPda:({programId,multisigAddress,authorityIndex,vaultIndex})=>deriveV4VaultPda({programId,multisigAddress,authorityIndex:authorityIndex??vaultIndex})});
  loop=startAssignmentLoop(runtime,{intervalMs:Number(process.env.SQUADS_POLL_INTERVAL_MS||60_000),onResult:result=>{state={status:'ready',result};process.stdout.write(`${JSON.stringify(result)}\n`)},onError:error=>{state={status:'degraded',error:error.message};process.stderr.write(`${error.message}\n`)}});
 }else runProductionCycle().then((result) => {state={status:'ready',result};process.stdout.write(`${JSON.stringify(result)}\n`)}).catch((error) => { state = { status: 'degraded', error: error.message }; process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
 process.on('SIGTERM', () => {loop?.stop();runtime?.close();diagnostics?.close()});
}

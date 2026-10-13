import { AsyncLocalStorage } from "node:async_hooks";
import { readFile,stat } from "node:fs/promises";
import { Connection,Keypair,Transaction,sendAndConfirmTransaction } from "@solana/web3.js";
import { createScenarioCapsuleChain } from "./scenario-capsule-chain.js";

async function load(path){const info=await stat(path);if((info.mode&0o077)!==0)throw new Error("demo_session_authority_permissions");return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path,"utf8"))))}
async function submit(rpc,tx,signers){return sendAndConfirmTransaction(rpc,tx,signers,{commitment:"confirmed"})}

export async function createDemoSessionRuntime({env=process.env,readAuthority=load,makeConnection=url=>new Connection(url,"confirmed"),makeChain=createScenarioCapsuleChain,send=submit}={}){
 const names=["DEVNET_SCENARIO_PROGRAM_ID","DEVNET_FUN_USD_MINT","DEVNET_SCENARIO_CONTROLLER_PATH","DEVNET_RPC_URL","DEVNET_SCENARIO_SESSION","DEVNET_SCENARIO_SESSION_ID"],values=names.map(name=>env[name]);
 if(values.every(value=>!value))return null;
 if(values.some(value=>!value))throw new Error("demo_session_configuration_incomplete");
 const sessionId=Buffer.from(env.DEVNET_SCENARIO_SESSION_ID,"hex");if(sessionId.length!==32||sessionId.toString("hex")!==env.DEVNET_SCENARIO_SESSION_ID.toLowerCase())throw new Error("demo_session_configuration_incomplete");
 const signer=await readAuthority(env.DEVNET_SCENARIO_CONTROLLER_PATH),authority=signer.publicKey.toBase58();
 if(env.DEVNET_SCENARIO_CONTROLLER_PUBKEY&&env.DEVNET_SCENARIO_CONTROLLER_PUBKEY!==authority)throw new Error("demo_session_authority_mismatch");
 const rpc=makeConnection(env.DEVNET_RPC_URL),fixedSession={sessionId,session:env.DEVNET_SCENARIO_SESSION,authority},identityContext=new AsyncLocalStorage();
 const resolveSession=()=>{const input=identityContext.getStore();if(!input?.wallet)throw new Error("invalid_demo_session_request");return{...fixedSession,wallet:input.wallet}};
 const chain=makeChain({rpc,programId:env.DEVNET_SCENARIO_PROGRAM_ID,mint:env.DEVNET_FUN_USD_MINT,controllerAuthority:authority,resolveSession});
 async function withIdentity(input,task){return identityContext.run(input,async()=>task(resolveSession()))}
 async function sendController(prepared){if(prepared.feePayer!==authority||typeof prepared.transaction!=="string"||!prepared.transaction)throw new Error("demo_controller_transaction_identity_mismatch");const tx=Transaction.from(Buffer.from(prepared.transaction,"base64")),signature=await send(rpc,tx,[signer],{blockhash:tx.recentBlockhash,lastValidBlockHeight:prepared.lastValidBlockHeight});return signature}
 return{
  async getOrCreateSession(input){return withIdentity(input,async identity=>{const prepared=await chain.prepareInitializeSession();if(prepared.state==="exists")return{...identity,state:"exists"};if(prepared.state!=="prepared"||prepared.session!==identity.session||prepared.feePayer!==authority)throw new Error("demo_session_transaction_identity_mismatch");const signature=await sendController(prepared);return{...identity,state:"confirmed",signature}})},
  async inspectPosition(input){return withIdentity(input,()=>chain.inspectPosition(input))},
  async prepareDeposit(input){return withIdentity(input,()=>chain.prepareDeposit(input))},
  async triggerAuthorityIncident(input){return withIdentity(input,async identity=>{const prepared=await chain.prepareAuthorityIncident({session:identity.session});if(prepared.session!==identity.session||prepared.incident!=="authority_changed")throw new Error("demo_incident_transaction_identity_mismatch");const signature=await sendController(prepared);return{state:"confirmed",incident:"authority_changed",session:identity.session,signature}})},
  async resetAuthorityIncident(input){return withIdentity(input,async identity=>{const prepared=await chain.prepareAuthorityReset({session:identity.session});if(prepared.session!==identity.session||prepared.state!=="baseline")throw new Error("demo_reset_transaction_identity_mismatch");const signature=await sendController(prepared);return{state:"confirmed",incident:"baseline",session:identity.session,signature}})},
  async prepareEvacuation(input){return withIdentity(input,identity=>chain.prepareEvacuation({...input,session:identity.session}))},
  close(){}
 };
}

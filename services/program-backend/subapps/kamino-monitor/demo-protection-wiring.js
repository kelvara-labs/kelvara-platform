import {createDemoPositionProtectionAdapter} from './demo-position-protection-adapter.js';
async function simulate(fetchImpl,url,transaction){
 const response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'simulateTransaction',params:[transaction,{encoding:'base64',sigVerify:false,replaceRecentBlockhash:false,commitment:'confirmed'}]})});
 if(!response.ok)throw new Error(`demo_protection_rpc_http_${response.status}`);
 const body=await response.json();if(body.error||!body.result?.value)throw new Error('demo_protection_rpc_malformed');return body.result.value;
}
export function createProgramBackendDemoProtection({env=process.env,activationService,fetchImpl=fetch}={}){
 if(!activationService||!env.DEVNET_RPC_URL)throw new TypeError('demo_protection_config_invalid');
 return createDemoPositionProtectionAdapter({targetId:env.DEMO_POSITION_TARGET_ID,session:env.DEVNET_SCENARIO_SESSION,programId:env.DEVNET_SCENARIO_PROGRAM_ID,mint:env.DEVNET_FUN_USD_MINT,prepare:input=>activationService.prepareEvacuation({wallet:input.wallet,network:'devnet',genesisHash:env.DEVNET_GENESIS_HASH,demoVersion:'scenario-capsule-v1',amount:input.amount}),simulate:transaction=>simulate(fetchImpl,env.DEVNET_RPC_URL,transaction)});
}

import {validateSolanaAddress} from '../../src/domains/discovery/wallet.js';
const PREFIX='solana:devnet:kelvara-demo:position:';
export function createDemoPositionProtectionAdapter({targetId,session,programId,mint,prepare,simulate}={}){
 const position=targetId?.startsWith(PREFIX)?targetId.slice(PREFIX.length):null;
 if(!validateSolanaAddress(position)||!validateSolanaAddress(session)||!validateSolanaAddress(programId)||!validateSolanaAddress(mint)||typeof prepare!=='function'||typeof simulate!=='function')throw new TypeError('demo_protection_config_invalid');
 return Object.freeze({async prepare(input){
  if(input?.network!=='devnet'||input.targetId!==targetId||!validateSolanaAddress(input.wallet))throw new Error('demo_protection_identity_mismatch');
  const prepared=await prepare({wallet:input.wallet,network:'devnet',targetId,session,programId,mint,amount:'100000'});
  if(prepared?.feePayer!==input.wallet||prepared.position!==position||prepared.programId!==programId||prepared.mint!==mint||prepared.amount!=='100000'||typeof prepared.transaction!=='string'||!prepared.transaction||!Number.isSafeInteger(prepared.lastValidBlockHeight)||prepared.lastValidBlockHeight<1||!validateSolanaAddress(prepared.destination))throw new Error('demo_protection_transaction_identity_mismatch');
  const simulation=await simulate(prepared.transaction);
  if(!simulation||simulation.err!==null)throw new Error('demo_protection_simulation_failed');
  return{schemaVersion:'kelvara-protection-preparation/v1',action:'evacuate',mode:'wallet-signature-required',network:'devnet',targetId,wallet:input.wallet,transaction:prepared.transaction,lastValidBlockHeight:prepared.lastValidBlockHeight,feePayer:prepared.feePayer,destination:prepared.destination,amount:prepared.amount,mint,programId,simulation};
 }});
}

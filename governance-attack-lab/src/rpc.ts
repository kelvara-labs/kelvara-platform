import { Connection } from '@solana/web3.js';
import type { StepEvidence } from './evidence/types.js';
export async function finalizedEvidence(connection:Connection,label:string,signature:string):Promise<StepEvidence>{
 const deadline=Date.now()+120_000; let status;
 while(Date.now()<deadline){status=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];if(status?.err)throw new Error(`${label} failed: ${JSON.stringify(status.err)}`);if(status?.confirmationStatus==='finalized')break;await new Promise(r=>setTimeout(r,1000))}
 if(status?.confirmationStatus!=='finalized')throw new Error(`${label} did not finalize within 120s`);
 const tx=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!tx)throw new Error(`${label} finalized but getTransaction returned null`);
 return {schemaVersion:1,label,signature,capturedAt:new Date().toISOString(),confirmation:{confirmationStatus:status.confirmationStatus,confirmations:status.confirmations,err:status.err},rpc:{slot:tx.slot,blockTime:tx.blockTime??null,transaction:tx.transaction,meta:tx.meta}};
}

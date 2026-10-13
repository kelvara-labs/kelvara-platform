import {createHash} from 'node:crypto';

export function fingerprintSignedTransaction(encoded){
 if(typeof encoded!=='string'||!encoded)throw new Error('signed_transaction_required');
 return createHash('sha256').update(Buffer.from(encoded,'base64')).digest('hex');
}
export function verifyStoredVariantBytes(variant){
 if(!variant?.fingerprint||fingerprintSignedTransaction(variant.signedTransaction)!==variant.fingerprint)throw new Error('signed_transaction_fingerprint_mismatch');
 return variant.signedTransaction;
}
export function evacuationResultProven({beforeShares,afterShares,authorizedShares}){return beforeShares>=afterShares&&beforeShares-afterShares>=authorizedShares}
export function executionPending(record){return ['reserved','broadcast_pending','confirmation_pending_position_verification'].includes(record?.execution?.state)}
export function createExecutionReservations(){
 const active=new Set();
 return{async run(key,operation){if(active.has(key))throw new Error('execution_in_progress');active.add(key);try{return await operation()}finally{active.delete(key)}}};
}

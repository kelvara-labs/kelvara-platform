import test from 'node:test';
import assert from 'node:assert/strict';
import {fingerprintSignedTransaction,verifyStoredVariantBytes,createExecutionReservations,evacuationResultProven,executionPending} from './manual-durable-execution.js';

test('fingerprint binds exact signed serialized bytes',()=>{
 const encoded=Buffer.from('signed bytes').toString('base64'),fingerprint=fingerprintSignedTransaction(encoded);
 assert.equal(verifyStoredVariantBytes({...{signedTransaction:encoded,fingerprint}}),encoded);
 assert.throws(()=>verifyStoredVariantBytes({signedTransaction:Buffer.from('changed').toString('base64'),fingerprint}),/signed_transaction_fingerprint_mismatch/);
});

test('position completion requires the authorized share reduction',()=>{
 assert.equal(evacuationResultProven({beforeShares:300n,afterShares:200n,authorizedShares:100n}),true);
 assert.equal(evacuationResultProven({beforeShares:300n,afterShares:250n,authorizedShares:100n}),false);
 assert.equal(evacuationResultProven({beforeShares:100n,afterShares:0n,authorizedShares:100n}),true);
});

test('persisted in-flight execution remains fail-closed across requests',()=>{
 for(const state of ['reserved','broadcast_pending','confirmation_pending_position_verification'])assert.equal(executionPending({execution:{state}}),true);
 assert.equal(executionPending({execution:{state:'completed'}}),false);
 assert.equal(executionPending({}),false);
});

test('keyed reservation permits only one concurrent execution',async()=>{
 const reservations=createExecutionReservations();let release;
 const first=reservations.run('wallet:mainnet:target:version',()=>new Promise(resolve=>{release=resolve}));
 await Promise.resolve();
 await assert.rejects(()=>reservations.run('wallet:mainnet:target:version',async()=>{}),/execution_in_progress/);
 release('done');assert.equal(await first,'done');
 assert.equal(await reservations.run('wallet:mainnet:target:version',async()=> 'next'),'next');
});

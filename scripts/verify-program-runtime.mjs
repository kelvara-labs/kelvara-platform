#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createProtectionStore} from '../services/program-backend/subapps/kamino-monitor/protection.js';
import {loadOrCreateProtectionKey} from '../services/program-backend/subapps/kamino-monitor/runtime-config.js';

export async function verifyProgramRuntime({runtimeDir='/data/kamino-monitor',expectedKeySha256,requiredRecords=[]}={}){
 const keyPath=`${runtimeDir}/protection.key`,storePath=`${runtimeDir}/armed-protection.enc`;
 const key=await loadOrCreateProtectionKey({keyPath,storePath});
 const digest=createHash('sha256').update(key).digest('hex');
 if(!expectedKeySha256||digest!==expectedKeySha256)throw new Error('protection_key_fingerprint_mismatch');
 JSON.parse(await readFile(storePath,'utf8'));
 const store=createProtectionStore({path:storePath,key});
 for(const record of requiredRecords){const value=await store.get(record.wallet,record.targetId);if(!value||value.wallet!==record.wallet||value.network!=='mainnet-beta'||value.targetId!==record.targetId)throw new Error('armed_protection_record_incompatible')}
 return {keySha256:digest,recordsVerified:requiredRecords.length};
}
if(process.argv[1]===new URL(import.meta.url).pathname){try{const requiredRecords=JSON.parse(process.env.REQUIRED_ARMED_PROTECTION_RECORDS_JSON||'[]');const result=await verifyProgramRuntime({runtimeDir:process.env.KELVARA_RUNTIME_DIR,expectedKeySha256:process.env.EXPECTED_PROTECTION_KEY_SHA256,requiredRecords});console.log(JSON.stringify({ok:true,...result}))}catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1}}

#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
const SHA=/^[0-9a-f]{40}$/;
const HASH=/^[0-9a-f]{64}$/;
export async function verifyCloudflareCutover({releaseSha,approvalFile='/run/kelvara/cloudflare-cutover-approval.json',readApproval=path=>readFile(path,'utf8'),fetchImpl=fetch}){
 let approval;try{approval=JSON.parse(await readApproval(approvalFile))}catch{throw new Error('cloudflare_cutover_not_approved')}
 if(!SHA.test(releaseSha||'')||approval?.schemaVersion!==1||approval.releaseSha!==releaseSha||!HASH.test(approval.snapshotSha256||'')||approval.pcTunnelStopped!==true||approval.localStateVerified!==true||approval.protectionChecksPassed!==true||typeof approval.approvedAt!=='string'||!approval.approvedAt)throw new Error('cloudflare_cutover_approval_invalid');
 const endpoints=[
  ['program-backend','http://program-backend:8080/healthz'],['control-center','http://control-center:7651/health/ready'],['observation-hub','http://observation-hub:7610/health/ready'],['indexer-squads','http://indexer-squads:7622/health/ready'],['status-page','http://status-page:8090/healthz']
 ];
 for(const [name,url] of endpoints){let response,payload;try{response=await fetchImpl(url);payload=await response.json()}catch{throw new Error(`cloudflare_cutover_${name}_unreachable`)}if(!response.ok||payload?.ok===false||payload?.status==='degraded')throw new Error(`cloudflare_cutover_${name}_unready`);if(name==='program-backend'&&payload?.releaseSha!==releaseSha)throw new Error('cloudflare_cutover_release_mismatch')}
 return approval;
}
if(process.argv[1]===new URL(import.meta.url).pathname){try{await verifyCloudflareCutover({releaseSha:process.env.KELVARA_RELEASE_SHA});console.log('cloudflare cutover gate: OK')}catch(error){console.error(`cloudflare cutover gate: FAIL: ${error.message}`);process.exitCode=1}}

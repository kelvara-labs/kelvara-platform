import { deriveScenarioPdas } from './scenario-capsule-codec.js';
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const KEYS=new Set(['programId','authority','wallet','sessionId','policyRevision','ruleVersion','bindingId']);
const BASE58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ID=/^[A-Za-z0-9._:-]{1,128}$/;
export function buildDemoCapsuleRotation(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!KEYS.has(key))||!BASE58.test(input.programId)||!BASE58.test(input.authority)||!BASE58.test(input.wallet)||!/^[a-f0-9]{64}$/.test(input.sessionId)||!Number.isSafeInteger(input.policyRevision)||input.policyRevision<1||!Number.isSafeInteger(input.ruleVersion)||input.ruleVersion<1||!ID.test(input.bindingId))throw new TypeError('invalid_demo_capsule_rotation');
 const {session,position}=deriveScenarioPdas({programId:input.programId,authority:input.authority,owner:input.wallet,sessionId:Buffer.from(input.sessionId,'hex')}),targetId=`solana:devnet:kelvara-demo:position:${position}`,ruleId='scenario.authority-unchanged';
 const policy=Object.freeze({targetId,position,ruleId,bindingId:input.bindingId,approvedAuthority:input.authority,session,programId:input.programId});
 const registry=Object.freeze([Object.freeze({network:'devnet',genesisHash:GENESIS,programId:input.programId,session,authority:input.authority,sessionId:input.sessionId,targetId,policyRevision:input.policyRevision,ruleId,ruleVersion:input.ruleVersion,bindingId:input.bindingId})]);
 return Object.freeze({sessionId:input.sessionId,session,position,targetId,policy,registry});
}

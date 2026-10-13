import { createHash } from 'node:crypto';
export const VELOCITY_OBSERVATION_SCHEMA='velocity-observation-v1';
const ID=/^[1-9A-HJ-NP-Za-km-z]{32,64}$/; const HEX=/^[0-9a-f]{64}$/;
const shapes={provenance:['source','method','commitment'],token:['mint','amount']};
function clone(v,depth=0){if(depth>4||v===null||typeof v!=='object')return v; if(Array.isArray(v))return Object.freeze(v.map(x=>clone(x,depth+1))); const o={}; for(const k of Object.keys(v).sort())o[k]=clone(v[k],depth+1); return Object.freeze(o)}
function closed(o, keys, name){if(!o||typeof o!=='object'||Array.isArray(o))throw new TypeError(`${name} must be an object`); for(const k of Object.keys(o))if(!keys.includes(k))throw new TypeError(`unknown ${name} field: ${k}`); for(const k of keys)if(typeof o[k]!=='string'||!o[k]||o[k].length>256)throw new TypeError(`${name}.${k} is invalid`)}
function canonicalTime(s){if(typeof s!=='string'||!/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)\.\d{3}Z$/.test(s))throw new TypeError('observedAt timestamp is invalid'); const d=new Date(s); if(Number.isNaN(d.valueOf())||d.toISOString()!==s||d>new Date())throw new TypeError('observedAt timestamp is invalid')}
export function validateVelocityObservation(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('observation must be an object');
 const allowed=['observationId','kind','network','programId','address','slot','owner','executable','dataLength','dataHash','observedAt','provenance','status','unknownReason','token']; for(const k of Object.keys(input))if(!allowed.includes(k))throw new TypeError(`unknown field: ${k}`);
 for(const k of ['observationId','network','programId','address','observedAt','status'])if(typeof input[k]!=='string'||!input[k]||input[k].length>256)throw new TypeError(`${k} is required`);
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(input.observationId)||!['mainnet-beta','devnet','testnet','localnet'].includes(input.network))throw new TypeError('observation identity is invalid');
 if(!ID.test(input.programId)||!ID.test(input.address))throw new TypeError('invalid Solana identity');
 if(typeof input.slot!=='string'||!/^(0|[1-9]\d{0,19})$/.test(input.slot)||BigInt(input.slot)>9007199254740991n)throw new TypeError('slot must be canonical decimal');
 if(!['program','account'].includes(input.kind)||!['verified','unknown','unresolved'].includes(input.status))throw new TypeError('invalid kind or status');
 if(input.status==='verified'&&input.unknownReason!==undefined)throw new TypeError('unknownReason only allowed for unknown status');
 if(input.status!=='verified'&&(typeof input.unknownReason!=='string'||!input.unknownReason))throw new TypeError('unknownReason required');
 canonicalTime(input.observedAt); closed(input.provenance,shapes.provenance,'provenance');
 if(input.token!==undefined)closed(input.token,shapes.token,'token');
 if(input.owner!==undefined&&!ID.test(input.owner))throw new TypeError('invalid owner');
 if(input.dataLength!==undefined&&(!Number.isSafeInteger(input.dataLength)||input.dataLength<0))throw new TypeError('invalid dataLength');
 if(input.dataHash!==undefined&&!HEX.test(input.dataHash))throw new TypeError('invalid dataHash');
 if(input.executable!==undefined&&typeof input.executable!=='boolean')throw new TypeError('invalid executable');
 const raw={...input,schema:VELOCITY_OBSERVATION_SCHEMA}; raw.payloadDigest=createHash('sha256').update(JSON.stringify(raw)).digest('hex'); return clone(raw);
}

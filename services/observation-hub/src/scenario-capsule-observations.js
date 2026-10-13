import {createHash} from 'node:crypto';
import {recordEvaluationReceipt} from './evaluation-receipts.js';

const BASE58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX64=/^[a-f0-9]{64}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVIDENCE_FIELDS=new Set(['schemaVersion','evidenceRef','network','genesisHash','programId','session','authority','sessionId','flags','sequence','finalizedSlot','observedAt','commitment','decoderVersion']);
const EXPECTED_FIELDS=new Set(['network','genesisHash','programId','session','authority','sessionId','targetId','policyRevision','ruleId','ruleVersion','bindingId']);
const id=(value,name,max=128)=>{if(typeof value!=='string'||value.length<1||value.length>max||!/^[A-Za-z0-9._:-]+$/.test(value))throw new TypeError(`${name} is invalid`);return value};
const key=(value,name)=>{if(typeof value!=='string'||!BASE58.test(value))throw new TypeError(`${name} is invalid`);return value};
const time=(value,name)=>{if(typeof value!=='string'||!ISO.test(value)||new Date(value).toISOString()!==value)throw new TypeError(`${name} is invalid`);return value};
const closed=(value,fields,name)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(field=>!fields.has(field)))throw new TypeError(`${name} is invalid`)};
const canonical=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export function createScenarioCapsuleRegistry(entries){if(!Array.isArray(entries)||entries.length<1)throw new TypeError('scenario registry is required');const registry=new Map;for(const entry of entries){closed(entry,EXPECTED_FIELDS,'registry entry');for(const name of ['programId','session','authority'])key(entry[name],`registry.${name}`);if(entry.network!=='devnet'||entry.genesisHash!==GENESIS||!HEX64.test(entry.sessionId))throw new TypeError('scenario registry identity is invalid');const idKey=`${entry.network}:${entry.genesisHash}:${entry.programId}:${entry.session}`;if(registry.has(idKey))throw new TypeError('scenario registry identity is duplicated');registry.set(idKey,Object.freeze({...entry}))}return registry}
function resolveExpected(registry,evidence){const expected=registry?.get(`${evidence.network}:${evidence.genesisHash}:${evidence.programId}:${evidence.session}`);if(!expected)throw new RangeError('scenario registry identity not found');return expected}
function validate(evidence,expected,now){closed(evidence,EVIDENCE_FIELDS,'evidence');closed(expected,EXPECTED_FIELDS,'expected');
 if(evidence.schemaVersion!=='scenario-capsule-evidence/v1'||evidence.network!=='devnet'||evidence.genesisHash!==GENESIS||expected.network!=='devnet'||expected.genesisHash!==GENESIS||evidence.commitment!=='finalized'||evidence.decoderVersion!=='scenario-capsule/v1')throw new TypeError('scenario capsule evidence contract is invalid');
 for(const name of ['programId','session','authority']){key(evidence[name],`evidence.${name}`);key(expected[name],`expected.${name}`);if(evidence[name]!==expected[name])throw new RangeError(`evidence ${name} mismatch`)}
 id(evidence.evidenceRef,'evidence.evidenceRef',256);id(expected.targetId,'expected.targetId');id(expected.ruleId,'expected.ruleId');id(expected.bindingId,'expected.bindingId');
 if(!HEX64.test(evidence.sessionId)||evidence.sessionId!==expected.sessionId)throw new RangeError('evidence sessionId mismatch');
 if(![0,4].includes(evidence.flags))throw new TypeError('evidence.flags is invalid');
 if(typeof evidence.sequence!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(evidence.sequence)||BigInt(evidence.sequence)>0xffffffffffffffffn)throw new TypeError('evidence.sequence is invalid');
 if(!Number.isSafeInteger(evidence.finalizedSlot)||evidence.finalizedSlot<0)throw new TypeError('evidence.finalizedSlot is invalid');
 time(evidence.observedAt,'evidence.observedAt');if(Date.parse(evidence.observedAt)>now.valueOf())throw new RangeError('evidence observedAt is in the future');
 for(const name of ['policyRevision','ruleVersion'])if(!Number.isSafeInteger(expected[name])||expected[name]<1)throw new TypeError(`expected.${name} is invalid`);
 return evidence;
}
export function recordScenarioCapsuleObservation(db,{evidence},registry,now=new Date()){if(!(now instanceof Date)||!Number.isFinite(now.valueOf()))throw new TypeError('now is invalid');const expected=resolveExpected(registry,evidence);validate(evidence,expected,now);const payloadHash=hash(evidence);const receipt={receiptId:`scenario:${payloadHash.slice(0,48)}`,idempotencyKey:`scenario:${evidence.evidenceRef}`,policyRevision:expected.policyRevision,ruleId:expected.ruleId,ruleVersion:expected.ruleVersion,bindingId:expected.bindingId,targetId:expected.targetId,evidenceRefs:[evidence.evidenceRef],evaluatorVersion:evidence.decoderVersion,result:evidence.flags===4?'fail':'pass',evaluatedAt:now.toISOString(),observedAt:evidence.observedAt,provenance:{sourceId:'scenario-capsule-devnet',schemaVersion:evidence.schemaVersion,producerVersion:evidence.decoderVersion,programId:evidence.programId,session:evidence.session,finalizedSlot:evidence.finalizedSlot,sequence:evidence.sequence}};
 db.exec('BEGIN IMMEDIATE');try{const existing=db.prepare('SELECT payload_hash FROM scenario_capsule_observations WHERE evidence_ref=?').get(evidence.evidenceRef);if(existing){if(existing.payload_hash!==payloadHash)throw new Error('observation_conflict');db.exec('COMMIT');return{inserted:false,evidenceRef:evidence.evidenceRef,receipt}}
 db.prepare('INSERT INTO scenario_capsule_observations (evidence_ref,payload_hash,network,program_id,session_address,authority,session_id,flags,sequence,finalized_slot,observed_at,evidence_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(evidence.evidenceRef,payloadHash,evidence.network,evidence.programId,evidence.session,evidence.authority,evidence.sessionId,evidence.flags,evidence.sequence,evidence.finalizedSlot,evidence.observedAt,canonical(evidence),now.toISOString());recordEvaluationReceipt(db,receipt,now);db.exec('COMMIT');return{inserted:true,evidenceRef:evidence.evidenceRef,receipt};}catch(error){db.exec('ROLLBACK');throw error}}

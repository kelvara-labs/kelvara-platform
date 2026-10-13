import { validateGovernanceControl } from './governance-control-v1.js';

const BASELINE_FIELDS=new Set(['schemaVersion','network','subjectAddress','acknowledgedAt','facts']);
const FACT_FIELDS=new Set(['programId','multisigAddress','vaultAuthority','threshold','memberCount','timeLockSeconds']);
const AVAILABILITY=new Set(['healthy','unavailable','not_monitored']);
const NETWORKS=new Set(['mainnet-beta','devnet','testnet','localnet']);
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UTC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FACT_NAMES=['programId','multisigAddress','vaultAuthority','threshold','memberCount','timeLockSeconds'];
function object(v,n){if(!v||typeof v!=='object'||Array.isArray(v))throw new TypeError(`${n} must be an object`)}
function exact(v,allowed,n){for(const k of Object.keys(v))if(!allowed.has(k))throw new TypeError(`${n} unknown field: ${k}`);for(const k of allowed)if(!Object.hasOwn(v,k))throw new TypeError(`${n} missing field: ${k}`)}
function address(v,n){if(typeof v!=='string'||!ADDRESS.test(v))throw new TypeError(`${n} is invalid`)}
function timestamp(v,n){if(typeof v!=='string'||!UTC.test(v)||new Date(v).toISOString()!==v)throw new TypeError(`${n} is invalid`)}
function nullableAddress(v,n){if(v!==null)address(v,n)}
function nullableInteger(v,n,max=Number.MAX_SAFE_INTEGER){if(v!==null&&(!Number.isSafeInteger(v)||v<0||v>max))throw new TypeError(`${n} is invalid`)}
function validateBaseline(input){object(input,'baseline');exact(input,BASELINE_FIELDS,'baseline');if(input.schemaVersion!=='control-baseline/v1'||!NETWORKS.has(input.network))throw new TypeError('baseline schema or network is invalid');address(input.subjectAddress,'baseline subjectAddress');timestamp(input.acknowledgedAt,'baseline acknowledgedAt');object(input.facts,'baseline facts');exact(input.facts,FACT_FIELDS,'baseline facts');nullableAddress(input.facts.programId,'baseline programId');nullableAddress(input.facts.multisigAddress,'baseline multisigAddress');nullableAddress(input.facts.vaultAuthority,'baseline vaultAuthority');nullableInteger(input.facts.threshold,'baseline threshold',64);nullableInteger(input.facts.memberCount,'baseline memberCount',64);nullableInteger(input.facts.timeLockSeconds,'baseline timeLockSeconds',31_536_000);return structuredClone(input)}
function freeze(v){if(!v||typeof v!=='object'||Object.isFrozen(v))return v;Object.freeze(v);Object.values(v).forEach(freeze);return v}
function equal(a,b){return JSON.stringify(a)===JSON.stringify(b)}
function historical(expected,observed){if(expected===null)return'not_baselined';if(observed===null)return'unknown';return equal(expected,observed)?'unchanged':'changed'}
function aggregate(facts,key){const values=Object.values(facts).map(f=>f[key]);if(values.includes('changed'))return'changed';if(values.includes('unknown'))return'unknown';if(values.includes('unchanged'))return'unchanged';return'not_baselined'}

export function projectControlMap({baseline,evidence,latestEvidenceStatus=evidence?.status,availability='healthy',freshnessMs,now=new Date()}){
 const expected=validateBaseline(baseline);if(!AVAILABILITY.has(availability)||!['verified','unsupported','invalid'].includes(latestEvidenceStatus))throw new TypeError('availability or latest evidence status is invalid');if(!Number.isSafeInteger(freshnessMs)||freshnessMs<1||freshnessMs>86_400_000)throw new TypeError('freshnessMs is invalid');if(!(now instanceof Date)||!Number.isFinite(now.valueOf()))throw new TypeError('now is invalid');
 const observed=validateGovernanceControl(evidence,{now});if(expected.network!==observed.network)throw new RangeError('network mismatch');if(expected.subjectAddress!==observed.subjectAddress)throw new RangeError('subject mismatch');
 const age=now.valueOf()-Date.parse(observed.observedAt);const derivedAvailability=availability==='healthy'?(age>freshnessMs?'stale':'healthy'):availability;const known=derivedAvailability==='healthy'&&latestEvidenceStatus==='verified'&&observed.status==='verified';
 const observedFacts={programId:observed.programId,multisigAddress:observed.multisigAddress,vaultAuthority:observed.authorityAddress,threshold:observed.threshold,memberCount:observed.status==='verified'?observed.members.length:null,timeLockSeconds:observed.timeLockSeconds};
 const facts={};for(const name of FACT_NAMES){const baselineValue=structuredClone(expected.facts[name]),last=structuredClone(observedFacts[name]);facts[name]={baseline:{value:baselineValue,acknowledgedAt:expected.acknowledgedAt},lastVerified:{value:last,slot:observed.slot,observedAt:observed.observedAt},current:{state:known?'known':'unknown',value:known?structuredClone(last):null},historicalComparison:historical(baselineValue,last),currentComparison:known?historical(baselineValue,last):'unknown'}}
 const output={schemaVersion:'control-map/v1',network:observed.network,subjectAddress:observed.subjectAddress,monitoring:{availability:derivedAvailability,evidenceStatus:latestEvidenceStatus,currentState:known?'known':'unknown'},baselineComparison:aggregate(facts,'historicalComparison'),currentComparison:aggregate(facts,'currentComparison'),facts,provenance:{slot:observed.slot,observedAt:observed.observedAt,accountHash:observed.accountHash,decoderFamily:observed.decoderFamily,decoderVersion:observed.decoderVersion,artifactHash:observed.artifactHash}};
 return freeze(output);
}

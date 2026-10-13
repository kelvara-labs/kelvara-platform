const NETWORKS=new Set(['mainnet-beta','devnet','testnet','localnet']);
const ACTIVE=new Set(['proposed','active']);
const ATTENTION=new Set(['approved','timelocked','executable']);
const RECENT=new Set(['executed','rejected','cancelled','closed']);
const string=(v,n)=>{if(typeof v!=='string'||!v)throw new TypeError(`${n} invalid`)};
function validateBinding(binding,network){if(!binding||typeof binding!=='object'||Array.isArray(binding))throw new TypeError('binding invalid');for(const key of ['bindingId','positionId','targetId','subjectAddress','provider','generation','programId','multisigAddress','vaultAddress','baselineId'])string(binding[key],key);if(!Number.isSafeInteger(binding.baselineRevision)||binding.baselineRevision<1||network===undefined)throw new TypeError('binding invalid')}
function item(actionId,current,direct){return{actionId,state:current?.state??'unreconstructable',current:current?structuredClone(current):null,history:direct.map(value=>structuredClone(value))}}
function controlFor(db,network,binding){
 const row=db.prepare(`SELECT canonical_json,finalized_slot,observed_at FROM governance_control_observations WHERE network=? AND subject_address=? AND program_id=? AND multisig_address=? ORDER BY finalized_slot DESC,observation_id DESC LIMIT 1`).get(network,binding.subjectAddress,binding.programId,binding.multisigAddress);
 if(!row)return{availability:'unavailable',currentState:'unknown',observedAt:null,finalizedSlot:null,threshold:null,memberCount:null,timeLockSeconds:null,members:[]};
 const evidence=JSON.parse(row.canonical_json);
 if(evidence.network!==network||evidence.subjectAddress!==binding.subjectAddress||evidence.programId!==binding.programId||evidence.multisigAddress!==binding.multisigAddress||evidence.authorityAddress!==binding.vaultAddress||evidence.provider!==binding.provider||evidence.generation!==binding.generation||evidence.status!=='verified')return{availability:'unavailable',currentState:'unknown',observedAt:row.observed_at,finalizedSlot:row.finalized_slot,threshold:null,memberCount:null,timeLockSeconds:null,members:[]};
 return{availability:'healthy',currentState:'known',observedAt:row.observed_at,finalizedSlot:row.finalized_slot,threshold:evidence.threshold,memberCount:evidence.members.length,timeLockSeconds:evidence.timeLockSeconds,members:structuredClone(evidence.members)};
}
export function readGovernanceActions(db,{network,wallet,bindings,completedLimit=10}={}){
 if(!NETWORKS.has(network))throw new TypeError('network invalid');string(wallet,'wallet');if(!Array.isArray(bindings))throw new TypeError('bindings invalid');if(!Number.isSafeInteger(completedLimit)||completedLimit<10||completedLimit>50)throw new RangeError('completedLimit invalid');bindings.forEach(binding=>validateBinding(binding,network));
 if(bindings.length===0)return{schemaVersion:'wallet-governance-actions/v1',network,wallet,state:'not_configured',vaults:[]};
 const vaults=[];
 for(const binding of bindings){
  const rows=db.prepare(`SELECT a.action_id,o.observation_id,o.observed_slot,o.canonical_json FROM governance_actions a JOIN governance_action_observations o ON o.action_id=a.action_id WHERE a.network=? AND a.program_id=? AND a.multisig_address=? AND a.vault_address=? ORDER BY a.action_id,o.observed_slot,o.observation_id`).all(network,binding.programId,binding.multisigAddress,binding.vaultAddress);
  const grouped=new Map();
  for(const row of rows){const evidence=JSON.parse(row.canonical_json);if(evidence.network!==network||evidence.provider!==binding.provider||evidence.generation!==binding.generation||evidence.programId!==binding.programId||evidence.multisigAddress!==binding.multisigAddress||evidence.vaultAddress!==binding.vaultAddress||evidence.actionId!==row.action_id)continue;const group=grouped.get(row.action_id)??{direct:[],derived:[]};(evidence.evidenceBasis==='direct_event'?group.direct:group.derived).push(evidence);grouped.set(row.action_id,group)}
  const sections={needsAttention:[],active:[],recent:[],unreconstructable:[]};
  for(const [actionId,group] of grouped){const current=group.derived.at(-1)??null,value=item(actionId,current,group.direct);if(!current)sections.unreconstructable.push(value);else if(ATTENTION.has(current.state))sections.needsAttention.push(value);else if(ACTIVE.has(current.state))sections.active.push(value);else if(RECENT.has(current.state))sections.recent.push(value);else sections.unreconstructable.push(value)}
  const newest=(a,b)=>(b.current?.observedSlot??b.history.at(-1)?.observedSlot??-1)-(a.current?.observedSlot??a.history.at(-1)?.observedSlot??-1)||a.actionId.localeCompare(b.actionId);for(const values of Object.values(sections))values.sort(newest);sections.recent=sections.recent.slice(0,completedLimit);
  vaults.push({binding:structuredClone(binding),control:controlFor(db,network,binding),...sections});
 }
 return{schemaVersion:'wallet-governance-actions/v1',network,wallet,vaults};
}

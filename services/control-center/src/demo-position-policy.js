const BASE58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ID=/^[A-Za-z0-9._:-]{1,128}$/;
function valid(input){return input&&ID.test(input.targetId)&&BASE58.test(input.position)&&input.targetId===`solana:devnet:kelvara-demo:position:${input.position}`&&input.ruleId==='scenario.authority-unchanged'&&ID.test(input.bindingId)&&BASE58.test(input.approvedAuthority)&&BASE58.test(input.session)&&BASE58.test(input.programId)}
export function ensureDemoPositionPolicy(store,input){
 if(!store||!valid(input))throw new TypeError('demo_position_policy_invalid');
 const active=store.getActiveSnapshot();
 const existingTarget=active?.snapshot.targets.find(target=>target.id===input.targetId);
 if(existingTarget){
  const protocol=active.snapshot.protocols.find(item=>item.id==='kelvara-demo'),binding=active.snapshot.bindings.find(item=>item.id===input.bindingId),version=active.snapshot.ruleVersions.find(item=>item.ruleId===input.ruleId&&item.version===1);
  const parameters=version?.parameters;
  if(!protocol||protocol.discoveryAdapterId!=='kelvara-demo-position'||protocol.discoveryAdapterVersion!==1||existingTarget.address!==input.position||binding?.targetId!==input.targetId||binding.ruleId!==input.ruleId||parameters?.approvedAuthority!==input.approvedAuthority||parameters?.session!==input.session||parameters?.programId!==input.programId||parameters?.maximumAgeMs!==30000)throw new Error('demo_position_policy_conflict');
  return{created:false,targetId:input.targetId,policyRevision:active.revision};
 }
 if(store.getTarget(input.targetId)||store.listBindings().some(binding=>binding.id===input.bindingId))throw new Error('demo_position_policy_conflict');
 const actorId='control-plane',reason='bootstrap verified Devnet DemoPosition policy';
 const previousTargets=active?.snapshot.targets.filter(target=>target.protocolId==='kelvara-demo'&&target.status==='active')??[];
 const previousBindings=active?.snapshot.bindings.filter(binding=>previousTargets.some(target=>target.id===binding.targetId)&&binding.status==='active')??[];
 const protocol=store.getProtocol('kelvara-demo');
 if(!protocol)store.createProtocol({id:'kelvara-demo',name:'Kelvara Demo Protection Vault',chain:'solana',discoveryAdapterId:'kelvara-demo-position',discoveryAdapterVersion:1,actorId,reason});
 else if(protocol.discoveryAdapterId!=='kelvara-demo-position'||protocol.discoveryAdapterVersion!==1||protocol.status!=='active')throw new Error('demo_position_policy_conflict');
 store.createTarget({id:input.targetId,protocolId:'kelvara-demo',kind:'position',address:input.position,name:'USDfun protected position',network:'devnet',actorId,reason});
 if(!active?.snapshot.rules.some(rule=>rule.id===input.ruleId))store.createRuleDefinition({id:input.ruleId,name:'Control authority matches approved authority',evaluatorType:'authority-match',actorId,reason});
 const versions=active?.snapshot.ruleVersions.filter(version=>version.ruleId===input.ruleId)??[];
 const ruleVersion=Math.max(0,...versions.map(version=>version.version))+1;
 store.createRuleVersion({ruleId:input.ruleId,version:ruleVersion,evaluatorVersion:'scenario-capsule-v1',parameters:{approvedAuthority:input.approvedAuthority,session:input.session,programId:input.programId,maximumAgeMs:30000},evidenceSchema:'scenario-capsule/v1',actorId,reason});
 store.createBinding({id:input.bindingId,ruleId:input.ruleId,ruleVersion,targetId:input.targetId,actorId,reason});
 const protocolIds=[...new Set([...(active?.snapshot.protocols.map(item=>item.id)??[]),'kelvara-demo'])],targetIds=[...(active?.snapshot.targets.filter(target=>!previousTargets.some(previous=>previous.id===target.id)).map(target=>target.id)??[]),input.targetId],bindingIds=[...(active?.snapshot.bindings.filter(binding=>!previousBindings.some(previous=>previous.id===binding.id)).map(binding=>binding.id)??[]),input.bindingId];
 const activation={draftManifest:{protocolIds,targetIds,bindingIds},actorId,reason};
 const result=previousTargets.length?store.activateDraftReplacing({...activation,retiredTargetIds:previousTargets.map(target=>target.id),retiredBindingIds:previousBindings.map(binding=>binding.id)}):store.activateDraft(activation);
 return{created:true,targetId:input.targetId,policyRevision:result.revision};
}
export function parseDemoPositionPolicy(value){if(!value)return null;let input;try{input=JSON.parse(value)}catch{throw new TypeError('DEMO_POSITION_POLICY_JSON invalid')}if(!valid(input))throw new TypeError('DEMO_POSITION_POLICY_JSON invalid');return input}

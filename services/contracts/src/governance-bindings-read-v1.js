const KEYS=new Set(['schemaVersion','network','wallet','state','bindings']);
const BINDING_KEYS=new Set(['bindingId','positionId','targetId','subjectAddress','provider','generation','programId','multisigAddress','vaultAddress','baselineId','baselineRevision']);
const string=(value,name)=>{if(typeof value!=='string'||!value)throw new TypeError(`${name} invalid`)};
export function validateGovernanceBindingsRead(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!KEYS.has(key)))throw new TypeError('governance bindings read invalid');
  if(value.schemaVersion!=='governance-bindings-read/v1')throw new TypeError('schemaVersion invalid');
  string(value.network,'network');string(value.wallet,'wallet');
  if(!Array.isArray(value.bindings))throw new TypeError('bindings invalid');
  if(value.bindings.length===0&&value.state!=='not_configured')throw new TypeError('empty bindings state invalid');
  if(value.bindings.length>0&&Object.hasOwn(value,'state'))throw new TypeError('configured state invalid');
  const ids=new Set();
  for(const binding of value.bindings){
    if(!binding||typeof binding!=='object'||Array.isArray(binding)||Object.keys(binding).some(key=>!BINDING_KEYS.has(key))||[...BINDING_KEYS].some(key=>!Object.hasOwn(binding,key)))throw new TypeError('binding invalid');
    for(const key of BINDING_KEYS)if(key!=='baselineRevision')string(binding[key],key);
    if(!Number.isSafeInteger(binding.baselineRevision)||binding.baselineRevision<1)throw new TypeError('baselineRevision invalid');
    if(ids.has(binding.bindingId))throw new TypeError('bindingId duplicate');ids.add(binding.bindingId);
  }
  return value;
}

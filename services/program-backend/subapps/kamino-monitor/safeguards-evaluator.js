const RULES=Object.freeze([
 ['governance','admin_authority_changed','Admin or vault authority changed','vaultAdminAuthority'],
 ['governance','unknown_multisig_signer','Unknown multisig signer added',null],
 ['governance','multisig_threshold_reduced','Multisig threshold reduced',null],
 ['governance','emergency_authority_changed','Emergency authority changed',null],
 ['upgrades','upgrade_authority_changed','Upgrade authority changed',null],
 ['upgrades','upgrade_approved','Upgrade approved or scheduled',null],
 ['upgrades','upgrade_executed','Upgrade executed',null],
 ['withdrawal','withdrawals_restricted','Withdrawals disabled or restricted',null],
 ['withdrawal','vault_authority_changed','Vault or custody authority changed','baseVaultAuthority'],
 ['oracle','oracle_changed','Oracle changed',null],
 ['oracle','underlying_mint_changed','Underlying mint changed','underlyingMint']
]);

function result({wallet,facts,group,ruleId,label,status,severity,reason,expected,observed}){return Object.freeze({id:`${facts.positionId}:${ruleId}`,wallet,positionId:facts.positionId,group,ruleId,label,scope:'baseline',supported:true,configured:true,status,currentStatus:status,severity,observedAt:facts.observedAt,source:facts.source||'kamino-indexer',...(facts.slot!=null?{slot:facts.slot}:{}),...(facts.asset?{asset:facts.asset}:{}),...(facts.evidenceRef?{evidenceRef:facts.evidenceRef}:{}),...(facts.decoderVersion?{decoderVersion:facts.decoderVersion}:{}),...(expected!==undefined?{expected}:{}),...(observed!==undefined?{observed}:{}),...(reason?{reason}:{})});}
function categorical(wallet,facts,baseline,[group,ruleId,label,field]){const expected=baseline[field];if(typeof facts[field]!=='string'||!facts[field])return result({wallet,facts,group,ruleId,label,status:'unknown',severity:'warning',reason:'configured evidence unavailable',expected,observed:null});const observed=facts[field],breached=observed!==expected;return result({wallet,facts,group,ruleId,label,status:breached?'breached':'intact',severity:breached?'critical':'safe',expected,observed});}

export function evaluateBaselineSafeguards({wallet,facts,baseline={},now=Date.now(),maximumAgeMs=60_000}={}){
 if(typeof wallet!=='string'||!wallet||!facts||typeof facts!=='object'||typeof facts.positionId!=='string')throw new TypeError('wallet and normalized facts are required');
 const evaluations=RULES.filter(([, , ,field])=>field&&typeof baseline[field]==='string'&&baseline[field]).map(rule=>categorical(wallet,facts,baseline,rule));
 const observed=Date.parse(facts.observedAt),fresh=Number.isFinite(observed)&&Number.isFinite(now)&&now>=observed&&now-observed<=maximumAgeMs;
 evaluations.push(result({wallet,facts,group:'evidence',ruleId:'observation_stale',label:'Observation stale',status:fresh?'intact':'breached',severity:fresh?'safe':'critical'}));
 const healthy=facts.indexerStatus==='healthy'&&facts.decoderStatus==='decoded';
 const known=['healthy','error'].includes(facts.indexerStatus)&&['decoded','error'].includes(facts.decoderStatus);
 evaluations.push(result({wallet,facts,group:'evidence',ruleId:'decoder_indexer_failure',label:'Decoder or indexer failure',status:!known?'unknown':healthy?'intact':'breached',severity:!known?'warning':healthy?'safe':'critical'}));
 return Object.freeze(evaluations);
}

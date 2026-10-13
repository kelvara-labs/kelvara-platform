import {decodeFinalizedSquadsInstructions} from './finalized-instruction-decoder.js';

function exactBinding(input,{expectedSubjectId,expectedNetwork,expectedProgramId}){
 if(Array.isArray(input))throw new Error('ambiguous authorized binding');
 if(!input||typeof input!=='object')throw new Error('authorized binding required');
 if(input.subjectId!==expectedSubjectId||input.network!==expectedNetwork)throw new Error('authorized binding network or subject mismatch');
 if(input.programId!==expectedProgramId)throw new Error('authorized binding program mismatch');
 for(const field of ['subjectAddress','vaultAddress','multisigAddress','creator'])if(typeof input[field]!=='string'||!input[field])throw new Error(`authorized binding ${field} missing`);
 if(!Number.isSafeInteger(input.transactionIndex)||input.transactionIndex<0||!Number.isSafeInteger(input.createdSlot)||input.createdSlot<0||!Number.isSafeInteger(input.threshold)||input.threshold<1)throw new Error('authorized binding is malformed');
 return input;
}

export function discoverFinalizedProposal(tx,{authorizedBinding,expectedSubjectId,expectedNetwork,expectedProgramId,artifactHash,deriveVaultAddress}){
 const binding=exactBinding(authorizedBinding,{expectedSubjectId,expectedNetwork,expectedProgramId});
 if(typeof deriveVaultAddress!=='function')throw new TypeError('vault derivation authority required');
 const derivedVault=deriveVaultAddress({programId:expectedProgramId,multisigAddress:binding.multisigAddress,vaultIndex:binding.vaultIndex??0});
 if(derivedVault!==binding.vaultAddress)throw new Error('authorized binding vault mismatch');
 const events=decodeFinalizedSquadsInstructions(tx,{network:expectedNetwork,programId:expectedProgramId,artifactHash,resolveAction:({kind,accounts,decoded})=>{
  if(kind!=='proposal_create')return null;
  const args=decoded.args??decoded;
  if(accounts[0]!==binding.multisigAddress||accounts[2]!==binding.subjectAddress||Number(args.transactionIndex)!==binding.transactionIndex)throw new Error('authorized binding identity mismatch');
  return binding;
 }});
 return events.filter(event=>event.directEvent.kind==='proposal_create');
}

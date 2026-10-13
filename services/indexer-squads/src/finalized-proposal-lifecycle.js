import {decodeFinalizedSquadsInstructions} from './finalized-instruction-decoder.js';
import {reduceSquadsV4Lifecycle} from './lifecycle-reducer.js';

function validateBinding(binding,{expectedSubjectId,expectedNetwork,expectedProgramId,deriveVaultAddress}){
 if(!binding||Array.isArray(binding)||typeof binding!=='object')throw new Error('ambiguous authorized binding');
 if(binding.subjectId!==expectedSubjectId||binding.network!==expectedNetwork)throw new Error('authorized binding subject or network mismatch');
 if(binding.programId!==expectedProgramId)throw new Error('authorized binding program mismatch');
 if(typeof deriveVaultAddress!=='function')throw new TypeError('vault derivation authority required');
 if(deriveVaultAddress({programId:expectedProgramId,multisigAddress:binding.multisigAddress,vaultIndex:binding.vaultIndex??0})!==binding.vaultAddress)throw new Error('authorized binding vault mismatch');
 return binding;
}
function order(a,b){return a.slot-b.slot||String(a.transaction?.signatures?.[0]).localeCompare(String(b.transaction?.signatures?.[0]))}
export function reconstructFinalizedProposalLifecycle(options){
 const {transactions,authorizedBinding,expectedSubjectId,expectedNetwork,expectedProgramId,artifactHash,deriveVaultAddress,bootstrap,reducerFamily,reducerVersion,reducerArtifactHash,monitorFresh,finalizedHead}=options;
 const binding=validateBinding(authorizedBinding,{expectedSubjectId,expectedNetwork,expectedProgramId,deriveVaultAddress});
 if(!Array.isArray(transactions))throw new TypeError('transactions must be an array');
 const events=[];
 for(const tx of [...transactions].sort(order))events.push(...decodeFinalizedSquadsInstructions(tx,{network:expectedNetwork,programId:expectedProgramId,artifactHash,resolveAction:({accounts,decoded})=>{
  const args=decoded.args??decoded;
  if(accounts[0]!==binding.multisigAddress)throw new Error('authorized binding multisig mismatch');
  if(Number.isSafeInteger(Number(args.transactionIndex))&&Number(args.transactionIndex)!==binding.transactionIndex)throw new Error('authorized binding transaction mismatch');
  return binding;
 }}));
 const actionId=`governance-action:solana:${expectedNetwork}:squads:v4:${expectedProgramId}:${binding.multisigAddress}:${binding.vaultAddress}:${binding.actionType}:${binding.transactionIndex}`;
 const history=[];
 for(let i=1;i<=events.length;i++)history.push(reduceSquadsV4Lifecycle({bootstrap,events:events.slice(0,i),family:reducerFamily,version:reducerVersion,artifactHash:reducerArtifactHash}));
 const current=history.at(-1)??null;
 let currentStatus=current?.state??'unknown';
 if(finalizedHead!==undefined){if(!finalizedHead||!Number.isSafeInteger(finalizedHead.slot)||finalizedHead.slot<(current?.observedSlot??0)||typeof finalizedHead.observedAt!=='string'||!Number.isFinite(Date.parse(finalizedHead.observedAt)))throw new TypeError('invalid finalized head');if(currentStatus==='timelocked'&&current.executeAfter!==null&&Date.parse(finalizedHead.observedAt)>=Date.parse(current.executeAfter))currentStatus='executable'}
 return Object.freeze({actionId,currentStatus:monitorFresh?currentStatus:'unknown',current:monitorFresh?current:null,history:Object.freeze(history)});
}

import * as multisig from '@sqds/multisig';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
const commitment='finalized' as const;
export class SquadsDriver{
 constructor(readonly connection:Connection){}
 async bootstrap(ids:Keypair[],createKey:Keypair){
  const [multisigPda]=multisig.getMultisigPda({createKey:createKey.publicKey});
  const [programConfigPda]=multisig.getProgramConfigPda({});
  const cfg=await multisig.accounts.ProgramConfig.fromAccountAddress(this.connection,programConfigPda,commitment);
  const signature=await multisig.rpc.multisigCreateV2({connection:this.connection,treasury:cfg.treasury,createKey,creator:ids[0],multisigPda,configAuthority:null,threshold:3,members:ids.map(i=>({key:i.publicKey,permissions:{mask:7}})),timeLock:0,rentCollector:null,sendOptions:{preflightCommitment:commitment}});
  return {multisigPda,signature};
 }
 async inspectMultisig(address:PublicKey){const a=await multisig.accounts.Multisig.fromAccountAddress(this.connection,address,commitment);return {threshold:a.threshold,memberCount:a.members.length,transactionIndex:BigInt(a.transactionIndex.toString())}}
 async createThresholdChange(multisigPda:PublicKey,creator:Keypair,index:bigint){
  const create=await multisig.rpc.configTransactionCreate({connection:this.connection,feePayer:creator,multisigPda,transactionIndex:index,creator:creator.publicKey,actions:[{__kind:'ChangeThreshold',newThreshold:1}],sendOptions:{preflightCommitment:commitment}});
  const proposal=await multisig.rpc.proposalCreate({connection:this.connection,feePayer:creator,creator,multisigPda,transactionIndex:index,isDraft:true,sendOptions:{preflightCommitment:commitment}});
  const activate=await multisig.rpc.proposalActivate({connection:this.connection,feePayer:creator,member:creator,multisigPda,transactionIndex:index,sendOptions:{preflightCommitment:commitment}});
  return {create,proposal,activate};
 }
 async approve(multisigPda:PublicKey,index:bigint,member:Keypair){return multisig.rpc.proposalApprove({connection:this.connection,feePayer:member,member,multisigPda,transactionIndex:index,sendOptions:{preflightCommitment:commitment}})}
 async execute(multisigPda:PublicKey,index:bigint,member:Keypair){return multisig.rpc.configTransactionExecute({connection:this.connection,feePayer:member,multisigPda,transactionIndex:index,member,rentPayer:member,sendOptions:{preflightCommitment:commitment}})}
 async inspectGovernance(multisigPda:PublicKey,index:bigint){const [txPda]=multisig.getTransactionPda({multisigPda,index});const [proposalPda]=multisig.getProposalPda({multisigPda,transactionIndex:index});const tx=await multisig.accounts.ConfigTransaction.fromAccountAddress(this.connection,txPda,commitment);const p=await multisig.accounts.Proposal.fromAccountAddress(this.connection,proposalPda,commitment);const action=tx.actions.find(a=>a.__kind==='ChangeThreshold');if(!action||action.__kind!=='ChangeThreshold')throw new Error('Config transaction lacks ChangeThreshold');return {transactionPda:txPda,proposalPda,proposedThreshold:action.newThreshold,status:p.pretty().status,approvals:p.approved.map(x=>x.toBase58())}}
}

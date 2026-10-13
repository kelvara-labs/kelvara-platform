import {PublicKey,SystemProgram,Transaction,TransactionInstruction} from "@solana/web3.js";
import {TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from "@solana/spl-token";
import {deriveScenarioPdas,encodeInitializeSession,encodeDepositPosition,encodeTriggerScenarios,encodeResetSession,encodeArmProtection,encodeEvacuate,decodeDemoPosition,instructionDiscriminator} from "./scenario-capsule-codec.js";

const GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const RAW=100_000_000_000n;

export function createScenarioCapsuleChain({rpc,programId,mint,controllerAuthority,resolveSession}={}){
 const program=new PublicKey(programId),mintKey=new PublicKey(mint),authority=new PublicKey(controllerAuthority);
 async function devnet(){if(await rpc.getGenesisHash()!==GENESIS)throw new Error("devnet_genesis_mismatch")}
 async function identity(session,wallet){const info=await resolveSession(),expected=deriveScenarioPdas({programId,authority:authority.toBase58(),owner:wallet,sessionId:info.sessionId});return info.wallet===wallet&&info.session===session&&expected.session===session?expected:null}
 async function validPosition({session,wallet,programId:requested,mint:requestedMint,amount}){if(requested!==programId||requestedMint!==mint||amount!=="100000")return null;return identity(session,wallet)}
 async function validSession(session){const info=await resolveSession();return info.session===session&&info.authority===authority.toBase58()}
 async function prepared(ix,feePayer,extra={}){const latest=await rpc.getLatestBlockhash("confirmed"),tx=new Transaction({feePayer,recentBlockhash:latest.blockhash}).add(ix);return{transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString("base64"),lastValidBlockHeight:latest.lastValidBlockHeight,feePayer:feePayer.toBase58(),...extra}}
 return{
  getOrCreateSession:resolveSession,
  async prepareInitializeSession(){
   await devnet();const info=await resolveSession(),expected=deriveScenarioPdas({programId,authority:authority.toBase58(),owner:authority.toBase58(),sessionId:info.sessionId});
   if(info.session!==expected.session||info.authority!==authority.toBase58())throw new Error("invalid_demo_session_identity");
   const session=new PublicKey(expected.session),account=await rpc.getAccountInfo(session,"confirmed");
   if(account){if(!account.owner.equals(program))throw new Error("demo_session_owner_mismatch");const data=Buffer.from(account.data);if(data.length!==107||!data.subarray(0,8).equals(instructionDiscriminator("account:DemoSession"))||!new PublicKey(data.subarray(8,40)).equals(authority)||!data.subarray(40,72).equals(Buffer.from(info.sessionId)))throw new Error("demo_session_identity_mismatch");return{state:"exists",session:expected.session}}
   const ix=new TransactionInstruction({programId:program,keys:[{pubkey:session,isSigner:false,isWritable:true},{pubkey:authority,isSigner:true,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}],data:encodeInitializeSession(info.sessionId,300)});
   return{state:"prepared",session:expected.session,...await prepared(ix,authority)};
  },
  async prepareDeposit(input){
   await devnet();const expected=await validPosition(input);if(!expected)throw new Error("invalid_demo_activation_request");
   const owner=new PublicKey(input.wallet),position=new PublicKey(expected.position),ownerToken=getAssociatedTokenAddressSync(mintKey,owner),vaultToken=getAssociatedTokenAddressSync(mintKey,position,true),treasuryToken=getAssociatedTokenAddressSync(mintKey,authority);
   const deposit=new TransactionInstruction({programId:program,keys:[{pubkey:new PublicKey(input.session),isSigner:false,isWritable:false},{pubkey:position,isSigner:false,isWritable:true},{pubkey:owner,isSigner:true,isWritable:true},{pubkey:mintKey,isSigner:false,isWritable:false},{pubkey:ownerToken,isSigner:false,isWritable:true},{pubkey:vaultToken,isSigner:false,isWritable:true},{pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:ASSOCIATED_TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}],data:encodeDepositPosition(RAW)});
   const createTreasury=new TransactionInstruction({programId:ASSOCIATED_TOKEN_PROGRAM_ID,keys:[{pubkey:owner,isSigner:true,isWritable:true},{pubkey:treasuryToken,isSigner:false,isWritable:true},{pubkey:authority,isSigner:false,isWritable:false},{pubkey:mintKey,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false}],data:Buffer.alloc(0)});
   const arm=new TransactionInstruction({programId:program,keys:[{pubkey:new PublicKey(input.session),isSigner:false,isWritable:false},{pubkey:position,isSigner:false,isWritable:true},{pubkey:owner,isSigner:true,isWritable:false},{pubkey:mintKey,isSigner:false,isWritable:false},{pubkey:ownerToken,isSigner:false,isWritable:true},{pubkey:treasuryToken,isSigner:false,isWritable:true},{pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false}],data:encodeArmProtection()});
   const latest=await rpc.getLatestBlockhash("confirmed"),tx=new Transaction({feePayer:owner,recentBlockhash:latest.blockhash}).add(deposit,createTreasury,arm);return{transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString("base64"),lastValidBlockHeight:latest.lastValidBlockHeight,feePayer:owner.toBase58(),programId,mint,amount:"100000",position:expected.position,treasury:treasuryToken.toBase58()};
  },
  async inspectPosition(input){
   await devnet();const expected=await identity(input.session,input.wallet);if(!expected||input.programId!==programId||input.mint!==mint)throw new Error("invalid_demo_position_request");
   const account=await rpc.getAccountInfo(new PublicKey(expected.position),"confirmed");if(!account)return null;if(!account.owner.equals(program))throw new Error("demo_position_owner_mismatch");const decoded=decodeDemoPosition(account.data);if(decoded.session!==input.session||decoded.owner!==input.wallet||decoded.mint!==mint)throw new Error("demo_position_identity_mismatch");return{position:expected.position,...decoded};
  },
  async prepareAuthorityIncident({session}){
   await devnet();if(!await validSession(session))throw new Error("invalid_demo_session");
   const ix=new TransactionInstruction({programId:program,keys:[{pubkey:new PublicKey(session),isSigner:false,isWritable:true},{pubkey:authority,isSigner:true,isWritable:false}],data:encodeTriggerScenarios(4)});
   return prepared(ix,authority,{session,incident:"authority_changed"});
  },
  async prepareAuthorityReset({session}){
   await devnet();if(!await validSession(session))throw new Error("invalid_demo_session");
   const ix=new TransactionInstruction({programId:program,keys:[{pubkey:new PublicKey(session),isSigner:false,isWritable:true},{pubkey:authority,isSigner:true,isWritable:false}],data:encodeResetSession()});
   return prepared(ix,authority,{session,state:"baseline"});
  },
  async prepareEvacuation(input){
   await devnet();const expected=await validPosition(input);if(!expected)throw new Error("invalid_demo_evacuation_request");
   const owner=new PublicKey(input.wallet),position=new PublicKey(expected.position),vaultToken=getAssociatedTokenAddressSync(mintKey,position,true),ownerToken=getAssociatedTokenAddressSync(mintKey,owner);
   const ix=new TransactionInstruction({programId:program,keys:[{pubkey:new PublicKey(input.session),isSigner:false,isWritable:false},{pubkey:position,isSigner:false,isWritable:true},{pubkey:owner,isSigner:true,isWritable:false},{pubkey:mintKey,isSigner:false,isWritable:false},{pubkey:vaultToken,isSigner:false,isWritable:true},{pubkey:ownerToken,isSigner:false,isWritable:true},{pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false}],data:encodeEvacuate()});
   return prepared(ix,owner,{programId,mint,amount:"100000",position:expected.position,destination:ownerToken.toBase58()});
  }
 };
}

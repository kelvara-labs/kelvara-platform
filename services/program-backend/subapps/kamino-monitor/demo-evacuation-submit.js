import {Connection,PublicKey,Transaction} from '@solana/web3.js';
import {createHash} from 'node:crypto';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import bs58 from 'bs58';

export function createFileSubmissionJournal({runtimeDir}){
 const path=join(runtimeDir,'demo-evacuation-submissions.json');
 const read=async()=>{try{return JSON.parse(await readFile(path,'utf8'))}catch(error){if(error.code==='ENOENT')return {};throw error}};
 const atomic=async data=>{await mkdir(runtimeDir,{recursive:true});const tmp=`${path}.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify(data));await rename(tmp,path)};
 return {async load(signature){return (await read())[signature]||null},async record(entry){const data=await read();data[entry.signature]=entry;await atomic(data)},async finalize(signature){const data=await read();if(data[signature]){data[signature]={...data[signature],state:'finalized'};await atomic(data)}}};
}
import {encodeEvacuate,decodeDemoPosition} from './scenario-capsule-codec.js';
import {getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID} from '@solana/spl-token';
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const TOKEN_PROGRAM=TOKEN_PROGRAM_ID.toBase58();
const PREFIX='solana:devnet:kelvara-demo:position:';
const B58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const submissionLocks=new Map();
async function acquireSubmissionLock(key){
 const previous=submissionLocks.get(key);
 let release;
 const current=new Promise(resolve=>{release=resolve});
 submissionLocks.set(key,current);
 if(previous)await previous;
 return ()=>{if(submissionLocks.get(key)===current)submissionLocks.delete(key);release()};
}
export function createDemoEvacuationSubmit({rpc,programId,mint,position,session,wallet,journal={load:async()=>null,record:async()=>{},finalize:async()=>{}}}={}){
 if(![programId,mint,position,session,wallet].every(v=>typeof v==='string'&&B58.test(v)))throw new TypeError('demo_evacuation_config_invalid');
 const configuredWallet=wallet,expectedVault=getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(position),true).toBase58(),expectedDestination=getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(wallet)).toBase58();
 const fail=(code)=>{throw new Error(code)};
 return {async submit({wallet,targetId,signedTransaction,lastValidBlockHeight}={}){
  if(wallet!==configuredWallet||targetId!==`${PREFIX}${position}`||typeof signedTransaction!=='string'||!Number.isSafeInteger(lastValidBlockHeight))fail('demo_evacuation_scope_invalid');
  if(await rpc.getGenesisHash()!==GENESIS)fail('devnet_genesis_mismatch');
  const tx=Transaction.from(Buffer.from(signedTransaction,'base64')), w=new PublicKey(wallet);
  if(tx.feePayer?.equals(w)!==true||tx.signatures.length!==1||!tx.signatures[0].publicKey.equals(w)||!tx.signatures[0].signature||!tx.verifySignatures())fail('demo_evacuation_signature_invalid');
  if(tx.instructions.length!==1)fail('demo_evacuation_instruction_invalid');
  const ix=tx.instructions[0],keys=ix.keys.map(k=>k.pubkey.toBase58());
  if(ix.programId.toBase58()!==programId||!Buffer.from(ix.data).equals(encodeEvacuate())||keys.length!==7||keys[0]!==session||keys[1]!==position||keys[2]!==wallet||keys[3]!==mint||keys[4]!==expectedVault||keys[5]!==expectedDestination||keys[6]!==TOKEN_PROGRAM||ix.keys.some((key,index)=>key.isSigner!==(index===2)||key.isWritable!==(index===1||index===2||index===4||index===5)))fail('demo_evacuation_instruction_invalid');
  const raw=tx.serialize(),signature=bs58.encode(tx.signatures[0].signature),fingerprint=createHash('sha256').update(raw).digest('hex');
  const release=await acquireSubmissionLock(signature);
  try{
   if((await rpc.getBlockHeight())>lastValidBlockHeight)fail('demo_evacuation_transaction_expired');
   const observed=(await rpc.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
   if(observed)return {duplicatePrevented:true};
   if(await journal.load(signature))return {broadcast_pending:true};
   await journal.record({signature,fingerprint,target:targetId,wallet,state:'send_attempted'});
   try{return {signature:await rpc.sendRawTransaction(raw,{skipPreflight:false,maxRetries:0})}}catch{const status=(await rpc.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];if(status)return {signature};return {broadcast_pending:true};}
  }finally{release()}
 },async finalize({wallet,targetId,signature}={}){
  if(wallet!==configuredWallet||targetId!==`${PREFIX}${position}`||typeof signature!=='string')fail('demo_evacuation_scope_invalid');
  const status=await rpc.confirmTransaction({signature},'finalized');
  if(status?.value?.err)fail('demo_evacuation_transaction_failed');
  const observed=(await rpc.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
  if(!observed||observed.err||observed.confirmationStatus!=='finalized')fail('demo_evacuation_finality_unknown');
  if(!(await journal.load(signature)))fail('demo_evacuation_signature_unbound');
  await journal.finalize(signature);
  const account=await rpc.getAccountInfo(new PublicKey(position),'finalized');
  if(!account||!account.owner.equals(new PublicKey(programId)))fail('demo_evacuation_position_unavailable');
  const decoded=decodeDemoPosition(account.data);
  if(decoded.owner!==wallet||decoded.session!==session||decoded.mint!==mint||decoded.evacuated!==true)fail('demo_evacuation_position_not_evacuated');
  return {signature,confirmationStatus:'finalized',slot:observed.slot,position};
 }};
}
export function createDemoEvacuationSubmitRuntime({env=process.env,runtimeDir=env.KELVARA_RUNTIME_DIR||'.runtime'}={}){
 const target=env.DEMO_POSITION_TARGET_ID||'';if(!env.DEVNET_RPC_URL||!env.DEVNET_SCENARIO_PROGRAM_ID||!env.DEVNET_FUN_USD_MINT||!env.DEVNET_SCENARIO_SESSION||!target.startsWith(PREFIX))return null;
 if(!env.DEVNET_DEMO_WALLET)return null;
 return createDemoEvacuationSubmit({rpc:new Connection(env.DEVNET_RPC_URL,'finalized'),programId:env.DEVNET_SCENARIO_PROGRAM_ID,mint:env.DEVNET_FUN_USD_MINT,session:env.DEVNET_SCENARIO_SESSION,position:target.slice(PREFIX.length),wallet:env.DEVNET_DEMO_WALLET,journal:createFileSubmissionJournal({runtimeDir})});
}

import {Connection,PublicKey,Transaction} from '@solana/web3.js';
import {encodeArmProtection,encodeDepositPosition} from './scenario-capsule-codec.js';

const DEVNET_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const ATA_PROGRAM='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const RAW=100_000_000_000n;
const BASE58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function createDemoActivationSubmit({rpc,programId,mint,position}={}){
 if(!rpc||![programId,mint,position].every(value=>typeof value==='string'&&BASE58.test(value)))throw new TypeError('demo_activation_submit_config_invalid');
 return async({wallet,signedTransaction,position:requested,lastValidBlockHeight}={})=>{
  if(!BASE58.test(wallet)||requested!==position||typeof signedTransaction!=='string'||!signedTransaction||!Number.isSafeInteger(lastValidBlockHeight)||lastValidBlockHeight<1)throw new Error('demo_activation_submission_invalid');
  if(await rpc.getGenesisHash()!==DEVNET_GENESIS)throw new Error('devnet_genesis_mismatch');
  const tx=Transaction.from(Buffer.from(signedTransaction,'base64')),walletKey=new PublicKey(wallet);
  if(tx.feePayer?.toBase58()!==wallet||tx.signatures.length!==1||tx.signatures[0].publicKey.toBase58()!==wallet||!tx.signatures[0].signature||!tx.verifySignatures())throw new Error('demo_activation_signature_invalid');
  if(tx.instructions.length!==3)throw new Error('demo_activation_transaction_invalid');
  const [deposit,createTreasury,arm]=tx.instructions;
  if(deposit.programId.toBase58()!==programId||createTreasury.programId.toBase58()!==ATA_PROGRAM||arm.programId.toBase58()!==programId||!Buffer.from(deposit.data).equals(encodeDepositPosition(RAW))||!Buffer.from(arm.data).equals(encodeArmProtection()))throw new Error('demo_activation_transaction_invalid');
  const expected=[wallet,mint,position];for(const address of expected)if(![...deposit.keys,...arm.keys].some(key=>key.pubkey.toBase58()===address))throw new Error('demo_activation_transaction_invalid');
  if(!deposit.keys.some(key=>key.pubkey.equals(walletKey)&&key.isSigner)||!arm.keys.some(key=>key.pubkey.equals(walletKey)&&key.isSigner))throw new Error('demo_activation_transaction_invalid');
  const raw=tx.serialize(),signature=await rpc.sendRawTransaction(raw,{skipPreflight:false,maxRetries:0}),status=await rpc.confirmTransaction({signature,blockhash:tx.recentBlockhash,lastValidBlockHeight},'finalized');
  if(status.value.err)throw new Error('demo_activation_transaction_failed');
  const observed=(await rpc.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
  if(!observed||observed.err||observed.confirmationStatus!=='finalized')throw new Error('demo_activation_finality_unknown');
  return{signature,confirmationStatus:'finalized',slot:observed.slot,position};
 };
}

export function createDemoActivationSubmitRuntime({env=process.env}={}){
 const names=['DEVNET_RPC_URL','DEVNET_SCENARIO_PROGRAM_ID','DEVNET_FUN_USD_MINT','DEMO_POSITION_TARGET_ID'];
 if(names.some(name=>!env[name]))return null;
 const prefix='solana:devnet:kelvara-demo:position:',position=env.DEMO_POSITION_TARGET_ID.startsWith(prefix)?env.DEMO_POSITION_TARGET_ID.slice(prefix.length):'';
 return createDemoActivationSubmit({rpc:new Connection(env.DEVNET_RPC_URL,'finalized'),programId:env.DEVNET_SCENARIO_PROGRAM_ID,mint:env.DEVNET_FUN_USD_MINT,position});
}

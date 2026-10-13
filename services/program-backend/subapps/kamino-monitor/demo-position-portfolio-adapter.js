import {PublicKey} from '@solana/web3.js';
import {getAssociatedTokenAddressSync} from '@solana/spl-token';
import {decodeDemoPosition} from './scenario-capsule-codec.js';
import {validateSolanaAddress} from '../../src/domains/discovery/wallet.js';

const DEVNET_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
function targetFor(protocol,position){
 if(!protocol||!Array.isArray(protocol.targets)||!Array.isArray(protocol.targetIds))throw new Error('demo_position_targets_malformed');
 const id=`solana:devnet:kelvara-demo:position:${position}`;
 const target=protocol.targets.find(item=>item.id===id);
 if(!target||!protocol.targetIds.includes(id)||target.chain!=='solana'||target.network!=='devnet'||target.protocolId!=='kelvara-demo'||target.resourceType!=='position'||target.address!==position||typeof target.displayName!=='string'||!target.displayName)throw new Error('demo_position_targets_malformed');
 return target;
}
export function createDemoPositionPortfolioAdapter({rpc,programId,session,mint}={}){
 if(!rpc||!validateSolanaAddress(programId)||!validateSolanaAddress(session)||!validateSolanaAddress(mint))throw new TypeError('demo_position_config_invalid');
 const program=new PublicKey(programId),sessionKey=new PublicKey(session),mintKey=new PublicKey(mint);
 return Object.freeze({async discover(wallet,protocol={}){
  if(!validateSolanaAddress(wallet))throw new Error('demo_position_wallet_invalid');
  if(await rpc.getGenesisHash()!==DEVNET_GENESIS)throw new Error('demo_position_network_mismatch');
  const owner=new PublicKey(wallet),position=PublicKey.findProgramAddressSync([Buffer.from('position'),sessionKey.toBuffer(),owner.toBuffer()],program)[0],target=targetFor(protocol,position.toBase58());
  const account=await rpc.getAccountInfo(position,{commitment:'finalized'});
  if(!account)return{network:'devnet',wallet,positions:[]};
  if(account.owner.toBase58()!==programId)throw new Error('demo_position_chain_identity_mismatch');
  const decoded=decodeDemoPosition(account.data);
  if(decoded.session!==session||decoded.owner!==wallet||decoded.mint!==mint)throw new Error('demo_position_chain_identity_mismatch');
  const vault=getAssociatedTokenAddressSync(mintKey,position,true),balance=await rpc.getTokenAccountBalance(vault,{commitment:'finalized'});
  if(!balance?.value||balance.value.decimals!==6||balance.value.amount!==String(BigInt(decoded.amount)*1_000_000n))throw new Error('demo_position_vault_identity_mismatch');
  return{network:'devnet',wallet,positions:[{targetId:target.id,protocol:'kelvara-demo',adapterId:protocol.discoveryAdapterId||'kelvara-demo-position',adapterVersion:protocol.discoveryAdapterVersion??1,display:target.displayName,details:{positionAccount:position.toBase58(),session,mint,owner:wallet,vault:vault.toBase58(),balance:decoded.amount,programId,protected:decoded.protected,evacuated:decoded.evacuated,environment:'devnet'}}]};
 }});
}

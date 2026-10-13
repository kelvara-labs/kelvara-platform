import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { encodeBase58 } from "../../src/platform/solana/base58.js";

const AUTH_PREFIX="Kelvara wallet authentication";
export const SOLANA_NETWORKS=Object.freeze({
  "mainnet-beta": Object.freeze({genesisHash:"5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"}),
  devnet: Object.freeze({genesisHash:"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"}),
});

function parseDecimal(value,decimals){
 const match=String(value).match(/^(\d+)(?:\.(\d+))?$/);if(!match)throw new Error("invalid_share_amount");
 const fraction=match[2]||"";if(fraction.length>decimals)throw new Error("share_precision_exceeded");
 return BigInt(match[1])*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,"0")||"0");
}
function littleEndian(value,bytes){const out=Buffer.alloc(bytes);let n=value;for(let i=0;i<bytes;i++){out[i]=Number(n&255n);n>>=8n}if(n)throw new Error("amount_overflow");return out}
export function exactShareBytes(shares,decimals=6){const rawShares=parseDecimal(shares,decimals),farmScaled=rawShares*10n**18n;return{rawShares,farmScaled,vaultAmount:littleEndian(rawShares,8),farmAmount:littleEndian(farmScaled,16)}}

export function createWalletAuth({ttlMs=60*60_000,now=()=>Date.now()}={}){
 const challenges=new Map(),sessions=new Map();
 return{
  issue(wallet,network="mainnet-beta",demoMode=false){new PublicKey(wallet);const profile=SOLANA_NETWORKS[network];if(!profile||typeof demoMode!=="boolean"||demoMode&&network!=="devnet")throw new Error("invalid_network");const nonce=randomBytes(24).toString("base64url"),expiresAt=now()+ttlMs,message=`${AUTH_PREFIX}\nWallet: ${wallet}\nNetwork: ${network}\nMode: ${demoMode?"demo":"normal"}\nNonce: ${nonce}\nExpires: ${expiresAt}`;challenges.set(nonce,{wallet,message,expiresAt,network,genesisHash:profile.genesisHash,demoMode});return{message,expiresAt,network,genesisHash:profile.genesisHash,demoMode}},
  verify(wallet,message,signature){const nonce=/\nNonce: ([^\n]+)/.exec(message)?.[1],entry=nonce&&challenges.get(nonce);if(!entry||entry.wallet!==wallet||entry.message!==message||entry.expiresAt<now())throw new Error("invalid_or_expired_challenge");const ok=nacl.sign.detached.verify(Buffer.from(message),Buffer.from(signature,"base64"),new PublicKey(wallet).toBytes());if(!ok)throw new Error("invalid_wallet_signature");challenges.delete(nonce);const token=randomBytes(32).toString("base64url"),session={wallet,expiresAt:now()+ttlMs,network:entry.network,genesisHash:entry.genesisHash,demoMode:entry.demoMode};sessions.set(createHash("sha256").update(token).digest("hex"),session);return{token,...session}},
  authorize(token){return this.authorizeSession(token).wallet},
  authorizeSession(token){if(!token)throw new Error("authentication_required");const key=createHash("sha256").update(token).digest("hex"),session=sessions.get(key);if(!session||session.expiresAt<now())throw new Error("authentication_required");return {...session}}
 }
}

function normalizedKey(key){const value=Buffer.isBuffer(key)?key:Buffer.from(key,"base64");if(value.length!==32)throw new Error("protection_key_must_be_32_bytes");return value}
export function createProtectionStore({path,key}){const secret=normalizedKey(key);let queue=Promise.resolve();
 async function loadAll(){try{const envelope=JSON.parse(await readFile(path,"utf8")),iv=Buffer.from(envelope.iv,"base64"),tag=Buffer.from(envelope.tag,"base64"),ciphertext=Buffer.from(envelope.ciphertext,"base64"),decipher=createDecipheriv("aes-256-gcm",secret,iv);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString("utf8"))}catch(error){if(error.code==="ENOENT")return{};throw error}}
 async function persist(all){await mkdir(dirname(path),{recursive:true});const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",secret,iv),ciphertext=Buffer.concat([cipher.update(JSON.stringify(all)),cipher.final()]),envelope=JSON.stringify({v:1,iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),ciphertext:ciphertext.toString("base64")}),temp=`${path}.${process.pid}.tmp`;await writeFile(temp,envelope,{mode:0o600});await rename(temp,path)}
 return{async save(wallet,record,targetId){if(!targetId)throw new Error("target_id_required");const key=`${wallet}:mainnet-beta:${targetId}`;queue=queue.then(async()=>{const all=await loadAll();all[key]={...record,wallet,network:"mainnet-beta",targetId,updatedAt:new Date().toISOString()};await persist(all)});await queue;return this.get(wallet,targetId)},async get(wallet,targetId){if(!targetId)throw new Error("target_id_required");await queue;const all=await loadAll();return all[`${wallet}:mainnet-beta:${targetId}`]||null},async remove(wallet,targetId){if(!targetId)throw new Error("target_id_required");const key=`${wallet}:mainnet-beta:${targetId}`;queue=queue.then(async()=>{const all=await loadAll();delete all[key];await persist(all)});await queue}}
}

export async function runFeeLadder(record,{nonceCurrent,submit,status,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),attemptWaitMs=4000}){
 const variants=[...record.variants].sort((a,b)=>a.priorityMicroLamports-b.priorityMicroLamports),failed=new Set();
 async function reconcile(){for(const variant of variants){const state=await status(variant.signature);if(state?.err){failed.add(variant.signature);continue}if(["confirmed","finalized"].includes(state?.confirmationStatus))return{signature:variant.signature,status:state}}return null}
 const existing=await reconcile();if(existing)return existing;
 for(const variant of variants){
  if(failed.has(variant.signature))continue;
  const landed=await reconcile();if(landed)return landed;
  if(!await nonceCurrent(variant)){failed.add(variant.signature);continue}
  try{await submit(variant)}catch{
   const reconciled=await reconcile();if(reconciled)return reconciled;
   return{signature:variant.signature,status:null,pending:true,nonceCurrent:await nonceCurrent(variant)};
  }
  for(let i=0;i<2;i++){const result=await reconcile();if(result)return result;if(failed.has(variant.signature))break;await wait(attemptWaitMs)}
  return{signature:variant.signature,status:null,pending:true,nonceCurrent:await nonceCurrent(variant)};
 }
 throw new Error("No armed transaction confirmed. Inspect every signature and nonce before retrying.")
}

export function transactionSignature(transaction){return encodeBase58(transaction.signatures[0])}

import { readFile } from 'node:fs/promises';
import { Keypair } from '@solana/web3.js';
export const identityNames=['alice','bob','carol','dave','eve'] as const;
export type IdentityName=typeof identityNames[number];
export type IdentityPaths=Record<IdentityName,string>;
export type Identities=Record<IdentityName,Keypair>;
export async function loadIdentities(paths:IdentityPaths):Promise<Identities>{
 const out={} as Identities;
 for(const name of identityNames){
  let text:string; try{text=await readFile(paths[name],'utf8')}catch(e){throw new Error(`Identity ${name} unavailable at ${paths[name]}`,{cause:e})}
  const bytes=JSON.parse(text); if(!Array.isArray(bytes)||bytes.length!==64) throw new Error(`Identity ${name} must be a 64-byte Solana keypair JSON array`);
  out[name]=Keypair.fromSecretKey(Uint8Array.from(bytes));
 }
 return out;
}

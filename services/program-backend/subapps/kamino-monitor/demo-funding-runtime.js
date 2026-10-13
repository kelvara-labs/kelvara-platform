import { readFile,stat } from "node:fs/promises";
import { join } from "node:path";
import { Connection,Keypair,PublicKey,Transaction,sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync,getAccount,createAssociatedTokenAccountInstruction,createMintToInstruction,TokenAccountNotFoundError } from "@solana/spl-token";
import { createFunUsdSolanaAdapter } from "./fun-usd-solana-adapter.js";
import { createFunUsdChain } from "./fun-usd-chain.js";
import { createFunUsdTransfer } from "./fun-usd-transfer.js";
import { createDemoFundingService } from "./demo-funding.js";

async function load(path){const info=await stat(path);if((info.mode&0o077)!==0)throw new Error("demo_funding_authority_permissions");const bytes=JSON.parse(await readFile(path,"utf8"));return Keypair.fromSecretKey(Uint8Array.from(bytes))}
function sdk(){return{publicKey:value=>new PublicKey(value),deriveAta:(mint,owner)=>getAssociatedTokenAddressSync(mint,owner),getAccount,createAtaInstruction:createAssociatedTokenAccountInstruction,mintToInstruction:createMintToInstruction,async send(connection,instructions,signers,options){return sendAndConfirmTransaction(connection,new Transaction().add(...instructions),signers,options)},getGenesisHash:connection=>connection.getGenesisHash(),TokenAccountNotFoundError}}
export async function createDemoFundingRuntime({env=process.env,runtimeDir=env.KELVARA_RUNTIME_DIR||"var",readAuthority=load,makeConnection=url=>new Connection(url,"confirmed"),makeSdk=sdk,makeAdapter=createFunUsdSolanaAdapter,makeChain=createFunUsdChain,makeTransfer=createFunUsdTransfer,makeService=createDemoFundingService}={}){
 const values=[env.DEVNET_FUN_USD_MINT,env.DEVNET_FUN_USD_AUTHORITY_PATH,env.DEVNET_RPC_URL];if(values.every(value=>!value))return null;if(values.some(value=>!value))throw new Error("demo_funding_configuration_incomplete");const signer=await readAuthority(env.DEVNET_FUN_USD_AUTHORITY_PATH),publicKey=signer.publicKey.toBase58();if(env.DEVNET_FUN_USD_AUTHORITY_PUBKEY&&env.DEVNET_FUN_USD_AUTHORITY_PUBKEY!==publicKey)throw new Error("demo_funding_authority_mismatch");new PublicKey(env.DEVNET_FUN_USD_MINT);const authority={publicKey,signer},adapter=makeAdapter({connection:makeConnection(env.DEVNET_RPC_URL),authority,sdk:makeSdk()}),chain=makeChain({mint:env.DEVNET_FUN_USD_MINT,authority,deriveAta:adapter.deriveAta,rpc:adapter.rpc,sendTopUp:adapter.sendTopUp}),transfer=makeTransfer({chain,mint:env.DEVNET_FUN_USD_MINT});return makeService({path:join(runtimeDir,"demo-funding.sqlite"),transfer});
}

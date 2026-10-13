import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEVNET_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const AMOUNT="100000";
function result(state,row={}){return{state,amount:AMOUNT,symbol:"USDfun",network:"devnet",...(row.signature?{signature:row.signature}:{}),...(row.balance?{balance:row.balance}:{})}}
function valid(value){return value?.network==="devnet"&&value.genesisHash===DEVNET_GENESIS&&value.amount===AMOUNT&&typeof value.wallet==="string"&&value.wallet.length>=32&&typeof value.demoVersion==="string"&&value.demoVersion.length>0&&value.demoVersion.length<=64}

export function createDemoFundingService({path="var/demo-funding.sqlite",transfer}={}){
 if(typeof transfer!=="function")throw new TypeError("demo_funding_transfer_required");mkdirSync(dirname(path),{recursive:true});const db=new DatabaseSync(path);db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS demo_funding_grants(wallet TEXT NOT NULL,genesis_hash TEXT NOT NULL,demo_version TEXT NOT NULL,amount TEXT NOT NULL,state TEXT NOT NULL,signature TEXT,balance TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(wallet,genesis_hash,demo_version));`);
 const get=db.prepare("SELECT * FROM demo_funding_grants WHERE wallet=? AND genesis_hash=? AND demo_version=?"),save=db.prepare("INSERT INTO demo_funding_grants(wallet,genesis_hash,demo_version,amount,state,signature,balance,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(wallet,genesis_hash,demo_version) DO UPDATE SET amount=excluded.amount,state=excluded.state,signature=excluded.signature,balance=excluded.balance,updated_at=excluded.updated_at");
 return{async fund(input){if(!valid(input))throw new Error("invalid_demo_funding_request");const existing=get.get(input.wallet,input.genesisHash,input.demoVersion);if(existing?.state==="confirmed")return result("already_funded",existing);try{const receipt=await transfer(input);if(!receipt?.signature||receipt.balance!==AMOUNT)throw new Error("invalid_funding_receipt");save.run(input.wallet,input.genesisHash,input.demoVersion,AMOUNT,"confirmed",receipt.signature,receipt.balance,Date.now());return result("confirmed",receipt)}catch{save.run(input.wallet,input.genesisHash,input.demoVersion,AMOUNT,"failed_retryable",null,null,Date.now());return{...result("failed_retryable"),error:"funding_unavailable"}}},close(){db.close()}};
}

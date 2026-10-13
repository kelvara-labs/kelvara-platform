const DEVNET_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TARGET=100000n, SCALE=1000000n;
function valid(input){return input?.network==="devnet"&&input.genesisHash===DEVNET_GENESIS&&input.amount==="100000"&&input.demoVersion==="scenario-capsule-v1"&&typeof input.wallet==="string"}
function amount(value){if(typeof value!=="string"||!/^(0|[1-9]\d*)$/.test(value))throw new Error("invalid_funding_balance");return BigInt(value)}

export function createFunUsdTransfer({chain,mint}={}){
 if(!chain||typeof chain.inspect!=="function"||typeof chain.topUp!=="function"||typeof mint!=="string"||!mint)throw new TypeError("fun_usd_transfer_config_required");
 return async input=>{if(!valid(input))throw new Error("invalid_demo_funding_request");const current=await chain.inspect({wallet:input.wallet,mint});if(current?.mint!==mint)throw new Error("funding_mint_mismatch");const balance=amount(current.balance);if(balance>=TARGET)return{signature:`already-funded:${input.wallet.slice(0,8)}:${input.demoVersion}`,balance:"100000"};const receipt=await chain.topUp({wallet:input.wallet,mint,tokenAccount:current.tokenAccount,rawAmount:((TARGET-balance)*SCALE).toString()});if(!receipt?.signature||receipt.balance!=="100000")throw new Error("funding_postcondition_failed");return{signature:receipt.signature,balance:receipt.balance};};
}

#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { discoverWallet, ONRE_PROGRAM_ID, ONYC_MINT } from "../../domains/discovery/wallet.js";
import { buildOnreBaseline } from "../../domains/protocols/onre/baseline.js";
import { createSolanaRpc } from "../../platform/solana/rpc.js";
import { runDemo } from "./run.js";

const tokenPrograms = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];
const urls = [process.env.HELIUS_RPC_1, process.env.HELIUS_RPC_2, process.env.SOLANA_RPC_URL]
  .filter(Boolean)
  .filter((url, index, all) => all.indexOf(url) === index);
if (!urls.length) urls.push("https://api.mainnet-beta.solana.com");
const rpcs = urls.map((url, index) => createSolanaRpc(url, { name: `mainnet-${index + 1}` }));

let wallet = process.argv[2];
if (!wallet) {
  if (!input.isTTY) {
    console.error("Usage: npm run demo -- <public-wallet-address>");
    process.exitCode = 2;
  } else {
    const prompt = createInterface({ input, output });
    wallet = await prompt.question("Public Solana wallet address: ");
    prompt.close();
  }
}

if (wallet) {
  process.exitCode = await runDemo({
    wallet: wallet.trim(),
    discover: value => discoverWallet(value, { rpcs, tokenPrograms }),
    assure: () => buildOnreBaseline({ programId: ONRE_PROGRAM_ID, mint: ONYC_MINT, rpcs, observedAt: new Date().toISOString() }),
  });
}

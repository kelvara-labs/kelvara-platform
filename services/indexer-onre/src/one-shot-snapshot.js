import { createVaultSnapshot } from './snapshot.js';

const VAULT = 'BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5';
const PROGRAM = 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd';
const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const response = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [VAULT, { encoding: 'base64', commitment: 'finalized' }]
  }),
  signal: AbortSignal.timeout(15_000)
});
if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
const payload = await response.json();
if (payload.error) throw new Error(`RPC ${payload.error.code}: ${payload.error.message}`);
process.stdout.write(`${JSON.stringify(createVaultSnapshot({ address: VAULT, programId: PROGRAM, rpcResult: payload.result }), null, 2)}\n`);

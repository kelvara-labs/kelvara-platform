import path from 'node:path';
import type { IdentityPaths } from './identities.js';
export function config(){const need=(n:string)=>{const v=process.env[n];if(!v)throw new Error(`Missing ${n}`);return v};return {rpcUrl:need('SOLANA_RPC_URL'),runsDir:path.resolve('runs'),identityPaths:{alice:need('GOVLAB_ALICE_KEYPAIR'),bob:need('GOVLAB_BOB_KEYPAIR'),carol:need('GOVLAB_CAROL_KEYPAIR'),dave:need('GOVLAB_DAVE_KEYPAIR'),eve:need('GOVLAB_EVE_KEYPAIR')} satisfies IdentityPaths}}

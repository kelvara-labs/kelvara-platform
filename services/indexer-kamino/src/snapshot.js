import { createHash } from 'node:crypto';

import { decodeVaultAccount } from './decode-vault.js';

function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return value;
}

export function createVaultSnapshot({ address, programId, rpcResult }) {
  if (!rpcResult?.value) throw new Error('vault account missing from RPC response');
  const account = rpcResult.value;
  if (!Array.isArray(account.data) || account.data[1] !== 'base64') {
    throw new TypeError('vault account data must use base64 encoding');
  }
  const bytes = Buffer.from(account.data[0], 'base64');
  const state = decodeVaultAccount({ data: bytes, owner: account.owner }, programId);
  return {
    schemaVersion: 1,
    source: 'solana-rpc',
    commitment: 'finalized',
    target: address,
    slot: rpcResult.context.slot,
    accountHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    state: jsonSafe(state)
  };
}

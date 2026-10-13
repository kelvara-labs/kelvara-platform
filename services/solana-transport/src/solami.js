import Client, { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import { createHash } from 'node:crypto';

function accountObservation(update) {
  const payload = update?.account;
  const account = payload?.account;
  if (!account || payload.slot == null) return null;
  const address = Buffer.from(account.pubkey || []).toString('hex');
  const data = Buffer.from(account.data || []);
  const hash = createHash('sha256').update(data).digest('hex');
  return Object.freeze({
    kind: 'account', slot: Number(payload.slot), address,
    identity: `account:${address}:${payload.slot}:${hash}`,
    account: { data: [data.toString('base64'), 'base64'], executable: Boolean(account.executable), lamports: Number(account.lamports), owner: Buffer.from(account.owner || []).toString('hex'), rentEpoch: Number(account.rentEpoch) }
  });
}

function transactionObservation(update) {
  const payload = update?.transaction;
  const tx = payload?.transaction;
  if (!tx || payload.slot == null) return null;
  const signature = Buffer.from(tx.signature || []).toString('base64');
  return Object.freeze({ kind: 'transaction', slot: Number(payload.slot), signature, identity: `transaction:${signature}`, transaction: tx });
}

async function* stream(client, request, project) {
  await client.connect();
  const subscription = await client.subscribe(request);
  try {
    for await (const update of subscription) {
      const observation = project(update);
      if (observation) yield observation;
    }
  } finally { subscription.destroy(); }
}

export function createSolamiLiveAdapter({ endpoint, token, ClientImpl = Client } = {}) {
  if (!endpoint || !token) throw new TypeError('Solami endpoint and token are required');
  const client = new ClientImpl(endpoint, token, undefined, { backoff: { initialIntervalMs: 1_000, multiplier: 2, maxRetries: 12 } });
  const base = { slots: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [], commitment: CommitmentLevel.FINALIZED, ping: undefined, fromSlot: undefined };
  return Object.freeze({
    accounts({ addresses }) { return stream(client, { ...base, accounts: { kelvara: { account: addresses, owner: [], filters: [] } }, transactions: {} }, accountObservation); },
    transactions({ accounts = [] }) { return stream(client, { ...base, accounts: {}, transactions: { kelvara: { vote: false, failed: false, signature: undefined, accountInclude: accounts, accountExclude: [], accountRequired: [] } } }, transactionObservation); },
    async close() {}
  });
}

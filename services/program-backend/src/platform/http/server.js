import { resolve } from "node:path";
import { createApp } from "./app.js";
import { resolveServerConfig } from "./config.js";
import { inspectIndexer } from "../../domains/indexer/inspect.js";
import { discoverWallet } from "../../domains/discovery/wallet.js";
import { createSolanaRpc } from "../solana/rpc.js";
import { buildOnreBaseline } from "../../domains/protocols/onre/baseline.js";
import { ONYC_MINT, ONRE_PROGRAM_ID } from "../../domains/discovery/wallet.js";
import { createConsumerStore } from "../storage/consumer-store.js";
import { readDiskStats } from "../storage/disk-governor.js";
import { createOperationsService } from "../../domains/operations/status.js";
import { createOperationsObservationRecorder } from "../../domains/operations/observations.js";
import { createJsonStatusStore } from "../../domains/indexer/status-store.js";
import { createGovernanceClient } from "../../domains/governance/read-client.js";

const defaultSource = "/home/andy/kelvara-build/[codebase]/indexer_anchor_protocol/indexer.db";
const sourcePath = resolve(process.env.KELVARA_INDEXER_DB_PATH || defaultSource);
const { host, port, consumerDbPath, statusPath, maintenanceStatusPath, operationsToken } = resolveServerConfig();
const maxAgeSeconds = Number(process.env.INDEXER_MAX_AGE_SECONDS || 30);
const tokenPrograms = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];
const rpcUrls = [process.env.HELIUS_RPC_1, process.env.HELIUS_RPC_2, process.env.SOLANA_RPC_URL]
  .filter(Boolean)
  .filter((url, index, all) => all.indexOf(url) === index);
if (!rpcUrls.length) rpcUrls.push("https://api.mainnet-beta.solana.com");
const rpcs = rpcUrls.map((url, index) => createSolanaRpc(url, { name: `mainnet-${index + 1}` }));

async function getAssurance(wallet) {
  const discovery = await discoverWallet(wallet, { rpcs, tokenPrograms });
  const position = discovery.positions[0];
  if (!position) throw new Error("supported_position_not_found");
  const assurance = await buildOnreBaseline({
    programId: ONRE_PROGRAM_ID,
    mint: ONYC_MINT,
    rpcs,
    observedAt: new Date().toISOString(),
  });
  return { wallet, sourceStatus: discovery.sourceStatus, position, assurance };
}

const consumerStore = createConsumerStore({ path: consumerDbPath });
const ingestionStatus = createJsonStatusStore(statusPath);
const maintenanceStatus = createJsonStatusStore(maintenanceStatusPath);
const operations = createOperationsService({
  store: consumerStore,
  readIngestionStatus: () => ingestionStatus.read(),
  diskStats: () => readDiskStats(consumerDbPath),
  inspectIndexers: () => {
    const source = inspectIndexer(sourcePath, { maxAgeSeconds });
    return [{ id: "onre-mainnet", name: "ONRE Mainnet Indexer", protocol: "ONRE", network: "mainnet-beta", sourceType: "producer-sqlite", ...source }];
  },
  retention: () => maintenanceStatus.read(),
});
const recordOperationObservation = createOperationsObservationRecorder({ store: consumerStore });
const governanceToken = process.env.OBSERVATION_HUB_GOVERNANCE_TOKEN || '';
const getGovernance = process.env.OBSERVATION_HUB_URL && governanceToken
  ? createGovernanceClient({ baseUrl: process.env.OBSERVATION_HUB_URL, token: governanceToken })
  : null;
const app = createApp({
  inspectSource: () => inspectIndexer(sourcePath, { maxAgeSeconds }),
  getGovernance,
  governanceToken,
  discoverWallet: wallet => discoverWallet(wallet, { rpcs, tokenPrograms }),
  getAssurance,
  getOperationsStatus: () => operations.getStatus(),
  getOperationTargets: () => operations.getTargets(),
  getOperationIndexers: () => operations.getIndexers(),
  getOperationHistory: options => operations.getHistory(options),
  getOperationSettings: () => operations.getSettings(),
  updateOperationSettings: value => operations.updateSettings(value),
  getOperationClients: () => operations.getClients(),
  getOperationClient: walletId => operations.getClient(walletId),
  getOperationWallets: () => operations.getWallets(),
  getOperationWallet: walletId => operations.getWallet(walletId),
  recordOperationObservation,
  operationsToken,
});
app.listen(port, host, () => {
  console.log(`kelvara-onre listening on http://${host}:${port}; RPC providers=${rpcs.length}`);
});
function shutdown() { consumerStore.close(); app.close(() => process.exit(0)); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

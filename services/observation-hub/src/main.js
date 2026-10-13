import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadBackendConfig } from './config.js';
import { createOperationsDatabase } from './database.js';
import { createBackendServer } from './server.js';
import { createControlPlaneWalletSafeguardResolver } from './control-plane-wallet-safeguard-client.js';
import { createGovernanceReadOwnership } from './governance-ownership.js';
import { createScenarioCapsuleRegistry } from './scenario-capsule-observations.js';

const config = loadBackendConfig();
mkdirSync(dirname(config.databasePath), { recursive: true });
const db = createOperationsDatabase(config.databasePath);
const resolveWalletSafeguardIdentity = config.walletSafeguardUrl
  ? createControlPlaneWalletSafeguardResolver({ url: config.walletSafeguardUrl, token: config.controlPlaneWalletSafeguardToken })
  : undefined;
const scopeMap=new Map(Object.entries(config.governanceReaderScopes).map(([producer,wallets])=>[producer,{wallets:new Map(Object.entries(wallets).map(([wallet,targets])=>[wallet,new Set(targets)]))}]));
const subjectBindings=new Map(config.governanceSubjectBindings.map(binding=>[`${binding.network}:${binding.subjectAddress}`,binding.positionId]));
const governanceOwnership=createGovernanceReadOwnership({db,scopes:scopeMap,subjectBindings});
const scenarioRegistry=config.scenarioRegistry.length?createScenarioCapsuleRegistry(config.scenarioRegistry):undefined;
const server = createBackendServer({ db, tokens: config.tokens, observationTokens: config.tokens, observationProducerSources: config.observationProducerSources, scenarioRegistry, readGovernanceAuthorization: input=>governanceOwnership.authorize(input), governanceAvailability: input=>governanceOwnership.availability(input), velocityViewerToken: config.velocityViewerToken, evacuationToken: config.evacuationToken, evaluationToken: config.evaluationToken, walletSafeguardToken: config.walletSafeguardToken, revalidationToken: config.revalidationToken, resolveWalletSafeguardIdentity, privateReceiptToken: config.privateReceiptToken, ownerReceiptPublicKey: config.ownerAuthorityPublicKey, assignmentToken: config.assignmentToken });

server.listen(config.port, config.host, () => {
  process.stdout.write(`${JSON.stringify({ level: 'info', event: 'observation_hub_listening', host: config.host, port: config.port })}\n`);
});

function shutdown(signal) {
  process.stdout.write(`${JSON.stringify({ level: 'info', event: 'observation_hub_shutdown', signal })}\n`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

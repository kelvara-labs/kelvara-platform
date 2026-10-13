import { discoverAddress, ONYC_MINT, ONRE_PROGRAM_ID } from "../../../src/domains/discovery/wallet.js";
import { buildOnreBaseline } from "../../../src/domains/protocols/onre/baseline.js";
import { createSolanaRpc } from "../../../src/platform/solana/rpc.js";

export const CLUSTERS = ["mainnet", "devnet"];
export const NETWORKS = ["mainnet", "devnet", "devnet-fixture"];
const tokenPrograms = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

function urlsFor(cluster, env) {
  const prefix = cluster === "devnet" ? "DEVNET" : "MAINNET";
  const configured = [
    env[`${prefix}_RPC_1`], env[`${prefix}_RPC_2`],
    cluster === "mainnet" ? env.HELIUS_RPC_1 : null,
    cluster === "mainnet" ? env.HELIUS_RPC_2 : null,
    env[`${prefix}_RPC_URL`],
    cluster === "mainnet" ? env.SOLANA_RPC_URL : null,
  ].filter(Boolean);
  const unique = configured.filter((url, index, all) => all.indexOf(url) === index);
  return unique.length ? unique : [cluster === "devnet"
    ? "https://api.devnet.solana.com"
    : "https://api.mainnet-beta.solana.com"];
}

export function createWalletInspectorRuntime(env = process.env) {
  const clusters = Object.fromEntries(CLUSTERS.map(cluster => [
    cluster,
    urlsFor(cluster, env).map((url, index) => createSolanaRpc(url, { name: `${cluster}-${index + 1}` })),
  ]));
  const networks = {
    ...clusters,
    "devnet-fixture": [createSolanaRpc(env.FIXTURE_RPC_URL || "http://127.0.0.1:7630/rpc", { name: "fixture-lab" })],
  };

  async function discover(address, network) {
    return discoverAddress(address, { rpcs: networks[network], tokenPrograms });
  }

  async function assure(wallet, network) {
    const assurance = await buildOnreBaseline({
      programId: ONRE_PROGRAM_ID,
      mint: ONYC_MINT,
      rpcs: networks[network],
      observedAt: new Date().toISOString(),
    });
    return { wallet, assurance };
  }

  async function inspect(address, network) {
    if (!NETWORKS.includes(network)) throw new Error("invalid_cluster");
    const discovery = await discover(address, network);
    let assurance = null;
    let assuranceError = null;
    if (discovery.positions?.length || discovery.inputType === "monitored_mint") {
      try { assurance = await assure(discovery.wallet, network); }
      catch (error) { assuranceError = error.message; }
    }
    return {
      wallet: discovery.wallet ?? (discovery.inputType === "monitored_mint" ? null : address),
      network,
      cluster: network === "devnet-fixture" ? "devnet" : network,
      mode: network === "devnet-fixture" ? "fixture_simulation" : "chain_read",
      inspectedAt: new Date().toISOString(),
      discovery,
      assurance,
      assuranceError,
    };
  }

  return { clusters, networks, discover, assure, inspect };
}

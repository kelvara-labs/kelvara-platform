#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createWalletInspectorRuntime } from "./backend/runtime.js";

export function parseWalletInspectorArgs(argv) {
  let cluster = null;
  let json = false;
  let address = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--cluster") cluster = argv[++index];
    else if (arg.startsWith("--cluster=")) cluster = arg.slice(10);
    else if (arg.startsWith("-")) throw new Error(`unknown_option:${arg}`);
    else if (address) throw new Error("too_many_addresses");
    else address = arg;
  }
  if (!address) throw new Error("missing_address");
  if (!cluster) throw new Error("missing_cluster");
  if (!["mainnet", "devnet"].includes(cluster)) throw new Error("invalid_cluster");
  return { address, cluster, json };
}

export function formatInspection(result) {
  const lines = [`Cluster: ${result.cluster}`];
  const monitored = result.discovery.monitoredAsset;
  const position = result.discovery.positions?.[0];
  if (monitored) {
    lines.push(`Monitored token: ${monitored.asset}`, `Mint: ${monitored.mint}`);
  } else if (position) {
    lines.push(`Token: ${position.asset}`, `Mint: ${position.mint}`, `Owner wallet: ${result.wallet}`, `Balance: ${position.amount} ${position.asset}`);
  } else {
    lines.push("Monitored position: none");
  }
  const status = result.assurance?.assurance?.sourceStatus;
  lines.push(`Assurance: ${status || `unavailable${result.assuranceError ? ` (${result.assuranceError})` : ""}`}`);
  return lines.join("\n");
}

export async function runWalletInspectorCli(argv, { runtime = createWalletInspectorRuntime(), write = console.log, writeError = console.error } = {}) {
  try {
    const args = parseWalletInspectorArgs(argv);
    const result = await runtime.inspect(args.address, args.cluster);
    write(args.json ? JSON.stringify(result, null, 2) : formatInspection(result));
    return 0;
  } catch (error) {
    writeError(`wallet-inspector: ${error.message}`);
    return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = await runWalletInspectorCli(process.argv.slice(2));

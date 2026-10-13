#!/usr/bin/env node
import { resolve } from "node:path";
import { inspectIndexer } from "../../domains/indexer/inspect.js";
import { createJsonStatusStore } from "../../domains/indexer/status-store.js";
import { formatIngestionStatus } from "./ingestion-status.js";

const indexerDir = resolve(process.env.KELVARA_INDEXER_DIR || "/home/andy/kelvara-build/[codebase]/indexer_anchor_protocol");
const dbPath = resolve(process.env.KELVARA_INDEXER_DB_PATH || `${indexerDir}/indexer.db`);
const statusPath = resolve(process.env.KELVARA_INGESTION_STATUS_PATH || "./var/ingestion-status.json");
const maxAgeSeconds = Number(process.env.INDEXER_MAX_AGE_SECONDS || 45);

const runner = createJsonStatusStore(statusPath).read();
const source = inspectIndexer(dbPath, { maxAgeSeconds });
console.log(formatIngestionStatus({ runner, source }));

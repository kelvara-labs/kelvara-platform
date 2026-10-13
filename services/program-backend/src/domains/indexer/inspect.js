import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assessIndexerFreshness } from "./source.js";

const REQUIRED_TABLES = ["signatures", "raw_instructions", "raw_accounts", "discriminator_list"];

function scalar(db, sql) {
  return db.prepare(sql).get().value;
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
}

export function inspectIndexer(sourcePath, { now = Math.floor(Date.now() / 1000), maxAgeSeconds = 30 } = {}) {
  if (!existsSync(sourcePath)) {
    return { available: false, reason: "source_not_found", sourcePath };
  }

  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    const problems = REQUIRED_TABLES.filter(table => !tables.has(table)).map(table => `missing table: ${table}`);
    const instructionColumns = tables.has("raw_instructions") ? columns(db, "raw_instructions") : [];
    const hasProgramId = instructionColumns.includes("program_id");
    if (!hasProgramId) problems.push("raw_instructions missing program_id");

    const head = tables.has("signatures")
      ? db.prepare("SELECT signature, slot, block_time AS blockTime, block_time_readable AS blockTimeReadable FROM signatures ORDER BY slot DESC, block_time DESC LIMIT 1").get() || null
      : null;

    const counts = tables.has("signatures") ? {
      signatures: scalar(db, "SELECT count(*) AS value FROM signatures"),
      processed: scalar(db, "SELECT count(*) AS value FROM signatures WHERE processed = 1"),
      pending: scalar(db, "SELECT count(*) AS value FROM signatures WHERE processed = 0"),
      failed: scalar(db, "SELECT count(*) AS value FROM signatures WHERE processed = -1"),
      rawInstructions: tables.has("raw_instructions") ? scalar(db, "SELECT count(*) AS value FROM raw_instructions") : 0,
      rawAccounts: tables.has("raw_accounts") ? scalar(db, "SELECT count(*) AS value FROM raw_accounts") : 0,
      discriminators: tables.has("discriminator_list") ? scalar(db, "SELECT count(*) AS value FROM discriminator_list") : 0,
    } : { signatures: 0, processed: 0, pending: 0, failed: 0, rawInstructions: 0, rawAccounts: 0, discriminators: 0 };

    return {
      available: true,
      sourcePath,
      access: "read-only",
      schema: { compatible: problems.length === 0, hasProgramId, problems },
      counts,
      head,
      freshness: assessIndexerFreshness({ newestBlockTime: head?.blockTime ?? null, now, maxAgeSeconds }),
      ingestion: {
        mode: "polling-source",
        caughtUp: counts.pending === 0,
        pending: counts.pending,
        failed: counts.failed,
      },
    };
  } finally {
    db.close();
  }
}

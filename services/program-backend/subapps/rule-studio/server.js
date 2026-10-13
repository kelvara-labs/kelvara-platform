import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateRule, summarizeRule, validateRule } from "../../packages/rule-engine/index.js";

const root = dirname(fileURLToPath(import.meta.url));
const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validateDevnetEvidence(evidence) {
  const errors = [];
  if (evidence?.cluster !== "devnet") errors.push("devnet level requires devnet evidence");
  if (evidence?.source?.type !== "monitoring_backend" || !evidence?.source?.id) errors.push("monitoring backend source is required");
  if (!Number.isInteger(evidence?.slot) || evidence.slot < 0) errors.push("non-negative slot is required");
  if (!Number.isFinite(Date.parse(evidence?.observedAt))) errors.push("observedAt is required");
  if (!Number.isFinite(Date.parse(evidence?.fetchedAt))) errors.push("fetchedAt is required");
  return errors;
}

function validRun(run) {
  return run && ["paper", "devnet"].includes(run.level)
    && run.cluster === "devnet"
    && Number.isInteger(run.total)
    && run.counts && ["pass", "review", "breach", "unknown"].every(key => Number.isInteger(run.counts[key]));
}

export function createRuleStudio() {
  const levels = { paper: null, devnet: null };
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && assets[url.pathname]) {
        const [name, type] = assets[url.pathname];
        response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        response.end(await readFile(join(root, name)));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        send(response, 200, { status: "active", service: "rule-studio", capabilities: ["paper", "devnet", "batch"] });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/levels") {
        send(response, 200, levels);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/preview") {
        const input = await readBody(request);
        if (input.rule?.cluster && input.evidence?.cluster && input.rule.cluster !== input.evidence.cluster) {
          send(response, 400, { error: "mixed_clusters" }); return;
        }
        const validation = validateRule(input.rule);
        if (!validation.valid) { send(response, 400, { error: "invalid_rule", errors: validation.errors }); return; }
        const preview = { level: "paper", mode: "preview", summary: summarizeRule(input.rule), result: evaluateRule(input.rule, input.evidence) };
        levels.paper = preview;
        send(response, 200, preview);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/levels/devnet/evaluate") {
        const input = await readBody(request);
        const errors = validateDevnetEvidence(input.evidence);
        const validation = validateRule(input.rule);
        if (!validation.valid) errors.push(...validation.errors);
        if (input.rule?.cluster !== "devnet") errors.push("devnet rule cluster is required");
        if (errors.length) { send(response, 400, { error: "invalid_devnet_input", errors }); return; }
        const evaluation = {
          level: "devnet",
          mode: "monitored_evidence",
          summary: summarizeRule(input.rule),
          result: evaluateRule(input.rule, input.evidence),
          provenance: {
            source: input.evidence.source,
            slot: input.evidence.slot,
            observedAt: input.evidence.observedAt,
            fetchedAt: input.evidence.fetchedAt,
            freshness: input.evidence.freshness,
          },
        };
        levels.devnet = evaluation;
        send(response, 200, evaluation);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/runs") {
        const run = await readBody(request);
        if (!validRun(run)) { send(response, 400, { error: "invalid_run" }); return; }
        levels[run.level] = run;
        send(response, 201, { accepted: true, level: run.level, runId: run.runId });
        return;
      }
      send(response, 404, { error: "not_found" });
    } catch (error) {
      send(response, 400, { error: error.message === "body_too_large" ? error.message : "invalid_request" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.RULE_STUDIO_PORT || 7622);
  createRuleStudio().listen(port, "127.0.0.1", () => console.log(`Kelvara Rule Studio: http://127.0.0.1:${port}`));
}

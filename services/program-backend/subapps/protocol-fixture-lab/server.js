import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureLab, fixtureScenarios } from "./state.js";
import { evaluateRule } from "../../packages/rule-engine/index.js";
import { ONRE_PROGRAM_ID } from "../../src/domains/discovery/wallet.js";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "web");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function body(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function rpcResult(lab, method, params) {
  if (method === "getSlot") return lab.snapshot().slot;
  if (method === "getHealth") return "ok";
  if (method === "getVersion") return { "solana-core": "protocol-fixture-lab-0.1.0", "feature-set": 0 };
  if (method === "getSignaturesForAddress") return lab.signatures(params[1] ?? {});
  if (method === "getTransaction") return lab.transaction(params[0]);
  if (method === "getProgramAccounts") return lab.programAccounts();
  if (method === "getTokenAccountsByOwner") return { context: { slot: lab.snapshot().slot }, value: lab.tokenAccounts(params[0], params[1]?.programId) };
  if (method === "getAccountInfo") return { context: { slot: lab.snapshot().slot }, value: lab.account(params[0], params[1]?.encoding) };
  throw Object.assign(new Error("method_not_found"), { code: -32601 });
}

const solanaMeaningByScenario = {
  "upgrade-authority-transfer": "In a real Solana deployment, the Upgradeable Loader ProgramData account's upgrade authority changed. The new authority can replace executable program bytes until removed.",
  "upgrade-authority-remove": "In a real Solana deployment, the Upgradeable Loader ProgramData account's upgrade authority became null. The current executable becomes immutable through the standard upgrade authority path.",
  pause: "In a real Solana deployment, the decoded ONRE state/config account changed its paused field from false to true. This means the protocol reports itself paused; it does not mean the Solana executable was frozen.",
  "vault-outflow": "In a real Solana deployment, an ONRE-controlled SPL token vault account balance decreased sharply between slots. This is evidence of asset movement, not proof of theft.",
};
function solanaMeaning(scenario, field) { return solanaMeaningByScenario[scenario] || `In a real Solana deployment, normalized on-chain account evidence showed the monitored ${field} value breach its configured baseline. The alert reports the observed state change, not an inferred root cause.`; }

const ruleByScenario = {
  "upgrade-authority-transfer": ["upgradeAuthority", "11111111111111111111111111111111"],
  "upgrade-authority-remove": ["upgradeAuthority", "11111111111111111111111111111111"],
  "mint-authority-transfer": ["mintAuthority", "11111111111111111111111111111111"],
  "freeze-authority-change": ["freezeAuthority", "11111111111111111111111111111111"],
  "supply-increase": ["rawSupply", "100000000000000"],
  "nav-jump": ["nav", 1], "nav-stale": ["navUpdatedAt", "2026-11-14T22:13:20.000Z"],
  "vault-outflow": ["vaultRawBalance", "50000000000000"],
  "first-seen-destination": ["lastDestination", "SysvarC1ock11111111111111111111111111111111"],
  pause: ["paused", false], "redemption-failure": ["redemptionHealthy", true],
  "multi-condition-incident": ["paused", false],
};

async function evaluateAndAlert(lab, scenario, alertConsoleUrl) {
  const [field, threshold] = ruleByScenario[scenario];
  const evidence = lab.evidence();
  const ruleDefinition = { id: `fixture-${field}`, version: 1, name: `Fixture ${field}`, field, operator: "equals", threshold, severity: "high", recommendedAction: `Review simulated ${field} change.` };
  const rule = evaluateRule(ruleDefinition, evidence);
  if (!alertConsoleUrl || rule.status !== "breach") return { rule, alert: null };
  const event = { eventId: `fixture:${scenario}:${evidence.slot}`, dedupKey: `fixture:onre:${field}`, mode: "fixture_simulation", level: "fixture_simulation", cluster: "devnet", subject: { type: "program", id: ONRE_PROGRAM_ID }, ruleId: ruleDefinition.id, ruleVersion: 1, status: rule.status, severity: ruleDefinition.severity, uncertainty: "fixture_only", evidenceIds: [evidence.id], recommendedAction: ruleDefinition.recommendedAction, solanaMeaning: solanaMeaning(scenario, field), occurredAt: evidence.observedAt, source: evidence.source, slot: evidence.slot };
  try {
    const response = await fetch(`${alertConsoleUrl}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
    if (!response.ok) throw new Error(`alert_console_http_${response.status}`);
    return { rule, alert: await response.json() };
  } catch (error) { return { rule, alert: null, alertError: error.message }; }
}

async function asset(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!new Set(["index.html", "styles.css", "app.js"]).has(relative)) return false;
  try {
    const data = await readFile(join(webRoot, relative));
    response.writeHead(200, { "content-type": types[extname(relative)], "cache-control": "no-store" });
    response.end(data);
  } catch { json(response, 404, { error: "not_found" }); }
  return true;
}

export function createFixtureLabServer({ lab = createFixtureLab(), alertConsoleUrl = process.env.ALERT_CONSOLE_URL || null } = {}) {
  const rpcCalls = [];
  const recordRpc = (method, ok, error = null) => {
    rpcCalls.push({ sequence: rpcCalls.length + 1, method, ok, error, observedAt: new Date().toISOString() });
    if (rpcCalls.length > 100) rpcCalls.shift();
  };
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && await asset(response, url.pathname)) return;
      if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true, service: "protocol-fixture-lab", label: "fixture-only-not-chain-data", mode: "fixture_simulation" });
      if (request.method === "GET" && url.pathname === "/api/state") return json(response, 200, { state: lab.snapshot(), evidence: lab.evidence() });
      if (request.method === "GET" && url.pathname === "/api/scenarios") return json(response, 200, { scenarios: fixtureScenarios });
      if (request.method === "GET" && url.pathname === "/api/activity") {
        const transactions = lab.snapshot().transactions.map(({ signature, slot, blockTime, scenario, err, confirmationStatus }) => ({ signature, slot, blockTime, scenario, err, confirmationStatus }));
        return json(response, 200, { rpcCalls, transactions });
      }
      if (request.method === "GET" && url.pathname === "/api/export") return json(response, 200, { label: "fixture-only-not-chain-data", state: lab.snapshot(), evidence: lab.evidence(), rpcCalls });
      if (request.method === "POST" && url.pathname === "/api/reset") return json(response, 200, { state: lab.reset(), evidence: lab.evidence() });
      const scenario = request.method === "POST" && url.pathname.match(/^\/api\/scenarios\/([^/]+)$/);
      if (scenario) {
        const name = decodeURIComponent(scenario[1]);
        const result = lab.trigger(name);
        const evaluation = await evaluateAndAlert(lab, name, alertConsoleUrl);
        return json(response, 200, { ...result, evidence: lab.evidence(), ...evaluation });
      }
      if (request.method === "POST" && url.pathname === "/rpc") {
        const call = await body(request);
        try {
          const result = rpcResult(lab, call.method, call.params ?? []);
          recordRpc(call.method, true);
          return json(response, 200, { jsonrpc: "2.0", id: call.id ?? null, result });
        } catch (error) {
          recordRpc(call.method ?? "unknown", false, error.message);
          return json(response, 200, { jsonrpc: "2.0", id: call.id ?? null, error: { code: error.code ?? -32603, message: error.message } });
        }
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      const status = error.message === "unknown_scenario" ? 400 : 500;
      return json(response, status, { error: status === 500 ? "fixture_lab_failed" : error.message });
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PROTOCOL_FIXTURE_LAB_PORT || process.env.ONRE_FIXTURE_LAB_PORT || 7630);
  createFixtureLabServer().listen(port, "127.0.0.1", () => {
    console.log(`Protocol Fixture Lab: http://127.0.0.1:${port}; RPC=http://127.0.0.1:${port}/rpc; fixture-only`);
  });
}

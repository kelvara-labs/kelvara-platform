import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(ROOT, "..", "web");
const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function asset(response, pathname) {
  const definition = ASSETS.get(pathname);
  if (!definition) return false;
  const [file, contentType] = definition;
  try {
    const body = await readFile(join(WEB_ROOT, file));
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    response.end(body);
  } catch {
    json(response, 503, { error: "interface_unavailable" });
  }
  return true;
}

function failureStatus(error) {
  if (error.message === "invalid_wallet") return 400;
  if (error.message === "supported_position_not_found") return 404;
  if (error.message === "all_rpc_sources_failed") return 503;
  return 500;
}

export function createWalletInspectorApp({ discoverWallet = null, discoverAddress = null, getAssurance = null, inspectAddress = null, serviceUrls = {}, fetchImpl = fetch } = {}) {
  async function serviceStatus(name, url) {
    if (!url) return { name, status: "not_configured" };
    try {
      const result = await fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
      return { name, status: result.ok ? "healthy" : "unhealthy", url };
    } catch (error) { return { name, status: "unreachable", url, error: error.message }; }
  }
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    if (request.method === "GET" && await asset(response, url.pathname)) return;

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, { ok: true, service: "kelvara-wallet-inspector", mode: "read-only" });
    }

    if (request.method === "GET" && url.pathname === "/api/services") {
      const [fixtureLab, alertConsole] = await Promise.all([
        serviceStatus("fixtureLab", serviceUrls.fixtureLab),
        serviceStatus("alertConsole", serviceUrls.alertConsole),
      ]);
      return json(response, 200, { walletInspector: { name: "walletInspector", status: "healthy" }, fixtureLab, alertConsole });
    }

    if (request.method === "GET" && url.pathname === "/api/alerts") {
      if (!serviceUrls.alertConsole) return json(response, 503, { error: "alert_console_not_configured" });
      try {
        const upstream = await fetchImpl(`${serviceUrls.alertConsole}/api/alerts?mode=fixture_simulation`, { signal: AbortSignal.timeout(1500) });
        if (!upstream.ok) return json(response, 502, { error: "alert_console_unhealthy" });
        return json(response, 200, await upstream.json());
      } catch { return json(response, 503, { error: "alert_console_unreachable" }); }
    }

    const match = request.method === "GET" && url.pathname.match(/^\/api\/inspect\/([^/]+)$/);
    if (match) {
      const cluster = url.searchParams.get("cluster") || "mainnet";
      if (!new Set(["mainnet", "devnet", "devnet-fixture"]).has(cluster)) return json(response, 400, { error: "invalid_cluster" });
      const discover = discoverAddress || discoverWallet;
      if (!discover) return json(response, 503, { error: "discovery_unavailable" });
      const wallet = decodeURIComponent(match[1]);
      try {
        if (inspectAddress) return json(response, 200, await inspectAddress(wallet, cluster));
        const discovery = await discover(wallet, cluster);
        let assurance = null;
        let assuranceError = null;
        if ((discovery.positions?.length || discovery.inputType === "monitored_mint") && getAssurance) {
          try { assurance = await getAssurance(discovery.wallet, cluster, discovery); }
          catch (error) { assuranceError = error.message; }
        }
        return json(response, 200, {
          wallet: discovery.wallet ?? (discovery.inputType === "monitored_mint" ? null : wallet),
          cluster,
          inspectedAt: new Date().toISOString(),
          discovery,
          assurance,
          assuranceError,
        });
      } catch (error) {
        return json(response, failureStatus(error), {
          error: failureStatus(error) === 500 ? "inspection_failed" : error.message,
        });
      }
    }

    return json(response, 404, { error: "not_found" });
  });
}

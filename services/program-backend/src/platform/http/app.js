import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const operationsAssets = new Map([
  ["/operations/", [new URL("../../../subapps/operations-console/index.html", import.meta.url), "text/html; charset=utf-8"]],
  ["/operations/app.js", [new URL("../../../subapps/operations-console/app.js", import.meta.url), "text/javascript; charset=utf-8"]],
  ["/operations/styles.css", [new URL("../../../subapps/operations-console/styles.css", import.meta.url), "text/css; charset=utf-8"]],
]);

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function staticOperationsAsset(response, pathname) {
  const asset = operationsAssets.get(pathname);
  if (!asset) return false;
  try {
    const [file, contentType] = asset;
    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(await readFile(file));
  } catch {
    json(response, 503, { error: "operations_console_unavailable" });
  }
  return true;
}

async function readJson(request, limit = 16_384) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > limit) throw new RangeError("request_too_large");
  }
  try { return JSON.parse(raw || "{}"); }
  catch { throw new SyntaxError("invalid_json"); }
}

export function createApp({ inspectSource, discoverWallet = null, getAssurance = null, getGovernance = null, governanceToken = null, getOperationsStatus = null, getOperationTargets = null, getOperationIndexers = null, getOperationHistory = null, getOperationSettings = null, updateOperationSettings = null, getOperationClients = null, getOperationClient = null, getOperationWallets = null, getOperationWallet = null, recordOperationObservation = null, operationsToken = null }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (operationsToken && url.pathname.startsWith("/api/operations/") && request.headers.authorization !== `Bearer ${operationsToken}`) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (request.method === "GET" && await staticOperationsAsset(response, url.pathname)) return;
    if (request.method === "GET" && url.pathname === "/api/governance" && getGovernance) {
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-methods", "GET");
      response.setHeader("cache-control", "no-store");
      if (governanceToken && request.headers.authorization !== `Bearer ${governanceToken}`) return json(response, 401, { error: "unauthorized" });
      try { return json(response, 200, await getGovernance({ network: url.searchParams.get("network"), historyLimit: Number(url.searchParams.get("history_limit") || 10), cursor: url.searchParams.get("cursor") })); }
      catch (error) { return json(response, /^observation_hub_4/.test(error.message) ? 502 : 400, { error: error.message === "invalid_governance_response" ? "governance_unavailable" : error.message }); }
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, { ok: true, service: "kelvara-onre", milestone: "indexer-bridge" });
    }
    if (request.method === "POST" && url.pathname === "/api/operations/observations" && recordOperationObservation) {
      try { return json(response, 202, await recordOperationObservation(await readJson(request))); }
      catch (error) {
        if (error instanceof RangeError) return json(response, 413, { error: "request_too_large" });
        if (error instanceof SyntaxError || error instanceof TypeError) return json(response, 400, { error: error.message });
        return json(response, 503, { error: "operations_observation_unavailable" });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/operations/status" && getOperationsStatus) {
      try { return json(response, 200, await getOperationsStatus()); }
      catch { return json(response, 503, { error: "operations_status_unavailable" }); }
    }
    if (request.method === "GET" && url.pathname === "/api/operations/targets" && getOperationTargets) {
      try { return json(response, 200, await getOperationTargets()); }
      catch { return json(response, 503, { error: "operations_targets_unavailable" }); }
    }
    if (request.method === "GET" && url.pathname === "/api/operations/indexers" && getOperationIndexers) {
      try { return json(response, 200, await getOperationIndexers()); }
      catch { return json(response, 503, { error: "operations_indexers_unavailable" }); }
    }
    if (request.method === "GET" && url.pathname === "/api/operations/history" && getOperationHistory) {
      try { return json(response, 200, await getOperationHistory({ hours: Number(url.searchParams.get("hours") || 24) })); }
      catch { return json(response, 503, { error: "operations_history_unavailable" }); }
    }
    if (request.method === "GET" && url.pathname === "/api/operations/settings" && getOperationSettings) {
      try { return json(response, 200, await getOperationSettings()); }
      catch { return json(response, 503, { error: "operations_settings_unavailable" }); }
    }
    if (request.method === "PUT" && url.pathname === "/api/operations/settings" && updateOperationSettings) {
      try { return json(response, 200, await updateOperationSettings(await readJson(request))); }
      catch (error) {
        if (error instanceof RangeError) return json(response, 413, { error: "request_too_large" });
        if (error instanceof SyntaxError || error instanceof TypeError) return json(response, 400, { error: error.message });
        return json(response, 503, { error: "operations_settings_unavailable" });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/operations/clients" && getOperationClients) {
      try { return json(response, 200, await getOperationClients()); }
      catch { return json(response, 503, { error: "operations_clients_unavailable" }); }
    }
    const operationClientMatch = request.method === "GET" && url.pathname.match(/^\/api\/operations\/clients\/([^/]+)$/);
    if (operationClientMatch && getOperationClient) {
      try {
        const client = await getOperationClient(decodeURIComponent(operationClientMatch[1]));
        return client ? json(response, 200, client) : json(response, 404, { error: "client_not_found" });
      } catch { return json(response, 503, { error: "operations_client_unavailable" }); }
    }
    if (request.method === "GET" && url.pathname === "/api/operations/wallets" && getOperationWallets) {
      try { return json(response, 200, await getOperationWallets()); }
      catch { return json(response, 503, { error: "operations_wallets_unavailable" }); }
    }
    const operationWalletMatch = request.method === "GET" && url.pathname.match(/^\/api\/operations\/wallets\/([^/]+)$/);
    if (operationWalletMatch && getOperationWallet) {
      try {
        const wallet = await getOperationWallet(decodeURIComponent(operationWalletMatch[1]));
        return wallet ? json(response, 200, wallet) : json(response, 404, { error: "wallet_not_found" });
      } catch { return json(response, 503, { error: "operations_wallet_unavailable" }); }
    }
    if (request.method === "GET" && url.pathname === "/api/sources/onre-indexer") {
      try {
        const result = inspectSource();
        if (result.available === false) {
          return json(response, 503, { available: false, reason: result.reason || "source_unavailable" });
        }
        return json(response, 200, result);
      } catch {
        return json(response, 503, { available: false, reason: "source_inspection_failed" });
      }
    }
    const assuranceMatch = request.method === "GET" && url.pathname.match(/^\/api\/wallets\/([^/]+)\/assurance$/);
    if (assuranceMatch && getAssurance) {
      try {
        return json(response, 200, await getAssurance(decodeURIComponent(assuranceMatch[1])));
      } catch (error) {
        const status = error.message === "invalid_wallet" ? 400 : error.message === "supported_position_not_found" ? 404 : error.message === "all_rpc_sources_failed" ? 503 : 500;
        return json(response, status, { error: error.message });
      }
    }
    const walletMatch = request.method === "GET" && url.pathname.match(/^\/api\/wallets\/([^/]+)\/positions$/);
    if (walletMatch && discoverWallet) {
      try {
        const wallet = decodeURIComponent(walletMatch[1]);
        const discovery = await discoverWallet(wallet);
        return json(response, 200, discovery);
      } catch (error) {
        const status = error.message === "invalid_wallet" ? 400 : error.message === "all_rpc_sources_failed" ? 503 : 500;
        return json(response, status, { error: error.message });
      }
    }
    return json(response, 404, { error: "not_found" });
  });
}

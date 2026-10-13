import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateEvidence } from "../../packages/evidence-model/index.js";
import { networkProfile, redactRpcUrl } from "../../packages/evidence-model/network-profile.js";
import { validateEvent } from "../../packages/event-schema/index.js";

const root = dirname(fileURLToPath(import.meta.url));
const assets = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
});

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createContractInspector(env = process.env) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && assets[url.pathname]) {
        const [name, type] = assets[url.pathname];
        response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        response.end(await readFile(join(root, name)));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/network") {
        const profile = networkProfile({ ...env, KELVARA_NETWORK: url.searchParams.get("cluster") || env.KELVARA_NETWORK });
        json(response, 200, { cluster: profile.cluster, source: profile.source, rpcProviders: profile.rpcUrls.map(redactRpcUrl) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, { status: "active", service: "contract-inspector" });
        return;
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/validate/")) {
        const body = await readJson(request);
        if (url.pathname === "/api/validate/evidence") json(response, 200, validateEvidence(body));
        else if (url.pathname === "/api/validate/event") json(response, 200, validateEvent(body));
        else json(response, 404, { error: "not_found" });
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      json(response, 400, { error: error.message === "body_too_large" ? error.message : "invalid_request" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.CONTRACT_INSPECTOR_PORT || 4312);
  createContractInspector().listen(port, "127.0.0.1", () => {
    console.log(`Kelvara Contract Inspector: http://127.0.0.1:${port}`);
  });
}

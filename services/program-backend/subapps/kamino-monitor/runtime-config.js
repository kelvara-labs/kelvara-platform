import { randomBytes, createPrivateKey } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function validPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("PORT must be an integer between 1 and 65535");
  return port;
}
function boundedUrl(value, name) {
  if (!value) return null;
  if (String(value).length > 2048) throw new TypeError(`${name} is too long`);
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError(`${name} must be HTTP(S)`);
  return url.toString().replace(/\/$/, "");
}
function internalToken(value, name) {
  if (!value) return null;
  if (String(value).length < 32 || String(value).length > 512) throw new TypeError(`${name} must be 32-512 characters`);
  return String(value);
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export function resolveKaminoRuntimeConfig(env = process.env, moduleDir = ".") {
  const runtimeDir = resolve(env.KELVARA_RUNTIME_DIR || resolve(moduleDir, "../../.runtime/kamino-monitor"));
  const configUrl = boundedUrl(env.KELVARA_CONTROL_PLANE_URL, "KELVARA_CONTROL_PLANE_URL");
  const receiptsUrl = boundedUrl(env.KELVARA_OBSERVATION_HUB_URL, "KELVARA_OBSERVATION_HUB_URL");
  const configToken = internalToken(env.KELVARA_CONTROL_PLANE_TOKEN, "KELVARA_CONTROL_PLANE_TOKEN");
  const receiptsToken = internalToken(env.KELVARA_OBSERVATION_HUB_TOKEN, "KELVARA_OBSERVATION_HUB_TOKEN");
  if (Boolean(configUrl) !== Boolean(configToken) || Boolean(receiptsUrl) !== Boolean(receiptsToken)) throw new TypeError("portfolio internal dependency configuration incomplete");
  if (configToken && receiptsToken && configToken === receiptsToken) throw new TypeError("portfolio internal dependency tokens must be distinct");
  if ((env.NODE_ENV === "production" || env.HAOS === "1") && (!configUrl || !receiptsUrl || env.HOST !== "127.0.0.1")) {
    if (!configUrl || !receiptsUrl) throw new TypeError("portfolio internal dependencies required");
  }
  return {
    host: env.HOST || "127.0.0.1",
    port: validPort(env.PORT || 8080),
    runtimeDir,
    keyPath: resolve(runtimeDir, "protection.key"),
    storePath: resolve(runtimeDir, "armed-protection.enc"),
    controlPlaneUrl: configUrl,
    observationHubUrl: receiptsUrl,
    controlPlaneToken: configToken,
    observationHubToken: receiptsToken,
  };
}

export async function loadOrCreateProtectionKey({ keyPath, storePath }) {
  const keyExists = await exists(keyPath);
  if (keyExists) {
    const encoded = (await readFile(keyPath, "utf8")).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded) throw new Error("protection_key_invalid");
    return key;
  }
  if (await exists(storePath)) throw new Error("protection_key_missing_for_existing_store");
  const key = randomBytes(32);
  try {
    await writeFile(keyPath, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    return key;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const encoded = (await readFile(keyPath, "utf8")).trim();
    const existing = Buffer.from(encoded, "base64");
    if (existing.length !== 32 || existing.toString("base64") !== encoded) throw new Error("protection_key_invalid");
    return existing;
  }
}

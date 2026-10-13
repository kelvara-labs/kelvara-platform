import { spawn } from "node:child_process";
import { join } from "node:path";

const STEP_ARGS = Object.freeze({
  recent: ["src/index.ts", "--recent"],
  process: ["src/index.ts", "--process", "--all"],
  accounts: ["src/index.ts", "--accounts"],
});

export function commandForStep(step, { processLimit = 25 } = {}) {
  const args = STEP_ARGS[step];
  if (!args) throw new Error(`unsupported indexer step: ${step}`);
  if (step === "process") return [...args, "--limit", String(processLimit)];
  return [...args];
}

export function compactOutput(output, limit = 4000) {
  const text = String(output || "");
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

export function runIndexerStep(step, {
  indexerDir,
  timeoutMs = 120_000,
  processLimit = 25,
  signal,
  terminationGraceMs = 5_000,
  spawnImpl = spawn,
  killImpl = process.kill,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const executable = join(indexerDir, "node_modules", ".bin", "tsx");
  const args = commandForStep(step, { processLimit });
  return new Promise(resolve => {
    const child = spawnImpl(executable, args, {
      cwd: indexerDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    let timedOut = false;
    let settled = false;
    let graceTimer;
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timeoutTimer);
      if (graceTimer !== undefined) clearTimeoutImpl(graceTimer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const killGroup = killSignal => {
      try { killImpl(-child.pid, killSignal); }
      catch (error) { output += `\ntermination failed: ${error.message}`; }
    };
    const terminate = reason => {
      if (settled || graceTimer !== undefined) return;
      output += `\n${reason}`;
      killGroup("SIGTERM");
      graceTimer = setTimeoutImpl(() => {
        output += `\ntermination grace expired after ${terminationGraceMs}ms`;
        killGroup("SIGKILL");
      }, terminationGraceMs);
    };
    const abort = () => terminate("aborted");
    const timeoutTimer = setTimeoutImpl(() => {
      timedOut = true;
      terminate(`timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    child.on("error", error => finish({ code: -1, timedOut, output: compactOutput(output + error.message) }));
    child.on("close", (code, closeSignal) => {
      const suffix = closeSignal ? `\nterminated by ${closeSignal}` : "";
      finish({ code: code ?? -1, timedOut, output: compactOutput(output + suffix) });
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

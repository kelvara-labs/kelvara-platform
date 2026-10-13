const STEPS = ["recent", "process", "accounts"];

function diagnostic(value, limit = 500) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;\]}]+/gi, "$1[redacted]")
    .replace(/(["']?(?:password|api[-_]?key|token|secret)["']?\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s,;\]}]+)/gi, "$1[redacted]")
    .slice(-limit);
}

export function createIngestionRunner({
  runStep,
  inspectSource,
  writeStatus = () => {},
  recordTelemetry = () => {},
  recordIncident = () => {},
  initialStatus = { state: "never-run", lastResult: null },
  now = () => Math.floor(Date.now() / 1000),
  highResolutionNow = () => performance.now(),
}) {
  let running = false;
  let status = initialStatus;
  let cycle = Number(initialStatus.cycle || 0);
  if (initialStatus.state === "running") {
    recordIncident({ id: `interrupted-${cycle}-${initialStatus.startedAt}`, kind: "interrupted_cycle", startedAt: initialStatus.startedAt, detail: { cycle, stage: initialStatus.stage ?? null } });
    status = { state: "failed", cycle, lastResult: { ok: false, cycle, startedAt: initialStatus.startedAt, finishedAt: now(), failedStep: initialStatus.stage ?? "unknown", error: "interrupted_by_restart", steps: [] } };
    writeStatus(status);
  }

  async function runOnce() {
    if (running) return { ok: false, skipped: true, reason: "cycle_already_running" };
    running = true;
    cycle += 1;
    const startedAt = now();
    status = { state: "running", cycle, startedAt, lastResult: status.lastResult };
    writeStatus(status);
    const steps = [];
    let activeStage = "recent";
    try {
      for (const step of STEPS) {
        activeStage = step;
        status = { ...status, stage: step };
        writeStatus(status);
        const stageStartedAt = highResolutionNow();
        const result = await runStep(step);
        const stageFinishedAt = highResolutionNow();
        const sampledAt = Math.floor(Date.now() / 1000);
        const clean = { ...result, output: diagnostic(result.output) };
        steps.push({ step, ...clean });
        recordTelemetry({ sampledAt, success: result.code === 0, timeout: Boolean(result.timedOut), latencyMs: result.latencyMs ?? Math.max(0, stageFinishedAt - stageStartedAt), provider: result.provider ?? null, stage: step });
        if (result.code !== 0) {
          const finishedAt = now();
          const failed = { ok: false, cycle, startedAt, finishedAt, failedStep: step, error: clean.output, steps };
          status = { state: "failed", cycle, lastResult: failed };
          writeStatus(status);
          recordIncident({ id: `cycle-${cycle}-${step}-${finishedAt}`, kind: result.timedOut ? "stage_timeout" : "stage_failure", startedAt: finishedAt, detail: { cycle, stage: step, diagnostic: clean.output } });
          return failed;
        }
      }
      activeStage = "inspect";
      status = { ...status, stage: activeStage };
      writeStatus(status);
      const source = inspectSource();
      const finishedAt = now();
      const sourceFailure = source.available === false
        ? { error: diagnostic(source.reason || "source_unavailable"), kind: "source_unavailable" }
        : source.schema?.compatible === false
          ? { error: "source_schema_incompatible", kind: "source_incompatible" }
          : null;
      recordTelemetry({ sampledAt: finishedAt, success: !sourceFailure, timeout: false, latencyMs: null, provider: null, stage: "inspect", sourceLagMs: source.freshness?.ageSeconds == null ? null : source.freshness.ageSeconds * 1000, slot: source.head?.slot ?? null, backlog: source.counts?.pending ?? null, processingLagMs: source.processingLagMs ?? null });
      if (sourceFailure) {
        const failed = { ok: false, cycle, startedAt, finishedAt, failedStep: "inspect", error: sourceFailure.error, steps, source };
        status = { state: "failed", cycle, lastResult: failed };
        writeStatus(status);
        recordIncident({ id: `cycle-${cycle}-inspect-${finishedAt}`, kind: sourceFailure.kind, startedAt: finishedAt, detail: { cycle, stage: "inspect", diagnostic: sourceFailure.error } });
        return failed;
      }
      const succeeded = { ok: true, cycle, startedAt, finishedAt, steps, source };
      status = { state: "idle", cycle, lastResult: succeeded };
      writeStatus(status);
      return succeeded;
    } catch (error) {
      const failed = { ok: false, cycle, startedAt, finishedAt: now(), failedStep: activeStage, error: diagnostic(error.message), steps };
      status = { state: "failed", cycle, lastResult: failed };
      writeStatus(status);
      recordIncident({ id: `cycle-${cycle}-exception-${failed.finishedAt}`, kind: "cycle_exception", startedAt: failed.finishedAt, detail: { cycle, stage: activeStage, diagnostic: failed.error } });
      return failed;
    } finally { running = false; }
  }

  return { runOnce, getStatus: () => status };
}

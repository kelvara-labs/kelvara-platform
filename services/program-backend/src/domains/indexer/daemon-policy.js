export function createCycleController({ runCycle }) {
  let active = null;
  async function run() {
    if (active) return { ok: false, skipped: true, reason: "cycle_already_running" };
    const abortController = new AbortController();
    const promise = Promise.resolve().then(() => runCycle(abortController.signal));
    active = { abortController, promise };
    try { return await promise; }
    finally { if (active?.promise === promise) active = null; }
  }
  function abort() { active?.abortController.abort(); }
  async function waitForIdle() { if (active) await active.promise.catch(() => {}); }
  return { run, abort, waitForIdle, isRunning: () => Boolean(active) };
}

export function createDaemonPolicy({
  runCycle,
  runRoutineMaintenance,
  evaluatePressure,
  writeMaintenanceStatus,
  initialMaintenanceStatus = { state: "unknown", lastSuccessfulCompactionAt: null, compactionLagSeconds: null },
  now = () => Math.floor(Date.now() / 1000),
}) {
  let lastMaintenance = initialMaintenanceStatus;
  function persist(status) {
    lastMaintenance = status;
    writeMaintenanceStatus(status);
  }
  function maintain() {
    const result = runRoutineMaintenance();
    const completedAt = now();
    persist({ state: "ok", lastSuccessfulCompactionAt: completedAt, compactionLagSeconds: 0, result });
    return result;
  }
  async function cycle() {
    const pressure = evaluatePressure();
    if (pressure.pauseOptionalBackfill) {
      try {
        const maintenance = maintain();
        return { ok: false, skipped: true, reason: "disk_pressure_pause", maintenance };
      } catch {
        persist({ state: "failed", lastFailureAt: now(), error: "maintenance_failed" });
        return { ok: false, skipped: true, reason: "disk_pressure_pause", failedStep: "maintenance" };
      }
    }
    const result = await runCycle();
    try {
      const maintenance = maintain();
      return { ...result, skipped: false, maintenance, pressure };
    } catch {
      persist({ state: "failed", lastFailureAt: now(), error: "maintenance_failed" });
      return { ok: false, failedStep: "maintenance", cycleResult: result, pressure };
    }
  }
  return { cycle, getLastMaintenance: () => lastMaintenance };
}

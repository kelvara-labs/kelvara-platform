function row(label, value) {
  return `${label.padEnd(24)} ${value}`;
}

export function formatIngestionStatus({ runner, source }) {
  const lines = ["Kelvara ingestion status", ""];
  lines.push(row("Runner state", runner.state));
  lines.push(row("Cycle", String(runner.cycle ?? "never")));
  if (runner.state === "running") lines.push(row("Current stage", runner.stage || "starting"));
  if (source.available) {
    const freshness = source.freshness || {};
    const age = freshness.ageSeconds == null ? "age unknown" : `${freshness.ageSeconds}s old`;
    lines.push(row("Freshness", `${freshness.status || "unknown"} (${age})`));
    lines.push(row("Pending", String(source.counts?.pending ?? 0)));
    lines.push(row("Failed", String(source.counts?.failed ?? 0)));
    lines.push(row("Caught up", source.ingestion?.caughtUp ? "yes" : "no"));
  } else {
    lines.push(row("Source", `unavailable: ${source.reason}`));
  }
  const last = runner.lastResult;
  if (last?.startedAt != null && last?.finishedAt != null) {
    lines.push(row("Last cycle latency", `${last.finishedAt - last.startedAt}s`));
  }
  lines.push(row("Catch-up", "bounded per cycle"));
  return lines.join("\n");
}

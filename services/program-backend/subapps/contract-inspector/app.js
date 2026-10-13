const samples = {
  evidence: {
    id: "evidence:program-control:1", kind: "program_control", cluster: "devnet",
    source: { id: "rpc-a", type: "solana_rpc" }, observedAt: "2026-09-26T09:00:00.000Z",
    fetchedAt: "2026-09-26T09:00:01.000Z", freshness: { status: "fresh", ageMs: 1000, maxAgeMs: 15000 },
    confidence: "single_source", coverage: "partial", state: "degraded", value: { upgradeAuthority: "authority-a" },
  },
  event: {
    type: "program_control_changed", cluster: "devnet", mode: "fixture_simulation",
    occurredAt: "2026-09-26T09:30:00.000Z", subject: { type: "program", id: "Program111" },
    severity: "high", uncertainty: "single_source", evidenceIds: ["evidence:program-control:1"],
    affectedPosition: null, affectedValue: null, recommendedAction: "Review before transacting.",
    details: { before: "AuthorityA", after: "AuthorityB" },
  },
};

for (const type of ["evidence", "event"]) document.querySelector(`#${type}`).value = JSON.stringify(samples[type], null, 2);

async function selectNetwork(cluster) {
  const response = await fetch(`/api/network?cluster=${encodeURIComponent(cluster)}`);
  const profile = await response.json();
  document.querySelector("#cluster").textContent = profile.cluster === "devnet" ? "Devnet selected" : "Mainnet selected";
  document.querySelector("#rpc").textContent = profile.rpcProviders.join(" · ");
  document.querySelectorAll("[data-cluster]").forEach(button => button.classList.toggle("active", button.dataset.cluster === profile.cluster));
  for (const type of ["evidence", "event"]) {
    const area = document.querySelector(`#${type}`);
    try { const value = JSON.parse(area.value); value.cluster = profile.cluster; if (type === "event") value.mode = profile.cluster === "devnet" ? "fixture_simulation" : "live"; area.value = JSON.stringify(value, null, 2); } catch {}
  }
}

document.querySelectorAll("[data-cluster]").forEach(button => button.addEventListener("click", () => selectNetwork(button.dataset.cluster)));
document.querySelectorAll("[data-validate]").forEach(button => button.addEventListener("click", async () => {
  const type = button.dataset.validate;
  const output = document.querySelector(`#${type}-result`);
  try {
    const value = JSON.parse(document.querySelector(`#${type}`).value);
    const response = await fetch(`/api/validate/${type}`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(value) });
    const result = await response.json();
    output.textContent = result.valid ? "VALID\nContract accepted." : `INVALID\n${result.errors.join("\n")}`;
    output.className = result.valid ? "valid" : "invalid";
  } catch (error) { output.textContent = `INVALID JSON\n${error.message}`; output.className = "invalid"; }
}));

selectNetwork("devnet");

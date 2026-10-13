import { validateSolanaAddress } from "../../domains/discovery/wallet.js";

function line(write, label, value) {
  write(`${label.padEnd(24)} ${value}`);
}

export async function runDemo({ wallet, write = console.log, discover, assure }) {
  write("Kelvara ONRE live CLI");
  write("Read-only: a public address is inspected; no wallet signature is requested.");
  write("");

  if (!validateSolanaAddress(wallet)) {
    write("Invalid Solana wallet address.");
    return 2;
  }

  line(write, "Wallet", `${wallet}  CONNECTED (read-only)`);
  write("[1/3] Discovering ONYC across SPL Token and Token-2022 accounts...");
  let discovery;
  try {
    discovery = await discover(wallet);
  } catch (error) {
    write(`Discovery failed: ${error.message}`);
    return 1;
  }

  line(write, "RPC agreement", discovery.sourceStatus);
  for (const source of discovery.sources || []) line(write, `  ${source.name}`, source.status);
  const position = discovery.positions?.[0];
  if (!position) {
    write("[2/3] No ONYC position found. Assurance skipped because no supported position exists.");
    write("[3/3] Done. No transaction was built, signed, or sent.");
    return 0;
  }

  line(write, "ONYC position", position.amount);
  line(write, "ONYC mint", position.mint);
  line(write, "Token accounts", String(position.tokenAccounts?.length || 0));
  write("[2/3] Reading ONRE program, ProgramData, and ONYC mint controls...");

  let baseline;
  try {
    baseline = await assure();
  } catch (error) {
    write(`Assurance failed: ${error.message}`);
    return 1;
  }
  line(write, "Control RPC agreement", baseline.sourceStatus);
  line(write, "Deployment slot", String(baseline.program.deploymentSlot));
  line(write, "Upgrade authority", baseline.program.upgradeAuthority || "none (immutable)");
  line(write, "Mint authority", baseline.token.mintAuthority || "none");
  line(write, "Freeze authority", baseline.token.freezeAuthority || "none");
  line(write, "ONYC total supply", baseline.token.supply);
  write("");
  write("Monitor coverage");
  for (const monitor of baseline.monitors) line(write, `  ${monitor.id}`, `${monitor.status.toUpperCase()} — ${monitor.reason}`);
  write("");
  line(write, "Current conclusion", baseline.conclusion);
  write("[3/3] Done. No transaction was built, signed, or sent.");
  return 0;
}

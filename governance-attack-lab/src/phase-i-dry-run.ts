export const PHASE_I_IDENTITIES = Object.freeze({
  network: 'devnet',
  wallet: 'DpbwVS5RYtUon7DVPDHXDSkDKVhxermbYytRP9fGhxXv',
  position: 'Ed7aDLAYDq8Q91Gvq2nkHft16dShNaWiTs8hRbgfoiJp',
  multisig: 'CUR3VagHa3wBvYF4HYPnSyhDXTw8bPemCBsR3eF6u67Y',
  vault: 'AtDPByS8KB94qH6mDm9ta5rdQgZDB62JgXSSmmceVXF',
  squadsProgram: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
});

type State = { address?: string; threshold: number; memberCount: number; timeLock: number };
type Options = { network: string; multisig?: string; readMultisig: (address: string) => Promise<State> };
export type PhaseIPlan = { network: 'devnet'; identities: typeof PHASE_I_IDENTITIES; before: State; multisig: string; mutation: PlanStep; reset: PlanStep };
type PlanStep = { action: { kind: 'ChangeThreshold'; from: number; to: number }; precondition: string; expectedDiff: Record<string, unknown>; signers: string[]; fees: string; rollback: string; idempotency: string };

function step(from: number, to: number): PlanStep {
  return {
    action: { kind: 'ChangeThreshold', from, to },
    precondition: `devnet multisig ${PHASE_I_IDENTITIES.multisig}; threshold=${from}; members=3; timeLock=120; finalized read`,
    expectedDiff: { threshold: { from, to }, memberCount: 0, timeLock: 0 },
    signers: [PHASE_I_IDENTITIES.wallet],
    fees: 'SOL transaction fees plus rent for Squads config/proposal accounts; fund only the approved Devnet wallet; exact lamports require simulation/fee quote',
    rollback: `Re-read finalized state; execute inverse ChangeThreshold ${to}->${from} only if threshold=${to}; otherwise stop`,
    idempotency: `Refuse if current threshold != ${from}; never replay by signature alone; verify exact post-state`,
  };
}

export async function buildPhaseIPlan(options: Options): Promise<PhaseIPlan> {
  if (options.network !== 'devnet') throw new Error('Phase I is devnet-only');
  const address = options.multisig ?? PHASE_I_IDENTITIES.multisig;
  if (address !== PHASE_I_IDENTITIES.multisig) throw new Error('Phase I multisig identity mismatch');
  const before = await options.readMultisig(address);
  if (before.threshold !== 2 || before.memberCount !== 3 || before.timeLock !== 120) throw new Error('Phase I precondition mismatch');
  return { network: 'devnet', identities: PHASE_I_IDENTITIES, before, multisig: address, mutation: step(2, 3), reset: step(3, 2) };
}

export async function executePhaseI(plan: PhaseIPlan, io: { authorizeTransactions?: boolean; sign: () => Promise<unknown>; broadcast: () => Promise<unknown> }) {
  if (!io.authorizeTransactions) return { mode: 'dry-run', mutation: 'refused', reset: 'refused', plan };
  throw new Error('Transaction authorization reaches the user-signature gate; this dry-run harness never signs or broadcasts');
}

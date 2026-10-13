# Kelvara

**Self-custodial protection infrastructure for Solana DeFi positions.**

Kelvara maps the control assumptions behind a supported onchain position, preserves canonical evidence about those assumptions, and lets the owner prepare a narrowly constrained exit before an incident.

> Protocol-specific state in. Provider-neutral evidence out.

[Live app](https://app.kelvara.xyz/) · [Architecture](docs/architecture/dependency-map.svg)

### Architecture in one sentence

Solami gRPC and RPC sources feed protocol-specific adapters; adapters produce canonical evidence; Observation Hub and Control Center preserve evidence and identity; Safeguards, Governance, and Protection consume it.

## Why Kelvara

A yield position can look healthy while its control plane changes underneath it. Multisig membership, approval thresholds, upgrade authorities, privileged proposals, and execution rights may change before a holder notices. Raw explorers expose fragments of this evidence, but they do not connect those changes to a holder's position or next decision.

Kelvara turns that fragmented evidence into position-scoped answers:

1. **What do I hold?** Discover supported positions for the authenticated wallet.
2. **Who can change it?** Resolve verified governance and authority mappings.
3. **Has a monitored assumption changed?** Compare fresh observations with explicit baselines.
4. **What does that mean?** Show pass, review, breach, or unknown without hiding stale or unavailable evidence.
5. **What can I do?** Prepare and validate an exact exit path, then ask the wallet owner to approve it.

> **No false guarantees**
>
> A green screen is not a guarantee. Kelvara reports what was checked, evidence freshness, and unavailable coverage. The intended claim is **“No monitored condition is currently breached,”** never **“Everything is safe.”**

## Implemented today

### Mainnet

- Wallet-scoped discovery for supported Kamino positions.
- Verified Kamino-to-Squads control mappings.
- Squads V4 signer-set and approval-threshold monitoring.
- Evidence provenance, finalized slot, observation time, and freshness.
- Read-only Squads governance activity.
- Durable-nonce protected exits for supported positions.
- Explicit submission of a previously approved exit.

### Supported safeguard checks

| Check | Meaning |
|---|---|
| Signer set unchanged | Current Squads members match the approved baseline |
| Approval threshold unchanged | Required approvals have not been reduced |

### Implementation status

| Capability | Mainnet | Devnet | Notes |
|---|:---:|:---:|---|
| Position discovery | Implemented | Partial | Supported targets only |
| Kamino adapter | Implemented | Partial | Network-scoped sources |
| Squads control mapping | Implemented | Partial | Verified mappings only |
| Signer safeguard | Implemented | Partial | Approved signer baseline |
| Threshold safeguard | Implemented | Partial | Approved threshold baseline |
| Governance tracking | Implemented | Partial | Read-only |
| Durable-nonce preparation | Implemented | — | Supported positions |
| Protected withdrawal | Implemented | — | Explicit owner opt-in |
| Demo incident lab | — | In development | Devnet only; no-value assets |

“Partial” means the bounded Devnet journey is not yet complete end to end.

## Architecture

Kelvara separates chain transport, protocol decoding, canonical evidence, policy evaluation, presentation, and signing boundaries.

### Chain transport

Kelvara uses complementary Solana data paths:

- **Solami gRPC** provides low-latency Mainnet account and transaction streams.
- **Helius JSON-RPC** provides point queries, verification, enrichment, recovery, and historical backfill.

Streaming provides immediacy. RPC remains the independent query and recovery path. Neither transport directly determines safeguard state. Protocol adapters normalize observations before they enter the evidence layer.

### Protocol adapters

- **Kamino indexer** observes configured Kamino targets and Solana account state.
- **Squads indexer** observes verified multisig assignments and finalized governance activity.
- **Velocity indexer** derives wallet and subject transaction-activity evidence.

Each producer has a dedicated scoped credential. Observation Hub validates producer identity and source bindings at ingestion.

### Evidence and control layers

**Observation Hub** is the canonical evidence authority. It stores normalized observations, governance detections, actions, evaluation receipts, provenance, and freshness. The browser cannot manufacture incident state.

**Control Center** owns verified target mappings, approved baselines, enrollment state, and protection-readiness projection. Enrollment requires an authenticated wallet, a canonical eligible position, and a verified governance target.

**Program Backend** serves the application edge, creates network-scoped wallet sessions, projects supported positions, and exposes Safeguards, Governance, and Protection APIs.

### Trust boundaries

```text
Browser / wallet
      |
      | authenticated API; transaction consent remains separate
      v
Program Backend
      |
      +---- Control Center
      |
      +---- Observation Hub
                  ^
                  | scoped producer credentials
          +-------+--------+
          |       |        |
       Kamino   Squads  Velocity
          ^       ^        ^
          +------- Solana -+
             gRPC + RPC
```

## Safeguards

Safeguards answer:

> Has a monitored assumption behind this position changed?

They compare canonical current state with an approved baseline. Outcomes preserve provenance and uncertainty. Missing, stale, disagreeing, or unauthorized evidence cannot silently become a pass.

### Example: Squads control evidence

```text
Supported Kamino position
└─ verified Squads control subject
   ├─ approved signer baseline
   ├─ approved threshold baseline
   ├─ current finalized slot
   ├─ decoder provenance
   └─ observation freshness

                    ↓

Safeguards
├─ Signer set unchanged
└─ Approval threshold unchanged
```

The evaluator is position-neutral: it consumes verified identity, canonical observations, and an approved baseline rather than UI-specific state.

## Governance

Governance answers:

> What is the controlling multisig proposing, approving, or executing now?

Kelvara reconstructs read-only Squads proposal activity for verified control subjects. A pending proposal is not treated as effective control state. The monitored baseline changes only after relevant finalized execution evidence enters the normal observation and evaluation path.

## Protected exits

A normally signed Solana transaction depends on a recent blockhash and expires quickly. It is unsuitable as an exit authorized now but potentially needed later.

Kelvara uses user-controlled durable nonce accounts to preserve exact transactions approved beforehand. For a supported protected position:

1. Kelvara resolves the exact position and destination.
2. The backend constructs and simulates constrained evacuation transactions.
3. Three priority-fee variants are prepared against separate durable nonce accounts.
4. The wallet signs those exact transactions client-side.
5. Kelvara stores the signed variants and verified nonce state.
6. When the owner chooses **Withdraw now**, Kelvara may submit an already approved variant.
7. Kelvara cannot create a different withdrawal or obtain general wallet authority.

The owner retains control and can revoke unused nonce authorizations. Prepared material is constrained to the expected network, position, destination, programs, accounts, instruction sequence, amount, signer set, and fee policy. Exact bytes are inspected and simulated before approval.

### Permit Vault

Permit Vault is the least-privilege readiness authority for signed protection material. It does not hold browser-wallet private keys and does not grant arbitrary transaction authority. Protection readiness and evidence observation remain separate responsibilities.

## User flow

1. Connect and authenticate a Solana wallet.
2. Kelvara discovers supported positions and verified control mappings.
3. Indexers continuously normalize protocol and governance evidence.
4. Safeguards and Governance explain current control state and activity.
5. For supported positions, the owner can pre-authorize and later submit a constrained protected exit.

Wallet authentication proves wallet control for the session. It does not authorize a transaction.

## Security invariants

### Wallet safety

- **Non-custodial:** wallet secrets remain in the wallet.
- **Authentication is not transaction consent:** `signMessage` cannot authorize activation or evacuation.
- **Explicit protection opt-in:** monitoring enrollment does not silently enable pre-signing.

### Evidence integrity

- **Fail closed:** unknown, stale, mismatched, or unavailable evidence is not presented as safe.
- **Canonical evidence:** Observation Hub is authoritative; UI state cannot bypass ingestion and evaluation.
- **Verified governance targets:** no wildcard or inferred multisig mappings.
- **Least privilege:** dedicated credentials per producer and read scope.

### Network and execution safety

- **Exact network scope:** wallet sessions, evidence, mappings, and actions are network-bound.
- **Exact-byte validation:** prepared and signed transactions are checked before submission.
- **No automatic retry of uncertain financial actions:** ambiguous submission state requires review.
- **Mainnet isolation:** Devnet demo authorities and test assets cannot authorize Mainnet mutation.

## Live review

### Public app

- Application: [https://app.kelvara.xyz/](https://app.kelvara.xyz/)

Without a wallet, verify that network catalogs are explicitly scoped and wallet-specific Portfolio, Governance, Safeguards, and Protection data remains unavailable.

### Authenticated Mainnet walkthrough

1. Select **Mainnet** and connect the intended wallet.
2. Review and sign the one-time authentication message.
3. Open **Positions** to inspect eligible supported positions.
4. Open **Governance** to inspect linked Squads activity.
5. Open **Safeguards** to inspect status, source evidence, history, and freshness.
6. Open **Protection** to inspect readiness and the separate transaction-approval boundary.

### Devnet Demo

A bounded Devnet environment is under development for reproducible incident scenarios using no-value test assets. It is isolated from Mainnet and cannot authorize Mainnet mutation. Incomplete activation, incident, or evacuation steps are not represented as complete.

## Local deployment

### Requirements

- Docker Engine with Docker Compose
- Required scoped service credentials and RPC configuration
- Access to the configured Permit Vault dependency

Secrets, keypairs, permit bundles, runtime databases, and logs must remain outside Git.

### Start

```bash
git clone https://github.com/kelvara-labs/kelvara-platform.git
cd kelvara-platform

# Configure required endpoints and scoped credentials outside Git.
docker compose \
  --profile kamino \
  --profile squads \
  up -d --build
```

Optional public tunnel:

```bash
docker compose \
  --profile kamino \
  --profile squads \
  --profile cloudflared \
  up -d --build
```

### Verify

```bash
docker compose -p kelvara-v3 ps
curl --fail http://127.0.0.1:18437/healthz
curl --fail 'http://127.0.0.1:18437/api/catalog?network=mainnet-beta'
curl --fail http://127.0.0.1:18090/healthz
```

| Local surface | URL |
|---|---|
| Application | `http://127.0.0.1:18437/index.html` |
| Status page | `http://127.0.0.1:18090/` |
| Control Center health | `http://127.0.0.1:18651/health/live` |
| Observation Hub readiness | `http://127.0.0.1:18711/health/ready` |
| Kamino diagnostics | `http://127.0.0.1:18270/health/live` |
| Squads diagnostics | `http://127.0.0.1:18272/health/live` |
| Velocity diagnostics | `http://127.0.0.1:18273/health/live` |

Admin and diagnostics ports bind to loopback by default. The internal backend network is not externally routable.

## Testing

```bash
cd services/program-backend
npm test
npm run check
```

Service tests are colocated with each service. High-risk behavior has focused coverage for wallet and network session isolation, public catalogs, governance mappings, safeguard evaluation, Permit Vault projection, protection lifecycle, transaction constraints, and indexer ingestion.

Docker health proves service availability, not the complete wallet or signing journey. Review evidence should record both container health and the exact browser and wallet boundaries exercised.

## Service map

| Component | Responsibility | Trust boundary |
|---|---|---|
| `ui/` | Public catalog and authenticated workspace | Browser; no server credentials |
| `program-backend` | UI hosting, wallet sessions, portfolio projection, safeguards, protection APIs | Public application edge |
| `control-center` | Verified mappings, baselines, enrollment, readiness, operator and auditor policy | Internal control plane |
| `observation-hub` | Canonical evidence, governance actions, receipts, freshness | Internal evidence authority |
| `indexer-kamino` | Kamino and Solana observations | Read-only producer |
| `indexer-squads` | Squads assignments and finalized governance lifecycle | Read-only producer |
| `indexer-velocity` | Transaction velocity and activity observations | Read-only producer |
| `solana-transport` | Solami gRPC live streams and Helius RPC query/recovery path | External chain transport |
| `status-page` | Independent service-health history | Loopback operations surface |
| Permit Vault | Signed permit and readiness authority | External least-privilege dependency |

## Repository map

```text
.
├── compose.yaml
├── ui/                           # application UI snapshot
├── services/
│   ├── program-backend/          # app edge, portfolio, safeguards, protection
│   ├── control-center/           # mappings, enrollment, baselines, readiness
│   ├── observation-hub/          # canonical evidence store and APIs
│   ├── indexer-kamino/           # Kamino observations
│   ├── indexer-squads/           # Squads governance observations
│   ├── indexer-velocity/         # transaction activity observations
│   ├── solana-transport/         # gRPC and RPC transport abstraction
│   ├── status-page/              # operational health surface
│   └── contracts/                # shared provider-neutral contracts
├── governance-attack-lab/        # bounded governance scenario tooling
└── docs/architecture/            # public architecture visual
```

## Core contracts

Kelvara services communicate through versioned, provider-neutral contracts rather than UI-shaped JSON. Important definitions include:

- [`target-contract-v2.js`](services/contracts/src/target-contract-v2.js) — canonical monitored-target identity.
- [`control-map-v1.js`](services/contracts/src/control-map-v1.js) — verified position-to-control mapping.
- [`governance-control-v1.js`](services/contracts/src/governance-control-v1.js) — current effective governance control.
- [`governance-action-v1.js`](services/contracts/src/governance-action-v1.js) — governance proposal and execution evidence.
- [`wallet-safeguard-policy.js`](services/contracts/src/wallet-safeguard-policy.js) — wallet-scoped safeguard policy.
- [`wallet-safeguard-receipt.js`](services/contracts/src/wallet-safeguard-receipt.js) — evaluated safeguard result and provenance.
- [`ingestion-contract.js`](services/contracts/src/ingestion-contract.js) — producer ingestion boundary.

## Current scope and limitations

- Supported protocols and positions are allowlisted, not universal.
- Mainnet portfolio and safeguards require an authenticated wallet session.
- Current live safeguard coverage is the approved Squads signer set and approval threshold for verified supported mappings.
- Provider freshness and availability can degrade; the UI preserves `unknown` and `unavailable` states.
- Public Solana RPC endpoints are unsuitable for sustained production polling.
- The bounded Devnet Demo wallet lifecycle remains under active implementation.
- This code and its tests are not a security audit.

## Evidence vocabulary

- **Live:** observed from the configured current source within its freshness policy.
- **Cached/stale:** previously observed, outside freshness policy.
- **Historical:** real past evidence, not a current guarantee.
- **Replay/fixture:** deterministic demonstration evidence, never represented as live.
- **Unknown:** insufficient or conflicting evidence.
- **Unavailable:** an expected source or service could not answer.

## License

No open-source license is granted by this repository unless a license file explicitly states otherwise.

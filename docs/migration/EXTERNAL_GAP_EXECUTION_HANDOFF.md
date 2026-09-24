# Rust replacement external-gap execution handoff

This handoff is bound to the source-baseline candidate commit
`161d54f603152c95411beb7fc9a7ab79919ffe8d` on
`codex/full-rust-replacement-progress-20260916`. It is an executable packet
for evidence that cannot be produced by a local source checkout. This file's
source-status table and ledger hash describe that historical baseline, not the
current implementation. For live status use the existing
[command map and generated ledger](NODE_RUST_GAP_CLOSURE.md) and
[runtime implementation](../rust/RUNTIME_MIGRATION_IMPLEMENTATION.md).
It does not mark a route implemented, accepted, activated or retired.
The current single-maintainer policy supersedes historical human-review language:
no independent human reviewer is required for repository integration.

## Source-baseline branch evidence and current consolidation policy

The source-baseline branch was equal locally and remotely when captured. The
following full-history inventory is the historical `161d54f...` baseline, not a
live branch count. The current two-tree policy retains original Node `main` and
`codex/full-rust-replacement-progress-20260916`; the
[branch consolidation record](BRANCH_CONSOLIDATION.md) supplies the
pre-cleanup decisions, source archive and separate post-cleanup ref observation.
Removing names does not replace those decisions with a new zero-gap claim.

The historical baseline inventory is:

```text
candidateCommit=161d54f603152c95411beb7fc9a7ab79919ffe8d
candidateTree=977a19fc6c34aafeb61401cd08f318d97641b219
branchCount=228
same_tree=0
ancestor=50
diverged=178
unresolvedBranchCount=178
branchAuditSha256=sha256:71b81a581d5c2556d1dfa95fc51bf553618171a7a1fc55c9e7cc20ed1d40f006
```

Run the read-only audit from a full-history checkout:

```sh
python3 docs/tools/audit-branch-convergence.py --candidate HEAD
```

Every divergent branch needs an owner, a disposition (`absorb`, `supersede`,
`retain_reference` or `reject`), the complete two-tree change list and review
evidence. Preserve those records after branch-name deletion. A digest-shaped
value is not behavioral evidence. The maintainer may make these source decisions;
source consolidation does not itself prove runtime/external effects.

## Historical source-baseline migration state

The command map contains 57 Node routes. All 57 have an explicit Rust
candidate or bounded fail-closed boundary, so `unmapped=0`; every row remains
`partial_local_source`. Independently accepted parity is 0, production
activation is false and Node retirement is false. The generated ledger is
bound to:

```text
sha256:a17f247de8d257d757dfbc488944686e51c444dd9d5367551dbba2a29384b8ca
```

A bounded Rust preflight is evidence about inputs and safety boundaries. It is
not evidence that a provider, signer, portal, target host or production writer
performed the missing action. Full-production readiness now preserves ambient
`HEPTA_PAPER_ASSET_ROOT`/`HEPTA_PAPER_RUNTIME_ROOT` before applying a pinned
deployment-environment file, and the standalone operational/owner verifier CLIs
follow the incumbent environment/default-root resolution. These changes improve
local behavior parity but do not create external acceptance.

## Historical package scope; current machine authority boundaries remain

| Scope | Existing local Rust boundary | Required external package | Required acceptance evidence |
|---|---|---|---|
| `maintenance/autonomous-state-provision` | Ten-role manifest, machine/topic/dataset identity and stable plan preflight; execute is fail-closed. | Machine-intake authority, private staging root, writer fence and schema manifest. | Ten-repository atomic install, inventory/schema/handoff receipts, crash cleanup and independent owner review. |
| `maintenance/autonomous-state-partial-root-maintenance` | Partial-root, rescue-root, database identity and quiescence inspection; invalid SQLite observations remain blocked. | Production-shaped root, drained writer, lease/fence authority and rollback target. | Retry/cancel/process-death matrix, atomic rescue publication and post-recovery inventory. |
| `maintenance/autonomous-online-schema-transition` | Native signed readiness, planning, normalization, installation and finalization primitives. | Target configuration restart, durable receipt store and linearizable external authority. | Ten-database replay, WAL/crash recovery, final receipt publication and independent target-host qualification. |
| `operator/autonomous-research` and `operator/autonomous-research-one-shot-campaign-attempt` | Strict identity/configuration parsing and read-only campaign/dataset preflights. | Provider credentials, execution fence, dataset authority, budget/lease service and recovery host. | Positive/negative/replay corpus, bounded-cost receipt, crash/retry recovery and provider canary. |
| `operator/autonomous-submission-dispatcher` and `operator/autonomous-supervisor` | Challenge/storage and resident-health observations without external effects. | Handoff database, portal account, credentials, service manager and executor authority. | Delivery/cancel/retry/canary evidence, signal/restart recovery, queue drain and no-clobber receipts. |
| `operator/autonomous-intake-authority-rotation` | No-follow/hash preflight for next-generation configuration and rotation root. | Key custody, governance approval, authority generation CAS and target runtime. | Signed rotation/revocation receipt, expiry/rollback matrix and independent owner approval. |
| `operator/autonomous-empirical-plugin-release` and `operator/advanced-numerical-plugin` | Template/input inspection and bounded reference candidates; no signer or install. | Plugin registry, signing custody, runtime image, sandbox and GPU/CPU target host. | Package/hash/signature lineage, install/rollback, oracle/replay/uncertainty and hardware evidence. |
| `operator/strict-full-auto-acceptance` and `operator/full-production-readiness` | Strict parser, input identity and fail-closed gate composition. | Owner acceptance families, release attestor/KMS, off-host WORM and deployment target. | Exact plan/execute/converge/adopt matrix, fresh readiness package, canary/soak/recovery and owner sign-off. |
| `operator/submission-handoff-export` and portal qualification | Bounded request, release-lineage and local-layout inspection. | Current campaign release, reviewed submission authority, artifact root, portal credentials and destination. | Authority-bound export, publication/recovery receipt, portal canary and independent review. |
| `verify/critical` and `verify/full` | Static target/inventory reports; Rust never starts Node/npm and remains blocked for parity. | Full CI runner, all declared Node suites, retained raw receipts and production SQLite copy. | Non-empty candidate CI, complete failure matrix, exact full-suite receipt and independent parity decision. |
| Personal GPU/formal and nested runtime routes | Local receipt/hash/provenance verification and fail-closed readiness. | Real hardware, container/runtime image, formal runner and external authority. | Fresh process-isolated CPU/GPU/formal receipts, host identity, replay and independent qualification. |
| Release, owner, operational and retirement routes | Read-only hash/manifest/status projections and conservative blocked decisions. | Release signing/key custody, owner/operations identities, archive host and deletion authority. | Signed release/owner/operations evidence, archive replay, protected deletion drill and explicit retirement approval. |

## Required handoff packet

An external collector must return one immutable packet containing:

1. Candidate commit and tree, branch-audit hash, current remote ref snapshot,
   pre-cleanup ref/archive bindings and the historical branch disposition-plan
   hash from the consolidation record.
2. Target host identity, pinned compiler/runtime/container images and exact
   workspace cleanliness/provenance.
3. Authority identities, key IDs, roles, credential custody and revocation
   evidence. Secret material must not enter the repository or packet.
4. Input manifests and content hashes for runtime, dataset, provider, portal,
   release and submission artifacts.
5. Positive, negative, malformed, limit, timeout, cancellation, crash and
   replay receipts for every selected mode.
6. Maintainer-selected semantic evaluation and actual operational-owner evidence
   bound to the same candidate. A local hash does not establish a runtime effect;
   no second human approver is required.

The packet must state whether each effect was read-only, local mutation,
external action or network action. A blocked or missing external package must
never be converted into a green production report.

## Local checks before accepting a packet

Run these checks on the exact candidate after the packet is collected:

```sh
node docs/tools/validate-development-docs.mjs
node docs/tools/validate-module-documentation.mjs
python3 docs/rust/tools/validate-program-truth.py
node docs/tools/generate-node-rust-gap-report.mjs --check
python3 docs/tools/audit-branch-convergence.py --candidate HEAD
```

The command map, gap ledger and program-truth record must be updated from the
verified packet. Until that happens, the current status remains 57 partial
routes, zero independently accepted parity rows, no production activation and
no Node retirement.

# Rust replacement external-gap execution handoff

This handoff is bound to candidate commit
`f2f594c30812e45215d918ad011558fb818bf751` on
`codex/full-rust-replacement-progress-20260916`. It is an execution packet
for evidence that cannot be produced by a local source checkout. It does not
mark a route implemented, accepted, activated or retired.

## Current source and branch evidence

The local and remote refs were compared after refreshing all 228 remote
branches. The candidate branch itself is byte-identical at both ends, but the
candidate is not the same tree as every historical branch:

```text
branchCount=228
same_tree=1
ancestor=49
diverged=178
unresolvedBranchCount=178
branchAuditSha256=sha256:ed42edfd977377cb4a871d2295aa7b52480c628638c78a7e281937ac07c2ae00
```

The audit command is read-only and must be run from a full-history checkout:

```sh
python3 docs/tools/audit-branch-convergence.py --candidate f2f594c30812e45215d918ad011558fb818bf751
```

Every divergent branch needs an owner, a decision (`absorb`, `supersede`,
`retain_reference` or `reject`), the complete two-tree change list and an
independent review-evidence digest. A digest-shaped value does not constitute
review. Until that plan exists, `independentReviewVerified` remains false and
no branch is merged or treated as accepted.

## Route handoff matrix

The 14 routes below remain `unmapped` in
`docs/migration/node-rust-command-map.v1.json`. Each row names the evidence
package required before a Rust implementation can be called a replacement.

| Route | Local blocker | External execution package | Acceptance evidence |
|---|---|---|---|
| `operator/autonomous-intake-authority-rotation` | No Rust source-bound machine-intake rotation chain | Owner-scoped intake authority, key custody, rotation/revocation and target runtime | Signed rotation receipt, replay/expiry/rollback matrix, independent owner review |
| `operator/autonomous-research` | No campaign prepare/launch/status/resume/converge call chain | Provider credentials, campaign runtime, lease/budget authority and recovery target | Differential campaign state machine, crash/retry receipts, provider canary and target-host review |
| `operator/autonomous-research-one-shot-campaign-attempt` | No one-shot execution/fence/replay implementation | Isolated provider environment, execution fence, sealed attempt inputs and external authority | Positive and terminal replay corpus, process-death recovery, bounded cost receipt |
| `operator/strict-full-auto-acceptance` | No complete immutable acceptance plan/live/adopt chain | Owner acceptance families, release attestor/KMS, off-host evidence and runtime adoption authority | Exact plan/execute/converge/adopt mode matrix, independent acceptance and no-authority negative tests |
| `operator/autonomous-empirical-plugin-release` | No plugin package/sign/release source chain | Empirical plugin registry, signing custody, runtime image and release repository | Package tree/hash/signature lineage, install/recovery/rollback receipts, independent review |
| `operator/autonomous-submission-dispatcher` | No resident dispatcher lifecycle or provider-effect chain | Handoff store, portal account, credentials, leases and external executor | Canary, delivery, retry/cancel, crash recovery, no-clobber and provider receipts |
| `operator/autonomous-submission-dispatcher-challenge` | No portal descriptor/cycle/canary/trust verifier in Rust | Public portal descriptor, dispatcher identity, challenge exchange, independent portal authority and handoff DB | Signed cycle fixture matrix, expiry/tamper/symlink/race negatives, independent canary verification |
| `operator/autonomous-supervisor` | No resident process, scheduling or external-action journal implementation | Target host service manager, instance/cycle leases, machine intake and provider canary | Cold start, pause/resume, signal, crash/restart, queue drain and external-action recovery evidence |
| `maintenance/autonomous-state-provision` | No source-bound ten-database fresh provisioner | Machine-intake/profile/dataset inputs, private staging root, writer authority and schema manifest | Plan identity, ten repository atomic install, inventory/schema/handoff receipts and failure cleanup |
| `maintenance/autonomous-state-partial-root-maintenance` | No rescue-root, quiescence, fencing or crash recovery chain | Production-shaped root, writer drain, authority/fence and rollback target | Lease/retry/cancel/process-death matrix, atomic filesystem receipt and post-recovery inventory |
| `verify/critical` | Node runs isolated production copy, V8 coverage and ~300+ suites | Full test host, production SQLite copy, legacy reference archive and 30-minute child budget | Non-empty candidate CI, coverage thresholds, raw child receipts and independent review |
| `operator/full-production-readiness` | No complete readiness composition | Real model principals, providers, release attestor, off-host WORM and target deployment | Fresh readiness package, canary/soak/recovery evidence and owner acceptance |
| `operator/submission-handoff-export` | No authority-bound release consumer or no-clobber exporter | Current campaign release, reviewed submission authority, artifact root and export destination | Request verification, release lineage, bundle publication/recovery receipts and independent review |
| `verify/full` | Rust tests do not certify the full Node suite | Full CI runner, all declared Node suites and artifact retention | Exact candidate full-suite receipt, non-empty CI and independent parity decision |

## Required handoff packet

An external collector must return one immutable packet containing:

1. Candidate commit and tree, branch-audit hash, remote ref snapshot and
   disposition-plan hash.
2. Target host identity, pinned compiler/runtime/container images and exact
   workspace cleanliness/provenance.
3. Authority identities, key IDs, roles, credential custody and revocation
   evidence. Secret material itself must not enter the repository or packet.
4. Input manifests and content hashes for runtime, dataset, provider, portal,
   release and submission artifacts.
5. Positive, negative, malformed, limit, timeout, cancellation, crash and
   replay receipts for every selected mode.
6. Independent reviewer/owner evidence bound to the same candidate; a local
   receipt or a matching hash alone is insufficient.

The packet must record whether each effect was read-only, local mutation,
external action or network action. No Rust route may convert a blocked or
missing external package into a green production report.

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
verified packet. Until then the current status remains 43 partial routes, 14
unmapped routes, zero independently accepted parity rows, no production
activation and no Node retirement.

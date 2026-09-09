# hepta-paper global development status

This is a committed **static status projection** for the complete system. It
records current implementation, planned architecture, and known blockers. It
does not qualify or activate its own commit.

## Historical audit provenance

```text
repository  TrillionniumFoundation/hepta-paper
audited ref codex/rust-plan-v4-rc1-20260831
commit      b664b43c8caf0fa8513deee0bf3e7a9935afc4d8
tree        3f4dd3dfc59785410bd98c190f65d184829dce11
audit date  2026-09-01
```

The block above records the historical 2026-09-01 audit, not the current source
head. The current runtime migration candidate is indexed in
[`../rust/RUNTIME_MIGRATION_IMPLEMENTATION.md`](../rust/RUNTIME_MIGRATION_IMPLEMENTATION.md).
Its exact branch/commit/tree must obtain fresh exact-subject workflow evidence
and independent review; the historical provenance cannot qualify this tree.

## Current authority ceiling

```text
current campaign/control authority    existing Node control plane under its current gates
Rust local/shadow service             executable source candidate
qualified Rust production composition root absent
Rust campaign-writer activation       disabled
real Codex credentials/provider calls forbidden until independent qualification
release/KMS/HSM/WORM authority         absent from repository and control plane
portal/submission authority            absent from repository and control plane
```

No development document, source implementation, hosted workflow, fixture key,
or repository administrator prose changes this ceiling.

## Current source and qualification disposition

The current tree contains executable local/shadow service composition, real Node
hash and database compatibility checks, a persistent control sequencer, concrete
broker dispatch, and durable cooperative cutover/rollback mechanics. These are
source results; accepted production composition and complete Node business
replacement remain open.

The historical RC review identified incomplete base/merge identity and eligible
run-attempt history in the older qualification subject. Qualification Subject V3
source now exists: `qualification_subject_v3.py` and
`qualification_subject_integrity.py` bind and validate those identities;
`derive_effective_status_v2.py` and `verify_effective_status_v2_current.py`
produce and revalidate the V3-bound artifact. The dedicated V3 workflows execute
`run-qualification-subject-v3.sh`, including raw collection/projection checks.

`QUAL-001` through `QUAL-005` remain conservative machine-truth acceptance items.
Their open status must not be described as proof that the V3 code is absent.
Closure still needs the full current producer matrix, retained raw evidence,
live V3 currentness and independent exact-candidate review. A green legacy
`source-qualification-current` check alone does not establish the V3 subject.

## Global machine-truth inventory

The current documentation candidate defines:

```text
capabilities             29
registered/planned modules 32
global work items         72
scoped Rust backlog items 75
milestone gates           11
global risks              26
canonical workloads       15
global capability evidence bindings 29
scoped Rust capability evidence bindings 126
```

Counts come from the global truth records and scoped Rust program-truth
validator respectively: 72 global work items and 75 scoped Rust backlog items
are different inventories. Detailed Rust source items remain in the scoped Rust
backlog and machine projection rather than becoming a second global status source.

## Capability state summary

| Area | Static implementation | Effective qualification | Activation |
|---|---|---|---|
| current Node campaign and automation control | source implemented | existing scoped gates | authoritative |
| Rust broker/runtime/workspace/writer components | source implemented | fresh exact-subject requalification required | disabled |
| global machine truth and documentation controls | source implemented | fresh exact-subject qualification required | disabled as governance authority |
| module protocol, registry, SDK and conformance | typed policy-owned registry, prepared-effect source slice, and bounded Node legacy execution adapter implemented; full capability inventory/SDK/conformance pending | fresh exact-subject qualification required | disabled |
| Rust central composition root | runnable local/shadow CLI and durable plan-to-commit composition; module remains `design_ready`; qualified production composition absent | fresh exact-subject and host/capability qualification required | disabled |
| global scheduler/optimizer | bounded exact selection, deterministic fallback and replayable certificate source implemented; full optimizer port/calibration pending | fresh exact-subject qualification required | disabled |
| hierarchical DRF/aging/reservation model | current Node governor plus Rust weighted dominant-share, aging and exact reservation/accounting source slice | full canonical workload qualification pending | disabled for Rust control |
| performance qualification | design ready | no exact-host baseline | disabled |
| team-scale ownership | design ready | real GitHub teams not provisioned | current single-reviewer policy retained |
| release/submission verification ports | source implemented | external packages absent | external actions disabled |

## Executable local/shadow migration candidate

The current source composes the module, control-plane and service crates:

```text
hepta-module-platform
hepta-control-plane
hepta-paper-service
```

They implement a policy-owned module registry, canonical candidate and prepared
result values, immutable planning snapshots, hard policy, bounded exact/fallback
selection, hierarchical resource admission, dependency-wave execution,
independent artifact-byte/prepared-result verification, a persistent single-writer
sequencer, explicit native/process worker boundaries, and preflighted bounded
events. SQLite commit persists result, receipt, campaign revision and resource
accounting together; replay uses durable records. Integration executes:

```text
snapshot -> plan -> reserve -> execute waves -> verify -> commit -> release
```

Runnable local service, real Node/Rust compatibility fixtures and cutover drills
are described in the runtime implementation document. This remains source
implementation, not accepted production composition; local commands do not load
real credentials or authorize external actions, and keep
`automatic_activation=false` and `production_activation=false`. G2 through G6
remain open for their unimplemented work items and exact-subject qualification.

## External blockers

| ID | Missing independently controlled fact |
|---|---|
| `GAP-GOV-003` | protected-main policy export, seven denial probes, and independent exact-candidate decision |
| `LEGACY-REPLAY-001` | retained secret-gated 263-file hosted replay and independent acknowledgement |
| `GAP-HOST-001` | target-host listener, schema, gate, systemd, and cgroup qualification |
| `GAP-HOST-002` | destructive storage, reboot, corruption, and 72-hour production-topology soak |
| `GAP-KEY-001` | independent key lifecycle, revocation, rollback, and compromise drills |
| `GAP-CODEX-001` | separated authenticated Codex author/reviewer canaries under real credential custody |
| `GAP-REL-001` | real KMS/HSM, immutable-storage, release, portal, and submission receipts |

## Documentation convergence state

The candidate working tree now has:

- one global entry point at `docs/README.md`;
- one global plan, architecture, status, backlog, invariant, risk, milestone, and
  traceability center under `docs/system`;
- strict machine records and schemas for capabilities, modules, work, milestones,
  risks, workloads, evidence bindings, and current-document policy;
- current scoped Node and Rust projections rather than competing global truth;
- active ADRs, module/control-plane/performance/qualification/security contracts;
- no retained `paper-core/docs/history` tree, dated P0 status, Rust checkpoint,
  trigger note, fragmented evidence-policy note, or obsolete Codex document;
- Git history, issues, pull requests, and retained artifacts as the audit archive.

These are source changes only. G1 remains open until the resulting exact tree
passes its required workflows and independent review.

## Next closure order

1. Commit the runtime/documentation candidate on its dedicated branch and obtain its
   fresh exact base/head/merge identity.
2. Run the documentation graph validator, Rust program-truth checks, source and
   supply-chain gates, and all required exact-head workflows.
3. Requalify the existing Qualification Subject V3 implementation with the complete
   producer, raw-collection, projection and live-currentness matrix to close G0.
4. Integrate the qualified documentation tree into the single product
   convergence surface without reusing predecessor artifacts.
5. Complete remaining G2 SDK/conformance work and qualify production composition
   from the runnable G3 local/shadow service, including live identities and adapters.
6. Complete G4 hierarchy/starvation qualification, G5 capability migration, and the remaining G6 Pareto/optimizer/calibration work.
7. Provision G7 team ownership and exact-host performance evidence.
8. Complete G8 external packages, then G9 shadow/canary/rollback and G10 atomic
   authority transfer/Node retirement.

## Local validation entry points

```bash
node docs/tools/validate-development-docs.mjs
python3 docs/rust/tools/validate-program-truth.py
npm run scripts:check
npm run security:source-gate
npm run release:state-check
```

The full locked test matrix, exact-head workflow evidence, and required
independent review remain authoritative over local results.

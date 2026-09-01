# hepta-paper global development status

This is a committed **static status projection** for the complete system. It
records current implementation, planned architecture, and known blockers. It
does not qualify or activate its own commit.

## Audit provenance

```text
repository  TrillionniumFoundation/hepta-paper
audited ref codex/rust-plan-v4-rc1-20260831
commit      b664b43c8caf0fa8513deee0bf3e7a9935afc4d8
tree        3f4dd3dfc59785410bd98c190f65d184829dce11
audit date  2026-09-01
```

The documentation rebuild produces a different commit and tree. Its live branch
identity must be read from GitHub and must obtain fresh exact-subject workflow
evidence and latest-head review. The provenance above is not qualification for
the rebuilt tree.

## Current authority ceiling

```text
current campaign/control authority    existing Node control plane under its current gates
Rust production composition root      absent
Rust campaign-writer activation       disabled
real Codex credentials/provider calls forbidden until independent qualification
release/KMS/HSM/WORM authority         absent from repository and control plane
portal/submission authority            absent from repository and control plane
```

No development document, source implementation, hosted workflow, fixture key,
or repository administrator prose changes this ceiling.

## Latest Rust RC disposition

The audited Rust RC contains substantial repository-local implementation for
protocols, broker/journal, durable launch, workspace authority, compatibility,
read-only control, campaign writer, evidence ingestion, and cutover fencing.
It is not accepted as current source-qualified evidence because the latest
independent review still requires:

1. exact base repository/ref/commit/tree and tested synthetic merge commit/tree
   to participate in eligibility, schemas, snapshot identity, artifacts, and
   live revalidation;
2. the complete eligible workflow run/attempt history to participate in the
   snapshot so a later rerun of an older run cannot be ignored after a newer run
   exists.

`QUAL-001` through `QUAL-005` and Qualification Subject V3 own this G0 closure.
Historical green artifacts or superseded approvals cannot be reused.

## Global machine-truth inventory

The current documentation candidate defines:

```text
capabilities             29
registered/planned modules 32
global work items         72
milestone gates           11
global risks              26
canonical workloads       15
capability evidence bindings 29
```

Detailed Rust source items remain in the scoped Rust backlog and machine
projection rather than being duplicated as a second global status source.

## Capability state summary

| Area | Static implementation | Effective qualification | Activation |
|---|---|---|---|
| current Node campaign and automation control | source implemented | existing scoped gates | authoritative |
| Rust broker/runtime/workspace/writer components | source implemented | fresh exact-subject requalification required | disabled |
| global machine truth and documentation controls | source implemented | fresh exact-subject qualification required | disabled as governance authority |
| module protocol, registry, SDK and conformance | design ready | none | disabled |
| Rust central composition root | design ready | none | absent |
| global scheduler/optimizer | design ready | none | disabled |
| hierarchical DRF/aging/reservation model | design ready; current Node capacity governor is partial | none | disabled |
| performance qualification | design ready | no exact-host baseline | disabled |
| team-scale ownership | design ready | real GitHub teams not provisioned | current single-reviewer policy retained |
| release/submission verification ports | source implemented | external packages absent | external actions disabled |

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

1. Commit the documentation candidate on its dedicated branch and obtain its
   fresh exact base/head/merge identity.
2. Run the documentation graph validator, Rust program-truth checks, source and
   supply-chain gates, and all required exact-head workflows.
3. Close G0 by implementing Qualification Subject V3 and rerun the complete
   producer/effective/currentness matrix.
4. Integrate the qualified documentation tree into the single product
   convergence surface without reusing predecessor artifacts.
5. Implement G2 module protocol/registry/conformance and G3 Rust composition.
6. Implement G4 resource fairness, G5 capability migration, and G6 optimizer.
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

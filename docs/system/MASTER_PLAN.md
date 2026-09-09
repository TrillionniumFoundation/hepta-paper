# Hepta Global Development Plan 1.1

Status: **static development plan**
Applies to: the complete `hepta-paper` system
Rust migration subplan: `docs/rust/RUST_REWRITE_MASTER_PLAN.md`
Machine truth: `docs/system/truth/program.v2.json`

## 1. Mission

Build `hepta-paper` as a modular, concurrent research-and-paper production
system in which independently owned modules can improve rapidly while one small
central control plane preserves global correctness, resource discipline,
evidence quality, and authority separation.

The target is not a collection of mutually unaware local optimizers. Each module
may optimize its internal implementation, but it must expose a bounded set of
feasible candidates, costs, uncertainty, and evidence requirements. The central
control plane selects and integrates candidates against a single system snapshot
and a versioned global objective.

The program is successful when dozens of engineers can work primarily inside
one home module without acquiring write access to unrelated state, without
coordinating every internal change with every other team, and without weakening
the global scheduler, single-writer, evidence, recovery, or external-authority
boundaries.

## 1.1 Plan 1.1 hardening delta

Plan 1.1 closes documentation-design gaps found by the second full audit:

- all global truth records now have strict schemas with closed object shapes;
- every capability and module has reciprocal executable work-item traceability;
- capability-specific evidence bindings connect contracts, implementation,
  validation, workflow contexts, workloads, and external blockers;
- milestone implementation state is separate from closure state and every open
  gate remains visible in `program.v2.json`;
- every risk names affected milestones and every work item belongs to at least
  one milestone;
- committed module truth records qualification requirements only; effective
  qualification remains derived after commit;
- the Node current-status projection is bounded to current facts rather than a
  dated incident journal;
- delivery, module-template, traceability, and milestone contracts are explicit.

These are source-implemented documentation controls. G1 remains open until this
new tree passes exact-subject checks and independent review.

## 2. Non-negotiable outcomes

1. Exactly one authoritative campaign-state commit sequencer exists at a time.
2. Modules outside the sequencer return prepared effects; they do not commit
   authoritative campaign state directly.
3. Every execution plan binds one immutable state snapshot, candidate set,
   constraint set, objective version, module-version set, and plan hash.
4. Hard safety, authority, evidence, budget, and resource constraints are never
   converted into soft optimizer penalties.
5. Modules submit feasible alternatives or a justified singleton candidate;
   local preference is not global authority.
6. Module-reported utility is advisory. Independent evaluators recompute actual
   outcome, cost, evidence, and policy compliance.
7. CPU, GPU, memory, storage, token, provider, external-action, and central-writer
   capacity are admitted before use and reconciled afterward.
8. Waiting work has a bounded starvation policy. Continuous small work cannot
   indefinitely suppress large or scarce-resource work.
9. Provider execution, scientific verification, campaign writing, release,
   immutable-storage custody, and submission use distinct authority domains.
10. Every irreversible external action has durable intent and an idempotency key
    before execution, followed by authoritative reconciliation after ambiguity.
11. Historical bytes, hashes, receipts, schemas, and campaign state remain
    verifiable across Node-to-Rust migration.
12. A source document, test fixture, repository administrator, or model process
    cannot self-promote production or external-authority status.
13. Every module has a primary owner, secondary owner, independent reviewer,
    version policy, rollback version, SLO, and conformance evidence.
14. The repository retains only current development documents and active ADRs;
    Git history is the sole archive for superseded plans and snapshots.

## 3. Program model

The program is managed through five independent state dimensions:

| Dimension | Meaning |
|---|---|
| implementation | whether reviewed source and tests exist |
| qualification | which environment and authority produced accepted evidence |
| activation | whether a version is disabled, shadowing, canarying, authoritative, or retired |
| operation | whether the active instance is healthy, degraded, blocked, or unknown |
| compatibility | whether behavior is exact, semantic, evaluation-based, or intentionally retired |

No single word such as “done” or “ready” may collapse these dimensions.
`source_qualified` does not mean activated. `target_host_qualified` does not mean
release-authorized. A module can be implemented and healthy in shadow mode while
remaining forbidden from authoritative writes.

## 4. Target operating model

```text
immutable state/read-model snapshot
              |
              v
hard policy and authority constraints
              |
              v
module candidate requests
              |
              v
validated Pareto candidate frontier
              |
              v
global planner / optimizer
              |
              v
admission and multi-resource allocation
              |
              v
isolated module execution plane
              |
              v
prepared result + content-addressed artifacts
              |
              v
independent result and evidence verification
              |
              v
single-writer commit sequencer
              |
              v
event log + projections + calibration feedback
```

The expensive and heterogeneous work is parallel. Only the final authoritative
state transition is serialized. This preserves exactly-once integration without
turning the whole system into a single-threaded application.

## 5. Workstreams

### SYS — global program truth and architecture

Own the system architecture, capability graph, invariants, state dimensions,
document manifest, milestone closure rules, and cross-subsystem consistency.

Exit criteria:

- every production capability has one stable ID;
- every capability resolves to one or more registered module implementations;
- no active document claims a competing global source of truth;
- all status projections are validated against machine truth.

### MOD — module protocol, registry, lifecycle, and SDK

Define module identity, capability declarations, protocol ranges, authority
classes, candidate/result envelopes, health and SLO reports, conformance tests,
version compatibility, rollout, rollback, and retirement.

Exit criteria:

- an independently developed module can be registered and exercised by the
  conformance kit without importing central implementation code;
- invalid, expired, unqualified, or incompatible module versions fail closed;
- module manifests cannot grant themselves authority.

### CTL — Rust central control-plane composition

Create the production composition root that combines snapshot construction,
policy, candidate collection, planning, admission, dispatch, verification,
reconciliation, and commit sequencing.

Exit criteria:

- a fake-provider end-to-end path completes
  `snapshot → candidates → plan → execute → prepare → verify → commit`;
- no business module has a direct central-writer handle;
- identical inputs produce an identical plan hash or bind an explicit random seed.

### SCH — global planning and optimization

Define global objectives, candidate normalization, dependency and deadline
constraints, solver interface, deterministic fallback, plan explanation,
optimality evidence, online calibration, and champion/challenger evaluation.

Exit criteria:

- fixed finite workloads can produce a model-global optimum or a recorded gap;
- optimizer timeout or failure produces a safe deterministic fallback;
- hard constraints remain invariant under every solver implementation.

### RES — resource allocation, fairness, and backpressure

Replace capacity-only first-fit behavior with hierarchical admission across
campaigns and modules, dominant-resource fairness, aging, reservations, quota,
deadline inheritance, circuit breakers, and side-effect-aware preemption.

Exit criteria:

- no canonical workload starves;
- oversubscription and unreserved usage remain zero;
- resource loss aborts or reclassifies work before stale integration;
- large GPU/memory jobs receive bounded progress under sustained small-job load.

### PERF — performance, capacity, and SLO qualification

Establish canonical workloads and exact-host performance evidence for planner,
queue, broker, writer, recovery, resource utilization, fairness, quality, and
cost calibration.

Exit criteria:

- every performance claim binds source, binary, configuration, host, workload,
  measurement method, and threshold version;
- module-local and system-wide regression budgets are enforced;
- safety invariants remain zero-tolerance rather than statistical SLOs.

### OBS — observability and calibration

Define bounded, privacy-preserving event, trace, metric, and outcome schemas that
allow the planner to calibrate duration, cost, quality, and failure predictions
without storing prompt, credential, manuscript, or secret content unnecessarily.

Exit criteria:

- every plan, reservation, execution, prepared result, verification, and commit
  is correlated by stable IDs and hashes;
- high-cardinality data has an explicit budget and retention rule;
- prediction error can be measured independently per module version.

### ORG — team ownership and development governance

Establish home modules, secondary ownership, independent review, CODEOWNER
provisioning, change classes, RFC/ADR rules, release trains, and escalation.

Exit criteria:

- ordinary module implementation changes do not require a single global reviewer;
- protocol, authority, writer, objective, and qualification changes receive
  cross-team review;
- no module has a single-person merge or operational bus factor.

### Existing implementation workstreams

The existing FND, BRK, WS, CMP, RO, MVP, DB, EVD, REL, and CUT workstreams remain
active as implementation/migration substreams. They do not replace the global
SYS/MOD/CTL/SCH/RES/PERF/OBS/ORG ownership model.

## 6. Milestone gates

| Gate | Outcome | Required evidence |
|---|---|---|
| G0 | Current RC qualification identity is sound | exact base/head/merge subject and complete run-history invalidation |
| G1 | Global truth and documentation are singular | manifest-valid docs; no historical development files in the working tree |
| G2 | Module protocol and registry are executable | schemas, SDK bindings, conformance kit, ownership and version rules |
| G3 | Central control-plane vertical slice works | deterministic fake-provider end-to-end plan and commit |
| G4 | Concurrency and resource model are qualified | fairness, backpressure, starvation, crash and scale workloads |
| G5 | Node capabilities are wrapped behind module contracts | no new direct cross-layer authority; differential evidence retained |
| G6 | Global optimizer is qualified | hard-constraint proof, fixed-workload optimum/gap, safe fallback |
| G7 | Organization can scale | team CODEOWNERS provisioned; module CI and review policy operational |
| G8 | Production prerequisites are independently qualified | governance, legacy replay, host, storage, key, Codex, release and submission packages |
| G9 | Shadow and canary complete | production-shaped comparison, rollback and no dual writer |
| G10 | Rust control plane becomes authoritative | atomic writer transfer and Node authority retirement evidence |

A date, percentage, source presence, or successful local fixture never replaces a
gate. Each gate closes only from its named evidence and reviewer domain.

## 7. Delivery sequence

1. Close the active RC qualification defects without broadening its scope.
2. Establish the global machine truth and documentation validator.
3. Freeze capability IDs and register the current Node and Rust implementations.
4. Define module protocol V1 and generate language bindings.
5. Build a Rust production composition root around existing safe crates.
6. Introduce multi-resource admission and commit sequencing before a complex
   optimizer; correctness and starvation bounds precede optimality.
7. Wrap Node capabilities as out-of-process or explicitly trusted in-process
   modules, one capability at a time.
8. Establish canonical workloads and baseline performance on named hosts.
9. Add global optimization over bounded candidate frontiers with a deterministic
   fallback.
10. Provision team ownership and CODEOWNER groups before broad contributor scale.
11. Complete external host, credential, key, storage, release, and submission
    qualification.
12. Run shadow, canary, rollback, atomic cutover, and final Node-authority
    retirement.

## 8. Change rules

Every production-relevant pull request states:

```text
change class
exact base/head identity
affected capability and module IDs
authority gained and authority retained elsewhere
protocol and compatibility impact
resource and performance impact
failure/recovery and rollback behavior
test, benchmark, evidence, and reviewer requirements
status and document-manifest impact
```

A change that cannot identify its capability, module, owner, and rollback is not
ready for implementation review.

## 9. Stop conditions

Development, qualification, rollout, or activation stops when:

- a required identity cannot be proven;
- the state snapshot or candidate set changes without re-planning;
- a module requests undeclared resources or authority;
- an unclassified result could be committed;
- a second campaign writer or release authority becomes reachable;
- a failure residue has no deterministic reconciliation;
- an optimizer output violates a hard constraint;
- a performance claim lacks an exact workload and host subject;
- a module has no active owner or rollback version;
- a local fixture would have to impersonate an external authority;
- a historical document would have to be treated as current truth.

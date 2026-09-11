# Executable Rust migration: implementation and acceptance boundaries

This document records the current repository-local Rust implementation. It is a
source implementation record, not a production qualification receipt. Exact-head
workflow evidence, independent review and separately controlled deployment
authority remain required before production activation.

## Current implementation map

| Layer | Repository-local implementation | Source disposition |
|---|---|---|
| Module protocol / SDK / conformance | `rust/crates/hepta-module-platform` implements canonical protocol envelopes, candidates, SDK, registry, lifecycle, conformance and legacy adapter | implemented source |
| Planning snapshot | `rust/crates/hepta-orchestration-kernel/src/snapshot.rs` | implemented source |
| Candidate/Pareto routing | module-platform Pareto reduction plus orchestration `router.rs` integer-only Pareto routing | implemented source |
| Global bounded planning | `rust/crates/hepta-control-plane/src/planner.rs` exact bounded optimization, deterministic fallback and recomputable `PlanCertificateV1` | implemented source |
| Hierarchical resources | control-plane and orchestration resource ledgers with generation fencing and recovery | implemented source |
| Telemetry / performance qualification | orchestration telemetry plus exact-subject canonical workload qualification | implemented source; target-host evidence separate |
| Node hash compatibility | actual Node production hash/serializer oracle plus Rust compatibility kernel | implemented source |
| Node SQLite compatibility | actual migration ledger 1–25 validation and Node-compatible logical report | implemented source |
| Durable Rust writer | generation-fenced SQLite campaign writer and atomic control journal | implemented source |
| Control execution | persistent sequencer, exact replay, independent artifact-byte verification | implemented source |
| Runnable Rust service | registry/policy/planning/admission/dispatch/verify/commit composition | implemented local/shadow source |
| Broker | authenticated request contract, durable journal, pre-exec gate, containment and bounded output validation | implemented source; real credentials/host authority external |
| Native business kernel | author, reviewer, formal, empirical, numerical, build and submission-package preparation | implemented source |
| Cutover / retirement | cooperative writer fencing, backup/restore, quiescence proof and forward-only retirement contract | implemented source; production cutover external |

The implementation map deliberately separates **source present** from **source
qualified**, **target-host qualified**, **external-authority qualified** and
**production activated**.

## Native business capability closure

The first-party native kernel in `hepta-paper-service` now contains a closed,
bounded Rust protocol for:

- deterministic manuscript assembly;
- deterministic structural review;
- bounded formal proof-certificate checking;
- finite empirical aggregation;
- deterministic numerical linear solving;
- deterministic build/package generation;
- deterministic submission-package preparation.

These workers produce prepared artifacts and evidence only. They have no campaign
writer, provider, portal, release or submission authority. The submission worker
specifically cannot perform an external action; real submission remains behind the
independently authorized external port.

This means the previous statement that author/reviewer/empirical/formal/numerical/
build capabilities had no Rust implementation is obsolete. Remaining work for
those capabilities is parity corpus/replay, exact-head qualification and
production rollout evidence, not absence of a native source entry point.

## Planning and optimization closure

The Rust control stack already provides the repository-local source required for
the planning path:

```text
snapshot -> candidate collection/Pareto reduction -> hard policy
         -> bounded exact optimizer or deterministic fallback
         -> PlanCertificate -> resource reservation
         -> dependency-wave execution -> independent verification
         -> durable commit/release
```

`PlanCertificateV1` binds the exact snapshot, frontier, hard policy, planner
policy, objective version, selected IDs, resources, cost, objective, solver mode,
fallback reason and plan hash. Exact mode reports zero optimality gap; candidate
sets beyond the exact bound take a deterministic, dependency-aware fallback.

The separate orchestration router implements integer-only eligibility, Pareto
frontier reduction, deterministic scoring and tie-breaking. The resource ledger
implements hierarchical cumulative limits, generation fencing, prepare/commit/
finalize/cancel transitions and conservative restart disposition. Canonical
performance qualification binds source commit/tree, binary, configuration and
host-profile identities and never grants production authority by itself.

## Node compatibility and state boundary

Rust reads and verifies the real Node migration-ledger schema through version 25,
including production-compatible logical hashes. This is used for compatibility,
migration and immutable archive verification.

The Rust campaign writer intentionally has a different native schema. Full
replacement does **not** require keeping a retired Node runtime able to interpret
arbitrary future Rust-only state. The accepted retirement architecture is:

1. finish capability and state parity before authority transfer;
2. drain all legacy runtime work and prove the exact Node database quiescent;
3. retain the exact schema-25 database as an immutable historical archive;
4. keep Rust-native read-only inspection for that archive;
5. atomically transfer writer ownership to the qualified Rust stack;
6. allow incumbent rollback only before the first authoritative Rust commit;
7. after the first Rust commit, recover forward from Rust state so no committed
   Rust record is erased by restoring a stale Node database.

`hepta-cutover::retirement` implements the immutable freeze/quiescence receipt and
encodes this rollback disposition. Cooperative same-database fencing remains the
mechanical handoff tool while legacy writers are enrolled and drained.

## Provider and external-effect boundary

The broker and local service do not contain a permissive production authority
adapter. Real Codex/provider execution requires separately controlled credential
custody, target-host identity, gate/containment qualification and live canaries.
Likewise KMS/HSM/WORM, release, portal and submission actions remain external
authority facts.

A schema-valid worker response, repository administrator statement or fixture key
cannot promote itself across those boundaries.

## Reproducible repository-local checks

Representative source checks include:

```sh
cargo test --manifest-path rust/Cargo.toml --locked \
  -p hepta-module-platform \
  -p hepta-orchestration-kernel \
  -p hepta-control-plane \
  -p hepta-paper-service

cargo test --manifest-path rust/Cargo.toml --locked \
  -p hepta-legacy-compatibility \
  -p hepta-readonly-store \
  -p hepta-campaign-writer \
  -p hepta-cutover

node docs/tools/validate-development-docs.mjs
node docs/tools/validate-module-documentation.mjs
python3 docs/rust/tools/validate-program-truth.py
```

The complete exact-head workflow matrix remains authoritative over these local
commands. A changed candidate needs fresh evidence for its exact immutable head.

## Remaining repository-local work versus external gates

The source audit distinguishes two classes of remaining work.

### Repository-local convergence

- align machine truth and human projections with source that is already present;
- ensure every native capability is bound into the module/capability evidence map
  and exact-head tests;
- run complete parity/replay corpora for the new native business and planning
  surfaces;
- prove no production composition path can silently select a Node bridge after
  the Rust-only cutover configuration is chosen;
- retain explicit Node-entrypoint retirement inventory and deletion/disable proof
  as part of the final cutover package.

### Independently controlled production evidence

The repository cannot manufacture these facts:

- current protected-main governance/denial evidence and independent decision;
- private historical archive replay acknowledgement;
- target Linux host/systemd/cgroup/listener qualification;
- destructive storage/reboot/corruption/soak evidence;
- key lifecycle and compromise drills;
- authenticated real provider author/reviewer canaries;
- KMS/HSM/WORM/release/portal/submission receipts;
- production-shaped shadow/canary/rollback and final writer authority transfer.

Those items remain open until their real owners produce accepted evidence.

## Completion rule

“Rust source replacement complete” means every repository-local production
capability has a native Rust implementation or an explicitly retired behavior,
all compatibility/cutover source contracts exist, no hidden Node fallback is
possible in the Rust-only composition, and the exact candidate passes the full
source/parity evidence matrix.

“Rust production replacement complete” is stronger: all target-host and external
authority prerequisites are accepted, production shadow/canary/rollback succeeds,
writer authority transfers atomically, and every Node writer/production entrypoint
is disabled or removed with retained evidence. The second state cannot be claimed
from repository source alone.

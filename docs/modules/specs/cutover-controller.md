# module.cutover-controller

Status: normative module specification  
Manifest: [`../manifests/cutover-controller.v1.json`](../manifests/cutover-controller.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.cutover-controller
implementationKind: trusted_in_process
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: prepared_result_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-KERNEL
secondaryOwnerTeam: TEAM-STATE
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Prepare and fence shadow, canary, rollback, writer-transfer, and retirement transitions while preventing dual authority.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- current and candidate implementation subjects
- shadow/canary evidence
- writer/external authority leases
- rollback target

Outputs:

- fenced transition proposal
- cutover/rollback/retirement receipt
- dual-authority denial evidence

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

## Dependencies

Hard registered module dependencies:

- `module.compatibility-kernel`
- `module.commit-sequencer`

Current implementation and contract roots:

- `rust/crates/hepta-cutover`
- `paper-adapters/migration/rust-cutover-fence.mjs`
- `paper-adapters/persistence/sqlite-store.mjs`

## Concurrency and resources

Uses the caller's bounded executor and declares maximum inflight work, queue depth, result bytes, CPU/memory budget, blocking boundary, and cancellation point in the qualified deployment profile. It may not create an unbounded pool or consume undeclared provider, GPU, storage, or network capacity.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject incomplete parity, stale evidence, unavailable rollback, in-flight ambiguity, writer-generation mismatch, or any reachable dual-authority state. Failure before transfer leaves the incumbent authoritative; failure after transfer invokes fenced rollback/reconciliation.

## Security and privacy

Cutover capabilities are short-lived, exact-subject, and audience-bound. The controller never owns provider/release secrets and cannot bypass the sequencer.

## Compatibility and migration

Every transition binds incumbent/candidate versions, state and protocol readers, rollback version, and the exact disposition of in-flight/prepared work.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

## Operational runbook

Use the [durable cutover owner and runbook](../../../rust/crates/hepta-cutover/README.md)
and the [Node drain/forward-recovery contract](../../rust/LEGACY_NODE_DRAIN_AND_FORWARD_CUTOVER.md).
Before transfer stop new admissions, identify every enrolled writer and reconcile
prepared or externally uncertain work. Bind the current database preimage,
writer generation and exact replacement subject; a declaration in this spec is
not the transfer capability.

After a lost transfer reply, query the durable cutover journal before either
writer runs. An unknown result is not a reason to retry transfer blindly. After
the first Rust commit, preserve all newer records: returning writer ownership
is not restoring an old Node database backup. A schema-incompatible reverse
migration requires a separately reviewed route. Only after reboot/recovery tests
prove Node cannot reacquire authority may an owner record Node retirement.

The disposable regression is
`cargo test --manifest-path rust/Cargo.toml --locked -p hepta-cutover --test durable_cutover`.
It is a local recovery test, not execution of a production cutover.

## Verification and evidence

Capability bindings: `CAP-MIG-CUTOVER`. Related work identifiers: `MIG-005`, `MIG-006`. Implementation/contract roots: `rust/crates/hepta-cutover`, `paper-adapters/migration/rust-cutover-fence.mjs`, `paper-adapters/persistence/sqlite-store.mjs`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Runtime migration implementation details

See the [durable cutover protocol, Node fencing and runbook](../../../rust/crates/hepta-cutover/README.md). It specifies the append-only SQLite state journal, persisted file identities, monotonic writer epochs, mandatory initial maintenance enrollment, Node StorePort enforcement, scoped canary, exact shadow comparisons, SQLite backup/restore and subprocess crash/concurrency tests. The runnable disposable drill preserves Rust-era committed records when returning ownership to a new Node epoch.

Local drill receipts remain nonproduction. Production canary uses the existing independently signed writer authorization and exact database preimage. Production expansion, reverse-schema compatibility and production rollback remain unqualified; restoring an old backup over newer committed records is not a supported rollback.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `MIG-005` — `source_implemented`
- `MIG-006` — `source_implemented`

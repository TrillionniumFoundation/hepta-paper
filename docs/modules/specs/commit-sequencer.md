# module.commit-sequencer

Status: normative module specification  
Manifest: [`../manifests/commit-sequencer.v1.json`](../manifests/commit-sequencer.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.commit-sequencer
implementationKind: host_service
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: central_state_write
qualificationRequirement: target_host
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-STATE
secondaryOwnerTeam: TEAM-KERNEL
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Provide the sole authoritative campaign-state commit path, validating fenced prepared results and returning idempotent durable receipts.

It does not perform long-running scientific/provider work or own release/submission credentials. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- verified prepared result
- expected campaign/node revisions
- writer and lease generations
- resource settlement identity

Outputs:

- committed/already-committed/stale/conflict receipt
- hash-linked authoritative event

## State and authority

Maximum authority class: `central_state_write`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It is a logical single-writer boundary for its state domain. Raw writable handles are never exposed; writer generation, expected revision, idempotency, and fencing are mandatory.

Declared side-effect classes: `central_commit`.

## Dependencies

Hard registered module dependencies:

- `module.policy-engine`

Current implementation and contract roots:

- `rust/crates/hepta-campaign-writer`
- `docs/control-plane/COMMIT_SEQUENCER.md`
- `rust/crates/hepta-control-plane/src/commit.rs`

## Concurrency and resources

Runs as a role-specific service with bounded listeners/workers, queue depth, file descriptors, CPU, memory, storage, and deadlines. Startup/recovery capacity is reserved separately. Backpressure is machine-readable, and every accepted operation is linked to a reservation or a documented control-plane exemption.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject stale revisions, attempts, leases, plans, reservations, verifier identities, writer generations, or conflicting idempotency. Unknown residue disables admission; exact duplicates return the original receipt.

## Security and privacy

Only the sequencer owns the writable campaign connection. Writer leases and generations prevent stale or dual writers; callers receive no raw database handle.

## Compatibility and migration

Command, event, receipt, and database schema versions are explicit. Rollback is restore/migration based and cannot reopen terminal commands.

## SLO, capacity, and observability

Track p50/p95/p99 latency, maximum queue age/depth, throughput, timeout/fallback rate, recovery time, and all zero-tolerance safety counters. Canonical workload and threshold versions are bound in the deployment evidence; source documents do not invent production numbers.

## Operational runbook

This module is not an independently writable operator database tool. The
[control-plane sequencer](../../../rust/crates/hepta-control-plane/README.md)
opens the [campaign writer](../../../rust/crates/hepta-campaign-writer/README.md)
and submits verified batches through its existing owner. Do not use a SQLite
shell to alter revisions, leases, resource charges or commit receipts.

Before admission check campaign state, writer generation, expected revision and
current lease. Revalidate time after the actual SQLite write lock and before
COMMIT through `append_control_batch_with_clock`. After a lost reply query the
persisted operation identity: exact duplicates replay their receipt; conflicting
reuse is rejected. Preserve prepared bytes and the original batch after a late
clock or transaction failure. A cancelled campaign cannot be reopened to force
a commit. Native schema-25 and local HPCW stores are distinct contracts; do not
copy one over the other.

For local workflows use the service's `status` and `hepta-local-maintenance`
inspection/backup/recovery commands in [the workflow runbook](../LOCAL_WORKFLOW_HANDOFF.md).
Production writer transfer requires the separate qualified cutover owner; these
commands are not a production activation procedure.

## Verification and evidence

Capability bindings: `CAP-STATE-COMMIT`. Related work identifiers: `CTL-007`, `GAP-HOST-002`. Implementation/contract roots: `rust/crates/hepta-campaign-writer`, `docs/control-plane/COMMIT_SEQUENCER.md`, `rust/crates/hepta-control-plane/src/commit.rs`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Runtime migration implementation details

See the [persistent control commit contract](../../../rust/crates/hepta-control-plane/README.md) and [campaign writer schema, fencing and recovery contract](../../../rust/crates/hepta-campaign-writer/README.md). These documents specify atomic resource/revision and prepared-result/receipt journal updates, idempotent replay, stale-plan rejection, local database marking, independent signed writer activation and the distinction between native schema 25 and Rust HPCW storage. The source implementation does not imply native-to-HPCW migration or target-host qualification.

## Rollout and rollback

Current channel is `disabled`. Promotion follows disabled → shadow/read-only comparison → bounded canary → authoritative, with an exact rollback version and atomic mutual-exclusion fencing. A failed or ambiguous canary stops admission and invokes reconciliation before rollback; dual authority is forbidden.

## Open blockers

- `CTL-007` — `source_implemented`
- `GAP-HOST-002` — `blocked_external`
- Effective `target_host` evidence remains deployment/external-subject specific and cannot be committed as static success.

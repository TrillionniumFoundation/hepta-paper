# module.node-control-plane

Status: normative module specification  
Manifest: [`../manifests/node-control-plane.v1.json`](../manifests/node-control-plane.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.node-control-plane
implementationKind: legacy_in_process
staticImplementationState: source_implemented
staticActivation: authoritative
authorityClass: central_state_write
qualificationRequirement: target_host
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

Operate the current authoritative Node campaign, automation, preparation, verification, and integration graph under existing gates during migration.

It does not perform long-running scientific/provider work or own release/submission credentials. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- campaign commands and external triggers
- current Node configuration
- qualified runtime and store adapters

Outputs:

- campaign events and projections
- prepared/integrated results
- operator and external-action receipts

## State and authority

Maximum authority class: `central_state_write`. Current static activation: `authoritative`. The registry declaration is a ceiling and request, not an authority grant. It is a logical single-writer boundary for its state domain. Raw writable handles are never exposed; writer generation, expected revision, idempotency, and fencing are mandatory.

Declared side-effect classes: `central_commit`.

## Dependencies

Hard registered module dependencies:

- No hard module dependency.

Current implementation and contract roots:

- `workflow-kernel`
- `paper-domain`

## Concurrency and resources

Uses the incumbent Node runtime's bounded worker, storage, and provider controls. Migration/shadow work has separate quotas and cannot starve authoritative traffic or create hidden child concurrency. Resource use is reported in the common settlement format.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Preserve existing campaign fencing, prepared-result integration, external-action journals, startup reconciliation, and fail-closed release gates. Migration failures cannot weaken the incumbent path.

## Security and privacy

Retain current least-privilege composition, role separation, workspace fencing, release/submission gates, and no Rust authority before accepted cutover.

## Compatibility and migration

Node behavior remains the compatibility oracle until each capability's parity class, shadow/canary evidence, cutover, and retirement are accepted.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-STATE-COMMIT`, `CAP-STATE-READ`, `CAP-EXE-DISPATCH`, `CAP-AUTHOR`, `CAP-REVIEW`, `CAP-FORMAL`, `CAP-EMPIRICAL`, `CAP-NUMERICAL`, `CAP-BUILD`, `CAP-SUBMIT`. Related work identifiers: `NODE-001`. Implementation/contract roots: `workflow-kernel`, `paper-domain`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.


The current `runPaperCampaign` implementation accepts an explicit versioned
resource-envelope policy captured by
`paper-application/automation/campaign-resource-envelope.mjs`. It must match the
hash in the stored campaign definition before any claims; declared nodes reserve
parent and child capacity in both global and campaign-local governors. An active
policy forbids undeclared and same-scope recursive nested-agent entry. For legacy as well as explicitly configured callers, the engine
joins wrapped agent and empirical-cell calls in one bounded scope before preparing
a successful parent result and drains
them before handling parent failure or returning reservations. Both child callbacks
recheck cancellation after awaited gates; suppressed lease-loss events cannot
permit a prepared parent result. Heartbeat setup/cleanup failures do not skip
logical reservation cleanup, and those failures are not converted to success. Escaped ongoing
work causes a failed, unprepared parent rather than an early completed node.
The original budget, side-effect, workspace and commit gates remain responsible
for their own acceptance; the resource policy grants none of their authority.

`paper-core/tests/campaign-resource-envelope.test.mjs` tests the actual engine
with real SQLite campaign state and local, non-model callbacks. It covers
policy identity, admission, gated nested execution, delayed-child settlement,
shutdown and sibling joining. `paper-core/tests/campaign-child-lifetime.test.mjs`
adds empirical/mixed child settlement, final-gate cancellation, lease-loss and
monitor failure controls. These are not production provider or target-host
qualification. The exact configuration and non-claims are in
[`RESOURCE_MODEL.md`](../../control-plane/RESOURCE_MODEL.md#15-explicit-campaign-integration-and-joined-nested-execution).

## Rollout and rollback

Current channel is `authoritative`. Promotion follows disabled → shadow/read-only comparison → bounded canary → authoritative, with an exact rollback version and atomic mutual-exclusion fencing. A failed or ambiguous canary stops admission and invokes reconciliation before rollback; dual authority is forbidden.

## Open blockers

- `NODE-001` — `source_implemented`
- Effective `target_host` evidence remains deployment/external-subject specific and cannot be committed as static success.
- Explicit envelope routing is implemented for the in-process engine only; default operator rollout, persistent multiprocess envelopes, per-cell physical admission, arbitrary unregistered background work and target-host evidence remain unclosed. Qualification, activation, and operation remain separate.

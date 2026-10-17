# module.execution-dispatcher

Status: normative module specification  
Manifest: [`../manifests/execution-dispatcher.v1.json`](../manifests/execution-dispatcher.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.execution-dispatcher
implementationKind: trusted_in_process
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: prepared_result_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-RUNTIME
secondaryOwnerTeam: TEAM-KERNEL
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Translate admitted plan actions into identity-bound execution commands, route them to qualified modules, and classify cancellation and ambiguous outcomes.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- admitted action
- reservation lease
- qualified module identity
- workspace/artifact and cancellation identities

Outputs:

- execution command and ordered events
- prepared result or conservative ambiguity
- resource-use observation

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

## Dependencies

Hard registered module dependencies:

- `module.codex-broker`
- `module.workspace-authority`

Current implementation and contract roots:

- `docs/control-plane/COMPOSITION_ROOT.md`
- `docs/control-plane/REPLAN_AND_RECOVERY.md`
- `rust/crates/hepta-control-plane`
- `rust/crates/hepta-codex-broker/src/codex_dispatch.rs`

## Concurrency and resources

Uses the caller's bounded executor and declares maximum inflight work, queue depth, result bytes, CPU/memory budget, blocking boundary, and cancellation point in the qualified deployment profile. It may not create an unbounded pool or consume undeclared provider, GPU, storage, or network capacity.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject stale plans/reservations, incompatible module versions, expired commands, conflicting idempotency, unsafe cancellation, missing workspace identity, or unclassified post-effect failure. Timeouts never prove non-execution.

## Security and privacy

Commands carry least-privilege audiences and exact expiry. The dispatcher cannot mint credentials or broaden module authority.

## Compatibility and migration

Support declared protocol ranges and explicit cancellation/result dispositions. Unknown future terminal events fail closed.

## SLO, capacity, and observability

Track readiness, admission/dispatch latency, busy and rejection rates, queue depth, crash/restart reconciliation, prepared-result durability, cleanup time, and identity/security violations. Identity violations and duplicate effects are zero-tolerance.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-EXE-DISPATCH`, `CAP-MOD-EXECUTION`. Related work identifiers: `CTL-005`, `MOD-003`. Implementation/contract roots: `docs/control-plane/COMPOSITION_ROOT.md`, `docs/control-plane/REPLAN_AND_RECOVERY.md`, `rust/crates/hepta-control-plane`, `rust/crates/hepta-codex-broker/src/codex_dispatch.rs`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Runtime migration implementation details

See the [control-plane execution and prepared-result contract](../../../rust/crates/hepta-control-plane/README.md) and [broker dispatch contract](../../../rust/crates/hepta-codex-broker/DISPATCH.md). The local filesystem executor and signed broker dispatcher have different authority envelopes. Prepared result files require bounded real-file verification and exact identity; successful JSON parsing or caller-supplied evidence hashes alone cannot authorize a commit or a provider action.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `CTL-005` — `source_implemented`
- `MOD-003` — `source_implemented`

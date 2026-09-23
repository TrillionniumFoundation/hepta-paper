# module.rust-local-vertical

Status: normative module specification  
Manifest: [`../manifests/rust-local-vertical.v1.json`](../manifests/rust-local-vertical.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.rust-local-vertical
implementationKind: trusted_in_process
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: prepared_result_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-KERNEL
secondaryOwnerTeam: TEAM-WORKSPACE
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Exercise a non-production local Rust author-review-build vertical across broker, workspace, read-only state, verification, and sequenced commit ports.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- fixture registry and campaign
- fake author/reviewer modules
- local workspace and sequencer
- no-external-effect policy

Outputs:

- non-production end-to-end receipt
- prepared and commit hashes
- resource and event reports

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

## Dependencies

Hard registered module dependencies:

- `module.codex-broker`
- `module.workspace-authority`
- `module.readonly-control`
- `module.commit-sequencer`

Current implementation and contract roots:

- `rust/crates/hepta-local-vertical`

## Concurrency and resources

Uses the caller's bounded executor and declares maximum inflight work, queue depth, result bytes, CPU/memory budget, blocking boundary, and cancellation point in the qualified deployment profile. It may not create an unbounded pool or consume undeclared provider, GPU, storage, or network capacity.

## Determinism and optimization contract

Declared class: `bounded_nondeterministic`. Output content may vary, but schemas, authority, tools, resources, side effects, quality metrics, and evidence requirements are hard bounded. Predictions are advisory and actual outcomes feed a separately versioned calibration process.

## Failure, recovery, and idempotency

Reject any configuration that enables production activation, real provider credentials, external effects, or direct writer bypass. Fixture failure leaves all source authority flags false.

## Security and privacy

Use only fixtures/fake providers, temporary workspaces, local non-production sequencer, and explicit false activation flags.

## Compatibility and migration

The fixture protocol is pinned and explicitly non-production. It is retired once the production composition root has equivalent qualified tests.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-MOD-EXECUTION`, `CAP-EVD-VERIFY`, `CAP-AUTHOR`, `CAP-REVIEW`, `CAP-BUILD`. Related work identifiers: `CTL-006`. Implementation/contract roots: `rust/crates/hepta-local-vertical`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Original executable fixture entry

The original local slice is implemented in
[`tests/local_slice.rs`](../../../rust/crates/hepta-local-vertical/tests/local_slice.rs),
not the crate library's version constant. It composes temporary filesystem
materialization, deterministic fake author/reviewer data, a real locally signed
cutover fixture and SQLite writer recovery without duplicate integration. Run
`cargo test -p hepta-local-vertical --test local_slice --locked` from `rust`.
This is distinct from the newer service local workflow and its CLI; it does not
qualify a live model, production installation or incumbent-process shutdown.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `CTL-006` — `source_implemented`

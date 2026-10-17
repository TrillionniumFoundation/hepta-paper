# module.scientific-evidence

Status: normative module specification  
Manifest: [`../manifests/scientific-evidence.v1.json`](../manifests/scientific-evidence.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.scientific-evidence
implementationKind: trusted_in_process
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: read_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-EVIDENCE
secondaryOwnerTeam: TEAM-FORMAL
independentReviewerTeam: TEAM-KERNEL
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Validate claim, theorem, empirical, numerical, artifact, and provenance evidence against exact subjects without granting release or submission authority.

It does not mutate campaign state, issue external effects, or self-promote evidence. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- claim and artifact identities
- producer/runtime/source provenance
- verification policy
- independent oracle observations

Outputs:

- accepted/rejected evidence result
- reason codes
- evidence hash and non-authority statement

## State and authority

Maximum authority class: `read_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may read only declared projections/artifacts and cannot mutate campaign or external state.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- `module.protocol-kernel`

Current implementation and contract roots:

- `rust/crates/hepta-scientific-evidence`
- `paper-domain/research`

## Concurrency and resources

Uses the caller's bounded executor and declares maximum inflight work, queue depth, result bytes, CPU/memory budget, blocking boundary, and cancellation point in the qualified deployment profile. It may not create an unbounded pool or consume undeclared provider, GPU, storage, or network capacity.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject unbound claims, missing provenance, circular self-verification, invalid artifact hashes, unsupported scientific regimes, stale runtimes, conflicting evidence, or insufficient reviewer independence.

## Security and privacy

Separate producer and verifier domains; prohibit prompt, credential, confidential manuscript, and unrestricted raw-provider content in public receipts.

## Compatibility and migration

Evidence schemas preserve exact producer/runtime/claim identities. New evaluators cannot silently upgrade or reinterpret prior evidence.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-EVD-VERIFY`. Related work identifiers: `CTL-006`. Implementation/contract roots: `rust/crates/hepta-scientific-evidence`, `paper-domain/research`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Concrete Rust composition responsibility

The function compares supplied records and digest sets; it does not recompute scientific artifacts or authenticate a verifier/attestation. Its publicly constructible capsule is not an opaque grant. The detailed contract specifies validation order, hash ordering, assurance-level behavior and the independent adapter responsibilities.

See the [field-level development handoff](../../../rust/crates/hepta-scientific-evidence/HANDOFF.md) for
limits, typed failures, external operation recovery and the actual test scope.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `CTL-006` — `source_implemented`

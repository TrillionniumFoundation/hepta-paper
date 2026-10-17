# module.external-authority-verifier

Status: normative module specification  
Manifest: [`../manifests/external-authority-verifier.v1.json`](../manifests/external-authority-verifier.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.external-authority-verifier
implementationKind: trusted_in_process
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: read_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-RELEASE
secondaryOwnerTeam: TEAM-EVIDENCE
independentReviewerTeam: TEAM-KERNEL
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Verify independently issued host, governance, key, storage, release, portal, and submission evidence packages and their revocation/currentness.

It does not mutate campaign state, issue external effects, or self-promote evidence. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- signed external package
- trust-store generation
- exact subject and authority identity
- revocation/currentness data

Outputs:

- verified/rejected/revoked/expired disposition
- package digest and reviewer decision

## State and authority

Maximum authority class: `read_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may read only declared projections/artifacts and cannot mutate campaign or external state.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- `module.scientific-evidence`

Current implementation and contract roots:

- `rust/crates/hepta-external-authority`

## Concurrency and resources

Uses the caller's bounded executor and declares maximum inflight work, queue depth, result bytes, CPU/memory budget, blocking boundary, and cancellation point in the qualified deployment profile. It may not create an unbounded pool or consume undeclared provider, GPU, storage, or network capacity.

## Determinism and optimization contract

Declared class: `external_observation`. Determinism applies to validation of a frozen external receipt set, not to the external system. Every observation binds authority, time window, generation, request/idempotency identity, and reconciliation provenance.

## Failure, recovery, and idempotency

Reject invalid signatures, wrong audience, expired/revoked authority, generation rollback, subject mismatch, duplicate/forked receipts, missing custody facts, or self-issued acceptance.

## Security and privacy

Trust anchors, authority generations, reviewer identities, expiry, and revocation are explicit. Repository-local fixtures cannot impersonate independent custody.

## Compatibility and migration

Package schemas, signature suites, trust-store generations, and authority kinds are versioned; revoked or unsupported forms remain verifiable as historical rejection.

## SLO, capacity, and observability

Track verification/ingest/reconciliation latency, stale/revoked/duplicate/conflict rates, unresolved ambiguity age, and trust/currentness failures. False acceptance, duplicate external effects, and self-issued promotion are zero-tolerance.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-REL-VERIFY`. Related work identifiers: `REL-001`. Implementation/contract roots: `rust/crates/hepta-external-authority`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Concrete Rust composition responsibility

The wrapper validates explicit fields and delegates signature/subject/nonce/currentness verification to a supplied implementation. It owns no cryptographic verifier, provider transport or anti-replay journal. The detailed contract assigns each field and failure/retry decision to its actual owner; different domain strings alone do not prove independent control.

See the [field-level development handoff](../../../rust/crates/hepta-external-authority/HANDOFF.md) for
limits, typed failures, external operation recovery and the actual test scope.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `REL-001` — `source_implemented`
- No additional repository-local implementation blocker is asserted by this specification; qualification, activation, and operation remain separate.

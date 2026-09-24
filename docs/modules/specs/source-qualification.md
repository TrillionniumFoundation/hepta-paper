# module.source-qualification

Status: normative module specification  
Manifest: [`../manifests/source-qualification.v1.json`](../manifests/source-qualification.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.source-qualification
implementationKind: trusted_in_process
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: read_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-EVIDENCE
secondaryOwnerTeam: TEAM-SRE
independentReviewerTeam: TEAM-KERNEL
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Derive source qualification only for an exact immutable GitHub subject and reject stale, incomplete, or self-issued workflow evidence.

It does not mutate campaign state, issue external effects, or self-promote evidence. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- repository/base/head/merge identities
- workflow definition hashes
- complete eligible run/attempt history
- artifacts and independent review decisions

Outputs:

- qualification subject snapshot
- effective status artifact
- currentness/revalidation disposition

## State and authority

Maximum authority class: `read_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may read only declared projections/artifacts and cannot mutate campaign or external state.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- `module.program-truth`

Current implementation and contract roots:

- `docs/rust/tools`
- `docs/rust/qualification`

## Concurrency and resources

Uses the caller's bounded executor and declares maximum inflight work, queue depth, result bytes, CPU/memory budget, blocking boundary, and cancellation point in the qualified deployment profile. It may not create an unbounded pool or consume undeclared provider, GPU, storage, or network capacity.

## Determinism and optimization contract

Declared class: `external_observation`. Determinism applies to validation of a frozen external receipt set, not to the external system. Every observation binds authority, time window, generation, request/idempotency identity, and reconciliation provenance.

## Failure, recovery, and idempotency

Fail closed on repository/ref/tree drift, incomplete run history, mutable workflow definitions, missing artifacts, stale or conflicting reviews, clock rollback, revoked trust, or any attempt to derive authority from the current producer.

## Security and privacy

Separate evidence producer, mechanical verifier, reviewer, repository administrator, and external authority. Trust material is public verification data only; secret keys never enter artifacts.

## Compatibility and migration

Historical qualification encodings remain verifiable; new subject versions do not reinterpret old evidence. Revalidation binds the current producer set.

## SLO, capacity, and observability

Track verification/ingest/reconciliation latency, stale/revoked/duplicate/conflict rates, unresolved ambiguity age, and trust/currentness failures. False acceptance, duplicate external effects, and self-issued promotion are zero-tolerance.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-QUAL-SOURCE`. Related work identifiers: `GAP-GOV-003`, `QUAL-001`, `QUAL-002`, `QUAL-003`, `QUAL-004`, `QUAL-005`. Implementation/contract roots: `docs/rust/tools`, `docs/rust/qualification`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

The V2 derivation and currentness entrypoints share
`docs/rust/tools/qualification_subject_integrity.py`. Each independently validates
the strict V1 effective-record and V3 subject schemas; a matching source tuple
found in an arbitrary nested object or a caller-supplied status word is not
accepted evidence. CLI inputs are captured once, limited to 16 MiB, and reject
duplicate keys, nonfinite numbers and invalid UTF-8. Existing encoding and hash
domains remain unchanged; previously inconsistent records must be regenerated,
not repaired or normalized into acceptance.

The shared verifier recomputes job, flattened-step, artifact, attempt-history,
selected-run and aggregate hashes. It checks repository/base/head/merge bindings,
unique ordered identities, contiguous attempts for each observed run, canonical
successful nonempty jobs, no failed/incomplete step, and history watermark.
Queued/failed canonical runs, absent earlier attempts and later or same-second
noncanonical updates deny even when an input author recomputes every self-hash.
Maximum accepted collections are 128 producers and 4096 attempts overall; the
strict schema evaluator also retains its own traversal/evaluation budgets.

The V1/V3 pair must agree on pull request, required-check snapshot, required
contexts, producer definitions, exact canonical run/attempt/check-suite/job,
job steps and timestamps. V1 derivation now binds the shared verifier, both V2
entrypoints, V3 collector/runner and schemas in its existing file-digest set.
Those source changes invalidate previously derived evidence. The existing
`test_qualification_subject_v3.py` suite runs these controls in the canonical
qualification runner, including real CLI failure and round-trip checks using
explicitly synthetic test observations.

These are offline consistency checks, not authentication of uploaded records,
proof that no GitHub run was omitted, reviewer approval, or a stable live-state
snapshot. The live collector, exact checkout and byte checks in the V1 revalidator,
fresh V3 comparison and maintainer integration remain required. V2 live
verification still invokes the existing V1 currentness verifier and cannot turn
its failure into success. No module, milestone or production authority is promoted
by these test fixtures. This contributes to QUAL-001..004 without closing G0.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `GAP-GOV-003` — `retired`
- `QUAL-001` — `design_ready`
- `QUAL-002` — `design_ready`
- `QUAL-003` — `design_ready`
- `QUAL-004` — `design_ready`
- `QUAL-005` — `retired`

The retired governance work items describe the removed human approval/staffing
ceremony, not accepted external runtime evidence. See the current
[single-maintainer policy](../../governance/OWNERSHIP_AND_REVIEW.md).

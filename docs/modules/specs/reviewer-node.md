# module.reviewer-node

Status: normative module specification  
Manifest: [`../manifests/reviewer-node.v1.json`](../manifests/reviewer-node.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.reviewer-node
implementationKind: isolated_process
staticImplementationState: source_implemented
staticActivation: authoritative
authorityClass: prepared_result_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-REVIEW
secondaryOwnerTeam: TEAM-EVIDENCE
independentReviewerTeam: TEAM-AUTHOR
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Independently assess exact author outputs against versioned rubrics and evidence, producing read-only review findings and signed/hashed review receipts.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- read-only exact author output
- review rubric and evidence graph
- reviewer runtime identity
- conflict-of-interest policy

Outputs:

- structured findings and severity
- accept/revise/reject recommendation
- independent review receipt

### Implemented Rust structural review

Call `execute_native_business_for_capability_v1(job, "CAP-REVIEW")` with
`NativeBusinessJobV1::ReviewerAssessment`. The
[implementation](../../../rust/crates/hepta-paper-service/src/native_business/reviewer.rs)
checks supplied manuscript bytes against `ReviewPolicyV1`; it does not call an
independent model or verify scientific claims. The wire job uses
`kind: reviewer_assessment`; its policy fields are camelCase
`minimumWordCount`, `requiredHeadings`, `forbiddenMarkers`. Unknown typed fields
are rejected.

The manuscript is nonempty and at most 1 MiB of UTF-8, with newline/tab as the
only permitted control characters. Each rule list has at most 4096 entries;
each entry is nonempty, control-free and at most 512 UTF-8 bytes. Rules are
sorted and deduplicated. Headings are extracted only from lines beginning
exactly `## `, then trimmed; forbidden markers use case-sensitive substring
matching. Word count uses whitespace separation. These are structural rules,
not a Markdown parser or a review-rubric implementation.

One `NativeReviewReportV1` JSON artifact records manuscript hash, word counts,
missing headings, forbidden matches and `accepted`. `NativeReviewerEvidenceV1`
binds its report hash. A valid request with failed review rules returns a valid
report with `accepted=false`; that is distinct from a malformed-request error.
The [business handoff](../NATIVE_BUSINESS_HANDOFF.md) and
[executable examples](../examples/native-business.v1.json) cover actual wire and
output conventions. An accepted structural report cannot act as independent
scientific acceptance or reviewer-principal evidence.

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `authoritative`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

## Dependencies

Hard registered module dependencies:

- `module.node-control-plane`

Current implementation and contract roots:

- `paper-application/automation`
- `paper-domain/research`

Additive Rust implementation roots (the incumbent roots above remain distinct):

- `rust/crates/hepta-paper-service/src/native_business.rs`
- `rust/crates/hepta-paper-service/src/native_business/types.rs`
- `rust/crates/hepta-paper-service/src/native_business/reviewer.rs`

## Concurrency and resources

Runs behind a qualified process/container runner with explicit CPU, memory, PID, storage, deadline, network, token/provider, and optional GPU envelopes. Child concurrency is included in the reservation; overload returns a bounded busy/retry disposition rather than bypassing central admission.

## Determinism and optimization contract

Declared class: `bounded_nondeterministic`. Output content may vary, but schemas, authority, tools, resources, side effects, quality metrics, and evidence requirements are hard bounded. Predictions are advisory and actual outcomes feed a separately versioned calibration process.

## Failure, recovery, and idempotency

Reject mutable author workspaces, hidden author session state, stale subjects, missing rubric/evidence, conflicts of interest, unbounded prose, or recommendations without normalized findings and exact reviewer identity.

The Rust checker returns `NativeBusinessError::Contract` for malformed text,
rule limits or capability mismatch; encoding/output-limit errors produce no
prepared success. A negative assessment remains a replayable report, not a
transport failure to retry until accepted. The pure checker has no review
journal. The service owns prepared bytes and commit replay; reviewed artifact,
policy and attempt identities must stay bound when a caller consumes the report.

## Security and privacy

Use a distinct reviewer principal and private read-only clone; deny author credential/session access and mutation of the reviewed attempt.

## Compatibility and migration

Review rubric, severity taxonomy, recommendation rules, model/runtime, and receipt schema are versioned; old reviews bind the old subject.

## SLO, capacity, and observability

Track admission/start latency, execution duration, success/timeout/cancel rate, resource and cost settlement, output validity, evidence/quality gain, reproducibility, and recovery time. Quality and scientific metrics are versioned by workload and cannot be replaced by repository-wide green CI.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-REVIEW`. Related work identifiers: `REVIEW-001`. Implementation/contract roots: `paper-application/automation`, `paper-domain/research`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Focused Rust verification

Run from the repository root:

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test documented_native_business --test native_bundle_and_binding
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --lib native_business
```

The documented fixture executes the actual structural checker and verifies
repeatable report/evidence; capability and unknown-field controls exercise the
shared typed boundary. Library tests cover deterministic author-to-review
assembly and a positive structural assessment. Negative rule outcomes need
dedicated semantic cases. These commands do not establish live-model evaluation
or author/reviewer principal isolation.

## Rollout and rollback

Current channel is `authoritative`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `REVIEW-001` — `source_implemented`

The static work-item projection above does not establish complete Rust reviewer
replacement. Model review, rubric/severity semantics, conflict-of-interest and
principal isolation, independent evidence recomputation, disagreement/repair
rounds and their crash/cancellation behavior need separately specified and
verified role integration. The supplied-text checker provides none of those
through its `accepted` field.

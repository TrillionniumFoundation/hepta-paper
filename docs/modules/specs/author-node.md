# module.author-node

Status: normative module specification  
Manifest: [`../manifests/author-node.v1.json`](../manifests/author-node.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.author-node
implementationKind: isolated_process
staticImplementationState: source_implemented
staticActivation: authoritative
authorityClass: prepared_result_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-AUTHOR
secondaryOwnerTeam: TEAM-WORKSPACE
independentReviewerTeam: TEAM-REVIEW
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Produce bounded manuscript, code, and revision candidates from exact campaign inputs while retaining no central-state or publication authority.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- exact research/manuscript snapshot
- authoring objective and constraints
- qualified model/runtime
- workspace capability

Outputs:

- draft/revision/code candidate
- mutation inventory
- provenance and predicted quality/cost

### Implemented Rust author slice

The public entry is `execute_native_business_for_capability_v1(job,
"CAP-AUTHOR")` in [native_business.rs](../../../rust/crates/hepta-paper-service/src/native_business.rs).
It accepts `NativeBusinessJobV1::AuthorDraft`; the private
[author implementation](../../../rust/crates/hepta-paper-service/src/native_business/author.rs)
assembles supplied text. It does not invoke an author model. The closed wire job
uses `kind: author_draft` and snake_case `abstract_text` / `reference_keys`;
`ManuscriptSectionV1` contains `heading` and `body`. Unknown typed fields fail.

The title and each heading are nonempty, control-free and at most 512 UTF-8
bytes. There are 1–256 sections with distinct headings. Abstract and each body
are nonempty, at most 1 MiB, and admit newline/tab but no other control characters.
There are at most 4096 distinct reference identifiers of at most 256 ASCII bytes;
references are sorted before rendering. The input text budget is 16 MiB; the
shared dispatcher separately rejects an artifact exceeding 16 MiB, including
rendering overhead.

The return is `NativeBusinessOutputV1`: one Markdown byte artifact and
`NativeAuthorEvidenceV1` with its SHA-256, word/section/reference counts and
`externalActionMayHaveStarted=false`. Word count uses whitespace separation.
No filesystem path, CAS publication or commit receipt is created by this kernel.
The [business handoff](../NATIVE_BUSINESS_HANDOFF.md) and
[executable examples](../examples/native-business.v1.json) define the shared
encoding and direct-call examples; they are not complete service configurations.

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `authoritative`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

## Dependencies

Hard registered module dependencies:

- `module.node-control-plane`

Current implementation and contract roots:

- `paper-application/automation`
- `paper-adapters/automation`

Additive Rust implementation roots (the incumbent roots above remain distinct):

- `rust/crates/hepta-paper-service/src/native_business.rs`
- `rust/crates/hepta-paper-service/src/native_business/types.rs`
- `rust/crates/hepta-paper-service/src/native_business/author.rs`

## Concurrency and resources

Runs behind a qualified process/container runner with explicit CPU, memory, PID, storage, deadline, network, token/provider, and optional GPU envelopes. Child concurrency is included in the reservation; overload returns a bounded busy/retry disposition rather than bypassing central admission.

## Determinism and optimization contract

Declared class: `bounded_nondeterministic`. Output content may vary, but schemas, authority, tools, resources, side effects, quality metrics, and evidence requirements are hard bounded. Predictions are advisory and actual outcomes feed a separately versioned calibration process.

## Failure, recovery, and idempotency

Reject stale inputs, unauthorized tools, context/byte/resource overflow, forbidden credentials, unclassified mutations, malformed output, or results that cannot be linked to exact provenance. Model failure produces a typed non-authoritative result.

The Rust slice returns `NativeBusinessError::Contract` for invalid text,
identities, duplicate headings/references or capability mismatch, and
`OutputLimit` if rendered bytes exceed the dispatcher bound. Encoding failure
returns no accepted prepared output. It owns no durable state: repeating the
same valid kernel input is deterministic. Through the service, dispatch intent,
prepared CAS bytes and commit receipts belong to the existing service executor
and sequencer; a kernel retry is not authorization to repeat a provider call.

## Security and privacy

Use attempt-scoped workspaces, least-privilege tools, separate author credentials, secret redaction, and no access to reviewer or release principals.

## Compatibility and migration

Prompt/model/tool and output schemas are versioned. A changed rubric or generation policy creates a new module version and requalification subject.

## SLO, capacity, and observability

Track admission/start latency, execution duration, success/timeout/cancel rate, resource and cost settlement, output validity, evidence/quality gain, reproducibility, and recovery time. Quality and scientific metrics are versioned by workload and cannot be replaced by repository-wide green CI.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-AUTHOR`. Related work identifiers: `AUTH-001`. Implementation/contract roots: `paper-application/automation`, `paper-adapters/automation`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Focused Rust verification

Run from the repository root:

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test documented_native_business --test native_bundle_and_binding
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test scientific_workflow
```

The documentation target imports the checked-in example and verifies artifact,
evidence, deterministic repeat and wrong-capability/unknown-field refusal. The
workflow target checks a real scientific named output feeding manuscript and
bundle construction, CAS verification and SQLite replay; it does not run an
author model or measure manuscript quality.

## Rollout and rollback

Current channel is `authoritative`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `AUTH-001` — `source_implemented`

The registered static work-item state above describes the incumbent module;
it does not accept full Rust role parity. The native slice still needs an
explicit model/runtime call chain, research/code/revision workflow, independent
quality review, attempt/cancellation and cost reconciliation, and representative
Node-to-Rust role cases before it can replace that role. The scientific worker
can supply an input artifact but does not supply model authorship. Keep these
boundaries separate from target-host and external qualification.

# module.formal-node

Status: normative module specification  
Manifest: [`../manifests/formal-node.v1.json`](../manifests/formal-node.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.formal-node
implementationKind: isolated_process
staticImplementationState: source_implemented
staticActivation: authoritative
authorityClass: prepared_result_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-FORMAL
secondaryOwnerTeam: TEAM-EVIDENCE
independentReviewerTeam: TEAM-REVIEW
```

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

## Mission and non-goals

Run bounded theorem/proof search and certificate checking in qualified formal runtimes, preserving explicit soundness and unsupported-case boundaries.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- formal claim and dependencies
- theorem/prover/runtime identity
- resource budget and seed
- trusted kernel policy

Outputs:

- proof object or bounded failure
- kernel verification receipt
- unsupported/timeout disposition

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

### Rust proof checker and separate Lean adapter

`execute_native_business_for_capability_v1(job, "CAP-FORMAL")` accepts
`NativeBusinessJobV1::FormalCertificate`. The
[closed types](../../../rust/crates/hepta-paper-service/src/native_business/types.rs)
use snake_case `kind` tags: propositions are `atom`, `and`, `implies`; steps are
`assumption`, `and_introduction`, `and_elimination_left`,
`and_elimination_right`, `modus_ponens`. Step indices must refer to an earlier
step. An assumption step must match a declared assumption; the last derived
proposition must equal the requested goal. Duplicate assumptions are rejected.

The [checker](../../../rust/crates/hepta-paper-service/src/native_business/formal.rs)
accepts at most 16384 assumptions and 1–16384 steps. It bounds proposition depth
at 64 and the aggregate visited-node budget at 65536, including derived
propositions. Atom identifiers are bounded to 256 ASCII bytes. Success emits
one `NativeFormalCertificateV1` JSON artifact and `NativeFormalEvidenceV1`, with
proof/certificate hashes and trusted kernel name `hepta_propositional_kernel_v1`.
The [business handoff](../NATIVE_BUSINESS_HANDOFF.md) supplies the executable
example and shared artifact limits.

Lean execution is a different boundary:
`execute_scientific_job_v1(&profile, job, "CAP-FORMAL")` in
[scientific_runtime.rs](../../../rust/crates/hepta-paper-service/src/scientific_runtime.rs),
or the first-party `hepta-scientific-worker` through `WorkerBindingV1::Process`.
A `lean` profile binds the actual tool/runtime file hashes and complete job hash;
it requires `main.lean` and fixes argv to `-o proof.olean main.lean`. Requested
outputs remain explicit. See the [scientific runtime contract](../SCIENTIFIC_RUNTIME_HANDOFF.md)
for the closed profile, file/output bounds, process and named-artifact behavior.
The adapter does not establish kernel audit, axiom policy or Lake dependency
closure merely because the tool exits successfully.

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `authoritative`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- `module.node-control-plane`

Current implementation and contract roots:

- `paper-domain/research`
- `paper-adapters/runtime`

Additive Rust implementation roots (the incumbent roots above remain distinct):

- `rust/crates/hepta-paper-service/src/native_business.rs`
- `rust/crates/hepta-paper-service/src/native_business/types.rs`
- `rust/crates/hepta-paper-service/src/native_business/formal.rs`
- `rust/crates/hepta-paper-service/src/scientific_runtime.rs`
- `rust/crates/hepta-paper-service/src/bin/hepta-scientific-worker.rs`

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

## Concurrency and resources

Runs behind a qualified process/container runner with explicit CPU, memory, PID, storage, deadline, network, token/provider, and optional GPU envelopes. Child concurrency is included in the reservation; overload returns a bounded busy/retry disposition rather than bypassing central admission.

The qualified profile records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, preemption points, affinity/anti-affinity, expected duration/confidence, overload response, and settlement evidence.

## Determinism and optimization contract

Declared class: `seeded`. Reproduction binds the exact input, module/runtime version, configuration, dataset, and explicit seed. Hardware- or solver-dependent variation must remain within a versioned tolerance/evaluation contract and is independently measured.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

## Failure, recovery, and idempotency

Reject unsupported syntax, untrusted kernels, unverifiable proof objects, dependency drift, time/resource exhaustion, or claims outside the prover's declared soundness envelope. Search timeout is not proof failure.

The native checker distinguishes invalid contracts, `ProofInvalid` (wrong rule,
reference or final goal), `ProofLimit`, encoding and output limits. No failed
proof returns an accepted certificate; a pure retry changes no durable state.
For Lean, runtime identity drift, timeout/nonzero exit and invalid output are
separate `ScientificRuntimeError` categories. Scratch is retained and never
adopted automatically. A direct scientific-library call has no durable replay;
service dispatch supplies intent/prepared/commit records and blocks relaunch of
started work lacking a durable prepared result. It must not turn an ambiguous
attempt into a successful or scientifically disproved claim.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

## Security and privacy

Pin prover/kernel/runtime identities, isolate generated code, restrict mounts/network, and distinguish trusted kernel checks from model-generated proof narratives.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Prover, kernel, library, theorem syntax, proof-object, and trust-base versions are bound; cross-version proof reuse requires rechecking.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Track admission/start latency, execution duration, success/timeout/cancel rate, resource and cost settlement, output validity, evidence/quality gain, reproducibility, and recovery time. Quality and scientific metrics are versioned by workload and cannot be replaced by repository-wide green CI.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-FORMAL`. Related work identifiers: `FORMAL-001`. Implementation/contract roots: `paper-domain/research`, `paper-adapters/runtime`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Focused Rust verification

Run from the repository root:

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test documented_native_business
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --lib native_business
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test scientific_runtime
```

The documented kernel checks and library tests exercise the propositional
boundary. The runtime suite exercises shared process/file rejection through
actual Python programs; it does not claim a real Lean execution or independent
proof-kernel qualification. A Lean-equipped acceptance needs its own exact
runtime/dependency subject and representative successful and rejected proofs.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

See the [installed-tool migration lane](../SCIENTIFIC_RUNTIME_HANDOFF.md#mandatory-installed-tool-migration-lane).
The tool-equipped migration lane explicitly executes the Lean integration case with `--include-ignored`: a valid supplied proof produces a retained `.olean`, while an invalid proof fails. The actual pinned executable and source are recorded. This does not establish general proof search, an axiom audit or natural-language equivalence.

## Rollout and rollback

Current channel is `authoritative`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `FORMAL-001` — `source_implemented`

The static work-item projection does not accept complete Rust formal-role
parity. General theorem/proof search, the full incumbent formal workflow,
axiom/library closure, independently checked proof artifacts, model repair
rounds and actual qualified Lean execution remain beyond the bounded kernel
and shared process-adapter evidence described here.

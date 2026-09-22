# module.numerical-node

Status: normative module specification  
Manifest: [`../manifests/numerical-node.v1.json`](../manifests/numerical-node.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.numerical-node
implementationKind: isolated_process
staticImplementationState: source_implemented
staticActivation: authoritative
authorityClass: prepared_result_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-NUMERICAL
secondaryOwnerTeam: TEAM-EMPIRICAL
independentReviewerTeam: TEAM-EVIDENCE
```

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

## Mission and non-goals

Execute qualified numerical plugins with declared equations, domains, tolerances, convergence rules, runtime identities, and independent oracles.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- equations/domains/units
- algorithm and tolerance profile
- runtime/device identity
- independent oracle policy

Outputs:

- numerical artifacts and diagnostics
- convergence/error estimates
- oracle comparison receipt

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

### Three distinct Rust numerical surfaces

1. `execute_native_business_for_capability_v1(job, "CAP-NUMERICAL")` accepts
   `NativeBusinessJobV1::NumericalLinearSolve` (`kind: numerical_linear_solve`).
   The [kernel](../../../rust/crates/hepta-paper-service/src/native_business/numerical.rs)
   requires a finite square matrix/RHS of dimension 1–128 and positive finite
   tolerance. Partial pivoting and back substitution produce one
   `NativeNumericalLinearSolutionV1` JSON artifact plus `NativeNumericalEvidenceV1`;
   the report contains solution, residual infinity norm, tolerance and input
   hash. Tolerance is the pivot-singularity threshold, not a forward-error bound
   or an acceptance threshold imposed on the returned residual.
2. `execute_scientific_job_v1(&profile, job, "CAP-NUMERICAL")` and the first-party
   `hepta-scientific-worker` support `python_numerical` / `r_numerical`. Their
   [scientific runtime contract](../SCIENTIFIC_RUNTIME_HANDOFF.md) binds the exact
   tool, operator-supplied runtime inventory, typed job hash and named outputs.
   They execute a trusted local program, not just the built-in linear solver.
3. [advanced_numerical.rs](../../../rust/crates/hepta-paper-service/src/advanced_numerical.rs)
   exposes `execute_advanced_numerical_plugin_v1(&serde_json::Value)` and the
   `hepta-paper-rust advanced-numerical-plugin REQUEST` CLI. The
   [advanced numerical handoff](../ADVANCED_NUMERICAL_PLUGIN_HANDOFF.md) maps it
   to the actual incumbent reference-candidate route. It accepts a hash-bound
   `AdvancedNumericalPluginRequest` with safe-integer seed and three assurance
   contract hashes. The command limits raw JSON to 32 KiB; the library also
   bounds serialized request bytes. Implemented families are `linear-algebra`,
   `monte-carlo`, `optimization`: matrix dimension is at most 128 and
   sample/iteration budgets at most 1000000. Output is a self-hashed
   `AdvancedNumericalPluginResult`, with `nativeExecution=true`,
   `productionQualified=false` and `reference_candidate_unqualified` status.

These are distinct input/output contracts. The advanced result's local oracle
and replay fields do not represent independently issued scientific evidence.
It uses a deterministic native stream, without claiming byte parity with the
Python reference generator. It is not the signed out-of-process plugin runner.
The [business handoff](../NATIVE_BUSINESS_HANDOFF.md) supplies the linear-kernel
example and shared byte/evidence conventions.

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `authoritative`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- `module.node-control-plane`

Current implementation and contract roots:

- `numerical-plugins`
- `paper-adapters/runtime`

Additive Rust implementation roots (the incumbent roots above remain distinct):

- `rust/crates/hepta-paper-service/src/native_business.rs`
- `rust/crates/hepta-paper-service/src/native_business/types.rs`
- `rust/crates/hepta-paper-service/src/native_business/numerical.rs`
- `rust/crates/hepta-paper-service/src/advanced_numerical.rs`
- `rust/crates/hepta-paper-service/src/bin/hepta-paper-rust.rs`
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

Reject invalid domains/units, non-convergence, instability, NaN/Inf, tolerance failure, resource exhaustion, incomplete artifacts, or oracle disagreement. Changing method or tolerance creates a new protocol identity.

The linear kernel reports `Contract` for shape/nonfinite-input/tolerance errors,
`SingularMatrix` for rejected pivots, and `Numeric` for nonfinite elimination,
solution or residual terms; output/encoding errors cannot become prepared success.
The advanced API has separate `Contract`, `UnsupportedFamily`, `Numeric`, `Hash`,
`InputLimit`, `Computation` failures. Both direct computations own no journal.
Scientific execution retains scratch on failure; service dispatch reuses durable
prepared bytes and refuses automatic relaunch of ambiguous started work. A changed
method, tolerance, seed, runtime or job requires a fresh bound identity.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

## Security and privacy

Run out of process with bounded argv/files/network/CPU/memory/PIDs/GPU lease; treat inputs and outputs as untrusted until oracle verification.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Algorithm, discretization, precision, tolerance, runtime, device, and oracle versions are part of plugin identity; changed tolerance is a new protocol.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Track admission/start latency, execution duration, success/timeout/cancel rate, resource and cost settlement, output validity, evidence/quality gain, reproducibility, and recovery time. Quality and scientific metrics are versioned by workload and cannot be replaced by repository-wide green CI.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-NUMERICAL`. Related work identifiers: `NUM-001`. Implementation/contract roots: `numerical-plugins`, `paper-adapters/runtime`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Focused Rust verification

Run from the repository root:

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test documented_native_business --test scientific_runtime
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --lib advanced_numerical
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test advanced_numerical_plugin
```

The runtime suite executes an actual Python numerical program; it does not claim
R execution. Advanced tests cover the real CLI, request-hash drift, unsupported
families, oversized raw requests and deterministic unqualified results. They do
not verify signed bundles or claim independent oracle/replay qualification.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

See the [installed-tool migration lane](../SCIENTIFIC_RUNTIME_HANDOFF.md#mandatory-installed-tool-migration-lane).
The existing migration workflow now requires a tool-equipped lane running the real R numerical and empirical cases with `--include-ignored`; it verifies actual result and CAS bytes. This does not qualify the remaining advanced plugin families, physical GPU admission or independent numerical oracles.

## Rollout and rollback

Current channel is `authoritative`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `NUM-001` — `source_implemented`

The static work-item status does not accept complete Rust numerical-role parity.
Seven of the ten declared advanced families, full incumbent argument/status
modes, signed plugin bundle/trust-store/entrypoint identities, OS sandbox,
physical CPU/GPU admission, runtime closure and independently controlled
oracle/replay/uncertainty evidence remain outside the advanced reference slice.
Representative scientific acceptance and complete plugin-runner replacement
must be established separately from its finite local calculations.

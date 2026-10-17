# module.empirical-node

Status: normative module specification  
Manifest: [`../manifests/empirical-node.v1.json`](../manifests/empirical-node.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.empirical-node
implementationKind: isolated_process
staticImplementationState: source_implemented
staticActivation: authoritative
authorityClass: prepared_result_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-EMPIRICAL
secondaryOwnerTeam: TEAM-NUMERICAL
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Execute reproducible empirical protocols with bound datasets, seeds, parameters, statistical plans, artifacts, and independent result verification.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- versioned protocol and hypotheses
- dataset/source snapshot
- seed/parameters/statistical plan
- qualified runtime

Outputs:

- raw and aggregate artifacts
- statistical diagnostics
- reproducibility and evidence receipt

### Implemented Rust empirical paths

All native jobs pass through
`execute_native_business_for_capability_v1(job, "CAP-EMPIRICAL")`; the two job
kinds have different contracts:

- `empirical_aggregate` consumes 1–1000000 `ObservationV1 {label, value}` records.
  Labels are distinct bounded ASCII identifiers (256 bytes); values and
  intermediate arithmetic must be finite. The
  [aggregate implementation](../../../rust/crates/hepta-paper-service/src/native_business/empirical.rs)
  uses an online mean/variance update in supplied order. One
  `NativeEmpiricalAggregateV1` JSON artifact contains count, extrema, mean,
  population variance, sample variance and the hash of the ordered observations;
  sample variance is null for one observation. `NativeEmpiricalEvidenceV1`
  binds report hash and count.
- `empirical_inference` wraps a closed camelCase `AnalysisInferenceRequestV1`.
  [inference.rs](../../../rust/crates/hepta-paper-service/src/native_business/inference.rs)
  also exposes `evaluate_analysis_inference_v1(&request)`. It accepts 1–65536
  finite paired values; bootstrap/sign-flip bounds and observation count must
  fit the 4000000-work budget. The [paired-analysis contract](../NATIVE_PARITY_HANDOFF.md#paired-statistical-analysis)
  defines seed/hash domains, supplied hypotheses, confidence/power fields and
  every limit. `NativePairedAnalysisReportV1` retains
  `scientificAcceptance=false`, `datasetAuthorityVerified=false` and
  `productionActivation=false`.

Actual program execution uses
`execute_scientific_job_v1(&profile, job, "CAP-EMPIRICAL")` or
`hepta-scientific-worker`, with `python_empirical` or `r_empirical` profiles.
The [scientific runtime handoff](../SCIENTIFIC_RUNTIME_HANDOFF.md) binds the tool,
runtime-file inventory, complete job hash, fixed argv, explicit named outputs
and service integration. Aggregating supplied observations is not execution of
an experiment; executing a program does not establish dataset or oracle authority.
See the [kernel examples](../examples/native-business.v1.json) and
[paired-analysis example](../examples/paired-analysis.v1.json) for separate inputs.

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `authoritative`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

## Dependencies

Hard registered module dependencies:

- `module.node-control-plane`

Current implementation and contract roots:

- `paper-application/automation`
- `paper-adapters/runtime`

Additive Rust implementation roots (the incumbent roots above remain distinct):

- `rust/crates/hepta-paper-service/src/native_business.rs`
- `rust/crates/hepta-paper-service/src/native_business/types.rs`
- `rust/crates/hepta-paper-service/src/native_business/empirical.rs`
- `rust/crates/hepta-paper-service/src/native_business/inference.rs`
- `rust/crates/hepta-paper-service/src/scientific_runtime.rs`
- `rust/crates/hepta-paper-service/src/bin/hepta-scientific-worker.rs`

## Concurrency and resources

Runs behind a qualified process/container runner with explicit CPU, memory, PID, storage, deadline, network, token/provider, and optional GPU envelopes. Child concurrency is included in the reservation; overload returns a bounded busy/retry disposition rather than bypassing central admission.

## Determinism and optimization contract

Declared class: `seeded`. Reproduction binds the exact input, module/runtime version, configuration, dataset, and explicit seed. Hardware- or solver-dependent variation must remain within a versioned tolerance/evaluation contract and is independently measured.

## Failure, recovery, and idempotency

Reject mutable/unidentified data, undeclared preprocessing, missing seeds/parameters, invalid statistical plans, leakage, non-finite output, resource overflow, or aggregates that cannot be recomputed from retained artifacts.

The aggregate rejects duplicate labels or nonfinite arithmetic as `Numeric`;
shape/count/identifier failures are `Contract`. Inference similarly refuses
unsafe numeric/work/identity inputs without prepared success. Input order is
part of the statistical and hash contract, not an invitation to reorder samples
on retry. Pure calculations own no journal. Scientific process failures retain
scratch; service-recorded prepared/committed outputs replay without another
launch or debit, while started-without-prepared work remains ambiguous. No
retry rule here authorizes repeating a provider action or changing a protocol,
dataset, seed or statistical plan under the old identity.

## Security and privacy

Use read-only datasets, isolated runtimes, declared network policy, privacy classification, and artifact-level rather than free-form sensitive telemetry.

## Compatibility and migration

Protocol, dataset, preprocessing, seed, statistical plan, and runtime versions are immutable experiment identity components.

## SLO, capacity, and observability

Track admission/start latency, execution duration, success/timeout/cancel rate, resource and cost settlement, output validity, evidence/quality gain, reproducibility, and recovery time. Quality and scientific metrics are versioned by workload and cannot be replaced by repository-wide green CI.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-EMPIRICAL`. Related work identifiers: `EMP-001`. Implementation/contract roots: `paper-application/automation`, `paper-adapters/runtime`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Focused Rust verification

Run from the repository root with the pinned Node oracle for differential tests:

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test documented_native_business --test analysis_inference_parity --test native_business_service
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test scientific_runtime --test scientific_workflow
```

The inference target compares actual incumbent Node statistical exports on the
bounded corpus. Service tests exercise real CAS verification, SQLite integration
and exact replay. Scientific tests execute Python and a real Rust worker, check
named-output membership, and keep failed work ambiguous. R execution, dataset
permission, representative scientific validity and independent replication are
not established by these targets.

See the [installed-tool migration lane](../SCIENTIFIC_RUNTIME_HANDOFF.md#mandatory-installed-tool-migration-lane).
The tool-equipped migration job now explicitly runs the R empirical/numerical and failure cases in `scientific_runtime` with `--include-ignored`. It retains actual tool and CAS output evidence; ordinary runs that leave these cases ignored do not establish R execution. This does not complete dataset authority or full experiment orchestration.

## Rollout and rollback

Current channel is `authoritative`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `EMP-001` — `source_implemented`

The registered static status does not establish full Rust empirical-role parity.
Remaining role work includes complete incumbent protocol validation and
experiment orchestration, dataset/preprocessing authority, runtime-specific
reproducibility, independently controlled oracle/replication, resource and cost
settlement, cancellation and representative full-workflow acceptance. Generic
statistics on supplied values cannot substitute for these contracts.

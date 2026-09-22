# Module implementation handoff

This is the code-level navigation companion to the [module matrix](MODULE_DOCUMENTATION_MATRIX.md), not a second global status record. It distinguishes the incumbent Node role, an additive Rust implementation, and a qualified production replacement. A linked source file or passing focused test is not a parity or deployment decision.

## Development environment and contract ownership

Use the toolchain in `rust/rust-toolchain.toml`, `rust/Cargo.lock`, and the pinned Node oracle specified in the [service contract](../../rust/crates/hepta-paper-service/README.md). Run commands below from the repository root. Tests that require scientific tools must not silently count a missing or ignored tool scenario as success.

Concrete Rust field names, closed enum variants, error types and limits belong to the linked source definitions and their crate/handoff contract; Node APIs belong to their linked implementation and conformance tests. Consult the module specification for state/authority, owners and rollback obligations. Keep the request examples in the shared handoffs imported by executable tests rather than maintaining an unrelated example copy.

## Common build and verification commands

```sh
node docs/tools/validate-module-documentation.mjs
node --test paper-core/tests/module-development-handoff.test.mjs
cargo build --manifest-path rust/Cargo.toml --locked --workspace
cargo test --manifest-path rust/Cargo.toml --locked --workspace
cargo doc --manifest-path rust/Cargo.toml --locked --workspace --no-deps
```

The [native business examples](NATIVE_BUSINESS_HANDOFF.md), [local workflow](LOCAL_WORKFLOW_HANDOFF.md), [workflow amendment](WORKFLOW_AMENDMENT_HANDOFF.md), and [scientific runtime](SCIENTIFIC_RUNTIME_HANDOFF.md) document wire examples, bounded failures, state and recovery for the implemented slices. Their production exclusions remain binding.

## module.program-truth

**Implementation scope:** Node/Python static validators.

**API and concrete types:** [docs/tools/validate-development-docs.mjs](../tools/validate-development-docs.mjs). **Engineering contract:** [DOCUMENTATION_GOVERNANCE.md](../system/DOCUMENTATION_GOVERNANCE.md). **Module specification:** [program-truth](specs/program-truth.md).

**Boundary and recovery:** Machine graph validation has no campaign-write authority; JSON records remain the source for implementation state.

**Focused validation:** `node --test paper-core/tests/development-documentation-governance.test.mjs`.

## module.source-qualification

**Implementation scope:** Python source qualification.

**API and concrete types:** [docs/rust/tools/qualification_subject_integrity.py](../rust/tools/qualification_subject_integrity.py). **Engineering contract:** [QUALIFICATION_SUBJECT_V3.md](../qualification/QUALIFICATION_SUBJECT_V3.md). **Module specification:** [source-qualification](specs/source-qualification.md).

**Boundary and recovery:** Offline hash consistency is not authenticated live collection or independent review. Preserve exact base/head/merge and complete run-attempt histories.

**Focused validation:** `python3 -B docs/rust/tools/test_qualification_subject_v3.py`.

## module.protocol-kernel

**Implementation scope:** Mixed Node baseline and Rust protocol.

**API and concrete types:** [rust/crates/hepta-codex-protocol/src/lib.rs](../../rust/crates/hepta-codex-protocol/src/lib.rs). **Engineering contract:** [README.md](../../rust/crates/hepta-legacy-compatibility/README.md). **Module specification:** [protocol-kernel](specs/protocol-kernel.md).

**Boundary and recovery:** Protocol digests and historical Node record hashes are different domains; use the pinned Node oracle for legacy bytes.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-codex-protocol -p hepta-legacy-compatibility`.

## module.module-registry

**Implementation scope:** Rust registry, SDK and conformance.

**API and concrete types:** [rust/crates/hepta-module-platform/src/registry.rs](../../rust/crates/hepta-module-platform/src/registry.rs). **Engineering contract:** [MODULE_REGISTRY.md](MODULE_REGISTRY.md). **Module specification:** [module-registry](specs/module-registry.md).

**Boundary and recovery:** ModuleManifestV1 is a requested authority ceiling, not a grant; ModuleRegistryV1 validates against an independently selected RegistryPolicyV1.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-module-platform`.

## module.candidate-router

**Implementation scope:** Registered Node router; Rust candidate contracts are separate.

**API and concrete types:** [paper-application/orchestration/candidate-router.mjs](../../paper-application/orchestration/candidate-router.mjs). **Engineering contract:** [MODULE_PROTOCOL.md](MODULE_PROTOCOL.md). **Module specification:** [candidate-router](specs/candidate-router.md).

**Boundary and recovery:** routeActionCandidatesV1 consumes bounded trusted plain data. Caller-supplied qualification metadata still requires external currentness verification; no context-free Pareto deletion.

**Focused validation:** `node --test paper-core/tests/candidate-router.test.mjs`.

**Additive orchestration API:** [`route_candidate_v1`](../../rust/crates/hepta-orchestration-kernel/src/router.rs).
The [detailed Rust contract](../../rust/crates/hepta-orchestration-kernel/HANDOFF.md) documents its separate
schema, limits, recovery and integration boundary. This additive Rust API filters, Pareto-reduces and scores a bounded five-axis integer tuple. The Node frontier collector retains contextual candidate semantics and deliberately avoids context-free Pareto deletion. They have different inputs, hashes and responsibilities; selecting the Rust API requires a reviewed mapping and currentness/hard-policy integration, not a type-name substitution.
Focused source validation: `cargo test -p hepta-orchestration-kernel --locked`
from `rust`; the re-export alone does not switch existing consumers.


## module.snapshot-builder

**Implementation scope:** Registered Node snapshot construction.

**API and concrete types:** [paper-application/orchestration/planning-snapshot-builder.mjs](../../paper-application/orchestration/planning-snapshot-builder.mjs). **Engineering contract:** [PLANNING_SNAPSHOT_BUILDER_V1.md](../control-plane/PLANNING_SNAPSHOT_BUILDER_V1.md). **Module specification:** [snapshot-builder](specs/snapshot-builder.md).

**Boundary and recovery:** Bind every component generation, observation interval and schema. A consistent caller assertion does not create a database read transaction or authenticate a store.

**Focused validation:** `node --test paper-core/tests/planning-snapshot-schema-conformance.test.mjs`.

**Additive orchestration API:** [`build_planning_snapshot_v1`](../../rust/crates/hepta-orchestration-kernel/src/snapshot.rs).
The [detailed Rust contract](../../rust/crates/hepta-orchestration-kernel/HANDOFF.md) documents its separate
schema, limits, recovery and integration boundary. This Rust function checks caller-supplied revision, barrier, component time and digest consistency. It neither opens a read transaction nor verifies payload bytes or producer identity. Its 256-component and 64 GiB declared-payload limits and distinct snapshot hash are separate from the registered Node snapshot schema. A real read owner and explicit compatibility adapter remain required.
Focused source validation: `cargo test -p hepta-orchestration-kernel --locked`
from `rust`; the re-export alone does not switch existing consumers.


## module.policy-engine

**Implementation scope:** Rust hard-policy model.

**API and concrete types:** [rust/crates/hepta-control-plane/src/model.rs](../../rust/crates/hepta-control-plane/src/model.rs). **Engineering contract:** [COMPOSITION_ROOT.md](../control-plane/COMPOSITION_ROOT.md). **Module specification:** [policy-engine](specs/policy-engine.md).

**Boundary and recovery:** HardPolicyV1 and ControlPlaneSnapshotV1 own concrete fields and validation. Missing authority and invalid hashes are denials, never soft optimization penalties.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-control-plane`.

## module.scheduler-core

**Implementation scope:** Rust bounded planning.

**API and concrete types:** [rust/crates/hepta-control-plane/src/planner.rs](../../rust/crates/hepta-control-plane/src/planner.rs). **Engineering contract:** [GLOBAL_OPTIMIZATION.md](../control-plane/GLOBAL_OPTIMIZATION.md). **Module specification:** [scheduler-core](specs/scheduler-core.md).

**Boundary and recovery:** select_plan_v1 produces PlanCertificateV1 from snapshot/frontier/hard/planner policies. Resource admission, verification and commit independently recheck the selected plan.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-control-plane`.

**Additive orchestration API:** [`calibrate_predictions_v1`](../../rust/crates/hepta-orchestration-kernel/src/calibration.rs).
The [detailed Rust contract](../../rust/crates/hepta-orchestration-kernel/HANDOFF.md) documents its separate
schema, limits, recovery and integration boundary. This additive Rust API computes integer calibration errors from bounded caller-supplied observations. It is distinct from the similarly named optimizer_v2 types and does not promote a planner or authenticate samples. The V1 report hash binds observations and policy ID but not numeric policy thresholds; a qualified integration must bind the complete policy separately with explicit versioning.
Focused source validation: `cargo test -p hepta-orchestration-kernel --locked`
from `rust`; the re-export alone does not switch existing consumers.


## module.resource-allocator

**Implementation scope:** Node governor and additive Rust allocation.

**API and concrete types:** [rust/crates/hepta-control-plane/src/resource.rs](../../rust/crates/hepta-control-plane/src/resource.rs). **Engineering contract:** [RESOURCE_MODEL.md](../control-plane/RESOURCE_MODEL.md). **Module specification:** [resource-allocator](specs/resource-allocator.md).

**Boundary and recovery:** ResourceAllocatorV1 reservations and the separate durable_resource.rs ledger are not physical CPU/GPU enforcement. The standalone durable ledger retains finalized/uncertain charges until reconciliation. The actual `ControlPlaneV1` now retains its whole selected plan after a post-dispatch failure and blocks that same in-memory owner; [`runtime/HANDOFF.md`](../../rust/crates/hepta-control-plane/src/runtime/HANDOFF.md) defines its inspection state and original-error access. This runtime guard is not persisted across owner replacement/restart, and the standalone hierarchical/durable resource components are not mandatory gates in this runtime.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-control-plane`.

**Additive orchestration API:** [`ResourceLedgerV1`](../../rust/crates/hepta-orchestration-kernel/src/resource.rs).
The [detailed Rust contract](../../rust/crates/hepta-orchestration-kernel/HANDOFF.md) documents its separate
schema, limits, recovery and integration boundary. This in-memory Rust ledger checks hierarchical integer budgets, individual scope generations and prepare/commit/finalize/cancel transitions. Commit time must be within the inclusive creation/expiry interval; expired committed reservations remain charged as ambiguous. It has no durable load/replay or physical CPU/GPU enforcement and is separate from the control-plane durable lease ledger.
Focused source validation: `cargo test -p hepta-orchestration-kernel --locked`
from `rust`; the re-export alone does not switch existing consumers.


## module.node-control-plane

**Implementation scope:** Incumbent Node implementation plus additive pure Rust decision/SLO ports.

The [native parity handoff](NATIVE_PARITY_HANDOFF.md) links `campaign_policy.rs`,
`campaign_slo.rs` and their actual Node differential tests. These functions do
not replace the campaign engine, its writer, or in-flight process cancellation.

**API and concrete types:** [paper-application/automation/campaign-engine.mjs](../../paper-application/automation/campaign-engine.mjs). **Engineering contract:** [NODE_RUST_MIGRATION.md](../migration/NODE_RUST_MIGRATION.md). **Module specification:** [node-control-plane](specs/node-control-plane.md).

**Boundary and recovery:** runPaperCampaign remains the incumbent business orchestration. Rust source existence does not retire this path or its operational gates.

**Focused validation:** `node --test paper-core/tests/campaign-resource-envelope.test.mjs paper-core/tests/campaign-child-lifetime.test.mjs`.

## module.rust-control-plane-service

**Implementation scope:** Rust local/shadow service; separately gated production API.

**API and concrete types:** [rust/crates/hepta-paper-service/src/lib.rs](../../rust/crates/hepta-paper-service/src/lib.rs). **Engineering contract:** [README.md](../../rust/crates/hepta-paper-service/README.md). **Module specification:** [rust-control-plane-service](specs/rust-control-plane-service.md).

**Boundary and recovery:** ServiceRunV1 is the closed local configuration. run_production_service_v1 requires opaque external authorities and currently accepts Native workers only; Process scientific workers are local/shadow. Its actual run consumers now propagate `ServiceError::ControlRequiresInspection` with the original runtime diagnostic; the three related CLIs preserve that disposition through the actual error/source chain. [`control_error/HANDOFF.md`](../../rust/crates/hepta-paper-service/src/control_error/HANDOFF.md) specifies the bounded projection and unchanged noninspection errors. Every service call still creates and drops its own runtime: the copied diagnostic does not persist charged capacity, block a new plan or provide durable dispatch recovery.

**Resident health and intake:** The [current intake V1 contract](../../rust/crates/hepta-paper-service/src/machine_intake/HANDOFF.md) describes actual configuration/static files, template budgets, provider precedence, generation-one SQLite/WAL state and the real current-intake health CLI. The [strict receipt contract](../../rust/crates/hepta-paper-service/src/strict_machine_intake_reconciliation/HANDOFF.md) adds original-format receipt/binding inspection to that actual intake observation. Neither diagnostic implements topic-producer V2 authority, publisher/lifecycle execution or the fully autonomous prerequisite chain.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service`.

**Local maintenance extension:** [MAINTENANCE.md](../../rust/crates/hepta-paper-service/MAINTENANCE.md) binds immutable local recovery, explicit native-only purge and cached-result-only commit to `local_recovery_gc` regressions. Purge never selects live CAS; reconciliation never dispatches a worker. These are partial local scopes, not accepted command or production parity.

## module.node-legacy-adapter

**Implementation scope:** Rust translation of explicitly labelled Node work.

**API and concrete types:** [rust/crates/hepta-module-platform/src/legacy_adapter.rs](../../rust/crates/hepta-module-platform/src/legacy_adapter.rs). **Engineering contract:** [NODE_RUST_MIGRATION.md](../migration/NODE_RUST_MIGRATION.md). **Module specification:** [node-legacy-adapter](specs/node-legacy-adapter.md).

**Boundary and recovery:** Translation and bounded prepared observations are not native Rust business execution. Preserve Node identity and never accept central-write or irreversible-effect observations here.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-module-platform`.

## module.rust-local-vertical

**Implementation scope:** Rust nonproduction fixture vertical.

**API and concrete types:** [rust/crates/hepta-local-vertical/tests/local_slice.rs](../../rust/crates/hepta-local-vertical/tests/local_slice.rs). **Engineering contract:** [LOCAL_WORKFLOW_HANDOFF.md](LOCAL_WORKFLOW_HANDOFF.md). **Module specification:** [rust-local-vertical](specs/rust-local-vertical.md).

**Boundary and recovery:** The older fake-provider slice and the newer durable local workflow are distinct scopes. Neither is live model evaluation or production activation.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-local-vertical`.

**Actual original fixture entry:** [local_slice.rs](../../rust/crates/hepta-local-vertical/tests/local_slice.rs) composes a real temporary workspace copy, deterministic fake author/reviewer result, locally signed cutover fixture and SQLite writer/reopen recovery. The crate library only declares a version constant. This fixture is separate from the newer service workflow and does not establish live model, independent installation or Node retirement. Run `cargo test -p hepta-local-vertical --test local_slice --locked` from `rust`.


## module.codex-broker

**Implementation scope:** Rust broker and process supervision.

**API and concrete types:** [rust/crates/hepta-codex-broker/src/codex_dispatch.rs](../../rust/crates/hepta-codex-broker/src/codex_dispatch.rs). **Engineering contract:** [DISPATCH.md](../../rust/crates/hepta-codex-broker/DISPATCH.md). **Module specification:** [codex-broker](specs/codex-broker.md).

**Boundary and recovery:** Role-separated principals, pre-exec release, journal and cgroup containment are required. A timeout is ambiguous after a provider action may have started; do not blindly relaunch. Journal read-only preflight now compares complete actual table/trigger definitions against the compiled in-memory schema before the writer opens; same-name trigger replacements are refused without repair. Socket frame reads share a single elapsed deadline. The actual server samples time/trust after reading and rechecks the current signed key schedule, capability and deadline after acquiring the SQLite write transaction, before returning an existing operation or inserting rows. Signed per-key expiry/revocation and future activation are evaluated at each snapshot; these observations are not atomic with a later external action. See the engineering contract for bounds, compatibility and source-test scope.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-codex-broker`.

**Worker ownership:** Worker errors/unwinding stop acceptance; startup and accept-loop failures close the queue, join every spawned worker and attempt listener cleanup before returning the first observed error. A normal connection cap drains without cancellation. The shared cancellation flag does not forcibly terminate a non-cooperative adapter. `BrokerServerError::WorkerSpawn(ErrorKind)` is an additive public enum variant requiring exhaustive-match updates. Real Unix lifecycle tests and a deterministic join test cover this source behavior; they do not qualify a production dispatcher.

**Containment ownership:** The [cgroup implementation contract](../../rust/crates/hepta-cgroup-containment/HANDOFF.md) covers held root/operation descriptors, actual filesystem checks, fixed-leaf control I/O, terminal refusal, and the broker's consumption of those identities for durable recovery. Ordinary filesystem fixtures do not qualify Linux cgroup behavior; final name removal still requires the documented cooperating namespace owner.

## module.execution-dispatcher

**Implementation scope:** Rust execution and prepared-byte verification.

**API and concrete types:** [rust/crates/hepta-control-plane/src/execution.rs](../../rust/crates/hepta-control-plane/src/execution.rs). **Engineering contract:** [README.md](../../rust/crates/hepta-control-plane/README.md). **Module specification:** [execution-dispatcher](specs/execution-dispatcher.md).

**Boundary and recovery:** Local filesystem execution and authenticated broker dispatch have different permissions. Prepared-result metadata cannot substitute for verifying actual artifact bytes.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-control-plane`.

## module.commit-sequencer

**Implementation scope:** Rust fenced SQLite writer.

**API and concrete types:** [rust/crates/hepta-campaign-writer/src/control.rs](../../rust/crates/hepta-campaign-writer/src/control.rs). **Engineering contract:** [README.md](../../rust/crates/hepta-campaign-writer/README.md). **Module specification:** [commit-sequencer](specs/commit-sequencer.md).

**Boundary and recovery:** Persist result, receipt, sequence, revision and accounting atomically. Exact duplicate attempts replay; stale or conflicting identities deny. HPCW is not the native Node schema.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-campaign-writer`.

## module.readonly-control

**Implementation scope:** Rust immutable Node/HPCW inspection.

**API and concrete types:** [rust/crates/hepta-readonly-store/src/lib.rs](../../rust/crates/hepta-readonly-store/src/lib.rs). **Engineering contract:** [README.md](../../rust/crates/hepta-readonly-store/README.md). **Module specification:** [readonly-control](specs/readonly-control.md).

**Boundary and recovery:** ReadOnlyStoreV1 detects the actual migration history and database identity. Read-only recognition is not schema translation, writer authority or a repair operation.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-readonly-store -p hepta-readonly-control`.

## module.workspace-authority

**Implementation scope:** Rust descriptor-bound workspace operations.

**API and concrete types:** [rust/crates/hepta-workspace-authority/src/lib.rs](../../rust/crates/hepta-workspace-authority/src/lib.rs). **Engineering contract:** [WORKSPACE_AND_EXECUTION.md](../runtime/WORKSPACE_AND_EXECUTION.md). **Module specification:** [workspace-authority](specs/workspace-authority.md).

**Boundary and recovery:** WorkspaceRootV1, MutationPolicyV1 and PreparedWorkspaceResultV1 define the boundaries. Bind before/after inventories; forbid unsafe links, replacement identities and reviewer mutations.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-workspace -p hepta-workspace-authority`.

**Implementation selection and recovery:** [Two workspace contracts](WORKSPACE_IMPLEMENTATIONS_HANDOFF.md) distinguishes owner arguments, inventory/copy bounds, atomic publication, remaining post-publication ambiguity and the quiescence required by staging cleanup. Prepared records do not themselves authorize campaign writes.


## module.author-node

**Implementation scope:** Incumbent Node role plus bounded Rust author kernel.

**API and concrete types:** [rust/crates/hepta-paper-service/src/native_business/author.rs](../../rust/crates/hepta-paper-service/src/native_business/author.rs). **Engineering contract:** [NATIVE_BUSINESS_HANDOFF.md](NATIVE_BUSINESS_HANDOFF.md). **Module specification:** [author-node](specs/author-node.md).

**Boundary and recovery:** author_draft assembles supplied text into Markdown with explicit byte/section/reference bounds. It does not generate research or execute a model-authored repair loop.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test documented_native_business`.

## module.reviewer-node

**Implementation scope:** Incumbent Node role plus bounded Rust review kernel.

**API and concrete types:** [rust/crates/hepta-paper-service/src/native_business/reviewer.rs](../../rust/crates/hepta-paper-service/src/native_business/reviewer.rs). **Engineering contract:** [NATIVE_BUSINESS_HANDOFF.md](NATIVE_BUSINESS_HANDOFF.md). **Module specification:** [reviewer-node](specs/reviewer-node.md).

**Boundary and recovery:** reviewer_assessment checks word count, required headings and forbidden markers. Its accepted field is a structural routing result, not independent scientific review.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test documented_native_business`.

**Negative review semantics:** A structurally valid result with `accepted=false` is a review outcome, not a parser/transport failure. The focused positive library fixture does not replace the full rejection/rubric matrix described in the module specification.


## module.formal-node

**Implementation scope:** Rust bounded proof kernel plus external Lean adapter.

**API and concrete types:** [rust/crates/hepta-paper-service/src/native_business/formal.rs](../../rust/crates/hepta-paper-service/src/native_business/formal.rs). **Engineering contract:** [SCIENTIFIC_RUNTIME_HANDOFF.md](SCIENTIFIC_RUNTIME_HANDOFF.md). **Module specification:** [formal-node](specs/formal-node.md).

**Boundary and recovery:** The built-in proposition/step enums bound supported proof rules. The Lean adapter separately requires tool and dependency identity, axiom policy and independent runtime verification.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test documented_native_business`.

**Validation scope:** A generic scientific transport fixture running Python does not demonstrate a real Lean proof. Actual tool/version, proof result and independent evidence remain separate from protocol execution.


## module.empirical-node

**Implementation scope:** Rust aggregation, bounded paired-analysis statistics and trusted external scientific execution.

The [paired-analysis contract](NATIVE_PARITY_HANDOFF.md) binds the native
`empirical_inference` variant to real Node statistical exports and the existing
durable service. It does not establish data provenance or independent replication.

**API and concrete types:** [rust/crates/hepta-paper-service/src/native_business/empirical.rs](../../rust/crates/hepta-paper-service/src/native_business/empirical.rs). **Engineering contract:** [SCIENTIFIC_RUNTIME_HANDOFF.md](SCIENTIFIC_RUNTIME_HANDOFF.md). **Module specification:** [empirical-node](specs/empirical-node.md).

**Boundary and recovery:** Distinguish aggregation of supplied observations from execution of a program. Neither guarantees dataset authority, statistical adequacy or independent replication.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test scientific_runtime --test scientific_workflow`.

**Additional implemented slice:** [inference.rs](../../rust/crates/hepta-paper-service/src/native_business/inference.rs) and `analysis_inference_parity` cover the bounded native inference contract alongside simulation. Dataset acquisition, arbitrary experiment scheduling and full empirical role acceptance are separate.


## module.numerical-node

**Implementation scope:** Rust linear solver plus external scientific execution.

**API and concrete types:** [rust/crates/hepta-paper-service/src/native_business/numerical.rs](../../rust/crates/hepta-paper-service/src/native_business/numerical.rs). **Engineering contract:** [SCIENTIFIC_RUNTIME_HANDOFF.md](SCIENTIFIC_RUNTIME_HANDOFF.md). **Module specification:** [numerical-node](specs/numerical-node.md).

**Boundary and recovery:** Finite arithmetic and pivot-threshold checks are not forward-error certification or complete GPU/PDE plugin parity. External numerical programs need their own oracle and runtime closure.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test native_bundle_and_binding --test scientific_runtime`.

**Three separate execution paths:** [native numerical kernel](../../rust/crates/hepta-paper-service/src/native_business/numerical.rs), [scientific runtime](../../rust/crates/hepta-paper-service/src/scientific_runtime.rs) and [advanced numerical family adapter](../../rust/crates/hepta-paper-service/src/advanced_numerical.rs) have distinct request/receipt contracts. See [advanced family/CLI handoff](ADVANCED_NUMERICAL_PLUGIN_HANDOFF.md) and `cargo test -p hepta-paper-service --test advanced_numerical_plugin --locked` from `rust`. Local family candidates remain unqualified; a solver kernel does not complete the full numerical role.


## module.build-package

**Implementation scope:** Rust bundle encoder plus external PDF compiler adapter.

**API and concrete types:** [rust/crates/hepta-paper-service/src/native_business/build.rs](../../rust/crates/hepta-paper-service/src/native_business/build.rs). **Engineering contract:** [SCIENTIFIC_RUNTIME_HANDOFF.md](SCIENTIFIC_RUNTIME_HANDOFF.md). **Module specification:** [build-package](specs/build-package.md).

**Boundary and recovery:** The native bundle is not a PDF. Actual TeX compilation requires the explicit tool-equipped ignored test described in the linked handoff; publication and signing remain separate.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test native_bundle_and_binding`.

**Validation scope:** The native deterministic bundle is not a compiled PDF, complete SBOM or release signature. The real LaTeX host test is explicitly ignored by default and must be selected on a provisioned host; a normal test run does not count it as passed.


## module.submission-port

**Implementation scope:** Incumbent Node sandbox; Rust prepared submission only.

**API and concrete types:** [rust/crates/hepta-paper-service/src/native_business/submission.rs](../../rust/crates/hepta-paper-service/src/native_business/submission.rs). **Engineering contract:** [NATIVE_BUSINESS_HANDOFF.md](NATIVE_BUSINESS_HANDOFF.md). **Module specification:** [submission-port](specs/submission-port.md).

**Boundary and recovery:** prepare_submission emits non-authorizing bytes. Remote submission, credential custody, durable intent and authoritative reconciliation remain external-effect obligations.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test documented_native_business`.

## module.scientific-evidence

**Implementation scope:** Rust capsule verification.

**API and concrete types:** [rust/crates/hepta-scientific-evidence/src/lib.rs](../../rust/crates/hepta-scientific-evidence/src/lib.rs). **Engineering contract:** [QUALIFICATION_MODEL.md](../qualification/QUALIFICATION_MODEL.md). **Module specification:** [scientific-evidence](specs/scientific-evidence.md).

**Boundary and recovery:** ProducerEvidenceV1 and IndependentVerificationV1 feed verify_evidence_capsule_v1. Hash identity alone does not establish scientific correctness or verifier independence.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-scientific-evidence`.

**Detailed responsibility contract:** [Rust development handoff](../../rust/crates/hepta-scientific-evidence/HANDOFF.md). The function compares supplied records and digest sets; it does not recompute scientific artifacts or authenticate a verifier/attestation. Its publicly constructible capsule is not an opaque grant. The detailed contract specifies validation order, hash ordering, assurance-level behavior and the independent adapter responsibilities.


## module.external-authority-verifier

**Implementation scope:** Rust external-receipt contracts.

**API and concrete types:** [rust/crates/hepta-external-authority/src/lib.rs](../../rust/crates/hepta-external-authority/src/lib.rs). **Engineering contract:** [EXTERNAL_AUTHORITY.md](../qualification/EXTERNAL_AUTHORITY.md). **Module specification:** [external-authority-verifier](specs/external-authority-verifier.md).

**Boundary and recovery:** ExternalAuthorityRequestV1 and ExternalAuthorityReceiptV1 bind authority kind, subject and effects. ExternalReceiptVerifierV1 must be independently controlled, not a permissive callback.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-external-authority`.

**Detailed responsibility contract:** [Rust development handoff](../../rust/crates/hepta-external-authority/HANDOFF.md). The wrapper validates explicit fields and delegates signature/subject/nonce/currentness verification to a supplied implementation. It owns no cryptographic verifier, provider transport or anti-replay journal. The detailed contract assigns each field and failure/retry decision to its actual owner; different domain strings alone do not prove independent control.


## module.qualification-ingest

**Implementation scope:** Rust signed package ingestion and closure.

**API and concrete types:** [rust/crates/hepta-qualification-ingest/src/closure.rs](../../rust/crates/hepta-qualification-ingest/src/closure.rs). **Engineering contract:** [EXTERNAL_AUTHORITY.md](../qualification/EXTERNAL_AUTHORITY.md). **Module specification:** [qualification-ingest](specs/qualification-ingest.md).

**Boundary and recovery:** verify_external_qualification_closure_v1 produces an opaque VerifiedExternalQualificationClosureV1 only after package/subject/currentness checks. Its retained expiry includes every signed payload and required inner authority receipt; millisecond checks preserve exact fractional expiry semantics. A narrowed expiry changes the opaque digest, while valid CLI report bytes remain compatible. Actual CLI admission resamples the system clock after all authority reads and after SQLite writer-lock acquisition, rechecking the retained trust/opaque windows before new acceptance or replay. Static documentation cannot construct acceptance.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-qualification-ingest`.

## module.observability

**Implementation scope:** Rust bounded telemetry; incumbent Node observations.

**API and concrete types:** [rust/crates/hepta-control-plane/src/observability.rs](../../rust/crates/hepta-control-plane/src/observability.rs). **Engineering contract:** [OBSERVABILITY_MODEL.md](../control-plane/OBSERVABILITY_MODEL.md). **Module specification:** [observability](specs/observability.md).

**Boundary and recovery:** ObservabilityJournalV1 ingests TelemetrySignalV1 under ObservabilityPolicyV1. Privacy, cardinality and retention classes are closed; export is not an authority grant.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-control-plane`.

**Additive orchestration API:** [`TelemetryAggregatorV1`](../../rust/crates/hepta-orchestration-kernel/src/telemetry.rs).
The [detailed Rust contract](../../rust/crates/hepta-orchestration-kernel/HANDOFF.md) documents its separate
schema, limits, recovery and integration boundary. This Rust accumulator accepts only closed labels/event classes and produces bounded counters and per-bucket latency counts. It does not persist raw events, implement retention or expose the existing control-plane observability journal. Bucket counts are non-cumulative; exporters must explicitly convert semantics. The handoff specifies allowed fields, cardinality, clock/error behavior and hash identity.
Focused source validation: `cargo test -p hepta-orchestration-kernel --locked`
from `rust`; the re-export alone does not switch existing consumers.


## module.performance-qualification

**Implementation scope:** Rust measurement verification, not a measured host baseline.

**API and concrete types:** [rust/crates/hepta-control-plane/src/performance_qualification.rs](../../rust/crates/hepta-control-plane/src/performance_qualification.rs). **Engineering contract:** [PERFORMANCE_AND_SLO.md](../performance/PERFORMANCE_AND_SLO.md). **Module specification:** [performance-qualification](specs/performance-qualification.md).

**Boundary and recovery:** qualify_performance_v1 binds a PerformanceQualificationRequestV1 to its exact subject. Target-host measurements and reviewed thresholds remain required; do not invent SLO values.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-control-plane`.

**Additive orchestration API:** [`qualify_performance_v1`](../../rust/crates/hepta-orchestration-kernel/src/performance.rs).
The [detailed Rust contract](../../rust/crates/hepta-orchestration-kernel/HANDOFF.md) documents its separate
schema, limits, recovery and integration boundary. This pure Rust function computes integer median, nearest-rank p95, throughput and regression from supplied samples. It bounds the complete workload/observation sets before map construction, binds supplied subject digests and keeps productionAuthorityGranted false. It does not run a benchmark, observe binary provenance or consume independent target-host signatures; it is separate from the existing control-plane performance evaluator.
Focused source validation: `cargo test -p hepta-orchestration-kernel --locked`
from `rust`; the re-export alone does not switch existing consumers.


## module.compatibility-kernel

**Implementation scope:** Rust legacy serialization with pinned Node oracle.

**API and concrete types:** [rust/crates/hepta-legacy-compatibility/src/lib.rs](../../rust/crates/hepta-legacy-compatibility/src/lib.rs). **Engineering contract:** [README.md](../../rust/crates/hepta-legacy-compatibility/README.md). **Module specification:** [compatibility-kernel](specs/compatibility-kernel.md).

**Boundary and recovery:** Property ordering, number formatting and source/runtime identities are compatibility inputs. The secret-gated historical corpus and independent acknowledgement are not replaced by local vectors.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-compatibility -p hepta-legacy-compatibility`.

## module.cutover-controller

**Implementation scope:** Rust transition journal plus incumbent Node fencing.

**API and concrete types:** [rust/crates/hepta-cutover/src/lib.rs](../../rust/crates/hepta-cutover/src/lib.rs). **Engineering contract:** [README.md](../../rust/crates/hepta-cutover/README.md). **Module specification:** [cutover-controller](specs/cutover-controller.md).

**Boundary and recovery:** Drain and freeze the incumbent before unique-writer transfer. After a Rust commit, restoring a stale Node backup is not rollback; preserve the new history and require a qualified recovery design.

**Focused validation:** `cargo test --manifest-path rust/Cargo.toml --locked -p hepta-cutover`.

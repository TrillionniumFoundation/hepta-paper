//! Rust-native, bounded business capability workers for `hepta-paper`.
//!
//! The implementation emits prepared artifacts only. It has no campaign-writer,
//! provider, release, portal, or submission authority.

#![forbid(unsafe_code)]

pub mod local_submission_preflight;
pub mod research_data;

mod author;
mod build;
mod empirical;
mod formal;
pub mod inference;
pub mod legacy_submission_v1;
mod numerical;
mod reviewer;
mod submission;
mod types;

pub use build::verify_native_build_bundle_v1;
pub use submission::{PreparedSubmissionV1, SubmissionPackageV1, prepare_submission_v1};
pub use types::{
    BuildEntryV1, ManuscriptSectionV1, NativeBusinessJobV1, NativeBusinessOutputV1, ObservationV1,
    ProofStepV1, PropositionV1, ReviewPolicyV1,
};

use author::author_draft;
use build::build_package;
use empirical::empirical_aggregate;
use formal::formal_certificate;
use numerical::numerical_linear_solve;
use reviewer::reviewer_assessment;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use thiserror::Error;

pub(super) const MAX_TEXT_BYTES: usize = 1024 * 1024;
pub(super) const MAX_TOTAL_TEXT_BYTES: usize = 16 * 1024 * 1024;
pub(super) const MAX_ARTIFACTS: usize = 8;

/// Stable implementation identity bound into deployment and process manifests.
///
/// Only the immutable `include_bytes!` closure of this compiled binary is cached.
/// Mutable runtime sources, executable files and CAS objects must still be read
/// and checked by their owners at every existing currentness boundary.
pub fn native_business_implementation_hash_v1() -> String {
    compiled_business_identity().clone()
}

fn compiled_business_identity() -> &'static String {
    static IDENTITY: OnceLock<String> = OnceLock::new();
    IDENTITY.get_or_init(compute_native_business_implementation_hash_v1)
}

fn compute_native_business_implementation_hash_v1() -> String {
    hash_domain(
        "HeptaNativeBusinessImplementationV1",
        &[
            include_bytes!("native_business.rs"),
            include_bytes!("native_business/types.rs"),
            include_bytes!("native_business/author.rs"),
            include_bytes!("native_evidence_consumption/dependencies.rs"),
            include_bytes!("native_evidence_consumption/reference.rs"),
            include_bytes!("native_research_assessment.rs"),
            include_bytes!("native_research_source.rs"),
            include_bytes!("native_research_source_plan.rs"),
            include_bytes!("native_research_manuscript.rs"),
            include_bytes!("native_research_evidence/observed_inputs.rs"),
            include_bytes!("runtime_source_cas/observation.rs"),
            include_bytes!("native_inventory.rs"),
            include_bytes!("native_inventory/values.rs"),
            include_bytes!("native_inventory/sources.rs"),
            include_bytes!("native_inventory/paper.rs"),
            include_bytes!("../../../Cargo.lock"),
            include_bytes!("native_research_assessment/cas.rs"),
            include_bytes!("native_research_assessment/cas/producer.rs"),
            include_bytes!("native_research_assessment/cas/execution.rs"),
            include_bytes!("native_research_assessment/cas/workflow.rs"),
            include_bytes!("native_research_plan.rs"),
            include_bytes!("native_research_workflow.rs"),
            include_bytes!("state_recoverability.rs"),
            include_bytes!("state_recoverability/publication.rs"),
            include_bytes!("sqlite_mutation_coordinator.rs"),
            include_bytes!("workflow/provider_calls.rs"),
            include_bytes!("workflow/recovery.rs"),
            include_bytes!("workflow/inspection.rs"),
            include_bytes!("workflow/amendment.rs"),
            include_bytes!("workflow/amendment/broker_revision.rs"),
            include_bytes!("research.rs"),
            include_bytes!("../../hepta-control-plane/src/bin/hepta-performance-qualification.rs"),
            include_bytes!("../../hepta-control-plane/src/commit.rs"),
            include_bytes!("../../hepta-control-plane/src/durable_resource.rs"),
            include_bytes!("../../hepta-control-plane/src/events.rs"),
            include_bytes!("../../hepta-control-plane/src/execution.rs"),
            include_bytes!("../../hepta-control-plane/src/execution_filesystem.rs"),
            include_bytes!("../../hepta-control-plane/src/hierarchical_resource.rs"),
            include_bytes!("../../hepta-control-plane/src/legacy_hierarchy/accounting_v1.rs"),
            include_bytes!("../../hepta-control-plane/src/legacy_hierarchy/mod.rs"),
            include_bytes!("../../hepta-control-plane/src/legacy_hierarchy/prepared_v1.rs"),
            include_bytes!("../../hepta-control-plane/src/legacy_planning/calibration.rs"),
            include_bytes!("../../hepta-control-plane/src/legacy_planning/mod.rs"),
            include_bytes!("../../hepta-control-plane/src/legacy_planning/model_selection.rs"),
            include_bytes!("../../hepta-control-plane/src/legacy_planning/observability.rs"),
            include_bytes!("../../hepta-control-plane/src/lib.rs"),
            include_bytes!("../../hepta-control-plane/src/model.rs"),
            include_bytes!("../../hepta-control-plane/src/model_selection.rs"),
            include_bytes!("../../hepta-control-plane/src/observability.rs"),
            include_bytes!("../../hepta-control-plane/src/optimizer_v2.rs"),
            include_bytes!("../../hepta-control-plane/src/pareto.rs"),
            include_bytes!("../../hepta-control-plane/src/performance_qualification.rs"),
            include_bytes!("../../hepta-control-plane/src/planner.rs"),
            include_bytes!("../../hepta-control-plane/src/resource.rs"),
            include_bytes!("../../hepta-control-plane/src/runtime.rs"),
            include_bytes!("../../hepta-control-plane/src/source_closure.rs"),
            include_bytes!("../../hepta-control-plane/Cargo.toml"),
            include_bytes!("../../hepta-campaign-writer/src/control.rs"),
            include_bytes!("../../hepta-campaign-writer/src/cutover.rs"),
            include_bytes!("../../hepta-campaign-writer/src/inspection.rs"),
            include_bytes!("../../hepta-campaign-writer/src/lib.rs"),
            include_bytes!("../../hepta-campaign-writer/src/local_recovery.rs"),
            include_bytes!("../../hepta-campaign-writer/src/workflow_amendment.rs"),
            include_bytes!("../../hepta-campaign-writer/Cargo.toml"),
            include_bytes!("../../hepta-module-platform/src/candidate.rs"),
            include_bytes!("../../hepta-module-platform/src/conformance.rs"),
            include_bytes!("../../hepta-module-platform/src/error.rs"),
            include_bytes!("../../hepta-module-platform/src/hash.rs"),
            include_bytes!("../../hepta-module-platform/src/legacy_adapter/engine.rs"),
            include_bytes!("../../hepta-module-platform/src/legacy_adapter/model.rs"),
            include_bytes!("../../hepta-module-platform/src/legacy_adapter/support.rs"),
            include_bytes!("../../hepta-module-platform/src/legacy_adapter.rs"),
            include_bytes!("../../hepta-module-platform/src/lib.rs"),
            include_bytes!("../../hepta-module-platform/src/lifecycle.rs"),
            include_bytes!("../../hepta-module-platform/src/migration.rs"),
            include_bytes!("../../hepta-module-platform/src/protocol.rs"),
            include_bytes!("../../hepta-module-platform/src/registry.rs"),
            include_bytes!("../../hepta-module-platform/src/sdk.rs"),
            include_bytes!("../../hepta-module-platform/src/types.rs"),
            include_bytes!("../../hepta-module-platform/Cargo.toml"),
            include_bytes!("../../hepta-codex-runtime/src/bin/hepta-codex-preexec-gate.rs"),
            include_bytes!("../../hepta-codex-runtime/src/environment.rs"),
            include_bytes!("../../hepta-codex-runtime/src/identity/hash.rs"),
            include_bytes!("../../hepta-codex-runtime/src/identity/inspect.rs"),
            include_bytes!("../../hepta-codex-runtime/src/identity/mod.rs"),
            include_bytes!("../../hepta-codex-runtime/src/identity/path.rs"),
            include_bytes!("../../hepta-codex-runtime/src/identity/types.rs"),
            include_bytes!("../../hepta-codex-runtime/src/invocation/builder.rs"),
            include_bytes!("../../hepta-codex-runtime/src/invocation/control.rs"),
            include_bytes!("../../hepta-codex-runtime/src/invocation/mod.rs"),
            include_bytes!("../../hepta-codex-runtime/src/invocation/types.rs"),
            include_bytes!("../../hepta-codex-runtime/src/lib.rs"),
            include_bytes!("../../hepta-codex-runtime/src/process/gate.rs"),
            include_bytes!("../../hepta-codex-runtime/src/process/io.rs"),
            include_bytes!("../../hepta-codex-runtime/src/process/mod.rs"),
            include_bytes!("../../hepta-codex-runtime/src/process/types.rs"),
            include_bytes!("../../hepta-codex-runtime/src/process/unix.rs"),
            include_bytes!("../../hepta-codex-runtime/src/qualification.rs"),
            include_bytes!("../../hepta-codex-runtime/Cargo.toml"),
            include_bytes!("../../hepta-cutover/src/durable/external_transfer/preimage.rs"),
            include_bytes!("../../hepta-cutover/src/durable/external_transfer.rs"),
            include_bytes!("../../hepta-cutover/src/durable/observation.rs"),
            include_bytes!("../../hepta-cutover/src/durable/storage.rs"),
            include_bytes!("../../hepta-cutover/src/durable.rs"),
            include_bytes!("../../hepta-cutover/src/lib.rs"),
            include_bytes!("../../hepta-cutover/src/retirement.rs"),
            include_bytes!("../../hepta-cutover/Cargo.toml"),
            include_bytes!("native_research_evidence/runtime.rs"),
            include_bytes!("native_research_evidence/verification.rs"),
            include_bytes!("native_research_canonical.rs"),
            include_bytes!("native_research_formal.rs"),
            include_bytes!("native_latex_theorem_syntax.rs"),
            include_bytes!("native_empirical_markers.rs"),
            include_bytes!("native_research_support_surfaces.rs"),
            include_bytes!("runtime_source_cas.rs"),
            include_bytes!("runtime_source_cas/observation/inventory.rs"),
            include_bytes!("state_access.rs"),
            include_bytes!("objects.rs"),
            include_bytes!("worker_recovery.rs"),
            include_bytes!("workflow.rs"),
            include_bytes!("../../hepta-readonly-store/src/inventory_projection.rs"),
            include_bytes!("../../hepta-readonly-store/src/lib.rs"),
            include_bytes!("../../hepta-readonly-store/src/logical_store_compat_v1.rs"),
            include_bytes!("../../hepta-readonly-store/src/node_receipts.rs"),
            include_bytes!("../../hepta-readonly-store/src/node_snapshot.rs"),
            include_bytes!("../../hepta-readonly-store/src/ordinary.rs"),
            include_bytes!("../../hepta-legacy-compatibility/src/node_adapter.rs"),
            include_bytes!("../../hepta-legacy-compatibility/data/node22-en-us-unihan.postcard"),
            include_bytes!("../../hepta-codex-protocol/src/lib.rs"),
            include_bytes!("../../hepta-codex-protocol/src/digest.rs"),
            include_bytes!("../../hepta-codex-protocol/src/execution.rs"),
            include_bytes!("../../hepta-codex-protocol/src/execution/types.rs"),
            include_bytes!("../../hepta-codex-protocol/src/execution/request.rs"),
            include_bytes!("../../hepta-codex-protocol/src/execution/receipt.rs"),
            include_bytes!("../../hepta-codex-protocol/src/execution/error.rs"),
            include_bytes!("../Cargo.toml"),
            include_bytes!("../build.rs"),
            include_bytes!("../../../Cargo.toml"),
            include_bytes!("worker.rs"),
            include_bytes!("lib.rs"),
            include_bytes!("native_research_evidence.rs"),
            include_bytes!("native_research_evidence/candidates.rs"),
            include_bytes!("native_research_evidence/intake.rs"),
            include_bytes!("native_research_quality.rs"),
            include_bytes!("native_research_gap_plan.rs"),
            include_bytes!("native_research_contract_context.rs"),
            include_bytes!("native_research_contracts.rs"),
            include_bytes!("native_research_claims.rs"),
            include_bytes!("native_evidence_consumption.rs"),
            include_bytes!("native_workspace.rs"),
            include_bytes!("release_state.rs"),
            include_bytes!("native_business/local_submission_preflight/records.rs"),
            include_bytes!("sqlite_mutation_coordinator/clock.rs"),
            include_bytes!("native_business/research_data/mod.rs"),
            include_bytes!("native_business/research_data/values.rs"),
            include_bytes!("native_business/research_data/csv.rs"),
            include_bytes!("native_business/research_data/assertions.rs"),
            include_bytes!("automation_runtime_reconciliation/sqlite_number.rs"),
            include_bytes!("../../hepta-legacy-compatibility/src/production.rs"),
            include_bytes!("../../hepta-legacy-compatibility/src/lib.rs"),
            include_bytes!("native_business/reviewer.rs"),
            include_bytes!("native_business/formal.rs"),
            include_bytes!("native_business/empirical.rs"),
            include_bytes!("native_business/inference.rs"),
            include_bytes!("native_business/numerical.rs"),
            include_bytes!("native_business/build.rs"),
            include_bytes!("native_business/submission.rs"),
            include_bytes!("native_business/local_submission_preflight/mod.rs"),
            include_bytes!("native_business/local_submission_preflight/records.rs"),
            include_bytes!("native_business/local_submission_preflight/semantic.rs"),
            include_bytes!("native_business/local_submission_preflight/workflow.rs"),
            include_bytes!("native_business/local_submission_preflight/delivery.rs"),
            include_bytes!("native_business/local_submission_preflight/lifecycle.rs"),
            include_bytes!("native_business/local_submission_preflight/cas.rs"),
            include_bytes!("native_business/legacy_submission_v1/mod.rs"),
            include_bytes!("native_business/legacy_submission_v1/manifest.rs"),
            include_bytes!("native_business/legacy_submission_v1/intent.rs"),
            include_bytes!("bin/hepta-native-business.rs"),
        ],
    )
}

/// Execute only when the admitted capability matches the typed business job.
/// This validates routing, not deployment, scientific, or external authority.
pub fn execute_native_business_for_capability_v1(
    job: NativeBusinessJobV1,
    capability_id: &str,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    if job.capability_id() != capability_id {
        return Err(NativeBusinessError::Contract);
    }
    execute_native_business_v1(job)
}

/// Route a typed CAS preparation through the existing worker-owned store.
/// Other jobs retain their exact pure capability executor and output contract.
pub fn execute_native_business_with_objects_for_capability_v1(
    job: NativeBusinessJobV1,
    capability_id: &str,
    objects: &crate::ObjectStoreV1,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    execute_native_business_with_objects_and_deadline_for_capability_v1(
        job,
        capability_id,
        objects,
        cancelled,
        None,
    )
}
pub(crate) fn execute_native_business_with_objects_and_deadline_for_capability_v1(
    job: NativeBusinessJobV1,
    capability_id: &str,
    objects: &crate::ObjectStoreV1,
    cancelled: &std::sync::atomic::AtomicBool,
    inherited_deadline: Option<std::time::Instant>,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    if job.capability_id() != capability_id {
        return Err(NativeBusinessError::Contract);
    }
    match job {
        NativeBusinessJobV1::ResearchObservedAssessmentFromCasV1 { request } => {
            let deadline = inherited_deadline.ok_or(NativeBusinessError::Contract)?;
            crate::native_research_assessment::cas::execute(objects, request, cancelled, deadline)
                .map_err(|_| NativeBusinessError::Contract)
        }
        NativeBusinessJobV1::ResearchDataWorkerV1 { request } => {
            research_data::execute_native_research_data_worker_v1(objects, request, cancelled)
        }
        NativeBusinessJobV1::PrepareLocalSubmissionFromCasV1 { request } => {
            local_submission_preflight::prepare_local_submission_from_cas_v1(
                objects, request, cancelled,
            )
        }
        other => execute_native_business_for_capability_v1(other, capability_id),
    }
}

/// Execute one bounded Rust-native business capability.
pub fn execute_native_business_v1(
    job: NativeBusinessJobV1,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    let output = match job {
        NativeBusinessJobV1::ResearchDataWorkerV1 { .. }
        | NativeBusinessJobV1::ResearchObservedAssessmentFromCasV1 { .. }
        | NativeBusinessJobV1::PrepareLocalSubmissionFromCasV1 { .. } => {
            return Err(NativeBusinessError::Contract);
        }
        NativeBusinessJobV1::AuthorDraft {
            title,
            abstract_text,
            sections,
            reference_keys,
        } => author_draft(title, abstract_text, sections, reference_keys)?,
        NativeBusinessJobV1::ReviewerAssessment { manuscript, policy } => {
            reviewer_assessment(manuscript, policy)?
        }
        NativeBusinessJobV1::FormalCertificate {
            assumptions,
            steps,
            goal,
        } => formal_certificate(assumptions, steps, goal)?,
        NativeBusinessJobV1::EmpiricalAggregate { observations } => {
            empirical_aggregate(observations)?
        }
        NativeBusinessJobV1::EmpiricalInference { request } => {
            inference::empirical_inference(request)?
        }
        NativeBusinessJobV1::NumericalLinearSolve {
            matrix,
            rhs,
            tolerance,
        } => numerical_linear_solve(matrix, rhs, tolerance)?,
        NativeBusinessJobV1::BuildPackage { entries } => build_package(entries)?,
        NativeBusinessJobV1::LegacySubmissionManifestV1 {
            venue,
            manuscript_sha256,
            artifacts,
            metadata,
        } => legacy_submission_v1::prepare_legacy_submission_manifest_v1(
            venue,
            manuscript_sha256,
            artifacts,
            metadata,
        )?,
        NativeBusinessJobV1::LegacySubmissionIntentV1 {
            venue,
            manuscript_hash,
            supplementary_hashes,
            metadata,
            idempotency_key,
        } => legacy_submission_v1::prepare_legacy_submission_intent_v1(
            venue,
            manuscript_hash,
            supplementary_hashes,
            metadata,
            idempotency_key,
        )?,
        NativeBusinessJobV1::PrepareSubmission {
            venue_id,
            manuscript_artifact,
            cover_letter,
            supplementary_artifacts,
            recipient_hint,
        } => {
            let prepared = prepare_submission_v1(SubmissionPackageV1 {
                venue_id,
                manuscript_artifact,
                cover_letter,
                supplementary_artifacts,
                recipient_hint,
            })?;
            let bytes = serde_json::to_vec(&prepared).map_err(|_| NativeBusinessError::Encoding)?;
            NativeBusinessOutputV1 {
                artifacts: vec![bytes],
                evidence: json!({
                    "kind": "prepared_submission_v1",
                    "packageSha256": prepared.package_sha256,
                    "externalEffectAuthorized": false
                }),
            }
        }
    };
    if output.artifacts.is_empty()
        || output.artifacts.len() > MAX_ARTIFACTS
        || output
            .artifacts
            .iter()
            .any(|artifact| artifact.is_empty() || artifact.len() > MAX_TOTAL_TEXT_BYTES)
    {
        return Err(NativeBusinessError::OutputLimit);
    }
    Ok(output)
}

pub(super) fn validate_inline_text(value: &str, maximum: usize) -> Result<(), NativeBusinessError> {
    if value.is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        return Err(NativeBusinessError::Contract);
    }
    Ok(())
}

pub(super) fn validate_body_text(value: &str) -> Result<(), NativeBusinessError> {
    if value.is_empty()
        || value.len() > MAX_TEXT_BYTES
        || value.contains('\0')
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(NativeBusinessError::Contract);
    }
    Ok(())
}

pub(super) fn validate_identifier(value: &str, maximum: usize) -> Result<(), NativeBusinessError> {
    if value.is_empty()
        || value.len() > maximum
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
    {
        return Err(NativeBusinessError::Contract);
    }
    Ok(())
}

pub(super) fn count_words(value: &str) -> u64 {
    u64::try_from(value.split_whitespace().count()).unwrap_or(u64::MAX)
}

pub(super) fn hash_bytes(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

pub(super) fn hash_domain(domain: &str, values: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    update_hash(&mut hasher, domain.as_bytes());
    for value in values {
        update_hash(&mut hasher, value);
    }
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

pub(super) fn hash_serialized<T: Serialize>(
    domain: &str,
    value: &T,
) -> Result<String, NativeBusinessError> {
    let bytes = serde_json::to_vec(value).map_err(|_| NativeBusinessError::Encoding)?;
    Ok(hash_domain(domain, &[&bytes]))
}

fn update_hash(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum NativeBusinessError {
    #[error("native business contract is invalid")]
    Contract,
    #[error("native formal proof is invalid")]
    ProofInvalid,
    #[error("native formal proof exceeds limits")]
    ProofLimit,
    #[error("native numeric input or result is invalid")]
    Numeric,
    #[error("native linear system is singular")]
    SingularMatrix,
    #[error("native business encoding failed")]
    Encoding,
    #[error("native business output exceeds limits")]
    OutputLimit,
}

#[cfg(test)]
mod tests;

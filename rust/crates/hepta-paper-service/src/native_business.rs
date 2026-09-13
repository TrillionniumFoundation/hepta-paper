//! Rust-native, bounded business capability workers for `hepta-paper`.
//!
//! The implementation emits prepared artifacts only. It has no campaign-writer,
//! provider, release, portal, or submission authority.

#![forbid(unsafe_code)]

mod author;
mod build;
mod empirical;
mod formal;
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
use thiserror::Error;

pub(super) const MAX_TEXT_BYTES: usize = 1024 * 1024;
pub(super) const MAX_TOTAL_TEXT_BYTES: usize = 16 * 1024 * 1024;
pub(super) const MAX_ARTIFACTS: usize = 8;

/// Stable implementation identity bound into deployment and process manifests.
pub fn native_business_implementation_hash_v1() -> String {
    hash_domain(
        "HeptaNativeBusinessImplementationV1",
        &[
            include_bytes!("native_business.rs"),
            include_bytes!("native_business/types.rs"),
            include_bytes!("native_business/author.rs"),
            include_bytes!("native_business/reviewer.rs"),
            include_bytes!("native_business/formal.rs"),
            include_bytes!("native_business/empirical.rs"),
            include_bytes!("native_business/numerical.rs"),
            include_bytes!("native_business/build.rs"),
            include_bytes!("native_business/submission.rs"),
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

/// Execute one bounded Rust-native business capability.
pub fn execute_native_business_v1(
    job: NativeBusinessJobV1,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    let output = match job {
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
        NativeBusinessJobV1::NumericalLinearSolve {
            matrix,
            rhs,
            tolerance,
        } => numerical_linear_solve(matrix, rhs, tolerance)?,
        NativeBusinessJobV1::BuildPackage { entries } => build_package(entries)?,
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

use super::{NativeBusinessError, hash_serialized, validate_body_text, validate_identifier};
use serde::{Deserialize, Serialize};

const MAX_FILES: usize = 64;
const MAX_RECIPIENT_BYTES: usize = 512;

/// A deterministic, non-authoritative submission package prepared by Rust.
///
/// This type deliberately contains no credential, portal session, mutable remote
/// identifier or send primitive. External delivery remains owned by the separately
/// qualified submission authority port.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmissionPackageV1 {
    pub venue_id: String,
    pub manuscript_artifact: String,
    pub cover_letter: String,
    pub supplementary_artifacts: Vec<String>,
    pub recipient_hint: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedSubmissionV1 {
    pub venue_id: String,
    pub manuscript_artifact: String,
    pub cover_letter_sha256: String,
    pub supplementary_artifacts: Vec<String>,
    pub package_sha256: String,
    pub external_effect_authorized: bool,
}

fn validate_artifact_reference(value: &str) -> Result<(), NativeBusinessError> {
    validate_identifier(value, 512)?;
    if value.starts_with('/')
        || value.split('/').any(|component| component == "." || component == "..")
    {
        return Err(NativeBusinessError::Contract);
    }
    Ok(())
}

pub fn prepare_submission_v1(
    package: SubmissionPackageV1,
) -> Result<PreparedSubmissionV1, NativeBusinessError> {
    validate_identifier(&package.venue_id, 128)?;
    validate_artifact_reference(&package.manuscript_artifact)?;
    validate_body_text(&package.cover_letter)?;
    if package.supplementary_artifacts.len() > MAX_FILES {
        return Err(NativeBusinessError::Contract);
    }
    for artifact in &package.supplementary_artifacts {
        validate_artifact_reference(artifact)?;
    }
    if let Some(recipient) = &package.recipient_hint {
        if recipient.is_empty()
            || recipient.len() > MAX_RECIPIENT_BYTES
            || recipient.contains('\0')
            || recipient.chars().any(|ch| ch.is_control())
        {
            return Err(NativeBusinessError::Contract);
        }
    }

    // The recipient hint is intentionally excluded from the externally replayable
    // package identity. It is advisory operator metadata, not delivery authority.
    let canonical = (
        &package.venue_id,
        &package.manuscript_artifact,
        &package.cover_letter,
        &package.supplementary_artifacts,
    );
    let package_sha256 = hash_serialized("HeptaPreparedSubmissionV1", &canonical)?;
    let cover_letter_sha256 = hash_serialized("HeptaCoverLetterV1", &package.cover_letter)?;

    Ok(PreparedSubmissionV1 {
        venue_id: package.venue_id,
        manuscript_artifact: package.manuscript_artifact,
        cover_letter_sha256,
        supplementary_artifacts: package.supplementary_artifacts,
        package_sha256,
        external_effect_authorized: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepares_deterministic_non_authoritative_package() {
        let package = SubmissionPackageV1 {
            venue_id: "journal:test".into(),
            manuscript_artifact: "cas:sha256:abc".into(),
            cover_letter: "Please consider the attached manuscript.".into(),
            supplementary_artifacts: vec!["cas:sha256:def".into()],
            recipient_hint: Some("editorial office".into()),
        };
        let first = prepare_submission_v1(package.clone()).expect("prepare");
        let second = prepare_submission_v1(package).expect("prepare");
        assert_eq!(first, second);
        assert!(!first.external_effect_authorized);
    }

    #[test]
    fn rejects_unbounded_or_unsafe_inputs() {
        let package = SubmissionPackageV1 {
            venue_id: "journal:test".into(),
            manuscript_artifact: "../manuscript".into(),
            cover_letter: "ok".into(),
            supplementary_artifacts: Vec::new(),
            recipient_hint: None,
        };
        assert_eq!(prepare_submission_v1(package), Err(NativeBusinessError::Contract));
    }
}

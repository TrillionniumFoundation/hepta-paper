use super::{
    NativeBusinessError, NativeBusinessOutputV1, SubmissionArtifactV1, SubmissionMetadataV1,
    hash_bytes, validate_identifier, validate_inline_text,
};
use serde::Serialize;
use serde_json::json;

const MAX_SUBMISSION_ARTIFACTS: usize = 128;
const MAX_SUBMISSION_METADATA: usize = 128;
const MAX_SUBMISSION_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Build a deterministic, non-activating submission package.
///
/// This capability deliberately stops before any network, portal, credential,
/// release, or external side effect. It emits a canonical prepared package that
/// an independently authorized submission port may later verify and consume.
pub(super) fn prepare_submission(
    venue: String,
    manuscript_sha256: String,
    mut artifacts: Vec<SubmissionArtifactV1>,
    mut metadata: Vec<SubmissionMetadataV1>,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    validate_inline_text(&venue, 256)?;
    validate_sha256(&manuscript_sha256)?;
    if artifacts.is_empty() || artifacts.len() > MAX_SUBMISSION_ARTIFACTS {
        return Err(NativeBusinessError::Contract);
    }
    if metadata.len() > MAX_SUBMISSION_METADATA {
        return Err(NativeBusinessError::Contract);
    }

    let mut total_bytes = 0_u64;
    for artifact in &artifacts {
        validate_identifier(&artifact.name, 512)?;
        validate_inline_text(&artifact.media_type, 256)?;
        validate_sha256(&artifact.sha256)?;
        if artifact.byte_length == 0 {
            return Err(NativeBusinessError::Contract);
        }
        total_bytes = total_bytes
            .checked_add(artifact.byte_length)
            .ok_or(NativeBusinessError::Contract)?;
    }
    if total_bytes > MAX_SUBMISSION_TOTAL_BYTES {
        return Err(NativeBusinessError::Contract);
    }

    for item in &metadata {
        validate_identifier(&item.key, 128)?;
        validate_inline_text(&item.value, 4096)?;
    }

    artifacts.sort_by(|left, right| left.name.cmp(&right.name));
    metadata.sort_by(|left, right| left.key.cmp(&right.key));
    if artifacts
        .windows(2)
        .any(|window| window[0].name == window[1].name)
        || metadata
            .windows(2)
            .any(|window| window[0].key == window[1].key)
    {
        return Err(NativeBusinessError::Contract);
    }

    let package = SubmissionPackageV1 {
        kind: "NativeSubmissionPackageV1",
        version: 1,
        venue,
        manuscript_sha256,
        artifact_count: artifacts.len(),
        total_bytes,
        artifacts,
        metadata,
        authority: "prepared_result_only",
        external_action_may_have_started: false,
    };
    let package_bytes = serde_json::to_vec(&package).map_err(|_| NativeBusinessError::Encoding)?;
    let package_hash = hash_bytes(&package_bytes);

    Ok(NativeBusinessOutputV1 {
        artifacts: vec![package_bytes],
        evidence: json!({
            "kind": "NativeSubmissionEvidenceV1",
            "version": 1,
            "packageHash": package_hash,
            "artifactCount": package.artifact_count,
            "totalBytes": package.total_bytes,
            "authority": "prepared_result_only",
            "externalActionMayHaveStarted": false,
            "requiresIndependentSubmissionAuthority": true,
            "deterministic": true
        }),
    })
}

fn validate_sha256(value: &str) -> Result<(), NativeBusinessError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(NativeBusinessError::Contract);
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(NativeBusinessError::Contract);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubmissionPackageV1 {
    kind: &'static str,
    version: u16,
    venue: String,
    manuscript_sha256: String,
    artifact_count: usize,
    total_bytes: u64,
    artifacts: Vec<SubmissionArtifactV1>,
    metadata: Vec<SubmissionMetadataV1>,
    authority: &'static str,
    external_action_may_have_started: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact(name: &str, byte: char, byte_length: u64) -> SubmissionArtifactV1 {
        SubmissionArtifactV1 {
            name: name.into(),
            media_type: "application/octet-stream".into(),
            sha256: format!("sha256:{}", byte.to_string().repeat(64)),
            byte_length,
        }
    }

    #[test]
    fn submission_package_is_deterministic_and_non_activating() {
        let manuscript = format!("sha256:{}", "c".repeat(64));
        let first = prepare_submission(
            "journal.example".into(),
            manuscript.clone(),
            vec![artifact("source.tar.zst", 'b', 2048), artifact("manuscript.pdf", 'a', 1024)],
            vec![
                SubmissionMetadataV1 {
                    key: "title".into(),
                    value: "Native Rust Research".into(),
                },
                SubmissionMetadataV1 {
                    key: "article_type".into(),
                    value: "research".into(),
                },
            ],
        )
        .expect("submission package");
        let second = prepare_submission(
            "journal.example".into(),
            manuscript,
            vec![artifact("manuscript.pdf", 'a', 1024), artifact("source.tar.zst", 'b', 2048)],
            vec![
                SubmissionMetadataV1 {
                    key: "article_type".into(),
                    value: "research".into(),
                },
                SubmissionMetadataV1 {
                    key: "title".into(),
                    value: "Native Rust Research".into(),
                },
            ],
        )
        .expect("deterministic package");
        assert_eq!(first, second);
        assert_eq!(first.evidence["authority"], "prepared_result_only");
        assert_eq!(first.evidence["externalActionMayHaveStarted"], false);
        assert_eq!(first.evidence["requiresIndependentSubmissionAuthority"], true);
    }

    #[test]
    fn submission_package_rejects_duplicates_and_invalid_hashes() {
        let duplicate = prepare_submission(
            "journal.example".into(),
            format!("sha256:{}", "d".repeat(64)),
            vec![artifact("same", 'e', 1), artifact("same", 'f', 1)],
            Vec::new(),
        );
        assert_eq!(
            duplicate.expect_err("duplicate artifacts fail"),
            NativeBusinessError::Contract
        );

        let invalid = prepare_submission(
            "journal.example".into(),
            "sha256:not-a-hash".into(),
            vec![artifact("manuscript.pdf", 'a', 1)],
            Vec::new(),
        );
        assert_eq!(
            invalid.expect_err("invalid manuscript hash fails"),
            NativeBusinessError::Contract
        );
    }
}

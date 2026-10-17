use super::*;
use super::{SubmissionArtifactV1 as CurrentArtifact, SubmissionMetadataV1 as CurrentMetadata};
use reference_types::{SubmissionArtifactV1, SubmissionMetadataV1};

mod reference_types {
    use serde::{Deserialize, Serialize};
    include!("reference_types.rs");
}
use crate::native_business::{
    NativeBusinessJobV1, execute_native_business_for_capability_v1, execute_native_business_v1,
};
use hepta_codex_protocol::Sha256Digest;
use std::collections::BTreeMap;

// Unmodified historical source bodies; compiled only as differential test oracles.
mod original_manifest {
    include!("reference_manifest.rs");
}
mod original_intent {
    include!("reference_intent.rs");
}

fn digest(byte: char) -> String {
    format!("sha256:{}", byte.to_string().repeat(64))
}

fn artifact(name: &str, bytes: u64) -> CurrentArtifact {
    CurrentArtifact {
        name: name.into(),
        media_type: "application/pdf".into(),
        sha256: digest('A'),
        byte_length: bytes,
    }
}

fn manifest_job() -> NativeBusinessJobV1 {
    NativeBusinessJobV1::LegacySubmissionManifestV1 {
        venue: "Recorded Journal".into(),
        manuscript_sha256: digest('F'),
        artifacts: vec![artifact("z.pdf", 4), artifact("a.pdf", 1)],
        metadata: vec![
            CurrentMetadata {
                key: "title".into(),
                value: "Recorded Title".into(),
            },
            CurrentMetadata {
                key: "article_type".into(),
                value: "research".into(),
            },
        ],
    }
}

fn manifest_reference(
    job: NativeBusinessJobV1,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    match job {
        NativeBusinessJobV1::LegacySubmissionManifestV1 {
            venue,
            manuscript_sha256,
            artifacts,
            metadata,
        } => original_manifest::prepare_submission(
            venue,
            manuscript_sha256,
            artifacts
                .into_iter()
                .map(|value| SubmissionArtifactV1 {
                    name: value.name,
                    media_type: value.media_type,
                    sha256: value.sha256,
                    byte_length: value.byte_length,
                })
                .collect(),
            metadata
                .into_iter()
                .map(|value| SubmissionMetadataV1 {
                    key: value.key,
                    value: value.value,
                })
                .collect(),
        ),
        _ => panic!("test requires manifest job"),
    }
}

fn intent_job() -> NativeBusinessJobV1 {
    NativeBusinessJobV1::LegacySubmissionIntentV1 {
        venue: "journal.example".into(),
        manuscript_hash: digest('a').parse().expect("digest"),
        supplementary_hashes: vec![
            digest('c').parse().expect("digest"),
            digest('b').parse().expect("digest"),
        ],
        metadata: BTreeMap::from([("title".into(), "Recorded Title".into())]),
        idempotency_key: "submission:1".into(),
    }
}

fn intent_reference(
    job: NativeBusinessJobV1,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    match job {
        NativeBusinessJobV1::LegacySubmissionIntentV1 {
            venue,
            manuscript_hash,
            supplementary_hashes,
            metadata,
            idempotency_key,
        } => original_intent::submission_package(
            venue,
            manuscript_hash,
            supplementary_hashes,
            metadata,
            idempotency_key,
        ),
        _ => panic!("test requires intent job"),
    }
}

#[test]
fn manifest_dispatch_preserves_old_artifact_bytes_ordering_and_evidence() {
    let job = manifest_job();
    let original = manifest_reference(job.clone()).expect("old manifest");
    assert_eq!(
        execute_native_business_for_capability_v1(job.clone(), "CAP-SUBMIT"),
        Ok(original.clone())
    );
    let mut reordered = job;
    if let NativeBusinessJobV1::LegacySubmissionManifestV1 {
        artifacts,
        metadata,
        ..
    } = &mut reordered
    {
        artifacts.reverse();
        metadata.reverse();
    }
    assert_eq!(execute_native_business_v1(reordered), Ok(original.clone()));
    assert_eq!(original.evidence["externalActionMayHaveStarted"], false);
    assert_eq!(
        original.evidence["requiresIndependentSubmissionAuthority"],
        true
    );
    assert_eq!(
        original.evidence["packageHash"],
        hash_bytes(&original.artifacts[0])
    );
}

#[test]
fn manifest_limits_and_refusals_match_actual_old_function() {
    for case in 0..9 {
        let mut job = manifest_job();
        if let NativeBusinessJobV1::LegacySubmissionManifestV1 {
            venue,
            manuscript_sha256,
            artifacts,
            metadata,
        } = &mut job
        {
            match case {
                0 => artifacts[0].byte_length = 4 * 1024 * 1024 * 1024 - 1,
                1 => artifacts[0].byte_length = 4 * 1024 * 1024 * 1024,
                2 => artifacts[0].byte_length = 0,
                3 => artifacts.push(artifacts[0].clone()),
                4 => metadata.push(metadata[0].clone()),
                5 => *manuscript_sha256 = format!("SHA256:{}", "a".repeat(64)),
                6 => venue.push('\n'),
                7 => metadata[0].value = "x".repeat(4097),
                8 => artifacts.clear(),
                _ => unreachable!(),
            }
        }
        let expected = manifest_reference(job.clone());
        if case == 0 {
            assert!(expected.is_ok());
        } else {
            assert_eq!(expected, Err(NativeBusinessError::Contract));
        }
        assert_eq!(execute_native_business_v1(job), expected, "case {case}");
    }
}

#[test]
fn intent_dispatch_preserves_old_sorted_digest_and_domain_hash_contract() {
    let job = intent_job();
    let expected = intent_reference(job.clone()).expect("old intent");
    assert_eq!(
        execute_native_business_for_capability_v1(job.clone(), "CAP-SUBMIT"),
        Ok(expected.clone())
    );
    let mut reordered = job;
    if let NativeBusinessJobV1::LegacySubmissionIntentV1 {
        supplementary_hashes,
        ..
    } = &mut reordered
    {
        supplementary_hashes.reverse();
    }
    assert_eq!(execute_native_business_v1(reordered), Ok(expected.clone()));
    assert_eq!(expected.evidence["externalActionAuthorized"], false);
    assert_eq!(expected.evidence["externalActionPerformed"], false);
    assert_ne!(
        expected.evidence["packageHash"],
        hash_bytes(&expected.artifacts[0])
    );
}

#[test]
fn intent_limits_and_refusals_match_actual_old_function() {
    for case in 0..7 {
        let mut job = intent_job();
        if let NativeBusinessJobV1::LegacySubmissionIntentV1 {
            venue,
            manuscript_hash,
            supplementary_hashes,
            metadata,
            idempotency_key,
        } = &mut job
        {
            match case {
                0 => supplementary_hashes.clear(),
                1 => supplementary_hashes.push(manuscript_hash.clone()),
                2 => supplementary_hashes.push(supplementary_hashes[0].clone()),
                3 => metadata.clear(),
                4 => {
                    metadata.insert("title".into(), "x".repeat(2049));
                }
                5 => venue.push(' '),
                6 => idempotency_key.clear(),
                _ => unreachable!(),
            }
        }
        let expected = intent_reference(job.clone());
        if case == 0 {
            assert!(expected.is_ok());
        } else {
            assert_eq!(expected, Err(NativeBusinessError::Contract));
        }
        assert_eq!(execute_native_business_v1(job), expected, "case {case}");
    }
}

#[test]
fn named_legacy_jobs_are_closed_and_cannot_override_routing() {
    for job in [manifest_job(), intent_job()] {
        let encoded = serde_json::to_vec(&job).expect("job JSON");
        let decoded: NativeBusinessJobV1 = serde_json::from_slice(&encoded).expect("closed job");
        assert_eq!(
            execute_native_business_v1(job.clone()),
            execute_native_business_v1(decoded)
        );
        assert_eq!(
            execute_native_business_for_capability_v1(job, "CAP-BUILD"),
            Err(NativeBusinessError::Contract)
        );
        let mut value: serde_json::Value = serde_json::from_slice(&encoded).expect("value");
        value["external_action_authorized"] = true.into();
        assert!(serde_json::from_value::<NativeBusinessJobV1>(value).is_err());
    }
    assert!(serde_json::from_str::<Sha256Digest>(&format!("\"{}\"", digest('A'))).is_err());
}

#[test]
fn reference_source_bytes_are_bound_to_reviewed_git_blobs() {
    assert_eq!(
        hash_bytes(include_bytes!("reference_types.rs")),
        "sha256:5acb539944189ce551efc9162b503801eb06c32dc0706348c32af4ccf9cba984"
    );
    assert_eq!(
        hash_bytes(include_bytes!("reference_manifest.rs")),
        "sha256:b5d196edc85dac7aefed10fecaf590adf110dd1a38692a91cbbf96ccdf4f8d2e"
    );
    assert_eq!(
        hash_bytes(include_bytes!("reference_intent.rs")),
        "sha256:1dc57aad76c5287793986d20f02b49c7ff893bf192d0077a81c2849081cc0cb9"
    );
}

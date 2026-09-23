use hepta_paper_service::native_business::{
    BuildEntryV1, ManuscriptSectionV1, NativeBusinessError, NativeBusinessJobV1, ObservationV1,
    ProofStepV1, PropositionV1, ReviewPolicyV1, execute_native_business_for_capability_v1,
    execute_native_business_v1, verify_native_build_bundle_v1,
};
use sha2::{Digest, Sha256};

fn hash(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn entry(path: &str) -> BuildEntryV1 {
    BuildEntryV1 {
        path: path.into(),
        content: "# A deterministic manuscript\n".into(),
        media_type: "text/markdown".into(),
    }
}

fn raw_bundle(entries: &[BuildEntryV1]) -> Vec<u8> {
    let mut bytes = b"HEPTA-NATIVE-BUNDLE-V1\0".to_vec();
    bytes.extend_from_slice(&(entries.len() as u64).to_be_bytes());
    for entry in entries {
        for field in [&entry.path, &entry.media_type, &entry.content] {
            bytes.extend_from_slice(&(field.len() as u64).to_be_bytes());
            bytes.extend_from_slice(field.as_bytes());
        }
    }
    bytes
}

#[test]
fn native_bundle_round_trip_preserves_exact_canonical_entries() {
    let mut entries = vec![entry("papers/论文.md"), entry("a.md")];
    let output = execute_native_business_v1(NativeBusinessJobV1::BuildPackage {
        entries: entries.clone(),
    })
    .expect("build");
    let bundle = &output.artifacts[1];
    let expected = output.evidence["bundleHash"].as_str().expect("bundle hash");
    let decoded = verify_native_build_bundle_v1(bundle, expected).expect("verify and decode");
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    assert_eq!(decoded, entries);
    assert_eq!(*bundle, raw_bundle(&decoded));
}

#[test]
fn native_bundle_rejects_every_truncation_even_with_matching_content_hash() {
    let bytes = raw_bundle(&[entry("a.md")]);
    for length in 0..bytes.len() {
        let truncated = &bytes[..length];
        assert!(
            verify_native_build_bundle_v1(truncated, &hash(truncated)).is_err(),
            "truncation length {length}"
        );
    }
    assert!(verify_native_build_bundle_v1(&bytes, &hash(&bytes)).is_ok());
}

#[test]
fn native_bundle_rejects_digest_drift_trailing_bytes_and_oversize_lengths() {
    let bytes = raw_bundle(&[entry("a.md")]);
    assert!(verify_native_build_bundle_v1(&bytes, &hash(b"different")).is_err());
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(verify_native_build_bundle_v1(&trailing, &hash(&trailing)).is_err());
    let prefix = b"HEPTA-NATIVE-BUNDLE-V1\0".len();
    for offset in [prefix, prefix + 8] {
        let mut oversized = bytes.clone();
        oversized[offset..offset + 8].copy_from_slice(&u64::MAX.to_be_bytes());
        assert!(verify_native_build_bundle_v1(&oversized, &hash(&oversized)).is_err());
    }
    let mut invalid_utf8 = bytes;
    invalid_utf8[prefix + 16] = 0xff;
    assert!(verify_native_build_bundle_v1(&invalid_utf8, &hash(&invalid_utf8)).is_err());
}

#[test]
fn native_bundle_rejects_duplicate_unsorted_and_file_directory_collisions() {
    for entries in [
        vec![entry("a"), entry("a")],
        vec![entry("b"), entry("a")],
        vec![entry("a"), entry("a-b"), entry("a/c")],
    ] {
        let bytes = raw_bundle(&entries);
        assert!(verify_native_build_bundle_v1(&bytes, &hash(&bytes)).is_err());
    }
    assert!(
        execute_native_business_v1(NativeBusinessJobV1::BuildPackage {
            entries: vec![entry("a"), entry("a-b"), entry("a/c")],
        })
        .is_err()
    );
}

#[test]
fn native_bundle_encoder_and_decoder_reject_unsafe_paths_consistently() {
    for path in [
        "../escape",
        "/absolute",
        "a//b",
        "C:/drive",
        "a\nb",
        "a\tb",
        "a/./b",
    ] {
        let entries = vec![entry(path)];
        let bytes = raw_bundle(&entries);
        assert!(verify_native_build_bundle_v1(&bytes, &hash(&bytes)).is_err());
        assert!(execute_native_business_v1(NativeBusinessJobV1::BuildPackage { entries }).is_err());
    }
}

#[test]
fn all_seven_native_business_jobs_bind_exactly_one_capability() {
    let a = PropositionV1::Atom { name: "A".into() };
    let jobs = vec![
        NativeBusinessJobV1::AuthorDraft {
            title: "Bounded native draft".into(),
            abstract_text: "Abstract.".into(),
            sections: vec![ManuscriptSectionV1 {
                heading: "Method".into(),
                body: "Method.".into(),
            }],
            reference_keys: vec![],
        },
        NativeBusinessJobV1::ReviewerAssessment {
            manuscript: "## Method\nMethod.\n".into(),
            policy: ReviewPolicyV1 {
                minimum_word_count: 1,
                required_headings: vec!["Method".into()],
                forbidden_markers: vec![],
            },
        },
        NativeBusinessJobV1::FormalCertificate {
            assumptions: vec![a.clone()],
            steps: vec![ProofStepV1::Assumption {
                proposition: a.clone(),
            }],
            goal: a,
        },
        NativeBusinessJobV1::EmpiricalAggregate {
            observations: vec![ObservationV1 {
                label: "observation-1".into(),
                value: 1.0,
            }],
        },
        NativeBusinessJobV1::NumericalLinearSolve {
            matrix: vec![vec![2.0]],
            rhs: vec![4.0],
            tolerance: 1e-9,
        },
        NativeBusinessJobV1::BuildPackage {
            entries: vec![entry("a.md")],
        },
        NativeBusinessJobV1::PrepareSubmission {
            venue_id: "venue-1".into(),
            manuscript_artifact: "artifact/manuscript".into(),
            cover_letter: "A cover letter.".into(),
            supplementary_artifacts: vec![],
            recipient_hint: None,
        },
    ];
    let capabilities = [
        "CAP-AUTHOR",
        "CAP-REVIEW",
        "CAP-FORMAL",
        "CAP-EMPIRICAL",
        "CAP-NUMERICAL",
        "CAP-BUILD",
        "CAP-SUBMIT",
    ];
    for (index, job) in jobs.into_iter().enumerate() {
        assert_eq!(job.capability_id(), capabilities[index]);
        for capability in capabilities {
            let result = execute_native_business_for_capability_v1(job.clone(), capability);
            if capability == capabilities[index] {
                assert!(result.is_ok(), "native job {index}: {result:?}");
            } else {
                assert_eq!(result, Err(NativeBusinessError::Contract));
            }
        }
    }
}

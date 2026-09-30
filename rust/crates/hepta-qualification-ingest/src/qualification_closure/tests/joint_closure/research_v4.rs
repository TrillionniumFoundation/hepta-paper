//! Genuine signed recovery evidence selects research without writer transfer.
//! These local signatures exercise consumers and do not qualify a target host.
use super::*;
use std::io::Write;

fn validate_receipt_schema(receipt: &ExternalQualificationClosureReceiptV1) {
    let mut child = std::process::Command::new("python3")
        .arg(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../docs/rust/tools/strict_json_schema.py"),
        )
        .arg("--batch-stdin")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let requests = json!([{
        "name": "actual-v4-receipt",
        "schema": include_str!("../../../../../../../docs/rust/qualification/research-qualification-receipt-v4.schema.json"),
        "instance": serde_json::to_string(receipt).unwrap()
    }]);
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&requests).unwrap())
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{} {}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

fn restricted(mut fixture: AcceptanceFixture) -> AcceptanceFixture {
    fixture.request.version = 4;
    fixture.request.envelopes.retain(|source| {
        QualificationPackageIdV1::RESEARCH_V4_REQUIRED.contains(&source.package_id)
    });
    fixture.signed.candidates.retain(|candidate| {
        QualificationPackageIdV1::RESEARCH_V4_REQUIRED.contains(&candidate.envelope.package_id)
    });
    fixture
}

fn subject() -> ExternalQualificationClosureSubjectV1 {
    ExternalQualificationClosureSubjectV1 {
        repository: REQUIRED_REPOSITORY.into(),
        commit: COMMIT.into(),
        tree: TREE.into(),
    }
}

#[test]
fn four_signed_recovery_packages_admit_research_without_cutover_or_publication() {
    let fixture = restricted(AcceptanceFixture::new("research-v4"));
    validate_request(&fixture.request).unwrap();
    fixture.signed.assert_individually_valid();
    let verified = verify_research_qualification_v4(
        &fixture.signed.candidates,
        &subject(),
        NOW,
        1,
        &fixture.signed.trust,
    )
    .unwrap();
    assert_eq!(
        verified.profile(),
        QualificationClosureProfile::RestrictedResearchV4
    );
    assert_eq!(verified.codex_role_principal("author"), Some((1001, 1001)));
    assert_eq!(
        verified.codex_role_principal("reviewer"),
        Some((1002, 1002))
    );
    assert_eq!(verified.runtime_facts().writer_transfer_receipt_hash, None);
    assert!(
        serde_json::to_value(verified.runtime_facts())
            .unwrap()
            .get("writerTransferReceiptHash")
            .is_none()
    );
    for package in [
        QualificationPackageIdV1::ExtGovMain001,
        QualificationPackageIdV1::ExtCutoverSoak001,
        QualificationPackageIdV1::ExtAuthoritySet001,
    ] {
        assert!(verified.package(package).is_none());
    }
    let receipt = fixture.accept(NOW).unwrap();
    validate_receipt_schema(&receipt);
    assert_eq!(receipt.body.version, 4);
    assert_eq!(receipt.body.kind, "ResearchQualificationReceiptV4");
    assert_eq!(receipt.body.packages.len(), 4);
    assert_eq!(receipt.body.authority_groups.len(), 3);
    assert!(
        !receipt
            .body
            .authority_groups
            .contains_key("release_and_cutover")
    );
    let profile = receipt.body.research_workflow_profile.as_ref().unwrap();
    assert_eq!(profile.qualification_binding_hash, verified.binding_hash());
    assert!(!profile.release_authority && !profile.submission_authority);
    assert!(!profile.production_activation && !profile.automatic_activation);
    let before = fixture.snapshot();
    let replay = fixture.accept(NOW).unwrap();
    assert_eq!(
        serde_json::to_vec(&receipt).unwrap(),
        serde_json::to_vec(&replay).unwrap()
    );
    assert_eq!(before, fixture.snapshot());
    assert!(
        verify_research_qualification_v3(
            &fixture.signed.candidates,
            &subject(),
            NOW,
            1,
            &fixture.signed.trust
        )
        .is_err()
    );
    assert!(
        verify_external_qualification_closure_v2(
            &fixture.signed.candidates,
            &subject(),
            NOW,
            1,
            &fixture.signed.trust
        )
        .is_err()
    );
}

#[test]
fn missing_or_forbidden_v4_package_never_creates_replay_state() {
    for missing in 0..4 {
        let mut fixture = restricted(AcceptanceFixture::new("research-v4-missing"));
        fixture.request.envelopes.remove(missing);
        fixture.signed.candidates.remove(missing);
        assert!(validate_request(&fixture.request).is_err());
        assert!(fixture.accept(NOW).is_err());
        fixture.assert_no_ledger();
    }
    for forbidden in [0, 5, 6] {
        let fixture = AcceptanceFixture::new("research-v4-forbidden");
        let extra_source = fixture.request.envelopes[forbidden].clone();
        let extra_candidate = fixture.signed.candidates[forbidden].clone();
        let mut fixture = restricted(fixture);
        fixture.request.envelopes[0] = extra_source;
        fixture.signed.candidates[0] = extra_candidate;
        assert!(validate_request(&fixture.request).is_err());
        assert!(fixture.accept(NOW).is_err());
        fixture.assert_no_ledger();
    }
}

#[test]
fn v4_storage_recovery_faults_soak_and_exact_host_binding_remain_required() {
    for case in 0..4 {
        let mut fixture = AcceptanceFixture::new("research-v4-storage");
        fixture.signed.update_payload(2, |payload| match case {
            0 => payload["faultMatrix"]["backupRestore"] = json!("failed"),
            1 => payload["operationCount"] = json!(9_999),
            2 => payload["continuousSoakSeconds"] = json!(259_199),
            3 => payload["hostIdentityHash"] = json!(hash(99)),
            _ => unreachable!(),
        });
        let fixture = restricted(fixture);
        assert!(fixture.accept(NOW).is_err());
        fixture.assert_no_ledger();
    }
}

#[test]
fn v4_retains_expiry_signature_profile_and_durable_clock_refusal() {
    let mut signature = restricted(AcceptanceFixture::new("research-v4-signature"));
    signature.signed.candidates[0].envelope.signature_base64 =
        Base64UrlUnpadded::encode_string(&[0; 64]);
    assert!(signature.accept(NOW).is_err());
    signature.assert_no_ledger();

    let mut expired = AcceptanceFixture::new("research-v4-expiry");
    validity::expire_payload(&mut expired.signed, 2, "2026-08-30T12:00:00Z");
    let expired = restricted(expired);
    assert!(expired.accept(NOW).is_err());
    expired.assert_no_ledger();

    let mut fixture = AcceptanceFixture::new("research-v4-profile");
    let v3 = verify_research_qualification_v3(
        &fixture
            .signed
            .candidates
            .iter()
            .filter(|candidate| {
                QualificationPackageIdV1::RESEARCH_REQUIRED.contains(&candidate.envelope.package_id)
            })
            .cloned()
            .collect::<Vec<_>>(),
        &subject(),
        NOW,
        1,
        &fixture.signed.trust,
    )
    .unwrap();
    let expected = ResearchQualificationExpectationV3 {
        subject: subject(),
        qualification_binding_hash: v3.binding_hash().into(),
        qualification_trust_store_generation: v3.trust_store_generation(),
        qualification_expires_at_unix_ms: v3.expires_at_unix_ms(),
        qualified_codex_runtime_identity_hash: v3
            .runtime_facts()
            .codex_runtime_identity_hash
            .clone(),
    };
    fixture = restricted(fixture);
    assert!(matches!(
        fixture.accept_expected(NOW, &expected),
        Err(ClosureError::ResearchProfileMismatch)
    ));
    fixture.assert_no_ledger();
    fixture.accept(NOW).unwrap();
    let before = fixture.snapshot();
    assert!(matches!(
        fixture.accept(NOW - 1),
        Err(ClosureError::ClockRollback)
    ));
    assert_eq!(before, fixture.snapshot());
}

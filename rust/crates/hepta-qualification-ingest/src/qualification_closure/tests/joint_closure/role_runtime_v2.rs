//! Actual signed source fixtures exercise the versioned production verifier and
//! replay owner. They are not independently supplied provider/host canaries.
use super::*;

fn upgrade_role_payload_v2(payload: &mut Value) {
    payload["schemaVersion"] = json!(2);
    for (index, role) in payload["roles"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        role["executableIdentityHash"] = json!(hash(110));
        role["modelSelector"] = json!("qualified-model");
        role["environmentPolicyHash"] = json!(hash(111));
        role["transportProfileHash"] = json!(hash(112 + index as u8));
        let runtime = hepta_codex_runtime::codex_runtime_identity_hash_v1(
            &role["executableIdentityHash"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            &role["homeIdentityHash"].as_str().unwrap().parse().unwrap(),
            role["modelSelector"].as_str().unwrap(),
            &role["environmentPolicyHash"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            &role["transportProfileHash"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
        )
        .unwrap();
        role["runtimeIdentityHash"] = json!(runtime.to_string());
    }
}

fn fixture_v2(label: &str) -> AcceptanceFixture {
    let mut fixture = AcceptanceFixture::new(label);
    fixture.signed.update_payload(4, upgrade_role_payload_v2);
    research_only(fixture)
}

fn verified(fixture: &AcceptanceFixture) -> crate::VerifiedResearchQualificationV3 {
    verify_research_qualification_v3(
        &fixture.signed.candidates,
        &subject(),
        NOW,
        1,
        &fixture.signed.trust,
    )
    .unwrap()
}

fn subject() -> ExternalQualificationClosureSubjectV1 {
    ExternalQualificationClosureSubjectV1 {
        repository: REQUIRED_REPOSITORY.into(),
        commit: COMMIT.into(),
        tree: TREE.into(),
    }
}

fn expectation(q: &crate::VerifiedResearchQualificationV3) -> ResearchQualificationExpectationV3 {
    ResearchQualificationExpectationV3 {
        subject: subject(),
        qualification_binding_hash: q.binding_hash().into(),
        qualification_trust_store_generation: q.trust_store_generation(),
        qualification_expires_at_unix_ms: q.expires_at_unix_ms(),
        qualified_codex_runtime_identity_hash: q
            .runtime_facts()
            .codex_runtime_identity_hash
            .clone(),
        workflow_profile_version: 2,
        qualified_codex_role_runtime_identity_hashes_v2: q.codex_role_runtime_identity_hashes_v2(),
    }
}

#[test]
fn signed_v2_role_mapping_binds_distinct_full_runtimes_and_replays_exactly() {
    let fixture = fixture_v2("signed-v2-role-map");
    fixture.signed.assert_individually_valid();
    let qualification = verified(&fixture);
    let author = qualification
        .codex_role_runtime_identity_v2("author")
        .unwrap();
    let reviewer = qualification
        .codex_role_runtime_identity_v2("reviewer")
        .unwrap();
    assert_eq!(author.principal(), (1001, 1001));
    assert_eq!(reviewer.principal(), (1002, 1002));
    assert_ne!(
        author.runtime_identity_hash(),
        reviewer.runtime_identity_hash()
    );
    assert_ne!(author.home_identity_hash(), reviewer.home_identity_hash());
    assert_ne!(
        author.transport_profile_hash(),
        reviewer.transport_profile_hash()
    );
    assert!(
        qualification
            .codex_role_runtime_identity_v2("repairer")
            .is_none()
    );
    let template = research_workflow_profile_template(&qualification);
    assert_eq!(template.version, 2);
    assert_eq!(
        template
            .qualified_codex_role_runtime_identity_hashes_v2
            .len(),
        2
    );
    assert!(
        !template.release_authority
            && !template.submission_authority
            && !template.production_activation
    );
    let expected = expectation(&qualification);
    let accepted = fixture.accept_expected(NOW, &expected).unwrap();
    assert_eq!(
        accepted.body.research_workflow_profile.as_ref().unwrap(),
        &template
    );
    let after = fixture.snapshot();
    let recovered = fixture.accept_expected(NOW, &expected).unwrap();
    assert_eq!(
        serde_json::to_vec(&accepted).unwrap(),
        serde_json::to_vec(&recovered).unwrap()
    );
    assert_eq!(after, fixture.snapshot());
    assert!(matches!(
        qualification.assert_current(qualification.expires_at_unix_ms()),
        Err(QualificationClosureError::ClosureExpired)
    ));
}

#[test]
fn signed_v2_mapping_and_version_mismatch_do_not_consume_nonce() {
    for case in 0..4 {
        let fixture = fixture_v2("signed-v2-role-expectation");
        let q = verified(&fixture);
        let mut expected = expectation(&q);
        match case {
            0 => expected.workflow_profile_version = 1,
            1 => {
                expected
                    .qualified_codex_role_runtime_identity_hashes_v2
                    .remove("reviewer");
            }
            2 => {
                expected
                    .qualified_codex_role_runtime_identity_hashes_v2
                    .insert("author".into(), hash(99));
            }
            3 => {
                let reviewer =
                    expected.qualified_codex_role_runtime_identity_hashes_v2["reviewer"].clone();
                expected
                    .qualified_codex_role_runtime_identity_hashes_v2
                    .insert("author".into(), reviewer);
            }
            _ => unreachable!(),
        }
        assert!(matches!(
            fixture.accept_expected(NOW, &expected),
            Err(ClosureError::ResearchProfileMismatch)
        ));
        fixture.assert_no_ledger();
    }
    let legacy = research_only(AcceptanceFixture::new("legacy-role-not-v2"));
    let q = verified(&legacy);
    assert!(q.codex_role_runtime_identities_v2().is_empty());
    assert!(q.codex_role_runtime_identity_v2("author").is_none());
    assert_eq!(research_workflow_profile_template(&q).version, 1);
    assert!(matches!(
        legacy.accept_expected(NOW, &expectation(&q)),
        Err(ClosureError::ResearchProfileMismatch)
    ));
    legacy.assert_no_ledger();
}

#[test]
fn genuinely_signed_v2_role_component_drift_and_unknown_versions_fail_closed() {
    for case in 0..11 {
        let mut fixture = AcceptanceFixture::new("signed-v2-role-component");
        fixture.signed.update_payload(4, |payload| {
            upgrade_role_payload_v2(payload);
            match case {
                0 => payload["schemaVersion"] = json!(3),
                1 => payload["schemaVersion"] = json!(1),
                2 => payload["roles"][0]["homeIdentityHash"] = json!(hash(99)),
                3 => payload["roles"][0]["transportProfileHash"] = json!(hash(99)),
                4 => payload["roles"][0]["executableIdentityHash"] = json!(hash(99)),
                5 => payload["roles"][0]["environmentPolicyHash"] = json!(hash(99)),
                6 => payload["roles"][0]["modelSelector"] = json!("changed-model"),
                7 => {
                    payload["roles"][0]
                        .as_object_mut()
                        .unwrap()
                        .remove("runtimeIdentityHash");
                }
                8 => {
                    payload["roles"][1]["runtimeIdentityHash"] =
                        payload["roles"][0]["runtimeIdentityHash"].clone()
                }
                9 => payload["roles"][1]["uid"] = payload["roles"][0]["uid"].clone(),
                10 => {
                    payload["roles"].as_array_mut().unwrap().pop();
                }
                _ => unreachable!(),
            }
        });
        let fixture = research_only(fixture);
        for candidate in &fixture.signed.candidates {
            verify_external_qualification_v1(
                &candidate.envelope,
                &package_subject(candidate.envelope.package_id),
                NOW,
                &fixture.signed.trust,
            )
            .expect("actual signed malformed claim");
        }
        assert!(fixture.accept(NOW).is_err(), "case {case}");
        fixture.assert_no_ledger();
    }
}

#[test]
fn v2_role_map_tampering_and_revoked_signer_never_reconstruct_opaque_authority() {
    let mut tampered = fixture_v2("tampered-v2-role-map");
    let candidate = tampered
        .signed
        .candidates
        .iter_mut()
        .find(|candidate| {
            candidate.envelope.package_id == QualificationPackageIdV1::ExtCodexRole001
        })
        .unwrap();
    let mut payload: Value = serde_json::from_slice(&candidate.payload).unwrap();
    payload["roles"][0]["uid"] = json!(9999);
    candidate.payload = serde_json::to_vec(&payload).unwrap();
    assert!(tampered.accept(NOW).is_err());
    tampered.assert_no_ledger();

    let mut revoked = fixture_v2("revoked-v2-role-map");
    // Remove only the role signer from the actual trust-key set. Other required
    // package signatures retain their original valid keys and payload bytes.
    let mut entries = REVIEWERS
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != 4)
        .map(|(index, (domain, key))| {
            (
                (*domain).to_owned(),
                (*key).to_owned(),
                reviewer_key(index).verifying_key(),
            )
        })
        .collect::<Vec<_>>();
    entries.extend(INNER_AUTHORITIES.map(|(_, domain, key, seed)| {
        (
            domain.to_owned(),
            key.to_owned(),
            SigningKey::from_bytes(&[seed; 32]).verifying_key(),
        )
    }));
    revoked.signed.trust =
        QualificationTrustStoreV1::new(entries, REQUIRED_FORBIDDEN_DOMAINS.map(str::to_owned))
            .unwrap();
    assert!(revoked.accept(NOW).is_err());
    revoked.assert_no_ledger();
}

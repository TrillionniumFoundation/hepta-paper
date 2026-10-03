//! Admission binds broker peers to the role facts retained by the signed closure.
//! Local keys and controlled principals exercise refusal, not installed canaries.
use super::*;
use crate::broker_prepared::{
    BrokerCommitAcknowledgementKeyV2, BrokerCommitAcknowledgementSourceV2,
    BrokerCostSettlementKeyV1, BrokerCostSettlementSourceV1, BrokerPreparedSourceV1,
    BrokerRequestSignerSourceV1,
};
use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::SigningKey;
use hepta_campaign_writer::{CampaignWriterPolicyV1, CampaignWriterStoreV1};
use hepta_codex_protocol::AgentRole;

fn broker_configuration(temp: &Temp, prepared_only: bool) -> ResearchServiceRunV1 {
    let mut config = configuration(temp);
    let public_key = |marker| {
        Base64UrlUnpadded::encode_string(
            SigningKey::from_bytes(&[marker; 32])
                .verifying_key()
                .as_bytes(),
        )
    };
    let source = BrokerPreparedSourceV1 {
        operation_publisher: None,
        socket_path: temp.0.join("broker.sock"),
        broker_uid: 1001,
        broker_gid: 2001,
        request_directory: temp.0.join("requests"),
        request_owner_uid: 3001,
        request_owner_gid: 3001,
        role: AgentRole::Author,
        runtime_identity_hash: digest(4),
        timeout_ms: 1_000,
        request_signer: Some(BrokerRequestSignerSourceV1 {
            private_key_path: temp.0.join("request-key.pem"),
            private_key_owner_uid: 3001,
            private_key_owner_gid: 3001,
            signer_key_id: "request-key".into(),
            public_key_base64: public_key(71),
            model_selector: "qualified-model".into(),
            maximum_lifetime_ms: 60_000,
            maximum_output_bytes: 4096,
            maximum_event_count: 100,
            remaining_token_hint: Some(100),
        }),
        cost_settlement: Some(BrokerCostSettlementSourceV1 {
            directory: temp.0.join("billing"),
            authority_domain_id: "billing-domain".into(),
            authority_uid: 4001,
            authority_gid: 4001,
            trust_store_generation: 1,
            maximum_age_ms: 60_000,
            keys: vec![BrokerCostSettlementKeyV1 {
                key_id: "billing-key".into(),
                public_key_base64: public_key(72),
            }],
        }),
        commit_acknowledgement: Some(BrokerCommitAcknowledgementSourceV2 {
            directory: temp.0.join("acknowledgements"),
            authority_domain_id: "commit-domain".into(),
            authority_uid: 5001,
            authority_gid: 5001,
            trust_store_generation: 1,
            maximum_age_ms: 60_000,
            keys: vec![BrokerCommitAcknowledgementKeyV2 {
                key_id: "commit-key".into(),
                public_key_base64: public_key(73),
            }],
        }),
    };
    let worker = if prepared_only {
        WorkerBindingV1::BrokerPrepared { source }
    } else {
        WorkerBindingV1::BrokerExecute { source }
    };
    *config.service.workers.values_mut().next().unwrap() = worker;
    assert!(validate_research_service_policy_v1(&config, &digest(4)).is_ok());
    config
}

fn source(config: &mut ResearchServiceRunV1) -> &mut BrokerPreparedSourceV1 {
    match config.service.workers.values_mut().next().unwrap() {
        WorkerBindingV1::BrokerExecute { source } | WorkerBindingV1::BrokerPrepared { source } => {
            source
        }
        _ => panic!("broker fixture"),
    }
}

#[test]
fn same_runtime_hash_cannot_substitute_unqualified_role_uid_or_gid() {
    for prepared_only in [false, true] {
        for case in 0..5 {
            let temp = Temp::new();
            let mut config = broker_configuration(&temp, prepared_only);
            assert!(
                std::fs::read_dir(temp.0.join("attempts"))
                    .unwrap()
                    .next()
                    .is_none()
            );
            let mut qualification = TestQualification::valid();
            qualification.role_principals = BTreeMap::from([
                ("author".into(), (1001, 2001)),
                ("reviewer".into(), (1002, 2002)),
            ]);
            match case {
                0 => source(&mut config).broker_uid = 1002,
                1 => source(&mut config).broker_gid = 2002,
                2 => source(&mut config).role = AgentRole::Reviewer,
                3 => source(&mut config).role = AgentRole::Repairer,
                4 => qualification.role_principals.clear(),
                _ => unreachable!(),
            }
            assert!(validate_research_service_policy_v1(&config, &digest(4)).is_ok());
            let observed = Cell::new(0);
            let mut clock = || {
                observed.set(observed.get() + 1);
                Ok(1_000)
            };
            assert!(matches!(
                run_with_clock(config, &qualification, &mut clock),
                Err(ServiceError::Configuration)
            ));
            assert_eq!(observed.get(), 0, "refuse before authority or service I/O");
            assert_eq!(qualification.checks.get(), 0);
            assert!(!temp.0.join("campaign.sqlite").exists());
            assert!(
                std::fs::read_dir(temp.0.join("attempts"))
                    .unwrap()
                    .next()
                    .is_none(),
                "admission refusal leaves the existing object-store attempt namespace empty"
            );
            assert!(!temp.0.join("requests").exists());
        }
    }
}

#[test]
fn each_qualified_role_retains_its_own_exact_principal() {
    let temp = Temp::new();
    let mut config = broker_configuration(&temp, false);
    let mut qualification = TestQualification::valid();
    for (role, name, uid, gid) in [
        (AgentRole::Author, "author", 1001, 2001),
        (AgentRole::Reviewer, "reviewer", 1002, 2002),
        (AgentRole::FormalReviewer, "formal_reviewer", 1003, 2003),
        (AgentRole::Repairer, "repairer", 1004, 2004),
    ] {
        qualification
            .role_principals
            .insert(name.into(), (uid, gid));
        let runtime = digest(uid as u8);
        qualification
            .role_runtime_hashes
            .insert(name.into(), runtime.to_string());
        let peer = source(&mut config);
        peer.role = role;
        peer.runtime_identity_hash = runtime;
        peer.broker_uid = uid;
        peer.broker_gid = gid;
        assert!(validate_research_broker_principals(&config.service, &qualification).is_ok());
        let expected_runtime = source(&mut config).runtime_identity_hash.clone();
        source(&mut config).runtime_identity_hash = digest(88);
        assert!(validate_research_broker_principals(&config.service, &qualification).is_err());
        source(&mut config).runtime_identity_hash = expected_runtime;
        source(&mut config).broker_uid += 1;
        assert!(validate_research_broker_principals(&config.service, &qualification).is_err());
    }
}

#[test]
fn restricted_v4_workflow_recovers_native_state_without_writer_transfer() {
    // The genuine signed V4 factory is covered by qualification-ingest.
    // This controlled authority exercises the actual existing native
    // workflow/CAS/SQLite consumer with its omitted transfer fact.
    let temp = Temp::new();
    let mut qualification = TestQualification::valid();
    qualification.facts.writer_transfer_receipt_hash = None;
    qualification.binding_hash = digest(12).to_string();
    let mut definition = workflow_definition(&temp, &qualification);
    let mut second = definition.steps[0].clone();
    second.id = "research-step-2".into();
    definition.steps.push(second);
    let digest = initialize_local_workflow_v1(definition.clone()).unwrap();
    let objects = ObjectStoreV1::open(&definition.template.state_directory).unwrap();
    objects.put(b"research service initial state").unwrap();
    objects.put(b"research service input artifact").unwrap();
    let profile = definition.research_profile.as_ref().unwrap();
    let mut clock = || Ok(1_000);
    let operate = |through_steps,
                   qualification: &TestQualification,
                   clock: &mut dyn FnMut() -> Result<u64, ControlPlaneError>| {
        operate_research_local_workflow_with_authority_clock_and_cancellation_v1(
            &definition.template.state_directory,
            &digest,
            WorkflowActionV1::Advance { through_steps },
            profile,
            qualification,
            clock,
            Arc::new(AtomicBool::new(false)),
        )
    };
    let first = operate(1, &qualification, &mut clock).unwrap();
    assert_eq!(first.workflow.committed_steps, 1);
    qualification.reject_check = Some(1);
    assert!(operate(2, &qualification, &mut clock).is_err());
    let status = crate::workflow::operate_local_workflow_v1(
        &definition.template.state_directory,
        &digest,
        WorkflowActionV1::Status,
        0,
    )
    .unwrap();
    assert_eq!(status.committed_steps, 1);
    qualification.reject_check = None;
    let recovered = operate(2, &qualification, &mut clock).unwrap();
    assert_eq!(recovered.workflow.committed_steps, 2);
    assert_eq!(recovered.service_receipts.len(), 1);
    let checks_after_commit = qualification.checks.get();
    let replay = operate(2, &qualification, &mut clock).unwrap();
    assert_eq!(
        serde_json::to_value(&replay.workflow).unwrap(),
        serde_json::to_value(&recovered.workflow).unwrap()
    );
    assert!(replay.service_receipts.is_empty());
    assert_eq!(qualification.checks.get(), checks_after_commit);
    assert!(
        !recovered.release_authority
            && !recovered.submission_authority
            && !recovered.production_activation
    );
}

fn initialized_research_workflow(
    temp: &Temp,
) -> (TestQualification, LocalWorkflowV1, Sha256Digest) {
    let qualification = TestQualification::valid();
    let definition = workflow_definition(temp, &qualification);
    let definition_hash = initialize_local_workflow_v1(definition.clone()).unwrap();
    (qualification, definition, definition_hash)
}

fn persist_profile_change_and_check_recovery(change_kind: u8) {
    use crate::workflow::{
        WorkflowAmendmentV1, amend_local_workflow_with_clock_v1, operate_local_workflow_v1,
        read_current_local_workflow_v1,
    };
    let temp = Temp::new();
    let (_, definition, original_hash) = if change_kind == 2 {
        let mut qualification = TestQualification::valid();
        qualification.role_runtime_hashes = BTreeMap::from([
            ("author".into(), digest(30).to_string()),
            ("reviewer".into(), digest(31).to_string()),
        ]);
        let definition = workflow_definition(&temp, &qualification);
        assert_eq!(definition.research_profile.as_ref().unwrap().version, 2);
        let definition_hash = initialize_local_workflow_v1(definition.clone()).unwrap();
        (qualification, definition, definition_hash)
    } else {
        initialized_research_workflow(&temp)
    };
    let root = &definition.template.state_directory;
    let initial =
        operate_local_workflow_v1(root, &original_hash, WorkflowActionV1::Status, 0).unwrap();
    let mut next = definition.clone();
    if change_kind == 1 {
        next.research_profile
            .as_mut()
            .unwrap()
            .qualification_binding_hash = digest(20);
    } else if change_kind == 2 {
        next.research_profile
            .as_mut()
            .unwrap()
            .qualified_codex_role_runtime_identity_hashes_v2
            .insert("author".into(), digest(32));
    } else {
        next.research_profile = None;
    }
    next.validate().unwrap();
    let next_hash = canonical_hash_v1(&next).unwrap();
    let change = serde_json::json!({
        "operationId": "profile-change",
        "requestHash": digest(21),
        "previousDefinitionHash": original_hash,
        "definitionHash": next_hash,
        "definitionJson": serde_json::to_string(&next).unwrap(),
        "expectedRevision": initial.campaign_revision,
        "committedSteps": 0,
        "additionalBudgetMicrousd": 0,
        "previousLease": definition.template.writer_lease,
        "nextLease": definition.template.writer_lease,
        "repairRejectedReview": false
    });
    // Use the real lower-level writer and event chain, rather than altering
    // SQLite rows or pretending that a normal amendment can change its profile.
    let mut writer = CampaignWriterStoreV1::open_local(
        root.join("campaign.sqlite"),
        CampaignWriterPolicyV1::strict(nix::unistd::Uid::effective().as_raw()),
    )
    .unwrap();
    writer
        .apply_local_workflow_change(
            &definition.template.snapshot.campaign_id,
            &serde_json::to_string(&change).unwrap(),
            1_001,
        )
        .unwrap();
    drop(writer);
    let before = fs::read(root.join("campaign.sqlite")).unwrap();
    for action in [
        WorkflowActionV1::Status,
        WorkflowActionV1::Advance { through_steps: 1 },
    ] {
        let observed = operate_local_workflow_v1(root, &next_hash, action, 1_002);
        assert!(
            matches!(observed, Err(WorkflowError::History)),
            "persisted profile removal or rebinding must fail recovery: {observed:?}"
        );
    }
    assert!(matches!(
        read_current_local_workflow_v1(root),
        Err(WorkflowError::History)
    ));
    let mut step = definition.steps[0].clone();
    step.id = "research-step-2".into();
    let amendment = WorkflowAmendmentV1 {
        version: 1,
        operation_id: "cannot-repair-profile-change".into(),
        expected_revision: initial.campaign_revision + 1,
        steps: vec![step],
        additional_budget_microusd: 0,
        lease_expires_at_unix_ms: definition.template.writer_lease.expires_at_unix_ms,
        repair_rejected_review: false,
    };
    assert!(matches!(
        amend_local_workflow_with_clock_v1(root, &next_hash, amendment, &mut || {
            panic!("invalid persisted profile must fail before amendment clock")
        }),
        Err(WorkflowError::History)
    ));
    assert_eq!(fs::read(root.join("campaign.sqlite")).unwrap(), before);
    assert!(
        fs::read_dir(root.join("attempts"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn persisted_research_profile_removal_is_rejected_during_recovery() {
    persist_profile_change_and_check_recovery(0);
}

#[test]
fn persisted_research_profile_rebinding_is_rejected_during_recovery() {
    persist_profile_change_and_check_recovery(1);
}

#[test]
fn persisted_per_role_runtime_mapping_rebinding_is_rejected_during_recovery() {
    persist_profile_change_and_check_recovery(2);
}

#[test]
fn research_profile_is_preserved_by_ordinary_amendment() {
    use crate::workflow::{
        WorkflowAmendmentV1, amend_local_workflow_v1, operate_local_workflow_v1,
        read_current_local_workflow_v1,
    };
    let temp = Temp::new();
    let (qualification, definition, original_hash) = initialized_research_workflow(&temp);
    let root = &definition.template.state_directory;
    let initial =
        operate_local_workflow_v1(root, &original_hash, WorkflowActionV1::Status, 0).unwrap();
    let mut step = definition.steps[0].clone();
    step.id = "research-step-2".into();
    let request = WorkflowAmendmentV1 {
        version: 1,
        operation_id: "preserve-research-profile".into(),
        expected_revision: initial.campaign_revision,
        steps: vec![step],
        additional_budget_microusd: 0,
        lease_expires_at_unix_ms: definition.template.writer_lease.expires_at_unix_ms,
        repair_rejected_review: false,
    };
    let amended = amend_local_workflow_v1(root, &original_hash, request.clone(), 1_001).unwrap();
    let current = read_current_local_workflow_v1(root).unwrap();
    assert_eq!(current.research_profile, definition.research_profile);
    assert_eq!(current.steps.len(), 2);
    assert_eq!(
        amend_local_workflow_v1(root, &original_hash, request, 100_001).unwrap(),
        amended,
        "exact amendment replay cannot refresh qualification or extend the lease"
    );
    let objects = ObjectStoreV1::open(root).unwrap();
    objects.put(b"research service initial state").unwrap();
    objects.put(b"research service input artifact").unwrap();
    let receipt = operate_research_local_workflow_with_authority_clock_and_cancellation_v1(
        root,
        &amended.definition_hash,
        WorkflowActionV1::Advance { through_steps: 2 },
        current.research_profile.as_ref().unwrap(),
        &qualification,
        &mut || Ok(1_002),
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    assert_eq!(receipt.workflow.committed_steps, 2);
    assert_eq!(receipt.service_receipts.len(), 2);
    assert!(!receipt.release_authority && !receipt.submission_authority);
}

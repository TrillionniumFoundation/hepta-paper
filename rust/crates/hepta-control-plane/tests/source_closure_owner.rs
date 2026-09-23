use std::collections::{BTreeMap, BTreeSet};

use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::{
    HardPolicyV1, HierarchicalAdmissionRequestV1, HierarchicalResourceAllocatorV1,
    HierarchicalResourcePolicyV1, ObservabilityJournalV1, ObservabilityPolicyV1,
    PerformanceBudgetV1, PerformanceQualificationRequestV1, PerformanceQualificationSubjectV1,
    PerformanceSampleV1, ResourceEntitlementV1, SnapshotBuildRequestV1, TelemetryPrivacyClassV1,
    TelemetryRetentionClassV1, TelemetrySignalKindV1, TelemetrySignalV1, build_snapshot_v1,
    qualify_performance_v1, route_candidates_v1,
};
use hepta_module_platform::{
    ActionCandidateV1, ActivationStateV1, AuthorityClassV1, ModuleExecutionV1, ModuleGrantV1,
    ModuleKindV1, ModuleManifestV1, ModuleRegistryArtifactV1, ModuleRegistryV1,
    QualificationTierV1, RegistryPolicyV1, ResourceVectorV1,
};

fn digest(byte: char) -> Sha256Digest {
    format!("sha256:{}", byte.to_string().repeat(64))
        .parse()
        .expect("digest")
}

fn resources(cpu_millis: u64) -> ResourceVectorV1 {
    ResourceVectorV1 {
        cpu_millis,
        memory_bytes: cpu_millis.saturating_mul(1024),
        ..ResourceVectorV1::default()
    }
}

fn candidate_registry() -> ModuleRegistryArtifactV1 {
    let capability_ids = BTreeSet::from(["CAP-MOD-CANDIDATES".to_owned()]);
    let mut registry = ModuleRegistryV1::new(RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.commit-sequencer".to_owned(),
        grants: BTreeMap::from([(
            "module.candidate-router".to_owned(),
            ModuleGrantV1 {
                module_version: "1.0.0".to_owned(),
                authority: AuthorityClassV1::Pure,
                minimum_qualification: QualificationTierV1::Source,
                activation: ActivationStateV1::Shadow,
                capability_ids: capability_ids.clone(),
            },
        )]),
    })
    .expect("registry policy");
    registry
        .register(ModuleManifestV1 {
            version: 1,
            module_id: "module.candidate-router".to_owned(),
            module_version: "1.0.0".to_owned(),
            protocol_min: 1,
            protocol_max: 1,
            module_kind: ModuleKindV1::TrustedInProcess,
            requested_authority: AuthorityClassV1::Pure,
            qualification: QualificationTierV1::Source,
            requested_activation: ActivationStateV1::Shadow,
            capability_ids: capability_ids.into_iter().collect(),
            dependencies: vec![],
            primary_owner: "TEAM-KERNEL".to_owned(),
            secondary_owner: "TEAM-SCHEDULER".to_owned(),
            independent_reviewer: "TEAM-EVIDENCE".to_owned(),
            rollback_version: "0.9.0".to_owned(),
            execution: ModuleExecutionV1::InProcess {
                implementation_hash: digest('a'),
            },
        })
        .expect("register candidate router");
    registry.finish().expect("registry artifact")
}

#[test]
fn snapshot_and_candidate_router_bind_exact_registry_and_deduplicate() {
    let registry = candidate_registry();
    let required = BTreeSet::from(["CAP-MOD-CANDIDATES".to_owned()]);
    let snapshot = build_snapshot_v1(
        SnapshotBuildRequestV1 {
            campaign_id: "campaign-source-owner".to_owned(),
            campaign_revision: 1,
            state_hash: digest('b'),
            objective_version: "objective-v1".to_owned(),
            constraint_set_hash: digest('c'),
            resource_limit: resources(100),
            budget_microusd: 100,
            required_capability_ids: required,
            random_seed: None,
        },
        &registry,
    )
    .expect("snapshot");
    assert_eq!(snapshot.registry_hash, *registry.registry_hash());

    let hard_policy = HardPolicyV1 {
        version: 1,
        policy_id: "hard-policy-v1".to_owned(),
        registry_policy_hash: registry.policy_hash().clone(),
        forbidden_module_ids: BTreeSet::new(),
        minimum_evidence_by_capability: BTreeMap::from([(
            "CAP-MOD-CANDIDATES".to_owned(),
            QualificationTierV1::Source,
        )]),
        external_actions_authorized: false,
        maximum_central_writer_turns: 0,
        maximum_candidates_per_decision_group: 8,
    };
    let candidate = ActionCandidateV1 {
        version: 1,
        candidate_id: "candidate-a".to_owned(),
        decision_group: "decision-a".to_owned(),
        module_id: "module.candidate-router".to_owned(),
        module_version: "1.0.0".to_owned(),
        capability_id: "CAP-MOD-CANDIDATES".to_owned(),
        snapshot_hash: snapshot.snapshot_hash().expect("snapshot hash"),
        dependency_candidate_ids: vec![],
        resources: resources(1),
        utility_micros: 10,
        cost_microusd: 1,
        uncertainty_ppm: 0,
        evidence_tier: QualificationTierV1::Source,
        payload_hash: digest('d'),
    };
    let frontier = route_candidates_v1(
        &snapshot,
        &registry,
        &hard_policy,
        vec![candidate.clone(), candidate],
    )
    .expect("routed frontier");
    assert_eq!(frontier.candidates.len(), 1);
    assert_eq!(
        frontier.snapshot_hash,
        snapshot.snapshot_hash().expect("hash")
    );
}

#[test]
fn hierarchical_resource_accounting_is_exact_and_bounded() {
    let policy = HierarchicalResourcePolicyV1 {
        version: 1,
        capacity: resources(100),
        entitlements: BTreeMap::from([
            (
                "root".to_owned(),
                ResourceEntitlementV1 {
                    domain_id: "root".to_owned(),
                    parent_domain_id: None,
                    hard_limit: resources(100),
                    weight: 1,
                },
            ),
            (
                "campaign-a".to_owned(),
                ResourceEntitlementV1 {
                    domain_id: "campaign-a".to_owned(),
                    parent_domain_id: Some("root".to_owned()),
                    hard_limit: resources(60),
                    weight: 2,
                },
            ),
        ]),
        maximum_depth: 8,
        starvation_bound_ms: 1_000,
    };
    let mut allocator = HierarchicalResourceAllocatorV1::new(policy).expect("allocator");
    let reservation = allocator
        .reserve(
            HierarchicalAdmissionRequestV1 {
                reservation_id: "reservation-a".to_owned(),
                domain_id: "campaign-a".to_owned(),
                resources: resources(40),
                queued_at_unix_ms: 10,
                deadline_unix_ms: None,
            },
            20,
        )
        .expect("reserve");
    assert_eq!(reservation.charged_domain_ids, vec!["campaign-a", "root"]);
    assert_eq!(allocator.global_reserved(), resources(40));
    assert_eq!(allocator.domain_reserved("root"), resources(40));
    allocator
        .reconcile("reservation-a", resources(25))
        .expect("reconcile");
    assert_eq!(allocator.global_reserved(), resources(25));
    allocator.release("reservation-a").expect("release");
    assert_eq!(allocator.global_reserved(), ResourceVectorV1::default());
}

#[test]
fn observability_is_content_bounded_replay_safe_and_non_authorizing() {
    let policy = ObservabilityPolicyV1 {
        version: 1,
        maximum_signals: 4,
        maximum_labels_per_signal: 2,
        maximum_unique_label_pairs: 4,
        allowed_signal_names: BTreeSet::from(["scheduler.queue_age_micros".to_owned()]),
        allowed_label_keys: BTreeSet::from(["campaign".to_owned()]),
    };
    let mut journal = ObservabilityJournalV1::new(policy).expect("journal");
    let signal = TelemetrySignalV1 {
        version: 1,
        sequence: 1,
        kind: TelemetrySignalKindV1::Metric,
        name: "scheduler.queue_age_micros".to_owned(),
        module_id: "module.scheduler-core".to_owned(),
        subject_hash: digest('e'),
        value: Some(10),
        labels: BTreeMap::from([("campaign".to_owned(), "campaign-a".to_owned())]),
        privacy_class: TelemetryPrivacyClassV1::Internal,
        retention_class: TelemetryRetentionClassV1::Operational,
    };
    let first = journal.ingest(signal.clone()).expect("signal");
    assert_eq!(journal.ingest(signal).expect("idempotent replay"), first);
    let export = journal.export().expect("export");
    assert_eq!(export.signals.len(), 1);
    assert!(!export.grants_authority);
}

#[test]
fn performance_qualification_binds_exact_subject_without_granting_authority() {
    let subject = PerformanceQualificationSubjectV1 {
        source_hash: digest('1'),
        binary_hash: digest('2'),
        configuration_hash: digest('3'),
        host_identity_hash: digest('4'),
        workload_hash: digest('5'),
        measurement_method_hash: digest('6'),
        threshold_version_hash: digest('7'),
        warm_cold_policy_hash: digest('8'),
    };
    let request = PerformanceQualificationRequestV1 {
        version: 1,
        subject: subject.clone(),
        performance_budget: PerformanceBudgetV1 {
            version: 1,
            workload_id: "workload.control".to_owned(),
            maximum_p95_latency_micros: 200,
            maximum_p99_latency_micros: 300,
            maximum_peak_memory_bytes: 4096,
            maximum_queue_age_micros: 500,
            maximum_failure_ppm: 100_000,
        },
        performance_samples: vec![PerformanceSampleV1 {
            workload_id: "workload.control".to_owned(),
            latency_micros: 100,
            operations: 10,
            failures: 0,
            peak_memory_bytes: 1024,
            queue_age_micros: 10,
        }],
        calibration_policy: None,
        calibration_observations: vec![],
    };
    let receipt = qualify_performance_v1(&request).expect("qualification aggregation");
    assert!(receipt.accepted);
    assert!(!receipt.grants_authority);
    assert_eq!(
        receipt.subject_hash,
        subject.subject_hash().expect("subject hash")
    );
}

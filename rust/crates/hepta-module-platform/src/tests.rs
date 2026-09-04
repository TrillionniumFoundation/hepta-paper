use std::{
    collections::{BTreeMap, BTreeSet},
    str::FromStr,
};

use hepta_codex_protocol::Sha256Digest;

use crate::*;

fn digest(marker: char) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", marker.to_string().repeat(64)))
        .expect("test digest")
}

fn manifest(
    module_id: &str,
    authority: AuthorityClassV1,
    activation: ActivationStateV1,
    capabilities: &[&str],
    dependencies: Vec<ModuleDependencyV1>,
) -> ModuleManifestV1 {
    ModuleManifestV1 {
        version: 1,
        module_id: module_id.to_owned(),
        module_version: "1.0.0".to_owned(),
        protocol_min: 1,
        protocol_max: 1,
        module_kind: if authority == AuthorityClassV1::Pure {
            ModuleKindV1::PureLibrary
        } else {
            ModuleKindV1::TrustedInProcess
        },
        requested_authority: authority,
        qualification: QualificationTierV1::Source,
        requested_activation: activation,
        capability_ids: capabilities
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        dependencies,
        primary_owner: "TEAM-KERNEL".to_owned(),
        secondary_owner: "TEAM-PROTOCOL".to_owned(),
        independent_reviewer: "TEAM-EVIDENCE".to_owned(),
        rollback_version: "0.9.0".to_owned(),
        execution: ModuleExecutionV1::InProcess {
            implementation_hash: digest('a'),
        },
    }
}

fn grant(
    authority: AuthorityClassV1,
    activation: ActivationStateV1,
    capabilities: &[&str],
) -> ModuleGrantV1 {
    ModuleGrantV1 {
        module_version: "1.0.0".to_owned(),
        authority,
        minimum_qualification: QualificationTierV1::Source,
        activation,
        capability_ids: capabilities
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
    }
}

#[test]
fn registry_rejects_manifest_authority_escalation() {
    let policy = RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.commit-sequencer".to_owned(),
        grants: BTreeMap::from([(
            "module.planner".to_owned(),
            grant(
                AuthorityClassV1::Pure,
                ActivationStateV1::Authoritative,
                &["CAP-SCH-PLAN"],
            ),
        )]),
    };
    let mut registry = ModuleRegistryV1::new(policy).expect("policy");
    let hostile = manifest(
        "module.planner",
        AuthorityClassV1::PreparedResultOnly,
        ActivationStateV1::Authoritative,
        &["CAP-SCH-PLAN"],
        Vec::new(),
    );
    assert_eq!(
        registry.register(hostile),
        Err(ModulePlatformError::AuthorityEscalation)
    );
}

#[test]
fn registry_binds_versions_and_rejects_dependency_cycles() {
    let policy = RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.commit-sequencer".to_owned(),
        grants: BTreeMap::from([
            (
                "module.a".to_owned(),
                grant(
                    AuthorityClassV1::Pure,
                    ActivationStateV1::Authoritative,
                    &["CAP-A"],
                ),
            ),
            (
                "module.b".to_owned(),
                grant(
                    AuthorityClassV1::Pure,
                    ActivationStateV1::Authoritative,
                    &["CAP-B"],
                ),
            ),
        ]),
    };
    let mut registry = ModuleRegistryV1::new(policy).expect("policy");
    registry
        .register(manifest(
            "module.a",
            AuthorityClassV1::Pure,
            ActivationStateV1::Authoritative,
            &["CAP-A"],
            vec![ModuleDependencyV1 {
                module_id: "module.b".to_owned(),
                module_version: "1.0.0".to_owned(),
            }],
        ))
        .expect("module a");
    registry
        .register(manifest(
            "module.b",
            AuthorityClassV1::Pure,
            ActivationStateV1::Authoritative,
            &["CAP-B"],
            vec![ModuleDependencyV1 {
                module_id: "module.a".to_owned(),
                module_version: "1.0.0".to_owned(),
            }],
        ))
        .expect("module b");
    assert_eq!(registry.finish(), Err(ModulePlatformError::DependencyCycle));
}

#[test]
fn registry_artifact_and_conformance_are_deterministic() {
    let policy = RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.commit-sequencer".to_owned(),
        grants: BTreeMap::from([(
            "module.planner".to_owned(),
            grant(
                AuthorityClassV1::Pure,
                ActivationStateV1::Authoritative,
                &["CAP-SCH-PLAN"],
            ),
        )]),
    };
    let build = || {
        let mut registry = ModuleRegistryV1::new(policy.clone()).expect("policy");
        registry
            .register(manifest(
                "module.planner",
                AuthorityClassV1::Pure,
                ActivationStateV1::Authoritative,
                &["CAP-SCH-PLAN"],
                Vec::new(),
            ))
            .expect("manifest");
        registry.finish().expect("registry")
    };
    let left = build();
    let right = build();
    assert_eq!(left, right);
    left.validate(left.policy_hash())
        .expect("registry validates");
    let expected_policy_hash = left.policy_hash().clone();
    let report = module_conformance_report_v1(&left, &expected_policy_hash).expect("conformance");
    assert_eq!(report.policy_hash, expected_policy_hash);
    assert!(report.conformant);
    assert_eq!(report.module_count, 1);
}

#[test]
fn candidates_and_prepared_results_bind_exact_subjects() {
    let policy = RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.commit-sequencer".to_owned(),
        grants: BTreeMap::from([(
            "module.executor".to_owned(),
            grant(
                AuthorityClassV1::PreparedResultOnly,
                ActivationStateV1::Shadow,
                &["CAP-MOD-EXECUTION"],
            ),
        )]),
    };
    let mut registry = ModuleRegistryV1::new(policy).expect("policy");
    registry
        .register(manifest(
            "module.executor",
            AuthorityClassV1::PreparedResultOnly,
            ActivationStateV1::Shadow,
            &["CAP-MOD-EXECUTION"],
            Vec::new(),
        ))
        .expect("manifest");
    let registry = registry.finish().expect("registry");
    let snapshot = digest('b');
    let candidate = ActionCandidateV1 {
        version: 1,
        candidate_id: "candidate-1".to_owned(),
        decision_group: "group-1".to_owned(),
        module_id: "module.executor".to_owned(),
        module_version: "1.0.0".to_owned(),
        capability_id: "CAP-MOD-EXECUTION".to_owned(),
        snapshot_hash: snapshot.clone(),
        dependency_candidate_ids: Vec::new(),
        resources: ResourceVectorV1 {
            cpu_millis: 10,
            ..ResourceVectorV1::default()
        },
        utility_micros: 100,
        cost_microusd: 20,
        uncertainty_ppm: 1_000,
        evidence_tier: QualificationTierV1::Source,
        payload_hash: digest('c'),
    };
    candidate
        .validate(&registry, &snapshot)
        .expect("candidate validates");
    let plan_hash = digest('d');
    let result = PreparedResultV1 {
        version: 1,
        attempt_id: "attempt-1".to_owned(),
        snapshot_hash: snapshot,
        plan_hash: plan_hash.clone(),
        candidate_hash: candidate.candidate_hash().expect("candidate hash"),
        module_id: candidate.module_id.clone(),
        module_version: candidate.module_version.clone(),
        status: PreparedResultStatusV1::Prepared,
        artifact_hashes: vec![digest('e')],
        actual_resources: candidate.resources,
        actual_cost_microusd: 20,
        evidence_hash: digest('f'),
        external_action_may_have_started: false,
    };
    result
        .validate(&candidate, &plan_hash)
        .expect("prepared result validates");
}

#[test]
fn legacy_adapter_is_forced_to_prepared_result_only() {
    let manifest = node_legacy_adapter_manifest_v1("1.0.0", "0.9.0", digest('1'), digest('2'));
    assert_eq!(
        manifest.requested_authority,
        AuthorityClassV1::PreparedResultOnly
    );
    assert_eq!(manifest.requested_activation, ActivationStateV1::Shadow);
    assert_eq!(
        manifest.capability_ids.into_iter().collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "CAP-CMP-LEGACY".to_owned(),
            "CAP-MOD-CANDIDATES".to_owned(),
            "CAP-MOD-EXECUTION".to_owned(),
        ])
    );
}

#[test]
fn resource_vectors_are_checked_component_wise() {
    let available = ResourceVectorV1 {
        cpu_millis: 10,
        memory_bytes: 20,
        ..ResourceVectorV1::default()
    };
    let used = ResourceVectorV1 {
        cpu_millis: 4,
        memory_bytes: 8,
        ..ResourceVectorV1::default()
    };
    assert_eq!(
        available.checked_sub(used).expect("subtraction"),
        ResourceVectorV1 {
            cpu_millis: 6,
            memory_bytes: 12,
            ..ResourceVectorV1::default()
        }
    );
    assert_eq!(
        used.checked_sub(available),
        Err(ModulePlatformError::ResourceUnderflow)
    );
}

fn canonical_test_hash<T: serde::Serialize>(value: &T) -> Sha256Digest {
    use sha2::{Digest, Sha256};

    let bytes = serde_json::to_vec(value).expect("canonical test JSON");
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
        .expect("test hash")
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryWireForTest {
    version: u16,
    protocol_version: u16,
    policy: RegistryPolicyV1,
    policy_hash: Sha256Digest,
    modules: BTreeMap<String, RegisteredModuleV1>,
    registry_hash: Sha256Digest,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactBodyForTest<'a> {
    version: u16,
    protocol_version: u16,
    policy: &'a RegistryPolicyV1,
    policy_hash: &'a Sha256Digest,
    modules: &'a BTreeMap<String, RegisteredModuleV1>,
}

fn rehash_forged_registry(wire: &mut RegistryWireForTest) {
    for registered in wire.modules.values_mut() {
        registered.manifest_hash = canonical_test_hash(&registered.manifest);
    }
    wire.policy_hash = canonical_test_hash(&wire.policy);
    wire.registry_hash = canonical_test_hash(&ArtifactBodyForTest {
        version: wire.version,
        protocol_version: wire.protocol_version,
        policy: &wire.policy,
        policy_hash: &wire.policy_hash,
        modules: &wire.modules,
    });
}

fn one_module_registry() -> ModuleRegistryArtifactV1 {
    let policy = RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.commit-sequencer".to_owned(),
        grants: BTreeMap::from([(
            "module.planner".to_owned(),
            grant(
                AuthorityClassV1::Pure,
                ActivationStateV1::Authoritative,
                &["CAP-SCH-PLAN"],
            ),
        )]),
    };
    let mut registry = ModuleRegistryV1::new(policy).expect("policy");
    registry
        .register(manifest(
            "module.planner",
            AuthorityClassV1::Pure,
            ActivationStateV1::Authoritative,
            &["CAP-SCH-PLAN"],
            Vec::new(),
        ))
        .expect("manifest");
    registry.finish().expect("registry")
}

#[test]
fn registry_decode_rejects_rehashed_authority_activation_and_capability_substitution() {
    let artifact = one_module_registry();
    let expected_policy_hash = artifact.policy_hash().clone();
    let canonical = serde_json::to_vec(&artifact).expect("registry encoding");

    let mut authority: RegistryWireForTest =
        serde_json::from_slice(&canonical).expect("authority wire");
    let grant = authority
        .policy
        .grants
        .get_mut("module.planner")
        .expect("grant");
    grant.authority = AuthorityClassV1::PreparedResultOnly;
    let registered = authority.modules.get_mut("module.planner").expect("module");
    registered.manifest.requested_authority = AuthorityClassV1::PreparedResultOnly;
    registered.manifest.module_kind = ModuleKindV1::TrustedInProcess;
    rehash_forged_registry(&mut authority);
    let authority_bytes = serde_json::to_vec(&authority).expect("authority bytes");
    assert_eq!(
        ModuleRegistryArtifactV1::decode_json(&authority_bytes, &expected_policy_hash),
        Err(ModulePlatformError::RegistryPolicyIdentityMismatch)
    );

    let mut activation: RegistryWireForTest =
        serde_json::from_slice(&canonical).expect("activation wire");
    activation
        .policy
        .grants
        .get_mut("module.planner")
        .expect("grant")
        .activation = ActivationStateV1::Shadow;
    activation
        .modules
        .get_mut("module.planner")
        .expect("module")
        .manifest
        .requested_activation = ActivationStateV1::Shadow;
    rehash_forged_registry(&mut activation);
    let activation_bytes = serde_json::to_vec(&activation).expect("activation bytes");
    assert_eq!(
        ModuleRegistryArtifactV1::decode_json(&activation_bytes, &expected_policy_hash),
        Err(ModulePlatformError::RegistryPolicyIdentityMismatch)
    );

    let mut capability: RegistryWireForTest =
        serde_json::from_slice(&canonical).expect("capability wire");
    capability
        .policy
        .grants
        .get_mut("module.planner")
        .expect("grant")
        .capability_ids = BTreeSet::from(["CAP-SCH-ALT".to_owned()]);
    capability
        .modules
        .get_mut("module.planner")
        .expect("module")
        .manifest
        .capability_ids = vec!["CAP-SCH-ALT".to_owned()];
    rehash_forged_registry(&mut capability);
    let capability_bytes = serde_json::to_vec(&capability).expect("capability bytes");
    assert_eq!(
        ModuleRegistryArtifactV1::decode_json(&capability_bytes, &expected_policy_hash),
        Err(ModulePlatformError::RegistryPolicyIdentityMismatch)
    );
}

#[test]
fn registry_decode_rejects_arbitrary_policy_hash_and_noncanonical_json() {
    let artifact = one_module_registry();
    let expected_policy_hash = artifact.policy_hash().clone();
    let canonical = serde_json::to_vec(&artifact).expect("registry encoding");
    let mut wire: RegistryWireForTest = serde_json::from_slice(&canonical).expect("wire");
    wire.policy_hash = digest('9');
    wire.registry_hash = canonical_test_hash(&ArtifactBodyForTest {
        version: wire.version,
        protocol_version: wire.protocol_version,
        policy: &wire.policy,
        policy_hash: &wire.policy_hash,
        modules: &wire.modules,
    });
    let forged = serde_json::to_vec(&wire).expect("forged bytes");
    assert_eq!(
        ModuleRegistryArtifactV1::decode_json(&forged, &expected_policy_hash),
        Err(ModulePlatformError::RegistryPolicyIdentityMismatch)
    );

    let pretty = serde_json::to_vec_pretty(&artifact).expect("pretty registry");
    assert_eq!(
        ModuleRegistryArtifactV1::decode_json(&pretty, &expected_policy_hash),
        Err(ModulePlatformError::RegistryDecodeInvalid)
    );
}

#[test]
fn manifests_candidates_and_results_require_canonical_order() {
    let capabilities = ["CAP-A", "CAP-Z"];
    let policy = RegistryPolicyV1 {
        version: 1,
        protocol_version: 1,
        central_writer_module_id: "module.commit-sequencer".to_owned(),
        grants: BTreeMap::from([(
            "module.executor".to_owned(),
            grant(
                AuthorityClassV1::PreparedResultOnly,
                ActivationStateV1::Shadow,
                &capabilities,
            ),
        )]),
    };
    let mut registry_builder = ModuleRegistryV1::new(policy).expect("policy");
    let unsorted_manifest = manifest(
        "module.executor",
        AuthorityClassV1::PreparedResultOnly,
        ActivationStateV1::Shadow,
        &["CAP-Z", "CAP-A"],
        Vec::new(),
    );
    assert_eq!(
        registry_builder.register(unsorted_manifest),
        Err(ModulePlatformError::ManifestInvalid)
    );

    registry_builder
        .register(manifest(
            "module.executor",
            AuthorityClassV1::PreparedResultOnly,
            ActivationStateV1::Shadow,
            &capabilities,
            Vec::new(),
        ))
        .expect("canonical manifest");
    let registry = registry_builder.finish().expect("registry");
    let snapshot = digest('b');
    let mut candidate = ActionCandidateV1 {
        version: 1,
        candidate_id: "candidate-1".to_owned(),
        decision_group: "group-1".to_owned(),
        module_id: "module.executor".to_owned(),
        module_version: "1.0.0".to_owned(),
        capability_id: "CAP-A".to_owned(),
        snapshot_hash: snapshot.clone(),
        dependency_candidate_ids: vec!["candidate-z".to_owned(), "candidate-a".to_owned()],
        resources: ResourceVectorV1 {
            cpu_millis: 10,
            ..ResourceVectorV1::default()
        },
        utility_micros: 100,
        cost_microusd: 20,
        uncertainty_ppm: 1_000,
        evidence_tier: QualificationTierV1::Source,
        payload_hash: digest('c'),
    };
    assert_eq!(
        candidate.validate(&registry, &snapshot),
        Err(ModulePlatformError::CandidateInvalid)
    );
    candidate.dependency_candidate_ids = vec!["candidate-a".to_owned(), "candidate-z".to_owned()];
    candidate
        .validate(&registry, &snapshot)
        .expect("canonical candidate");

    let plan_hash = digest('d');
    let result = PreparedResultV1 {
        version: 1,
        attempt_id: "attempt-1".to_owned(),
        snapshot_hash: snapshot,
        plan_hash: plan_hash.clone(),
        candidate_hash: candidate.candidate_hash().expect("candidate hash"),
        module_id: candidate.module_id.clone(),
        module_version: candidate.module_version.clone(),
        status: PreparedResultStatusV1::Prepared,
        artifact_hashes: vec![digest('f'), digest('e')],
        actual_resources: candidate.resources,
        actual_cost_microusd: 20,
        evidence_hash: digest('9'),
        external_action_may_have_started: false,
    };
    assert_eq!(
        result.validate(&candidate, &plan_hash),
        Err(ModulePlatformError::PreparedResultInvalid)
    );
}

fn lifecycle_profile(manifest: &ModuleManifestV1) -> ModuleLifecycleProfileV1 {
    ModuleLifecycleProfileV1 {
        version: 1,
        module_id: manifest.module_id.clone(),
        module_version: manifest.module_version.clone(),
        manifest_hash: module_protocol_hash_v1(manifest).expect("manifest hash"),
        side_effect_classes: BTreeSet::from([SideEffectClassV1::NoSideEffect]),
        determinism_class: DeterminismClassV1::Deterministic,
        maximum_inflight: 4,
        maximum_queue_depth: 16,
        resource_ceiling: ResourceVectorV1 {
            cpu_millis: 100,
            memory_bytes: 1_024,
            ..ResourceVectorV1::default()
        },
        maximum_latency_ms: 5_000,
        maximum_result_bytes: 65_536,
        readable_protocol_min: 1,
        readable_protocol_max: 1,
        readable_state_min: 1,
        writable_state_version: 1,
        rollout_channel: RolloutChannelV1::Authoritative,
        mutual_exclusion_group: None,
        rollback_version: manifest.rollback_version.clone(),
        canonical_workload_ids: vec!["WORKLOAD-MODULE-SMOKE".to_owned()],
    }
}

fn envelope(kind: ProtocolObjectKindV1, payload_hash: Sha256Digest) -> ProtocolEnvelopeV1 {
    ProtocolEnvelopeV1 {
        version: 1,
        kind,
        request_id: format!("request-{kind:?}"),
        created_at_unix_ms: 1_000,
        expires_at_unix_ms: 10_000,
        module_id: "module.planner".to_owned(),
        module_version: "1.0.0".to_owned(),
        protocol_version: 1,
        trace_id: "trace-1".to_owned(),
        payload_hash,
    }
}

fn planning_request() -> PlanningRequestV1 {
    PlanningRequestV1 {
        envelope: envelope(ProtocolObjectKindV1::PlanningRequest, digest('1')),
        planning_request_id: "planning-1".to_owned(),
        state_snapshot_hash: digest('2'),
        capability_id: "CAP-SCH-PLAN".to_owned(),
        hard_constraint_set_hash: digest('3'),
        objective_version: "objective-v1".to_owned(),
        resource_price_snapshot_hash: digest('4'),
        candidate_limit: 4,
        deadline_unix_ms: 9_000,
        allowed_side_effect_classes: BTreeSet::from([SideEffectClassV1::NoSideEffect]),
        input_artifact_hashes: vec![digest('5')],
    }
}

fn protocol_candidate(id: &str, utility: i64, cost: u64, cpu: u64) -> ActionCandidateV1 {
    ActionCandidateV1 {
        version: 1,
        candidate_id: id.to_owned(),
        decision_group: "planner-choice".to_owned(),
        module_id: "module.planner".to_owned(),
        module_version: "1.0.0".to_owned(),
        capability_id: "CAP-SCH-PLAN".to_owned(),
        snapshot_hash: digest('2'),
        dependency_candidate_ids: Vec::new(),
        resources: ResourceVectorV1 {
            cpu_millis: cpu,
            memory_bytes: cpu.saturating_mul(10),
            ..ResourceVectorV1::default()
        },
        utility_micros: utility,
        cost_microusd: cost,
        uncertainty_ppm: 1_000,
        evidence_tier: QualificationTierV1::Source,
        payload_hash: digest('6'),
    }
}

#[test]
fn protocol_objects_are_canonical_bounded_and_time_scoped() {
    let request = planning_request();
    request.validate(2_000).expect("request");
    let bytes = to_canonical_protocol_json_v1(&request).expect("canonical request");
    let decoded: PlanningRequestV1 =
        decode_canonical_protocol_json_v1(&bytes).expect("decode exact request");
    assert_eq!(decoded, request);

    let pretty = serde_json::to_vec_pretty(&request).expect("pretty");
    assert_eq!(
        decode_canonical_protocol_json_v1::<PlanningRequestV1>(&pretty),
        Err(ModulePlatformError::ProtocolInvalid)
    );

    let mut expired = request;
    expired.envelope.expires_at_unix_ms = 1_500;
    assert_eq!(
        expired.validate(2_000),
        Err(ModulePlatformError::ProtocolInvalid)
    );
}

#[test]
fn planning_response_and_collection_bind_registry_request_and_singleton_reason() {
    let registry = one_module_registry();
    let request = planning_request();
    let response = PlanningResponseV1 {
        envelope: envelope(ProtocolObjectKindV1::PlanningResponse, digest('7')),
        planning_request_hash: request.request_hash().expect("request hash"),
        candidates: vec![protocol_candidate("candidate-a", 100, 10, 10)],
        singleton_reason: Some("only_feasible_candidate".to_owned()),
    };
    response
        .validate(&request, &registry, 2_000)
        .expect("response");
    let collection = CandidateCollectionV1::collect(&request, &registry, vec![response], 2_000)
        .expect("collection");
    assert_eq!(collection.candidates.len(), 1);
    assert!(collection.dominated_candidate_ids.is_empty());
    assert_eq!(collection.response_hashes.len(), 1);
}

#[test]
fn pareto_reducer_preserves_dependencies_and_removes_only_strict_dominance() {
    let dominant = protocol_candidate("candidate-a", 200, 5, 5);
    let dominated = protocol_candidate("candidate-b", 100, 10, 10);
    let mut referenced = protocol_candidate("candidate-c", 50, 20, 20);
    referenced.dependency_candidate_ids = vec!["candidate-b".to_owned()];
    let (retained, removed) =
        pareto_reduce_candidates_v1(vec![referenced, dominated.clone(), dominant])
            .expect("reduction");
    assert!(
        removed.is_empty(),
        "referenced candidates cannot be removed"
    );
    assert_eq!(retained.len(), 3);

    let (retained, removed) = pareto_reduce_candidates_v1(vec![
        dominated,
        protocol_candidate("candidate-a", 200, 5, 5),
    ])
    .expect("unreferenced reduction");
    assert_eq!(removed, vec!["candidate-b".to_owned()]);
    assert_eq!(retained[0].candidate_id, "candidate-a");
}

#[test]
fn lifecycle_health_and_conformance_are_bounded_and_non_authorizing() {
    let registry = one_module_registry();
    let manifest = &registry.module("module.planner").expect("module").manifest;
    let profile = lifecycle_profile(manifest);
    profile.validate(manifest).expect("profile");
    let health = ModuleHealthReportV1::new(
        manifest,
        &profile,
        2_000,
        10_000,
        CircuitBreakerStateV1::Closed,
        1,
        2,
        Vec::new(),
    )
    .expect("health");
    assert!(
        health
            .admission_available(manifest, &profile, 3_000)
            .expect("available")
    );
    let report = module_contract_conformance_report_v1(manifest, &profile).expect("report");
    assert!(report.conformant);
    assert!(!report.grants_authority);
    assert_eq!(report.checks.len(), 10);
}

#[test]
fn lifecycle_rejects_owner_or_side_effect_escalation_and_classifies_changes() {
    let registry = one_module_registry();
    let manifest = &registry.module("module.planner").expect("module").manifest;
    let profile = lifecycle_profile(manifest);
    let mut hostile = profile.clone();
    hostile
        .side_effect_classes
        .insert(SideEffectClassV1::CentralStateCommit);
    assert_eq!(
        hostile.validate(manifest),
        Err(ModulePlatformError::LifecycleInvalid)
    );

    let mut next = profile.clone();
    next.maximum_latency_ms = 6_000;
    let decision =
        classify_registry_change_v1(manifest, &profile, manifest, &next).expect("classification");
    assert_eq!(decision.change_class, RegistryChangeClassV1::ResourceOrSlo);
    assert!(decision.requires_fresh_conformance);
    assert!(!decision.requires_cross_team_review);
}

#[test]
fn execution_and_cancellation_contracts_fail_closed_on_identity_drift() {
    let candidate = protocol_candidate("candidate-a", 100, 10, 10);
    let plan_hash = digest('8');
    let command = ExecutionCommandV1 {
        envelope: envelope(ProtocolObjectKindV1::ExecutionCommand, digest('9')),
        execution_id: "execution-1".to_owned(),
        plan_hash: plan_hash.clone(),
        selected_candidate_hash: candidate.candidate_hash().expect("candidate hash"),
        state_snapshot_hash: candidate.snapshot_hash.clone(),
        campaign_id: "campaign-1".to_owned(),
        node_id: "node-1".to_owned(),
        attempt_id: "attempt-1".to_owned(),
        lease_generation: 1,
        writer_generation: 1,
        resource_reservation_id: "reservation-1".to_owned(),
        resource_reservation_hash: digest('a'),
        resource_envelope: candidate.resources,
        deadline_unix_ms: 9_000,
        cancellation_id: "cancel-1".to_owned(),
        authority_audience: candidate.capability_id.clone(),
        idempotency_key: "idempotency-1".to_owned(),
        input_artifact_hashes: vec![digest('b')],
    };
    command
        .validate(&candidate, &plan_hash, 2_000)
        .expect("command");

    let cancel = CancellationRequestV1 {
        envelope: envelope(ProtocolObjectKindV1::CancellationRequest, digest('c')),
        execution_id: command.execution_id.clone(),
        execution_command_hash: command.command_hash().expect("command hash"),
        idempotency_key: "cancel-idempotency-1".to_owned(),
    };
    let ack = CancellationAcknowledgementV1 {
        envelope: envelope(
            ProtocolObjectKindV1::CancellationAcknowledgement,
            digest('d'),
        ),
        cancellation_request_hash: cancel.request_hash().expect("cancel hash"),
        execution_id: command.execution_id,
        disposition: CancellationDispositionV1::CancelledBeforeExternalEffect,
        prepared_result: None,
    };
    ack.validate(&cancel, 2_000).expect("ack");

    let mut hostile = ack;
    hostile.disposition = CancellationDispositionV1::PreparedResultAlreadyExists;
    assert_eq!(
        hostile.validate(&cancel, 2_000),
        Err(ModulePlatformError::CancellationInvalid)
    );
}

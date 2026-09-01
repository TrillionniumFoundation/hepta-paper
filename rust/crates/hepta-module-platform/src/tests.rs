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
    left.validate(left.policy_hash()).expect("registry validates");
    let expected_policy_hash = left.policy_hash().clone();
    let report = module_conformance_report_v1(&left, &expected_policy_hash)
        .expect("conformance");
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

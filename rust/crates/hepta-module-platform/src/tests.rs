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
    left.validate().expect("registry validates");
    let report = module_conformance_report_v1(&left).expect("conformance");
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

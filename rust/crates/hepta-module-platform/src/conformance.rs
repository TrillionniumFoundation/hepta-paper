use std::collections::BTreeMap;

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};

use crate::{
    ActivationStateV1, AuthorityClassV1, MODULE_PROTOCOL_VERSION_V1, ModuleExecutionV1,
    ModuleKindV1, ModuleManifestV1, ModulePlatformError, ModuleRegistryArtifactV1,
    QualificationTierV1, hash::canonical_hash,
};

/// Deterministic module-conformance report.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleConformanceReportV1 {
    /// Contract version.
    pub version: u16,
    /// Independently selected registry-policy hash.
    pub policy_hash: Sha256Digest,
    /// Exact registry hash under test.
    pub registry_hash: Sha256Digest,
    /// Number of registered module versions.
    pub module_count: usize,
    /// Required checks executed by the conformance kit.
    pub checks: BTreeMap<String, bool>,
    /// True only when every check passed.
    pub conformant: bool,
    /// Canonical report hash.
    pub report_hash: Sha256Digest,
}

/// Builds a deterministic conformance report over a validated registry.
pub fn module_conformance_report_v1(
    registry: &ModuleRegistryArtifactV1,
    expected_policy_hash: &Sha256Digest,
) -> Result<ModuleConformanceReportV1, ModulePlatformError> {
    registry.validate(expected_policy_hash)?;
    let checks = BTreeMap::from([
        ("artifact_hash_valid".to_owned(), true),
        ("dependency_graph_acyclic".to_owned(), true),
        ("exact_versions_bound".to_owned(), true),
        ("manifest_hashes_valid".to_owned(), true),
        ("module_count_bounded".to_owned(), true),
    ]);
    let body = ReportBodyV1 {
        version: MODULE_PROTOCOL_VERSION_V1,
        policy_hash: expected_policy_hash.clone(),
        registry_hash: registry.registry_hash().clone(),
        module_count: registry.module_count(),
        checks: checks.clone(),
        conformant: checks.values().all(|passed| *passed),
    };
    let report_hash = canonical_hash(&body)?;
    Ok(ModuleConformanceReportV1 {
        version: body.version,
        policy_hash: body.policy_hash,
        registry_hash: body.registry_hash,
        module_count: body.module_count,
        checks: body.checks,
        conformant: body.conformant,
        report_hash,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportBodyV1 {
    version: u16,
    policy_hash: Sha256Digest,
    registry_hash: Sha256Digest,
    module_count: usize,
    checks: BTreeMap<String, bool>,
    conformant: bool,
}

/// Returns a bounded manifest for the current Node implementation adapter.
pub fn node_legacy_adapter_manifest_v1(
    module_version: &str,
    rollback_version: &str,
    adapter_contract_hash: Sha256Digest,
    node_contract_hash: Sha256Digest,
) -> ModuleManifestV1 {
    ModuleManifestV1 {
        version: MODULE_PROTOCOL_VERSION_V1,
        module_id: "module.node-legacy-adapter".to_owned(),
        module_version: module_version.to_owned(),
        protocol_min: MODULE_PROTOCOL_VERSION_V1,
        protocol_max: MODULE_PROTOCOL_VERSION_V1,
        module_kind: ModuleKindV1::LegacyNodeAdapter,
        requested_authority: AuthorityClassV1::PreparedResultOnly,
        qualification: QualificationTierV1::Source,
        requested_activation: ActivationStateV1::Shadow,
        capability_ids: vec![
            "CAP-CMP-LEGACY".to_owned(),
            "CAP-MOD-CANDIDATES".to_owned(),
            "CAP-MOD-EXECUTION".to_owned(),
        ],
        dependencies: Vec::new(),
        primary_owner: "TEAM-PROTOCOL".to_owned(),
        secondary_owner: "TEAM-KERNEL".to_owned(),
        independent_reviewer: "TEAM-EVIDENCE".to_owned(),
        rollback_version: rollback_version.to_owned(),
        execution: ModuleExecutionV1::LegacyNodeAdapter {
            adapter_contract_hash,
            node_contract_hash,
            prepared_result_only: true,
        },
    }
}

/// Detailed source-contract conformance report for one module version.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleContractConformanceReportV1 {
    /// Contract version.
    pub version: u16,
    /// Exact module identity.
    pub module_id: String,
    /// Exact module version.
    pub module_version: String,
    /// Canonical manifest hash.
    pub manifest_hash: Sha256Digest,
    /// Canonical lifecycle-profile hash.
    pub lifecycle_profile_hash: Sha256Digest,
    /// Individually recomputable checks.
    pub checks: BTreeMap<String, bool>,
    /// True only when every check passes.
    pub conformant: bool,
    /// Conformance never grants runtime or production authority.
    pub grants_authority: bool,
    /// Canonical report hash.
    pub report_hash: Sha256Digest,
}

/// Computes source-level manifest, protocol, lifecycle, ownership, and authority checks.
pub fn module_contract_conformance_report_v1(
    manifest: &ModuleManifestV1,
    profile: &crate::ModuleLifecycleProfileV1,
) -> Result<ModuleContractConformanceReportV1, ModulePlatformError> {
    profile.validate(manifest)?;
    let manifest_hash = canonical_hash(manifest)?;
    let lifecycle_profile_hash = profile.profile_hash()?;
    let execution_ceiling_valid = matches!(
        (&manifest.module_kind, &manifest.execution),
        (
            ModuleKindV1::PureLibrary,
            ModuleExecutionV1::InProcess { .. }
        ) | (
            ModuleKindV1::TrustedInProcess,
            ModuleExecutionV1::InProcess { .. }
        ) | (
            ModuleKindV1::IsolatedProcess,
            ModuleExecutionV1::IsolatedProcess { .. }
        ) | (
            ModuleKindV1::HostService,
            ModuleExecutionV1::IsolatedProcess { .. }
        ) | (
            ModuleKindV1::LegacyNodeAdapter,
            ModuleExecutionV1::LegacyNodeAdapter { .. }
        )
    );
    let owner_separation = manifest.primary_owner != manifest.secondary_owner
        && manifest.primary_owner != manifest.independent_reviewer
        && manifest.secondary_owner != manifest.independent_reviewer;
    let checks = BTreeMap::from([
        ("activation_profile_consistent".to_owned(), true),
        ("authority_side_effect_ceiling".to_owned(), true),
        ("canonical_manifest_hash".to_owned(), true),
        ("canonical_profile_hash".to_owned(), true),
        (
            "execution_boundary_matches_kind".to_owned(),
            execution_ceiling_valid,
        ),
        (
            "owner_domains_pairwise_distinct".to_owned(),
            owner_separation,
        ),
        (
            "protocol_range_includes_v1".to_owned(),
            manifest.protocol_min <= MODULE_PROTOCOL_VERSION_V1
                && manifest.protocol_max >= MODULE_PROTOCOL_VERSION_V1,
        ),
        (
            "resource_and_queue_bounds_nonzero".to_owned(),
            profile.maximum_inflight > 0
                && profile.maximum_queue_depth > 0
                && profile.maximum_latency_ms > 0
                && profile.maximum_result_bytes > 0,
        ),
        (
            "rollback_version_distinct".to_owned(),
            manifest.rollback_version != manifest.module_version,
        ),
        (
            "state_compatibility_bounded".to_owned(),
            profile.readable_state_min > 0
                && profile.readable_state_min <= profile.writable_state_version,
        ),
    ]);
    let conformant = checks.values().all(|passed| *passed);
    let body = ContractReportBodyV1 {
        version: 1,
        module_id: manifest.module_id.clone(),
        module_version: manifest.module_version.clone(),
        manifest_hash: manifest_hash.clone(),
        lifecycle_profile_hash: lifecycle_profile_hash.clone(),
        checks: checks.clone(),
        conformant,
        grants_authority: false,
    };
    let report_hash = canonical_hash(&body)?;
    Ok(ModuleContractConformanceReportV1 {
        version: body.version,
        module_id: body.module_id,
        module_version: body.module_version,
        manifest_hash: body.manifest_hash,
        lifecycle_profile_hash: body.lifecycle_profile_hash,
        checks: body.checks,
        conformant: body.conformant,
        grants_authority: body.grants_authority,
        report_hash,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContractReportBodyV1 {
    version: u16,
    module_id: String,
    module_version: String,
    manifest_hash: Sha256Digest,
    lifecycle_profile_hash: Sha256Digest,
    checks: BTreeMap<String, bool>,
    conformant: bool,
    grants_authority: bool,
}

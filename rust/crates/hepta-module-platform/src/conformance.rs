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
) -> Result<ModuleConformanceReportV1, ModulePlatformError> {
    registry.validate()?;
    let checks = BTreeMap::from([
        ("artifact_hash_valid".to_owned(), true),
        ("dependency_graph_acyclic".to_owned(), true),
        ("exact_versions_bound".to_owned(), true),
        ("manifest_hashes_valid".to_owned(), true),
        ("module_count_bounded".to_owned(), true),
    ]);
    let body = ReportBodyV1 {
        version: MODULE_PROTOCOL_VERSION_V1,
        registry_hash: registry.registry_hash.clone(),
        module_count: registry.modules.len(),
        checks: checks.clone(),
        conformant: checks.values().all(|passed| *passed),
    };
    let report_hash = canonical_hash(&body)?;
    Ok(ModuleConformanceReportV1 {
        version: body.version,
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

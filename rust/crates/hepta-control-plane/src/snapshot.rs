use std::collections::{BTreeMap, BTreeSet};

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::{ModuleRegistryArtifactV1, ResourceVectorV1};
use serde::{Deserialize, Serialize};

use crate::{ControlPlaneError, ControlPlaneSnapshotV1, canonical_hash_v1};

const MAXIMUM_STATE_COMPONENTS: usize = 4_096;

/// One exact immutable read-model component consumed by snapshot construction.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotStateComponentV1 {
    /// Stable component identifier.
    pub component_id: String,
    /// Monotonic source generation.
    pub generation: u64,
    /// Exact content identity of the component bytes/projection.
    pub content_hash: Sha256Digest,
}

/// Complete deterministic source material for one planning snapshot.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotMaterialV1 {
    /// Contract version, exactly one.
    pub version: u16,
    /// Stable campaign identity.
    pub campaign_id: String,
    /// Last committed campaign revision before this planning cycle.
    pub persisted_campaign_revision: u64,
    /// Exact immutable read-model components keyed by their stable IDs.
    pub state_components: BTreeMap<String, SnapshotStateComponentV1>,
    /// Versioned objective identity.
    pub objective_version: String,
    /// Exact hard-policy/constraint-set identity.
    pub constraint_set_hash: Sha256Digest,
    /// Hard aggregate resource ceiling for the plan.
    pub resource_limit: ResourceVectorV1,
    /// Hard aggregate cost ceiling.
    pub budget_microusd: u64,
    /// Capabilities that the completed plan must cover.
    pub required_capability_ids: BTreeSet<String>,
    /// Explicit seed when stochastic downstream code is permitted.
    pub random_seed: Option<u64>,
}

/// Recomputable receipt proving how an immutable control-plane snapshot was built.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotBuildReceiptV1 {
    /// Contract version.
    pub version: u16,
    /// Exact source-material identity.
    pub material_hash: Sha256Digest,
    /// Constructed immutable snapshot.
    pub snapshot: ControlPlaneSnapshotV1,
    /// Canonical snapshot identity.
    pub snapshot_hash: Sha256Digest,
    /// Canonical receipt identity.
    pub receipt_hash: Sha256Digest,
}

/// Builds a planning snapshot exclusively from explicit immutable source material.
///
/// Ambient wall-clock state, map iteration order, process identity and repository
/// mutation are not inputs. The registry is independently validated against the
/// expected policy hash before its identity is bound into the snapshot.
pub fn build_snapshot_v1(
    material: SnapshotMaterialV1,
    registry: &ModuleRegistryArtifactV1,
    expected_registry_policy_hash: &Sha256Digest,
) -> Result<SnapshotBuildReceiptV1, ControlPlaneError> {
    validate_material(&material)?;
    registry
        .validate(expected_registry_policy_hash)
        .map_err(|_| ControlPlaneError::ModulePlatformRejected)?;
    if registry.policy_hash() != expected_registry_policy_hash {
        return Err(ControlPlaneError::SnapshotInvalid);
    }
    let campaign_revision = material
        .persisted_campaign_revision
        .checked_add(1)
        .ok_or(ControlPlaneError::SnapshotInvalid)?;
    let state_subject = SnapshotStateSubjectV1 {
        version: 1,
        campaign_id: &material.campaign_id,
        persisted_campaign_revision: material.persisted_campaign_revision,
        state_components: &material.state_components,
    };
    let state_hash = canonical_hash_v1(&state_subject)?;
    let snapshot = ControlPlaneSnapshotV1 {
        version: 1,
        campaign_id: material.campaign_id.clone(),
        campaign_revision,
        state_hash,
        registry_hash: registry.registry_hash().clone(),
        registry_policy_hash: expected_registry_policy_hash.clone(),
        objective_version: material.objective_version.clone(),
        constraint_set_hash: material.constraint_set_hash.clone(),
        resource_limit: material.resource_limit,
        budget_microusd: material.budget_microusd,
        required_capability_ids: material.required_capability_ids.clone(),
        random_seed: material.random_seed,
    };
    snapshot.validate(registry)?;
    let material_hash = canonical_hash_v1(&material)?;
    let snapshot_hash = snapshot.snapshot_hash()?;
    let body = SnapshotReceiptBodyV1 {
        version: 1,
        material_hash: &material_hash,
        snapshot: &snapshot,
        snapshot_hash: &snapshot_hash,
    };
    let receipt_hash = canonical_hash_v1(&body)?;
    Ok(SnapshotBuildReceiptV1 {
        version: body.version,
        material_hash,
        snapshot,
        snapshot_hash,
        receipt_hash,
    })
}

fn validate_material(material: &SnapshotMaterialV1) -> Result<(), ControlPlaneError> {
    if material.version != 1
        || !valid_identifier(&material.campaign_id)
        || !valid_identifier(&material.objective_version)
        || material.state_components.is_empty()
        || material.state_components.len() > MAXIMUM_STATE_COMPONENTS
        || material.resource_limit.is_zero()
        || material.required_capability_ids.is_empty()
        || material
            .required_capability_ids
            .iter()
            .any(|capability| !valid_capability_id(capability))
    {
        return Err(ControlPlaneError::SnapshotInvalid);
    }
    for (component_id, component) in &material.state_components {
        if component_id != &component.component_id
            || !valid_identifier(component_id)
            || component.generation == 0
        {
            return Err(ControlPlaneError::SnapshotInvalid);
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotStateSubjectV1<'a> {
    version: u16,
    campaign_id: &'a str,
    persisted_campaign_revision: u64,
    state_components: &'a BTreeMap<String, SnapshotStateComponentV1>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotReceiptBodyV1<'a> {
    version: u16,
    material_hash: &'a Sha256Digest,
    snapshot: &'a ControlPlaneSnapshotV1,
    snapshot_hash: &'a Sha256Digest,
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
        })
}

fn valid_capability_id(value: &str) -> bool {
    value.starts_with("CAP-")
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
}

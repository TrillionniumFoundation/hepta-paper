//! Source-level Node-to-Rust migration closure contracts.
//!
//! These contracts record a complete incumbent capability inventory and compare
//! Node/Rust shadow results. They cannot activate Rust, commit campaign state,
//! authorize external effects, cut over writers, or retire Node.

use std::str::FromStr;

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::{LegacyParityClassV1, PreparedResultStatusV1, ResourceVectorV1};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_CAPABILITIES: usize = 256;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyCapabilityInventoryEntryV1 {
    pub version: u16,
    pub capability_id: String,
    pub node_entrypoint: String,
    pub node_entrypoint_hash: Sha256Digest,
    pub node_contract_hash: Sha256Digest,
    pub translation_policy_hash: Sha256Digest,
    pub parity_class: LegacyParityClassV1,
    pub resources: ResourceVectorV1,
    pub maximum_cost_microusd: u64,
    pub rollback_target: String,
}

impl LegacyCapabilityInventoryEntryV1 {
    fn validate(&self) -> Result<(), MigrationClosureError> {
        if self.version != 1
            || !valid_capability_id(&self.capability_id)
            || !valid_repository_relative_path(&self.node_entrypoint)
            || self.resources.is_zero()
            || self.resources.external_actions != 0
            || self.resources.central_writer_turns != 0
            || !valid_identifier(&self.rollback_target, 128)
        {
            return Err(MigrationClosureError::InventoryInvalid);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyCapabilityInventoryV1 {
    pub version: u16,
    pub required_capability_ids: Vec<String>,
    pub entries: Vec<LegacyCapabilityInventoryEntryV1>,
    pub grants_authority: bool,
    pub inventory_hash: Sha256Digest,
}

/// Builds a canonical inventory and requires exact set equality with the
/// caller-supplied incumbent capability set. Missing coverage is a hard error.
pub fn build_legacy_capability_inventory_v1(
    mut required_capability_ids: Vec<String>,
    mut entries: Vec<LegacyCapabilityInventoryEntryV1>,
) -> Result<LegacyCapabilityInventoryV1, MigrationClosureError> {
    if required_capability_ids.is_empty()
        || required_capability_ids.len() > MAXIMUM_CAPABILITIES
        || entries.is_empty()
        || entries.len() > MAXIMUM_CAPABILITIES
        || required_capability_ids
            .iter()
            .any(|capability| !valid_capability_id(capability))
    {
        return Err(MigrationClosureError::InventoryInvalid);
    }

    required_capability_ids.sort();
    if required_capability_ids
        .windows(2)
        .any(|window| window[0] == window[1])
    {
        return Err(MigrationClosureError::InventoryInvalid);
    }

    for entry in &entries {
        entry.validate()?;
    }
    entries.sort_by(|left, right| left.capability_id.cmp(&right.capability_id));
    let entry_ids = entries
        .iter()
        .map(|entry| entry.capability_id.as_str())
        .collect::<Vec<_>>();
    let required_ids = required_capability_ids
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    if entries
        .windows(2)
        .any(|window| window[0].capability_id == window[1].capability_id)
        || entry_ids != required_ids
    {
        return Err(MigrationClosureError::InventoryIncomplete);
    }

    let body = LegacyCapabilityInventoryBodyV1 {
        version: 1,
        required_capability_ids: &required_capability_ids,
        entries: &entries,
        grants_authority: false,
    };
    let inventory_hash = canonical_digest("HeptaLegacyCapabilityInventoryV1", &body)?;
    Ok(LegacyCapabilityInventoryV1 {
        version: 1,
        required_capability_ids,
        entries,
        grants_authority: false,
        inventory_hash,
    })
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyShadowPolicyV1 {
    pub version: u16,
    pub capability_id: String,
    pub parity_class: LegacyParityClassV1,
    pub minimum_evaluation_score_ppm: u32,
    pub maximum_evaluation_delta_ppm: u32,
}

impl LegacyShadowPolicyV1 {
    fn validate(&self) -> Result<(), MigrationClosureError> {
        let evaluation = matches!(self.parity_class, LegacyParityClassV1::Evaluation);
        if self.version != 1
            || !valid_capability_id(&self.capability_id)
            || self.minimum_evaluation_score_ppm > 1_000_000
            || self.maximum_evaluation_delta_ppm > 1_000_000
            || (!evaluation
                && (self.minimum_evaluation_score_ppm != 0
                    || self.maximum_evaluation_delta_ppm != 0))
        {
            return Err(MigrationClosureError::PolicyInvalid);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyShadowResultV1 {
    pub version: u16,
    pub status: PreparedResultStatusV1,
    pub output_projection_hash: Sha256Digest,
    pub semantic_invariant_hash: Option<Sha256Digest>,
    pub evaluation_score_ppm: Option<u32>,
    pub actual_resources: ResourceVectorV1,
    pub actual_cost_microusd: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyShadowComparisonReceiptV1 {
    pub version: u16,
    pub capability_id: String,
    pub parity_class: LegacyParityClassV1,
    pub inventory_entry_hash: Sha256Digest,
    pub node_result_hash: Sha256Digest,
    pub rust_result_hash: Sha256Digest,
    pub evaluator_evidence_hash: Option<Sha256Digest>,
    pub accepted: bool,
    pub grants_authority: bool,
    pub comparison_hash: Sha256Digest,
}

/// Compares incumbent Node and Rust replacement results under a closed parity
/// policy. An accepted receipt is evidence only and grants no authority.
pub fn compare_legacy_shadow_v1(
    inventory_entry: &LegacyCapabilityInventoryEntryV1,
    policy: &LegacyShadowPolicyV1,
    node: &LegacyShadowResultV1,
    rust: &LegacyShadowResultV1,
    evaluator_evidence_hash: Option<Sha256Digest>,
) -> Result<LegacyShadowComparisonReceiptV1, MigrationClosureError> {
    inventory_entry.validate()?;
    policy.validate()?;
    if inventory_entry.capability_id != policy.capability_id
        || inventory_entry.parity_class != policy.parity_class
    {
        return Err(MigrationClosureError::PolicyInvalid);
    }
    validate_shadow_result(inventory_entry, node)?;
    validate_shadow_result(inventory_entry, rust)?;

    let accepted = match policy.parity_class {
        LegacyParityClassV1::Exact => {
            evaluator_evidence_hash.is_none()
                && node.status == rust.status
                && node.output_projection_hash == rust.output_projection_hash
        }
        LegacyParityClassV1::Semantic => {
            evaluator_evidence_hash.is_none()
                && node.status == rust.status
                && node.semantic_invariant_hash.is_some()
                && node.semantic_invariant_hash == rust.semantic_invariant_hash
        }
        LegacyParityClassV1::Evaluation => {
            let node_score = node
                .evaluation_score_ppm
                .ok_or(MigrationClosureError::ObservationInvalid)?;
            let rust_score = rust
                .evaluation_score_ppm
                .ok_or(MigrationClosureError::ObservationInvalid)?;
            evaluator_evidence_hash.is_some()
                && node_score >= policy.minimum_evaluation_score_ppm
                && rust_score >= policy.minimum_evaluation_score_ppm
                && node_score.abs_diff(rust_score) <= policy.maximum_evaluation_delta_ppm
        }
    };

    let inventory_entry_hash = canonical_digest("HeptaLegacyInventoryEntryV1", inventory_entry)?;
    let node_result_hash = canonical_digest("HeptaLegacyShadowResultV1", node)?;
    let rust_result_hash = canonical_digest("HeptaLegacyShadowResultV1", rust)?;
    let body = LegacyShadowComparisonBodyV1 {
        version: 1,
        capability_id: &policy.capability_id,
        parity_class: policy.parity_class,
        inventory_entry_hash: &inventory_entry_hash,
        node_result_hash: &node_result_hash,
        rust_result_hash: &rust_result_hash,
        evaluator_evidence_hash: evaluator_evidence_hash.as_ref(),
        accepted,
        grants_authority: false,
    };
    let comparison_hash = canonical_digest("HeptaLegacyShadowComparisonV1", &body)?;
    Ok(LegacyShadowComparisonReceiptV1 {
        version: 1,
        capability_id: policy.capability_id.clone(),
        parity_class: policy.parity_class,
        inventory_entry_hash,
        node_result_hash,
        rust_result_hash,
        evaluator_evidence_hash,
        accepted,
        grants_authority: false,
        comparison_hash,
    })
}

fn validate_shadow_result(
    entry: &LegacyCapabilityInventoryEntryV1,
    result: &LegacyShadowResultV1,
) -> Result<(), MigrationClosureError> {
    if result.version != 1
        || !result.actual_resources.fits_within(entry.resources)
        || result.actual_resources.external_actions != 0
        || result.actual_resources.central_writer_turns != 0
        || result.actual_cost_microusd > entry.maximum_cost_microusd
        || result
            .evaluation_score_ppm
            .is_some_and(|score| score > 1_000_000)
    {
        return Err(MigrationClosureError::ObservationInvalid);
    }

    let shape_is_valid = match entry.parity_class {
        LegacyParityClassV1::Exact => {
            result.semantic_invariant_hash.is_none() && result.evaluation_score_ppm.is_none()
        }
        LegacyParityClassV1::Semantic => {
            result.semantic_invariant_hash.is_some() && result.evaluation_score_ppm.is_none()
        }
        LegacyParityClassV1::Evaluation => result.evaluation_score_ppm.is_some(),
    };
    if !shape_is_valid {
        return Err(MigrationClosureError::ObservationInvalid);
    }
    Ok(())
}

fn valid_capability_id(value: &str) -> bool {
    value.starts_with("CAP-")
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/')
        })
}

fn valid_repository_relative_path(value: &str) -> bool {
    valid_identifier(value, 512)
        && !value.starts_with('/')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn canonical_digest<T: Serialize>(
    domain: &str,
    value: &T,
) -> Result<Sha256Digest, MigrationClosureError> {
    let bytes = serde_json::to_vec(value).map_err(|_| MigrationClosureError::Encoding)?;
    let mut hasher = Sha256::new();
    update_hash(&mut hasher, domain.as_bytes());
    update_hash(&mut hasher, &bytes);
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
        .map_err(|_| MigrationClosureError::Encoding)
}

fn update_hash(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCapabilityInventoryBodyV1<'a> {
    version: u16,
    required_capability_ids: &'a [String],
    entries: &'a [LegacyCapabilityInventoryEntryV1],
    grants_authority: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyShadowComparisonBodyV1<'a> {
    version: u16,
    capability_id: &'a str,
    parity_class: LegacyParityClassV1,
    inventory_entry_hash: &'a Sha256Digest,
    node_result_hash: &'a Sha256Digest,
    rust_result_hash: &'a Sha256Digest,
    evaluator_evidence_hash: Option<&'a Sha256Digest>,
    accepted: bool,
    grants_authority: bool,
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum MigrationClosureError {
    #[error("legacy capability inventory is invalid")]
    InventoryInvalid,
    #[error("legacy capability inventory is incomplete")]
    InventoryIncomplete,
    #[error("legacy shadow policy is invalid")]
    PolicyInvalid,
    #[error("legacy shadow observation is invalid")]
    ObservationInvalid,
    #[error("migration closure encoding failed")]
    Encoding,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(marker: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", marker.to_string().repeat(64)))
            .expect("test digest")
    }

    fn resources() -> ResourceVectorV1 {
        ResourceVectorV1 {
            cpu_millis: 100,
            memory_bytes: 4096,
            ..ResourceVectorV1::default()
        }
    }

    fn entry(
        capability: &str,
        parity_class: LegacyParityClassV1,
    ) -> LegacyCapabilityInventoryEntryV1 {
        LegacyCapabilityInventoryEntryV1 {
            version: 1,
            capability_id: capability.to_owned(),
            node_entrypoint: format!("paper-core/bin/{}.mjs", capability.to_ascii_lowercase()),
            node_entrypoint_hash: digest('a'),
            node_contract_hash: digest('b'),
            translation_policy_hash: digest('c'),
            parity_class,
            resources: resources(),
            maximum_cost_microusd: 100,
            rollback_target: "node-v1".to_owned(),
        }
    }

    fn result(parity_class: LegacyParityClassV1, output: char) -> LegacyShadowResultV1 {
        LegacyShadowResultV1 {
            version: 1,
            status: PreparedResultStatusV1::Prepared,
            output_projection_hash: digest(output),
            semantic_invariant_hash: matches!(parity_class, LegacyParityClassV1::Semantic)
                .then(|| digest('d')),
            evaluation_score_ppm: matches!(parity_class, LegacyParityClassV1::Evaluation)
                .then_some(900_000),
            actual_resources: ResourceVectorV1 {
                cpu_millis: 50,
                memory_bytes: 2048,
                ..ResourceVectorV1::default()
            },
            actual_cost_microusd: 50,
        }
    }

    #[test]
    fn inventory_is_complete_and_deterministic() {
        let required = vec!["CAP-AUTHOR".to_owned(), "CAP-REVIEW".to_owned()];
        let left = build_legacy_capability_inventory_v1(
            required.clone(),
            vec![
                entry("CAP-REVIEW", LegacyParityClassV1::Evaluation),
                entry("CAP-AUTHOR", LegacyParityClassV1::Evaluation),
            ],
        )
        .expect("inventory");
        let right = build_legacy_capability_inventory_v1(
            required,
            vec![
                entry("CAP-AUTHOR", LegacyParityClassV1::Evaluation),
                entry("CAP-REVIEW", LegacyParityClassV1::Evaluation),
            ],
        )
        .expect("inventory");
        assert_eq!(left, right);
        assert!(!left.grants_authority);
    }

    #[test]
    fn incomplete_inventory_rejects() {
        assert_eq!(
            build_legacy_capability_inventory_v1(
                vec!["CAP-AUTHOR".to_owned(), "CAP-REVIEW".to_owned()],
                vec![entry("CAP-AUTHOR", LegacyParityClassV1::Evaluation)],
            ),
            Err(MigrationClosureError::InventoryIncomplete)
        );
    }

    #[test]
    fn exact_shadow_detects_drift_without_authority() {
        let inventory = entry("CAP-BUILD", LegacyParityClassV1::Exact);
        let policy = LegacyShadowPolicyV1 {
            version: 1,
            capability_id: "CAP-BUILD".to_owned(),
            parity_class: LegacyParityClassV1::Exact,
            minimum_evaluation_score_ppm: 0,
            maximum_evaluation_delta_ppm: 0,
        };
        let node = result(LegacyParityClassV1::Exact, '1');
        let equal = compare_legacy_shadow_v1(&inventory, &policy, &node, &node, None)
            .expect("equal comparison");
        assert!(equal.accepted);
        assert!(!equal.grants_authority);

        let rust = result(LegacyParityClassV1::Exact, '2');
        let drift = compare_legacy_shadow_v1(&inventory, &policy, &node, &rust, None)
            .expect("drift comparison");
        assert!(!drift.accepted);
    }

    #[test]
    fn evaluation_requires_independent_evidence() {
        let inventory = entry("CAP-REVIEW", LegacyParityClassV1::Evaluation);
        let policy = LegacyShadowPolicyV1 {
            version: 1,
            capability_id: "CAP-REVIEW".to_owned(),
            parity_class: LegacyParityClassV1::Evaluation,
            minimum_evaluation_score_ppm: 800_000,
            maximum_evaluation_delta_ppm: 50_000,
        };
        let node = result(LegacyParityClassV1::Evaluation, '5');
        let rust = result(LegacyParityClassV1::Evaluation, '6');
        assert!(
            !compare_legacy_shadow_v1(&inventory, &policy, &node, &rust, None)
                .expect("comparison")
                .accepted
        );
        assert!(
            compare_legacy_shadow_v1(&inventory, &policy, &node, &rust, Some(digest('9')))
                .expect("comparison")
                .accepted
        );
    }

    #[test]
    fn over_budget_observation_rejects() {
        let inventory = entry("CAP-BUILD", LegacyParityClassV1::Exact);
        let policy = LegacyShadowPolicyV1 {
            version: 1,
            capability_id: "CAP-BUILD".to_owned(),
            parity_class: LegacyParityClassV1::Exact,
            minimum_evaluation_score_ppm: 0,
            maximum_evaluation_delta_ppm: 0,
        };
        let node = result(LegacyParityClassV1::Exact, '1');
        let mut rust = node.clone();
        rust.actual_cost_microusd = 101;
        assert_eq!(
            compare_legacy_shadow_v1(&inventory, &policy, &node, &rust, None),
            Err(MigrationClosureError::ObservationInvalid)
        );
    }
}

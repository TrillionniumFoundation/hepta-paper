use std::collections::BTreeMap;

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    LegacyParityClassV1,
    hash::canonical_hash,
    types::{valid_capability_id, valid_module_id},
};

/// Ordered migration stage for one capability.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityMigrationStageV1 {
    /// Incumbent Node capability is the only executable authority.
    NodeAuthoritative,
    /// Rust executes only in shadow while Node remains authoritative.
    RustShadow,
    /// Rust executes a bounded non-authoritative canary while Node remains authoritative.
    RustCanary,
    /// Rust owns capability authority; Node execution is fenced and recovery is forward-only.
    RustAuthoritative,
    /// Node execution is removed from the accepted deployment set.
    NodeRetired,
}

impl CapabilityMigrationStageV1 {
    fn rank(self) -> u8 {
        match self {
            Self::NodeAuthoritative => 0,
            Self::RustShadow => 1,
            Self::RustCanary => 2,
            Self::RustAuthoritative => 3,
            Self::NodeRetired => 4,
        }
    }
}

/// Current authoritative implementation for a capability.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityAuthorityOwnerV1 {
    /// Incumbent Node implementation remains authoritative.
    Node,
    /// Rust implementation is authoritative.
    Rust,
}

/// Closed rollback/recovery disposition for one migration stage.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityRecoveryModeV1 {
    /// Before Rust receives authoritative writer ownership, a failed shadow/canary may return
    /// to the unchanged Node writer after reconciliation.
    NodeRollbackBeforeRustAuthority,
    /// After the first authoritative Rust commit, recovery must preserve Rust state and move
    /// forward. Re-enabling the legacy Node writer is forbidden.
    ForwardOnlyAfterRustAuthority,
}

/// Exact migration evidence and reachability state for one capability.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityMigrationRecordV1 {
    /// Contract version.
    pub version: u16,
    /// Stable capability identity.
    pub capability_id: String,
    /// Incumbent Node module identity.
    pub node_module_id: String,
    /// Replacement Rust module identity.
    pub rust_module_id: String,
    /// Immutable Node behavior/authority contract identity.
    pub node_contract_hash: Sha256Digest,
    /// Immutable Rust behavior/authority contract identity.
    pub rust_contract_hash: Sha256Digest,
    /// Required parity classification.
    pub parity_class: LegacyParityClassV1,
    /// Whether promotion eventually requires separately controlled external authority.
    pub requires_external_authority: bool,
    /// Ordered migration stage.
    pub stage: CapabilityMigrationStageV1,
    /// Current authoritative implementation.
    pub authoritative_owner: CapabilityAuthorityOwnerV1,
    /// Closed rollback/recovery mode for this stage.
    pub recovery_mode: CapabilityRecoveryModeV1,
    /// Whether the incumbent Node entrypoint remains executable in the accepted deployment set.
    pub node_execution_enabled: bool,
    /// Whether the Rust entrypoint is executable in the accepted deployment set.
    pub rust_execution_enabled: bool,
    /// Translation/parity evidence binding Node and Rust representations.
    pub translation_receipt_hash: Option<Sha256Digest>,
    /// Accepted shadow comparison receipt.
    pub shadow_receipt_hash: Option<Sha256Digest>,
    /// Accepted bounded canary receipt.
    pub canary_receipt_hash: Option<Sha256Digest>,
    /// Exercised pre-authority rollback/reconciliation receipt.
    pub rollback_receipt_hash: Option<Sha256Digest>,
    /// Immutable legacy drain/freeze receipt required before Rust writer ownership.
    pub legacy_freeze_receipt_hash: Option<Sha256Digest>,
    /// Accepted atomic authority-transfer receipt.
    pub authority_transfer_receipt_hash: Option<Sha256Digest>,
    /// Receipt for the first authoritative Rust commit after writer transfer.
    pub first_rust_commit_receipt_hash: Option<Sha256Digest>,
    /// Accepted independently controlled external-authority receipt when required.
    pub external_authority_receipt_hash: Option<Sha256Digest>,
    /// Accepted proof that the Node authority path is disabled and retired.
    pub node_retirement_receipt_hash: Option<Sha256Digest>,
}

impl CapabilityMigrationRecordV1 {
    /// Validates monotonic migration invariants and forbids dual authority.
    pub fn validate(&self) -> Result<(), CapabilityMigrationError> {
        if self.version != 1
            || !valid_capability_id(&self.capability_id)
            || !valid_module_id(&self.node_module_id)
            || !valid_module_id(&self.rust_module_id)
            || self.node_module_id == self.rust_module_id
        {
            return Err(CapabilityMigrationError::RecordInvalid);
        }

        match self.stage {
            CapabilityMigrationStageV1::NodeAuthoritative => {
                if self.authoritative_owner != CapabilityAuthorityOwnerV1::Node
                    || self.recovery_mode
                        != CapabilityRecoveryModeV1::NodeRollbackBeforeRustAuthority
                    || !self.node_execution_enabled
                    || self.rust_execution_enabled
                    || self.shadow_receipt_hash.is_some()
                    || self.canary_receipt_hash.is_some()
                    || self.rollback_receipt_hash.is_some()
                    || self.legacy_freeze_receipt_hash.is_some()
                    || self.authority_transfer_receipt_hash.is_some()
                    || self.first_rust_commit_receipt_hash.is_some()
                    || self.node_retirement_receipt_hash.is_some()
                {
                    return Err(CapabilityMigrationError::StageInvariantInvalid);
                }
            }
            CapabilityMigrationStageV1::RustShadow => {
                if self.authoritative_owner != CapabilityAuthorityOwnerV1::Node
                    || self.recovery_mode
                        != CapabilityRecoveryModeV1::NodeRollbackBeforeRustAuthority
                    || !self.node_execution_enabled
                    || !self.rust_execution_enabled
                    || self.translation_receipt_hash.is_none()
                    || self.shadow_receipt_hash.is_none()
                    || self.canary_receipt_hash.is_some()
                    || self.rollback_receipt_hash.is_some()
                    || self.legacy_freeze_receipt_hash.is_some()
                    || self.authority_transfer_receipt_hash.is_some()
                    || self.first_rust_commit_receipt_hash.is_some()
                    || self.node_retirement_receipt_hash.is_some()
                {
                    return Err(CapabilityMigrationError::StageInvariantInvalid);
                }
            }
            CapabilityMigrationStageV1::RustCanary => {
                if self.authoritative_owner != CapabilityAuthorityOwnerV1::Node
                    || self.recovery_mode
                        != CapabilityRecoveryModeV1::NodeRollbackBeforeRustAuthority
                    || !self.node_execution_enabled
                    || !self.rust_execution_enabled
                    || self.translation_receipt_hash.is_none()
                    || self.shadow_receipt_hash.is_none()
                    || self.canary_receipt_hash.is_none()
                    || self.rollback_receipt_hash.is_none()
                    || self.legacy_freeze_receipt_hash.is_some()
                    || self.authority_transfer_receipt_hash.is_some()
                    || self.first_rust_commit_receipt_hash.is_some()
                    || self.node_retirement_receipt_hash.is_some()
                {
                    return Err(CapabilityMigrationError::StageInvariantInvalid);
                }
            }
            CapabilityMigrationStageV1::RustAuthoritative => {
                if self.authoritative_owner != CapabilityAuthorityOwnerV1::Rust
                    || self.recovery_mode
                        != CapabilityRecoveryModeV1::ForwardOnlyAfterRustAuthority
                    || self.node_execution_enabled
                    || !self.rust_execution_enabled
                    || self.translation_receipt_hash.is_none()
                    || self.shadow_receipt_hash.is_none()
                    || self.canary_receipt_hash.is_none()
                    || self.rollback_receipt_hash.is_none()
                    || self.legacy_freeze_receipt_hash.is_none()
                    || self.authority_transfer_receipt_hash.is_none()
                    || self.first_rust_commit_receipt_hash.is_none()
                    || self.node_retirement_receipt_hash.is_some()
                    || (self.requires_external_authority
                        && self.external_authority_receipt_hash.is_none())
                {
                    return Err(CapabilityMigrationError::StageInvariantInvalid);
                }
            }
            CapabilityMigrationStageV1::NodeRetired => {
                if self.authoritative_owner != CapabilityAuthorityOwnerV1::Rust
                    || self.recovery_mode
                        != CapabilityRecoveryModeV1::ForwardOnlyAfterRustAuthority
                    || self.node_execution_enabled
                    || !self.rust_execution_enabled
                    || self.translation_receipt_hash.is_none()
                    || self.shadow_receipt_hash.is_none()
                    || self.canary_receipt_hash.is_none()
                    || self.rollback_receipt_hash.is_none()
                    || self.legacy_freeze_receipt_hash.is_none()
                    || self.authority_transfer_receipt_hash.is_none()
                    || self.first_rust_commit_receipt_hash.is_none()
                    || self.node_retirement_receipt_hash.is_none()
                    || (self.requires_external_authority
                        && self.external_authority_receipt_hash.is_none())
                {
                    return Err(CapabilityMigrationError::StageInvariantInvalid);
                }
            }
        }
        Ok(())
    }

    /// Canonical source/evidence identity for this migration record.
    pub fn record_hash(&self) -> Result<Sha256Digest, CapabilityMigrationError> {
        self.validate()?;
        canonical_hash(self).map_err(|_| CapabilityMigrationError::EncodingInvalid)
    }
}

/// Monotonic migration ledger keyed by capability identity.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityMigrationLedgerV1 {
    /// Current exact record per capability.
    pub records: BTreeMap<String, CapabilityMigrationRecordV1>,
}

impl CapabilityMigrationLedgerV1 {
    /// Inserts the initial Node-authoritative record for one capability.
    pub fn insert_initial(
        &mut self,
        record: CapabilityMigrationRecordV1,
    ) -> Result<(), CapabilityMigrationError> {
        record.validate()?;
        if record.stage != CapabilityMigrationStageV1::NodeAuthoritative
            || self.records.contains_key(&record.capability_id)
        {
            return Err(CapabilityMigrationError::TransitionInvalid);
        }
        self.records.insert(record.capability_id.clone(), record);
        Ok(())
    }

    /// Advances exactly one stage while preserving immutable identities and accepted receipts.
    pub fn advance(
        &mut self,
        next: CapabilityMigrationRecordV1,
    ) -> Result<(), CapabilityMigrationError> {
        next.validate()?;
        let current = self
            .records
            .get(&next.capability_id)
            .ok_or(CapabilityMigrationError::TransitionInvalid)?;
        if next.stage.rank() != current.stage.rank().saturating_add(1)
            || next.version != current.version
            || next.node_module_id != current.node_module_id
            || next.rust_module_id != current.rust_module_id
            || next.node_contract_hash != current.node_contract_hash
            || next.rust_contract_hash != current.rust_contract_hash
            || next.parity_class != current.parity_class
            || next.requires_external_authority != current.requires_external_authority
            || !receipt_preserved(
                &current.translation_receipt_hash,
                &next.translation_receipt_hash,
            )
            || !receipt_preserved(&current.shadow_receipt_hash, &next.shadow_receipt_hash)
            || !receipt_preserved(&current.canary_receipt_hash, &next.canary_receipt_hash)
            || !receipt_preserved(&current.rollback_receipt_hash, &next.rollback_receipt_hash)
            || !receipt_preserved(
                &current.legacy_freeze_receipt_hash,
                &next.legacy_freeze_receipt_hash,
            )
            || !receipt_preserved(
                &current.authority_transfer_receipt_hash,
                &next.authority_transfer_receipt_hash,
            )
            || !receipt_preserved(
                &current.first_rust_commit_receipt_hash,
                &next.first_rust_commit_receipt_hash,
            )
            || !receipt_preserved(
                &current.external_authority_receipt_hash,
                &next.external_authority_receipt_hash,
            )
            || !receipt_preserved(
                &current.node_retirement_receipt_hash,
                &next.node_retirement_receipt_hash,
            )
        {
            return Err(CapabilityMigrationError::TransitionInvalid);
        }
        self.records.insert(next.capability_id.clone(), next);
        Ok(())
    }

    /// Validates every current capability record.
    pub fn validate(&self) -> Result<(), CapabilityMigrationError> {
        if self.records.is_empty() {
            return Err(CapabilityMigrationError::LedgerInvalid);
        }
        for (capability_id, record) in &self.records {
            if capability_id != &record.capability_id {
                return Err(CapabilityMigrationError::LedgerInvalid);
            }
            record.validate()?;
        }
        Ok(())
    }

    /// Canonical hash of the complete capability migration ledger.
    pub fn ledger_hash(&self) -> Result<Sha256Digest, CapabilityMigrationError> {
        self.validate()?;
        canonical_hash(self).map_err(|_| CapabilityMigrationError::EncodingInvalid)
    }

    /// True only when every registered migration has reached accepted Node retirement.
    pub fn all_node_paths_retired(&self) -> bool {
        !self.records.is_empty()
            && self
                .records
                .values()
                .all(|record| record.stage == CapabilityMigrationStageV1::NodeRetired)
    }
}

fn receipt_preserved(current: &Option<Sha256Digest>, next: &Option<Sha256Digest>) -> bool {
    current
        .as_ref()
        .is_none_or(|receipt| next.as_ref() == Some(receipt))
}

/// Fail-closed capability migration validation failure.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum CapabilityMigrationError {
    /// Static identity or record shape is invalid.
    #[error("capability migration record is invalid")]
    RecordInvalid,
    /// Stage-specific authority/evidence invariants are invalid.
    #[error("capability migration stage invariant is invalid")]
    StageInvariantInvalid,
    /// Migration attempted to skip, rewrite, or regress a stage/evidence identity.
    #[error("capability migration transition is invalid")]
    TransitionInvalid,
    /// Complete ledger shape is invalid.
    #[error("capability migration ledger is invalid")]
    LedgerInvalid,
    /// Canonical encoding failed.
    #[error("capability migration encoding failed")]
    EncodingInvalid,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(byte: char) -> Sha256Digest {
        format!("sha256:{}", byte.to_string().repeat(64))
            .parse()
            .expect("digest")
    }

    fn base_record() -> CapabilityMigrationRecordV1 {
        CapabilityMigrationRecordV1 {
            version: 1,
            capability_id: "CAP-AUTHOR".to_owned(),
            node_module_id: "module.node-control-plane".to_owned(),
            rust_module_id: "module.author-node".to_owned(),
            node_contract_hash: digest('a'),
            rust_contract_hash: digest('b'),
            parity_class: LegacyParityClassV1::Semantic,
            requires_external_authority: false,
            stage: CapabilityMigrationStageV1::NodeAuthoritative,
            authoritative_owner: CapabilityAuthorityOwnerV1::Node,
            recovery_mode: CapabilityRecoveryModeV1::NodeRollbackBeforeRustAuthority,
            node_execution_enabled: true,
            rust_execution_enabled: false,
            translation_receipt_hash: None,
            shadow_receipt_hash: None,
            canary_receipt_hash: None,
            rollback_receipt_hash: None,
            legacy_freeze_receipt_hash: None,
            authority_transfer_receipt_hash: None,
            first_rust_commit_receipt_hash: None,
            external_authority_receipt_hash: None,
            node_retirement_receipt_hash: None,
        }
    }

    fn shadow_record(initial: &CapabilityMigrationRecordV1) -> CapabilityMigrationRecordV1 {
        let mut shadow = initial.clone();
        shadow.stage = CapabilityMigrationStageV1::RustShadow;
        shadow.rust_execution_enabled = true;
        shadow.translation_receipt_hash = Some(digest('c'));
        shadow.shadow_receipt_hash = Some(digest('d'));
        shadow
    }

    fn canary_record(shadow: &CapabilityMigrationRecordV1) -> CapabilityMigrationRecordV1 {
        let mut canary = shadow.clone();
        canary.stage = CapabilityMigrationStageV1::RustCanary;
        canary.canary_receipt_hash = Some(digest('e'));
        canary.rollback_receipt_hash = Some(digest('f'));
        canary
    }

    #[test]
    fn migration_cannot_skip_shadow_or_rewrite_evidence() {
        let mut ledger = CapabilityMigrationLedgerV1::default();
        let initial = base_record();
        ledger.insert_initial(initial.clone()).expect("initial");

        let mut skipped = canary_record(&shadow_record(&initial));
        assert_eq!(
            ledger.advance(skipped.clone()),
            Err(CapabilityMigrationError::TransitionInvalid)
        );

        let shadow = shadow_record(&initial);
        ledger.advance(shadow.clone()).expect("shadow");
        let canary = canary_record(&shadow);
        ledger.advance(canary.clone()).expect("canary");

        skipped = canary.clone();
        skipped.stage = CapabilityMigrationStageV1::RustAuthoritative;
        skipped.authoritative_owner = CapabilityAuthorityOwnerV1::Rust;
        skipped.recovery_mode = CapabilityRecoveryModeV1::ForwardOnlyAfterRustAuthority;
        skipped.node_execution_enabled = false;
        skipped.translation_receipt_hash = Some(digest('9'));
        skipped.legacy_freeze_receipt_hash = Some(digest('0'));
        skipped.authority_transfer_receipt_hash = Some(digest('1'));
        skipped.first_rust_commit_receipt_hash = Some(digest('2'));
        assert_eq!(
            ledger.advance(skipped),
            Err(CapabilityMigrationError::TransitionInvalid)
        );
    }

    #[test]
    fn first_rust_commit_irreversibly_switches_to_forward_only_recovery() {
        let mut ledger = CapabilityMigrationLedgerV1::default();
        let initial = base_record();
        ledger.insert_initial(initial.clone()).expect("initial");
        let shadow = shadow_record(&initial);
        ledger.advance(shadow.clone()).expect("shadow");
        let canary = canary_record(&shadow);
        ledger.advance(canary.clone()).expect("canary");

        let mut authoritative = canary;
        authoritative.stage = CapabilityMigrationStageV1::RustAuthoritative;
        authoritative.authoritative_owner = CapabilityAuthorityOwnerV1::Rust;
        authoritative.recovery_mode = CapabilityRecoveryModeV1::ForwardOnlyAfterRustAuthority;
        authoritative.node_execution_enabled = false;
        authoritative.legacy_freeze_receipt_hash = Some(digest('0'));
        authoritative.authority_transfer_receipt_hash = Some(digest('1'));
        authoritative.first_rust_commit_receipt_hash = Some(digest('2'));
        ledger
            .advance(authoritative.clone())
            .expect("Rust authority transfer");

        let mut illegal_rollback = authoritative.clone();
        illegal_rollback.stage = CapabilityMigrationStageV1::NodeRetired;
        illegal_rollback.recovery_mode = CapabilityRecoveryModeV1::NodeRollbackBeforeRustAuthority;
        illegal_rollback.node_retirement_receipt_hash = Some(digest('3'));
        assert_eq!(
            ledger.advance(illegal_rollback),
            Err(CapabilityMigrationError::StageInvariantInvalid)
        );

        let mut retired = authoritative;
        retired.stage = CapabilityMigrationStageV1::NodeRetired;
        retired.node_retirement_receipt_hash = Some(digest('3'));
        ledger.advance(retired).expect("Node retirement");
        assert!(ledger.all_node_paths_retired());
    }
}

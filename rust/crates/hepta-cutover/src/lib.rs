//! Explicit shadow, cutover, activation, and rollback state machine.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Durable cutover phase.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CutoverPhaseV1 {
    /// Immutable plan prepared; no runtime mutation.
    Planned,
    /// Old writer and workers are stopped and leases cleared.
    Quiesced,
    /// Exact backup and restore evidence is bound.
    BackedUp,
    /// Rust shadow/read-only parity is accepted.
    ShadowVerified,
    /// Exclusive writer ownership moved to Rust but production remains disabled.
    WriterTransferred,
    /// Separately authorized production activation completed.
    Activated,
    /// Ownership returned to the prior writer from a pre-activation or approved rollback point.
    RolledBack,
}

/// Immutable cutover subject and current phase.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CutoverStateV1 {
    /// Contract version.
    pub version: u16,
    /// Exact cutover operation.
    pub cutover_id: String,
    /// Prior writer identity.
    pub old_writer_id: String,
    /// Rust writer identity.
    pub new_writer_id: String,
    /// Required SQLite schema version.
    pub schema_version: u32,
    /// Current phase.
    pub phase: CutoverPhaseV1,
    /// Monotonic transition revision.
    pub revision: u64,
    /// Exact backup evidence hash, once available.
    pub backup_receipt_hash: Option<String>,
    /// Exact restore evidence hash, once available.
    pub restore_receipt_hash: Option<String>,
    /// Exact Node/Rust parity evidence hash, once accepted.
    pub parity_receipt_hash: Option<String>,
    /// Exact writer-transfer evidence hash.
    pub writer_transfer_receipt_hash: Option<String>,
    /// External activation authority receipt hash.
    pub activation_receipt_hash: Option<String>,
}

/// Evidence supplied for one transition.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CutoverEvidenceV1 {
    /// Backup receipt.
    pub backup_receipt_hash: Option<String>,
    /// Independent restore receipt.
    pub restore_receipt_hash: Option<String>,
    /// Shadow/parity receipt.
    pub parity_receipt_hash: Option<String>,
    /// Single-writer transfer receipt.
    pub writer_transfer_receipt_hash: Option<String>,
    /// External activation receipt.
    pub activation_receipt_hash: Option<String>,
}

impl CutoverStateV1 {
    /// Constructs a schema-25 cutover plan with distinct writer identities.
    pub fn planned(
        cutover_id: String,
        old_writer_id: String,
        new_writer_id: String,
    ) -> Result<Self, CutoverError> {
        if !valid_identifier(&cutover_id)
            || !valid_identifier(&old_writer_id)
            || !valid_identifier(&new_writer_id)
            || old_writer_id == new_writer_id
        {
            return Err(CutoverError::InvalidPlan);
        }
        Ok(Self {
            version: 1,
            cutover_id,
            old_writer_id,
            new_writer_id,
            schema_version: 25,
            phase: CutoverPhaseV1::Planned,
            revision: 0,
            backup_receipt_hash: None,
            restore_receipt_hash: None,
            parity_receipt_hash: None,
            writer_transfer_receipt_hash: None,
            activation_receipt_hash: None,
        })
    }

    /// Applies exactly one legal transition and binds all required evidence.
    pub fn transition(
        &mut self,
        expected_revision: u64,
        next: CutoverPhaseV1,
        evidence: CutoverEvidenceV1,
    ) -> Result<(), CutoverError> {
        if self.version != 1 || self.schema_version != 25 {
            return Err(CutoverError::InvalidPlan);
        }
        if self.revision != expected_revision {
            return Err(CutoverError::RevisionConflict);
        }
        match (self.phase, next) {
            (CutoverPhaseV1::Planned, CutoverPhaseV1::Quiesced) => {
                reject_unexpected(&evidence)?;
            }
            (CutoverPhaseV1::Quiesced, CutoverPhaseV1::BackedUp) => {
                require_hashes([
                    evidence.backup_receipt_hash.as_deref(),
                    evidence.restore_receipt_hash.as_deref(),
                ])?;
                self.backup_receipt_hash = evidence.backup_receipt_hash;
                self.restore_receipt_hash = evidence.restore_receipt_hash;
            }
            (CutoverPhaseV1::BackedUp, CutoverPhaseV1::ShadowVerified) => {
                require_hashes([evidence.parity_receipt_hash.as_deref()])?;
                self.parity_receipt_hash = evidence.parity_receipt_hash;
            }
            (CutoverPhaseV1::ShadowVerified, CutoverPhaseV1::WriterTransferred) => {
                require_hashes([evidence.writer_transfer_receipt_hash.as_deref()])?;
                self.writer_transfer_receipt_hash = evidence.writer_transfer_receipt_hash;
            }
            (CutoverPhaseV1::WriterTransferred, CutoverPhaseV1::Activated) => {
                require_hashes([evidence.activation_receipt_hash.as_deref()])?;
                self.activation_receipt_hash = evidence.activation_receipt_hash;
            }
            (
                CutoverPhaseV1::Quiesced
                | CutoverPhaseV1::BackedUp
                | CutoverPhaseV1::ShadowVerified
                | CutoverPhaseV1::WriterTransferred,
                CutoverPhaseV1::RolledBack,
            ) => {
                if self.phase == CutoverPhaseV1::WriterTransferred {
                    require_hashes([evidence.writer_transfer_receipt_hash.as_deref()])?;
                } else {
                    reject_unexpected(&evidence)?;
                }
            }
            _ => return Err(CutoverError::IllegalTransition),
        }
        self.phase = next;
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or(CutoverError::NumericOverflow)?;
        Ok(())
    }

    /// Returns the only writer allowed by this phase.
    #[must_use]
    pub fn authoritative_writer(&self) -> Option<&str> {
        match self.phase {
            CutoverPhaseV1::Planned
            | CutoverPhaseV1::Quiesced
            | CutoverPhaseV1::BackedUp
            | CutoverPhaseV1::ShadowVerified
            | CutoverPhaseV1::RolledBack => Some(&self.old_writer_id),
            CutoverPhaseV1::WriterTransferred | CutoverPhaseV1::Activated => {
                Some(&self.new_writer_id)
            }
        }
    }

    /// Production activation requires the external activation receipt and all prior evidence.
    pub fn production_activation_eligible(&self) -> Result<bool, CutoverError> {
        if self.phase != CutoverPhaseV1::Activated {
            return Ok(false);
        }
        require_hashes([
            self.backup_receipt_hash.as_deref(),
            self.restore_receipt_hash.as_deref(),
            self.parity_receipt_hash.as_deref(),
            self.writer_transfer_receipt_hash.as_deref(),
            self.activation_receipt_hash.as_deref(),
        ])?;
        Ok(true)
    }
}

fn reject_unexpected(evidence: &CutoverEvidenceV1) -> Result<(), CutoverError> {
    if evidence != &CutoverEvidenceV1::default() {
        return Err(CutoverError::UnexpectedEvidence);
    }
    Ok(())
}

fn require_hashes<const N: usize>(values: [Option<&str>; N]) -> Result<(), CutoverError> {
    for value in values {
        validate_hash(value.ok_or(CutoverError::EvidenceMissing)?)?;
    }
    Ok(())
}

fn validate_hash(value: &str) -> Result<(), CutoverError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(CutoverError::EvidenceInvalid);
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(CutoverError::EvidenceInvalid);
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
        })
}

/// Cutover plan, transition, evidence, or activation failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum CutoverError {
    /// Plan identity or writer separation is invalid.
    #[error("cutover plan is invalid")]
    InvalidPlan,
    /// Concurrent transition changed revision.
    #[error("cutover revision conflict")]
    RevisionConflict,
    /// Transition is outside the explicit state machine.
    #[error("cutover transition is illegal")]
    IllegalTransition,
    /// A required evidence hash is absent.
    #[error("cutover evidence is missing")]
    EvidenceMissing,
    /// Evidence digest is malformed.
    #[error("cutover evidence is invalid")]
    EvidenceInvalid,
    /// Transition supplied evidence that is not consumed in that phase.
    #[error("cutover transition supplied unexpected evidence")]
    UnexpectedEvidence,
    /// Revision arithmetic overflowed.
    #[error("cutover revision overflow")]
    NumericOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(byte: char) -> String {
        format!("sha256:{}", byte.to_string().repeat(64))
    }

    #[test]
    fn single_writer_moves_only_after_backup_restore_and_parity() {
        let mut state = CutoverStateV1::planned(
            "cutover-1".into(),
            "node-writer".into(),
            "rust-writer".into(),
        )
        .expect("plan");
        assert_eq!(state.authoritative_writer(), Some("node-writer"));
        state
            .transition(0, CutoverPhaseV1::Quiesced, CutoverEvidenceV1::default())
            .expect("quiesce");
        state
            .transition(
                1,
                CutoverPhaseV1::BackedUp,
                CutoverEvidenceV1 {
                    backup_receipt_hash: Some(hash('1')),
                    restore_receipt_hash: Some(hash('2')),
                    ..CutoverEvidenceV1::default()
                },
            )
            .expect("backup");
        state
            .transition(
                2,
                CutoverPhaseV1::ShadowVerified,
                CutoverEvidenceV1 {
                    parity_receipt_hash: Some(hash('3')),
                    ..CutoverEvidenceV1::default()
                },
            )
            .expect("shadow");
        state
            .transition(
                3,
                CutoverPhaseV1::WriterTransferred,
                CutoverEvidenceV1 {
                    writer_transfer_receipt_hash: Some(hash('4')),
                    ..CutoverEvidenceV1::default()
                },
            )
            .expect("transfer");
        assert_eq!(state.authoritative_writer(), Some("rust-writer"));
        assert!(!state.production_activation_eligible().expect("activation"));
    }

    #[test]
    fn activation_without_external_receipt_and_dual_writer_plan_fail_closed() {
        assert_eq!(
            CutoverStateV1::planned(
                "cutover-1".into(),
                "same-writer".into(),
                "same-writer".into(),
            ),
            Err(CutoverError::InvalidPlan)
        );
        let mut state = CutoverStateV1::planned(
            "cutover-1".into(),
            "node-writer".into(),
            "rust-writer".into(),
        )
        .expect("plan");
        assert_eq!(
            state.transition(0, CutoverPhaseV1::Activated, CutoverEvidenceV1::default()),
            Err(CutoverError::IllegalTransition)
        );
    }
}

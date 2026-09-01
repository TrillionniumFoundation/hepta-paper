use std::collections::BTreeMap;

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};

use crate::{ControlPlaneError, VerifiedPreparedResultV1, canonical_hash_v1};

/// Serialized integration request for the single commit sequencer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitRequestV1 {
    /// Contract version.
    pub version: u16,
    /// Exact plan hash.
    pub plan_hash: Sha256Digest,
    /// Monotonic plan-local sequence.
    pub sequence: u64,
    /// Verified prepared result.
    pub verified: VerifiedPreparedResultV1,
}

/// Idempotent commit receipt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitReceiptV1 {
    /// Contract version.
    pub version: u16,
    /// Exact plan hash.
    pub plan_hash: Sha256Digest,
    /// Monotonic sequence.
    pub sequence: u64,
    /// Prepared-result hash integrated by this commit.
    pub result_hash: Sha256Digest,
    /// Canonical committed-state hash.
    pub committed_state_hash: Sha256Digest,
    /// Whether this call performed a new transition.
    pub newly_committed: bool,
    /// Production activation remains false in this source composition.
    pub production_activation: bool,
}

/// Only this interface may integrate verified prepared results.
pub trait CommitSequencerV1 {
    /// Integrates one verified result in monotonic sequence order.
    fn commit(&mut self, request: CommitRequestV1) -> Result<CommitReceiptV1, ControlPlaneError>;
}

/// In-memory deterministic commit sequencer for source qualification only.
#[derive(Clone, Debug)]
pub struct FixtureCommitSequencerV1 {
    initial_state_hash: Sha256Digest,
    current_state_hash: Sha256Digest,
    next_sequence: u64,
    receipts_by_result: BTreeMap<Sha256Digest, CommitReceiptV1>,
}

impl FixtureCommitSequencerV1 {
    /// Creates a non-production sequencer over an immutable starting state hash.
    #[must_use]
    pub fn new(initial_state_hash: Sha256Digest) -> Self {
        Self {
            current_state_hash: initial_state_hash.clone(),
            initial_state_hash,
            next_sequence: 1,
            receipts_by_result: BTreeMap::new(),
        }
    }

    /// Returns the current deterministic fixture state hash.
    #[must_use]
    pub fn current_state_hash(&self) -> &Sha256Digest {
        &self.current_state_hash
    }

    /// Returns the exact starting fixture state hash.
    #[must_use]
    pub fn initial_state_hash(&self) -> &Sha256Digest {
        &self.initial_state_hash
    }
}

impl CommitSequencerV1 for FixtureCommitSequencerV1 {
    fn commit(&mut self, request: CommitRequestV1) -> Result<CommitReceiptV1, ControlPlaneError> {
        if request.version != 1
            || !request.verified.accepted
            || request.verified.result.plan_hash != request.plan_hash
        {
            return Err(ControlPlaneError::CommitInvalid);
        }
        if let Some(receipt) = self.receipts_by_result.get(&request.verified.result_hash) {
            if receipt.plan_hash == request.plan_hash {
                let mut replay = receipt.clone();
                replay.newly_committed = false;
                return Ok(replay);
            }
            return Err(ControlPlaneError::CommitInvalid);
        }
        if request.sequence != self.next_sequence {
            return Err(ControlPlaneError::CommitInvalid);
        }
        let transition = CommitTransitionV1 {
            prior_state_hash: self.current_state_hash.clone(),
            plan_hash: request.plan_hash.clone(),
            sequence: request.sequence,
            result_hash: request.verified.result_hash.clone(),
            verifier_hash: request.verified.verifier_hash.clone(),
        };
        let committed_state_hash = canonical_hash_v1(&transition)?;
        let receipt = CommitReceiptV1 {
            version: 1,
            plan_hash: request.plan_hash,
            sequence: request.sequence,
            result_hash: request.verified.result_hash,
            committed_state_hash: committed_state_hash.clone(),
            newly_committed: true,
            production_activation: false,
        };
        self.current_state_hash = committed_state_hash;
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(ControlPlaneError::CommitInvalid)?;
        self.receipts_by_result
            .insert(receipt.result_hash.clone(), receipt.clone());
        Ok(receipt)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitTransitionV1 {
    prior_state_hash: Sha256Digest,
    plan_hash: Sha256Digest,
    sequence: u64,
    result_hash: Sha256Digest,
    verifier_hash: Sha256Digest,
}

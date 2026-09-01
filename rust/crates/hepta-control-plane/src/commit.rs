use std::collections::{BTreeMap, BTreeSet};

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};

use crate::{
    ControlPlaneError, VerifiedPreparedResultV1, canonical_hash_v1,
    verification_receipt_hash_v1,
};

/// Serialized integration request for the single commit sequencer.
///
/// The request cannot be deserialized from an untrusted wire object because it
/// contains a construction-restricted verified-result capability.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequestV1 {
    version: u16,
    plan_hash: Sha256Digest,
    verified: VerifiedPreparedResultV1,
}

impl CommitRequestV1 {
    /// Creates one integration request from a trusted verified result.
    pub fn new(
        plan_hash: Sha256Digest,
        verified: VerifiedPreparedResultV1,
    ) -> Result<Self, ControlPlaneError> {
        if verified.result.plan_hash != plan_hash {
            return Err(ControlPlaneError::CommitInvalid);
        }
        Ok(Self {
            version: 1,
            plan_hash,
            verified,
        })
    }

    /// Returns the exact plan hash.
    #[must_use]
    pub fn plan_hash(&self) -> &Sha256Digest {
        &self.plan_hash
    }

    /// Returns the verified prepared-result capability.
    #[must_use]
    pub fn verified(&self) -> &VerifiedPreparedResultV1 {
        &self.verified
    }
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
    /// Authorized verifier identity/configuration hash.
    pub verifier_hash: Sha256Digest,
    /// Verification receipt authenticated by the sequencer.
    pub verification_receipt_hash: Sha256Digest,
    /// Canonical committed-state hash.
    pub committed_state_hash: Sha256Digest,
    /// Whether this call performed a new transition.
    pub newly_committed: bool,
    /// Production activation remains false in this source composition.
    pub production_activation: bool,
}

mod sealed {
    pub trait Sealed {}
}

/// Only this interface may integrate verified prepared results.
///
/// The trait is sealed so an untrusted downstream crate cannot provide a
/// shallow-cloning or partially committing implementation to the source
/// composition. Production sequencers must be implemented and audited in this
/// crate with the same all-or-nothing batch contract.
pub trait CommitSequencerV1: sealed::Sealed {
    /// Returns the only verifier identity accepted by this sequencer.
    fn authorized_verifier_hash(&self) -> &Sha256Digest;

    /// Returns the next sequence for a newly integrated result.
    fn next_sequence(&self) -> u64;

    /// Atomically integrates a complete batch in monotonic sequence order.
    ///
    /// Implementations must leave their durable state unchanged when any item
    /// fails validation or persistence.
    fn commit_batch(
        &mut self,
        requests: &[CommitRequestV1],
    ) -> Result<Vec<CommitReceiptV1>, ControlPlaneError>;

    /// Atomically integrates one verified prepared result.
    fn commit(
        &mut self,
        request: CommitRequestV1,
    ) -> Result<CommitReceiptV1, ControlPlaneError> {
        let mut receipts = self.commit_batch(std::slice::from_ref(&request))?;
        receipts.pop().ok_or(ControlPlaneError::CommitInvalid)
    }
}

/// In-memory deterministic commit sequencer for source qualification only.
#[derive(Clone, Debug)]
pub struct FixtureCommitSequencerV1 {
    initial_state_hash: Sha256Digest,
    current_state_hash: Sha256Digest,
    authorized_verifier_hash: Sha256Digest,
    next_sequence: u64,
    receipts_by_result: BTreeMap<Sha256Digest, CommitReceiptV1>,
    fail_on_sequence: Option<u64>,
}

impl FixtureCommitSequencerV1 {
    /// Creates a non-production sequencer over an immutable starting state hash.
    #[must_use]
    pub fn new(
        initial_state_hash: Sha256Digest,
        authorized_verifier_hash: Sha256Digest,
    ) -> Self {
        Self {
            current_state_hash: initial_state_hash.clone(),
            initial_state_hash,
            authorized_verifier_hash,
            next_sequence: 1,
            receipts_by_result: BTreeMap::new(),
            fail_on_sequence: None,
        }
    }

    /// Creates a source-only fault-injecting sequencer for atomicity tests.
    #[must_use]
    pub fn with_failure_at(
        initial_state_hash: Sha256Digest,
        authorized_verifier_hash: Sha256Digest,
        fail_on_sequence: u64,
    ) -> Self {
        let mut sequencer = Self::new(initial_state_hash, authorized_verifier_hash);
        sequencer.fail_on_sequence = Some(fail_on_sequence);
        sequencer
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

    /// Returns the configured trusted verifier hash.
    #[must_use]
    pub fn authorized_verifier_hash(&self) -> &Sha256Digest {
        &self.authorized_verifier_hash
    }

    /// Returns the next new-transition sequence.
    #[must_use]
    pub fn next_sequence(&self) -> u64 {
        self.next_sequence
    }

    /// Returns the number of newly committed result identities.
    #[must_use]
    pub fn receipt_count(&self) -> usize {
        self.receipts_by_result.len()
    }

    fn apply_commit(
        &mut self,
        request: &CommitRequestV1,
    ) -> Result<CommitReceiptV1, ControlPlaneError> {
        if request.version != 1
            || request.verified.result.plan_hash != request.plan_hash
            || request.verified.verifier_hash != self.authorized_verifier_hash
        {
            return Err(ControlPlaneError::CommitInvalid);
        }
        let recomputed_result_hash = request
            .verified
            .result
            .result_hash()
            .map_err(|_| ControlPlaneError::CommitInvalid)?;
        if recomputed_result_hash != request.verified.result_hash
            || verification_receipt_hash_v1(
                &request.verified.result_hash,
                &request.verified.verifier_hash,
            )? != request.verified.verification_receipt_hash
        {
            return Err(ControlPlaneError::CommitInvalid);
        }
        if let Some(receipt) = self.receipts_by_result.get(&request.verified.result_hash) {
            if receipt.plan_hash == request.plan_hash
                && receipt.verifier_hash == request.verified.verifier_hash
                && receipt.verification_receipt_hash
                    == request.verified.verification_receipt_hash
            {
                let mut replay = receipt.clone();
                replay.newly_committed = false;
                return Ok(replay);
            }
            return Err(ControlPlaneError::CommitInvalid);
        }
        let sequence = self.next_sequence;
        if self.fail_on_sequence == Some(sequence) {
            return Err(ControlPlaneError::CommitInvalid);
        }
        let transition = CommitTransitionV1 {
            prior_state_hash: self.current_state_hash.clone(),
            plan_hash: request.plan_hash.clone(),
            sequence,
            result_hash: request.verified.result_hash.clone(),
            verifier_hash: request.verified.verifier_hash.clone(),
            verification_receipt_hash: request.verified.verification_receipt_hash.clone(),
        };
        let committed_state_hash = canonical_hash_v1(&transition)?;
        let receipt = CommitReceiptV1 {
            version: 1,
            plan_hash: request.plan_hash.clone(),
            sequence,
            result_hash: request.verified.result_hash.clone(),
            verifier_hash: request.verified.verifier_hash.clone(),
            verification_receipt_hash: request.verified.verification_receipt_hash.clone(),
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

impl sealed::Sealed for FixtureCommitSequencerV1 {}

impl CommitSequencerV1 for FixtureCommitSequencerV1 {
    fn authorized_verifier_hash(&self) -> &Sha256Digest {
        &self.authorized_verifier_hash
    }

    fn next_sequence(&self) -> u64 {
        self.next_sequence
    }

    fn commit_batch(
        &mut self,
        requests: &[CommitRequestV1],
    ) -> Result<Vec<CommitReceiptV1>, ControlPlaneError> {
        let Some(first) = requests.first() else {
            return Err(ControlPlaneError::CommitInvalid);
        };
        let mut result_hashes = BTreeSet::new();
        if requests.iter().any(|request| {
            request.plan_hash != first.plan_hash
                || !result_hashes.insert(request.verified.result_hash.clone())
        }) {
            return Err(ControlPlaneError::CommitInvalid);
        }
        let mut staged = self.clone();
        let mut receipts = Vec::with_capacity(requests.len());
        for request in requests {
            receipts.push(staged.apply_commit(request)?);
        }
        *self = staged;
        Ok(receipts)
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
    verification_receipt_hash: Sha256Digest,
}

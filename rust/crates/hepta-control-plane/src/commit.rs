use std::collections::{BTreeMap, BTreeSet};

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};

use crate::{
    ControlPlaneError, VerifiedPreparedResultV1, canonical_hash_v1, verification_receipt_hash_v1,
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
    /// Binds the run clock and immutable campaign snapshot before execution.
    fn begin_run(
        &mut self,
        _snapshot: &crate::ControlPlaneSnapshotV1,
        _now_unix_ms: u64,
    ) -> Result<(), ControlPlaneError> {
        Ok(())
    }
    /// Returns the only verifier identity accepted by this sequencer.
    fn authorized_verifier_hash(&self) -> &Sha256Digest;

    /// Returns the next sequence for a newly integrated result.
    fn next_sequence(&self) -> u64;

    /// Computes exact receipts without mutating storage. A successful subsequent
    /// commit on this exclusively owned sequencer must return these same receipts.
    /// This lets the runtime finish every fallible event/receipt operation before
    /// crossing the durable transaction boundary, without shallow-cloning a DB.
    fn preview_batch(
        &self,
        requests: &[CommitRequestV1],
    ) -> Result<Vec<CommitReceiptV1>, ControlPlaneError>;

    /// Atomically integrates a complete batch in monotonic sequence order.
    ///
    /// Implementations must leave their durable state unchanged when any item
    /// fails validation or persistence.
    fn commit_batch(
        &mut self,
        requests: &[CommitRequestV1],
    ) -> Result<Vec<CommitReceiptV1>, ControlPlaneError>;

    /// Atomically integrates one verified prepared result.
    fn commit(&mut self, request: CommitRequestV1) -> Result<CommitReceiptV1, ControlPlaneError> {
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
    pub fn new(initial_state_hash: Sha256Digest, authorized_verifier_hash: Sha256Digest) -> Self {
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
                && receipt.verification_receipt_hash == request.verified.verification_receipt_hash
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

    fn preview_batch(
        &self,
        requests: &[CommitRequestV1],
    ) -> Result<Vec<CommitReceiptV1>, ControlPlaneError> {
        self.clone().commit_batch(requests)
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

/// Exclusive SQLite sequencer integrating complete verified result bodies and
/// immutable receipts into the real campaign writer. It is intentionally not
/// `Clone`: copying a DB handle cannot stage an atomic transaction.
pub struct SqliteCommitSequencerV1 {
    store: hepta_campaign_writer::CampaignWriterStoreV1,
    writer: hepta_campaign_writer::WriterLeaseV1,
    campaign_id: String,
    state: FixtureCommitSequencerV1,
    now_unix_ms: u64,
    run_snapshot: Option<(Sha256Digest, Sha256Digest, u64)>,
    known_snapshots: BTreeSet<Sha256Digest>,
}

impl std::fmt::Debug for SqliteCommitSequencerV1 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SqliteCommitSequencerV1")
            .field("campaign_id", &self.campaign_id)
            .field("next_sequence", &self.state.next_sequence)
            .field("local_only", &self.store.is_local_only())
            .finish_non_exhaustive()
    }
}

impl SqliteCommitSequencerV1 {
    /// Opens or restores the stream through a generation-fenced writer store.
    /// The store must already hold a live writer lease and an existing campaign.
    /// Reopen recomputes every prepared-result and state-transition hash and
    /// compares every receipt field; corrupt or mismatched bindings fail closed.
    pub fn new(
        mut store: hepta_campaign_writer::CampaignWriterStoreV1,
        writer: hepta_campaign_writer::WriterLeaseV1,
        campaign_id: String,
        initial_state_hash: Sha256Digest,
        authorized_verifier_hash: Sha256Digest,
        now_unix_ms: u64,
    ) -> Result<Self, ControlPlaneError> {
        let log = store
            .open_control_log(
                &writer,
                &campaign_id,
                &initial_state_hash,
                &authorized_verifier_hash,
                now_unix_ms,
            )
            .map_err(|_| ControlPlaneError::PersistenceInvalid)?;
        let mut state = FixtureCommitSequencerV1::new(initial_state_hash, authorized_verifier_hash);
        let mut known_snapshots = BTreeSet::new();
        for entry in log.entries {
            let result: hepta_module_platform::PreparedResultV1 =
                serde_json::from_str(&entry.result_json)
                    .map_err(|_| ControlPlaneError::PersistenceInvalid)?;
            let expected: CommitReceiptV1 = serde_json::from_str(&entry.receipt_json)
                .map_err(|_| ControlPlaneError::PersistenceInvalid)?;
            let result_hash = result
                .result_hash()
                .map_err(|_| ControlPlaneError::PersistenceInvalid)?;
            if entry.sequence != state.next_sequence
                || entry.result_hash != result_hash
                || entry.attempt_id != result.attempt_id
                || entry.plan_hash != result.plan_hash
                || entry.actual_cost_microusd != result.actual_cost_microusd
                || result.status != hepta_module_platform::PreparedResultStatusV1::Prepared
                || result.external_action_may_have_started
            {
                return Err(ControlPlaneError::PersistenceInvalid);
            }
            let verification_receipt_hash =
                verification_receipt_hash_v1(&result_hash, &state.authorized_verifier_hash)?;
            known_snapshots.insert(result.snapshot_hash.clone());
            let verified = VerifiedPreparedResultV1 {
                result,
                result_hash,
                verifier_hash: state.authorized_verifier_hash.clone(),
                verification_receipt_hash,
                artifact_contents_verified: false,
            };
            let actual = state.apply_commit(&CommitRequestV1::new(entry.plan_hash, verified)?)?;
            if actual != expected {
                return Err(ControlPlaneError::PersistenceInvalid);
            }
        }
        if state.next_sequence != log.next_sequence {
            return Err(ControlPlaneError::PersistenceInvalid);
        }
        Ok(Self {
            store,
            writer,
            campaign_id,
            state,
            now_unix_ms,
            run_snapshot: None,
            known_snapshots,
        })
    }

    /// Advances the caller-supplied admission clock. Every SQL transaction checks
    /// the persisted lease expiry against this clock before accepting writes.
    pub fn advance_clock(&mut self, now_unix_ms: u64) -> Result<(), ControlPlaneError> {
        if now_unix_ms < self.now_unix_ms {
            return Err(ControlPlaneError::PersistenceInvalid);
        }
        self.now_unix_ms = now_unix_ms;
        if now_unix_ms >= self.writer.expires_at_unix_ms {
            return Err(ControlPlaneError::PersistenceInvalid);
        }
        Ok(())
    }

    /// Exact currently committed state hash.
    #[must_use]
    pub fn current_state_hash(&self) -> &Sha256Digest {
        self.state.current_state_hash()
    }

    /// Count of durable results, including restored results.
    #[must_use]
    pub fn receipt_count(&self) -> usize {
        self.state.receipt_count()
    }

    /// Read/backup access to the exclusively owned campaign database.
    #[must_use]
    pub fn store(&self) -> &hepta_campaign_writer::CampaignWriterStoreV1 {
        &self.store
    }

    /// Returns the writer store after dropping the composition root.
    #[must_use]
    pub fn into_store(self) -> hepta_campaign_writer::CampaignWriterStoreV1 {
        self.store
    }
}

impl sealed::Sealed for SqliteCommitSequencerV1 {}

impl CommitSequencerV1 for SqliteCommitSequencerV1 {
    fn begin_run(
        &mut self,
        snapshot: &crate::ControlPlaneSnapshotV1,
        now_unix_ms: u64,
    ) -> Result<(), ControlPlaneError> {
        self.run_snapshot = None;
        if snapshot.campaign_id != self.campaign_id {
            return Err(ControlPlaneError::SnapshotInvalid);
        }
        self.advance_clock(now_unix_ms)?;
        let snapshot_hash = snapshot.snapshot_hash()?;
        let campaign = self
            .store
            .load_campaign(&self.campaign_id)
            .map_err(|_| ControlPlaneError::PersistenceInvalid)?;
        // Reject before dispatch, not merely at SQL COMMIT after a worker ran.
        // Read-only history inspection remains available through replay_control_log_v1.
        if campaign.state != hepta_campaign_writer::CampaignStateV1::Running {
            return Err(ControlPlaneError::PersistenceInvalid);
        }
        if !self.known_snapshots.contains(&snapshot_hash)
            && (&snapshot.state_hash != self.state.current_state_hash()
                || snapshot.campaign_revision
                    != campaign
                        .revision
                        .checked_add(1)
                        .ok_or(ControlPlaneError::PersistenceInvalid)?)
        {
            return Err(ControlPlaneError::SnapshotInvalid);
        }
        self.run_snapshot = Some((
            snapshot_hash,
            snapshot.state_hash.clone(),
            snapshot.campaign_revision,
        ));
        Ok(())
    }
    fn authorized_verifier_hash(&self) -> &Sha256Digest {
        self.state.authorized_verifier_hash()
    }
    fn next_sequence(&self) -> u64 {
        self.state.next_sequence()
    }

    fn preview_batch(
        &self,
        requests: &[CommitRequestV1],
    ) -> Result<Vec<CommitReceiptV1>, ControlPlaneError> {
        if !self.store.is_local_only()
            && requests
                .iter()
                .any(|request| !request.verified.artifact_contents_verified)
        {
            return Err(ControlPlaneError::VerificationInvalid);
        }
        let receipts = self.state.preview_batch(requests)?;
        if let Some((snapshot_hash, state_hash, revision)) = &self.run_snapshot {
            let campaign = self
                .store
                .load_campaign(&self.campaign_id)
                .map_err(|_| ControlPlaneError::PersistenceInvalid)?;
            if requests
                .iter()
                .any(|request| &request.verified.result.snapshot_hash != snapshot_hash)
                || (receipts.iter().any(|receipt| receipt.newly_committed)
                    && (state_hash != self.state.current_state_hash()
                        || *revision
                            != campaign
                                .revision
                                .checked_add(1)
                                .ok_or(ControlPlaneError::PersistenceInvalid)?))
            {
                return Err(ControlPlaneError::SnapshotInvalid);
            }
        } else if !self.store.is_local_only() {
            return Err(ControlPlaneError::SnapshotInvalid);
        }
        Ok(receipts)
    }

    fn commit_batch(
        &mut self,
        requests: &[CommitRequestV1],
    ) -> Result<Vec<CommitReceiptV1>, ControlPlaneError> {
        self.preview_batch(requests)?;
        let mut staged = self.state.clone();
        let receipts = staged.commit_batch(requests)?;
        let entries = requests
            .iter()
            .zip(&receipts)
            .map(|(request, receipt)| {
                // Durable receipt bytes always describe the original transition;
                // newly_committed=false is a response-only idempotency annotation.
                let mut original = receipt.clone();
                original.newly_committed = true;
                let result = request.verified.result();
                Ok(hepta_campaign_writer::DurableControlEntryV1 {
                    sequence: receipt.sequence,
                    result_hash: receipt.result_hash.clone(),
                    attempt_id: result.attempt_id.clone(),
                    plan_hash: request.plan_hash.clone(),
                    result_json: serde_json::to_string(result)
                        .map_err(|_| ControlPlaneError::EncodingInvalid)?,
                    receipt_json: serde_json::to_string(&original)
                        .map_err(|_| ControlPlaneError::EncodingInvalid)?,
                    actual_cost_microusd: result.actual_cost_microusd,
                })
            })
            .collect::<Result<Vec<_>, ControlPlaneError>>()?;
        self.store
            .append_control_batch(
                &self.writer,
                &self.campaign_id,
                self.state.next_sequence,
                &entries,
                self.now_unix_ms,
            )
            .map_err(|_| ControlPlaneError::PersistenceInvalid)?;
        self.state = staged;
        for request in requests {
            self.known_snapshots
                .insert(request.verified.result.snapshot_hash.clone());
        }
        Ok(receipts)
    }
}

/// Recompute an entire persisted control chain without opening a writer or
/// minting a prepared-result authority. Returned receipts are read-only history.
pub fn replay_control_log_v1(
    log: &hepta_campaign_writer::DurableControlLogV1,
) -> Result<Vec<CommitReceiptV1>, ControlPlaneError> {
    let mut state = FixtureCommitSequencerV1::new(
        log.initial_state_hash.clone(),
        log.verifier_hash.clone(),
    );
    let mut receipts = Vec::with_capacity(log.entries.len());
    let mut attempts = BTreeSet::new();
    for entry in &log.entries {
        let result: hepta_module_platform::PreparedResultV1 =
            serde_json::from_str(&entry.result_json)
                .map_err(|_| ControlPlaneError::PersistenceInvalid)?;
        let expected: CommitReceiptV1 = serde_json::from_str(&entry.receipt_json)
            .map_err(|_| ControlPlaneError::PersistenceInvalid)?;
        let result_hash = result.result_hash()
            .map_err(|_| ControlPlaneError::PersistenceInvalid)?;
        if entry.sequence != state.next_sequence
            || entry.result_hash != result_hash
            || entry.attempt_id != result.attempt_id
            || !attempts.insert(result.attempt_id.clone())
            || entry.plan_hash != result.plan_hash
            || entry.actual_cost_microusd != result.actual_cost_microusd
            || result.status != hepta_module_platform::PreparedResultStatusV1::Prepared
            || result.external_action_may_have_started
        {
            return Err(ControlPlaneError::PersistenceInvalid);
        }
        let verification_receipt_hash =
            verification_receipt_hash_v1(&result_hash, &log.verifier_hash)?;
        let verified = VerifiedPreparedResultV1 {
            result,
            result_hash,
            verifier_hash: log.verifier_hash.clone(),
            verification_receipt_hash,
            artifact_contents_verified: false,
        };
        let actual = state.apply_commit(&CommitRequestV1::new(entry.plan_hash.clone(), verified)?)?;
        if actual != expected || !actual.newly_committed {
            return Err(ControlPlaneError::PersistenceInvalid);
        }
        receipts.push(actual);
    }
    if state.next_sequence != log.next_sequence {
        return Err(ControlPlaneError::PersistenceInvalid);
    }
    Ok(receipts)
}

use hepta_codex_journal::{OperationJournalV1, OperationState};
use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};

pub(super) const HARD_MAXIMUM_DATABASE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
pub(super) const HARD_MAXIMUM_BUSY_TIMEOUT_MS: u64 = 60_000;

/// Filesystem and SQLite durability policy for one broker journal.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerJournalPolicyV1 {
    pub version: u16,
    pub expected_owner_uid: u32,
    pub expected_owner_gid: Option<u32>,
    pub maximum_database_bytes: u64,
    pub busy_timeout_ms: u64,
}

impl BrokerJournalPolicyV1 {
    #[must_use]
    pub const fn strict(expected_owner_uid: u32) -> Self {
        Self {
            version: 1,
            expected_owner_uid,
            expected_owner_gid: None,
            maximum_database_bytes: HARD_MAXIMUM_DATABASE_BYTES,
            busy_timeout_ms: 5_000,
        }
    }

    pub(super) fn valid(self) -> bool {
        self.version == 1
            && self.maximum_database_bytes > 0
            && self.maximum_database_bytes <= HARD_MAXIMUM_DATABASE_BYTES
            && self.busy_timeout_ms > 0
            && self.busy_timeout_ms <= HARD_MAXIMUM_BUSY_TIMEOUT_MS
    }
}

/// Immutable admission values inserted before any provider process can spawn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationReservationV1 {
    pub operation_id: String,
    pub request_hash: Sha256Digest,
    pub idempotency_key: Sha256Digest,
    pub capability_nonce: String,
    pub peer_process_id: i32,
    pub peer_user_id: u32,
    pub peer_group_id: u32,
    pub created_at_unix_ms: u64,
}

/// Whether a reservation inserted a new row or returned an exact existing row.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReservationDisposition {
    Created,
    Existing,
}

/// Reconstructed and validated operation state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrokerOperationSnapshotV1 {
    pub disposition: ReservationDisposition,
    pub idempotency_key: Sha256Digest,
    pub capability_nonce: String,
    pub peer_process_id: i32,
    pub peer_user_id: u32,
    pub peer_group_id: u32,
    pub revision: u64,
    pub provider_action_may_have_started: bool,
    pub prepared_receipt_hash: Option<Sha256Digest>,
    pub journal: OperationJournalV1,
}

/// Compare-and-swap transition request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransitionCommandV1 {
    pub operation_id: String,
    pub expected_state: OperationState,
    pub to_state: OperationState,
    pub recorded_at_unix_ms: u64,
    pub evidence_hash: Option<Sha256Digest>,
    pub reason_code: Option<String>,
}

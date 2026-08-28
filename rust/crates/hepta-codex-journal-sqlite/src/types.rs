use std::{io, path::PathBuf};

use hepta_codex_broker_protocol::PeerCredentialsV1;
use hepta_codex_journal::OperationState;
use hepta_codex_protocol::{AgentRole, Sha256Digest};
use thiserror::Error;

const MAXIMUM_BUSY_TIMEOUT_MS: u64 = 60_000;

/// Private-directory and database-owner policy for a broker-owned journal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JournalPathPolicyV1 {
    pub owner_uid: u32,
    pub owner_gid: Option<u32>,
    pub busy_timeout_ms: u64,
}

impl JournalPathPolicyV1 {
    #[must_use]
    pub const fn strict(owner_uid: u32) -> Self {
        Self {
            owner_uid,
            owner_gid: None,
            busy_timeout_ms: 5_000,
        }
    }

    pub(crate) fn validate(self) -> Result<Self, JournalStoreError> {
        if self.busy_timeout_ms == 0 || self.busy_timeout_ms > MAXIMUM_BUSY_TIMEOUT_MS {
            return Err(JournalStoreError::InvalidPathPolicy);
        }
        Ok(self)
    }
}

/// Materialized operation row. Request bytes are exact admitted transport bytes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationRecordV1 {
    pub operation_id: String,
    pub request_hash: Sha256Digest,
    pub idempotency_key: Sha256Digest,
    pub signer_key_id: String,
    pub nonce: String,
    pub peer: PeerCredentialsV1,
    pub role: AgentRole,
    pub current_state: OperationState,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
    pub provider_action_may_have_started: bool,
    pub prepared_receipt_hash: Option<Sha256Digest>,
    pub request_payload: Vec<u8>,
}

/// Idempotent reservation result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReservationOutcomeV1 {
    Reserved(OperationRecordV1),
    Existing(OperationRecordV1),
}

/// Startup/readiness integrity summary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JournalIntegrityReportV1 {
    pub operation_count: u64,
    pub transition_count: u64,
}

/// Transaction boundary used by deterministic crash-injection tests.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JournalFaultPointV1 {
    AfterOperationInsert,
    AfterTransitionInsert,
    AfterStateUpdate,
}

/// Broker journal path, schema, transaction, replay, or integrity failure.
#[derive(Debug, Error)]
pub enum JournalStoreError {
    #[error("journal path policy is invalid")]
    InvalidPathPolicy,
    #[error("journal path must be absolute and have a file name")]
    InvalidDatabasePath,
    #[error("journal parent directory is noncanonical or contains a symlink")]
    ParentDirectoryNonCanonical,
    #[error("journal parent must be a private real directory")]
    ParentDirectoryNotPrivate,
    #[error("journal database must be a private single-link regular file")]
    DatabaseFileNotPrivate,
    #[error("journal filesystem owner mismatch for {subject}")]
    OwnerMismatch {
        subject: &'static str,
        expected_uid: u32,
        observed_uid: u32,
        expected_gid: Option<u32>,
        observed_gid: u32,
    },
    #[error("journal filesystem operation failed for {0}: {1:?}")]
    Filesystem(&'static str, io::ErrorKind),
    #[error("SQLite journal operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("journal schema version is unsupported: {0}")]
    UnsupportedSchemaVersion(i64),
    #[error("verified request payload does not match the request object")]
    VerifiedPayloadMismatch,
    #[error("verified request payload hash does not match exact payload bytes")]
    VerifiedPayloadHashMismatch,
    #[error("admission time is invalid")]
    InvalidAdmissionTime,
    #[error("idempotency key is already bound to different operation authority")]
    IdempotencyConflict,
    #[error("capability signer/nonce has already been consumed")]
    NonceReplay,
    #[error("operation is not present: {0}")]
    OperationNotFound(String),
    #[error("operation state compare-and-swap failed")]
    StateCompareAndSwapFailed,
    #[error("stored digest is invalid: {0}")]
    InvalidStoredDigest(String),
    #[error("stored operation state is invalid: {0}")]
    InvalidStoredState(String),
    #[error("stored agent role is invalid: {0}")]
    InvalidStoredRole(String),
    #[error("stored integer is outside the supported range: {0}")]
    InvalidStoredInteger(&'static str),
    #[error("stored request is invalid: {0}")]
    InvalidStoredRequest(String),
    #[error("stored journal is invalid: {0}")]
    InvalidStoredJournal(String),
    #[error("SQLite integrity check failed: {0}")]
    IntegrityCheckFailed(String),
    #[error("SQLite foreign-key check reported a violation")]
    ForeignKeyViolation,
    #[error("operation/request identity does not match stored columns: {0}")]
    OperationIdentityMismatch(&'static str),
    #[error("provider-action marker is inconsistent with the transition history")]
    ProviderActionMarkerMismatch,
    #[error("prepared receipt marker is inconsistent with the transition history")]
    PreparedReceiptMarkerMismatch,
    #[error("fault injected at {0:?}")]
    InjectedFault(JournalFaultPointV1),
    #[error("journal path is not available after creation: {0}")]
    DatabasePathUnavailable(PathBuf),
}

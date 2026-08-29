//! Generation-, revision- and attempt-fenced Rust campaign persistence.

mod schema;
mod store;
mod types;

pub use store::{CampaignWriterStoreV1, FaultPointV1};
pub use types::{
    CampaignStatusV1, NodeClaimV1, NodeStateV1, NodeStatusV1, PreparedNodeResultV1,
    WriterAuthorityV1,
};

use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StateSubjectV1 {
    Campaign,
    Node,
    Writer,
    PreparedResult,
}

#[derive(Debug, Error)]
pub enum CampaignWriterError {
    #[error("writer authority is invalid")]
    InvalidAuthority,
    #[error("writer authority is stale or conflicts with the active generation")]
    StaleWriter,
    #[error("campaign or node identifier is invalid")]
    InvalidIdentifier,
    #[error("recorded time or resource amount is invalid")]
    InvalidValue,
    #[error("digest is invalid")]
    InvalidDigest,
    #[error("state conflict for {subject:?}: expected {expected}, observed {observed}")]
    StateConflict {
        subject: StateSubjectV1,
        expected: String,
        observed: String,
    },
    #[error("campaign revision is stale: expected {expected}, observed {observed}")]
    StaleRevision { expected: u64, observed: u64 },
    #[error("node lease generation is stale: expected {expected}, observed {observed}")]
    StaleLease { expected: u64, observed: u64 },
    #[error("node attempt or claim owner does not match")]
    ClaimIdentityMismatch,
    #[error("campaign budget is insufficient")]
    BudgetExhausted,
    #[error("campaign CPU reservation is insufficient")]
    CpuCapacityExhausted,
    #[error("provider action may have started; pre-provider refund is forbidden")]
    RefundAfterProviderAction,
    #[error("prepared result identity conflicts with the persisted subject")]
    PreparedResultConflict,
    #[error("database path is invalid")]
    DatabasePathInvalid,
    #[error("database file or parent authority is invalid")]
    DatabaseAuthorityInvalid,
    #[error("database identity differs: application_id={application_id}, user_version={user_version}")]
    DatabaseIdentityMismatch {
        application_id: i64,
        user_version: i64,
    },
    #[error("database integrity failure: {0}")]
    IntegrityFailure(String),
    #[error("database value is corrupt: {0}")]
    CorruptValue(&'static str),
    #[error("event hash chain is corrupt")]
    EventChainCorrupt,
    #[error("backup or restore destination already exists")]
    DestinationExists,
    #[error("numeric conversion overflowed")]
    NumericOverflow,
    #[error("deterministic fault was injected at {0:?}")]
    InjectedFault(FaultPointV1),
    #[error("filesystem operation failed at {0}: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

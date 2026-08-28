//! Broker-owned SQLite persistence for Codex external-operation journals.
//!
//! This crate owns only local broker admission and operation history. It has no
//! campaign writer, model credential, release, or submission authority.

#![forbid(unsafe_code)]

#[cfg(not(unix))]
compile_error!("hepta-codex-journal-sqlite V1 supports Unix targets only");

mod schema;
mod store;
mod types;

pub use store::BrokerJournalStoreV1;
pub use types::{
    JournalFaultPointV1, JournalIntegrityReportV1, JournalPathPolicyV1,
    JournalStoreError, OperationRecordV1, ReservationOutcomeV1,
};

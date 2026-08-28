//! Broker-owned SQLite persistence for Codex external-operation admission and
//! append-only state transitions.
//!
//! This database is deliberately separate from the campaign database. It can
//! prevent duplicate provider operations and recover local observations, but it
//! cannot grant campaign, release or submission authority.

#![forbid(unsafe_code)]

#[cfg(not(unix))]
compile_error!("hepta-codex-broker-journal V1 supports Unix targets only");

mod path;
mod schema;
mod store;
mod types;

pub use store::{BrokerJournalV1, JournalAuditV1, JournalStoreError};
pub use types::{
    BrokerJournalPolicyV1, BrokerOperationSnapshotV1, OperationReservationV1,
    ReservationDisposition, TransitionCommandV1,
};

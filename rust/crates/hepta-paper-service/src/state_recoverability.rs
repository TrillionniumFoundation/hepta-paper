//! Recoverability reconciliation from real resident, backup and mutation evidence.
//! Stored restore receipts and caller-provided readiness JSON cannot create an
//! epoch permit. Local lease checks remain observations, not distributed locks.
mod backup;
mod backup_recovery;
pub mod controller;
mod drill;
mod files;
pub mod observation;
mod publication;
mod reconciliation;
pub mod resident;
pub mod safety_inspection;
pub mod service;
mod sqlite_copy;
use crate::sqlite_mutation_coordinator::clock::{MutationClockV1, iso};
use crate::sqlite_mutation_coordinator::{Result, error, hash, hash_bytes, int, text, timestamp};
use serde_json::{Value, json};
fn ensure(valid: bool, code: &str) -> Result<()> {
    if valid { Ok(()) } else { Err(error(code)) }
}
fn clock_now(clock: &mut dyn MutationClockV1) -> Result<(i64, String)> {
    let millis = clock.now_millis()?;
    Ok((millis, iso(millis)?))
}

mod history;

pub mod cli;
mod renewal;

pub(crate) mod schema_normalization_repository;

pub(crate) mod schema_finalization_repository;
pub(crate) mod schema_installation_repository;

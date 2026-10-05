//! Fixed compare-and-append business records for the original one-shot journal.
//! This API does not admit provider/campaign execution. Its records and commit
//! acknowledgments are not scientific, launch, release or submission permits.
mod contract;
mod marker;
mod path;
mod record;
mod reopen_continuity;
mod repository;

use super::json::*;
use crate::automation_runtime_reconciliation::ordinary::ReconciliationReadControlV1;
use crate::runtime_source_cas::observation::SourceObservation;
use crate::state_recoverability::publication::Directory;
use hepta_legacy_compatibility::ProductionJsonValue as Json;
pub use marker::OneShotExternalActionMarkerV1;
use std::{
    fs::{File, Metadata},
    path::Path,
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

/// Original head comparison, with borrowed input bounded before any snapshot.
pub struct OneShotAppendRequestV1<'a> {
    pub attempt_id: &'a str,
    pub phase: &'a str,
    pub evidence: &'a Json,
    pub event_id: Option<&'a str>,
    pub recorded_at: &'a str,
    pub expected_previous_event_hash: &'a str,
    pub expected_sequence: u8,
    pub expected_phase: &'a str,
}
pub struct OneShotFinalizeRequestV1<'a> {
    pub attempt_id: &'a str,
    pub terminal_status: &'a str,
    pub outcome: &'a Json,
    pub event_id: Option<&'a str>,
    pub completed_at: &'a str,
    pub expected_previous_event_hash: &'a str,
    pub expected_sequence: u8,
    pub expected_phase: &'a str,
}
/// A local commit observation. Only the original newly committed marker may
/// yield a one-use journal ownership claim. That claim is not worker admission,
/// provider authority, an execution-binding fence, or a launch permission.
pub struct OneShotJournalMutationV1 {
    inspection: Json,
    newly_appended: bool,
    commit_acknowledged: bool,
    owner: Arc<()>,
    marker: Option<marker::CommittedMarkerV1>,
}
impl OneShotJournalMutationV1 {
    pub fn inspection(&self) -> &Json {
        &self.inspection
    }
    pub fn newly_appended(&self) -> bool {
        self.newly_appended
    }
    pub fn commit_acknowledged(&self) -> bool {
        self.commit_acknowledged
    }
}

/// Uses one original Arc and absolute Instant for its whole lifetime.
/// Reopening a durable unknown marker only observes it; it never recreates a
/// per-invocation side-effect owner. Existing standalone/status APIs are separate.
pub struct OneShotJournalV1<'a> {
    runtime: SourceObservation<'a>,
    directory: Directory,
    file: File,
    epoch: Metadata,
    control: ReconciliationReadControlV1,
    poisoned: std::cell::Cell<bool>,
    owner: Arc<()>,
    #[cfg(test)]
    failure: std::cell::Cell<Option<repository::FailurePoint>>,
    #[cfg(test)]
    reopen_swap: std::cell::Cell<Option<path::ReopenSwap>>,
}
impl<'a> OneShotJournalV1<'a> {
    pub fn open(
        runtime_root: &Path,
        control_root: &Path,
        created_at: &str,
        cancelled: &'a Arc<AtomicBool>,
        deadline: Instant,
    ) -> Result<Self, String> {
        let control = ReconciliationReadControlV1::new(cancelled.clone(), deadline);
        control.checkpoint().map_err(|e| e.to_string())?;
        if Instant::now()
            .checked_add(std::time::Duration::from_secs(120))
            .is_none_or(|ceiling| deadline > ceiling)
        {
            return Err("one_shot_journal_deadline_limit_exceeded".into());
        }
        if created_at.len() > 32 || instant(&string(created_at)).is_none() {
            return Err("campaign_one_shot_attempt_journal_clock_invalid".into());
        }
        contract::contract()?;
        let runtime = SourceObservation::new_with_deadline(runtime_root, cancelled, deadline)?;
        if runtime.root() != runtime_root
            || !control_root.is_absolute()
            || runtime_root.starts_with(control_root)
            || control_root.starts_with(runtime_root)
        {
            return Err("campaign_one_shot_attempt_journal_path_invalid".into());
        }
        // Directory admission is the existing private/no-alias owner. This
        // adapter only tightens the original one-shot leaf to exactly 0700.
        let directory = Directory::open_or_create(control_root, true).map_err(|e| e.to_string())?;
        path::private_directory(&directory)?;
        let file = path::open_file(&directory)?;
        let epoch = file.metadata().map_err(|e| e.to_string())?;
        let mut result = Self {
            runtime,
            directory,
            file,
            epoch,
            control,
            poisoned: std::cell::Cell::new(false),
            owner: Arc::new(()),
            #[cfg(test)]
            failure: std::cell::Cell::new(None),
            #[cfg(test)]
            reopen_swap: std::cell::Cell::new(None),
        };
        result.assert_current()?;
        result.provision(created_at)?;
        Ok(result)
    }
    pub fn inspect(&self, attempt_id: &str) -> Result<Json, String> {
        self.assert_current()?;
        let connection = self.open_connection(false)?;
        super::journal::schema(&connection, &self.control)?;
        let report = super::journal::inspect_connection(&connection, attempt_id, &self.control)?;
        drop(connection);
        self.assert_current()?;
        Ok(report)
    }
    pub fn reserve(&mut self, reservation: &Json) -> Result<OneShotJournalMutationV1, String> {
        self.control.checkpoint().map_err(|e| e.to_string())?;
        record::reservation(reservation, &self.control.cancelled)?;
        self.reserve_inner(reservation)
    }
    pub fn append(
        &mut self,
        request: OneShotAppendRequestV1<'_>,
    ) -> Result<OneShotJournalMutationV1, String> {
        self.control.checkpoint().map_err(|e| e.to_string())?;
        self.append_inner(request)
    }
    pub fn finalize(
        &mut self,
        request: OneShotFinalizeRequestV1<'_>,
    ) -> Result<OneShotJournalMutationV1, String> {
        self.control.checkpoint().map_err(|e| e.to_string())?;
        self.finalize_inner(request)
    }
}
#[cfg(test)]
mod interruption_tests;
#[cfg(test)]
mod tests;

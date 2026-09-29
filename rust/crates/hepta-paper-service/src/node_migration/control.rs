//! Cooperative invocation control for the existing offline migration owner.
//! No authorization, process-global signal handler or new recovery state.
use super::{NODE_MIGRATION_MAX_TIMEOUT_MS, NodeMigrationError};
use rusqlite::{Connection, ErrorCode};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
#[derive(Clone)]
pub(super) struct MigrationControl {
    stopped: Arc<AtomicBool>,
    deadline: Option<Instant>,
}
impl MigrationControl {
    pub(super) fn unbounded() -> Self {
        Self {
            stopped: Arc::new(AtomicBool::new(false)),
            deadline: None,
        }
    }
    pub(super) fn bounded(
        stopped: Arc<AtomicBool>,
        timeout: Duration,
    ) -> Result<Self, NodeMigrationError> {
        if timeout.is_zero() || timeout > Duration::from_millis(NODE_MIGRATION_MAX_TIMEOUT_MS) {
            return Err(NodeMigrationError::ControlPolicy);
        }
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or(NodeMigrationError::ControlPolicy)?;
        Ok(Self {
            stopped,
            deadline: Some(deadline),
        })
    }
    pub(super) fn check(&self) -> Result<(), NodeMigrationError> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(NodeMigrationError::Cancelled);
        }
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(NodeMigrationError::DeadlineExceeded);
        }
        Ok(())
    }
    pub(super) fn lock_wait(&self, maximum: Duration) -> Result<Duration, NodeMigrationError> {
        self.check()?;
        sqlite_wait_duration(self.deadline.map_or(maximum, |deadline| {
            maximum.min(deadline.saturating_duration_since(Instant::now()))
        }))
    }
    pub(super) fn translate(&self, error: NodeMigrationError) -> NodeMigrationError {
        if matches!(&error, NodeMigrationError::Database(cause)
            if matches!(cause.sqlite_error_code(), Some(ErrorCode::OperationInterrupted | ErrorCode::DatabaseBusy)))
            && let Err(stopped) = self.check()
        {
            return stopped;
        }
        error
    }
    pub(super) fn install(
        &self,
        connection: &Connection,
    ) -> Result<Arc<AtomicBool>, NodeMigrationError> {
        let control = self.clone();
        let enabled = Arc::new(AtomicBool::new(true));
        let callback_enabled = Arc::clone(&enabled);
        connection.progress_handler(
            1000,
            Some(move || callback_enabled.load(Ordering::Acquire) && control.check().is_err()),
        )?;
        Ok(enabled)
    }
}
/// Declare AFTER the SQLite transaction: unwind disables interruption BEFORE
/// rollback. A stop request must never prevent cleanup of the original owner.
pub(super) struct RollbackProgressGuard(pub(super) Arc<AtomicBool>);
impl RollbackProgressGuard {
    pub(super) fn disarm(&self) {
        self.0.store(false, Ordering::Release);
    }
}
impl Drop for RollbackProgressGuard {
    fn drop(&mut self) {
        self.disarm();
    }
}

/// SQLite's busy timeout accepts integer milliseconds. Rounding down can
/// return Busy just before a live monotonic deadline and misclassify expiry.
/// Waiting rounds up by less than one millisecond; admission and COMMIT still
/// recheck the unchanged exact deadline, so this never extends write authority.
pub(super) fn sqlite_wait_duration(wait: Duration) -> Result<Duration, NodeMigrationError> {
    let millis = u64::try_from(wait.as_nanos().div_ceil(1_000_000))
        .map_err(|_| NodeMigrationError::ControlPolicy)?;
    Ok(Duration::from_millis(millis))
}

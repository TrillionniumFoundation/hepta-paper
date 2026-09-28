//! In-process request cancellation, not an authorization or recovery owner.
//! SQLite state still belongs to the existing runtime and transaction.
use super::{Result, error};
use rusqlite::{Connection, ErrorCode, Transaction, TransactionBehavior};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

pub(super) const LOCK_WAIT: Duration = Duration::from_secs(5);
const RETRY_INTERVAL: Duration = Duration::from_millis(2);

pub(super) struct RequestControl<'a> {
    stopped: Option<&'a AtomicBool>,
    deadline: Option<Instant>,
}
impl<'a> RequestControl<'a> {
    pub(super) fn local() -> Self {
        Self {
            stopped: None,
            deadline: None,
        }
    }
    pub(super) fn serving(stopped: &'a AtomicBool, deadline: Instant) -> Self {
        Self {
            stopped: Some(stopped),
            deadline: Some(deadline),
        }
    }
    pub(super) fn check(&self) -> Result<()> {
        if self
            .stopped
            .is_some_and(|stop| stop.load(Ordering::Acquire))
        {
            return Err(error("local_state_authority_request_stopped"));
        }
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(error("local_state_authority_request_deadline_exceeded"));
        }
        Ok(())
    }
    pub(super) fn begin<'db>(&self, db: &'db Connection) -> Result<Transaction<'db>> {
        let limit = Instant::now() + LOCK_WAIT;
        loop {
            self.check()?;
            // Runtime entry requires &mut self and keeps exactly one connection;
            // no nested/concurrent transaction is exposed. This shared borrow
            // permits bounded BEGIN retries; SQLite still rejects nested BEGIN.
            match Transaction::new_unchecked(db, TransactionBehavior::Immediate) {
                Ok(transaction) => {
                    self.check()?;
                    return Ok(transaction);
                }
                Err(cause)
                    if cause.sqlite_error_code() == Some(ErrorCode::DatabaseBusy)
                        && Instant::now() < limit =>
                {
                    thread::sleep(
                        RETRY_INTERVAL.min(limit.saturating_duration_since(Instant::now())),
                    );
                    self.check()?;
                    // Do not start one last BEGIN after the bounded wait ends,
                    // even when the competing writer releases at that boundary.
                    if Instant::now() >= limit {
                        return Err(cause.into());
                    }
                }
                Err(cause) => return Err(cause.into()),
            }
        }
    }
}

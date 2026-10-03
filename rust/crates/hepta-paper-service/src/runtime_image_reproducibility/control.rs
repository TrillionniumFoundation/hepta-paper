use super::{Error, Result};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

/// The normal operation borrows one original control context. It is never
/// decoded from flags, configuration, an attestation or a publication receipt.
#[derive(Clone, Copy)]
pub(crate) struct OperationControl<'a> {
    cancelled: &'a AtomicBool,
    deadline: Instant,
}
impl<'a> OperationControl<'a> {
    pub(crate) fn new(cancelled: &'a AtomicBool, deadline: Instant) -> Self {
        Self {
            cancelled,
            deadline,
        }
    }
    pub(crate) fn cancelled(self) -> &'a AtomicBool {
        self.cancelled
    }
    pub(crate) fn deadline(self) -> Instant {
        self.deadline
    }
    pub(crate) fn check(self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(Error("runtime_reproducibility_cancelled".into()))
        } else if Instant::now() >= self.deadline {
            Err(Error("runtime_reproducibility_deadline_exceeded".into()))
        } else {
            Ok(())
        }
    }
}
pub(crate) fn check(control: Option<OperationControl<'_>>) -> Result<()> {
    match control {
        Some(control) => control.check(),
        None => Ok(()),
    }
}

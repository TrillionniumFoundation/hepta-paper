//! Optional inherited operation control for the existing inventory owner.
//! None preserves the standalone/old API. This does not create authority.
use super::*;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::Instant,
};
#[derive(Clone)]
pub(crate) struct StateDatabaseInventoryControlV1 {
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
    failure: Arc<AtomicU8>,
}
impl StateDatabaseInventoryControlV1 {
    pub(crate) fn new(cancelled: &Arc<AtomicBool>, deadline: Instant) -> Result<Self> {
        let value = Self {
            cancelled: Arc::clone(cancelled),
            deadline,
            failure: Arc::new(AtomicU8::new(0)),
        };
        value.check()?;
        Ok(value)
    }
    pub(crate) fn check(&self) -> Result<()> {
        let mut code = self.failure.load(Ordering::Acquire);
        if code == 0 {
            let observed = if self.cancelled.load(Ordering::Acquire) {
                1
            } else if Instant::now() >= self.deadline {
                2
            } else {
                0
            };
            if observed != 0 {
                let _ =
                    self.failure
                        .compare_exchange(0, observed, Ordering::AcqRel, Ordering::Acquire);
                code = self.failure.load(Ordering::Acquire);
            }
        }
        match code {
            0 => Ok(()),
            1 => Err(error(
                "autonomous_research_state_database_inventory_cancelled",
            )),
            _ => Err(error(
                "autonomous_research_state_database_inventory_deadline_exceeded",
            )),
        }
    }
}
pub(super) fn checkpoint(control: &Option<StateDatabaseInventoryControlV1>) -> Result<()> {
    if let Some(control) = control {
        control.check()?;
    }
    Ok(())
}

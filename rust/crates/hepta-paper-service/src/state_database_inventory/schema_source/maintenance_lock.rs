//! A cooperating maintenance lock is bound to the runtime-root inode itself.
//! No replaceable lock pathname can split cooperating runners into two locks.
use super::*;
use nix::fcntl::{Flock, FlockArg};
use std::fs::File;

pub(crate) struct SchemaMaintenanceLock {
    ancestors: Vec<files::Directory>,
    identity: Value,
    _lock: Flock<File>,
}
impl SchemaMaintenanceLock {
    pub(crate) fn acquire(source: &SchemaSource) -> Result<Self> {
        source.assert_current()?;
        let root = source.ancestors.last().ok_or_else(files::changed)?;
        // Open a distinct file description. Duplicating an existing flock's
        // description would share its lock and would not exclude another run.
        let (_, ancestors) = files::open_root(&root.path)?;
        let observed = ancestors.last().ok_or_else(files::changed)?;
        ensure(
            root_identity(observed)? == source.root_identity,
            "autonomous_research_online_schema_transition_runtime_root_identity_changed",
        )?;
        let file = observed.held.try_clone().map_err(|_| files::changed())?;
        let lock = Flock::lock(file, FlockArg::LockExclusiveNonblock)
            .map_err(|_| error("autonomous_research_online_schema_transition_maintenance_busy"))?;
        let result = Self {
            ancestors,
            identity: source.root_identity.clone(),
            _lock: lock,
        };
        result.assert_current()?;
        source.assert_current()?;
        Ok(result)
    }
    pub(crate) fn runtime_root(&self) -> Result<&Path> {
        self.ancestors
            .last()
            .map(|root| root.path.as_path())
            .ok_or_else(files::changed)
    }
    pub(crate) fn assert_current(&self) -> Result<()> {
        for ancestor in &self.ancestors {
            ancestor.assert_current()?;
        }
        ensure(
            root_identity(self.ancestors.last().ok_or_else(files::changed)?)? == self.identity,
            "autonomous_research_online_schema_transition_runtime_root_identity_changed",
        )
    }
    pub(crate) fn identity(&self) -> &Value {
        &self.identity
    }
}

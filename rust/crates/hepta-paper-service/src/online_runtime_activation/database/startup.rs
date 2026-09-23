//! Dedicated recovery operations, never an arbitrary live Connection callback.
use super::*;
use crate::sqlite_mutation_coordinator::{
    self as mutation,
    authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
    clock::MutationClockV1,
    startup::{StartupMutationReconciliationV1, reconcile_online_mutation_database_startup_v1},
};
impl LiveActivationDatabaseV1 {
    pub(crate) fn reconcile_startup<T: MutationAuthorityTransportV1>(
        &mut self,
        authority: &mut PinnedMutationAuthorityV1<T>,
        manifest: &Value,
        clock: &mut dyn MutationClockV1,
        role: &str,
        instance: &str,
    ) -> mutation::Result<StartupMutationReconciliationV1> {
        self.assert_current().map_err(|e| mutation::error(e.code))?;
        let previous = self.snapshot.clone();
        let result = reconcile_online_mutation_database_startup_v1(
            &mut self.connection,
            role,
            instance,
            authority,
            manifest,
            clock,
        );
        let next = identity(&self.metadata().map_err(|e| mutation::error(e.code))?);
        if ["device", "inode", "mode", "links"]
            .iter()
            .any(|key| previous[key] != next[key])
        {
            return Err(mutation::error(changed().code));
        }
        self.snapshot = next;
        result
    }
}

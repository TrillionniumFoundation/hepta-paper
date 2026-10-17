//! Read-only provenance binding for the concrete recoverability composition.
use super::*;
impl<T: StateBackupAuthorityTransportV1> PinnedStateBackupAuthorityV1<T> {
    pub(crate) fn online_mutation_configuration_hash(&self) -> Option<&str> {
        self.online
            .as_ref()
            .map(PinnedMutationAuthorityV1::configuration_hash)
    }
}

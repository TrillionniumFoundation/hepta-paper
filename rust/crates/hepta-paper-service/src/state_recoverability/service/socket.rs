//! One owning recovery service, two authenticated receipt families, one original
//! socket creator. This does not establish native installation or activation.
use super::*;
use crate::{
    local_state_authority_client::LocalStateAuthoritySocketTransportV1,
    sqlite_mutation_coordinator::manifest::writer_manifest_hash_v1,
    state_backup_authority::socket::ObservedSocketAuthorityInputsV1,
};

impl
    BackupRecoveryServiceV1<
        LocalStateAuthoritySocketTransportV1,
        LocalStateAuthoritySocketTransportV1,
    >
{
    /// Load the pinned socket profile and its bound online authority, validate
    /// the options and actual complete runtime scope, then capture one socket
    /// origin for both clients. All checks precede any authority request.
    ///
    /// Call before opening any caller-owned SQLite connection. Public input
    /// descriptors are retained by the clients; temporary inventory descriptors
    /// and its copied-database SQLite connections are gone before return.
    /// Later operations re-observe their own inventory. This constructor grants
    /// neither a recoverability epoch nor native production authorization.
    pub fn load_socket_v1(
        configuration_path: &Path,
        raw_configuration_file_hash: &str,
        options: BackupRecoveryServiceOptionsV1,
    ) -> Result<Self> {
        let inputs =
            ObservedSocketAuthorityInputsV1::load(configuration_path, raw_configuration_file_hash)?;
        validate_service_options(
            &options,
            Some(inputs.online_configuration_hash()),
            inputs.online_configuration_hash(),
        )?;
        let writer_hash = writer_manifest_hash_v1(&options.writer_manifest)?;
        ensure(
            inputs.online_trust()["writerManifestHash"] == writer_hash,
            "autonomous_research_state_reconcile_and_renew_authority_scope_mismatch",
        )?;
        let inventory = observe_state_database_inventory_v1(
            &options.runtime_root,
            &options.state_database_manifest,
        )?;
        ensure(
            inputs.online_trust()["databaseScopeHash"] == inventory.value()["databaseScopeHash"],
            "autonomous_research_state_reconcile_and_renew_authority_scope_mismatch",
        )?;
        inventory.assert_current()?;
        inputs.assert_current()?;
        let (backup, online) = inputs.connect_recovery_pair()?;
        let service = Self::new(backup, online, options)?;
        inventory.assert_current()?;
        // Never carry these raw source/sidecar FDs into the service's later
        // SQLite transactions, including on constructor rejection or unwind.
        drop(inventory);
        Ok(service)
    }
}

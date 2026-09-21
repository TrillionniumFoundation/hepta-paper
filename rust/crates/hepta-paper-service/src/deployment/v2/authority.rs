//! Public-only authority observation. No private key, database or socket is opened.
use super::*;
use crate::sqlite_mutation_coordinator::authority::files::Snapshot;
use crate::sqlite_mutation_coordinator::{hash, text};
use crate::state_backup_authority::socket::ObservedSocketAuthorityInputsV1;
use serde_json::{Value, json};

pub(super) struct ObservedAuthorityPublicInputsV2 {
    daemon: Snapshot,
    preflight_backup: Snapshot,
    preflight_online: Snapshot,
    socket: ObservedSocketAuthorityInputsV1,
    binding: Value,
}

impl ObservedAuthorityPublicInputsV2 {
    pub(super) fn load(
        installation: &ProductionAuthorityInstallationV2,
        forbidden_roots: &[&Path],
    ) -> Result<Self, ProductionDeploymentError> {
        // Reject declared private namespaces before opening even a configuration.
        // The full producer supplies every service's private roots and the IPC
        // root. Public-only lower tests cannot turn this into deployment proof.
        for input in [
            &installation.daemon_configuration,
            &installation.online_configuration,
            &installation.backup_socket_configuration,
        ] {
            assert_public_path(&input.path, forbidden_roots)?;
        }
        let daemon = Snapshot::load(
            &installation.daemon_configuration.path,
            installation.daemon_configuration.sha256.as_str(),
            1024 * 1024,
            "production_authority_daemon_configuration_invalid",
        )
        .map_err(authority_error)?;
        let value = daemon
            .json("production_authority_daemon_configuration_invalid")
            .map_err(authority_error)?;
        crate::local_state_authority::configuration::validate_configuration(&value)
            .map_err(authority_error)?;
        let path = |key| text(&value, key).map(Path::new).map_err(authority_error);
        let state = path("stateDatabasePath")?;
        let key = path("privateKeyPath")?;
        let endpoint = path("socketPath")?;
        if !strict_descendant(state, &installation.private_state_root)
            || !strict_descendant(key, &installation.private_key_root)
            || state.starts_with(key)
            || key.starts_with(state)
            || !strict_path(endpoint)
            || endpoint.parent() != Some(installation.ipc_root.path.as_path())
            || nix::sys::socket::UnixAddr::new(endpoint).is_err()
        {
            return Err(ProductionDeploymentError::AuthorityInstallationInvalid);
        }
        // Read only the independently pinned configuration documents first.
        // Their nested public-key references must pass the same boundary before
        // the shared producer may follow them. The repeated shared reads use
        // these exact raw pins, and these original snapshots remain alive.
        let preflight_backup = Snapshot::load(
            &installation.backup_socket_configuration.path,
            installation.backup_socket_configuration.sha256.as_str(),
            4 * 1024 * 1024,
            "production_authority_backup_configuration_invalid",
        )
        .map_err(authority_error)?;
        let backup_value = preflight_backup
            .json("production_authority_backup_configuration_invalid")
            .map_err(authority_error)?;
        if backup_value["onlineMutationAuthorityConfigurationPath"]
            != json!(installation.online_configuration.path)
            || backup_value["onlineMutationAuthorityConfigurationSha256"]
                != installation.online_configuration.sha256.as_str()
        {
            return Err(ProductionDeploymentError::AuthorityInstallationInvalid);
        }
        assert_public_reference(&backup_value, "publicKeyPath", forbidden_roots)?;
        let preflight_online = Snapshot::load(
            &installation.online_configuration.path,
            installation.online_configuration.sha256.as_str(),
            4 * 1024 * 1024,
            "production_authority_online_configuration_invalid",
        )
        .map_err(authority_error)?;
        let online_value = preflight_online
            .json("production_authority_online_configuration_invalid")
            .map_err(authority_error)?;
        assert_public_reference(&online_value, "publicKeyPath", forbidden_roots)?;
        let socket = ObservedSocketAuthorityInputsV1::load(
            &installation.backup_socket_configuration.path,
            installation.backup_socket_configuration.sha256.as_str(),
        )
        .map_err(authority_error)?;
        let backup = socket.value();
        if backup["onlineMutationAuthorityConfigurationPath"]
            != json!(installation.online_configuration.path)
            || backup["onlineMutationAuthorityConfigurationSha256"]
                != installation.online_configuration.sha256.as_str()
            || backup["socketPath"] != value["socketPath"]
        {
            return Err(ProductionDeploymentError::AuthorityInstallationInvalid);
        }
        let mut trust = value
            .as_object()
            .cloned()
            .ok_or(ProductionDeploymentError::AuthorityInstallationInvalid)?;
        for key in ["privateKeyPath", "stateDatabasePath", "socketPath"] {
            trust.remove(key);
        }
        trust.insert(
            "kind".into(),
            json!("AutonomousResearchOnlineMutationAuthorityTrust"),
        );
        if &Value::Object(trust) != socket.online_trust() {
            return Err(ProductionDeploymentError::AuthorityInstallationInvalid);
        }
        let binding = json!({
            "kind":"HeptaProductionAuthorityPublicBindingV2",
            "daemonConfigurationHash":hash("HeptaLocalAutonomousResearchStateAuthorityConfiguration", &value)
                .map_err(authority_error)?,
            "onlineConfigurationHash":socket.online_configuration_hash(),
            "backupSocketConfigurationHash":socket.configuration_hash(),
            "publicKeySha256":Sha256Digest::from_digest_bytes(Sha256::digest(socket.verification_key().as_bytes()).into()),
            "authorityId":value["authorityId"], "keyId":value["keyId"],
            "scopeId":value["scopeId"], "databaseScopeHash":value["databaseScopeHash"],
            "writerManifestHash":value["writerManifestHash"],
            "maximumReservationLeaseMs":value["maximumReservationLeaseMs"],
            "maximumObservationAgeMs":value["maximumObservationAgeMs"],
            "socketPath":value["socketPath"], "stateDatabasePath":value["stateDatabasePath"],
            "privateKeyPath":value["privateKeyPath"],
            "timeoutMs":backup["timeoutMs"], "maximumMessageBytes":backup["maximumMessageBytes"]
        });
        let result = Self {
            daemon,
            preflight_backup,
            preflight_online,
            socket,
            binding,
        };
        result.assert_current()?;
        Ok(result)
    }

    pub(super) fn assert_current(&self) -> Result<(), ProductionDeploymentError> {
        self.daemon.assert_current().map_err(authority_error)?;
        self.preflight_backup
            .assert_current()
            .map_err(authority_error)?;
        self.preflight_online
            .assert_current()
            .map_err(authority_error)?;
        self.socket.assert_current().map_err(authority_error)
    }

    pub(super) fn binding(&self) -> &Value {
        &self.binding
    }

    pub(super) fn files(&self) -> Vec<&Snapshot> {
        let mut files = vec![&self.daemon, &self.preflight_backup, &self.preflight_online];
        files.extend(self.socket.files());
        files
    }
}

fn assert_public_reference(
    document: &Value,
    field: &str,
    forbidden_roots: &[&Path],
) -> Result<(), ProductionDeploymentError> {
    let path = document[field]
        .as_str()
        .map(Path::new)
        .ok_or(ProductionDeploymentError::AuthorityInstallationInvalid)?;
    assert_public_path(path, forbidden_roots)
}

fn assert_public_path(
    path: &Path,
    forbidden_roots: &[&Path],
) -> Result<(), ProductionDeploymentError> {
    if !strict_path(path) || forbidden_roots.iter().any(|root| path.starts_with(root)) {
        return Err(ProductionDeploymentError::AuthorityInstallationInvalid);
    }
    Ok(())
}

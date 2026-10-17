//! This helper can create only an already-revoked binding for denial-path tests.
use super::*;
use std::{fs, os::unix::fs::PermissionsExt};

impl InstalledCanaryDispatcherBindingV1 {
    pub(crate) fn revoked_for_test(
        resolved: ProductCodexDispatcherConfigurationV1,
        root: &Path,
    ) -> Self {
        let directory = root.join("revoked-configuration");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o750)).unwrap();
        let path = directory.join("broker.json");
        let uid = nix::unistd::geteuid().as_raw();
        let gid = nix::unistd::getegid().as_raw();
        let mut configuration = super::super::tests::configuration();
        configuration.configuration_authority_uid = uid;
        configuration.configuration_reader_gid = gid;
        configuration.broker_uid = uid.checked_add(1).unwrap_or_else(|| uid - 1);
        configuration.broker_gid = gid;
        configuration.operation_authority_uid = uid;
        configuration.trust_bundle_authority_uid = uid;
        configuration.gate_authority_uid = uid;
        configuration.listener.parent_owner_uid = configuration.broker_uid;
        configuration.listener.parent_group_gid = gid;
        configuration.purpose = crate::ProductCodexOperationPurposeV1::OneShotReadOnlyCanary;
        fs::write(&path, serde_json::to_vec(&configuration).unwrap()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o440)).unwrap();
        let loaded = super::super::config::load_configuration_source(&path).unwrap();
        loaded.revoke_for_test();
        assert!(loaded.assert_source_current().is_err());
        Self { loaded, resolved }
    }
}

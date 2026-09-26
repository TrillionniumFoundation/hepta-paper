//! Installed authority owner: V2 deployment + original socket pidfd + systemd
//! association. Manager I/O is completed before SQLite; retained currentness is
//! descriptor/pidfd-only and each business RPC still rechecks the same origin.
use super::*;
use crate::{
    LegacyNodeRuntimeDispositionV1, ProductionDeploymentManifestV2, ProductionServiceRoleV2,
    RetainedProductionDeploymentV2,
    local_state_authority_client::LocalStateAuthoritySocketTransportV1,
    state_backup_authority::socket::{
        ObservedSocketAuthorityInputsV1, SocketActivationAuthorityBundleV1,
    },
};
use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::canonical_hash_v1;
use std::collections::BTreeSet;

pub(super) struct RetainedInstalledAuthorityV2 {
    deployment: RetainedProductionDeploymentV2,
    origin: LocalStateAuthoritySocketTransportV1,
    manager_report: Value,
    profile_hash: String,
}

pub(super) struct InstalledAuthorityOwnersV2 {
    pub(super) retained: RetainedInstalledAuthorityV2,
    pub(super) authority: Online,
    pub(super) verifier: Online,
    pub(super) recovery_online: Online,
    pub(super) backup: PinnedStateBackupAuthorityV1<BackupAuthorityTransportV1>,
}

fn installed_error(
    suffix: &str,
) -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    fail(&format!("installed_authority_{suffix}"))
}

fn number(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|value| u32::try_from(value).ok())
}

fn installed_profile_hash_v2(deployment_hash: &Sha256Digest, report: &Value) -> Result<String> {
    canonical_hash_v1(&(
        "hepta-installed-state-authority-profile-v2",
        deployment_hash,
        report,
    ))
    .map(|value| value.as_str().to_owned())
    .map_err(|_| installed_error("profile_hash_invalid"))
}

fn state_authority_unit(
    manifest: &ProductionDeploymentManifestV2,
) -> Result<&crate::ProductionServiceUnitV2> {
    let mut rows = manifest
        .services
        .iter()
        .filter(|unit| unit.role == ProductionServiceRoleV2::StateAuthority);
    let unit = rows.next().ok_or_else(|| installed_error("unit_missing"))?;
    if rows.next().is_some()
        || unit.service_id != manifest.authority.service_id
        || unit.systemd_unit != manifest.authority.systemd_unit
    {
        return Err(installed_error("unit_mismatch"));
    }
    Ok(unit)
}

fn bind_manager_report_v2(manifest: &ProductionDeploymentManifestV2, report: &Value) -> Result<()> {
    let unit = state_authority_unit(manifest)?;
    let origin = &report["socketOrigin"];
    let kernel = &report["kernelCredentials"];
    let manager = &report["manager"];
    let props = &manager["unitProperties"];
    let service = &manager["serviceProperties"];
    let pid = number(&origin["pid"])
        .filter(|value| *value > 0)
        .ok_or_else(|| installed_error("socket_origin_invalid"))?;
    if number(&origin["uid"]) != Some(unit.principal_uid)
        || number(&origin["gid"]) != Some(unit.principal_gid)
        || manager["unitId"] != unit.systemd_unit
        || props["Id"] != unit.systemd_unit
        || props["LoadState"] != "loaded"
        || props["ActiveState"] != "active"
        || props["SubState"] != "running"
        || props["NeedDaemonReload"] != false
        || number(&service["MainPID"]) != Some(pid)
        || number(&service["ControlPID"]) != Some(0)
        || number(&service["UID"]) != Some(unit.principal_uid)
        || number(&service["GID"]) != Some(unit.principal_gid)
        || service["DynamicUser"] != false
    {
        return Err(installed_error("manager_binding_mismatch"));
    }
    for field in ["real", "effective", "saved", "filesystem"] {
        if number(&kernel["uid"][field]) != Some(unit.principal_uid)
            || number(&kernel["gid"][field]) != Some(unit.principal_gid)
        {
            return Err(installed_error("kernel_principal_mismatch"));
        }
    }
    let actual_groups = kernel["supplementaryGids"]
        .as_array()
        .ok_or_else(|| installed_error("kernel_groups_invalid"))?
        .iter()
        .map(number)
        .collect::<Option<BTreeSet<_>>>()
        .ok_or_else(|| installed_error("kernel_groups_invalid"))?;
    let declared = unit
        .supplementary_gids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    let actual_without_primary = actual_groups
        .into_iter()
        .filter(|gid| *gid != unit.principal_gid)
        .collect::<BTreeSet<_>>();
    if actual_without_primary != declared {
        return Err(installed_error("kernel_groups_mismatch"));
    }
    let commands = service["ExecStart"]
        .as_array()
        .filter(|rows| rows.len() == 1)
        .ok_or_else(|| installed_error("exec_start_invalid"))?;
    let command = commands[0]
        .as_array()
        .filter(|row| row.len() == 10)
        .ok_or_else(|| installed_error("exec_start_invalid"))?;
    let expected_argv = std::iter::once(unit.executable_path.to_string_lossy().into_owned())
        .chain(unit.arguments.iter().cloned())
        .map(Value::String)
        .collect::<Vec<_>>();
    if command[0] != unit.executable_path.to_string_lossy().as_ref()
        || command[1].as_array() != Some(&expected_argv)
        || command[2] != false
        || props["ControlGroup"].as_str().is_none_or(str::is_empty)
    {
        return Err(installed_error("exec_start_mismatch"));
    }
    Ok(())
}

impl RetainedInstalledAuthorityV2 {
    pub(super) fn assert_current(&self) -> Result<()> {
        self.deployment
            .assert_current()
            .map_err(|_| installed_error("deployment_changed"))?;
        self.origin.assert_origin_current_v1()?;
        let current_profile = installed_profile_hash_v2(
            self.deployment.observation().identity_hash(),
            &self.manager_report,
        )?;
        if current_profile != self.profile_hash {
            return Err(installed_error("profile_hash_changed"));
        }
        Ok(())
    }
    pub(super) fn profile_hash(&self) -> String {
        self.profile_hash.clone()
    }
}
pub(super) fn load_installed_authority_v2(
    manifest: &ProductionDeploymentManifestV2,
) -> Result<InstalledAuthorityOwnersV2> {
    if manifest.legacy_node_runtime != LegacyNodeRuntimeDispositionV1::RemovedFromProduction {
        return Err(installed_error("legacy_node_still_active"));
    }
    let deployment = RetainedProductionDeploymentV2::capture(manifest)
        .map_err(|_| installed_error("deployment_invalid"))?;
    let backup = &manifest.authority.backup_socket_configuration;
    let inputs = ObservedSocketAuthorityInputsV1::load(&backup.path, backup.sha256.as_str())?;
    let SocketActivationAuthorityBundleV1 {
        backup,
        authority,
        verifier,
        recovery_online,
        origin,
    } = inputs.connect_activation_bundle()?;
    let manager = origin
        .observe_system_manager_v1()
        .map_err(|_| installed_error("manager_observation_failed"))?;
    bind_manager_report_v2(manifest, manager.report())?;
    deployment
        .assert_current()
        .map_err(|_| installed_error("deployment_changed"))?;
    origin.assert_origin_current_v1()?;
    let profile_hash =
        installed_profile_hash_v2(deployment.observation().identity_hash(), manager.report())?;
    let wrap_online =
        |value: crate::sqlite_mutation_coordinator::authority::PinnedMutationAuthorityV1<
            LocalStateAuthoritySocketTransportV1,
        >| {
            value.map_transport(|inner| OnlineAuthorityTransportV1::InstalledSocket {
                inner,
                profile_hash: profile_hash.clone(),
            })
        };
    let retained = RetainedInstalledAuthorityV2 {
        deployment,
        origin,
        manager_report: manager.report().clone(),
        profile_hash: profile_hash.clone(),
    };
    let result = InstalledAuthorityOwnersV2 {
        retained,
        authority: wrap_online(authority),
        verifier: wrap_online(verifier),
        recovery_online: wrap_online(recovery_online),
        backup: backup.map_transport(BackupAuthorityTransportV1::InstalledSocket),
    };
    result.retained.assert_current()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ProductionAuthorityInstallationV2, ProductionAuthorityIpcRootV2, ProductionPublicFileV2,
        ProductionServiceUnitV2, ProductionWritableRootV1,
    };
    use serde_json::json;
    use std::path::PathBuf;

    fn digest(marker: u8) -> Sha256Digest {
        format!("sha256:{marker:064x}").parse().expect("digest")
    }

    fn unit(role: ProductionServiceRoleV2, id: &str, uid: u32) -> ProductionServiceUnitV2 {
        let state_authority = role == ProductionServiceRoleV2::StateAuthority;
        ProductionServiceUnitV2 {
            service_id: id.into(),
            systemd_unit: if state_authority {
                "hepta-paper-state-authority.service".into()
            } else {
                format!("{id}.service")
            },
            role,
            principal_uid: uid,
            principal_gid: if state_authority { 9009 } else { uid },
            supplementary_gids: vec![],
            executable_path: if state_authority {
                PathBuf::from("/opt/hepta/hepta-paper-state-authority-daemon")
            } else {
                PathBuf::from(format!("/opt/hepta/{id}"))
            },
            executable_hash: digest(1),
            executable_owner_uid: 0,
            executable_owner_gid: 0,
            executable_mode: 0o755,
            arguments: if state_authority {
                vec![
                    "--configuration".into(),
                    "/etc/hepta-native/state-authority/daemon.json".into(),
                ]
            } else {
                vec!["serve".into()]
            },
            environment_keys: vec![],
            writable_roots: if state_authority {
                vec![ProductionWritableRootV1 {
                    path: "/var/lib/hepta-native-authority".into(),
                    owner_uid: uid,
                    owner_gid: 9009,
                    mode: 0o700,
                }]
            } else {
                vec![]
            },
            network_declared: false,
        }
    }

    fn manifest() -> ProductionDeploymentManifestV2 {
        let roles = [
            (ProductionServiceRoleV2::ControlPlane, "control", 1001),
            (ProductionServiceRoleV2::CodexAuthorBroker, "author", 1002),
            (
                ProductionServiceRoleV2::CodexReviewerBroker,
                "reviewer",
                1003,
            ),
            (ProductionServiceRoleV2::CodexFormalBroker, "formal", 1004),
            (ProductionServiceRoleV2::CodexRepairBroker, "repair", 1005),
            (ProductionServiceRoleV2::EvidenceVerifier, "evidence", 1006),
            (ProductionServiceRoleV2::ReleaseBroker, "release", 1007),
            (
                ProductionServiceRoleV2::SubmissionBroker,
                "submission",
                1008,
            ),
            (
                ProductionServiceRoleV2::StateAuthority,
                "state-authority",
                1009,
            ),
        ];
        ProductionDeploymentManifestV2 {
            version: 2,
            repository: "TrillionniumFoundation/hepta-paper".into(),
            commit: "a".repeat(40),
            tree: "b".repeat(40),
            service_manager_inventory_hash: digest(2),
            mount_topology_hash: digest(3),
            legacy_runtime_scan_hash: digest(4),
            legacy_node_runtime: LegacyNodeRuntimeDispositionV1::RemovedFromProduction,
            services: roles
                .into_iter()
                .map(|(role, id, uid)| unit(role, id, uid))
                .collect(),
            authority: ProductionAuthorityInstallationV2 {
                service_id: "state-authority".into(),
                systemd_unit: "hepta-paper-state-authority.service".into(),
                daemon_configuration: ProductionPublicFileV2 {
                    path: "/etc/hepta-native/state-authority/daemon.json".into(),
                    sha256: digest(5),
                },
                online_configuration: ProductionPublicFileV2 {
                    path: "/etc/hepta-native/state-authority/online.json".into(),
                    sha256: digest(6),
                },
                backup_socket_configuration: ProductionPublicFileV2 {
                    path: "/etc/hepta-native/state-authority/backup.json".into(),
                    sha256: digest(7),
                },
                private_state_root: "/var/lib/hepta-native-authority".into(),
                private_key_root: "/var/lib/hepta-native-authority-keys".into(),
                ipc_root: ProductionAuthorityIpcRootV2 {
                    path: "/run/hepta-native-authority".into(),
                    owner_uid: 1009,
                    owner_gid: 9009,
                    mode: 0o750,
                },
            },
        }
    }

    fn manager_report() -> Value {
        json!({
            "socketOrigin":{"pid":4242,"uid":1009,"gid":9009},
            "kernelCredentials":{
                "uid":{"real":1009,"effective":1009,"saved":1009,"filesystem":1009},
                "gid":{"real":9009,"effective":9009,"saved":9009,"filesystem":9009},
                "supplementaryGids":[9009]
            },
            "manager":{
                "unitId":"hepta-paper-state-authority.service",
                "unitProperties":{
                    "Id":"hepta-paper-state-authority.service",
                    "LoadState":"loaded","ActiveState":"active","SubState":"running",
                    "NeedDaemonReload":false,"ControlGroup":"/system.slice/hepta-paper-state-authority.service",
                    "InvocationID":"00112233445566778899aabbccddeeff"
                },
                "serviceProperties":{
                    "MainPID":4242,"ControlPID":0,"UID":1009,"GID":9009,"DynamicUser":false,
                    "ExecStart":[[
                        "/opt/hepta/hepta-paper-state-authority-daemon",
                        ["/opt/hepta/hepta-paper-state-authority-daemon","--configuration","/etc/hepta-native/state-authority/daemon.json"],
                        false,0,0,0,0,0,0,0
                    ]]
                }
            }
        })
    }

    #[test]
    fn installed_owner_manifest_type_refuses_a_legacy_node_runtime_before_io() {
        let mut value = serde_json::to_value(manifest()).expect("manifest value");
        value["legacyNodeRuntime"] = json!("active");
        assert!(
            serde_json::from_value::<ProductionDeploymentManifestV2>(value).is_err(),
            "the installed-owner profile is unconstructable while Node remains active"
        );
    }

    #[test]
    fn manager_binding_accepts_only_the_declared_live_state_authority() {
        let manifest = manifest();
        let report = manager_report();
        bind_manager_report_v2(&manifest, &report).expect("exact manager binding");

        for (path, replacement) in [
            (("manager", "serviceProperties", "MainPID"), json!(4243)),
            (("manager", "serviceProperties", "UID"), json!(1008)),
            (
                ("manager", "unitProperties", "NeedDaemonReload"),
                json!(true),
            ),
        ] {
            let mut changed = report.clone();
            changed[path.0][path.1][path.2] = replacement;
            assert!(bind_manager_report_v2(&manifest, &changed).is_err());
        }
        let mut changed = report.clone();
        changed["kernelCredentials"]["supplementaryGids"] = json!([9009, 9010]);
        assert!(bind_manager_report_v2(&manifest, &changed).is_err());
        let mut changed = report.clone();
        changed["manager"]["serviceProperties"]["ExecStart"][0][1][0] =
            json!("/opt/hepta/replaced-daemon");
        assert!(bind_manager_report_v2(&manifest, &changed).is_err());
    }

    #[test]
    fn installed_profile_identity_binds_static_deployment_and_observed_manager_instance() {
        let report = manager_report();
        let deployment = digest(40);
        let original = installed_profile_hash_v2(&deployment, &report).expect("profile");
        let mut changed = report.clone();
        changed["manager"]["unitProperties"]["InvocationID"] =
            json!("ffeeddccbbaa99887766554433221100");
        assert_ne!(
            original,
            installed_profile_hash_v2(&deployment, &changed).expect("changed manager profile")
        );
        assert_ne!(
            original,
            installed_profile_hash_v2(&digest(41), &report).expect("changed deployment profile")
        );
    }
}

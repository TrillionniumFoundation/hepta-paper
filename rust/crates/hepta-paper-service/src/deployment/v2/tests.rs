use super::*;
use authority::ObservedAuthorityPublicInputsV2;
use ed25519_dalek::{SigningKey, pkcs8::EncodePublicKey};
use serde_json::{Value, json};
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn digest(marker: u8) -> Sha256Digest {
    format!("sha256:{marker:064x}")
        .parse()
        .expect("fixture digest")
}

fn raw_digest(bytes: &[u8]) -> Sha256Digest {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
        .parse()
        .expect("actual byte digest")
}

fn unit(
    role: ProductionServiceRoleV2,
    service_id: &str,
    executable: &str,
    principal: u32,
) -> ProductionServiceUnitV2 {
    ProductionServiceUnitV2 {
        service_id: service_id.into(),
        systemd_unit: if role == ProductionServiceRoleV2::StateAuthority {
            "hepta-paper-state-authority.service".into()
        } else {
            format!("{service_id}.service")
        },
        role,
        principal_uid: principal,
        principal_gid: principal,
        supplementary_gids: vec![],
        executable_path: executable.into(),
        executable_hash: digest(1),
        executable_owner_uid: 0,
        executable_owner_gid: 0,
        executable_mode: 0o755,
        arguments: vec!["serve".into()],
        environment_keys: if matches!(
            role,
            ProductionServiceRoleV2::CodexAuthorBroker
                | ProductionServiceRoleV2::CodexReviewerBroker
                | ProductionServiceRoleV2::CodexFormalBroker
                | ProductionServiceRoleV2::CodexRepairBroker
        ) {
            vec!["CODEX_HOME".into()]
        } else {
            vec![]
        },
        writable_roots: vec![],
        network_declared: false,
    }
}

fn manifest() -> ProductionDeploymentManifestV2 {
    let mut services = vec![
        unit(
            ProductionServiceRoleV2::ControlPlane,
            "control",
            "/opt/hepta/hepta-paper-rust",
            1001,
        ),
        unit(
            ProductionServiceRoleV2::CodexAuthorBroker,
            "author",
            "/opt/hepta/hepta-codex-broker",
            1002,
        ),
        unit(
            ProductionServiceRoleV2::CodexReviewerBroker,
            "reviewer",
            "/opt/hepta/hepta-codex-broker",
            1003,
        ),
        unit(
            ProductionServiceRoleV2::CodexFormalBroker,
            "formal",
            "/opt/hepta/hepta-codex-broker",
            1004,
        ),
        unit(
            ProductionServiceRoleV2::CodexRepairBroker,
            "repair",
            "/opt/hepta/hepta-codex-broker",
            1005,
        ),
        unit(
            ProductionServiceRoleV2::EvidenceVerifier,
            "evidence",
            "/opt/hepta/hepta-evidence-verifier",
            1006,
        ),
        unit(
            ProductionServiceRoleV2::ReleaseBroker,
            "release",
            "/opt/hepta/hepta-release-broker",
            1007,
        ),
        unit(
            ProductionServiceRoleV2::SubmissionBroker,
            "submission",
            "/opt/hepta/hepta-submission-broker",
            1008,
        ),
        unit(
            ProductionServiceRoleV2::StateAuthority,
            "state-authority",
            "/opt/hepta/hepta-paper-state-authority-daemon",
            1009,
        ),
    ];
    services[0].supplementary_gids.push(9009);
    services[8].principal_gid = 9009;
    services[8].arguments = vec![
        "--configuration".into(),
        "/etc/hepta-native/state-authority/daemon.json".into(),
    ];
    services[8].writable_roots = [
        "/var/lib/hepta-native-authority",
        "/var/lib/hepta-native-authority-keys",
    ]
    .map(|path| ProductionWritableRootV1 {
        path: path.into(),
        owner_uid: 1009,
        owner_gid: 9009,
        mode: 0o700,
    })
    .to_vec();
    ProductionDeploymentManifestV2 {
        version: 2,
        repository: REQUIRED_REPOSITORY.into(),
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        service_manager_inventory_hash: digest(2),
        mount_topology_hash: digest(3),
        legacy_runtime_scan_hash: digest(4),
        legacy_node_runtime: LegacyNodeRuntimeDispositionV1::RemovedFromProduction,
        services,
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

#[test]
fn nine_role_structure_does_not_itself_construct_verified_deployment() {
    let value = manifest();
    validate_manifest_v2(&value).expect("structurally complete nine-role fixture");
    // No fixture executable or root is installed. Never claim this synthetic
    // structure is a root-owned production topology.
    assert!(verify_production_deployment_v2(&value).is_err());
}

#[test]
fn retained_reader_hashes_an_actual_root_owned_system_elf() {
    // Observe an installed system ELF without modifying it. Its basename does
    // not satisfy a Hepta role, and ELF bytes do not prove Rust build provenance.
    let path = fs::canonicalize("/usr/bin/true").expect("installed root-owned system ELF");
    let metadata = fs::symlink_metadata(&path).expect("actual system executable metadata");
    assert_eq!((metadata.uid(), metadata.gid()), (0, 0));
    assert!(matches!(metadata.mode() & 0o7777, 0o555 | 0o755));
    let bytes = fs::read(&path).expect("actual system executable bytes");
    assert!(bytes.starts_with(ELF_MAGIC));
    let mut service = unit(
        ProductionServiceRoleV2::EvidenceVerifier,
        "system-elf-reader-fixture",
        path.to_str().expect("system executable path"),
        1006,
    );
    service.executable_mode = metadata.mode() & 0o7777;
    service.executable_hash = raw_digest(&bytes);
    let observed = RetainedExecutableV2::capture(&service).expect("actual retained ELF reader");
    assert_eq!(observed.hash, raw_digest(&bytes));
    assert_eq!(observed.metadata.dev(), metadata.dev());
    assert_eq!(observed.metadata.ino(), metadata.ino());
    assert!(!observed.ancestors.directories.is_empty());
    for (ancestor, retained) in &observed.ancestors.directories {
        assert_eq!(retained.uid(), 0);
        assert!(directory_same(
            retained,
            &fs::symlink_metadata(ancestor).expect("ancestor")
        ));
    }
    observed
        .assert_current()
        .expect("actual retained descriptor and ancestors remain current");
    service.executable_mode = if service.executable_mode == 0o755 {
        0o555
    } else {
        0o755
    };
    assert!(
        RetainedExecutableV2::capture(&service).is_err(),
        "wrong declared mode is rejected"
    );
}

#[test]
fn manifest_versions_and_role_vocabularies_are_closed() {
    let value = manifest();
    let encoded = serde_json::to_value(&value).expect("manifest JSON");
    assert!(serde_json::from_value::<ProductionDeploymentManifestV1>(encoded.clone()).is_err());
    for (field, replacement) in [("version", json!(1)), ("version", json!(3))] {
        let mut changed = encoded.clone();
        changed[field] = replacement;
        let parsed: ProductionDeploymentManifestV2 =
            serde_json::from_value(changed).expect("version remains typed");
        assert!(validate_manifest_v2(&parsed).is_err());
    }
    let mut extra = encoded.clone();
    extra["unreviewedInstallation"] = json!(true);
    assert!(serde_json::from_value::<ProductionDeploymentManifestV2>(extra).is_err());
    let mut client_role = encoded.clone();
    client_role["services"][8]["role"] = json!("state_authority_client");
    assert!(serde_json::from_value::<ProductionDeploymentManifestV2>(client_role).is_err());

    let mut legacy = encoded;
    legacy["version"] = json!(1);
    legacy
        .as_object_mut()
        .expect("manifest")
        .remove("authority");
    legacy["services"].as_array_mut().expect("services").pop();
    for service in legacy["services"].as_array_mut().expect("services") {
        service
            .as_object_mut()
            .expect("service")
            .remove("supplementaryGids");
        service
            .as_object_mut()
            .expect("service")
            .remove("systemdUnit");
    }
    let parsed: ProductionDeploymentManifestV1 =
        serde_json::from_value(legacy.clone()).expect("old eight-role vocabulary");
    super::super::validate_manifest(&parsed).expect("V1 remains independently valid");
    assert_eq!(
        super::super::production_deployment_identity_hash_v1(&parsed)
            .expect("unchanged V1 identity encoding")
            .as_str(),
        "sha256:9d7303a790133dab080503a0d431c52a192ad8211e1250252db6c7f47819ef19"
    );
    assert!(serde_json::from_value::<ProductionDeploymentManifestV2>(legacy).is_err());
}

#[test]
fn exactly_one_control_and_actual_daemon_are_required() {
    for index in [0, 8] {
        let mut missing = manifest();
        missing.services.remove(index);
        assert!(validate_manifest_v2(&missing).is_err());
        let mut duplicate = manifest();
        let mut replica = duplicate.services[index].clone();
        replica.service_id.push_str("-replica");
        replica.systemd_unit = format!("{}-replica.service", replica.service_id);
        duplicate.services.push(replica);
        assert!(validate_manifest_v2(&duplicate).is_err());
    }
    for executable in [
        "/usr/bin/node",
        "/bin/bash",
        "/opt/hepta/start.mjs",
        "/opt/hepta/hepta-paper-state-authority-client",
    ] {
        let mut value = manifest();
        value.services[8].executable_path = executable.into();
        assert!(validate_manifest_v2(&value).is_err(), "{executable}");
    }
    for arguments in [
        vec![],
        vec!["serve".into()],
        vec!["--configuration=/etc/hepta-native/state-authority/daemon.json".into()],
        vec![
            "--configuration".into(),
            "/etc/hepta-native/wrong.json".into(),
        ],
        vec![
            "--configuration".into(),
            "/etc/hepta-native/state-authority/daemon.json".into(),
            "--help".into(),
        ],
    ] {
        let mut value = manifest();
        value.services[8].arguments = arguments;
        assert!(validate_manifest_v2(&value).is_err());
    }
    let mut value = manifest();
    value.services[8].network_declared = true;
    assert!(validate_manifest_v2(&value).is_err());
    value.services[8].network_declared = false;
    value.services[8].environment_keys.push("LANG".into());
    assert!(validate_manifest_v2(&value).is_err());
}

#[test]
fn uid_isolation_and_exclusive_ipc_group_are_enforced() {
    let supplementary = manifest();
    validate_manifest_v2(&supplementary).expect("control supplementary IPC membership");
    let mut primary = manifest();
    primary.services[0].principal_gid = primary.authority.ipc_root.owner_gid;
    primary.services[0].supplementary_gids.clear();
    validate_manifest_v2(&primary).expect("control primary IPC membership");

    let mut shared_uid = manifest();
    shared_uid.services[8].principal_uid = shared_uid.services[0].principal_uid;
    for root in &mut shared_uid.services[8].writable_roots {
        root.owner_uid = 1001;
    }
    shared_uid.authority.ipc_root.owner_uid = 1001;
    // Different GIDs do not turn one UID into independent role custody.
    assert_ne!(
        shared_uid.services[8].principal_gid,
        shared_uid.services[0].principal_gid
    );
    assert!(validate_manifest_v2(&shared_uid).is_err());

    let mut no_control_access = manifest();
    no_control_access.services[0].supplementary_gids.clear();
    assert!(validate_manifest_v2(&no_control_access).is_err());
    for index in 1..8 {
        let mut extra_access = manifest();
        extra_access.services[index].supplementary_gids.push(9009);
        assert!(validate_manifest_v2(&extra_access).is_err());
        extra_access.services[index].supplementary_gids.clear();
        extra_access.services[index].principal_gid = 9009;
        assert!(validate_manifest_v2(&extra_access).is_err());
    }
    for gids in [
        vec![0],
        vec![9009, 9009],
        vec![1001, 9009],
        (1..=33).collect(),
    ] {
        let mut value = manifest();
        value.services[0].supplementary_gids = gids;
        assert!(validate_manifest_v2(&value).is_err());
    }
    let mut wrong_daemon_gid = manifest();
    wrong_daemon_gid.services[8].principal_gid = 1009;
    assert!(validate_manifest_v2(&wrong_daemon_gid).is_err());
}

#[test]
fn root_owned_ancestor_access_uses_declared_service_groups() {
    let ipc = [9009].into_iter().collect::<BTreeSet<_>>();
    for mode in [0o755, 0o555] {
        assert!(directory_accessible_v2(mode, 0, &ipc));
    }
    for mode in [0o750, 0o550] {
        assert!(directory_accessible_v2(mode, 9009, &ipc));
        assert!(!directory_accessible_v2(mode, 0, &ipc));
        assert!(!directory_accessible_v2(mode, 1002, &ipc));
    }
    for mode in [0o700, 0o710, 0o740] {
        assert!(!directory_accessible_v2(mode, 9009, &ipc));
    }
    let service_groups = [1002, 9009].into_iter().collect::<BTreeSet<_>>();
    assert!(directory_accessible_v2(0o750, 1002, &service_groups));
    assert!(directory_accessible_v2(0o750, 9009, &service_groups));
}

#[test]
fn installation_paths_bind_private_roots_and_separate_shared_ipc() {
    let mut value = manifest();
    value.authority.service_id = "control".into();
    assert!(validate_manifest_v2(&value).is_err());
    value = manifest();
    value.authority.systemd_unit = "other.service".into();
    assert!(validate_manifest_v2(&value).is_err());
    value = manifest();
    value.services[1].systemd_unit = value.services[0].systemd_unit.clone();
    assert!(validate_manifest_v2(&value).is_err());
    for unit_name in [
        "",
        "../../escape.service",
        "service.socket",
        "service@.service",
    ] {
        value = manifest();
        value.services[1].systemd_unit = unit_name.into();
        assert!(validate_manifest_v2(&value).is_err(), "{unit_name}");
    }
    for mode in [0o700, 0o755, 0o770, 0o2750] {
        value = manifest();
        value.authority.ipc_root.mode = mode;
        assert!(validate_manifest_v2(&value).is_err(), "IPC mode {mode:o}");
    }
    value = manifest();
    value.authority.private_key_root = "/var/lib/undeclared-authority-key".into();
    assert!(validate_manifest_v2(&value).is_err());
    value = manifest();
    value.services[8].writable_roots[0].mode = 0o750;
    assert!(validate_manifest_v2(&value).is_err());
    value = manifest();
    value.authority.ipc_root.path = value.authority.private_state_root.join("ipc");
    assert!(validate_manifest_v2(&value).is_err());
    value = manifest();
    value.authority.private_state_root = value.authority.ipc_root.path.join("state");
    assert!(validate_manifest_v2(&value).is_err());
    for root in [
        manifest().authority.private_state_root,
        manifest().authority.private_key_root,
        manifest().authority.ipc_root.path,
    ] {
        value = manifest();
        value.authority.online_configuration.path = root.join("online.json");
        assert!(validate_manifest_v2(&value).is_err());
    }
    for path in [
        "relative",
        "/etc//daemon.json",
        "/etc/../daemon.json",
        "/etc/./daemon.json",
    ] {
        value = manifest();
        value.authority.daemon_configuration.path = path.into();
        value.services[8].arguments[1] = path.into();
        assert!(validate_manifest_v2(&value).is_err(), "{path}");
    }

    let mut shared_private_root = manifest();
    shared_private_root.authority.private_key_root =
        shared_private_root.authority.private_state_root.clone();
    shared_private_root.services[8].writable_roots.pop();
    validate_manifest_v2(&shared_private_root)
        .expect("key and authority state may share one daemon-private root");
}

struct PublicFixture {
    root: PathBuf,
    installation: ProductionAuthorityInstallationV2,
    daemon: Value,
    online: Value,
    backup: Value,
    online_public: Value,
    backup_public: Value,
}

fn write_public(path: &Path, value: &Value) -> Sha256Digest {
    let bytes = serde_json::to_vec(value).expect("public JSON bytes");
    fs::write(path, &bytes).expect("write public fixture");
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).expect("private test file");
    raw_digest(&bytes)
}

impl PublicFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-deployment-v2-public-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&root).expect("public-input test directory");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .expect("private same-UID fixture boundary");
        let public_pem = SigningKey::from_bytes(&[79; 32])
            .verifying_key()
            .to_public_key_pem(Default::default())
            .expect("actual Ed25519 public key");
        let online_public = json!({
            "version":1, "kind":"AutonomousResearchOnlineMutationAuthorityPublicKey",
            "authorityId":"authority:deployment", "keyId":"key:deployment",
            "algorithm":"ed25519", "publicKeyPem":public_pem
        });
        let mut backup_public = online_public.clone();
        backup_public["kind"] = json!("AutonomousResearchStateBackupAuthorityPublicKey");
        let state = root.join("never-created-state");
        let keys = root.join("never-created-private-keys");
        let ipc = root.join("never-created-ipc");
        let daemon = json!({
            "version":1, "kind":"HeptaLocalAutonomousResearchStateAuthorityConfiguration",
            "authorityId":"authority:deployment", "keyId":"key:deployment",
            "scopeId":"scope:deployment", "databaseScopeHash":digest(30),
            "writerManifestHash":digest(31), "privateKeyPath":keys.join("never-written.pem"),
            "stateDatabasePath":state.join("never-created.sqlite"),
            "socketPath":ipc.join("authority.sock"),
            "maximumReservationLeaseMs":60000, "maximumObservationAgeMs":30000
        });
        let online = json!({
            "version":1, "kind":"AutonomousResearchOnlineMutationAuthorityConfiguration",
            "authorityId":daemon["authorityId"], "keyId":daemon["keyId"],
            "scopeId":daemon["scopeId"], "databaseScopeHash":daemon["databaseScopeHash"],
            "writerManifestHash":daemon["writerManifestHash"],
            "publicKeyPath":root.join("online-public.json"), "publicKeySha256":digest(1),
            "maximumReservationLeaseMs":60000, "maximumObservationAgeMs":30000
        });
        let backup = json!({
            "version":1, "kind":"AutonomousResearchStateBackupAuthoritySocketConfiguration",
            "authorityId":daemon["authorityId"], "keyId":daemon["keyId"],
            "socketPath":daemon["socketPath"], "timeoutMs":5000, "maximumMessageBytes":65536,
            "publicKeyPath":root.join("backup-public.json"), "publicKeySha256":digest(1),
            "maximumReservationLeaseMs":60000, "maximumHeadObservationAgeMs":30000,
            "onlineMutationAuthorityConfigurationPath":root.join("online.json"),
            "onlineMutationAuthorityConfigurationSha256":digest(1)
        });
        let installation = ProductionAuthorityInstallationV2 {
            service_id: "state-authority".into(),
            systemd_unit: "hepta-paper-state-authority.service".into(),
            daemon_configuration: ProductionPublicFileV2 {
                path: root.join("daemon.json"),
                sha256: digest(1),
            },
            online_configuration: ProductionPublicFileV2 {
                path: root.join("online.json"),
                sha256: digest(1),
            },
            backup_socket_configuration: ProductionPublicFileV2 {
                path: root.join("backup.json"),
                sha256: digest(1),
            },
            private_state_root: state,
            private_key_root: keys,
            ipc_root: ProductionAuthorityIpcRootV2 {
                path: ipc,
                owner_uid: 1009,
                owner_gid: 9009,
                mode: 0o750,
            },
        };
        let mut fixture = Self {
            root,
            installation,
            daemon,
            online,
            backup,
            online_public,
            backup_public,
        };
        fixture.publish();
        fixture
    }

    fn publish(&mut self) {
        self.online["publicKeySha256"] = json!(write_public(
            &self.root.join("online-public.json"),
            &self.online_public
        ));
        self.backup["publicKeySha256"] = json!(write_public(
            &self.root.join("backup-public.json"),
            &self.backup_public
        ));
        self.installation.daemon_configuration.sha256 =
            write_public(&self.installation.daemon_configuration.path, &self.daemon);
        self.installation.online_configuration.sha256 =
            write_public(&self.installation.online_configuration.path, &self.online);
        self.backup["onlineMutationAuthorityConfigurationSha256"] =
            json!(self.installation.online_configuration.sha256);
        self.installation.backup_socket_configuration.sha256 = write_public(
            &self.installation.backup_socket_configuration.path,
            &self.backup,
        );
    }

    fn load(&self) -> Result<ObservedAuthorityPublicInputsV2, ProductionDeploymentError> {
        self.load_with_additional_forbidden_roots(&[])
    }

    fn load_with_additional_forbidden_roots(
        &self,
        additional: &[&Path],
    ) -> Result<ObservedAuthorityPublicInputsV2, ProductionDeploymentError> {
        // This real public-file loader accepts the test process's own UID.
        // It cannot construct a root-owned VerifiedProductionDeploymentV2.
        let mut forbidden = vec![
            self.installation.private_state_root.as_path(),
            self.installation.private_key_root.as_path(),
            self.installation.ipc_root.path.as_path(),
        ];
        forbidden.extend_from_slice(additional);
        ObservedAuthorityPublicInputsV2::load(&self.installation, &forbidden)
    }

    fn assert_no_secret_state_or_socket(&self) {
        assert!(!self.installation.private_key_root.exists());
        assert!(!self.installation.private_state_root.exists());
        assert!(!self.installation.ipc_root.path.exists());
        let mut names = fs::read_dir(&self.root)
            .expect("public fixture directory")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(
            names,
            [
                "backup-public.json",
                "backup.json",
                "daemon.json",
                "online-public.json",
                "online.json",
            ]
        );
    }

    fn manifest(&self) -> ProductionDeploymentManifestV2 {
        let mut value = manifest();
        value.authority = self.installation.clone();
        value.services[8].arguments[1] = self
            .installation
            .daemon_configuration
            .path
            .to_str()
            .expect("fixture path")
            .into();
        value.services[8].writable_roots = [
            self.installation.private_state_root.clone(),
            self.installation.private_key_root.clone(),
        ]
        .map(|path| ProductionWritableRootV1 {
            path,
            owner_uid: 1009,
            owner_gid: 9009,
            mode: 0o700,
        })
        .to_vec();
        value
    }
}

impl Drop for PublicFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn actual_public_input_binding_never_opens_private_key_database_or_socket() {
    let fixture = PublicFixture::new();
    fixture.assert_no_secret_state_or_socket();
    let observed = fixture.load().expect("actual public inputs agree");
    observed
        .assert_current()
        .expect("retained public inputs unchanged");
    assert_eq!(
        observed.binding()["kind"],
        "HeptaProductionAuthorityPublicBindingV2"
    );
    assert_eq!(
        observed.binding()["authorityId"],
        fixture.daemon["authorityId"]
    );
    assert_eq!(observed.binding()["scopeId"], fixture.daemon["scopeId"]);
    assert_eq!(
        observed.binding()["socketPath"],
        fixture.daemon["socketPath"]
    );
    assert_eq!(
        observed.binding()["publicKeySha256"],
        json!(raw_digest(
            SigningKey::from_bytes(&[79; 32]).verifying_key().as_bytes()
        ))
    );
    let paths = observed
        .files()
        .iter()
        .map(|file| file.path.clone())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        paths,
        [
            fixture.root.join("daemon.json"),
            fixture.root.join("online.json"),
            fixture.root.join("online-public.json"),
            fixture.root.join("backup.json"),
            fixture.root.join("backup-public.json"),
        ]
        .into_iter()
        .collect()
    );
    fixture.assert_no_secret_state_or_socket();
}

#[test]
fn actual_public_keys_and_all_shared_configuration_facts_must_agree() {
    for (field, replacement) in [
        ("authorityId", json!("authority:other")),
        ("keyId", json!("key:other")),
        ("scopeId", json!("scope:other")),
        ("databaseScopeHash", json!(digest(100))),
        ("writerManifestHash", json!(digest(101))),
        ("maximumReservationLeaseMs", json!(60001)),
        ("maximumObservationAgeMs", json!(30001)),
    ] {
        let mut fixture = PublicFixture::new();
        fixture.daemon[field] = replacement;
        fixture.publish();
        assert!(fixture.load().is_err(), "daemon field {field}");
        fixture.assert_no_secret_state_or_socket();
    }
    for (field, replacement) in [
        ("authorityId", json!("authority:other")),
        ("keyId", json!("key:other")),
        ("maximumReservationLeaseMs", json!(60001)),
        ("maximumHeadObservationAgeMs", json!(30001)),
        (
            "kind",
            json!("AutonomousResearchStateBackupAuthorityProcessConfiguration"),
        ),
        ("version", json!(2)),
    ] {
        let mut fixture = PublicFixture::new();
        fixture.backup[field] = replacement;
        fixture.publish();
        assert!(fixture.load().is_err(), "backup field {field}");
    }
    let mut different_key = PublicFixture::new();
    different_key.backup_public["publicKeyPem"] = json!(
        SigningKey::from_bytes(&[80; 32])
            .verifying_key()
            .to_public_key_pem(Default::default())
            .expect("different real Ed25519 key")
    );
    different_key.publish();
    assert!(
        different_key.load().is_err(),
        "matching IDs cannot hide different actual keys"
    );
}

#[test]
fn public_input_paths_and_raw_pins_are_bound_to_the_installation() {
    for field in ["privateKeyPath", "stateDatabasePath", "socketPath"] {
        let mut fixture = PublicFixture::new();
        fixture.daemon[field] = json!(fixture.root.join("outside-declared-root"));
        fixture.publish();
        assert!(fixture.load().is_err(), "{field}");
    }
    let mut fixture = PublicFixture::new();
    fixture.installation.private_key_root = fixture.installation.private_state_root.clone();
    fixture.daemon["privateKeyPath"] = fixture.daemon["stateDatabasePath"].clone();
    fixture.publish();
    assert!(fixture.load().is_err());
    for key_is_parent in [true, false] {
        let mut fixture = PublicFixture::new();
        fixture.installation.private_key_root = fixture.installation.private_state_root.clone();
        let parent = fixture
            .installation
            .private_state_root
            .join("must-be-one-file");
        let child = parent.join("cannot-be-a-file-child");
        let (key, state) = if key_is_parent {
            (parent, child)
        } else {
            (child, parent)
        };
        fixture.daemon["privateKeyPath"] = json!(key);
        fixture.daemon["stateDatabasePath"] = json!(state);
        fixture.publish();
        assert!(
            fixture.load().is_err(),
            "regular key and database files cannot be ancestors of each other"
        );
        fixture.assert_no_secret_state_or_socket();
    }
    let mut fixture = PublicFixture::new();
    fixture.backup["socketPath"] = json!(fixture.installation.ipc_root.path.join("other.sock"));
    fixture.publish();
    assert!(fixture.load().is_err());
    let mut fixture = PublicFixture::new();
    fixture.backup["onlineMutationAuthorityConfigurationPath"] =
        json!(fixture.root.join("different-online.json"));
    fixture.publish();
    assert!(fixture.load().is_err());
    for input in 0..3 {
        let mut fixture = PublicFixture::new();
        let pin = match input {
            0 => &mut fixture.installation.daemon_configuration.sha256,
            1 => &mut fixture.installation.online_configuration.sha256,
            _ => &mut fixture.installation.backup_socket_configuration.sha256,
        };
        *pin = digest(200);
        assert!(fixture.load().is_err());
    }
}

#[test]
fn configuration_paths_are_checked_before_any_configuration_is_opened() {
    for input in 0..3 {
        for noncanonical in [false, true] {
            let mut fixture = PublicFixture::new();
            // A failed initial Snapshot would return AuthorityInput. Removing
            // this file makes the installation error prove preflight ordering.
            fs::remove_file(&fixture.installation.daemon_configuration.path)
                .expect("remove initial configuration before preflight");
            let bad_path = if noncanonical {
                fixture.root.join("../must-not-be-opened.json")
            } else {
                fixture.installation.private_key_root.join("protected.json")
            };
            let path = match input {
                0 => &mut fixture.installation.daemon_configuration.path,
                1 => &mut fixture.installation.online_configuration.path,
                _ => &mut fixture.installation.backup_socket_configuration.path,
            };
            *path = bad_path;
            assert!(matches!(
                fixture.load(),
                Err(ProductionDeploymentError::AuthorityInstallationInvalid)
            ));
            assert!(!fixture.installation.private_key_root.exists());
            assert!(!fixture.installation.private_state_root.exists());
            assert!(!fixture.installation.ipc_root.path.exists());
        }
    }
}

#[test]
fn nested_public_references_refuse_private_state_keys_and_ipc_before_open() {
    for target in 0..3 {
        let mut fixture = PublicFixture::new();
        match target {
            0 => fixture.backup["publicKeyPath"] = fixture.daemon["privateKeyPath"].clone(),
            1 => fixture.online["publicKeyPath"] = fixture.daemon["stateDatabasePath"].clone(),
            _ => {
                fixture.backup["publicKeyPath"] =
                    json!(fixture.installation.ipc_root.path.join("public.json"));
            }
        }
        fixture.publish();
        // These targets do not exist: following one would produce an input
        // read error instead of the required installation-boundary refusal.
        assert!(matches!(
            fixture.load(),
            Err(ProductionDeploymentError::AuthorityInstallationInvalid)
        ));
        fixture.assert_no_secret_state_or_socket();
    }
}

#[test]
fn other_role_private_namespaces_refuse_even_genuine_pinned_public_documents() {
    for online in [false, true] {
        for target_exists in [false, true] {
            let mut fixture = PublicFixture::new();
            let other_role_root = fixture.root.join("other-role-private");
            let public_path = other_role_root.join("public.json");
            let public_document = if online {
                &fixture.online_public
            } else {
                &fixture.backup_public
            };
            let expected_bytes = serde_json::to_vec(public_document).expect("public bytes");
            if target_exists {
                fs::create_dir(&other_role_root).expect("actual other-role namespace fixture");
                fs::set_permissions(&other_role_root, fs::Permissions::from_mode(0o700))
                    .expect("private same-UID directory");
                write_public(&public_path, public_document);
            }
            if online {
                fixture.online["publicKeyPath"] = json!(public_path);
            } else {
                fixture.backup["publicKeyPath"] = json!(public_path);
            }
            fixture.publish();
            assert!(matches!(
                fixture.load_with_additional_forbidden_roots(&[other_role_root.as_path()]),
                Err(ProductionDeploymentError::AuthorityInstallationInvalid)
            ));
            if target_exists {
                assert_eq!(
                    fs::read(&public_path).expect("unchanged public fixture"),
                    expected_bytes
                );
            } else {
                assert!(!other_role_root.exists());
            }
            assert!(!fixture.installation.private_key_root.exists());
            assert!(!fixture.installation.private_state_root.exists());
            assert!(!fixture.installation.ipc_root.path.exists());
        }
    }
}

#[test]
fn nested_online_configuration_must_match_installation_before_following_it() {
    for mismatch_pin in [false, true] {
        let mut fixture = PublicFixture::new();
        if mismatch_pin {
            fixture.backup["onlineMutationAuthorityConfigurationSha256"] = json!(digest(222));
        } else {
            fixture.backup["onlineMutationAuthorityConfigurationPath"] =
                fixture.daemon["privateKeyPath"].clone();
        }
        fixture.installation.backup_socket_configuration.sha256 = write_public(
            &fixture.installation.backup_socket_configuration.path,
            &fixture.backup,
        );
        // Neither the manifest's online document nor the substituted private
        // path can be opened successfully, even though the backup raw pin is real.
        fs::remove_file(&fixture.installation.online_configuration.path)
            .expect("remove online document before nested binding preflight");
        assert!(matches!(
            fixture.load(),
            Err(ProductionDeploymentError::AuthorityInstallationInvalid)
        ));
        assert!(!fixture.installation.private_key_root.exists());
        assert!(!fixture.installation.private_state_root.exists());
        assert!(!fixture.installation.ipc_root.path.exists());
    }
}

#[test]
fn actual_directory_identity_cannot_be_counted_twice() {
    let fixture = PublicFixture::new();
    let first = fixture.root.join("first-directory");
    let second = fixture.root.join("second-directory");
    fs::create_dir(&first).expect("first actual directory");
    fs::create_dir(&second).expect("second actual directory");
    let mut seen = BTreeSet::new();
    record_directory_identity_v2(&mut seen, &fs::metadata(&first).expect("first metadata"))
        .expect("first observed directory");
    record_directory_identity_v2(&mut seen, &fs::metadata(&second).expect("second metadata"))
        .expect("distinct actual directory");
    assert!(matches!(
        record_directory_identity_v2(&mut seen, &fs::metadata(&first).expect("same metadata")),
        Err(ProductionDeploymentError::NamespaceInvalid)
    ));
    assert_eq!(seen.len(), 2);
    // This tests real dev/ino observations, not a bind mount or a full deployment.
}

#[test]
fn socket_name_is_configuration_bound_and_must_be_one_direct_ipc_child() {
    let mut fixture = PublicFixture::new();
    let endpoint = fixture
        .installation
        .ipc_root
        .path
        .join("qualified-control.sock");
    fixture.daemon["socketPath"] = json!(endpoint);
    fixture.backup["socketPath"] = fixture.daemon["socketPath"].clone();
    fixture.publish();
    let observed = fixture
        .load()
        .expect("a bound direct IPC child need not use a fixed basename");
    assert_eq!(
        observed.binding()["socketPath"],
        fixture.daemon["socketPath"]
    );
    fixture.assert_no_secret_state_or_socket();
    drop(observed);

    for endpoint in [
        fixture
            .installation
            .ipc_root
            .path
            .join("nested/authority.sock"),
        fixture.root.join("different-ipc/authority.sock"),
        fixture.installation.ipc_root.path.join("x".repeat(108)),
    ] {
        fixture.daemon["socketPath"] = json!(endpoint);
        fixture.backup["socketPath"] = fixture.daemon["socketPath"].clone();
        fixture.publish();
        assert!(
            fixture.load().is_err(),
            "both profiles agree but the IPC parent is wrong"
        );
        fixture.assert_no_secret_state_or_socket();
    }
}

#[test]
fn public_file_names_permissions_links_and_retained_bytes_are_checked() {
    for name in [
        "daemon.json",
        "online.json",
        "online-public.json",
        "backup.json",
        "backup-public.json",
    ] {
        let fixture = PublicFixture::new();
        let observed = fixture.load().expect("valid preimage");
        fs::write(fixture.root.join(name), b"changed public bytes").expect("change public fixture");
        assert!(observed.assert_current().is_err(), "{name}");
    }
    for mutation in ["symlink", "hardlink", "group-write"] {
        let fixture = PublicFixture::new();
        let path = fixture.installation.daemon_configuration.path.clone();
        match mutation {
            "symlink" => {
                let destination = fixture.root.join("renamed-daemon.json");
                fs::rename(&path, &destination).expect("rename public fixture");
                symlink(&destination, &path).expect("fixture symlink");
            }
            "hardlink" => fs::hard_link(&path, fixture.root.join("daemon-alias.json"))
                .expect("fixture hardlink"),
            _ => fs::set_permissions(&path, fs::Permissions::from_mode(0o620))
                .expect("fixture unsafe write permission"),
        }
        assert!(fixture.load().is_err(), "{mutation}");
    }
    let mut duplicate = PublicFixture::new();
    let original = serde_json::to_string(&duplicate.daemon).expect("daemon JSON");
    let bytes = format!(
        "{},\"version\":1}}",
        original.strip_suffix('}').expect("object")
    )
    .into_bytes();
    fs::write(&duplicate.installation.daemon_configuration.path, &bytes)
        .expect("duplicate-key public fixture");
    duplicate.installation.daemon_configuration.sha256 = raw_digest(&bytes);
    assert!(
        duplicate.load().is_err(),
        "correct raw pin cannot admit duplicate JSON keys"
    );
}

#[test]
fn v2_identity_changes_with_topology_and_actual_public_input_binding() {
    let mut fixture = PublicFixture::new();
    let observed = fixture.load().expect("actual public binding");
    let value = fixture.manifest();
    validate_manifest_v2(&value).expect("structural fixture");
    let baseline = deployment_identity_hash_v2(&value, &observed).expect("V2 digest");
    for input in 0..6 {
        let mut changed = value.clone();
        match input {
            0 => changed.service_manager_inventory_hash = digest(240),
            1 => changed.mount_topology_hash = digest(241),
            2 => changed.legacy_runtime_scan_hash = digest(242),
            3 => changed.services[8].executable_hash = digest(243),
            4 => changed.authority.ipc_root.path = fixture.root.join("another-ipc"),
            _ => changed.authority.daemon_configuration.sha256 = digest(244),
        }
        let changed_hash = deployment_identity_hash_v2(&changed, &observed);
        assert!(
            changed_hash.is_err() || changed_hash.expect("changed digest") != baseline,
            "identity input {input} was ignored"
        );
    }
    let old_binding = observed.binding().clone();
    drop(observed);
    fixture.daemon["maximumObservationAgeMs"] = json!(30001);
    fixture.online["maximumObservationAgeMs"] = json!(30001);
    fixture.backup["maximumHeadObservationAgeMs"] = json!(30001);
    fixture.publish();
    let changed_inputs = fixture
        .load()
        .expect("coherently changed real public binding");
    assert_ne!(&old_binding, changed_inputs.binding());
    assert_ne!(
        deployment_identity_hash_v2(&fixture.manifest(), &changed_inputs)
            .expect("coherently changed identity"),
        baseline
    );
}

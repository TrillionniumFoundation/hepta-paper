use super::*;
use crate::state_database_inventory::observe_state_database_inventory_v1;
use rusqlite::{Connection, ErrorCode};
use serde_json::Value;
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

static NEXT: AtomicU64 = AtomicU64::new(0);
const LOCK_PROBE: &str = "online_mutation_composition::activation::native_process::transaction::tests::separate_process_deployment_lock_probe";
const PROCESS_PROBE: &str = "online_mutation_composition::activation::native_process::transaction::tests::retained_actual_process_probe";

struct Fixture {
    root: PathBuf,
    services: Vec<ProductionServiceUnitV1>,
}
fn digest(path: &Path) -> Sha256Digest {
    format!(
        "sha256:{}",
        hex::encode(Sha256::digest(fs::read(path).unwrap()))
    )
    .parse()
    .unwrap()
}
fn private_directory(path: &Path) {
    fs::create_dir_all(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
impl Fixture {
    fn new() -> Self {
        assert_ne!(
            nix::unistd::geteuid().as_raw(),
            0,
            "run as the actual unprivileged service test user"
        );
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        let root = home.join(format!(
            ".hepta-deployment-retention-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        private_directory(&root);
        private_directory(&root.join("bin"));
        private_directory(&root.join("state"));
        let mut services = Vec::new();
        for (index, role) in ProductionServiceRoleV1::ALL.into_iter().enumerate() {
            let name = match role {
                ProductionServiceRoleV1::ControlPlane => "hepta-paper-rust",
                ProductionServiceRoleV1::CodexAuthorBroker
                | ProductionServiceRoleV1::CodexReviewerBroker
                | ProductionServiceRoleV1::CodexFormalBroker
                | ProductionServiceRoleV1::CodexRepairBroker => "hepta-codex-broker",
                ProductionServiceRoleV1::EvidenceVerifier => "hepta-evidence-verifier",
                ProductionServiceRoleV1::ReleaseBroker => "hepta-release-broker",
                ProductionServiceRoleV1::SubmissionBroker => "hepta-submission-broker",
            };
            let path = root.join("bin").join(name);
            if !path.exists() {
                // Actual native ELF bytes, not an ELF-magic stub. This lower
                // fixture is deliberately user-owned and cannot mint production proof.
                fs::copy("/usr/bin/true", &path).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            }
            let writable = root.join("state").join(format!("service-{index}"));
            private_directory(&writable);
            services.push(ProductionServiceUnitV1 {
                service_id: format!("service-{index}"),
                role,
                principal_uid: nix::unistd::geteuid().as_raw(),
                principal_gid: nix::unistd::getegid().as_raw(),
                executable_hash: digest(&path),
                executable_path: path,
                executable_owner_uid: nix::unistd::geteuid().as_raw(),
                executable_owner_gid: nix::unistd::getegid().as_raw(),
                executable_mode: 0o755,
                arguments: vec![format!("role-{index}")],
                environment_keys: vec![],
                writable_roots: vec![ProductionWritableRootV1 {
                    path: writable,
                    owner_uid: nix::unistd::geteuid().as_raw(),
                    owner_gid: nix::unistd::getegid().as_raw(),
                    mode: 0o700,
                }],
                network_declared: false,
            });
        }
        Self { root, services }
    }
    fn create_inventory(
        &self,
        journal_mode: &str,
    ) -> (ObservedStateDatabaseInventoryV1, Value, PathBuf) {
        let root = self.root.join("runtime");
        private_directory(&root);
        let manifest: Value = serde_json::from_slice(
            &fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../paper-core/config/autonomous-research-state-databases.v1.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let mut native = None;
        for definition in manifest["databases"].as_array().unwrap() {
            let path = root.join(definition["relativePath"].as_str().unwrap());
            private_directory(path.parent().unwrap());
            let database = Connection::open(&path).unwrap();
            database.execute_batch("CREATE TABLE fixture_records(id TEXT PRIMARY KEY,value TEXT); INSERT INTO fixture_records VALUES('record','before'); PRAGMA user_version=7; PRAGMA application_id=24680;").unwrap();
            for object in definition["requiredSchemaObjects"].as_array().unwrap() {
                let (kind, name) = object.as_str().unwrap().split_once(':').unwrap();
                let sql = match kind {
                    "table" => format!("CREATE TABLE \"{name}\"(id TEXT PRIMARY KEY,value TEXT);"),
                    "index" => format!("CREATE INDEX \"{name}\" ON fixture_records(value);"),
                    "trigger" => format!(
                        "CREATE TRIGGER \"{name}\" BEFORE UPDATE ON fixture_records BEGIN SELECT 1; END;"
                    ),
                    "view" => {
                        format!("CREATE VIEW \"{name}\" AS SELECT id,value FROM fixture_records;")
                    }
                    _ => panic!("unknown schema kind"),
                };
                database.execute_batch(&sql).unwrap();
            }
            if definition["role"] == "native-store" {
                database
                    .execute_batch(&format!("PRAGMA journal_mode={journal_mode}"))
                    .unwrap();
                native = Some(path.clone());
            }
            database.close().unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        (
            observe_state_database_inventory_v1(&root, &manifest).unwrap(),
            manifest,
            native.unwrap(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn all_services_are_retained_and_only_matching_elf_declarations_can_share_a_file() {
    let fixture = Fixture::new();
    let files = RetainedDeploymentFiles::capture(&fixture.services).unwrap();
    assert_eq!(files.executables.len(), 5);
    assert_eq!(files.roots.len(), 8);
    files.assert_current().unwrap();
    for field in ["hash", "owner", "group", "mode"] {
        let mut changed = fixture.services.clone();
        match field {
            "hash" => {
                changed[2].executable_hash = format!("sha256:{}", "0".repeat(64)).parse().unwrap()
            }
            "owner" => changed[2].executable_owner_uid += 1,
            "group" => changed[2].executable_owner_gid += 1,
            "mode" => changed[2].executable_mode = 0o555,
            _ => unreachable!(),
        }
        assert!(
            RetainedDeploymentFiles::capture(&changed).is_err(),
            "{field}"
        );
    }
}

#[test]
fn every_noncontrol_elf_rejects_stale_bytes_names_links_and_permissions() {
    for mode in [
        "bytes",
        "missing",
        "replace",
        "symlink",
        "hardlink",
        "permissions",
    ] {
        let fixture = Fixture::new();
        let files = RetainedDeploymentFiles::capture(&fixture.services).unwrap();
        let path = &fixture.services[1].executable_path;
        match mode {
            "bytes" => {
                let file = OpenOptions::new().write(true).open(path).unwrap();
                file.write_at(b"changed", 64).unwrap();
            }
            "missing" => fs::remove_file(path).unwrap(),
            "replace" => {
                let replacement = path.with_extension("new");
                fs::copy(path, &replacement).unwrap();
                fs::rename(replacement, path).unwrap();
            }
            "symlink" => {
                fs::remove_file(path).unwrap();
                symlink("/usr/bin/true", path).unwrap();
            }
            "hardlink" => fs::hard_link(path, path.with_extension("link")).unwrap(),
            "permissions" => fs::set_permissions(path, fs::Permissions::from_mode(0o555)).unwrap(),
            _ => unreachable!(),
        }
        assert!(files.assert_current().is_err(), "{mode}");
        if mode != "replace" {
            assert!(
                RetainedDeploymentFiles::capture(&fixture.services).is_err(),
                "{mode}"
            );
        }
    }
}

#[test]
fn writable_roots_allow_children_but_reject_permissions_replacement_and_ancestor_changes() {
    for mode in [
        "chmod",
        "replace",
        "symlink",
        "ancestor-mode",
        "ancestor-replace",
    ] {
        let fixture = Fixture::new();
        let files = RetainedDeploymentFiles::capture(&fixture.services).unwrap();
        let root = &fixture.services[0].writable_roots[0].path;
        private_directory(&root.join("new-child"));
        fs::write(root.join("new-file"), "mutable business state").unwrap();
        files.assert_current().unwrap();
        fs::remove_dir(root.join("new-child")).unwrap();
        files.assert_current().unwrap();
        match mode {
            "chmod" => fs::set_permissions(root, fs::Permissions::from_mode(0o755)).unwrap(),
            "replace" => {
                fs::rename(root, root.with_extension("old")).unwrap();
                private_directory(root);
            }
            "symlink" => {
                fs::rename(root, root.with_extension("old")).unwrap();
                symlink(root.with_extension("old"), root).unwrap();
            }
            "ancestor-mode" => fs::set_permissions(
                fixture.root.join("state"),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap(),
            "ancestor-replace" => {
                fs::rename(fixture.root.join("state"), fixture.root.join("old-state")).unwrap();
                private_directory(&fixture.root.join("state"));
                for service in &fixture.services {
                    private_directory(&service.writable_roots[0].path);
                }
            }
            _ => unreachable!(),
        }
        assert!(files.assert_current().is_err(), "{mode}");
    }
}

fn probe(path: &Path) {
    let output = Command::new("/proc/self/exe")
        .args(["--exact", LOCK_PROBE, "--nocapture"])
        .env("HEPTA_DEPLOYMENT_RETAINED_SQLITE_PATH", path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("retained deployment actual process lock remains busy")
    );
}
#[test]
fn separate_process_deployment_lock_probe() {
    let Some(path) = std::env::var_os("HEPTA_DEPLOYMENT_RETAINED_SQLITE_PATH") else {
        return;
    };
    let db = Connection::open(path).unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    assert_eq!(
        db.execute_batch("BEGIN IMMEDIATE")
            .unwrap_err()
            .sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy)
    );
    println!("retained deployment actual process lock remains busy");
}

#[test]
fn genuine_inventory_origin_and_elf_hardlink_rejection_keep_delete_and_wal_locks() {
    for mode in ["DELETE", "WAL"] {
        let fixture = Fixture::new();
        let (inventory, manifest, path) = fixture.create_inventory(mode);
        let other =
            observe_state_database_inventory_v1(inventory.runtime_root(), &manifest).unwrap();
        assert_eq!(inventory.value(), other.value());
        let binding = InventoryOrigin::capture(&inventory).unwrap();
        let guard = inventory.native_store_transaction_guard_v1().unwrap();
        let other_guard = other.native_store_transaction_guard_v1().unwrap();
        let files = RetainedDeploymentFiles::capture(&fixture.services).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("BEGIN IMMEDIATE; UPDATE fixture_records SET value='staged'")
            .unwrap();
        binding.assert_current(&guard).unwrap();
        assert!(binding.assert_current(&other_guard).is_err());
        files.assert_current().unwrap();
        probe(&path);
        let source = &fixture.services[1].executable_path;
        fs::remove_file(source).unwrap();
        fs::hard_link(&path, source).unwrap();
        assert!(files.assert_current().is_err());
        probe(&path);
        db.execute_batch("ROLLBACK").unwrap();
        assert_eq!(
            db.query_row("SELECT value FROM fixture_records", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "before"
        );
        db.close().unwrap();
        // All retained file inventories/scopes outlive the SQLite connection.
        drop(files);
        drop(other_guard);
        drop(guard);
    }
}

fn process_arguments() -> Vec<String> {
    vec!["--exact".into(), PROCESS_PROBE.into(), "--nocapture".into()]
}
#[test]
fn retained_actual_process_probe() {
    let Ok(mode) = std::env::var("HEPTA_RETAINED_NATIVE_PROCESS_MODE") else {
        return;
    };
    let path = std::env::current_exe().unwrap();
    let metadata = fs::metadata(&path).unwrap();
    let unit = ProductionServiceUnitV1 {
        service_id: "actual-native-process-retained-probe".into(),
        role: ProductionServiceRoleV1::ControlPlane,
        principal_uid: nix::unistd::geteuid().as_raw(),
        principal_gid: nix::unistd::getegid().as_raw(),
        executable_hash: digest(&path),
        executable_path: path.clone(),
        executable_owner_uid: metadata.uid(),
        executable_owner_gid: metadata.gid(),
        executable_mode: 0o755,
        arguments: process_arguments(),
        environment_keys: vec![],
        writable_roots: vec![],
        network_declared: false,
    };
    let mut process = ProcessObservation::observe(&unit).unwrap();
    let arguments = RetainedArguments::capture(&process).unwrap();
    assert_eq!(arguments.file.metadata().unwrap().len(), 0);
    arguments.assert_current(&process).unwrap();
    let db_path = path.parent().unwrap().join("probe.sqlite");
    let db = Connection::open(&db_path).unwrap();
    db.execute_batch("CREATE TABLE records(value TEXT); INSERT INTO records VALUES('before'); BEGIN IMMEDIATE; UPDATE records SET value='staged'").unwrap();
    arguments.assert_current(&process).unwrap();
    match mode.as_str() {
        "arguments" => {
            process.unit.arguments.push("not-the-kernel-argv".into());
            assert_eq!(
                arguments.assert_current(&process).unwrap_err().code,
                "autonomous_research_online_native_process_arguments_changed"
            );
        }
        "executable" => {
            fs::rename(&path, path.with_extension("held-original")).unwrap();
            fs::hard_link(&db_path, &path).unwrap();
            assert!(arguments.assert_current(&process).is_err());
        }
        _ => panic!("unexpected probe mode"),
    }
    probe(&db_path);
    db.execute_batch("ROLLBACK").unwrap();
    db.close().unwrap();
    drop(arguments);
    drop(process);
}

#[test]
fn retained_real_process_argv_and_executable_rejection_preserve_sqlite_lock() {
    for mode in ["arguments", "executable"] {
        let fixture = Fixture::new();
        let path = fixture.root.join("bin/hepta-paper-rust");
        // /proc/self/exe continues to identify the actual running image even if
        // another Cargo build has unlinked its former target/debug pathname.
        fs::copy("/proc/self/exe", &path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        let _ = Command::new("strip")
            .arg("--strip-debug")
            .arg(&path)
            .output();
        let output = Command::new(&path)
            .args(process_arguments())
            .env("HEPTA_RETAINED_NATIVE_PROCESS_MODE", mode)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{mode}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

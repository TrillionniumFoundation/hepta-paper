use super::*;
use crate::{LegacyNodeRuntimeDispositionV1, native_implementation_hash_v1};
use std::{
    os::unix::fs::PermissionsExt,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const PROBE: &str =
    "online_mutation_composition::activation::native_process::tests::real_current_process_probe";
const MODE_ENV: &str = "HEPTA_NATIVE_PROCESS_TEST_MODE";

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        // This primitive fixture needs non-writable ancestry, unlike /tmp and
        // the shared checkout. It does not claim root-owned production evidence.
        let home = PathBuf::from(std::env::var_os("HOME").expect("test home"));
        let root = home.join(format!(
            ".hepta-native-process-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn copy(&self, source: &Path, relative: &str) -> PathBuf {
        let target = self.0.join(relative);
        fs::copy(source, &target).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
        target
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn digest(path: &Path) -> Sha256Digest {
    format!(
        "sha256:{}",
        hex::encode(Sha256::digest(fs::read(path).unwrap()))
    )
    .parse()
    .unwrap()
}
fn arguments() -> Vec<String> {
    vec!["--exact".into(), PROBE.into(), "--nocapture".into()]
}
fn current_unit() -> ProductionServiceUnitV1 {
    let path = std::env::current_exe().unwrap();
    let metadata = fs::metadata(&path).unwrap();
    ProductionServiceUnitV1 {
        service_id: "native-control-process-observation-test".into(),
        role: ProductionServiceRoleV1::ControlPlane,
        principal_uid: nix::unistd::geteuid().as_raw(),
        principal_gid: nix::unistd::getegid().as_raw(),
        executable_hash: digest(&path),
        executable_path: path,
        executable_owner_uid: metadata.uid(),
        executable_owner_gid: metadata.gid(),
        executable_mode: metadata.mode() & 0o7777,
        arguments: arguments(),
        environment_keys: vec![],
        writable_roots: vec![],
        network_declared: false,
    }
}

#[test]
fn real_current_process_probe() {
    let Ok(mode) = std::env::var(MODE_ENV) else {
        return;
    };
    let unit = current_unit();
    let observed = ProcessObservation::observe(&unit).unwrap();
    observed.assert_current().unwrap();
    match mode.as_str() {
        "stable" => {
            let mut wrong = unit.clone();
            wrong.principal_uid += 1;
            assert_eq!(
                ProcessObservation::observe(&wrong).err().unwrap().code,
                "autonomous_research_online_native_process_principal_invalid"
            );
            wrong = unit.clone();
            wrong.principal_gid += 1;
            assert_eq!(
                ProcessObservation::observe(&wrong).err().unwrap().code,
                "autonomous_research_online_native_process_principal_invalid"
            );
            wrong = unit.clone();
            wrong
                .arguments
                .push("sensitive-value-must-not-appear".into());
            let failure = ProcessObservation::observe(&wrong).err().unwrap();
            assert_eq!(
                failure.code,
                "autonomous_research_online_native_process_arguments_changed"
            );
            assert!(!format!("{failure:?}").contains("sensitive-value-must-not-appear"));
            let other = unit.executable_path.with_file_name("other-native-elf");
            fs::copy(&unit.executable_path, &other).unwrap();
            wrong = unit.clone();
            wrong.executable_path = other;
            assert_eq!(
                ProcessObservation::observe(&wrong).err().unwrap().code,
                "autonomous_research_online_native_process_current_executable_changed"
            );
            observed.assert_current().unwrap();
        }
        "replace-executable" => {
            let replacement = unit.executable_path.with_file_name("replacement");
            fs::copy(&unit.executable_path, &replacement).unwrap();
            assert_eq!(digest(&replacement), unit.executable_hash);
            fs::rename(replacement, &unit.executable_path).unwrap();
            assert!(observed.assert_current().is_err());
            assert!(ProcessObservation::observe(&unit).is_err());
        }
        "replace-directory" => {
            let directory = unit.executable_path.parent().unwrap();
            let displaced = directory.with_file_name("displaced");
            fs::rename(directory, &displaced).unwrap();
            fs::create_dir(directory).unwrap();
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
            fs::copy(displaced.join("hepta-paper-rust"), &unit.executable_path).unwrap();
            assert_eq!(digest(&unit.executable_path), unit.executable_hash);
            assert!(observed.assert_current().is_err());
        }
        "unsafe-directory" => {
            fs::set_permissions(
                unit.executable_path.parent().unwrap(),
                fs::Permissions::from_mode(0o777),
            )
            .unwrap();
            assert!(observed.assert_current().is_err());
            assert!(ProcessObservation::observe(&unit).is_err());
        }
        _ => panic!("unknown test mode"),
    }
}

#[test]
fn actual_current_native_process_and_replacement_checks() {
    assert_ne!(
        nix::unistd::geteuid().as_raw(),
        0,
        "run native process tests as the service principal"
    );
    let fixture = Fixture::new();
    for mode in [
        "stable",
        "replace-executable",
        "replace-directory",
        "unsafe-directory",
    ] {
        let parent = fixture.0.join(mode);
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        let bin = parent.join("bin");
        fs::create_dir(&bin).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
        let executable = bin.join("hepta-paper-rust");
        fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        // Debug sections are not exercised by this current-process check. If
        // the ordinary toolchain utility is present, reduce repeated hashing;
        // otherwise the unchanged native ELF still runs the identical checks.
        let _ = Command::new("strip")
            .arg("--strip-debug")
            .arg(&executable)
            .output();
        let result = Command::new(executable)
            .args(arguments())
            .env(MODE_ENV, mode)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "native process mode {mode} failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

#[test]
fn executable_rejects_symlink_hardlink_content_change_and_unsafe_ancestry() {
    let fixture = Fixture::new();
    let path = fixture.copy(&std::env::current_exe().unwrap(), "native-probe");
    let mut unit = current_unit();
    unit.executable_path = path.clone();
    unit.executable_mode = 0o755;
    let executable = Executable::open(&unit).unwrap();
    let alias = fixture.0.join("alias");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    let mut wrong = unit.clone();
    wrong.executable_path = alias.clone();
    assert!(Executable::open(&wrong).is_err());
    fs::remove_file(&alias).unwrap();
    fs::hard_link(&path, &alias).unwrap();
    assert!(Executable::open(&unit).is_err());
    assert!(executable.assert_current().is_err());
    fs::remove_file(&alias).unwrap();
    let executable = Executable::open(&unit).unwrap();
    OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .write_at(b"changed!", 64)
        .unwrap();
    assert!(executable.assert_current().is_err());
    assert!(Executable::open(&unit).is_err());
}

#[test]
fn user_owned_current_binary_cannot_mint_verified_production_deployment() {
    let fixture = Fixture::new();
    let source = std::env::current_exe().unwrap();
    let source_hash = digest(&source);
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
        let path = fixture.0.join(name);
        if !path.exists() {
            fixture.copy(&source, name);
        }
        let codex = name == "hepta-codex-broker";
        services.push(ProductionServiceUnitV1 {
            service_id: format!("service-{index}"),
            role,
            principal_uid: 10_000 + index as u32,
            principal_gid: 10_000 + index as u32,
            executable_hash: source_hash.clone(),
            executable_path: path,
            executable_owner_uid: 0,
            executable_owner_gid: 0,
            executable_mode: 0o755,
            arguments: vec!["serve".into()],
            environment_keys: if codex {
                vec!["CODEX_HOME".into()]
            } else {
                vec![]
            },
            writable_roots: vec![],
            network_declared: false,
        });
    }
    let manifest = ProductionDeploymentManifestV1 {
        version: 1,
        repository: "TrillionniumFoundation/hepta-paper".into(),
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        service_manager_inventory_hash: source_hash.clone(),
        mount_topology_hash: source_hash.clone(),
        legacy_runtime_scan_hash: source_hash,
        legacy_node_runtime: LegacyNodeRuntimeDispositionV1::RemovedFromProduction,
        services,
    };
    assert_eq!(
        verify_production_deployment_v1(&manifest)
            .unwrap_err()
            .to_string(),
        "production executable is invalid"
    );
}

#[test]
fn reconciliation_source_identity_is_distinct_from_worker_identity() {
    let actual = native_reconciliation_implementation_hash_v1();
    assert_eq!(actual, native_reconciliation_implementation_hash_v1());
    assert_ne!(actual, native_implementation_hash_v1().unwrap());
}

use super::*;
use crate::command_surface::{
    synchronize_command_surface_pretty_json_v1, synchronize_command_surface_v1,
};
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use std::{
    collections::BTreeMap,
    os::unix::{
        fs::{PermissionsExt, symlink},
        process::{CommandExt, ExitStatusExt},
    },
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

const ORIGINAL: &[u8] = br#"{"name":"hepta-paper-workspace","version":"0.21.0","scripts":{"custom":"echo retained","test":"old"},"metadata":{"preserved":true}}"#;
struct Fixture {
    parent: PathBuf,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let parent = std::env::temp_dir().join(format!(
            "hepta-command-surface-publication-{}-{}",
            std::process::id(),
            nonce().unwrap()
        ));
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        let root = parent.join("workspace");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o775)).unwrap();
        fs::write(root.join("package.json"), ORIGINAL).unwrap();
        fs::set_permissions(root.join("package.json"), fs::Permissions::from_mode(0o664)).unwrap();
        Self { parent, root }
    }
    fn sidecar(&self) -> PathBuf {
        self.root
            .parent()
            .unwrap()
            .join("hepta-paper-runtime/native-runtime")
            .join(runtime::NAMESPACE)
            .join(
                runtime::workspace_key(&self.root, &fs::symlink_metadata(&self.root).unwrap())
                    .unwrap(),
            )
    }
    fn assert_settled(&self) {
        let bytes = self.private_bytes();
        assert_eq!(
            bytes.keys().map(String::as_str).collect::<Vec<_>>(),
            ["lock", runtime::BINDING_NAME]
        );
        assert_eq!(bytes["lock"], Vec::<u8>::new());
        let binding: serde_json::Value =
            serde_json::from_slice(&bytes[runtime::BINDING_NAME]).unwrap();
        assert_eq!(binding["version"], 2);
        assert_eq!(binding["kind"], "OrdinaryPackagePublicationRootBinding");
        assert_eq!(binding["workspace_path"], self.root.to_str().unwrap());
        assert_eq!(binding["authority_granted"], false);
        assert!(!self.root.join(SIDECAR).exists());
    }
    fn package(&self) -> Vec<u8> {
        fs::read(self.root.join("package.json")).unwrap()
    }
    fn private_bytes(&self) -> BTreeMap<String, Vec<u8>> {
        fs::read_dir(self.sidecar())
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (
                    entry.file_name().to_str().unwrap().to_owned(),
                    fs::read(entry.path()).unwrap(),
                )
            })
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        TEST_HOOK.with(|h| h.borrow_mut().take());
        fs::remove_dir_all(&self.parent).unwrap();
    }
}
struct Hook;
impl Hook {
    fn set(f: impl FnMut(&str) + 'static) -> Self {
        TEST_HOOK.with(|h| *h.borrow_mut() = Some(Box::new(f)));
        Self
    }
}
impl Drop for Hook {
    fn drop(&mut self) {
        TEST_HOOK.with(|h| h.borrow_mut().take());
    }
}
fn error(value: Result<serde_json::Value, CommandSurfaceError>) -> String {
    value.unwrap_err().to_string()
}

#[test]
fn ordinary_group_writable_package_is_atomically_published_with_owner_mode_and_fresh_retry() {
    let f = Fixture::new();
    let path = f.root.join("package.json");
    let before = fs::metadata(&path).unwrap();
    let readonly = synchronize_command_surface_v1(&f.root, false).unwrap();
    assert!(!readonly["ready"].as_bool().unwrap());
    assert!(!f.sidecar().exists());
    assert_eq!(f.package(), ORIGINAL);
    let first = synchronize_command_surface_pretty_json_v1(&f.root, true).unwrap();
    let after = fs::metadata(&path).unwrap();
    assert_ne!(before.ino(), after.ino());
    assert_eq!(
        (after.uid(), after.gid(), after.mode(), after.nlink()),
        (before.uid(), before.gid(), before.mode(), 1)
    );
    let bytes = f.package();
    assert!(serde_json::from_slice::<serde_json::Value>(&bytes).is_ok());
    assert!(bytes.ends_with(b"\n"));
    assert_eq!(fs::metadata(&f.root).unwrap().mode() & 0o777, 0o775);
    assert_eq!(fs::metadata(f.sidecar()).unwrap().mode() & 0o777, 0o700);
    f.assert_settled();
    assert_eq!(
        synchronize_command_surface_pretty_json_v1(&f.root, true).unwrap(),
        first
    );
    assert_eq!(f.package(), bytes);
    assert_eq!(f.private_bytes().len(), 2);
}

#[test]
fn retained_source_and_parent_replacement_are_refused_before_publication() {
    for mutation in ["in_place", "rename", "symlink", "hardlink", "parent"] {
        let f = Fixture::new();
        let root = f.root.clone();
        let package = root.join("package.json");
        let saved = f.parent.join("saved");
        let _hook = Hook::set(move |phase| {
            if phase == "stage_durable" {
                match mutation {
                    "in_place" => fs::write(
                        &package,
                        br#"{"name":"hepta-paper-workspace","foreign":"in-place"}"#,
                    )
                    .unwrap(),
                    "rename" => {
                        fs::rename(&package, &saved).unwrap();
                        fs::write(&package, br#"{"foreign":"replacement"}"#).unwrap();
                    }
                    "symlink" => {
                        fs::rename(&package, &saved).unwrap();
                        symlink(&saved, &package).unwrap();
                    }
                    "hardlink" => fs::hard_link(&package, &saved).unwrap(),
                    "parent" => {
                        fs::rename(&root, &saved).unwrap();
                        fs::create_dir(&root).unwrap();
                        fs::write(&package, br#"{"foreign":"new-directory"}"#).unwrap();
                    }
                    _ => unreachable!(),
                }
            }
        });
        assert!(
            error(synchronize_command_surface_v1(&f.root, true)).contains("changed"),
            "{mutation}"
        );
        if mutation == "parent" {
            assert_eq!(
                fs::read(f.parent.join("saved/package.json")).unwrap(),
                ORIGINAL
            );
        } else if mutation == "hardlink" {
            assert_eq!(f.package(), ORIGINAL);
            assert_eq!(
                fs::metadata(f.root.join("package.json")).unwrap().nlink(),
                2
            );
        } else if mutation != "symlink" {
            assert!(!f.package().is_empty());
        }
    }
}

#[test]
fn late_exchange_conflict_retains_foreign_displaced_and_both_raw_copies_without_inverse() {
    let f = Fixture::new();
    let path = f.root.join("package.json");
    let foreign = br#"{"name":"hepta-paper-workspace","foreign":"late-exchange"}"#;
    let original_saved = f.parent.join("original-outside");
    let _hook = Hook::set(move |phase| {
        if phase == "before_exchange" {
            fs::rename(&path, &original_saved).unwrap();
            fs::write(&path, foreign).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o664)).unwrap();
        }
    });
    assert!(
        error(synchronize_command_surface_v1(&f.root, true)).contains("outcome_unknown_retained")
    );
    drop(_hook);
    let private = f.private_bytes();
    let stage = private
        .iter()
        .find(|(n, _)| n.starts_with("stage-"))
        .unwrap()
        .1;
    assert_eq!(stage.as_slice(), foreign);
    assert_eq!(
        private
            .iter()
            .find(|(n, _)| n.starts_with("preimage-"))
            .unwrap()
            .1
            .as_slice(),
        ORIGINAL
    );
    assert_eq!(
        private
            .iter()
            .find(|(n, _)| n.starts_with("replacement-"))
            .unwrap()
            .1,
        &f.package()
    );
    assert_eq!(
        fs::read(f.parent.join("original-outside")).unwrap(),
        ORIGINAL
    );
    assert!(
        error(synchronize_command_surface_v1(&f.root, true)).contains("outcome_unknown_retained")
    );
    assert_eq!(f.private_bytes(), private);
}

#[test]
fn published_path_foreign_replacement_retains_complete_evidence_and_recovery_refuses() {
    let f = Fixture::new();
    let path = f.root.join("package.json");
    let foreign = br#"{"name":"hepta-paper-workspace","foreign":"after-exchange"}"#;
    let _hook = Hook::set(move |phase| {
        if phase == "after_exchange" {
            fs::write(&path, foreign).unwrap();
        }
    });
    assert!(
        error(synchronize_command_surface_v1(&f.root, true)).contains("outcome_unknown_retained")
    );
    drop(_hook);
    assert_eq!(f.package(), foreign);
    let private = f.private_bytes();
    assert_eq!(
        private
            .iter()
            .find(|(n, _)| n.starts_with("stage-"))
            .unwrap()
            .1
            .as_slice(),
        ORIGINAL
    );
    assert_eq!(
        private
            .iter()
            .find(|(n, _)| n.starts_with("preimage-"))
            .unwrap()
            .1
            .as_slice(),
        ORIGINAL
    );
    let replacement = private
        .iter()
        .find(|(n, _)| n.starts_with("replacement-"))
        .unwrap()
        .1;
    assert_ne!(replacement.as_slice(), foreign);
    assert!(serde_json::from_slice::<serde_json::Value>(replacement).is_ok());
    assert!(
        error(synchronize_command_surface_v1(&f.root, true)).contains("outcome_unknown_retained")
    );
    assert_eq!(f.package(), foreign);
    assert_eq!(f.private_bytes(), private);
}

#[test]
fn private_lock_symlink_mode_and_unknown_recovery_records_fail_closed() {
    for mutation in [
        "symlink",
        "hardlink",
        "permissions",
        "oversized",
        "unknown",
        "forged_gc",
    ] {
        let f = Fixture::new();
        drop(PackagePublication::open(&f.root).unwrap());
        let lock = f.sidecar().join("lock");
        let target = f.parent.join("foreign");
        fs::write(&target, b"retained").unwrap();
        match mutation {
            "symlink" => {
                fs::remove_file(&lock).unwrap();
                symlink(&target, &lock).unwrap();
            }
            "hardlink" => fs::hard_link(&lock, f.parent.join("alias")).unwrap(),
            "permissions" => fs::set_permissions(&lock, fs::Permissions::from_mode(0o664)).unwrap(),
            "oversized" => fs::write(
                f.sidecar().join(format!("intent-{}.json", "a".repeat(32))),
                vec![b'x'; RECORD_LIMIT as usize + 1],
            )
            .unwrap(),
            "unknown" => fs::write(f.sidecar().join("unrecognized.json"), b"{}").unwrap(),
            "forged_gc" => {
                let name = format!("gcproof-{}.json", "b".repeat(32));
                let value = GarbageProof {
                    version: 1,
                    id: "b".repeat(32),
                    source: "../package.json".into(),
                    witness: Witness::new(&fs::metadata(f.root.join("package.json")).unwrap()),
                    sha256: hash(ORIGINAL),
                };
                fs::write(f.sidecar().join(name), serde_json::to_vec(&value).unwrap()).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            synchronize_command_surface_v1(&f.root, true).is_err(),
            "{mutation}"
        );
        assert_eq!(f.package(), ORIGINAL);
        assert_eq!(fs::read(&target).unwrap(), b"retained");
    }
}

#[test]
fn cooperative_lock_busy_preserves_source_and_retries_after_actual_guard_drop() {
    let f = Fixture::new();
    let first = PackagePublication::open(&f.root).unwrap();
    let before = f.package();
    assert!(error(synchronize_command_surface_v1(&f.root, true)).contains("publication_busy"));
    assert_eq!(f.package(), before);
    drop(first);
    assert_eq!(
        synchronize_command_surface_v1(&f.root, true).unwrap()["kind"],
        "NpmScriptRegistryInspection"
    );
}

// These variables are read only in this explicitly selected cfg(test) helper.
// Product code has neither an environment barrier nor a kill/recovery backdoor.
#[test]
fn publication_process_child_entry() {
    let Some(root) = std::env::var_os("HEPTA_PACKAGE_PUBLICATION_TEST_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let phase_name = std::env::var("HEPTA_PACKAGE_PUBLICATION_TEST_PHASE").unwrap_or_default();
    if std::env::var_os("HEPTA_PACKAGE_PUBLICATION_TEST_READONLY").is_some() {
        assert!(error(synchronize_command_surface_v1(&root, true)).contains("write_access_denied"));
        assert!(!root.join(SIDECAR).exists());
        return;
    }
    if !phase_name.is_empty() {
        let barrier =
            PathBuf::from(std::env::var_os("HEPTA_PACKAGE_PUBLICATION_TEST_BARRIER").unwrap());
        let variant = std::env::var("HEPTA_PACKAGE_PUBLICATION_TEST_VARIANT").unwrap_or_default();
        assert!(
            [
                "",
                "foreign_exchange",
                "foreign_published",
                "foreign_cleanup"
            ]
            .contains(&variant.as_str())
        );
        let fixture_root = root.clone();
        TEST_HOOK.with(|h| {
            *h.borrow_mut() = Some(Box::new(move |name| {
                let foreign =
                    br#"{"name":"hepta-paper-workspace","scripts":{},"foreign":"actual-actor"}"#;
                if name == "before_exchange" && variant == "foreign_exchange" {
                    let path = fixture_root.join("package.json");
                    fs::rename(&path, fixture_root.join("foreign-original-retained.json")).unwrap();
                    fs::write(&path, foreign).unwrap();
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o664)).unwrap();
                }
                if name == "after_exchange" && variant == "foreign_published" {
                    fs::write(fixture_root.join("package.json"), foreign).unwrap();
                }
                if name == "cleanup_proof_durable" && variant == "foreign_cleanup" {
                    let legacy = fixture_root.join(SIDECAR);
                    let sidecar = if legacy.exists() {
                        legacy
                    } else {
                        runtime::selected_runtime_path(&fixture_root)
                            .unwrap()
                            .join(runtime::NAMESPACE)
                            .join(
                                runtime::workspace_key(
                                    &fixture_root,
                                    &fs::symlink_metadata(&fixture_root).unwrap(),
                                )
                                .unwrap(),
                            )
                    };
                    let source = fs::read_dir(&sidecar)
                        .unwrap()
                        .map(|entry| entry.unwrap().path())
                        .find(|path| {
                            path.file_name()
                                .unwrap()
                                .to_str()
                                .unwrap()
                                .starts_with("stage-")
                        })
                        .unwrap();
                    fs::rename(&source, fixture_root.join("foreign-original-retained.json"))
                        .unwrap();
                    fs::write(&source, foreign).unwrap();
                }
                if name == phase_name {
                    let pending = barrier.with_extension("pending");
                    fs::write(&pending, name).unwrap();
                    fs::rename(&pending, &barrier).unwrap();
                    loop {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            }))
        });
    }
    assert_eq!(
        synchronize_command_surface_v1(&root, true).unwrap()["kind"],
        "NpmScriptRegistryInspection"
    );
}

fn child(root: &Path, phase: &str, barrier: &Path) -> OwnedChild {
    child_with_runtime(root, phase, barrier, None)
}
fn child_with_runtime(
    root: &Path,
    phase: &str,
    barrier: &Path,
    runtime: Option<&Path>,
) -> OwnedChild {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "command_surface::publication::tests::publication_process_child_entry",
            "--nocapture",
        ])
        .env_remove("HEPTA_PACKAGE_PUBLICATION_TEST_READONLY")
        .env_remove("HEPTA_PACKAGE_PUBLICATION_TEST_VARIANT")
        .env_remove("HEPTA_PAPER_RUNTIME_ROOT")
        .env("HEPTA_PACKAGE_PUBLICATION_TEST_ROOT", root)
        .env("HEPTA_PACKAGE_PUBLICATION_TEST_PHASE", phase)
        .env("HEPTA_PACKAGE_PUBLICATION_TEST_BARRIER", barrier)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if let Some(path) = runtime {
        command.env("HEPTA_PAPER_RUNTIME_ROOT", path);
    }
    OwnedChild::new(command.spawn().unwrap(), getuid().as_raw())
}
struct OwnedChild {
    process: Child,
    captured: Option<(u32, String)>,
}
impl OwnedChild {
    fn new(process: Child, actor: u32) -> Self {
        // Construct the guard first: even an observation/assertion failure
        // keeps the newly spawned, unreaped Child under bounded cleanup.
        let mut result = Self {
            process,
            captured: None,
        };
        result.captured = Some(identity(result.process.id()));
        assert_eq!(result.captured.as_ref().unwrap().0, actor);
        result
    }
}
impl std::ops::Deref for OwnedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.process
    }
}
impl std::ops::DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.process
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.process.try_wait().ok().flatten().is_some() {
            return;
        }
        if let Some(captured) = &self.captured {
            let observed = std::panic::catch_unwind(|| identity(self.process.id()));
            if observed.as_ref().ok() != Some(captured) {
                cleanup_failure(self.process.id(), "identity changed");
                return;
            }
        }
        // If initial /proc observation itself failed, this is still the
        // freshly spawned unreaped Child, not a persisted PID/PGID receipt.
        if self.process.kill().is_err() {
            cleanup_failure(self.process.id(), "kill failed");
            return;
        }
        let began = Instant::now();
        loop {
            if self.process.try_wait().ok().flatten().is_some() {
                return;
            }
            if began.elapsed() > Duration::from_secs(30) {
                cleanup_failure(self.process.id(), "cleanup deadline exceeded");
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
fn cleanup_failure(pid: u32, reason: &str) {
    if std::thread::panicking() {
        eprintln!("owned publication child cleanup unverified pid={pid}: {reason}");
    } else {
        panic!("owned publication child cleanup unverified pid={pid}: {reason}");
    }
}
fn identity(pid: u32) -> (u32, String) {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    let uid = status
        .lines()
        .find(|line| line.starts_with("Uid:"))
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let value = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let fields = value
        .rsplit_once(") ")
        .unwrap()
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    (uid, fields[19].to_owned())
}
fn wait(child: &mut OwnedChild) -> ExitStatus {
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if start.elapsed() > Duration::from_secs(30) {
            panic!("owned publication child cleanup exceeded fixed budget");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn actual_sigterm_and_sigkill_at_durable_boundaries_recover_through_fresh_ordinary_entry() {
    for phase_name in [
        "source_retained",
        "preimage_durable",
        "stage_created",
        "stage_partial_write",
        "stage_durable",
        "intent_durable",
        "before_exchange",
        "after_exchange",
        "publication_directories_durable",
        "completion_durable",
        "cleanup_proof_durable",
        "cleanup_entry_quarantined",
        "cleanup_entry_removed",
    ] {
        for signal in [Signal::SIGTERM, Signal::SIGKILL] {
            let f = Fixture::new();
            let barrier = f.parent.join("barrier");
            let mut process = child(&f.root, phase_name, &barrier);
            let captured = identity(process.id());
            assert_eq!(captured.0, getuid().as_raw());
            let start = Instant::now();
            while !barrier.exists() {
                if let Some(status) = process.try_wait().unwrap() {
                    panic!("phase {phase_name} child ended before its actual barrier: {status}");
                }
                if start.elapsed() > Duration::from_secs(30) {
                    panic!("phase {phase_name} did not reach fixed barrier budget");
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(fs::read_to_string(&barrier).unwrap(), phase_name);
            assert_eq!(identity(process.id()), captured);
            assert!(
                error(synchronize_command_surface_v1(&f.root, true)).contains("publication_busy")
            );
            eprintln!(
                "publication phase={phase_name} signal={signal:?} owned_pid={} start={}",
                process.id(),
                captured.1
            );
            kill(Pid::from_raw(process.id() as i32), signal).unwrap();
            assert_eq!(wait(&mut process).signal(), Some(signal as i32));
            let interrupted = f.package();
            assert!(
                interrupted == ORIGINAL
                    || serde_json::from_slice::<serde_json::Value>(&interrupted).unwrap()["scripts"]
                        ["test"]
                        != "old"
            );
            let before = f.private_bytes();
            let mut retry = child(&f.root, "", &barrier);
            assert!(
                wait(&mut retry).success(),
                "fresh ordinary retry at {phase_name} after {signal:?}"
            );
            let completed = f.package();
            assert!(
                serde_json::from_slice::<serde_json::Value>(&completed).unwrap()["scripts"]["test"]
                    != "old"
            );
            assert_eq!(
                fs::metadata(f.root.join("package.json")).unwrap().mode() & 0o777,
                0o664
            );
            let mut again = child(&f.root, "", &barrier);
            assert!(wait(&mut again).success());
            assert_eq!(f.package(), completed);
            if [
                "preimage_durable",
                "stage_created",
                "stage_partial_write",
                "stage_durable",
            ]
            .contains(&phase_name)
            {
                let after = f.private_bytes();
                for (name, bytes) in &before {
                    assert_eq!(
                        after.get(name),
                        Some(bytes),
                        "prepared/incomplete {phase_name} entry {name} was falsely cleaned"
                    );
                }
            } else {
                f.assert_settled();
            }
        }
    }
}

#[test]
fn ordinary_readonly_leaf_refuses_actual_write_access_before_sidecar_creation() {
    let f = Fixture::new();
    let actor = if getuid().as_raw() == 0 {
        65534
    } else {
        getuid().as_raw()
    };
    if getuid().as_raw() == 0 {
        for path in [&f.parent, &f.root, &f.root.join("package.json")] {
            nix::unistd::chown(
                path,
                Some(nix::unistd::Uid::from_raw(actor)),
                Some(Gid::from_raw(actor)),
            )
            .unwrap();
        }
    }
    fs::set_permissions(
        f.root.join("package.json"),
        fs::Permissions::from_mode(0o440),
    )
    .unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "command_surface::publication::tests::publication_process_child_entry",
            "--nocapture",
        ])
        .env("HEPTA_PACKAGE_PUBLICATION_TEST_ROOT", &f.root)
        .env("HEPTA_PACKAGE_PUBLICATION_TEST_READONLY", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if getuid().as_raw() == 0 {
        command.uid(actor).gid(actor);
    }
    let mut child = OwnedChild::new(command.spawn().unwrap(), actor);
    assert!(wait(&mut child).success());
    assert!(!f.sidecar().exists());
    assert_eq!(f.package(), ORIGINAL);
    assert!(synchronize_command_surface_v1(&f.root, false).is_ok());
}

#[test]
fn foreign_cleanup_quarantine_retains_committed_pending_evidence_without_deleting_foreign() {
    for at in ["cleanup_proof_durable", "cleanup_entry_quarantined"] {
        let f = Fixture::new();
        let sidecar = f.sidecar();
        let foreign = br#"{"foreign":"quarantine-replacement"}"#;
        let _hook = Hook::set(move |phase| {
            if phase == at {
                let entries = fs::read_dir(&sidecar)
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .collect::<Vec<_>>();
                let prefix = if at == "cleanup_proof_durable" {
                    "stage-"
                } else {
                    "gc-"
                };
                let selected = entries
                    .iter()
                    .find(|path| {
                        path.file_name()
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .starts_with(prefix)
                    })
                    .unwrap();
                fs::rename(selected, sidecar.join("foreign-original-retained.json")).unwrap();
                fs::write(selected, foreign).unwrap();
            }
        });
        assert!(
            error(synchronize_command_surface_v1(&f.root, true))
                .contains("committed_cleanup_pending")
        );
        drop(_hook);
        let bytes = f.private_bytes();
        assert!(bytes.values().any(|bytes| bytes.as_slice() == foreign));
        assert_eq!(bytes["foreign-original-retained.json"].as_slice(), ORIGINAL);
        assert!(
            bytes
                .iter()
                .any(|(name, bytes)| name.starts_with("preimage-") && bytes.as_slice() == ORIGINAL)
        );
        assert!(bytes.iter().any(|(name, _)| name.starts_with("done-")));
        assert!(synchronize_command_surface_v1(&f.root, true).is_err());
        assert_eq!(f.private_bytes(), bytes);
    }
}

#[test]
fn prepared_intent_never_accepts_foreign_package_and_clean_preimage_retry_discards_only_proven_preparation()
 {
    for conflict in [false, true] {
        let f = Fixture::new();
        let root = f.root.clone();
        let _hook = Hook::set(move |phase| {
            if phase == "intent_durable" {
                if conflict {
                    fs::write(
                        root.join("package.json"),
                        br#"{"name":"hepta-paper-workspace","foreign":"prepared"}"#,
                    )
                    .unwrap();
                }
                panic!("owned preparation interruption");
            }
        });
        let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            synchronize_command_surface_v1(&f.root, true)
        }));
        assert!(interrupted.is_err());
        drop(_hook);
        let bytes = f.private_bytes();
        if conflict {
            assert!(
                error(synchronize_command_surface_v1(&f.root, true))
                    .contains("outcome_unknown_retained")
            );
            assert_eq!(f.private_bytes(), bytes);
        } else {
            assert_eq!(
                synchronize_command_surface_v1(&f.root, true).unwrap()["kind"],
                "NpmScriptRegistryInspection"
            );
            f.assert_settled();
            assert!(synchronize_command_surface_v1(&f.root, true).is_ok());
        }
    }
}

#[test]
fn incomplete_without_durable_intent_is_retained_and_exact_pending_limit_refuses_without_mutating_source()
 {
    let f = Fixture::new();
    drop(PackagePublication::open(&f.root).unwrap());
    for value in 0..128 {
        let name = format!("stage-{value:032x}.json");
        fs::write(f.sidecar().join(name), b"incomplete").unwrap();
    }
    let before = f.private_bytes();
    assert!(error(synchronize_command_surface_v1(&f.root, true)).contains("pending_limit"));
    assert_eq!(f.package(), ORIGINAL);
    assert_eq!(f.private_bytes(), before);
}

#[test]
fn entry_reserve_refuses_before_new_staging_would_exceed_bounded_recovery_inventory() {
    let f = Fixture::new();
    drop(PackagePublication::open(&f.root).unwrap());
    for value in 0..MAXIMUM_ENTRIES - NEW_PUBLICATION_ENTRY_RESERVE {
        fs::write(
            f.sidecar().join(format!("stage-{value:032x}.json")),
            b"incomplete",
        )
        .unwrap();
    }
    let before = f.private_bytes();
    assert!(error(synchronize_command_surface_v1(&f.root, true)).contains("pending_limit"));
    assert_eq!(f.package(), ORIGINAL);
    assert_eq!(f.private_bytes(), before);
}

fn await_barrier(process: &mut OwnedChild, path: &Path, phase: &str) {
    let began = Instant::now();
    loop {
        if path.exists() {
            assert_eq!(fs::read_to_string(path).unwrap(), phase);
            return;
        }
        if let Some(status) = process.try_wait().unwrap() {
            panic!("owned phase {phase} exited before barrier: {status}");
        }
        assert!(
            began.elapsed() < Duration::from_secs(30),
            "owned {phase} barrier deadline"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn durable_prepared_abandonment_survives_actual_signals_and_fresh_entry_finishes_cleanup() {
    for signal in [Signal::SIGTERM, Signal::SIGKILL] {
        let f = Fixture::new();
        let first = f.parent.join("prepared-barrier");
        let mut prepare = child(&f.root, "intent_durable", &first);
        await_barrier(&mut prepare, &first, "intent_durable");
        kill(Pid::from_raw(prepare.id() as i32), signal).unwrap();
        assert_eq!(wait(&mut prepare).signal(), Some(signal as i32));
        assert_eq!(f.package(), ORIGINAL);
        let second = f.parent.join("abandonment-barrier");
        let mut abandon = child(&f.root, "prepared_abandonment_durable", &second);
        await_barrier(&mut abandon, &second, "prepared_abandonment_durable");
        kill(Pid::from_raw(abandon.id() as i32), signal).unwrap();
        assert_eq!(wait(&mut abandon).signal(), Some(signal as i32));
        assert_eq!(f.package(), ORIGINAL);
        assert!(
            f.private_bytes()
                .keys()
                .any(|name| name.starts_with("done-"))
        );
        let mut fresh = child(&f.root, "", &second);
        assert!(wait(&mut fresh).success());
        f.assert_settled();
        assert_ne!(f.package(), ORIGINAL);
    }
}

#[test]
fn harness_unwind_reaps_only_the_actual_owned_phase_child_before_namespace_cleanup() {
    let f = Fixture::new();
    let barrier = f.parent.join("unwind-barrier");
    let mut pid = 0;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut process = child(&f.root, "source_retained", &barrier);
        pid = process.id();
        await_barrier(&mut process, &barrier, "source_retained");
        panic!("owned harness failure before signal; guard must reap");
    }));
    assert!(result.is_err());
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
    assert_eq!(f.package(), ORIGINAL);
    f.assert_settled();
}

fn seed_legacy_lock(f: &Fixture) -> (u64, u64) {
    let path = f.root.join(SIDECAR);
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(path.join("lock"), []).unwrap();
    fs::set_permissions(path.join("lock"), fs::Permissions::from_mode(0o600)).unwrap();
    (
        fs::metadata(&path).unwrap().ino(),
        fs::metadata(path.join("lock")).unwrap().ino(),
    )
}

#[test]
fn known_legacy_lock_moves_to_runtime_with_same_directory_and_kernel_lock_inodes() {
    let f = Fixture::new();
    let (directory, lock) = seed_legacy_lock(&f);
    let root = f.root.clone();
    let _hook = Hook::set(move |phase| {
        if phase == "before_runtime_move" {
            assert!(
                error(synchronize_command_surface_v1(&root, true)).contains("publication_busy")
            );
        }
    });
    assert!(synchronize_command_surface_v1(&f.root, true).is_ok());
    f.assert_settled();
    assert_eq!(fs::metadata(f.sidecar()).unwrap().ino(), directory);
    assert_eq!(fs::metadata(f.sidecar().join("lock")).unwrap().ino(), lock);
    assert_eq!(fs::read_dir(&f.root).unwrap().count(), 1);
}

#[test]
fn unknown_legacy_bytes_and_metadata_remain_at_source_without_binding_or_migration() {
    let f = Fixture::new();
    seed_legacy_lock(&f);
    let old = f.root.join(SIDECAR);
    let foreign = old.join("unknown-external.json");
    fs::write(&foreign, b"foreign-original-bytes").unwrap();
    let before = fs::metadata(&foreign).unwrap();
    assert!(
        error(synchronize_command_surface_v1(&f.root, true)).contains("outcome_unknown_retained")
    );
    assert_eq!(fs::read(&foreign).unwrap(), b"foreign-original-bytes");
    assert_eq!(
        Witness::new(&before),
        Witness::new(&fs::metadata(&foreign).unwrap())
    );
    assert!(!old.join(runtime::BINDING_NAME).exists());
    assert!(!f.sidecar().exists());
    assert_eq!(f.package(), ORIGINAL);
}

#[test]
fn new_foreign_entry_before_runtime_move_is_refused_at_original_source_location() {
    let f = Fixture::new();
    seed_legacy_lock(&f);
    let old = f.root.join(SIDECAR);
    let foreign = old.join("introduced-foreign.json");
    let copy = foreign.clone();
    let _hook = Hook::set(move |phase| {
        if phase == "before_runtime_move" {
            fs::write(&copy, b"retained-at-source").unwrap();
        }
    });
    assert!(
        error(synchronize_command_surface_v1(&f.root, true)).contains("outcome_unknown_retained")
    );
    assert_eq!(fs::read(&foreign).unwrap(), b"retained-at-source");
    assert!(old.join(runtime::BINDING_NAME).exists());
    assert!(!f.sidecar().exists());
    assert_eq!(f.package(), ORIGINAL);
}

#[test]
fn local_root_binding_rejects_authority_fields_source_lock_and_runtime_replacements() {
    for mutation in [
        "authority",
        "workspace",
        "workspace_path",
        "runtime",
        "extra",
        "mode",
        "symlink",
        "hardlink",
        "oversize",
        "lock",
    ] {
        let f = Fixture::new();
        assert!(synchronize_command_surface_v1(&f.root, true).is_ok());
        let path = f.sidecar().join(runtime::BINDING_NAME);
        let before = f.package();
        let original = fs::read(&path).unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
        match mutation {
            "authority" => value["authority_granted"] = true.into(),
            "workspace" => value["workspace"]["ino"] = 0.into(),
            "workspace_path" => value["workspace_path"] = "/different-source".into(),
            "runtime" => value["runtime"]["ino"] = 0.into(),
            "extra" => value["undeclared"] = true.into(),
            "mode" => fs::set_permissions(&path, fs::Permissions::from_mode(0o440)).unwrap(),
            "symlink" => {
                fs::remove_file(&path).unwrap();
                symlink(f.root.join("package.json"), &path).unwrap();
            }
            "hardlink" => fs::hard_link(&path, f.parent.join("binding-alias")).unwrap(),
            "oversize" => fs::write(&path, vec![b'x'; RECORD_LIMIT as usize + 1]).unwrap(),
            "lock" => {
                let lock = f.sidecar().join("lock");
                fs::rename(&lock, f.parent.join("original-lock-retained")).unwrap();
                fs::write(&lock, []).unwrap();
                fs::set_permissions(&lock, fs::Permissions::from_mode(0o600)).unwrap();
            }
            _ => unreachable!(),
        }
        if [
            "authority",
            "workspace",
            "workspace_path",
            "runtime",
            "extra",
        ]
        .contains(&mutation)
        {
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        }
        assert!(
            synchronize_command_surface_v1(&f.root, true).is_err(),
            "{mutation}"
        );
        assert_eq!(f.package(), before, "{mutation}");
        if mutation == "lock" {
            assert_eq!(fs::read(&path).unwrap(), original);
        }
    }
}

#[test]
fn shared_selected_runtime_has_distinct_workspace_bindings_and_rejects_record_swaps() {
    let left = Fixture::new();
    let right = Fixture::new();
    let shared = left.parent.join("shared-runtime");
    for f in [&left, &right] {
        let mut process = child_with_runtime(&f.root, "", &f.parent.join("unused"), Some(&shared));
        assert!(wait(&mut process).success());
    }
    let path = |f: &Fixture| {
        shared
            .join(runtime::NAMESPACE)
            .join(runtime::workspace_key(&f.root, &fs::metadata(&f.root).unwrap()).unwrap())
    };
    let lp = path(&left);
    let rp = path(&right);
    assert_ne!(lp, rp);
    let left_binding = fs::read(lp.join(runtime::BINDING_NAME)).unwrap();
    let right_binding = fs::read(rp.join(runtime::BINDING_NAME)).unwrap();
    assert_ne!(left_binding, right_binding);
    fs::write(rp.join(runtime::BINDING_NAME), &left_binding).unwrap();
    let before = right.package();
    let mut rejected =
        child_with_runtime(&right.root, "", &right.parent.join("unused"), Some(&shared));
    assert!(!wait(&mut rejected).success());
    assert_eq!(right.package(), before);
    assert_eq!(
        fs::read(rp.join(runtime::BINDING_NAME)).unwrap(),
        left_binding
    );
}

#[test]
fn relative_runtime_environment_resolves_against_actual_workspace_root() {
    let f = Fixture::new();
    let mut process = child_with_runtime(
        &f.root,
        "",
        &f.parent.join("unused"),
        Some(Path::new("../selected-runtime")),
    );
    assert!(wait(&mut process).success());
    let runtime = f.parent.join("selected-runtime");
    let binding = runtime
        .join(runtime::NAMESPACE)
        .join(runtime::workspace_key(&f.root, &fs::metadata(&f.root).unwrap()).unwrap())
        .join(runtime::BINDING_NAME);
    let actual: serde_json::Value = serde_json::from_slice(&fs::read(binding).unwrap()).unwrap();
    assert_eq!(actual["runtime_path"], runtime.to_str().unwrap());
    assert!(!f.sidecar().exists());
    assert!(!f.root.join(SIDECAR).exists());
}

#[test]
fn normal_api_refuses_runtime_overlap_alias_cross_device_and_path_caps_before_any_creation() {
    let f = Fixture::new();
    let alias = f.parent.join("runtime-alias");
    symlink(&f.root, &alias).unwrap();
    let too_long_component = f.parent.join("x".repeat(256));
    let too_long_total = f.parent.join(
        std::iter::repeat_n("y".repeat(200), 21)
            .collect::<Vec<_>>()
            .join("/"),
    );
    for path in [
        &f.root,
        &f.root.join("inside-source"),
        &f.parent,
        &alias,
        &alias.join("uncreated"),
        &too_long_component,
        &too_long_total,
    ] {
        let before = Witness::new(&fs::metadata(f.root.join("package.json")).unwrap());
        let entries = fs::read_dir(&f.parent).unwrap().count();
        let mut process = child_with_runtime(&f.root, "", &f.parent.join("unused"), Some(path));
        assert!(!wait(&mut process).success(), "{}", path.display());
        assert_eq!(fs::read_dir(&f.parent).unwrap().count(), entries);
        assert_eq!(fs::read_dir(&f.root).unwrap().count(), 1);
        assert_eq!(f.package(), ORIGINAL);
        assert_eq!(
            before,
            Witness::new(&fs::metadata(f.root.join("package.json")).unwrap())
        );
        assert!(!f.sidecar().exists());
    }
    let alternate = PathBuf::from("/dev/shm").join(format!(
        "hepta-package-runtime-cross-device-{}-{}",
        std::process::id(),
        nonce().unwrap()
    ));
    assert!(!alternate.exists());
    assert_ne!(
        fs::metadata("/dev/shm").unwrap().dev(),
        fs::metadata(&f.root).unwrap().dev(),
        "actual cross-device fixture requires distinct mounted filesystems"
    );
    let mut process = child_with_runtime(&f.root, "", &f.parent.join("unused"), Some(&alternate));
    assert!(!wait(&mut process).success());
    assert!(
        !alternate.exists(),
        "cross-device refusal created the absent runtime"
    );
    let input = hold_native_workspace_package_v1(&f.root, MAXIMUM).unwrap();
    let result = runtime::Context::open_selected(&input, &alternate);
    assert!(
        result
            .err()
            .unwrap()
            .to_string()
            .contains("filesystem_mismatch")
    );
    assert!(!alternate.exists());
    assert_eq!(f.package(), ORIGINAL);
    assert!(!f.root.join(SIDECAR).exists());
}

#[test]
fn actual_legacy_runtime_migration_signal_boundaries_keep_same_input_fresh_recovery() {
    for phase in [
        "runtime_binding_durable",
        "before_runtime_move",
        "after_runtime_move",
        "runtime_move_directories_durable",
    ] {
        for signal in [Signal::SIGTERM, Signal::SIGKILL] {
            let f = Fixture::new();
            let (directory, lock) = seed_legacy_lock(&f);
            let barrier = f.parent.join("runtime-barrier");
            let mut process = child(&f.root, phase, &barrier);
            await_barrier(&mut process, &barrier, phase);
            let captured = identity(process.id());
            assert_eq!(captured.0, getuid().as_raw());
            eprintln!(
                "runtime migration phase={phase} signal={signal:?} owned_pid={} start={}",
                process.id(),
                captured.1
            );
            kill(Pid::from_raw(process.id() as i32), signal).unwrap();
            assert_eq!(wait(&mut process).signal(), Some(signal as i32));
            assert_eq!(f.package(), ORIGINAL);
            for _ in 0..2 {
                let mut fresh = child(&f.root, "", &barrier);
                assert!(wait(&mut fresh).success());
            }
            f.assert_settled();
            assert_eq!(fs::metadata(f.sidecar()).unwrap().ino(), directory);
            assert_eq!(fs::metadata(f.sidecar().join("lock")).unwrap().ino(), lock);
        }
    }
}

#[test]
fn ordinary_runtime_prefix_accepts_unrelated_siblings_but_rejects_identity_and_permission_replacement()
 {
    let f = Fixture::new();
    let sibling = f.parent.join("legitimate-unrelated-sibling");
    let _hook = Hook::set(move |phase| {
        if phase == "runtime_prefix_retained" {
            fs::create_dir(&sibling).unwrap();
        }
    });
    let result = synchronize_command_surface_v1(&f.root, true);
    assert!(result.is_ok(), "unrelated sibling refused: {result:?}");
    f.assert_settled();
    drop(_hook);
    for mutation in ["inode", "mode", "symlink"] {
        let f = Fixture::new();
        let prefix = f.parent.join("selected-prefix");
        fs::create_dir(&prefix).unwrap();
        fs::set_permissions(&prefix, fs::Permissions::from_mode(0o700)).unwrap();
        let retained = f.parent.join("retained-original-prefix");
        let copy = prefix.clone();
        let _hook = Hook::set(move |phase| {
            if phase == "runtime_prefix_retained" {
                match mutation {
                    "inode" => {
                        fs::rename(&copy, &retained).unwrap();
                        fs::create_dir(&copy).unwrap();
                        fs::set_permissions(&copy, fs::Permissions::from_mode(0o700)).unwrap();
                    }
                    "mode" => {
                        fs::set_permissions(&copy, fs::Permissions::from_mode(0o755)).unwrap()
                    }
                    "symlink" => {
                        fs::rename(&copy, &retained).unwrap();
                        symlink(&retained, &copy).unwrap();
                    }
                    _ => unreachable!(),
                }
            }
        });
        let input = hold_native_workspace_package_v1(&f.root, MAXIMUM).unwrap();
        let result = runtime::Context::open_selected(&input, &prefix.join("uncreated-runtime"));
        assert!(result.is_err(), "{mutation}");
        assert!(!prefix.join("uncreated-runtime").exists());
        assert_eq!(f.package(), ORIGINAL);
        assert!(!f.sidecar().exists());
    }
}

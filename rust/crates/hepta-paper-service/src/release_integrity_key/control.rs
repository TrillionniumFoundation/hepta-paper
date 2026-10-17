//! Cancellation delegates publication and rollback to the existing key owner.
use super::*;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

fn active(cancelled: &AtomicBool, deadline: Instant) -> Result<()> {
    if cancelled.load(Ordering::Acquire) {
        return Err(error("release_integrity_key_cancelled"));
    }
    if Instant::now() >= deadline {
        return Err(error("release_integrity_key_deadline_exhausted"));
    }
    Ok(())
}

/// Run the original closed CLI grammar and key owner with one cancellation flag
/// and absolute deadline. Cancellation never blocks identity-checked rollback
/// of this invocation's own files. Unknown crash leftovers remain unmodified.
pub fn release_integrity_key_cli_with_cancellation_v1(
    argv: &[String],
    environment: &BTreeMap<String, String>,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<ReleaseIntegrityKeyOutputV1> {
    with_hooks(argv, environment, cancelled, deadline, &mut NoHooks)
}

fn with_hooks(
    argv: &[String],
    environment: &BTreeMap<String, String>,
    cancelled: &AtomicBool,
    deadline: Instant,
    hooks: &mut dyn HookV1,
) -> Result<ReleaseIntegrityKeyOutputV1> {
    active(cancelled, deadline)?;
    let mut controlled = |event, path: &Path| {
        let cleanup = matches!(
            event,
            EventV1::BeforeCleanupFileRename | EventV1::BeforeCleanupDirectoryRename
        );
        if !cleanup {
            active(cancelled, deadline)?;
        }
        hooks.event(event, path)?;
        if !cleanup {
            active(cancelled, deadline)?;
        }
        Ok(())
    };
    release_integrity_key_cli_with_hooks_v1(argv, environment, &mut controlled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::{BufRead, BufReader, Write},
        os::unix::fs::PermissionsExt,
        process::{Command, Stdio},
        sync::{Arc, atomic::AtomicU64},
        time::Duration,
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "hepta-release-key-control-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        for name in ["workspace", "runtime"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        root
    }
    fn environment(root: &Path) -> BTreeMap<String, String> {
        [
            ("HEPTA_PAPER_WORKSPACE_ROOT", "workspace"),
            ("HEPTA_PAPER_RUNTIME_ROOT", "runtime"),
            ("HEPTA_PAPER_ASSET_ROOT", "assets"),
            ("PAPER_FACTORY_LEGACY_ROOT", "legacy"),
        ]
        .map(|(key, path)| (key.into(), root.join(path).to_str().unwrap().into()))
        .into_iter()
        .collect()
    }
    fn arguments() -> Vec<String> {
        crate::canonical_cli::resolve_canonical_cli_arguments_v1(
            &[
                "maintenance",
                "release-integrity-key",
                "--",
                "--action=provision",
                "--execute",
            ]
            .map(str::to_owned),
        )
        .unwrap()
        .unwrap()[1..]
            .to_vec()
    }
    fn snapshot(root: &Path) -> Value {
        fn collect(path: &Path, base: &Path, rows: &mut Vec<Value>) {
            use std::os::unix::fs::MetadataExt;
            let mut names = fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            names.sort();
            for p in names {
                let m = fs::symlink_metadata(&p).unwrap();
                rows.push(json!({"name":p.strip_prefix(base).unwrap(), "dev":m.dev(),
                    "ino":m.ino(), "mode":m.mode(), "nlink":m.nlink(), "bytes":m.len(),
                    "mtime":m.mtime(), "mtimeNsec":m.mtime_nsec(),
                    "ctime":m.ctime(), "ctimeNsec":m.ctime_nsec(),
                    "hash":if m.is_file() {Some(hex::encode(Sha256::digest(fs::read(&p).unwrap())))}else{None}}));
                if m.is_dir() {
                    collect(&p, base, rows);
                }
            }
        }
        let mut rows = Vec::new();
        collect(root, root, &mut rows);
        json!(rows)
    }

    #[test]
    fn cancelled_and_expired_key_publication_rolls_back_owned_files_and_retries_once() {
        let root = fixture();
        let env = environment(&root);
        let cancelled = AtomicBool::new(true);
        let before = snapshot(&root);
        assert_eq!(
            release_integrity_key_cli_with_cancellation_v1(
                &arguments(),
                &env,
                &cancelled,
                Instant::now() + Duration::from_secs(30)
            )
            .unwrap_err()
            .to_string(),
            "release_integrity_key_cancelled"
        );
        cancelled.store(false, Ordering::Release);
        assert_eq!(
            release_integrity_key_cli_with_cancellation_v1(
                &arguments(),
                &env,
                &cancelled,
                Instant::now()
            )
            .unwrap_err()
            .to_string(),
            "release_integrity_key_deadline_exhausted"
        );
        assert_eq!(snapshot(&root), before);
        let mut hit = false;
        let mut hook = |event, _: &Path| {
            if event == EventV1::AfterPublicLink {
                hit = true;
                cancelled.store(true, Ordering::Release);
            }
            Ok(())
        };
        let refused = with_hooks(
            &arguments(),
            &env,
            &cancelled,
            Instant::now() + Duration::from_secs(30),
            &mut hook,
        )
        .unwrap_err();
        assert!(hit);
        assert_eq!(refused.to_string(), "release_integrity_key_cancelled");
        assert!(fs::read_dir(root.join("runtime")).unwrap().next().is_none());
        cancelled.store(false, Ordering::Release);
        let completed = release_integrity_key_cli_with_cancellation_v1(
            &arguments(),
            &env,
            &cancelled,
            Instant::now() + Duration::from_secs(30),
        )
        .unwrap();
        assert_eq!(completed.value["created"], true);
        let committed = snapshot(&root);
        let retry = release_integrity_key_cli_with_cancellation_v1(
            &arguments(),
            &env,
            &cancelled,
            Instant::now() + Duration::from_secs(30),
        )
        .unwrap();
        assert_eq!(retry.value["created"], false);
        assert_eq!(snapshot(&root), committed);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "child process selected only by the actual interruption owner"]
    fn interrupted_key_control_worker() {
        let root = PathBuf::from(std::env::var("HEPTA_RELEASE_KEY_CONTROL_TEST_ROOT").unwrap());
        assert!(root.starts_with("/tmp"));
        assert!(
            root.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("hepta-release-key-control-")
        );
        let cancelled = Arc::new(AtomicBool::new(false));
        signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&cancelled)).unwrap();
        let mut held = false;
        let mut hook = |event, _: &Path| {
            if event == EventV1::AfterPublicLink && !held {
                held = true;
                println!("held-key-publication");
                std::io::stdout().flush().unwrap();
                while !cancelled.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            Ok(())
        };
        let result = with_hooks(
            &arguments(),
            &environment(&root),
            &cancelled,
            Instant::now() + Duration::from_secs(30),
            &mut hook,
        );
        assert!(held);
        assert_eq!(
            result.unwrap_err().to_string(),
            "release_integrity_key_cancelled"
        );
    }

    #[test]
    fn actual_term_rolls_back_and_kill_retains_unknown_key_state_without_automatic_repair() {
        use nix::sys::signal::{Signal, kill};
        use nix::unistd::Pid;
        for signal in [Signal::SIGTERM, Signal::SIGKILL] {
            let root = fixture();
            // This owner tests key publication interruption, not executable
            // copying. Reuse the running test binary so a concurrent fork cannot
            // inherit a copied executable's writer and make exec return ETXTBSY.
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "release_integrity_key::control::tests::interrupted_key_control_worker",
                    "--ignored",
                    "--nocapture",
                ])
                .env("HEPTA_RELEASE_KEY_CONTROL_TEST_ROOT", &root)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut reader = BufReader::new(child.stdout.take().unwrap());
            let mut ready = false;
            let mut line = String::new();
            while reader.read_line(&mut line).unwrap() != 0 {
                if line.trim() == "held-key-publication" {
                    ready = true;
                    break;
                }
                line.clear();
            }
            assert!(ready);
            kill(Pid::from_raw(i32::try_from(child.id()).unwrap()), signal).unwrap();
            let status = child.wait().unwrap();
            let env = environment(&root);
            let cancelled = AtomicBool::new(false);
            if signal == Signal::SIGTERM {
                assert!(status.success());
                assert!(fs::read_dir(root.join("runtime")).unwrap().next().is_none());
                assert_eq!(
                    release_integrity_key_cli_with_cancellation_v1(
                        &arguments(),
                        &env,
                        &cancelled,
                        Instant::now() + Duration::from_secs(30)
                    )
                    .unwrap()
                    .value["created"],
                    true
                );
            } else {
                use std::os::unix::process::ExitStatusExt;
                assert_eq!(status.signal(), Some(9));
                let retained = snapshot(&root);
                let status_args = ["--action=status".to_owned()];
                let inspection = release_integrity_key_cli_with_cancellation_v1(
                    &status_args,
                    &env,
                    &cancelled,
                    Instant::now() + Duration::from_secs(30),
                )
                .unwrap();
                assert_eq!(inspection.value["ready"], false);
                assert_eq!(
                    release_integrity_key_cli_with_cancellation_v1(
                        &arguments(),
                        &env,
                        &cancelled,
                        Instant::now() + Duration::from_secs(30)
                    )
                    .unwrap_err()
                    .to_string(),
                    "release_integrity_key_provision_locked"
                );
                assert_eq!(snapshot(&root), retained);
            }
            // Only this test's wholly owned temporary tree is cleaned by its owner.
            fs::remove_dir_all(root).unwrap();
        }
    }
}

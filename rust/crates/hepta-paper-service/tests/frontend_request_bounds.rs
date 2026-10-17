//! The public frontend must refuse special request files before reading or
//! opening writable state. These are actual processes under the existing
//! bounded runtime owner, including a fresh valid request after each refusal.
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, File},
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
#[derive(Debug, PartialEq, Eq)]
struct SourceExecutable {
    identity: (u64, u64, u64, u32, u32, u32, u64),
    timestamps: (i64, i64, i64, i64),
    sha256: [u8; 32],
}
impl SourceExecutable {
    fn observe(path: &Path) -> Self {
        let metadata = fs::symlink_metadata(path).unwrap();
        assert!(metadata.is_file());
        let bytes = fs::read(path).unwrap();
        assert!(bytes.starts_with(b"\x7fELF"));
        Self {
            identity: (
                metadata.dev(),
                metadata.ino(),
                metadata.len(),
                metadata.uid(),
                metadata.gid(),
                metadata.mode(),
                metadata.nlink(),
            ),
            timestamps: (
                metadata.mtime(),
                metadata.mtime_nsec(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            ),
            sha256: Sha256::digest(bytes).into(),
        }
    }
}
struct Fixture(PathBuf, PathBuf, SourceExecutable);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-frontend-request-bounds-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let root = fs::canonicalize(path).unwrap();
        // Cargo's shared artifact may inherit a group-writable build umask.
        // Execute an independently owned deployment copy without changing it.
        let source = fs::canonicalize(env!("CARGO_BIN_EXE_hepta-paper-rust")).unwrap();
        let observation = SourceExecutable::observe(&source);
        let executable = root.join("hepta-paper-rust");
        fs::copy(&source, &executable).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o550)).unwrap();
        let copied = SourceExecutable::observe(&executable);
        assert_ne!(observation.identity.1, copied.identity.1);
        assert_eq!(observation.sha256, copied.sha256);
        assert_eq!(observation, SourceExecutable::observe(&source));
        Self(root, executable, observation)
    }
    fn run(&self, args: &[OsString]) -> (i32, Vec<u8>, String) {
        let environment = EnvironmentPolicyV1::new(
            "frontend-request-file-test-v1",
            ["PATH", "LANG", "LC_ALL"],
            ["PATH"],
        )
        .unwrap()
        .build(
            std::iter::empty::<(OsString, OsString)>(),
            &BTreeMap::from([
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("LANG".into(), "C.UTF-8".into()),
                ("LC_ALL".into(), "C.UTF-8".into()),
            ]),
        )
        .unwrap();
        let result = run_bounded_process_capturing_stdout_with_cancellation(
            &BoundedProcessRequestV1 {
                executable: self.1.clone(),
                arguments: args.to_vec(),
                working_directory: self.0.clone(),
                environment,
                stdin: None,
            },
            ProcessLimitsV1 {
                timeout_ms: 15_000,
                termination_grace_ms: 100,
                cleanup_timeout_ms: 2_000,
                maximum_stdin_bytes: 1,
                maximum_stdout_bytes: 64 * 1024,
                maximum_stderr_bytes: 64 * 1024,
                maximum_tail_bytes: 4 * 1024,
                ..ProcessLimitsV1::default()
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(
            result.process.termination_reason,
            ProcessTerminationReason::Exited
        );
        assert!(result.process.process_group_cleanup_verified);
        assert_eq!(result.process.signal, None);
        assert!(!result.process.stdout_truncated);
        assert!(!result.process.stderr_truncated);
        (
            result.process.exit_code.unwrap(),
            result.stdout,
            String::from_utf8(result.process.stderr_tail).unwrap(),
        )
    }
    fn successful_json_retry(&self, path: &Path) {
        let bytes = serde_json::to_vec(&json!({
            "releaseCommit": "a".repeat(40), "capabilityCount": 1,
            "implementationVerified": 0, "releaseBoundConformanceVerified": 0,
            "independentProductionOperationalVerified": 0
        }))
        .unwrap();
        fs::write(path, &bytes).unwrap();
        let before = fs::symlink_metadata(path).unwrap();
        let (code, stdout, stderr) = self.run(&["release-trust-gate".into(), path.into()]);
        assert_eq!(code, 0, "{stderr}");
        let value: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
        assert_eq!(value["releaseCommit"], "a".repeat(40));
        assert_eq!(fs::read(path).unwrap(), bytes);
        let after = fs::symlink_metadata(path).unwrap();
        assert_eq!(before.ino(), after.ino());
        assert_eq!(before.mode(), after.mode());
        assert_eq!(before.ctime(), after.ctime());
        assert_eq!(before.ctime_nsec(), after.ctime_nsec());
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let source = fs::canonicalize(env!("CARGO_BIN_EXE_hepta-paper-rust")).unwrap();
        assert_eq!(self.2, SourceExecutable::observe(&source));
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn public_frontend_refuses_fifo_directory_symlink_and_oversize_before_cas_creation_then_retries() {
    let fixture = Fixture::new();
    let input = fixture.0.join("request");
    let target = fixture.0.join("alias-target");
    fs::write(&target, b"{}").unwrap();
    for (variant, diagnostic) in [
        ("fifo", "input must be a regular file"),
        ("directory", "input must be a regular file"),
        ("symlink", "Too many levels of symbolic links"),
        ("oversize", "input exceeds 16MiB"),
    ] {
        match variant {
            "fifo" => nix::unistd::mkfifo(
                &input,
                nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
            )
            .unwrap(),
            "directory" => fs::create_dir(&input).unwrap(),
            "symlink" => symlink(&target, &input).unwrap(),
            "oversize" => File::create(&input)
                .unwrap()
                .set_len(16 * 1024 * 1024 + 1)
                .unwrap(),
            _ => unreachable!(),
        }
        let before = fs::symlink_metadata(&input).unwrap();
        let cas = fixture.0.join(format!("cas-{variant}"));
        for args in [
            vec!["release-attest".into(), input.as_os_str().to_owned()],
            vec![
                "put".into(),
                cas.as_os_str().to_owned(),
                input.as_os_str().to_owned(),
            ],
        ] {
            let (code, stdout, stderr) = fixture.run(&args);
            assert_eq!(code, 1, "{variant}: {stderr}");
            assert!(stdout.is_empty());
            assert!(stderr.contains(diagnostic), "{variant}: {stderr}");
            assert!(!cas.exists(), "refused request created writable CAS state");
        }
        let after = fs::symlink_metadata(&input).unwrap();
        assert_eq!(before.ino(), after.ino());
        assert_eq!(before.mode(), after.mode());
        assert_eq!(before.len(), after.len());
        assert_eq!(before.ctime_nsec(), after.ctime_nsec());
        if variant == "fifo" {
            assert!(after.file_type().is_fifo());
        }
        if variant == "directory" {
            fs::remove_dir(&input).unwrap();
        } else {
            fs::remove_file(&input).unwrap();
        }
        fixture.successful_json_retry(&input);
        fs::remove_file(&input).unwrap();
    }
    assert_eq!(fs::read(target).unwrap(), b"{}");
}

#[test]
fn public_frontend_cas_put_retains_empty_binary_and_exact_16mib_regular_inputs() {
    let fixture = Fixture::new();
    let input = fixture.0.join("payload");
    for (name, bytes) in [
        ("empty", Vec::new()),
        ("binary", (0u8..=255).collect::<Vec<_>>()),
        ("maximum", vec![0x9a; 16 * 1024 * 1024]),
    ] {
        let cas = fixture.0.join(format!("cas-{name}"));
        fs::write(&input, &bytes).unwrap();
        let before = fs::symlink_metadata(&input).unwrap();
        let (code, stdout, stderr) = fixture.run(&[
            "put".into(),
            cas.as_os_str().to_owned(),
            input.as_os_str().to_owned(),
        ]);
        assert_eq!(code, 0, "{name}: {stderr}");
        let raw = format!("{:x}", Sha256::digest(&bytes));
        assert_eq!(
            String::from_utf8(stdout).unwrap(),
            format!("sha256:{raw}\n")
        );
        assert_eq!(fs::read(cas.join("objects").join(raw)).unwrap(), bytes);
        let after = fs::symlink_metadata(&input).unwrap();
        assert_eq!(before.ino(), after.ino());
        assert_eq!(before.mode(), after.mode());
        assert_eq!(before.len(), after.len());
        assert_eq!(before.ctime_nsec(), after.ctime_nsec());
    }
}

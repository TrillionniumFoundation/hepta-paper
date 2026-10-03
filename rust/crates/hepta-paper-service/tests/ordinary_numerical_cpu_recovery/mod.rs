//! Ordinary-entry recovery with real signed test data and real CPU workers.
//! No Prepared, authority, receipt or process observation is constructed here.
use hepta_codex_runtime::{
    BoundedProcessRequestV1, CapturedBoundedProcessResultV1, EnvironmentPolicyV1, ProcessLimitsV1,
    ProcessTerminationReason, run_bounded_process_capturing_stdout_with_cancellation,
};
use hepta_paper_service::ordinary_advanced_numerical_plugin::run_ordinary_advanced_numerical_plugin_status_v1;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, OpenOptions},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        process::{CommandExt, ExitStatusExt},
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
const ASSOCIATION: &str = "numerical-cpu-execution-association.v1.json";
const MARKER: &str = "ordinary-invocation";

#[derive(Debug, PartialEq, Eq)]
struct PhysicalFile {
    // Preserve all nine physical fields, including owner and both timestamps.
    fields: [u64; 9],
    hash: [u8; 32],
    bytes: Vec<u8>,
}
fn physical_fields(m: &fs::Metadata) -> [u64; 9] {
    [
        m.dev(),
        m.ino(),
        u64::from(m.mode()),
        u64::from(m.uid()),
        u64::from(m.gid()),
        m.nlink(),
        m.len(),
        u64::try_from(m.mtime()).unwrap() * 1_000_000_000 + u64::try_from(m.mtime_nsec()).unwrap(),
        u64::try_from(m.ctime()).unwrap() * 1_000_000_000 + u64::try_from(m.ctime_nsec()).unwrap(),
    ]
}

// A Cargo artifact is an input, not an execution permit: Cargo may create a
// group-writable hard link. Hold its exact input while copying the same ELF
// bytes to an exclusive fixture image; the ordinary process owner then admits
// that independent 0755, single-link image under its unchanged strict policy.
fn fixture_cli_image(root: &Path) -> PathBuf {
    use std::io::{Read, Seek, SeekFrom, Write};
    let source = PathBuf::from(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .canonicalize()
        .unwrap();
    let mut input = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(&source)
        .unwrap();
    let original = input.metadata().unwrap();
    assert!(original.is_file() && original.len() > 4 && original.len() <= 512 * 1024 * 1024);
    assert_eq!(
        physical_fields(&original),
        physical_fields(&fs::symlink_metadata(&source).unwrap())
    );
    let path = root.join("ordinary-cli-image");
    let mut output = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o700)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(&path)
        .unwrap();
    let mut copied = 0_u64;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = input.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        if copied == 0 {
            assert_eq!(&buffer[..4], b"\x7fELF");
        }
        copied = copied.checked_add(u64::try_from(count).unwrap()).unwrap();
        assert!(copied <= original.len());
        digest.update(&buffer[..count]);
        output.write_all(&buffer[..count]).unwrap();
    }
    assert_eq!(copied, original.len());
    output.sync_all().unwrap();
    output
        .set_permissions(fs::Permissions::from_mode(0o755))
        .unwrap();
    output.sync_all().unwrap();
    let image = output.metadata().unwrap();
    assert_eq!(image.mode() & 0o7777, 0o755);
    assert_eq!(image.nlink(), 1);
    assert_ne!((image.dev(), image.ino()), (original.dev(), original.ino()));
    assert_eq!(image.len(), original.len());
    assert_eq!(
        physical_fields(&image),
        physical_fields(&fs::symlink_metadata(&path).unwrap())
    );
    output.seek(SeekFrom::Start(0)).unwrap();
    let mut image_digest = Sha256::new();
    let mut verified = 0_u64;
    loop {
        let count = output.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        verified = verified.checked_add(u64::try_from(count).unwrap()).unwrap();
        assert!(verified <= copied);
        image_digest.update(&buffer[..count]);
    }
    assert_eq!(verified, copied);
    assert_eq!(digest.finalize(), image_digest.finalize());
    assert_eq!(
        physical_fields(&image),
        physical_fields(&output.metadata().unwrap())
    );
    assert_eq!(
        physical_fields(&image),
        physical_fields(&fs::symlink_metadata(&path).unwrap())
    );
    assert_eq!(
        physical_fields(&original),
        physical_fields(&input.metadata().unwrap())
    );
    assert_eq!(
        physical_fields(&original),
        physical_fields(&fs::symlink_metadata(&source).unwrap())
    );
    path
}
fn physical(path: &Path) -> PhysicalFile {
    use std::io::Read;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)
        .unwrap();
    let before = file.metadata().unwrap();
    assert!(before.is_file() && before.len() <= 4 * 1024 * 1024);
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes.len() as u64, before.len());
    assert_eq!(
        physical_fields(&before),
        physical_fields(&file.metadata().unwrap())
    );
    assert_eq!(
        physical_fields(&before),
        physical_fields(&fs::symlink_metadata(path).unwrap())
    );
    PhysicalFile {
        fields: physical_fields(&before),
        hash: Sha256::digest(&bytes).into(),
        bytes,
    }
}
struct Fixture {
    root: PathBuf,
    output_root: PathBuf,
    target: PathBuf,
    config: PathBuf,
    request: PathBuf,
    workspace: PathBuf,
    node: PathBuf,
    cli_image: PathBuf,
}
impl Fixture {
    fn environment(&self) -> hepta_codex_runtime::RestrictedEnvironmentV1 {
        EnvironmentPolicyV1::new(
            "ordinary-cpu-recovery-test-v1",
            ["PATH", "LANG", "LC_ALL", "HEPTA_PAPER_WORKSPACE_ROOT"],
            ["PATH"],
        )
        .unwrap()
        .build(
            std::iter::empty::<(OsString, OsString)>(),
            &BTreeMap::from([
                (
                    "PATH".into(),
                    format!("{}:/usr/bin:/bin", self.node.parent().unwrap().display()),
                ),
                ("LANG".into(), "C.UTF-8".into()),
                ("LC_ALL".into(), "C.UTF-8".into()),
                (
                    "HEPTA_PAPER_WORKSPACE_ROOT".into(),
                    self.workspace.display().to_string(),
                ),
            ]),
        )
        .unwrap()
    }
    fn new(mode: &str) -> Self {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let node = PathBuf::from(
            std::env::var_os("HEPTA_TEST_NODE").expect("qualified Node fixture dependency"),
        )
        .canonicalize()
        .unwrap();
        let provisional = Self {
            root: PathBuf::new(),
            output_root: PathBuf::new(),
            target: PathBuf::new(),
            config: PathBuf::new(),
            request: PathBuf::new(),
            workspace,
            node,
            cli_image: PathBuf::new(),
        };
        let result=provisional.capture(provisional.node.clone(),vec![
            provisional.workspace.join("rust/crates/hepta-paper-service/tests/ordinary_numerical_cpu_recovery/fixture.mjs").into_os_string(),mode.into()],30_000);
        assert_eq!(
            result.process.exit_code,
            Some(0),
            "{}",
            String::from_utf8_lossy(&result.process.stderr_tail)
        );
        let v: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(v["sourceFixtureOnly"], true);
        assert_eq!(v["installedAuthority"], false);
        assert_eq!(v["providerAuthority"], false);
        let path = |key: &str| PathBuf::from(v[key].as_str().unwrap());
        let root = path("root");
        assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
        assert!(
            root.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("hepta-advanced-numeric-")
        );
        let output_root = path("outputRoot");
        assert_eq!(output_root.parent(), Some(root.as_path()));
        let target = output_root.join("ordinary-recovery");
        let cli_image = fixture_cli_image(&root);
        Self {
            root,
            output_root,
            target,
            config: path("configurationPath"),
            request: path("requestPath"),
            workspace: provisional.workspace.clone(),
            node: provisional.node.clone(),
            cli_image,
        }
    }
    fn capture(
        &self,
        executable: PathBuf,
        arguments: Vec<OsString>,
        timeout_ms: u64,
    ) -> CapturedBoundedProcessResultV1 {
        let result = run_bounded_process_capturing_stdout_with_cancellation(
            &BoundedProcessRequestV1 {
                executable,
                arguments,
                working_directory: self.workspace.clone(),
                environment: self.environment(),
                stdin: None,
            },
            ProcessLimitsV1 {
                timeout_ms,
                termination_grace_ms: 100,
                cleanup_timeout_ms: 2_000,
                maximum_stdin_bytes: 1,
                maximum_stdout_bytes: 4 * 1024 * 1024,
                maximum_stderr_bytes: 4 * 1024 * 1024,
                maximum_tail_bytes: 1024 * 1024,
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
        assert!(!result.process.stdout_truncated && !result.process.stderr_truncated);
        result
    }
    fn api_args(&self) -> Vec<String> {
        vec![
            "--action".into(),
            "run".into(),
            "--config".into(),
            self.config.display().to_string(),
            "--request".into(),
            self.request.display().to_string(),
            "--output-directory".into(),
            self.target.display().to_string(),
        ]
    }
    fn cli_args(&self) -> Vec<OsString> {
        ["operator", "advanced-numerical-plugin", "--"]
            .into_iter()
            .map(OsString::from)
            .chain(self.api_args().into_iter().map(OsString::from))
            .collect()
    }
    fn run(&self) -> CapturedBoundedProcessResultV1 {
        self.capture(self.cli_image.clone(), self.cli_args(), 120_000)
    }
    fn sidecar(&self) -> Value {
        serde_json::from_slice(&physical(&self.target.join(ASSOCIATION)).bytes).unwrap()
    }
    fn private_output(&self) -> PathBuf {
        let value = self.sidecar();
        let p = PathBuf::from(value["privateOutputPath"].as_str().unwrap());
        let leaf = p.parent().unwrap().file_name().unwrap().to_string_lossy();
        assert!(leaf.starts_with(".hepta-native-numerical-") && leaf.len() == 56);
        assert_eq!(
            p.parent().unwrap().parent(),
            Some(self.output_root.as_path())
        );
        assert_eq!(p.file_name().unwrap(), "output");
        p
    }
    fn started_private_output(&self) -> Option<PathBuf> {
        // Poll only test-owned data. A sidecar can exist while its exclusive
        // write is still in progress; incomplete observation is not authority.
        let path = self.target.join(ASSOCIATION);
        if fs::metadata(&path).ok()?.len() > 64 * 1024 {
            return None;
        }
        let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
        let output = PathBuf::from(value["privateOutputPath"].as_str()?);
        let stage = output.parent()?;
        let leaf = stage.file_name()?.to_str()?;
        if stage.parent() != Some(self.output_root.as_path())
            || output.file_name()?.to_str()? != "output"
            || !leaf.starts_with(".hepta-native-numerical-")
            || leaf.len() != 56
        {
            return None;
        }
        let marker = output.join(MARKER);
        if fs::metadata(&marker).ok()?.len() != 23 {
            return None;
        }
        (fs::read(marker).ok()?.as_slice() == b"ordinary-worker-started").then_some(output)
    }
    fn stage_count(&self) -> usize {
        fs::read_dir(&self.output_root)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".hepta-native-numerical-")
            })
            .count()
    }
    fn retry_unknown(&self, expected_result: Option<&PhysicalFile>) {
        let sidecar = physical(&self.target.join(ASSOCIATION));
        let private = self.private_output();
        let marker = physical(&private.join(MARKER));
        let stages = self.stage_count();
        let actual = self.run();
        assert_eq!(actual.process.exit_code, Some(1));
        let report: Value = serde_json::from_slice(&actual.stdout).unwrap();
        assert_eq!(
            report["status"],
            "advanced_numerical_plugin_execution_blocked"
        );
        assert!(
            report["blockers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v == "advanced_numerical_plugin_prior_attempt_outcome_unknown")
        );
        assert!(report.get("workerReceipt").is_none());
        assert_eq!(report["productionQualified"], false);
        let stored: Value = serde_json::from_slice(&sidecar.bytes).unwrap();
        assert_eq!(stored["executionAuthority"], false);
        assert_eq!(
            stored["state"],
            "prepared_before_worker_spawn_outcome_unknown"
        );
        let observation = &report["executionAssociationObservation"];
        assert_eq!(observation["associationHash"], stored["associationHash"]);
        assert_eq!(
            observation["associationPath"],
            self.target.join(ASSOCIATION).display().to_string()
        );
        assert_eq!(
            observation["privateResultObservation"]["path"],
            private.join("result.json").display().to_string()
        );
        assert_eq!(observation["executionAuthority"], false);
        assert_eq!(
            observation["privateResultObservation"]["executionAuthority"],
            false
        );
        if let Some(original) = expected_result {
            assert_eq!(physical(&private.join("result.json")), *original);
            assert_eq!(
                observation["privateResultObservation"]["sha256"],
                format!("sha256:{}", hex::encode(original.hash))
            );
            assert_eq!(
                observation["privateResultObservation"]["bytes"],
                u64::try_from(original.bytes.len()).unwrap()
            );
            assert_eq!(
                observation["privateResultObservation"]["resultContractMatchesCurrentRequest"],
                true
            );
        } else {
            assert!(!private.join("result.json").exists());
            assert_eq!(
                observation["privateResultObservation"]["status"],
                "no_result_observed_outcome_unknown"
            );
        }
        assert_eq!(physical(&self.target.join(ASSOCIATION)), sidecar);
        assert_eq!(physical(&private.join(MARKER)), marker);
        assert_eq!(self.stage_count(), stages);
        assert!(!self.target.join("result.json").exists());
        // Portable evidence: no new stage or exclusive worker invocation marker.
        // This is narrower than the separately retained private execve traces.
    }
    fn refuse_current_sidecar(&self, expected: &str) {
        let before = physical(&self.target.join(ASSOCIATION));
        let actual = self.run();
        assert_eq!(actual.process.exit_code, Some(1));
        assert!(String::from_utf8_lossy(&actual.process.stderr_tail).contains(expected));
        assert_eq!(physical(&self.target.join(ASSOCIATION)), before);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.root.as_os_str().is_empty() && !std::thread::panicking() {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
}
#[test]
fn ordinary_cli_retains_written_failed_result_and_fresh_retry_refuses_tampering() {
    for mode in ["write-term", "write-kill"] {
        let f = Fixture::new(mode);
        let actual = f.run();
        assert_eq!(actual.process.exit_code, Some(1));
        let report: Value = serde_json::from_slice(&actual.stdout).unwrap();
        assert_eq!(report["workerReceipt"]["ok"], false);
        assert_eq!(report["productionQualified"], false);
        assert_eq!(
            report["executionAssociationObservation"]["executionAuthority"],
            false
        );
        let private = f.private_output();
        let original = physical(&private.join("result.json"));
        let result: Value = serde_json::from_slice(&original.bytes).unwrap();
        assert_eq!(result["estimate"]["estimate"], 6);
        f.retry_unknown(Some(&original));
        let sidecar = f.target.join(ASSOCIATION);
        let original_sidecar = physical(&sidecar);
        fs::write(&sidecar, b"{\"partial\":").unwrap();
        f.refuse_current_sidecar("association_invalid_or_changed");
        assert_eq!(physical(&private.join("result.json")), original);
        fs::write(&sidecar, &original_sidecar.bytes).unwrap();
        fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o666)).unwrap();
        f.refuse_current_sidecar("association_invalid_or_changed");
        fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o600)).unwrap();
        let retained = private.with_file_name("retained-original");
        fs::rename(&private, &retained).unwrap();
        fs::create_dir(&private).unwrap();
        fs::set_permissions(&private, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(private.join("result.json"), &original.bytes).unwrap();
        let replacement = physical(&private.join("result.json"));
        f.refuse_current_sidecar("association_invalid_or_changed");
        assert_eq!(physical(&retained.join("result.json")), original);
        assert_eq!(physical(&private.join("result.json")), replacement);
    }
}
#[test]
fn ordinary_api_actual_worker_cancel_preserves_unknown_association_and_fresh_retry() {
    let f = Fixture::new("no-result");
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancelled);
    let observed = std::thread::scope(|scope| {
        let waiter = scope.spawn(|| {
            let until = Instant::now() + Duration::from_secs(20);
            while Instant::now() < until {
                if f.started_private_output().is_some() {
                    assert_eq!(
                        physical(&f.private_output().join(MARKER)).bytes,
                        b"ordinary-worker-started"
                    );
                    flag.store(true, Ordering::Release);
                    return true;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            flag.store(true, Ordering::Release);
            false
        });
        let error = run_ordinary_advanced_numerical_plugin_status_v1(
            &f.api_args(),
            &cancelled,
            Instant::now() + Duration::from_secs(120),
        )
        .unwrap_err();
        let started = waiter.join().unwrap();
        assert!(started);
        assert!(error.contains("cancelled"));
        let facts: Value =
            serde_json::from_str(error.split_once(";cpuExecutionFacts=").unwrap().1).unwrap();
        assert_eq!(facts["process"]["processGroupCleanupVerified"], true);
        assert!(facts["publication"].is_null());
        assert_eq!(facts["executionAssociation"]["executionAuthority"], false);
        assert_eq!(
            facts["executionAssociation"]["associationOutcome"],
            "saved_prepared_outcome_unknown"
        );
        assert_eq!(facts["process"]["timeoutMs"], 30_000);
        assert_eq!(facts["process"]["maximumCapturedBytes"], 131_072);
        started
    });
    assert!(observed);
    f.retry_unknown(None);
}
// The fixture retains only its exact std::process::Child handle. It never signals
// an inferred group, discovers unrelated PIDs, or introduces another process owner.
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().unwrap().is_none() {
            self.0.kill().unwrap();
            self.0.wait().unwrap();
        }
    }
}
#[test]
fn ordinary_cli_actual_prefinal_sigkill_keeps_unknown_attempt_for_fresh_retry() {
    let f = Fixture::new("no-result");
    let stdout = f.root.join("killed-cli.stdout");
    let stderr = f.root.join("killed-cli.stderr");
    let create = |path: &Path| {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap()
    };
    let mut command = Command::new(&f.cli_image);
    command
        .args(f.cli_args())
        .current_dir(&f.workspace)
        .env_clear()
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", f.node.parent().unwrap().display()),
        )
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("HEPTA_PAPER_WORKSPACE_ROOT", &f.workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::from(create(&stdout)))
        .stderr(Stdio::from(create(&stderr)))
        .process_group(0);
    let mut owned = OwnedChild(command.spawn().unwrap());
    let until = Instant::now() + Duration::from_secs(120);
    loop {
        assert!(
            owned.0.try_wait().unwrap().is_none(),
            "normal CLI exited before the actual worker marker"
        );
        assert!(Instant::now() < until, "original120s pre-final deadline");
        assert!(
            fs::metadata(&stdout).unwrap().len() <= 4 * 1024 * 1024
                && fs::metadata(&stderr).unwrap().len() <= 4 * 1024 * 1024
        );
        if f.started_private_output().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let association = physical(&f.target.join(ASSOCIATION));
    let marker = physical(&f.private_output().join(MARKER));
    assert_eq!(marker.bytes, b"ordinary-worker-started");
    assert!(!f.private_output().join("result.json").exists());
    owned.0.kill().unwrap();
    let actual = owned.0.wait().unwrap();
    assert_eq!(actual.signal(), Some(nix::libc::SIGKILL));
    assert_eq!(actual.code(), None);
    assert_eq!(physical(&f.target.join(ASSOCIATION)), association);
    f.retry_unknown(None);
    assert_eq!(physical(&f.private_output().join(MARKER)), marker);
}

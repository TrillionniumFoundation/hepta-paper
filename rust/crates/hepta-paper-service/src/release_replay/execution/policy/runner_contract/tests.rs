use super::super::build_package_policy::inputs;
use super::super::fixture_test_support::{self, FixtureOwner};
use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{collections::BTreeMap, ffi::OsString, sync::atomic::AtomicBool};
fn root() -> super::super::PrivateTree {
    super::super::PrivateTree::new().unwrap()
}
fn directory(tree: &mut super::super::PrivateTree, name: &str) -> Directory {
    Directory::open_or_create(&tree.directory(name).unwrap(), false).unwrap()
}
fn oracle(
    tree: &mut super::super::PrivateTree,
    directory: &Directory,
    target: &Value,
    authoring: &Value,
    write: bool,
    label: &str,
) -> Value {
    let helper = FixtureOwner::new();
    let mut owner = helper.owner();
    let matrix = fixture_test_support::sources(&mut owner, tree);
    assert_eq!(matrix.entries.len(), 36);
    let bytes = tree.read_source(LOCAL_WRITER, &mut owner).unwrap();
    assert_eq!(
        super::super::super::digest(&bytes),
        "sha256:7825b10b02306594493a2cf6f112f6fbaa934f0f38023e6555573d07f81d4d2d"
    );
    let parent = tree.sources();
    let executable = fs::canonicalize("/usr/bin/python3").unwrap();
    let environment = EnvironmentPolicyV1::new(
        "native-runner-contract-retired-differential-test-v1",
        ["PATH", "LANG", "LC_ALL", "PYTHONDONTWRITEBYTECODE"],
        ["PATH", "LANG", "LC_ALL"],
    )
    .unwrap()
    .build(
        std::iter::empty::<(OsString, OsString)>(),
        &BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LANG".into(), "C.UTF-8".into()),
            ("LC_ALL".into(), "C.UTF-8".into()),
            ("PYTHONDONTWRITEBYTECODE".into(), "1".into()),
        ]),
    )
    .unwrap();
    let input=serde_json::to_vec(&json!({"target":target,"authoring":authoring,"upstream":{},"label":label,"materialize":write,"createdAt":"2026-07-10T00:00:00+00:00"})).unwrap();
    let request = BoundedProcessRequestV1 {
        executable,
        arguments: vec![
            "-c".into(),
            include_str!("../runner_contract_oracle.py").into(),
            directory.path.clone().into_os_string(),
            parent.as_os_str().into(),
        ],
        working_directory: directory.path.clone(),
        environment,
        stdin: Some(input),
    };
    let limits = ProcessLimitsV1 {
        timeout_ms: 120000,
        maximum_stdin_bytes: 65536,
        maximum_stdout_bytes: 4 * 1024 * 1024,
        maximum_stderr_bytes: 1024 * 1024,
        maximum_tail_bytes: 65536,
        termination_grace_ms: 100,
        cleanup_timeout_ms: 2000,
        ..ProcessLimitsV1::default()
    };
    let result = run_bounded_process_capturing_stdout_with_cancellation(
        &request,
        limits,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        result.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(
        result.process.exit_code,
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.process.stderr_tail)
    );
    assert!(result.process.process_group_cleanup_verified);
    serde_json::from_slice(&result.stdout).unwrap()
}
fn files(directory: &Directory) -> Value {
    fn walk(base: &Path, path: &Path, out: &mut Vec<Value>) {
        let mut names: Vec<_> = fs::read_dir(path)
            .unwrap()
            .map(|v| v.unwrap().path())
            .collect();
        names.sort();
        for name in names {
            let m = fs::symlink_metadata(&name).unwrap();
            if m.is_dir() {
                walk(base, &name, out);
            } else if m.is_file() && !m.is_symlink() {
                let bytes = fs::read(&name).unwrap();
                out.push(json!({"path":name.strip_prefix(base).unwrap().to_str().unwrap(),"bytesHex":hex::encode(&bytes),"sha256":super::super::super::digest(&bytes),"mode":m.mode()&0o777}));
            }
        }
    }
    let mut result = Vec::new();
    walk(&directory.path, &directory.path, &mut result);
    json!(result)
}
fn pair(
    tree: &mut super::super::PrivateTree,
    native: &Directory,
    python: &Directory,
    target: &Value,
    authoring: &Value,
    write: bool,
    label: &str,
) -> Value {
    let actual = materialize(
        native,
        target,
        authoring,
        &json!({}),
        label,
        write,
        "2026-07-10T00:00:00+00:00",
    )
    .unwrap();
    let expected = oracle(tree, python, target, authoring, write, label);
    assert_eq!(actual, expected["report"]);
    assert_eq!(files(native), expected["files"]);
    assert_eq!(actual["external_action_authorized"], false);
    assert_eq!(actual["external_action_performed"], false);
    assert_eq!(actual["summary"]["runner_ready_claim_allowed"], false);
    actual
}
#[test]
fn actual_retired_python_full_report_bytes_hashes_create_valid_retry_stale_and_invalid_are_matched()
{
    let mut tree = root();
    let native = directory(&mut tree, "test/native");
    let python = directory(&mut tree, "test/python");
    let (target, mut authoring) = inputs();
    let created = pair(
        &mut tree, &native, &python, &target, &authoring, true, "fixture",
    );
    assert_eq!(created["status"], "PASS");
    assert_eq!(created["summary"]["materialized_contract_count"], 1);
    let retry = pair(
        &mut tree, &native, &python, &target, &authoring, true, "fixture",
    );
    assert_eq!(retry["summary"]["materialized_contract_count"], 0);
    authoring["authoring_surface_matrix"][0]["external_lifecycle_readiness_report"] =
        json!("new.json");
    let stale = pair(
        &mut tree, &native, &python, &target, &authoring, true, "fixture",
    );
    assert_eq!(stale["summary"]["materialized_contract_count"], 1);
    for dir in [&native, &python] {
        let selected = dir
            .path
            .join("logs/paperctl/_contracts/runner_execution/fixture.json");
        let mut value: Value = serde_json::from_slice(&fs::read(&selected).unwrap()).unwrap();
        value["external_action_authorized"] = json!(true);
        fs::write(selected, encode_payload(&value).unwrap()).unwrap();
    }
    let invalid = pair(
        &mut tree, &native, &python, &target, &authoring, true, "fixture",
    );
    assert_eq!(invalid["status"], "FAIL");
    assert_eq!(invalid["summary"]["materialized_contract_count"], 0);
    assert!(
        invalid["contract_artifact_queue"][0]["validation_issues"]
            .as_array()
            .unwrap()
            .contains(&json!("external_action_authorized_not_false"))
    );
    tree.cleanup().unwrap();
}
#[test]
fn actual_private_python_no_write_blocked_inputs_unicode_live_queue_order_and_bad_json_match() {
    let mut tree = root();
    let (target, authoring) = inputs();
    for profile in [
        "missing",
        "target-blocked",
        "authoring-blocked",
        "unicode-live",
        "queue-order",
        "malformed",
        "not-object",
        "symlink",
        "outside",
        "absolute",
    ] {
        let native = directory(&mut tree, &format!("cases/{profile}/native"));
        let python = directory(&mut tree, &format!("cases/{profile}/python"));
        let (mut target, mut authoring) = (target.clone(), authoring.clone());
        let mut write = true;
        let mut label = "fixture";
        match profile {
            "missing" => write = false,
            "target-blocked" => target["status"] = json!("FAIL"),
            "authoring-blocked" => authoring["summary"]["authoring_surface_ready"] = json!(false),
            "unicode-live" => {
                label = "é\u{7f}𝄞";
                authoring["authoring_surface_matrix"][0]["contract_kind"] =
                    json!("live_entrypoint_adapter");
                authoring["authoring_surface_matrix"][0]["entrypoint"] = json!("local-entrypoint");
            }
            "queue-order" => {
                let mut second = authoring["authoring_surface_matrix"][0].clone();
                second["expected_contract_path"] =
                    json!("logs/paperctl/_contracts/runner_execution/second.json");
                second["expected_contract_id"] = json!("second-contract");
                second["route_id"] = json!("earlier-route");
                authoring["authoring_surface_matrix"]
                    .as_array_mut()
                    .unwrap()
                    .push(second);
            }
            "malformed" | "not-object" => {
                for dir in [&native, &python] {
                    let parent =
                        Directory::open_or_create(&dir.path.join(CONTRACT_ROOT), true).unwrap();
                    parent
                        .write_new(
                            "fixture.json",
                            if profile == "malformed" {
                                b"{"
                            } else {
                                b"null"
                            },
                        )
                        .unwrap();
                }
            }
            "symlink" => {
                for dir in [&native, &python] {
                    let parent =
                        Directory::open_or_create(&dir.path.join(CONTRACT_ROOT), true).unwrap();
                    parent.write_new("target.json", b"{}").unwrap();
                    std::os::unix::fs::symlink("target.json", parent.path.join("fixture.json"))
                        .unwrap();
                }
                write = false;
            }
            "outside" => {
                authoring["authoring_surface_matrix"][0]["expected_contract_path"] =
                    json!("outside.json")
            }
            "absolute" => {
                authoring["authoring_surface_matrix"][0]["expected_contract_path"] = json!(
                    tree.directory("absolute-contained")
                        .unwrap()
                        .join("missing-contract.json")
                        .to_str()
                        .unwrap()
                )
            }
            _ => unreachable!(),
        }
        let value = pair(
            &mut tree, &native, &python, &target, &authoring, write, label,
        );
        if [
            "missing",
            "target-blocked",
            "authoring-blocked",
            "outside",
            "absolute",
        ]
        .contains(&profile)
        {
            assert_eq!(files(&native), json!([]));
            assert_eq!(value["status"], "FAIL");
        }
        // The existing private cleanup deliberately retains unknown symlinks;
        // this test owns and removes only its exact fixture aliases first.
        if profile == "symlink" {
            for dir in [&native, &python] {
                fs::remove_file(dir.path.join(CONTRACT_ROOT).join("fixture.json")).unwrap();
            }
        }
    }
    tree.cleanup().unwrap();
}
#[test]
fn typed_input_and_held_private_namespace_refuse_float_budget_hardlink_fifo_and_parent_alias() {
    let mut tree = root();
    let (target, authoring) = inputs();
    let native = directory(&mut tree, "refusals/native");
    let mut float = target.clone();
    float["summary"]["target_paper_count"] = json!(1.5);
    assert!(
        materialize(
            &native,
            &float,
            &authoring,
            &json!({}),
            "fixture",
            true,
            "fixed"
        )
        .is_err()
    );
    assert_eq!(files(&native), json!([]));
    let mut oversized = authoring.clone();
    oversized["label"] = json!("x".repeat(4097));
    assert!(materialize(&native, &target, &oversized, &json!({}), "", true, "fixed").is_err());
    assert_eq!(files(&native), json!([]));
    let parent = Directory::open_or_create(&native.path.join(CONTRACT_ROOT), true).unwrap();
    parent.write_new("fixture.json", b"{}").unwrap();
    fs::hard_link(
        parent.path.join("fixture.json"),
        parent.path.join("link.json"),
    )
    .unwrap();
    assert!(
        materialize(
            &native,
            &target,
            &authoring,
            &json!({}),
            "fixture",
            false,
            "fixed"
        )
        .is_err()
    );
    fs::remove_file(parent.path.join("link.json")).unwrap();
    fs::remove_file(parent.path.join("fixture.json")).unwrap();
    nix::unistd::mkfifo(
        &parent.path.join("fixture.json"),
        Mode::from_bits_truncate(0o600),
    )
    .unwrap();
    let value = materialize(
        &native,
        &target,
        &authoring,
        &json!({}),
        "fixture",
        false,
        "fixed",
    )
    .unwrap();
    assert_eq!(value["status"], "FAIL");
    fs::remove_file(parent.path.join("fixture.json")).unwrap();
    fs::rename(native.path.join("logs"), native.path.join("original-logs")).unwrap();
    std::os::unix::fs::symlink("original-logs", native.path.join("logs")).unwrap();
    assert!(
        materialize(
            &native,
            &target,
            &authoring,
            &json!({}),
            "fixture",
            true,
            "fixed"
        )
        .is_err()
    );
    fs::remove_file(native.path.join("logs")).unwrap();
    fs::rename(native.path.join("original-logs"), native.path.join("logs")).unwrap();
    tree.cleanup().unwrap();
}

#[test]
fn retained_artifact_rejects_same_bytes_rewrite_and_replacement_before_or_after_oracle() {
    let mut tree = root();
    let native = directory(&mut tree, "retained/native");
    let (target, authoring) = inputs();
    materialize(
        &native,
        &target,
        &authoring,
        &json!({}),
        "fixture",
        true,
        "fixed",
    )
    .unwrap();
    let selected = "logs/paperctl/_contracts/runner_execution/fixture.json";
    let held = observe_artifact(&native, selected).unwrap();
    held.assert_current().unwrap();
    fs::write(native.path.join(selected), &held.bytes).unwrap();
    assert!(held.assert_current().is_err());
    let held = observe_artifact(&native, selected).unwrap();
    let path = native.path.join(selected);
    let bytes = held.bytes.clone();
    fs::remove_file(&path).unwrap();
    fs::write(&path, &bytes).unwrap();
    assert!(held.assert_current().is_err());
    tree.cleanup().unwrap();
}

// These checkpoints exist only in the Rust test ELF. Product execution never
// reads the fixture environment or parks at a publication phase.
fn hold_completed_result(root: &Directory, phase: &str, artifact: &ObservedArtifact) {
    use std::os::unix::fs::OpenOptionsExt;
    root.assert_current().unwrap();
    let barrier = root.path.join("materializer-phase-held-fd");
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(&barrier)
        .unwrap();
    file.write_all(phase.as_bytes()).unwrap();
    file.sync_all().unwrap();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::hint::black_box((&file, artifact));
    }
}
#[test]
#[ignore = "child helper invoked only by pinned_materializer_term_kill_completed_operation_cleanup_and_fresh_api_retry"]
fn private_materializer_phase_child() {
    let path = std::env::var_os("HEPTA_TEST_RUNNER_CONTRACT_ROOT").expect("owned root required");
    let phase = std::env::var("HEPTA_TEST_RUNNER_CONTRACT_CHECKPOINT").expect("phase required");
    assert!(["after-create", "after-stale", "after-read"].contains(&phase.as_str()));
    let directory = Directory::open_or_create(Path::new(&path), false).unwrap();
    let (target, authoring) = inputs();
    let result = materialize(
        &directory,
        &target,
        &authoring,
        &json!({}),
        "fixture",
        true,
        "fixed",
    )
    .unwrap();
    assert_eq!(result["status"], "PASS");
    assert_eq!(
        result["summary"]["materialized_contract_count"],
        if phase == "after-read" { 0 } else { 1 }
    );
    let artifact = observe_artifact(
        &directory,
        "logs/paperctl/_contracts/runner_execution/fixture.json",
    )
    .unwrap();
    artifact.assert_current().unwrap();
    // The actual native operation completed and its file is held, but no report
    // was returned to the caller when TERM/KILL removes this child.
    hold_completed_result(&directory, &phase, &artifact);
}
#[derive(Clone, Debug, PartialEq)]
struct ChildPin {
    pid: u32,
    uid: u32,
    group: u32,
    session: u32,
    start: String,
}
fn child_pin(pid: u32) -> Option<ChildPin> {
    let base = std::path::PathBuf::from(format!("/proc/{pid}"));
    let raw = fs::read_to_string(base.join("stat")).ok()?;
    let fields = raw
        .rsplit_once(')')?
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    if fields.len() < 20 || fields[0] == "Z" {
        return None;
    }
    let metadata = fs::metadata(&base).ok()?;
    Some(ChildPin {
        pid,
        uid: metadata.uid(),
        group: fields[2].parse().ok()?,
        session: fields[3].parse().ok()?,
        start: fields[19].into(),
    })
}
fn barrier_is_held(pid: u32, barrier: &Path) -> bool {
    let Ok(named) = fs::symlink_metadata(barrier) else {
        return false;
    };
    if !named.is_file()
        || named.is_symlink()
        || named.nlink() != 1
        || named.mode() & 0o777 != 0o600
        || named.uid() != nix::unistd::getuid().as_raw()
    {
        return false;
    }
    let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    for (count, entry) in entries.enumerate() {
        if count >= 256 {
            return false;
        }
        let Ok(entry) = entry else {
            return false;
        };
        if fs::read_link(entry.path()).ok().as_deref() != Some(barrier) {
            continue;
        }
        let Ok(held) = fs::metadata(entry.path()) else {
            return false;
        };
        return same(&named, &held);
    }
    false
}
fn private_test_elf(tree: &mut super::super::PrivateTree) -> std::path::PathBuf {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let current = std::env::current_exe().unwrap();
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(&current)
        .unwrap();
    let before = file.metadata().unwrap();
    assert!(before.is_file() && before.nlink() == 1 && before.len() <= 256 * 1024 * 1024);
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(before.len() + 1)
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes.len() as u64, before.len());
    assert!(
        same(&before, &file.metadata().unwrap())
            && same(&before, &fs::symlink_metadata(&current).unwrap())
    );
    let path = tree
        .directory("driver")
        .unwrap()
        .join("materializer-test-child");
    fs::write(&path, &bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(fs::read(&path).unwrap(), bytes);
    path
}
#[test]
fn pinned_materializer_term_kill_completed_operation_cleanup_and_fresh_api_retry() {
    use hepta_codex_runtime::{BoundedProcessError, run_bounded_process_with_spawn_hook};
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;
    use std::time::{Duration, Instant};
    for phase in ["after-create", "after-stale", "after-read"] {
        for signal in [Signal::SIGTERM, Signal::SIGKILL] {
            let mut tree = root();
            let native = directory(&mut tree, "runtime/native");
            let executable = private_test_elf(&mut tree);
            let (target, authoring) = inputs();
            if phase != "after-create" {
                let mut original_authoring = authoring.clone();
                if phase == "after-stale" {
                    original_authoring["authoring_surface_matrix"][0]["external_lifecycle_readiness_report"] =
                        json!("stale.json");
                }
                materialize(
                    &native,
                    &target,
                    &original_authoring,
                    &json!({}),
                    "fixture",
                    true,
                    "fixed",
                )
                .unwrap();
            }
            let values = BTreeMap::from([
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("LANG".into(), "C.UTF-8".into()),
                ("LC_ALL".into(), "C.UTF-8".into()),
                (
                    "HEPTA_TEST_RUNNER_CONTRACT_ROOT".into(),
                    native.path.to_string_lossy().into_owned(),
                ),
                ("HEPTA_TEST_RUNNER_CONTRACT_CHECKPOINT".into(), phase.into()),
            ]);
            let environment = EnvironmentPolicyV1::new(
                "private-local-materializer-real-signal-fixture-v1",
                values.keys().cloned(),
                ["PATH", "LANG", "LC_ALL"],
            )
            .unwrap()
            .build(std::iter::empty::<(OsString, OsString)>(), &values)
            .unwrap();
            let request=BoundedProcessRequestV1{executable,arguments:vec!["--exact".into(),"release_replay::execution::policy::runner_contract::tests::private_materializer_phase_child".into(),"--ignored".into(),"--nocapture".into(),"--test-threads=1".into()],working_directory:native.path.clone(),environment,stdin:None};
            let limits = ProcessLimitsV1 {
                timeout_ms: 60000,
                maximum_stdin_bytes: 65536,
                maximum_stdout_bytes: 65536,
                maximum_stderr_bytes: 65536,
                maximum_tail_bytes: 65536,
                termination_grace_ms: 100,
                cleanup_timeout_ms: 2000,
                ..ProcessLimitsV1::default()
            };
            let barrier = native.path.join("materializer-phase-held-fd");
            let mut observed = None;
            tree.process_cleanup(false);
            let result = run_bounded_process_with_spawn_hook(&request, limits, |pid| {
                let pin = child_pin(pid).ok_or(BoundedProcessError::SpawnHookRejected)?;
                if pin.uid != nix::unistd::getuid().as_raw() || pin.group != pid {
                    return Err(BoundedProcessError::SpawnHookRejected);
                }
                let deadline = Instant::now() + Duration::from_secs(30);
                loop {
                    if child_pin(pid).as_ref() != Some(&pin) {
                        return Err(BoundedProcessError::SpawnHookRejected);
                    }
                    if barrier_is_held(pid, &barrier) {
                        break;
                    }
                    if Instant::now() >= deadline {
                        return Err(BoundedProcessError::SpawnHookRejected);
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                if child_pin(pid).as_ref() != Some(&pin) || !barrier_is_held(pid, &barrier) {
                    return Err(BoundedProcessError::SpawnHookRejected);
                }
                kill(Pid::from_raw(pid as i32), signal)
                    .map_err(|_| BoundedProcessError::SpawnHookRejected)?;
                observed = Some(pin);
                Ok(())
            })
            .unwrap();
            tree.process_cleanup(result.process_group_cleanup_verified);
            assert!(result.process_group_cleanup_verified);
            assert_eq!(result.signal, Some(signal as i32));
            assert_eq!(result.exit_code, None);
            assert_eq!(result.process_id, observed.as_ref().unwrap().pid);
            let resumed = materialize(
                &native,
                &target,
                &authoring,
                &json!({}),
                "fixture",
                true,
                "fixed",
            )
            .unwrap();
            assert_eq!(resumed["status"], "PASS");
            assert_eq!(resumed["summary"]["materialized_contract_count"], 0);
            assert_eq!(resumed["external_action_authorized"], false);
            observe_artifact(
                &native,
                "logs/paperctl/_contracts/runner_execution/fixture.json",
            )
            .unwrap()
            .assert_current()
            .unwrap();
            let path = tree.sources().parent().unwrap().to_owned();
            tree.cleanup().unwrap();
            assert!(!path.exists());
            let mut fresh = root();
            let fresh_directory = directory(&mut fresh, "runtime/native");
            let report = materialize(
                &fresh_directory,
                &target,
                &authoring,
                &json!({}),
                "fixture",
                true,
                "fixed",
            )
            .unwrap();
            assert_eq!(report["status"], "PASS");
            assert_eq!(report["summary"]["materialized_contract_count"], 1);
            fresh.cleanup().unwrap();
            eprintln!(
                "{}",
                json!({"scope":"test_ELF_private_local_contract_after_completed_write_boundary_only","phase":phase,"signal":signal as i32,"processId":result.process_id,"uid":observed.as_ref().unwrap().uid,"group":observed.as_ref().unwrap().group,"session":observed.as_ref().unwrap().session,"startTime":observed.as_ref().unwrap().start,"actualHeldFdBarrierObserved":true,"verifiedGroupCleanup":result.process_group_cleanup_verified,"sameNamespaceApiRetry":true,"sameOwnerTreeDeleted":true,"freshApiReexecution":true,"installedPersistentWriterQualified":false,"authorityGranted":false})
            );
        }
    }
}

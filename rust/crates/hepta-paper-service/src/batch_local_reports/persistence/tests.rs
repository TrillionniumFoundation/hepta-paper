use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{ffi::OsString, time::Duration};
fn original_node_cases(
    fixture: &crate::batch_operator::tests::Fixture,
    cases: serde_json::Value,
) -> serde_json::Value {
    let script = format!(
        "{}\n{}",
        include_str!("../../release_replay/oracle-input-guard.mjs"),
        r#"import fs from 'node:fs';import path from 'node:path';import {verifyArtifactWriteReceiptSource} from './paper-adapters/artifacts/artifact-write-receipt-verifier.mjs';import {readMaterializationJsonRecordSync,verifyScopedMaterializationOperationDefinitionRecord,verifyScopedMaterializationOperationRecord,buildScopedMaterializationOperationRecord,scopedMaterializationOperationRecordName} from './paper-adapters/runtime/scoped-file-materialization-recovery-record.mjs';const input=readBoundedReplayInput('referee');const actual=input.cases.map(c=>{if(c.args.length!==1)throw new Error('receipt_case');if(c.name==='verify_local_receipt')return verifyArtifactWriteReceiptSource({receipt:JSON.parse(c.args[0])});if(c.name==='build_prepared'){const original=JSON.parse(c.args[0]);const record=buildScopedMaterializationOperationRecord({...original.binding,...original,status:'prepared',completedPostimageIdentity:null});const name=scopedMaterializationOperationRecordName(record.binding.operationId,'prepared',record.binding.relative);verifyScopedMaterializationOperationRecord(record,name,'prepared');return {status:'original_node_prepared_verified',wire:JSON.stringify(record),name};}if(c.name!=='verify_legacy_completed')throw new Error('legacy_case');const root=path.join(c.args[0],'.hepta-materialization-recovery');let definitions=0,completed=0;for(const name of fs.readdirSync(root)){const {record}=readMaterializationJsonRecordSync({candidate:path.join(root,name),name,maximumBytes:65536,unsafeCode:'legacy_fixture'});if(name.startsWith('.definition-')){verifyScopedMaterializationOperationDefinitionRecord(record,name);definitions++;}else{verifyScopedMaterializationOperationRecord(record,name,'completed');completed++;}}return {status:'original_node_legacy_completed_verified',definitions,completed};});process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},actual}));"#
    );
    let environment = EnvironmentPolicyV1::new(
        "native-local-persist-actual-receipt-verifier-v1",
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
    let stdin =
        serde_json::to_vec(&serde_json::json!({"version":1,"baseCaseCount":0,"cases":cases}))
            .unwrap();
    let result = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: PathBuf::from(
                std::env::var_os("HEPTA_TEST_NODE").expect("existing qualified producer Node"),
            ),
            arguments: vec!["--input-type=module".into(), "--eval".into(), script.into()],
            working_directory: fixture.code.clone(),
            environment,
            stdin: Some(stdin),
        },
        ProcessLimitsV1 {
            timeout_ms: 60000,
            maximum_stdin_bytes: 1024 * 1024,
            maximum_stdout_bytes: 1024 * 1024,
            maximum_stderr_bytes: 64 * 1024,
            maximum_tail_bytes: 8192,
            ..ProcessLimitsV1::default()
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        result.process.termination_reason,
        ProcessTerminationReason::Exited,
        "{}",
        String::from_utf8_lossy(&result.process.stderr_tail)
    );
    assert_eq!(result.process.exit_code, Some(0));
    assert!(result.process.process_group_cleanup_verified);
    let value: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(
        value["profile"],
        serde_json::json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    value
}
fn verify_original_node(fixture: &crate::batch_operator::tests::Fixture, receipts: &[Vec<u8>]) {
    let mut cases=receipts.iter().map(|v|serde_json::json!({"name":"verify_local_receipt","args":[std::str::from_utf8(v).unwrap()]})).collect::<Vec<_>>();
    cases.push(serde_json::json!({"name":"verify_legacy_completed","args":[fixture.base.join("runtime").to_str().unwrap()]}));
    let value = original_node_cases(fixture, serde_json::Value::Array(cases));
    for item in value["actual"].as_array().unwrap() {
        if item["status"] == "original_node_legacy_completed_verified" {
            assert_eq!(item["definitions"], 5);
            assert_eq!(item["completed"], 5);
        } else {
            assert_eq!(
                item["status"], "artifact_write_receipt_source_verified",
                "{item}"
            );
        }
    }
}
#[test]
fn actual_node_report_input_native_persistence_retains_database_and_original_receipt_sources() {
    let (fixture, value) = super::super::tests::actual_five_report_fixture();
    let wire = value["reportWire"].as_str().unwrap().as_bytes();
    let runtime = fixture.base.join("runtime");
    let database = crate::state_recoverability::files::ObservedFile::open(
        &runtime.join("hepta-paper.sqlite"),
        16 * 1024 * 1024,
    )
    .unwrap();
    let before = database.bytes(16 * 1024 * 1024).unwrap();
    let cancelled = AtomicBool::new(false);
    eprintln!(
        "actual Node report runtime={} selectedRuntime={}",
        serde_json::from_str::<serde_json::Value>(value["reportWire"].as_str().unwrap()).unwrap()["runtimeRoot"],
        runtime.display()
    );
    let actual = persist(
        &runtime,
        wire,
        &cancelled,
        Instant::now() + Duration::from_secs(60),
        &|phase| {
            eprintln!("actual local artifact phase={phase}");
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(actual.receipts.len(), 5);
    assert_eq!(actual.legacy_completed_receipts_retained, 5);
    assert!(!actual.old_authority_records_adopted);
    assert!(!actual.writer_trusted && !actual.business_store_mutated);
    assert!(actual.retained_unprepared.is_empty());
    database.assert_current().unwrap();
    assert_eq!(database.bytes(16 * 1024 * 1024).unwrap(), before);
    verify_original_node(&fixture, &actual.receipts);
    let retry = persist_native_local_batch_report_v1(
        &runtime,
        wire,
        &cancelled,
        Instant::now() + Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!(retry.receipts, actual.receipts);
    database.assert_current().unwrap();
    assert_eq!(database.bytes(16 * 1024 * 1024).unwrap(), before);
    verify_original_node(&fixture, &retry.receipts);
    println!(
        "originalNodeReceiptSources=5 actualNativeArtifacts=5 exactSameInputRetry=true businessStoreMutated=false writerTrusted=false authority=false installed=false"
    );
}

// Reuses the held Child + actual UID/startTime + fixed30s cleanup lifecycle
// already used by command_surface::publication::tests; this child runs only
// the local writer and cannot spawn provider/broker/external descendants.
use nix::{
    sys::signal::{Signal, kill},
    unistd::{Pid, getuid},
};
use std::{
    os::unix::{fs::PermissionsExt, process::ExitStatusExt},
    process::{Child, Command, ExitStatus, Stdio},
};
struct OwnedChild {
    process: Child,
    captured: Option<(u32, String)>,
}
impl OwnedChild {
    fn new(process: Child) -> Self {
        let mut value = Self {
            process,
            captured: None,
        };
        value.captured = Some(identity(value.process.id()));
        assert_eq!(value.captured.as_ref().unwrap().0, getuid().as_raw());
        value
    }
    fn wait(&mut self) -> ExitStatus {
        let start = Instant::now();
        loop {
            if let Some(status) = self.process.try_wait().unwrap() {
                return status;
            }
            assert!(
                start.elapsed() < Duration::from_secs(30),
                "owned local writer did not close within original30s"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.process.try_wait().ok().flatten().is_some() {
            return;
        }
        if self.captured.as_ref().is_some_and(|v| {
            std::panic::catch_unwind(|| identity(self.process.id()))
                .ok()
                .as_ref()
                != Some(v)
        }) {
            eprintln!(
                "owned local report cleanup identity unverified pid={}",
                self.process.id()
            );
            return;
        }
        if self.process.kill().is_err() {
            eprintln!(
                "owned local report cleanup kill unverified pid={}",
                self.process.id()
            );
            return;
        }
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(30) {
            if self.process.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        if std::thread::panicking() {
            eprintln!(
                "owned local report cleanup exceeded30s pid={}",
                self.process.id()
            );
        } else {
            panic!(
                "owned local report cleanup exceeded30s pid={}",
                self.process.id()
            );
        }
    }
}
fn identity(pid: u32) -> (u32, String) {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    let uid = status
        .lines()
        .find(|v| v.starts_with("Uid:"))
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
    (uid, fields[19].into())
}
fn child(input: &Path, barrier: &Path, phase: &str, log: &Path) -> OwnedChild {
    let output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(log)
        .unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .env_clear()
        .args([
            "--exact",
            "batch_local_reports::persistence::tests::local_report_process_child_entry",
            "--ignored",
            "--nocapture",
        ])
        .env("HEPTA_LOCAL_REPORT_TEST_INPUT", input)
        .env("HEPTA_LOCAL_REPORT_TEST_BARRIER", barrier)
        .env("HEPTA_LOCAL_REPORT_TEST_PHASE", phase)
        .stdout(Stdio::from(output.try_clone().unwrap()))
        .stderr(Stdio::from(output));
    OwnedChild::new(command.spawn().unwrap())
}
#[test]
#[ignore = "owned local report death/recovery fixture; parent actual test owns signals and fresh retry"]
fn local_report_process_child_entry() {
    let input = PathBuf::from(
        std::env::var_os("HEPTA_LOCAL_REPORT_TEST_INPUT").expect("test-only held input"),
    );
    let barrier = PathBuf::from(std::env::var_os("HEPTA_LOCAL_REPORT_TEST_BARRIER").unwrap());
    let phase = std::env::var("HEPTA_LOCAL_REPORT_TEST_PHASE").unwrap();
    let source =
        crate::state_recoverability::files::ObservedFile::open(&input, 16 * 1024 * 1024).unwrap();
    let wire = source.bytes(16 * 1024 * 1024).unwrap();
    let report = admission(
        &wire,
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    let runtime = PathBuf::from(text(get(&report, "runtimeRoot").unwrap()).unwrap());
    let hook = |actual: &str| -> Result<(), String> {
        if !phase.is_empty() && phase == actual {
            let parent = Directory::open_or_create(barrier.parent().unwrap(), false)
                .map_err(|_| refused())?;
            parent
                .write_new(
                    barrier.file_name().unwrap().to_str().unwrap(),
                    actual.as_bytes(),
                )
                .map_err(|_| refused())?;
            loop {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        Ok(())
    };
    let result = persist(
        &runtime,
        &wire,
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(60),
        &hook,
    )
    .unwrap();
    assert_eq!(result.receipts.len(), 5);
    assert!(!result.writer_trusted && !result.business_store_mutated);
    source.assert_current().unwrap();
}
fn relocated_report(value: &serde_json::Value, runtime: &Path) -> Vec<u8> {
    let mut report =
        parse_production_json_v1(value["reportWire"].as_str().unwrap().as_bytes()).unwrap();
    let Json::Object(fields) = &mut report else {
        panic!("actual Node object")
    };
    fields.retain(|(k, _)| *k != key("reportHash"));
    *fields
        .iter_mut()
        .find(|(k, _)| *k == key("runtimeRoot"))
        .unwrap() = (key("runtimeRoot"), string(runtime.to_str().unwrap()));
    let hash = hash(
        "PaperBatchRunReport",
        &report,
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    let Json::Object(fields) = &mut report else {
        unreachable!()
    };
    fields.push((key("reportHash"), string(&hash)));
    production_json_stringify_with_limits_v1(&report, limits(), &AtomicBool::new(false)).unwrap()
}
#[test]
fn actual_sigterm_and_sigkill_local_report_boundaries_retain_torn_unprepared_and_fresh_recover() {
    let (fixture, value) = super::super::tests::actual_five_report_fixture();
    let phases = [
        "unprepared_created",
        "unprepared_objects",
        "unprepared_partial_replacement",
        "before_prepared",
        "prepared",
        "public_cas",
        "before_materialize",
        "after_materialize",
        "materialized_synced",
        "records_prepared",
        "manifest",
        "ledger",
        "done",
        "compaction_prepared",
        "compaction_unlinked",
        "compacted",
        "immutable_partial_copy",
        "immutable_copy_synced",
    ];
    for (ordinal, phase) in phases.iter().enumerate() {
        for signal in [Signal::SIGTERM, Signal::SIGKILL] {
            let case = fixture.base.join(format!("death-{ordinal}-{signal:?}"));
            fs::create_dir(&case).unwrap();
            fs::set_permissions(&case, fs::Permissions::from_mode(0o700)).unwrap();
            let runtime = case.join("runtime");
            fs::create_dir(&runtime).unwrap();
            fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
            let wire = relocated_report(&value, &runtime);
            let input = case.join("input.json");
            Directory::open_or_create(&case, false)
                .unwrap()
                .write_new("input.json", &wire)
                .unwrap();
            assert_eq!(fs::metadata(&input).unwrap().mode() & 0o7777, 0o600);
            let barrier = case.join("barrier");
            let mut process = child(&input, &barrier, phase, &case.join("first.log"));
            let captured = identity(process.process.id());
            let start = Instant::now();
            loop {
                if let Ok(file) =
                    crate::state_recoverability::files::ObservedFile::open(&barrier, 1024)
                {
                    assert_eq!(file.bytes(1024).unwrap(), phase.as_bytes());
                    break;
                }
                if let Some(status) = process.process.try_wait().unwrap() {
                    panic!(
                        "phase {phase} ended before barrier {status}: {}",
                        fs::read_to_string(case.join("first.log")).unwrap()
                    );
                }
                assert!(
                    start.elapsed() < Duration::from_secs(30),
                    "local report actual phase {phase} did not arrive in original30s"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(identity(process.process.id()), captured);
            let busy = persist_native_local_batch_report_v1(
                &runtime,
                &wire,
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(5),
            )
            .unwrap_err();
            assert!(busy.contains("publication_busy"), "{busy}");
            kill(Pid::from_raw(process.process.id() as i32), signal).unwrap();
            assert_eq!(process.wait().signal(), Some(signal as i32));
            let mut retry = child(&input, &barrier, "", &case.join("retry.log"));
            let status = retry.wait();
            assert!(
                status.success(),
                "phase {phase} retry {status}: {}",
                fs::read_to_string(case.join("retry.log")).unwrap()
            );
            let settled = persist_native_local_batch_report_v1(
                &runtime,
                &wire,
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(60),
            )
            .unwrap();
            assert_eq!(settled.receipts.len(), 5);
            if phase.starts_with("unprepared")
                || *phase == "before_prepared"
                || phase.starts_with("immutable_")
            {
                assert!(!settled.retained_unprepared.is_empty());
            }
            assert!(!settled.writer_trusted && !settled.business_store_mutated);
            println!(
                "phase={phase} signal={signal:?} pid={} start={} freshRetry={} outputs=5 authority=false",
                process.process.id(),
                captured.1,
                retry.process.id()
            );
        }
    }
}

fn isolated_case(
    fixture: &crate::batch_operator::tests::Fixture,
    value: &serde_json::Value,
    label: &str,
) -> (PathBuf, Vec<u8>) {
    let runtime = fixture.base.join(format!("local-{label}"));
    fs::create_dir(&runtime).unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let wire = relocated_report(value, &runtime);
    (runtime, wire)
}
fn detail_target(runtime: &Path, wire: &[u8]) -> PathBuf {
    let value = prepare_native_local_report_detail_v1(
        wire,
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    runtime.join("reports").join(value.artifact.relative_path)
}
fn prepared_directory(runtime: &Path) -> PathBuf {
    let paths = fs::read_dir(runtime.join("local-report-publication-v1"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("prepared-")
        })
        .collect::<Vec<_>>();
    assert_eq!(paths.len(), 1);
    paths[0].clone()
}
fn private_bytes(path: &Path) -> Vec<u8> {
    let source =
        crate::state_recoverability::files::ObservedFile::open(path, 16 * 1024 * 1024).unwrap();
    let bytes = source.bytes(16 * 1024 * 1024).unwrap();
    source.assert_current().unwrap();
    bytes
}
#[test]
fn foreign_target_and_displaced_bytes_are_retained_without_inverse_or_adoption() {
    let (fixture, value) = super::super::tests::actual_five_report_fixture();
    for (label, existing, after) in [
        ("missing-pre-syscall", false, false),
        ("existing-pre-syscall", true, false),
        ("existing-after-syscall", true, true),
    ] {
        let (runtime, wire) = isolated_case(&fixture, &value, label);
        let target = detail_target(&runtime, &wire);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        if existing {
            fs::write(&target, b"original report preimage").unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let foreign = runtime.join("foreign-candidate");
        fs::write(&foreign, b"foreign report bytes, preserve exactly").unwrap();
        fs::set_permissions(&foreign, fs::Permissions::from_mode(0o600)).unwrap();
        let foreign_before = fs::metadata(&foreign).unwrap();
        let fired = AtomicBool::new(false);
        let hook = |phase: &str| -> Result<(), String> {
            if phase
                == if after {
                    "after_materialize"
                } else {
                    "before_materialize_syscall"
                }
                && !fired.swap(true, Ordering::SeqCst)
            {
                let foreign = foreign.clone();
                let target = target.clone();
                std::thread::spawn(move || fs::rename(&foreign, &target).unwrap())
                    .join()
                    .unwrap();
            }
            Ok(())
        };
        let error = persist(
            &runtime,
            &wire,
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(60),
            &hook,
        )
        .unwrap_err();
        assert!(fired.load(Ordering::SeqCst));
        assert!(error.contains("unknown"), "{error}");
        let prepared = prepared_directory(&runtime);
        let retained = if existing && !after {
            prepared.join("replacement")
        } else {
            target.clone()
        };
        assert_eq!(
            private_bytes(&retained),
            b"foreign report bytes, preserve exactly"
        );
        let retained_before = publication::Witness::of(&fs::metadata(&retained).unwrap());
        let retained_metadata = fs::metadata(&retained).unwrap();
        assert_eq!(
            (
                retained_metadata.dev(),
                retained_metadata.ino(),
                retained_metadata.uid(),
                retained_metadata.gid(),
                retained_metadata.mode(),
                retained_metadata.len()
            ),
            (
                foreign_before.dev(),
                foreign_before.ino(),
                foreign_before.uid(),
                foreign_before.gid(),
                foreign_before.mode(),
                foreign_before.len()
            )
        );
        if existing {
            let original_hash = publication::hash_bytes(b"original report preimage");
            assert_eq!(
                private_bytes(&prepared.join("objects").join(&original_hash[7..])),
                b"original report preimage"
            );
        }
        let retry = persist_native_local_batch_report_v1(
            &runtime,
            &wire,
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(60),
        )
        .unwrap_err();
        assert!(retry.contains("unknown"), "{retry}");
        assert_eq!(
            private_bytes(&retained),
            b"foreign report bytes, preserve exactly"
        );
        assert_eq!(
            publication::Witness::of(&fs::metadata(&retained).unwrap()),
            retained_before
        );
        println!(
            "actualConcurrentCase={label} foreignSHA={} inode={} unknownRetained=true inverse=false",
            publication::hash_bytes(&private_bytes(&retained)),
            retained_metadata.ino()
        );
    }
    let (runtime, wire) = isolated_case(&fixture, &value, "done-target-replaced");
    let actual = persist_native_local_batch_report_v1(
        &runtime,
        &wire,
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!(actual.receipts.len(), 5);
    let outputs = prepare_native_local_report_outputs_v1(
        &wire,
        &actual.receipts[0],
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    let target = runtime.join("reports").join(
        &outputs
            .iter()
            .find(|v| v.role == "paper_batch_current_report_pointer")
            .unwrap()
            .relative_path,
    );
    assert!(target.exists());
    let foreign = runtime.join("post-commit-foreign");
    fs::write(&foreign, b"foreign completed pointer").unwrap();
    fs::set_permissions(&foreign, fs::Permissions::from_mode(0o600)).unwrap();
    fs::rename(&foreign, &target).unwrap();
    let before = publication::Witness::of(&fs::metadata(&target).unwrap());
    assert!(
        persist_native_local_batch_report_v1(
            &runtime,
            &wire,
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(60)
        )
        .is_err()
    );
    assert_eq!(private_bytes(&target), b"foreign completed pointer");
    assert_eq!(
        publication::Witness::of(&fs::metadata(&target).unwrap()),
        before
    );
}
#[test]
fn cancellation_deadline_alias_and_foreign_namespace_refuse_and_keep_fresh_recovery() {
    let (fixture, value) = super::super::tests::actual_five_report_fixture();
    for (label, cancelled, expired) in [
        ("cancel-at-admission", true, false),
        ("expired-at-admission", false, true),
    ] {
        let (runtime, wire) = isolated_case(&fixture, &value, label);
        let deadline = if expired {
            Instant::now() - Duration::from_millis(1)
        } else {
            Instant::now() + Duration::from_secs(60)
        };
        assert!(
            persist_native_local_batch_report_v1(
                &runtime,
                &wire,
                &AtomicBool::new(cancelled),
                deadline
            )
            .is_err()
        );
        assert!(fs::read_dir(&runtime).unwrap().next().is_none());
        assert_eq!(
            persist_native_local_batch_report_v1(
                &runtime,
                &wire,
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(60)
            )
            .unwrap()
            .receipts
            .len(),
            5
        );
    }
    for phase in ["before_prepared", "prepared"] {
        let (runtime, wire) = isolated_case(&fixture, &value, phase);
        let cancelled = AtomicBool::new(false);
        let error = persist(
            &runtime,
            &wire,
            &cancelled,
            Instant::now() + Duration::from_secs(60),
            &|actual| {
                if actual == phase {
                    cancelled.store(true, Ordering::SeqCst)
                }
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.contains("cancel"), "{error}");
        let retry = persist_native_local_batch_report_v1(
            &runtime,
            &wire,
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(retry.receipts.len(), 5);
        if phase == "before_prepared" {
            assert!(!retry.retained_unprepared.is_empty())
        }
    }
    let (runtime, wire) = isolated_case(&fixture, &value, "deadline-before-prepared");
    let deadline = Instant::now() + Duration::from_secs(2);
    let reached = AtomicBool::new(false);
    let error = persist(
        &runtime,
        &wire,
        &AtomicBool::new(false),
        deadline,
        &|phase| {
            if phase == "before_prepared" {
                reached.store(true, Ordering::SeqCst);
                std::thread::sleep(
                    deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(1),
                );
            }
            Ok(())
        },
    )
    .unwrap_err();
    assert!(reached.load(Ordering::SeqCst));
    assert!(error.contains("deadline"), "{error}");
    assert_eq!(
        persist_native_local_batch_report_v1(
            &runtime,
            &wire,
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(60)
        )
        .unwrap()
        .receipts
        .len(),
        5
    );
    let (runtime, wire) = isolated_case(&fixture, &value, "foreign-namespace");
    let _ = open(
        &runtime,
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    let foreign = runtime.join("local-report-publication-v1/foreign-record.json");
    fs::write(&foreign, b"unrecognized recovery record").unwrap();
    fs::set_permissions(&foreign, fs::Permissions::from_mode(0o600)).unwrap();
    let before = publication::Witness::of(&fs::metadata(&foreign).unwrap());
    let error = persist_native_local_batch_report_v1(
        &runtime,
        &wire,
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(60),
    )
    .unwrap_err();
    assert!(error.contains("foreign_recovery"), "{error}");
    assert_eq!(private_bytes(&foreign), b"unrecognized recovery record");
    assert_eq!(
        publication::Witness::of(&fs::metadata(&foreign).unwrap()),
        before
    );
    let (runtime, wire) = isolated_case(&fixture, &value, "reports-alias");
    let alias = runtime.join("reports");
    std::os::unix::fs::symlink(fixture.base.join("runtime/reports"), &alias).unwrap();
    assert!(
        persist_native_local_batch_report_v1(
            &runtime,
            &wire,
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(60)
        )
        .is_err()
    );
    assert!(fs::symlink_metadata(&alias).unwrap().is_symlink());
    let (runtime, wire) = isolated_case(&fixture, &value, "world-write");
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(
        persist_native_local_batch_report_v1(
            &runtime,
            &wire,
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(60)
        )
        .is_err()
    );
    assert!(fs::read_dir(&runtime).unwrap().next().is_none());
}

#[test]
fn original_node_prepared_partial_hash_and_foreign_vault_records_are_retained_without_native_effects()
 {
    let (fixture, value) = super::super::tests::actual_five_report_fixture();
    let wire = value["reportWire"].as_str().unwrap().as_bytes();
    let runtime = fixture.base.join("runtime");
    let vault = runtime.join(".hepta-materialization-recovery");
    let mut completed = fs::read_dir(&vault)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.to_str().unwrap().ends_with(".completed.json"))
        .collect::<Vec<_>>();
    completed.sort();
    assert_eq!(completed.len(), 5);
    let completed = &completed[0];
    let original = fs::read(completed).unwrap();
    let prepared = original_node_cases(
        &fixture,
        serde_json::json!([{"name":"build_prepared","args":[std::str::from_utf8(&original).unwrap()]}]),
    );
    let prepared = &prepared["actual"][0];
    assert_eq!(prepared["status"], "original_node_prepared_verified");
    let cancelled = AtomicBool::new(false);
    for kind in ["prepared", "partial", "hash", "foreign_lease"] {
        let (selected, restore) = match kind {
            "prepared" => {
                let path = vault.join(prepared["name"].as_str().unwrap());
                fs::write(&path, prepared["wire"].as_str().unwrap()).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
                (path, false)
            }
            "partial" => {
                fs::remove_file(completed).unwrap();
                (completed.clone(), true)
            }
            "hash" => {
                let mut changed = original.clone();
                let offset = changed
                    .iter()
                    .rposition(|b| *b == b'0' || *b == b'1')
                    .unwrap();
                changed[offset] = if changed[offset] == b'0' { b'1' } else { b'0' };
                fs::write(completed, changed).unwrap();
                (completed.clone(), true)
            }
            "foreign_lease" => {
                let path = vault.join(".foreign.lease.json");
                fs::write(&path, b"{\"unknown\":true,\"authorityGranted\":false}").unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
                (path, false)
            }
            _ => unreachable!(),
        };
        let before = fixture_namespace(&runtime);
        let result = persist_native_local_batch_report_v1(
            &runtime,
            wire,
            &cancelled,
            Instant::now() + Duration::from_secs(60),
        );
        assert!(result.is_err(), "actual legacy {kind} unexpectedly adopted");
        assert_eq!(
            fixture_namespace(&runtime),
            before,
            "{kind} changed retained namespace"
        );
        assert!(!runtime.join("local-report-publication-v1").exists());
        println!(
            "legacy {kind}: native refused, all raw files/metadata/names retained; authority=false"
        );
        if restore {
            fs::write(&selected, &original).unwrap();
            fs::set_permissions(&selected, fs::Permissions::from_mode(0o600)).unwrap();
        } else {
            fs::remove_file(&selected).unwrap();
        }
    }
    let result = persist_native_local_batch_report_v1(
        &runtime,
        wire,
        &cancelled,
        Instant::now() + Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!(result.legacy_completed_receipts_retained, 5);
    assert!(!result.old_authority_records_adopted);
    verify_original_node(&fixture, &result.receipts);
}

fn fixture_namespace(root: &Path) -> BTreeMap<PathBuf, (publication::Witness, Option<Vec<u8>>)> {
    fn walk(path: &Path, result: &mut BTreeMap<PathBuf, (publication::Witness, Option<Vec<u8>>)>) {
        assert!(result.len() < 512, "bounded small fixture namespace");
        let metadata = fs::symlink_metadata(path).unwrap();
        assert!(!metadata.is_symlink());
        let raw = if metadata.is_file() {
            assert!(metadata.len() <= 16 * 1024 * 1024);
            let observed =
                crate::state_recoverability::files::ObservedFile::open(path, 16 * 1024 * 1024)
                    .unwrap();
            Some(observed.bytes(16 * 1024 * 1024).unwrap())
        } else {
            assert!(metadata.is_dir());
            None
        };
        result.insert(path.to_owned(), (publication::Witness::of(&metadata), raw));
        if metadata.is_dir() {
            for entry in fs::read_dir(path).unwrap() {
                walk(&entry.unwrap().path(), result);
            }
        }
        let after = fs::symlink_metadata(path).unwrap();
        assert_eq!(
            publication::Witness::of(&metadata),
            publication::Witness::of(&after)
        );
    }
    let mut result = BTreeMap::new();
    walk(root, &mut result);
    result
}

//! Actual compiled command over the original ten-database fixtures. The
//! configured executable is /usr/bin/false: planning must never invoke it.
use super::*;
use hepta_legacy_compatibility::production_hash_record_v1;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}
struct CliFixture {
    owner: Fixture,
    setup: Value,
    process_path: PathBuf,
    process_hash: String,
}
impl CliFixture {
    fn new(oracle: &mut Oracle, version: u8) -> Self {
        let owner = Fixture {
            root: PathBuf::from(format!(
                "/tmp/hepta-schema-source-rust-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            )),
            role: String::new(),
        };
        let result =
            oracle.call(json!({"operation":"full-fixture","root":owner.root,"version":version}));
        assert_eq!(result["ok"], true, "{result}");
        let setup = result["value"].clone();
        let command = owner.root.join("non-invoked-client");
        fs::copy("/usr/bin/false", &command).unwrap();
        fs::set_permissions(&command, fs::Permissions::from_mode(0o700)).unwrap();
        let process_path = owner.root.join("process.json");
        let bytes=serde_json::to_vec(&json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityProcessConfiguration",
            "authorityConfigurationPath":setup["configurationPath"],"authorityConfigurationSha256":setup["configurationFileHash"],
            "commandPath":command,"commandSha256":digest(&fs::read(&command).unwrap()),"fixedArguments":[],"timeoutMs":1000})).unwrap();
        fs::write(&process_path, &bytes).unwrap();
        fs::set_permissions(&process_path, fs::Permissions::from_mode(0o600)).unwrap();
        Self {
            owner,
            setup,
            process_path,
            process_hash: digest(&bytes),
        }
    }
    fn args(&self) -> Vec<String> {
        let mut args = vec![
            "--action".into(),
            "plan".into(),
            "--runtime-root".into(),
            self.setup["runtimeRoot"].as_str().unwrap().into(),
            "--authority-process-config".into(),
            self.process_path.to_str().unwrap().into(),
        ];
        if let Some(pin) = self.setup["expectedPreRebindPristineRuntimeStateHash"].as_str() {
            args.extend([
                "--expected-pre-rebind-pristine-runtime-state-hash".into(),
                pin.into(),
            ]);
        }
        args
    }
    fn native_args(&self) -> Vec<String> {
        let mut args = self.args();
        args.extend([
            "--authority-process-config-sha256".into(),
            self.process_hash.clone(),
        ]);
        args
    }
    fn native(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"));
        c.arg("autonomous-online-schema-transition")
            .args(self.native_args());
        c
    }
    fn runtime(&self) -> &Path {
        Path::new(self.setup["runtimeRoot"].as_str().unwrap())
    }
}
fn snapshot(root: &Path) -> Vec<(PathBuf, Value)> {
    fn walk(path: &Path, rows: &mut Vec<(PathBuf, Value)>) {
        let m = fs::symlink_metadata(path).unwrap();
        let data = if m.is_file() {
            json!(digest(&fs::read(path).unwrap()))
        } else if m.file_type().is_symlink() {
            json!(fs::read_link(path).unwrap())
        } else {
            Value::Null
        };
        rows.push((
            path.into(),
            json!([
                m.dev(),
                m.ino(),
                m.mode(),
                m.uid(),
                m.gid(),
                m.nlink(),
                m.len(),
                m.mtime(),
                m.mtime_nsec(),
                m.ctime(),
                m.ctime_nsec(),
                data
            ]),
        ));
        if m.is_dir() {
            let mut children = fs::read_dir(path)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect::<Vec<_>>();
            children.sort();
            for p in children {
                walk(&p, rows);
            }
        }
    }
    let mut rows = Vec::new();
    walk(root, &mut rows);
    rows
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap()
}
fn normalize(report: &mut Value, begin: i64, end: i64) {
    let plan = &mut report["plan"];
    let time =
        hepta_paper_service::journal_connector_coverage::qualification::canonical_instant_millis(
            plan["plannedAt"].as_str().unwrap(),
        )
        .unwrap();
    assert!(
        begin <= time && time <= end,
        "real CLI clock outside invocation"
    );
    let mut payload = plan.as_object().unwrap().clone();
    let declared = payload.remove("planHash").unwrap();
    payload.remove("transitionId");
    assert_eq!(
        declared,
        production_hash_record_v1(
            "AutonomousResearchOnlineSchemaTransitionPlan",
            &Value::Object(payload)
        )
        .unwrap()
        .as_str()
    );
    plan["planHash"] = Value::Null;
    plan["plannedAt"] = Value::Null;
}
fn native_report(fixture: &CliFixture) -> Value {
    let before = snapshot(&fixture.owner.root);
    let begin = now();
    let output = fixture.native().output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let mut report: Value = serde_json::from_slice(&output.stdout).unwrap();
    normalize(&mut report, begin, now());
    assert_eq!(report["plan"]["instances"].as_array().unwrap().len(), 10);
    assert_eq!(report["readinessScope"], "fresh_native_source_plan_only");
    for field in [
        "authorityInvoked",
        "executionAuthority",
        "releaseAuthority",
        "submissionAuthority",
        "productionActivation",
        "nodeRetirement",
    ] {
        assert_eq!(report[field], false);
        report.as_object_mut().unwrap().remove(field);
    }
    report.as_object_mut().unwrap().remove("readinessScope");
    assert_eq!(
        snapshot(&fixture.owner.root),
        before,
        "native planning changed source bytes or metadata"
    );
    report
}
#[test]
fn ordinary_schema_plan_matches_node_initial_and_rebind_without_source_writes() {
    let mut oracle = Oracle::new();
    for version in [1, 2] {
        let fixture = CliFixture::new(&mut oracle, version);
        let original = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../paper-core/bin/autonomous-research-online-schema-transition.mjs");
        let begin = now();
        let output = Command::new("node")
            .arg(original)
            .args(fixture.args())
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(0),
            "Node: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut expected: Value = serde_json::from_slice(&output.stdout).unwrap();
        normalize(&mut expected, begin, now());
        let report = native_report(&fixture);
        assert_eq!(report, expected, "v{version} full report");
        let replay = native_report(&fixture);
        assert_eq!(
            replay, report,
            "fresh read-only retry must preserve the exact transition subject"
        );
    }
}
#[test]
fn ordinary_v2_pristine_review_precedes_the_independently_pinned_plan() {
    let mut oracle = Oracle::new();
    let fixture = CliFixture::new(&mut oracle, 2);
    let before = snapshot(&fixture.owner.root);
    let mut args = fixture.native_args();
    let action = args.iter().position(|v| v == "--action").unwrap();
    args[action + 1] = "inspect-pristine".into();
    if let Some(index) = args
        .iter()
        .position(|v| v == "--expected-pre-rebind-pristine-runtime-state-hash")
    {
        args.drain(index..=index + 1);
    }
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("autonomous-online-schema-transition")
        .args(&args)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["kind"],
        "AutonomousResearchPristineSchemaRebindPreimageObservation"
    );
    assert_eq!(report["instanceCount"], 10);
    assert_eq!(
        report["prePristineRuntimeStateHash"],
        fixture.setup["expectedPreRebindPristineRuntimeStateHash"]
    );
    assert_eq!(report["mutationPerformed"], false);
    assert_eq!(report["authorityInvoked"], false);
    assert_eq!(snapshot(&fixture.owner.root), before);

    let planned = fixture.native().output().unwrap();
    assert_eq!(
        planned.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&planned.stderr)
    );
    let planned: Value = serde_json::from_slice(&planned.stdout).unwrap();
    assert_eq!(
        planned["plan"]["prePristineRuntimeStateHash"],
        report["prePristineRuntimeStateHash"]
    );
    assert_eq!(snapshot(&fixture.owner.root), before);

    let mut forbidden = fixture.native_args();
    let action = forbidden.iter().position(|v| v == "--action").unwrap();
    forbidden[action + 1] = "inspect-pristine".into();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("autonomous-online-schema-transition")
        .args(forbidden)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("expected_pre_rebind_state_forbidden_in_inspection")
    );
    assert_eq!(snapshot(&fixture.owner.root), before);
}

#[test]
fn ordinary_schema_plan_refuses_existing_control_and_pinned_input_substitution() {
    let mut oracle = Oracle::new();
    let fixture = CliFixture::new(&mut oracle, 1);
    for name in [
        "missing_pin",
        "wrong_pin",
        "unknown",
        "duplicate",
        "relative_root",
    ] {
        let mut args = fixture.native_args();
        match name {
            "missing_pin" => {
                args.truncate(args.len() - 2);
            }
            "wrong_pin" => {
                *args.last_mut().unwrap() = digest(b"not the observed configuration");
            }
            "unknown" => args.push("--unregistered-flag".into()),
            "duplicate" => args.extend(["--action".into(), "plan".into()]),
            _ => {
                let i = args.iter().position(|a| a == "--runtime-root").unwrap();
                args[i + 1] = "relative".into();
            }
        }
        let before = snapshot(&fixture.owner.root);
        let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
            .arg("autonomous-online-schema-transition")
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1), "{name}");
        assert!(output.stdout.is_empty());
        assert_eq!(snapshot(&fixture.owner.root), before);
    }
    let control = fixture
        .runtime()
        .join("autonomous-research/online-schema-transition");
    fs::create_dir(&control).unwrap();
    fs::write(control.join("ACTIVE.json"), b"retained unresolved state").unwrap();
    let before = snapshot(&fixture.owner.root);
    let output = fixture.native().output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("existing_control_requires_recovery"));
    assert_eq!(snapshot(&fixture.owner.root), before);
}
#[test]
fn ordinary_schema_execute_is_rejected_before_reading_runtime_or_authority() {
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "autonomous-online-schema-transition",
            "--action",
            "execute",
            "--execute",
            "--transition-id",
        ])
        .arg(digest(
            b"a syntactically valid but nonauthorizing transition",
        ))
        .args([
            "--runtime-root",
            "/unreadable/runtime",
            "--authority-process-config",
            "/unreadable/config",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("native_execute_requires_installed_owner")
    );
}

#[test]
fn schema_plan_final_observation_rejects_drift_and_retains_concurrent_bytes() {
    use hepta_paper_service::online_schema_execution::cli::schema_transition_plan_cli_v1;
    let mut oracle = Oracle::new();
    for scenario in ["trust", "command", "database", "control", "clock"] {
        let fixture = CliFixture::new(&mut oracle, 1);
        let mut sample = 0;
        let time = now();
        let mut expected = snapshot(&fixture.owner.root);
        let result = schema_transition_plan_cli_v1(&fixture.native_args(), &mut || {
            sample += 1;
            if sample == 2 {
                match scenario {
                    "trust" => {
                        let path = Path::new(fixture.setup["configurationPath"].as_str().unwrap());
                        let mut bytes = fs::read(path).unwrap();
                        bytes.push(b' ');
                        fs::write(path, bytes).unwrap();
                    }
                    "command" => {
                        let path = fixture.owner.root.join("non-invoked-client");
                        let mut bytes = fs::read(&path).unwrap();
                        bytes.push(0);
                        fs::write(path, bytes).unwrap();
                    }
                    "database" => {
                        let role = fixture.setup["stateDatabaseManifest"]["databases"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|row| row["role"] == "native-store")
                            .unwrap();
                        let database = rusqlite::Connection::open(
                            fixture
                                .runtime()
                                .join(role["relativePath"].as_str().unwrap()),
                        )
                        .unwrap();
                        database
                            .execute_batch("CREATE TABLE concurrent_business_change(id TEXT);")
                            .unwrap();
                        drop(database);
                    }
                    "control" => {
                        fs::create_dir(
                            fixture
                                .runtime()
                                .join("autonomous-research/online-schema-transition"),
                        )
                        .unwrap();
                    }
                    _ => {}
                }
                expected = snapshot(&fixture.owner.root);
                if scenario == "clock" {
                    return Ok(time - 1);
                }
            }
            Ok(time)
        });
        assert!(
            result.is_err(),
            "{scenario}: stale inputs yielded a ready plan"
        );
        assert_eq!(sample, 2, "{scenario}: final observation was not reached");
        assert_eq!(
            snapshot(&fixture.owner.root),
            expected,
            "{scenario}: concurrent bytes were changed or repaired"
        );
    }
}

#[test]
fn ordinary_schema_plan_rejects_common_invalid_modes_like_node() {
    let mut oracle = Oracle::new();
    let fixture = CliFixture::new(&mut oracle, 1);
    let original = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-core/bin/autonomous-research-online-schema-transition.mjs");
    for (tail, code) in [
        (
            vec!["--requested-lease-ms", "0"],
            "requested_lease_ms_invalid",
        ),
        (
            vec!["--required-execution-window-ms", "120001"],
            "execution_window_invalid",
        ),
        (
            vec!["--required-execution-window-ms", "1000"],
            "safety_margin_invalid",
        ),
        (vec!["--action", "plan"], "duplicate_cli_option:--action"),
        (vec!["--execute"], "execute_action_required"),
        (
            vec!["--commit-safety-margin-ms", "1"],
            "execute_option_forbidden_in_plan",
        ),
    ] {
        let before = snapshot(&fixture.owner.root);
        let node = Command::new("node")
            .arg(&original)
            .args(fixture.args())
            .args(&tail)
            .output()
            .unwrap();
        let native = fixture.native().args(&tail).output().unwrap();
        for (implementation, output) in [("node", node), ("rust", native)] {
            assert_eq!(output.status.code(), Some(1), "{implementation}: {tail:?}");
            assert!(output.stdout.is_empty());
            assert!(
                String::from_utf8_lossy(&output.stderr).contains(code),
                "{implementation}: {tail:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        assert_eq!(snapshot(&fixture.owner.root), before);
    }
}
#[test]
fn ordinary_schema_plan_process_death_preserves_source_and_retries_without_adoption() {
    use std::{
        os::unix::process::ExitStatusExt,
        thread,
        time::{Duration, Instant},
    };
    let mut oracle = Oracle::new();
    let fixture = CliFixture::new(&mut oracle, 1);
    let expected = native_report(&fixture);
    let scratch = fixture.owner.root.join("private-planning-copies");
    fs::create_dir(&scratch).unwrap();
    fs::set_permissions(&scratch, fs::Permissions::from_mode(0o700)).unwrap();
    let before = snapshot(fixture.runtime());
    let mut child = fixture
        .native()
        .env("TMPDIR", &scratch)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if fs::read_dir(&scratch).unwrap().next().is_some() {
            break;
        }
        if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!(
                "ordinary planner did not reach private-copy execution: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        thread::sleep(Duration::from_millis(1));
    }
    child.kill().unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.signal(), Some(9));
    assert_eq!(snapshot(fixture.runtime()), before);
    let orphans = fs::read_dir(&scratch)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect::<Vec<_>>();
    let retained = orphans
        .iter()
        .map(|p| (p.clone(), snapshot(p)))
        .collect::<Vec<_>>();
    let begin = now();
    let output = fixture.native().env("TMPDIR", &scratch).output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut actual: Value = serde_json::from_slice(&output.stdout).unwrap();
    normalize(&mut actual, begin, now());
    assert_eq!(actual["plan"], expected["plan"]);
    assert_eq!(snapshot(fixture.runtime()), before);
    for (path, bytes) in retained {
        assert_eq!(
            snapshot(&path),
            bytes,
            "retry changed an interrupted private copy"
        );
    }
}

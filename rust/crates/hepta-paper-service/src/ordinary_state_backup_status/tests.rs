use super::*;
use serde_json::json;
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    data: Value,
}
fn oracle(input: Value) -> Value {
    let node = std::env::var_os("HEPTA_TEST_NODE").expect("qualified HEPTA_TEST_NODE required");
    let mut child = Command::new(node)
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../oracle/state-backup-cli-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&input).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&response["profile"]).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    response["value"].clone()
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-backup-cli-e2e-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let data = oracle(json!({"root":root,"mode":"fixture"}));
        Self { root, data }
    }
    fn path(&self, key: &str) -> PathBuf {
        PathBuf::from(self.data[key].as_str().unwrap())
    }
    fn context(&self) -> StateBackupCliContextV1 {
        StateBackupCliContextV1 {
            workspace_root: self.path("workspace"),
            working_directory: self.path("workspace"),
            environment: BTreeMap::from([(
                "HEPTA_PAPER_RUNTIME_ROOT".into(),
                self.path("runtime").display().to_string(),
            )]),
        }
    }
    fn original(&self, argv: &[String]) -> Value {
        oracle(
            json!({"mode":"command","root":self.root,"cwd":self.path("workspace"),"argv":argv,"environment":{"HEPTA_PAPER_RUNTIME_ROOT":self.path("runtime")}}),
        )
    }
    fn native(&self, argv: &[String]) -> Value {
        match run_with_context(
            argv,
            &self.context(),
            &Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(120),
        ) {
            Ok(out) => {
                let report: Option<Value> = serde_json::from_slice(&out.stdout).ok();
                json!({"exitCode":out.exit_code,"stdout":if report.is_none(){Some(String::from_utf8(out.stdout).unwrap())}else{None},"report":report,"error":null})
            }
            Err(cause) => json!({"exitCode":1,"stdout":"","report":null,"error":cause}),
        }
    }
    fn compare(&self, argv: &[String]) -> Value {
        let value = self.native(argv);
        assert_eq!(value, self.original(argv), "{argv:?}");
        value
    }
    fn calls(&self) -> String {
        fs::read_to_string(self.root.join("calls.jsonl")).unwrap_or_default()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).into()).collect()
}

#[test]
fn ordinary_default_status_help_errors_and_passive_profiles_match_original_node() {
    let f = Fixture::new();
    for argv in [
        vec![],
        args(&["--action=status"]),
        args(&["--bundle=ignored"]),
        args(&["--help"]),
        args(&["--help", "--action=unknown"]),
        args(&["--help=true"]),
        args(&["--help", "--help"]),
        args(&["--"]),
        args(&["--=x"]),
        args(&["x"]),
        args(&["--unknown"]),
        args(&["--action"]),
        args(&["--action="]),
        args(&["--action", "--help"]),
        args(&["--action", "status", "--action", "backup"]),
        args(&["--action=unknown"]),
        args(&["--action=restore-drill"]),
        args(&["--action=reconcile-and-renew"]),
        args(&["--root=x"]),
        args(&["--authority-socket-config=x"]),
    ] {
        f.compare(&argv);
    }
    for key in ["backupConfiguration", "onlineProcess"] {
        let flag = if key == "backupConfiguration" {
            "--authority-config"
        } else {
            "--online-authority-process-config"
        };
        let argv = vec![flag.into(), f.path(key).display().to_string()];
        assert_eq!(f.compare(&argv)["exitCode"], 0);
    }
    let bad = vec![
        "--authority-config".into(),
        f.root.join("missing.json").display().to_string(),
    ];
    f.compare(&bad);
    assert!(
        f.calls().is_empty(),
        "status must not invoke either authority process"
    );
    let nonexistent = StateBackupCliContextV1 {
        workspace_root: f.root.join("absent-root"),
        working_directory: f.root.clone(),
        environment: BTreeMap::new(),
    };
    for argv in [
        args(&["--action=backup"]),
        args(&["--action=renew"]),
        args(&["--action=restore-drill", "--bundle=x"]),
        args(&[
            "--action=reconcile-and-renew",
            "--authority-config=x",
            "--online-authority-process-config=x",
        ]),
    ] {
        assert_eq!(
            run_with_context(
                &argv,
                &nonexistent,
                &Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(120)
            )
            .err()
            .unwrap(),
            "autonomous_research_state_backup_ordinary_readonly_action_required"
        );
    }
    eprintln!(
        "actual_default_status_and_original_grammar=true; actual_passive_authority_calls=0; writer_modes_refused=true"
    );
}

#[test]
fn ordinary_status_retains_wal_and_blocked_inventory_through_constructor_order_wire() {
    let f = Fixture::new();
    let path = f.path("runtime").join(
        f.data["manifest"]["databases"][0]["relativePath"]
            .as_str()
            .unwrap(),
    );
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE status_wal_only(id TEXT); INSERT INTO status_wal_only VALUES('committed');").unwrap();
    let before = fs::read(&path).unwrap();
    let wal = fs::read(format!("{}-wal", path.display())).unwrap();
    let value = f.compare(&[]);
    assert_eq!(value["exitCode"], 0);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(fs::read(format!("{}-wal", path.display())).unwrap(), wal);
    let node = std::env::var_os("HEPTA_TEST_NODE").unwrap();
    let original = Command::new(node)
        .arg("--import")
        .arg(f.path("preload"))
        .arg(
            f.path("workspace")
                .join("paper-core/bin/autonomous-research-state-backup.mjs"),
        )
        .current_dir(f.path("workspace"))
        .env("HEPTA_PAPER_RUNTIME_ROOT", f.path("runtime"))
        .output()
        .unwrap();
    let native = run_with_context(
        &[],
        &f.context(),
        &Arc::new(AtomicBool::new(false)),
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap();
    assert_eq!(native.stdout, original.stdout);
    assert!(original.status.success());
    writer.close().unwrap();
    let empty = f.root.join("empty");
    fs::create_dir(&empty).unwrap();
    let argv = vec!["--runtime-root".into(), empty.display().to_string()];
    assert_eq!(f.compare(&argv)["exitCode"], 2);
    assert!(f.calls().is_empty());
    eprintln!(
        "actual_wal_whole_value_and_raw_stdout=true; actual_semantic_blocked_exit=2; no_source_db_write=true"
    );
}

#[test]
fn ordinary_status_original_cancel_deadline_and_named_change_refuse_with_fresh_retry() {
    let f = Fixture::new();
    let context = f.context();
    let flag = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + Duration::from_secs(120);
    let observed =
        match observe_ordinary_state_backup_status_v1(&[], &context, &flag, deadline).unwrap() {
            StateBackupStatusReadV1::Observed(value) => value,
            _ => panic!("status observation required"),
        };
    flag.store(true, Ordering::Release);
    assert!(
        observed
            .check_control()
            .unwrap_err()
            .code
            .ends_with("cancelled")
    );
    flag.store(false, Ordering::Release);
    assert!(observed.finish().unwrap_err().code.ends_with("cancelled"));
    assert!(
        run_with_context(
            &[],
            &context,
            &flag,
            Instant::now() - Duration::from_millis(1)
        )
        .err()
        .unwrap()
        .ends_with("deadline_exceeded")
    );
    assert_eq!(
        run_with_context(
            &[],
            &context,
            &flag,
            Instant::now() + Duration::from_secs(120)
        )
        .unwrap()
        .exit_code,
        0
    );
    let observed = match observe_ordinary_state_backup_status_v1(
        &[],
        &context,
        &flag,
        Instant::now() + Duration::from_secs(120),
    )
    .unwrap()
    {
        StateBackupStatusReadV1::Observed(value) => value,
        _ => panic!("status observation required"),
    };
    let manifest = context
        .workspace_root
        .join("paper-core/config/autonomous-research-state-databases.v1.json");
    let replacement = manifest.with_extension("replacement");
    fs::copy(&manifest, &replacement).unwrap();
    fs::rename(replacement, &manifest).unwrap();
    let mut output = Output {
        bytes: Vec::new(),
        observed: &observed,
    };
    serde_json::to_writer_pretty(&mut output, &OrderedReport(observed.report())).unwrap();
    assert!(
        observed
            .finish()
            .unwrap_err()
            .code
            .contains("manifest_file_changed")
    );
    assert_eq!(
        run_with_context(
            &[],
            &context,
            &flag,
            Instant::now() + Duration::from_secs(120)
        )
        .unwrap()
        .exit_code,
        0
    );
    assert!(f.calls().is_empty());
    eprintln!(
        "actual_retained_cancel_sticky_deadline_named_replace=true; actual_fresh_retry=true; no_authority_calls=true"
    );
}

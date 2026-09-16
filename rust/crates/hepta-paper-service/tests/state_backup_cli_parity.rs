//! Actual incumbent CLI, real private ten-SQLite state and signed subprocesses.
use hepta_paper_service::state_recoverability::cli::{
    StateBackupCliContextV1, StateBackupCliOutputV1, state_backup_cli_v1,
    state_backup_writer_manifest_v1,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
const NOW: i64 = 1_789_560_000_000;
static NEXT: AtomicU64 = AtomicU64::new(0);
fn oracle(input: Value) -> Value {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(repository.join("rust/oracle/state-backup-cli-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
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
struct Fixture {
    root: PathBuf,
    data: Value,
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
    fn context(&self, environment: BTreeMap<String, String>) -> StateBackupCliContextV1 {
        StateBackupCliContextV1 {
            workspace_root: self.path("workspace"),
            working_directory: self.root.clone(),
            environment,
        }
    }
    fn native(&self, argv: &[String], environment: BTreeMap<String, String>) -> Value {
        match state_backup_cli_v1(argv, &self.context(environment), &mut || Ok(NOW)) {
            Ok(StateBackupCliOutputV1::Help(usage)) => {
                json!({"exitCode":0,"report":null,"stdout":format!("{usage}\n"),"error":null})
            }
            Ok(StateBackupCliOutputV1::Report { report, exit_code }) => {
                json!({"exitCode":exit_code,"report":report,"stdout":null,"error":null})
            }
            Err(cause) => json!({"exitCode":1,"report":null,"stdout":"","error":cause}),
        }
    }
    fn original(&self, argv: &[String], environment: BTreeMap<String, String>) -> Value {
        oracle(json!({"mode":"command","root":self.root,"argv":argv,"environment":environment}))
    }
    fn argv(&self, action: &str) -> Vec<String> {
        vec![
            "--action".into(),
            action.into(),
            "--runtime-root".into(),
            self.path("runtime").display().to_string(),
            "--authority-config".into(),
            self.path("backupConfiguration").display().to_string(),
        ]
    }
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(self.root.join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn clear_calls(&self) {
        let _ = fs::remove_file(self.root.join("calls.jsonl"));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).into()).collect()
}
fn json_file(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
#[test]
fn original_complete_cli_arguments_help_defaults_status_and_blocked_exit_match() {
    let f = Fixture::new();
    assert_eq!(
        state_backup_writer_manifest_v1().unwrap(),
        oracle(json!({"mode":"writer"}))
    );
    let cases = vec![
        vec!["--help"],
        vec!["--help", "--action", "unknown"],
        vec!["--help=true"],
        vec!["--help", "--help"],
        vec!["--"],
        vec!["--=x"],
        vec!["x"],
        vec!["--unknown"],
        vec!["--action"],
        vec!["--action="],
        vec!["--action", "--help"],
        vec!["--action", "status", "--action", "backup"],
        vec!["--action", "unknown"],
        vec!["--action", "restore-drill"],
        vec!["--action", "reconcile-and-renew"],
        vec!["--action", "reconcile-and-renew", "--authority-config", "x"],
        vec!["--runtime-root", "missing"],
        vec!["--runtime-root", "runtime/../runtime"],
        vec!["--action=backup", "--runtime-root=runtime"],
        vec!["--action=renew", "--runtime-root=runtime"],
        vec![
            "--action=restore-drill",
            "--bundle=missing",
            "--runtime-root=runtime",
        ],
    ];
    for case in cases {
        let argv = args(&case);
        assert_eq!(
            f.native(&argv, BTreeMap::new()),
            f.original(&argv, BTreeMap::new()),
            "{argv:?}"
        );
    }
    let env = BTreeMap::from([("HEPTA_PAPER_RUNTIME_ROOT".into(), "runtime".into())]);
    assert_eq!(f.native(&[], env.clone()), f.original(&[], env));
    let empty = f.root.join("empty");
    fs::create_dir(&empty).unwrap();
    let argv = args(&["--runtime-root", "empty"]);
    let native = f.native(&argv, BTreeMap::new());
    assert_eq!(native["exitCode"], 2);
    assert_eq!(native, f.original(&argv, BTreeMap::new()));
    assert!(f.calls().is_empty());
}
#[test]
fn actual_backup_process_ten_databases_and_original_node_drill_agree() {
    let f = Fixture::new();
    let args = f.argv("backup");
    let original = f.original(&args, BTreeMap::new());
    assert_eq!(original["exitCode"], 0, "{original}");
    let old_path = PathBuf::from(original["report"]["bundlePath"].as_str().unwrap());
    let old = json_file(old_path.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json"));
    let old_bytes = old["content"]["databases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| fs::read(old_path.join(e["backupRelativePath"].as_str().unwrap())).unwrap())
        .collect::<Vec<_>>();
    fs::remove_dir_all(&old_path).unwrap();
    f.clear_calls();
    let native = f.native(&args, BTreeMap::new());
    assert_eq!(native["exitCode"], 0, "{native}");
    let path = PathBuf::from(native["report"]["bundlePath"].as_str().unwrap());
    let bundle = json_file(path.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json"));
    assert_eq!(
        f.calls()
            .iter()
            .map(|q| q["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "AutonomousResearchStateBackupAuthorityReserveRequest",
            "AutonomousResearchStateBackupAuthorityFinalizeRequest"
        ]
    );
    let mut old_content = old["content"].clone();
    for ((previous, entry), old_entry) in old_bytes
        .iter()
        .zip(bundle["content"]["databases"].as_array().unwrap())
        .zip(old_content["databases"].as_array_mut().unwrap())
    {
        let current = fs::read(path.join(entry["backupRelativePath"].as_str().unwrap())).unwrap();
        assert_eq!(current.len(), previous.len());
        assert!(
            current
                .iter()
                .zip(previous)
                .enumerate()
                .all(|(index, (a, b))| a == b || (96..100).contains(&index))
        );
        old_entry["backupSha256"] = entry["backupSha256"].clone();
    }
    assert_eq!(old_content, bundle["content"]);
    let mut drill = f.argv("restore-drill");
    drill.extend(["--bundle".into(), path.display().to_string()]);
    let actual = f.native(&drill, BTreeMap::new());
    assert_eq!(actual["exitCode"], 0, "{actual}");
    assert_eq!(actual, f.original(&drill, BTreeMap::new()));
    assert!(path.join("RESTORE_DRILL_RECEIPT.json").exists());
    let retained_receipt = fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap();
    fs::write(f.root.join("broker-mode"), "bad-signature").unwrap();
    let denied = f.native(&drill, BTreeMap::new());
    assert_eq!(denied["exitCode"], 2);
    assert_eq!(
        denied["report"]["bundleManifestHash"],
        bundle["bundleManifestHash"]
    );
    assert_eq!(
        denied["report"]["authorityCurrentHeadReceiptHash"],
        Value::Null
    );
    fs::write(f.root.join("broker-mode"), "valid").unwrap();
    let stored = path.join(
        bundle["content"]["databases"][0]["backupRelativePath"]
            .as_str()
            .unwrap(),
    );
    let mut tampered = fs::read(&stored).unwrap();
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    fs::set_permissions(&stored, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&stored, tampered).unwrap();
    let denied = f.native(&drill, BTreeMap::new());
    assert_eq!(denied["exitCode"], 2, "{denied}");
    assert_eq!(
        denied["report"]["bundleManifestHash"],
        bundle["bundleManifestHash"]
    );
    assert_eq!(
        denied["report"]["authorityCurrentHeadReceiptHash"],
        actual["report"]["authorityCurrentHeadReceiptHash"]
    );
    assert_eq!(
        fs::read(path.join("RESTORE_DRILL_RECEIPT.json")).unwrap(),
        retained_receipt
    );
}
#[test]
fn renew_never_invokes_online_authority_and_reconciliation_really_visits_ten_databases() {
    for action in ["renew", "reconcile-and-renew"] {
        let f = Fixture::new();
        let mut argv = f.argv(action);
        if action == "reconcile-and-renew" {
            argv.extend([
                "--online-authority-process-config".into(),
                f.path("onlineProcess").display().to_string(),
            ]);
        }
        let actual = f.native(&argv, BTreeMap::new());
        assert_eq!(actual["exitCode"], 0, "{actual}");
        let report = &actual["report"];
        let renewal = if action == "renew" {
            report
        } else {
            &report["renewalReceipt"]
        };
        assert_eq!(
            renewal["status"],
            "autonomous_research_state_backup_renewal_complete"
        );
        let bundle = PathBuf::from(renewal["bundlePath"].as_str().unwrap());
        assert_eq!(json_file(bundle.join("RENEWAL_RECEIPT.json")), *renewal);
        assert_eq!(
            json_file(bundle.join("RESTORE_DRILL_RECEIPT.json"))["restoreDrillReceiptHash"],
            renewal["restoreDrillReceiptHash"]
        );
        let calls = f.calls();
        let online = calls
            .iter()
            .filter(|q| q["kind"] == "AutonomousResearchOnlineUnresolvedReservationListRequest")
            .collect::<Vec<_>>();
        if action == "renew" {
            assert!(online.is_empty());
        } else {
            assert_eq!(online.len(), 20);
            assert_eq!(report["reconciledDatabaseCount"], 10);
            assert_eq!(report["recoveredFinalizationCount"], 0);
            assert_eq!(report["businessDmlReplayed"], false);
            let roles = online
                .iter()
                .map(|q| q["databaseRole"].as_str().unwrap())
                .collect::<std::collections::BTreeSet<_>>();
            assert_eq!(roles.len(), 10);
        }
        let mut drill = f.argv("restore-drill");
        drill.extend(["--bundle".into(), bundle.display().to_string()]);
        let original = f.original(&drill, BTreeMap::new());
        assert_eq!(original["exitCode"], 0, "{original}");
        assert_eq!(
            original["report"]["restoreDrillReceiptHash"],
            renewal["restoreDrillReceiptHash"]
        );
        let mut payload = renewal.clone();
        payload
            .as_object_mut()
            .unwrap()
            .remove("renewalReceiptHash");
        assert_eq!(
            renewal["renewalReceiptHash"],
            hepta_legacy_compatibility::production_hash_record_v1(
                "AutonomousResearchStateBackupRenewalReceipt",
                &payload
            )
            .unwrap()
            .as_str()
        );
        f.clear_calls();
        let original_action = f.original(&argv, BTreeMap::new());
        assert_eq!(
            original_action["exitCode"], 0,
            "{action}: {original_action}"
        );
        let original_report = &original_action["report"];
        for field in [
            "version",
            "kind",
            "status",
            "businessDmlReplayed",
            "backupAttempted",
            "reconciledDatabaseCount",
            "recoveredFinalizationCount",
            "abortedRemoteOnlyReservationCount",
            "writerManifestHash",
            "databaseScopeHash",
            "blockers",
        ] {
            assert_eq!(report[field], original_report[field], "{action}/{field}");
        }
        let original_renewal = if action == "renew" {
            original_report
        } else {
            &original_report["renewalReceipt"]
        };
        for field in [
            "version",
            "kind",
            "status",
            "backupAuthorityHeadSequence",
            "backupAuthorityHeadHash",
            "restoreAuthorityHeadSequence",
            "restoreAuthorityHeadHash",
            "completeFinalizedMutationJournal",
            "journalReplayMutationCount",
            "renewedAt",
            "productionStateMutated",
            "blockers",
        ] {
            assert_eq!(renewal[field], original_renewal[field], "{action}/{field}");
        }
        assert_eq!(
            f.calls()
                .iter()
                .filter(|q| q["kind"] == "AutonomousResearchOnlineUnresolvedReservationListRequest")
                .count(),
            online.len()
        );
    }
}
#[test]
fn unsigned_or_rebound_process_receipts_never_publish_a_ready_cli_report() {
    let f = Fixture::new();
    for mode in ["bad-signature", "wrong-scope", "exit"] {
        fs::write(f.root.join("broker-mode"), mode).unwrap();
        for action in ["backup", "renew"] {
            let argv = f.argv(action);
            let actual = f.native(&argv, BTreeMap::new());
            assert_eq!(actual["exitCode"], 2, "{mode}/{action}: {actual}");
            if mode != "exit" {
                assert_eq!(
                    actual,
                    f.original(&argv, BTreeMap::new()),
                    "{mode}/{action}"
                );
            }
        }
        assert!(!f.path("backupRoot").exists());
    }
}

#[test]
fn blocked_inventory_retains_actual_missing_rows_in_backup_and_renewal_reports() {
    let f = Fixture::new();
    let empty = f.root.join("empty");
    fs::create_dir(&empty).unwrap();
    for action in ["backup", "renew"] {
        let mut argv = f.argv(action);
        argv[3] = empty.display().to_string();
        let actual = f.native(&argv, BTreeMap::new());
        assert_eq!(actual["exitCode"], 2, "{actual}");
        assert_eq!(actual, f.original(&argv, BTreeMap::new()));
        let report = if action == "backup" {
            &actual["report"]
        } else {
            &actual["report"]["backupReceipt"]
        };
        assert_eq!(report["inventory"]["instances"], json!([]));
        assert_eq!(
            report["inventory"]["blockers"].as_array().unwrap().len(),
            10
        );
    }
    assert!(f.calls().is_empty());
}

#[test]
fn unsafe_configuration_inputs_and_weaker_v1_write_policy_fail_without_rpc() {
    let f = Fixture::new();
    let original = fs::read(f.path("backupConfiguration")).unwrap();
    let path = f.root.join("selected.json");
    let mut argv = f.argv("backup");
    argv[5] = path.display().to_string();
    for mode in [
        "symlink",
        "hardlink",
        "fifo",
        "directory",
        "group-write",
        "duplicate",
        "non-utf8",
        "oversized",
    ] {
        match mode {
            "symlink" => std::os::unix::fs::symlink(f.path("backupConfiguration"), &path).unwrap(),
            "hardlink" => fs::hard_link(f.path("backupConfiguration"), &path).unwrap(),
            "fifo" => nix::unistd::mkfifo(
                &path,
                nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
            )
            .unwrap(),
            "directory" => fs::create_dir(&path).unwrap(),
            "group-write" => {
                fs::write(&path, &original).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o660)).unwrap();
            }
            "duplicate" => {
                fs::write(&path, b"{\"version\":2,\"version\":2}").unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            }
            "non-utf8" => {
                fs::write(&path, [0xff, 0xfe]).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            }
            "oversized" => {
                let file = fs::File::create(&path).unwrap();
                file.set_len(4 * 1024 * 1024 + 1).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            }
            _ => unreachable!(),
        }
        let actual = f.native(&argv, BTreeMap::new());
        assert_eq!(actual["exitCode"], 1, "{mode}: {actual}");
        assert_eq!(
            actual["error"],
            "autonomous_research_state_backup_authority_process_configuration_invalid",
            "{mode}"
        );
        if mode == "directory" {
            fs::remove_dir(&path).unwrap();
        } else {
            fs::remove_file(&path).unwrap();
        }
    }
    assert!(f.calls().is_empty());
    let mut v1: Value = serde_json::from_slice(&original).unwrap();
    v1["version"] = 1.into();
    v1.as_object_mut()
        .unwrap()
        .remove("onlineMutationAuthorityConfigurationPath");
    v1.as_object_mut()
        .unwrap()
        .remove("onlineMutationAuthorityConfigurationSha256");
    fs::write(&path, v1.to_string()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        f.native(&argv, BTreeMap::new())["error"],
        "autonomous_research_state_restore_online_authority_trust_required"
    );
    assert!(f.calls().is_empty());
    argv[1] = "status".into();
    assert_eq!(
        f.native(&argv, BTreeMap::new()),
        f.original(&argv, BTreeMap::new())
    );
    assert!(f.calls().is_empty());
}

#[test]
fn failed_reconciliation_reports_actual_initial_scope_and_completed_database_work() {
    let f = Fixture::new();
    let mut argv = f.argv("reconcile-and-renew");
    argv.extend([
        "--online-authority-process-config".into(),
        f.path("onlineProcess").display().to_string(),
    ]);
    for (mode, completed) in [("bad-signature", 0), ("fail-second-database", 1)] {
        fs::write(f.root.join("broker-mode"), mode).unwrap();
        f.clear_calls();
        let actual = f.native(&argv, BTreeMap::new());
        assert_eq!(actual["exitCode"], 2, "{actual}");
        let report = &actual["report"];
        assert!(
            report["initialInventoryHash"]
                .as_str()
                .unwrap()
                .starts_with("sha256:")
        );
        assert!(
            report["databaseScopeHash"]
                .as_str()
                .unwrap()
                .starts_with("sha256:")
        );
        assert_eq!(
            report["reconciliations"].as_array().unwrap().len(),
            completed
        );
        assert_eq!(report["backupAttempted"], false);
        assert!(!f.path("backupRoot").exists());
        assert!(
            f.calls()
                .iter()
                .all(|call| call["kind"]
                    == "AutonomousResearchOnlineUnresolvedReservationListRequest")
        );
        f.clear_calls();
        let original = f.original(&argv, BTreeMap::new());
        if completed == 0 {
            assert_eq!(actual, original);
        } else {
            for field in [
                "version",
                "kind",
                "status",
                "initialInventoryHash",
                "reconciledInventoryHash",
                "databaseScopeHash",
                "backupAttempted",
                "businessDmlReplayed",
                "pendingInspections",
                "renewalReceipt",
                "blockers",
            ] {
                assert_eq!(report[field], original["report"][field], "{field}");
            }
            assert_eq!(
                original["report"]["reconciliations"]
                    .as_array()
                    .unwrap()
                    .len(),
                completed
            );
        }
    }
}

#[test]
fn real_native_binary_uses_canonical_workspace_manifest_and_original_exit_classes() {
    let root = std::env::temp_dir().join(format!(
        "hepta-backup-cli-e2e-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    for argv in [
        vec![],
        args(&["--help"]),
        args(&["--action=restore-drill"]),
        args(&["--action=renew"]),
    ] {
        let native = Command::new(env!("CARGO_BIN_EXE_hepta-state-backup"))
            .args(&argv)
            .current_dir(&root)
            .env("HEPTA_PAPER_RUNTIME_ROOT", &root)
            .output()
            .unwrap();
        let node = Command::new("node")
            .arg(repository.join("paper-core/bin/autonomous-research-state-backup.mjs"))
            .args(&argv)
            .current_dir(&root)
            .env("HEPTA_PAPER_RUNTIME_ROOT", &root)
            .output()
            .unwrap();
        assert_eq!(
            native.status.code(),
            node.status.code(),
            "{argv:?}: {}",
            String::from_utf8_lossy(&native.stderr)
        );
        if argv == args(&["--help"]) {
            assert_eq!(native.stdout, node.stdout);
        } else if !node.stdout.is_empty() {
            assert_eq!(
                serde_json::from_slice::<Value>(&native.stdout).unwrap(),
                serde_json::from_slice::<Value>(&node.stdout).unwrap(),
                "{argv:?}"
            );
        } else {
            assert_eq!(
                String::from_utf8_lossy(&native.stderr).trim(),
                "autonomous_research_state_backup_bundle_required"
            );
        }
    }
    assert!(fs::read_dir(&root).unwrap().next().is_none());
    fs::remove_dir(&root).unwrap();
}

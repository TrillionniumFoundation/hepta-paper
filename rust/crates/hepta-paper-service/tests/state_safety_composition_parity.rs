//! Real original passive composition; real ten databases, copied repository
//! JavaScript, three signed authority-process observations, and stored backup.
use hepta_paper_service::state_recoverability::{
    cli::{StateBackupCliContextV1, StateBackupCliOutputV1, state_backup_cli_v1},
    safety_inspection::{
        StateSafetyInspectionOptionsV1, inspect_autonomous_research_state_safety_v1,
    },
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
const BACKUP: &str = "HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG";
const ONLINE: &str = "HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG";
const PROCESS: &str = "HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG";
static NEXT: AtomicU64 = AtomicU64::new(0);
fn oracle(input: Value) -> Value {
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../oracle/state-safety-composition-v1.mjs");
    let mut child = Command::new("node")
        .arg(script)
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
    let out: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(out["ok"], true, "{}", out["error"]);
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&out["profile"]).unwrap();
    out["value"].clone()
}
struct Fixture {
    root: PathBuf,
    value: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-backup-cli-e2e-safety-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let value = oracle(json!({"mode":"fixture","root":root}));
        Self { root, value }
    }
    fn path(&self, key: &str) -> PathBuf {
        PathBuf::from(self.value[key].as_str().unwrap())
    }
    fn environment(&self) -> BTreeMap<String, String> {
        [
            (BACKUP, "backupConfiguration"),
            (ONLINE, "onlineConfiguration"),
            (PROCESS, "onlineProcess"),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), self.value[v].as_str().unwrap().into()))
        .collect()
    }
    fn inspect(&self, environment: BTreeMap<String, String>, now: i64) -> Value {
        inspect_autonomous_research_state_safety_v1(&StateSafetyInspectionOptionsV1 {
            workspace_root: self.path("workspace"),
            runtime_root: self.path("runtime"),
            working_directory: self.root.clone(),
            now,
            environment,
        })
        .unwrap()
    }
    fn node(&self, environment: &BTreeMap<String, String>, now: i64) -> Value {
        oracle(
            json!({"mode":"inspect","root":self.root,"environment":environment,"now":hepta_paper_service::sqlite_mutation_coordinator::clock::iso(now).unwrap()}),
        )
    }
    fn parity(&self, environment: BTreeMap<String, String>, now: i64) -> Value {
        let started = std::time::Instant::now();
        eprintln!("native passive inspection started: {}", self.root.display());
        let native = self.inspect(environment.clone(), now);
        eprintln!(
            "native passive inspection finished after {:?}",
            started.elapsed()
        );
        let node = self.node(&environment, now);
        eprintln!(
            "Node differential inspection finished after {:?}",
            started.elapsed()
        );
        if native != node {
            fn differences(path: &str, a: &Value, b: &Value, out: &mut Vec<String>) {
                if a == b {
                    return;
                }
                if let (Some(a), Some(b)) = (a.as_object(), b.as_object()) {
                    let keys = a
                        .keys()
                        .chain(b.keys())
                        .collect::<std::collections::BTreeSet<_>>();
                    for key in keys {
                        differences(
                            &format!("{path}/{key}"),
                            a.get(key).unwrap_or(&Value::Null),
                            b.get(key).unwrap_or(&Value::Null),
                            out,
                        );
                    }
                } else {
                    out.push(format!("{path}: native={a}, node={b}"));
                }
            }
            let mut diffs = Vec::new();
            differences("", &native, &node, &mut diffs);
            panic!("{}", diffs.join("\n"));
        }
        native
    }
    fn rpc(&self) -> (Vec<u8>, Vec<u8>) {
        (
            fs::read(self.root.join("calls.jsonl")).unwrap_or_default(),
            fs::read(self.root.join("passive-calls.jsonl")).unwrap_or_default(),
        )
    }
    fn cli(&self, mode: &str, bundle: Option<&str>) -> Value {
        let mut argv = vec![
            "--action".into(),
            mode.to_owned(),
            "--runtime-root".into(),
            self.path("runtime").display().to_string(),
            "--authority-config".into(),
            self.path("backupConfiguration").display().to_string(),
        ];
        if let Some(bundle) = bundle {
            argv.extend(["--bundle".into(), bundle.into()]);
        }
        match state_backup_cli_v1(
            &argv,
            &StateBackupCliContextV1 {
                workspace_root: self.path("workspace"),
                working_directory: self.root.clone(),
                environment: BTreeMap::new(),
            },
            &mut || Ok(NOW),
        )
        .unwrap()
        {
            StateBackupCliOutputV1::Report { report, exit_code } => {
                assert_eq!(exit_code, 0, "{report}");
                report
            }
            _ => panic!("expected actual service report"),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn replace(path: &Path, bytes: &[u8], mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}
#[test]
fn missing_configuration_missing_backup_actual_configured_coordinator_and_blocked_inventory_match_node()
 {
    let f = Fixture::new();
    let report = f.parity(BTreeMap::new(), NOW);
    assert_eq!(report["inventoryCoveredRoleCount"], 10);
    assert_eq!(report["restoreAuthorityConfigured"], false);
    assert_eq!(
        report["latestRestoreDrill"]["blockers"],
        json!(["autonomous_research_state_restore_authority_trust_configuration_required"])
    );
    let mut empty = BTreeMap::new();
    empty.insert(BACKUP.into(), String::new());
    empty.insert(PROCESS.into(), String::new());
    empty.insert(ONLINE.into(), String::new());
    assert_eq!(f.parity(empty, NOW), report);
    let mut backup = BTreeMap::new();
    backup.insert(
        BACKUP.into(),
        f.value["backupConfiguration"].as_str().unwrap().into(),
    );
    let report = f.parity(backup, NOW);
    assert_eq!(report["restoreAuthorityConfigured"], true);
    assert_eq!(
        report["latestRestoreDrill"]["blockers"],
        json!(["autonomous_research_state_backup_bundle_missing"])
    );
    let report = f.parity(f.environment(), NOW);
    assert_eq!(
        report["onlineMutationCoordinatorStatus"]["status"],
        "externally_fenced_sqlite_mutation_coordinator_configured"
    );
    assert_eq!(
        report["onlineMutationCoordinatorStatus"]["blockers"],
        json!(["autonomous_research_online_mutation_runtime_activation_required"])
    );
    assert_eq!(report["ready"], false);
    assert!(!f.path("runtime").join("automation-cache").exists());
    let first = f.value["manifest"]["databases"][0]["relativePath"]
        .as_str()
        .unwrap();
    fs::remove_file(f.path("runtime").join(first)).unwrap();
    let report = f.parity(f.environment(), NOW);
    assert_eq!(report["inventoryCoveredRoleCount"], 9);
    assert_eq!(
        report["onlineMutationCoordinatorStatus"]["implemented"],
        false
    );
    assert_eq!(
        f.rpc(),
        (Vec::new(), Vec::new()),
        "passive composition must never start either authority process"
    );
}
#[test]
fn actual_signed_cache_backup_source_and_original_source_scan_match_without_rpc_or_authority_promotion()
 {
    let f = Fixture::new();
    let cache = oracle(json!({"mode":"cache","root":f.root}));
    assert_eq!(
        cache["active"]["status"],
        "autonomous_research_online_mutation_active_refresh_complete"
    );
    let backup = f.cli("backup", None);
    f.cli(
        "restore-drill",
        Some(backup["bundlePath"].as_str().unwrap()),
    );
    let before = f.rpc();
    assert_eq!(
        String::from_utf8(before.1.clone()).unwrap().lines().count(),
        3
    );
    let report = f.parity(f.environment(), NOW);
    assert_eq!(report["latestValidRestoreDrillReady"], true);
    assert_eq!(report["currentHeadReceiptVerified"], true);
    assert_eq!(report["recentActiveChallengeVerified"], true);
    assert_eq!(report["writerStaticCoverageVerified"], true);
    assert_eq!(report["writerBrokerScopeVerified"], true);
    assert_eq!(report["ready"], false);
    assert_eq!(report["externalActionPerformed"], false);
    assert_eq!(report["statusReadOnly"], true);
    assert_eq!(
        report["onlineMutationCoordinatorStatus"]["status"],
        "externally_fenced_sqlite_mutation_coordinator_configured"
    );
    let mut absent = f.environment();
    absent.remove(PROCESS);
    let no_process = f.parity(absent, NOW);
    assert_eq!(
        no_process["onlineMutationCoordinatorStatus"]["implemented"],
        false
    );
    assert_eq!(no_process["currentHeadReceiptVerified"], true);
    let mut forged = f.environment();
    forged.insert("HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_COORDINATOR_STATUS".into(),r#"{"implemented":true,"status":"externally_fenced_sqlite_mutation_coordinator_ready","blockers":[]}"#.into());
    assert_eq!(
        f.parity(forged, NOW),
        report,
        "environment readiness JSON is not a capability"
    );
    assert_eq!(f.rpc(), before);
    let cache_file = f
        .path("runtime")
        .join("automation-cache/online-authority-evidence-v1/current.json");
    let original = fs::read(&cache_file).unwrap();
    for role in ["currentHead", "activeChallenge", "brokerScope"] {
        fs::set_permissions(&cache_file, fs::Permissions::from_mode(0o600)).unwrap();
        oracle(json!({"mode":"tamper-cache","root":f.root,"role":role}));
        let report = f.parity(f.environment(), NOW);
        assert_eq!(report["currentHeadReceiptVerified"], false, "{role}");
        assert!(
            report["blockers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v.as_str().is_some_and(|s| s
                    .starts_with("autonomous_research_online_anti_rollback_inspection_failed:")))
        );
        replace(&cache_file, &original, 0o400);
    }
    let expired = f.parity(f.environment(), NOW + 60_000);
    assert_eq!(expired["currentHeadReceiptVerified"], false);
    let bundle = Path::new(backup["bundlePath"].as_str().unwrap());
    let entry = fs::read_dir(bundle.join("databases"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::set_permissions(&entry, fs::Permissions::from_mode(0o600)).unwrap();
    fs::OpenOptions::new()
        .append(true)
        .open(&entry)
        .unwrap()
        .write_all(b"tampered")
        .unwrap();
    let report = f.parity(f.environment(), NOW);
    assert_eq!(report["latestValidRestoreDrillReady"], false);
    assert_eq!(report["latestRestoreDrill"]["skippedCandidateCount"], 1);
    let rogue = f
        .path("workspace")
        .join("paper-adapters/persistence/unregistered-safety-writer.mjs");
    fs::write(
        rogue,
        "export function unsafeWrite(db){db.exec('DELETE FROM records');}\n",
    )
    .unwrap();
    let report = f.parity(f.environment(), NOW);
    assert_eq!(report["writerStaticCoverageVerified"], false);
    assert_eq!(
        f.rpc(),
        before,
        "even failed signatures/source scans must remain zero-RPC"
    );
}

#[test]
fn actual_invalid_configurations_preserve_failure_metadata_and_never_start_processes() {
    let f = Fixture::new();
    let process = f.path("onlineProcess");
    let saved = fs::read(&process).unwrap();
    let mut wrong: Value = serde_json::from_slice(&saved).unwrap();
    wrong["kind"] = json!("ForgedReadyCoordinator");
    replace(&process, &serde_json::to_vec(&wrong).unwrap(), 0o600);
    let report = f.parity(f.environment(), NOW);
    assert_eq!(report["restoreAuthorityConfigured"], true);
    assert_eq!(
        report["onlineMutationCoordinatorStatus"]["implemented"],
        false
    );
    assert!(
        report["onlineAntiRollback"]["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str().is_some_and(|s| s.starts_with(
                "autonomous_research_online_mutation_coordinator_composition_failed:"
            )))
    );
    replace(&process, &saved, 0o600);
    let backup = f.path("backupConfiguration");
    let saved = fs::read(&backup).unwrap();
    let mut wrong: Value = serde_json::from_slice(&saved).unwrap();
    wrong["kind"] = json!("ForgedReadyBackup");
    replace(&backup, &serde_json::to_vec(&wrong).unwrap(), 0o600);
    let report = f.parity(f.environment(), NOW);
    assert_eq!(report["restoreAuthorityConfigured"], false);
    assert_eq!(report["restoreAuthorityConfigurationHash"], Value::Null);
    assert_eq!(
        report["inventory"]["status"],
        "autonomous_research_state_database_inventory_blocked"
    );
    assert_eq!(
        report["latestRestoreDrill"]["blockers"],
        json!([
            "autonomous_research_state_latest_restore_drill_inspection_failed:state_backup_service_unavailable"
        ])
    );
    replace(&backup, &saved, 0o600);
    for mode in [0o622, 0o664] {
        fs::set_permissions(&backup, fs::Permissions::from_mode(mode)).unwrap();
        let native = f.inspect(f.environment(), NOW);
        assert_eq!(native["restoreAuthorityConfigured"], false);
        assert_eq!(native["ready"], false);
    }
    replace(&backup, &saved, 0o600);
    let outside = f.root.join("outside-cache");
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, f.path("runtime").join("automation-cache")).unwrap();
    let unsafe_cache = f.inspect(f.environment(), NOW);
    let cache_blockers = unsafe_cache["onlineAntiRollback"]["blockers"]
        .as_array()
        .unwrap();
    assert!(cache_blockers.iter().any(|v| v.as_str().is_some_and(|s| {
        s.ends_with("autonomous_research_online_authority_evidence_cache_parent_unsafe")
    })));
    assert!(!cache_blockers.iter().any(|v| {
        v.as_str()
            .is_some_and(|s| s.ends_with("scoped_path_missing_or_unreadable"))
    }));
    fs::remove_file(f.path("runtime").join("automation-cache")).unwrap();
    let alias = f.root.join("backup-alias.json");
    std::os::unix::fs::symlink(&backup, &alias).unwrap();
    let mut environment = f.environment();
    environment.insert(BACKUP.into(), alias.to_str().unwrap().into());
    let native = f.inspect(environment, NOW);
    assert_eq!(native["restoreAuthorityConfigured"], false);
    let duplicate = String::from_utf8(saved.clone())
        .unwrap()
        .replacen("{", "{\"version\":2,", 1);
    replace(&backup, duplicate.as_bytes(), 0o600);
    let native = f.inspect(f.environment(), NOW);
    assert_eq!(native["restoreAuthorityConfigured"], false);
    assert_eq!(f.rpc(), (Vec::new(), Vec::new()));
    replace(&backup, &saved, 0o600);
    let created = f.cli("backup", None);
    f.cli(
        "restore-drill",
        Some(created["bundlePath"].as_str().unwrap()),
    );
    let before = f.rpc();
    let mut v1: Value = serde_json::from_slice(&saved).unwrap();
    v1["version"] = json!(1);
    v1.as_object_mut()
        .unwrap()
        .remove("onlineMutationAuthorityConfigurationPath");
    v1.as_object_mut()
        .unwrap()
        .remove("onlineMutationAuthorityConfigurationSha256");
    replace(&backup, &serde_json::to_vec(&v1).unwrap(), 0o600);
    let mut only_backup = BTreeMap::new();
    only_backup.insert(BACKUP.into(), backup.to_str().unwrap().into());
    let legacy = f.parity(only_backup, NOW);
    assert_eq!(legacy["latestValidRestoreDrillReady"], true);
    assert_eq!(
        f.rpc(),
        before,
        "v1 passive source verification never invokes authority"
    );
}

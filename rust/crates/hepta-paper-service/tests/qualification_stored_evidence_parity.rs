//! Original repositories write owned constructed data. Neither these fixtures
//! nor successful readers establish executed qualification or signed acceptance.
#[allow(dead_code)]
mod machine_intake_support;
use hepta_paper_service::qualification_stored_evidence::{
    read_autonomous_external_qualification_state_v1 as state,
    read_full_research_qualification_receipt_pointer_v1 as pointer,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read},
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
const PAPER: &str = "owned-reader-paper";
const NOW: i64 = 1_790_035_200_000;
const EVIDENCE: &str = "constructed_data_original_repository_reader_only_no_executed_qualification_or_signed_acceptance";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn empty() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-stored-qualification-parity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            root.join(".owned-qualification-stored-fixture"),
            "owned constructed data fixture\n",
        )
        .unwrap();
        Self { root }
    }
    fn new() -> Self {
        let fixture = Self::empty();
        let expected = fixture.action(json!({"action":"setup"}));
        assert_eq!(expected["pointer"]["ok"], true);
        assert_eq!(expected["state"]["ok"], true);
        fixture
    }
    fn action(&self, mut input: Value) -> Value {
        input["root"] = json!(self.root);
        oracle(&input, &self.root)
    }
    fn database(&self, kind: &str) -> PathBuf {
        self.root
            .join("autonomous-research/qualification")
            .join(if kind == "pointer" {
                "qualification-receipt.json.publication.sqlite"
            } else {
                "external-qualification-state.sqlite"
            })
    }
    fn mirror(&self) -> PathBuf {
        self.root
            .join("autonomous-research/qualification/qualification-receipt.json")
    }
    fn compare(&self, expected: &Value, label: &str) {
        assert_eq!(expected["evidenceScope"], EVIDENCE);
        let before = snapshot(&self.root);
        let actual_pointer = pointer(
            &self.root,
            &repository(),
            &BTreeMap::new(),
            expected["nowMillis"].as_i64().unwrap(),
        );
        let actual_state = state(&self.root, expected["paperId"].as_str().unwrap());
        for (key, actual) in [("pointer", actual_pointer), ("state", actual_state)] {
            match actual {
                Ok(value) => {
                    assert_eq!(expected[key]["ok"], true, "{label}: {key}: {expected}");
                    assert_eq!(json!(value), expected[key]["value"], "{label}: {key}");
                }
                Err(error) => {
                    assert_eq!(
                        expected[key]["ok"], false,
                        "{label}: {key}: {error}: {expected}"
                    );
                    // Original business diagnostics are preserved. Additional
                    // bounded native refusals need not mimic raw SQLite errors.
                    if expected[key]["error"]
                        .as_str()
                        .unwrap()
                        .starts_with("autonomous_research_external_qualification_state_")
                        || key == "pointer"
                    {
                        assert_eq!(
                            error.code(),
                            expected[key]["error"].as_str().unwrap(),
                            "{label}: {key}"
                        );
                    }
                }
            }
        }
        assert_eq!(
            snapshot(&self.root),
            before,
            "reader mutated source: {label}"
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}
fn command(input: &Value, root: &Path) -> Command {
    let mut command = Command::new("node");
    command
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../oracle/qualification-stored-evidence-v1.mjs"),
        )
        .arg(serde_json::to_string(input).unwrap())
        .current_dir(root)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").expect("qualified Node"))
        .env("LANG", "en_US.UTF-8");
    command
}
fn qualified(output: &[u8]) -> Value {
    let output: Value = serde_json::from_slice(output).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&output["profile"]).unwrap();
    output["value"].clone()
}
fn oracle(input: &Value, root: &Path) -> Value {
    let output = machine_intake_support::run(&mut command(input, root));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    qualified(&output.stdout)
}
fn snapshot(root: &Path) -> Vec<Value> {
    fn visit(path: &Path, values: &mut Vec<Value>) {
        let metadata = fs::symlink_metadata(path).unwrap();
        let content = if metadata.file_type().is_symlink() {
            json!(fs::read_link(path).unwrap())
        } else if metadata.is_file() {
            json!(hex::encode(Sha256::digest(fs::read(path).unwrap())))
        } else {
            Value::Null
        };
        values.push(json!({"path":path,"dev":metadata.dev(),"ino":metadata.ino(),"mode":metadata.mode(),"uid":metadata.uid(),"size":metadata.size(),"nlink":metadata.nlink(),"mtime":metadata.mtime(),"mtimeNsec":metadata.mtime_nsec(),"ctime":metadata.ctime(),"ctimeNsec":metadata.ctime_nsec(),"content":content}));
        if metadata.is_dir() {
            let mut children = fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            children.sort();
            for child in children {
                visit(&child, values);
            }
        }
    }
    let mut values = Vec::new();
    visit(root, &mut values);
    values
}
struct WalKeeper(Child);
impl WalKeeper {
    fn new(fixture: &Fixture, database: &str) -> Self {
        let mut child = Self(
            command(
                &json!({"action":"hold-wal","database":database,"root":fixture.root}),
                &fixture.root,
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
        );
        let stdout = child.0.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut output = Vec::new();
            BufReader::new(stdout.take(2 * 1024 * 1024 + 1))
                .read_until(b'\n', &mut output)
                .unwrap();
            let _ = sender.send(output);
        });
        let output = receiver
            .recv_timeout(Duration::from_secs(20))
            .expect("bounded WAL keeper readiness");
        reader.join().unwrap();
        assert!(output.len() <= 2 * 1024 * 1024);
        assert_eq!(qualified(&output)["held"], true);
        child
    }
}
impl Drop for WalKeeper {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn original_missing_readers_create_no_files_and_do_not_use_legacy_json() {
    let fixture = Fixture::empty();
    let before = snapshot(&fixture.root);
    let expected = fixture.action(json!({"action":"read"}));
    fixture.compare(&expected, "absent");
    assert_eq!(snapshot(&fixture.root), before);
    let directory = fixture.root.join("autonomous-research/qualification");
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join("external-qualification-state.json"),
        "{\"ready\":true}",
    )
    .unwrap();
    fs::write(fixture.mirror(), "{\"ready\":true}").unwrap();
    let expected = fixture.action(json!({"action":"read"}));
    assert_eq!(expected["state"]["value"], Value::Null);
    assert_eq!(expected["pointer"]["value"], Value::Null);
    fixture.compare(&expected, "legacy artifacts provide no authority");
}
#[test]
fn original_builder_cas_publisher_and_readers_match_without_acceptance_claim() {
    let fixture = Fixture::new();
    let expected = fixture.action(json!({"action":"read"}));
    fixture.compare(&expected, "original production repositories");
    assert_eq!(expected["pointer"]["value"]["publicationGeneration"], 1);
    assert_eq!(
        expected["pointer"]["value"]["receipt"]["externalActionPerformed"],
        false
    );
    assert_eq!(expected["state"]["value"]["generation"], 1);
    assert!(expected["pointer"]["value"]["receipt"]["signature"].is_null());
    fixture.compare(
        &fixture.action(json!({"action":"read","paperId":"other-paper"})),
        "scope isolation",
    );
}
#[test]
fn effective_state_and_pointer_wal_match_separate_process_original_reader() {
    for database in ["state", "pointer"] {
        let fixture = Fixture::new();
        let _keeper = WalKeeper::new(&fixture, database);
        assert!(
            PathBuf::from(format!("{}-wal", fixture.database(database).display()))
                .metadata()
                .unwrap()
                .len()
                > 32
        );
        let expected = fixture.action(json!({"action":"read"}));
        assert_eq!(
            if database == "pointer" {
                &expected["pointer"]["value"]["publicationGeneration"]
            } else {
                &expected["state"]["value"]["generation"]
            },
            &json!(2)
        );
        fixture.compare(&expected, database);
    }
}
#[test]
fn original_state_v4_and_v5_recovery_and_all_nonverified_statuses_match() {
    let fixture = Fixture::new();
    let expected=fixture.action(json!({"action":"state-mutate","removeRecoveryKeys":["maximumTotalCostUsd","reservedCostUsd","attemptReservationCostUsd"]}));
    assert_eq!(expected["state"]["ok"], true);
    fixture.compare(&expected, "V4 recovery");
    for status in [
        "qualification_retry_scheduled",
        "qualification_attempt_in_progress",
        "qualification_epoch_cooldown",
        "qualification_recovery_budget_exhausted",
        "qualification_terminal_blocked",
    ] {
        let fixture = Fixture::new();
        let expected=fixture.action(json!({"action":"state-mutate","changes":[["/recovery/status",status],["/receipt",null],["/verifiedInspection",null]]}));
        assert_eq!(expected["state"]["ok"], true);
        fixture.compare(&expected, status);
    }
}
#[test]
fn original_invalid_next_attempt_timestamp_is_preserved_as_stored_data() {
    for next in [
        Value::Null,
        json!("not-a-timestamp"),
        json!(0),
        json!(false),
        json!({}),
        json!([]),
        json!("1999-01-01T00:00:00.000Z"),
    ] {
        let fixture = Fixture::new();
        let expected = fixture
            .action(json!({"action":"state-mutate","changes":[["/recovery/nextAttemptAt",next]]}));
        assert_eq!(expected["state"]["ok"], true);
        assert_eq!(
            expected["state"]["value"]["recovery"]["nextAttemptAt"],
            next
        );
        fixture.compare(&expected, "nullable invalid timestamp compatibility");
    }
}
#[test]
fn original_state_hash_scope_and_generation_fences_reject_drift() {
    for input in [
        json!({"changes":[["/generation",2]],"rehash":false}),
        json!({"rowGeneration":2}),
        json!({"rowHash":format!("sha256:{}","0".repeat(64))}),
        json!({"changes":[["/paperId","other-paper"],["/verifiedInspection/paperId","other-paper"]]}),
    ] {
        let fixture = Fixture::new();
        let mut input = input;
        input["action"] = json!("state-mutate");
        let expected = fixture.action(input);
        assert_eq!(expected["state"]["ok"], false);
        fixture.compare(&expected, "state fence");
    }
}
#[test]
fn original_state_structure_counter_cost_time_and_evidence_rejections_match() {
    for (path, value) in [
        ("/unexpected", json!(true)),
        ("/generation", json!(1_000_001)),
        ("/recovery/attemptCount", json!(3)),
        ("/recovery/cycle", json!("1")),
        ("/recovery/reservedCostUsd", json!(2)),
        ("/recovery/attemptReservationCostUsd", json!(0)),
        ("/recovery/deadlineAt", json!("2026-09-21T23:59:59.999Z")),
        ("/recovery/nextAttemptAt", json!("2026-09-21T23:59:59.999Z")),
        (
            "/recovery/globalDeadlineAt",
            json!("2100-01-01T00:00:00.001Z"),
        ),
        ("/verifiedInspection/ready", json!(false)),
        (
            "/verifiedInspection/trustIdentityHash",
            json!(format!("sha256:{}", "0".repeat(64))),
        ),
        ("/receipt/expiresAt", json!("invalid")),
        ("/recovery/terminalFailure", json!({})),
    ] {
        let fixture = Fixture::new();
        let expected = fixture.action(json!({"action":"state-mutate","changes":[[path,value]]}));
        assert_eq!(expected["state"]["ok"], false, "{path}");
        fixture.compare(&expected, path);
    }
}
#[test]
fn original_state_semantic_number_spelling_and_string_coercion_match() {
    let fixture = Fixture::new();
    let expected = fixture.action(json!({"action":"state-mutate","raw":"numeric-versions"}));
    assert_eq!(expected["state"]["ok"], true);
    fixture.compare(&expected, "numeric source spelling");
    let fixture = Fixture::new();
    let hash=fixture.action(json!({"action":"read"}))["state"]["value"]["recovery"]["recoveryIdentityHash"].clone();
    let expected = fixture.action(
        json!({"action":"state-mutate","changes":[["/recovery/recoveryIdentityHash",[hash]]]}),
    );
    assert_eq!(expected["state"]["ok"], true);
    fixture.compare(&expected, "original String hash coercion");
}
#[test]
fn original_state_malformed_and_oversized_cells_are_refused() {
    for raw in ["malformed", "oversize"] {
        let fixture = Fixture::new();
        let expected = fixture.action(json!({"action":"state-mutate","raw":raw}));
        assert_eq!(expected["state"]["ok"], false);
        fixture.compare(&expected, raw);
    }
}
#[test]
fn original_pointer_binds_raw_mirror_and_definition_key_order() {
    for scenario in [
        "mirror-whitespace",
        "mirror-missing",
        "mirror-mode",
        "mirror-invalid",
        "definition-order",
        "content-hash-drift",
    ] {
        let fixture = Fixture::new();
        let expected = fixture.action(json!({"action":"pointer-mutate","scenario":scenario}));
        assert_eq!(expected["pointer"]["ok"], false, "{scenario}");
        fixture.compare(&expected, scenario);
    }
}
#[test]
fn original_pointer_accepts_bound_alternate_serialization_without_new_freshness_gate() {
    for scenario in ["alternate-format", "numeric-version"] {
        let fixture = Fixture::new();
        let expected = fixture.action(json!({"action":"pointer-mutate","scenario":scenario}));
        assert_eq!(expected["pointer"]["ok"], true);
        fixture.compare(&expected, scenario);
    }
    let fixture = Fixture::new();
    let expected=fixture.action(json!({"action":"pointer-mutate","changes":[["/expiresAt","2001-01-01T00:00:00.000Z"],["/kind","ConstructedExpiredDataOnly"],["/version",27]]}));
    assert_eq!(expected["pointer"]["ok"], true);
    fixture.compare(&expected, "data read is not signed or fresh qualification");
}
#[test]
fn original_pointer_publication_and_plugin_bindings_reject_drift() {
    for input in [
        json!({"publicationGeneration":0}),
        json!({"changes":[["/campaignId","tampered"]],"rehash":false}),
        json!({"changes":[["/empiricalFamilyPluginPackageHash",format!("sha256:{}","0".repeat(64))]]}),
        json!({"changes":[["/runtimeImageReproducibilityRequiredProfiles",["r","pythonGpu","python"]]]}),
    ] {
        let fixture = Fixture::new();
        let mut input = input;
        input["action"] = json!("pointer-mutate");
        let expected = fixture.action(input);
        assert_eq!(expected["pointer"]["ok"], false);
        fixture.compare(&expected, "pointer binding");
    }
}
#[test]
fn native_readers_refuse_actual_symlinks_modes_views_and_invalid_scope() {
    for kind in ["pointer", "state"] {
        let fixture = Fixture::new();
        let file = fixture.database(kind);
        let moved = file.with_extension("owned-moved");
        fs::rename(&file, &moved).unwrap();
        symlink(&moved, &file).unwrap();
        let before = snapshot(&fixture.root);
        assert!(
            if kind == "pointer" {
                pointer(&fixture.root, &repository(), &BTreeMap::new(), NOW)
            } else {
                state(&fixture.root, PAPER)
            }
            .is_err()
        );
        assert_eq!(snapshot(&fixture.root), before);
        let fixture = Fixture::new();
        let file = fixture.database(kind);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(
            if kind == "pointer" {
                pointer(&fixture.root, &repository(), &BTreeMap::new(), NOW)
            } else {
                state(&fixture.root, PAPER)
            }
            .is_err()
        );
        let fixture = Fixture::new();
        let table = if kind == "pointer" {
            "full_research_qualification_pointer_authority"
        } else {
            "autonomous_external_qualification_state"
        };
        {
            let connection = rusqlite::Connection::open(fixture.database(kind)).unwrap();
            connection.execute_batch(&format!("ALTER TABLE {table} RENAME TO owned_hidden; CREATE VIEW {table} AS SELECT * FROM owned_hidden;")).unwrap();
        }
        assert!(
            if kind == "pointer" {
                pointer(&fixture.root, &repository(), &BTreeMap::new(), NOW)
            } else {
                state(&fixture.root, PAPER)
            }
            .is_err()
        );
    }
    let fixture = Fixture::new();
    for paper in ["", "../paper", "has/slash", "has@at"] {
        assert!(state(&fixture.root, paper).is_err());
    }
}

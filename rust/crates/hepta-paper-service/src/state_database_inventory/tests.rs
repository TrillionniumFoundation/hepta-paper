use super::*;
use rusqlite::{Connection, OpenFlags};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    manifest: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(format!(
            "/tmp/hepta-rust-live-inventory-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let manifest: Value = serde_json::from_slice(
            &fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../paper-core/config/autonomous-research-state-databases.v1.json"),
            )
            .unwrap(),
        )
        .unwrap();
        for definition in manifest["databases"].as_array().unwrap() {
            let path = root.join(definition["relativePath"].as_str().unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let db = Connection::open(&path).unwrap();
            db.execute_batch("CREATE TABLE fixture_records(id TEXT PRIMARY KEY,value TEXT); INSERT INTO fixture_records VALUES('record','before'); PRAGMA user_version=7; PRAGMA application_id=24680;").unwrap();
            for object in definition["requiredSchemaObjects"].as_array().unwrap() {
                let (kind, name) = object.as_str().unwrap().split_once(':').unwrap();
                let sql = match kind {
                    "table" => format!("CREATE TABLE \"{name}\"(id TEXT PRIMARY KEY,value TEXT);"),
                    "index" => format!("CREATE INDEX \"{name}\" ON fixture_records(value);"),
                    "trigger" => format!(
                        "CREATE TRIGGER \"{name}\" BEFORE UPDATE ON fixture_records BEGIN SELECT 1; END;"
                    ),
                    "view" => {
                        format!("CREATE VIEW \"{name}\" AS SELECT id,value FROM fixture_records;")
                    }
                    _ => panic!("unexpected fixture object"),
                };
                db.execute_batch(&sql).unwrap();
            }
            db.close().unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        Self { root, manifest }
    }
    fn path(&self, role: &str) -> PathBuf {
        self.root.join(
            self.manifest["databases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["role"] == role)
                .unwrap()["relativePath"]
                .as_str()
                .unwrap(),
        )
    }
    fn oracle(&self, handoff: bool) -> Value {
        self.oracle_request(json!({"handoff":handoff}))
    }
    fn oracle_request(&self, mut request: Value) -> Value {
        request["runtimeRoot"] = json!(self.root);
        request["manifest"] = self.manifest.clone();
        let binary = std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into());
        let mut child = Command::new(binary)
            .arg(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../oracle/state-database-inventory-v1.mjs"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&json!([request])).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["profile"]["node"], "v22.23.1");
        assert_eq!(report["profile"]["icu"], "78.2");
        assert_eq!(report["profile"]["cldr"], "48.0");
        assert_eq!(report["results"][0]["ok"], true, "{report}");
        report["results"][0]["value"].clone()
    }
    fn compare(&self, handoff: bool) -> Value {
        let before = source_bytes(&self.root);
        let node = self.oracle(handoff);
        let native = if handoff {
            inspect_submission_handoff_inventory_v1(&self.root, &self.manifest)
        } else {
            inspect_state_database_inventory_v1(&self.root, &self.manifest)
        }
        .unwrap();
        assert_eq!(native, node);
        assert_eq!(
            source_bytes(&self.root),
            before,
            "source bytes and identity must not change"
        );
        native
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn source_bytes(root: &Path) -> BTreeMap<PathBuf, (Value, Vec<u8>)> {
    let mut result = BTreeMap::new();
    for entry in fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        let metadata = fs::symlink_metadata(entry.path()).unwrap();
        if metadata.is_dir() {
            result.extend(source_bytes(&entry.path()));
        } else if metadata.is_file() {
            result.insert(
                entry.path(),
                (files::identity(&metadata), fs::read(entry.path()).unwrap()),
            );
        }
    }
    result
}
fn assert_blocked(report: &Value, fragment: &str) {
    assert_eq!(
        report["status"],
        "autonomous_research_state_database_inventory_blocked"
    );
    assert_eq!(report["inventoryHash"], Value::Null);
    assert!(
        report["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str().unwrap().contains(fragment)),
        "{report}"
    );
}
#[test]
fn real_ten_database_inventory_and_handoff_match_node_without_source_writes() {
    let fixture = Fixture::new();
    let report = fixture.compare(false);
    assert_eq!(report["instances"].as_array().unwrap().len(), 10);
    assert!(report["inventoryHash"].is_string());
    assert!(
        report["instances"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["walFileIdentity"].is_null())
    );
    let handoff = fixture.compare(true);
    assert_eq!(handoff["instances"].as_array().unwrap().len(), 1);
    let evidence = observe_state_database_inventory_v1(&fixture.root, &fixture.manifest).unwrap();
    assert_eq!(evidence.runtime_root(), fixture.root);
    assert_eq!(evidence.value(), &report);
    evidence.assert_current().unwrap();
    let source = report["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["instanceId"] == "native-store")
        .unwrap();
    assert_eq!(
        evidence.inspect_database_v1("native-store").unwrap(),
        json!({"quickCheck":source["quickCheck"],"foreignKeyViolationCount":source["foreignKeyViolationCount"],"schemaHash":source["schemaHash"],"userVersion":source["userVersion"],"applicationId":source["applicationId"]})
    );
}
#[test]
fn effective_wal_schema_and_rows_match_node_and_repeated_private_snapshots() {
    let fixture = Fixture::new();
    let path = fixture.path("native-store");
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture_wal_only(id TEXT PRIMARY KEY,value TEXT); INSERT INTO fixture_wal_only VALUES('wal','effective'); UPDATE fixture_records SET value='wal-after';").unwrap();
    let before = source_bytes(&fixture.root);
    let report = fixture.compare(false);
    let native = report["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["role"] == "native-store")
        .unwrap();
    assert!(native["walFileIdentity"].is_object());
    assert!(
        native["schemaObjects"]
            .as_array()
            .unwrap()
            .contains(&json!("table:fixture_wal_only"))
    );
    let evidence = observe_state_database_inventory_v1(&fixture.root, &fixture.manifest).unwrap();
    let mut snapshots = Vec::new();
    for _ in 0..2 {
        let value = evidence
            .with_database_snapshot("native-store", |path| {
                snapshots.push(path.to_owned());
                let db =
                    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
                let value: String = db
                    .query_row(
                        "SELECT value FROM fixture_wal_only WHERE id='wal'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                Ok(value)
            })
            .unwrap();
        assert_eq!(value, "effective");
    }
    assert!(snapshots.iter().all(|p| !p.exists()));
    assert_eq!(source_bytes(&fixture.root), before);
    evidence.assert_current().unwrap();
    writer
        .execute_batch("INSERT INTO fixture_wal_only VALUES('new','mutation');")
        .unwrap();
    assert!(evidence.assert_current().is_err());
}
#[test]
fn actual_missing_unknown_schema_foreign_keys_and_exclusion_reports_match_node() {
    for mutation in [
        "missing",
        "schema",
        "foreign-key",
        "unknown-top",
        "unknown-tree",
        "retired",
        "retired-wal",
        "handoff-unknown",
    ] {
        let fixture = Fixture::new();
        let path = fixture.path("native-store");
        match mutation {
            "missing" => fs::remove_file(path).unwrap(),
            "schema" => Connection::open(path).unwrap().execute_batch("DROP TABLE workflow_states;").unwrap(),
            "foreign-key" => Connection::open(path).unwrap().execute_batch("PRAGMA foreign_keys=OFF; CREATE TABLE fixture_parent(id TEXT PRIMARY KEY); CREATE TABLE fixture_child(id TEXT PRIMARY KEY,parent TEXT REFERENCES fixture_parent(id)); INSERT INTO fixture_child VALUES('child','absent');").unwrap(),
            "unknown-top" => fs::copy(&path,fixture.root.join("unknown.sqlite")).map(|_|()).unwrap(),
            "unknown-tree" => fs::copy(&path,fixture.root.join("autonomous-research/unknown.sqlite")).map(|_|()).unwrap(),
            "retired" => fs::write(fixture.root.join("paper-automation.sqlite"),b"not-empty").unwrap(),
            "retired-wal" => {fs::write(fixture.root.join("paper-automation.sqlite"),b"").unwrap(); fs::write(fixture.root.join("paper-automation.sqlite-wal"),b"").unwrap();},
            "handoff-unknown" => fs::copy(&path,fixture.path("submission-handoff").parent().unwrap().join("extra.sqlite")).map(|_|()).unwrap(),
            _ => unreachable!(),
        }
        let report = fixture.compare(mutation == "handoff-unknown");
        assert_eq!(
            report["status"], "autonomous_research_state_database_inventory_blocked",
            "{mutation}"
        );
        if mutation != "handoff-unknown" {
            assert!(observe_state_database_inventory_v1(&fixture.root, &fixture.manifest).is_err());
        }
    }
}
#[test]
fn per_paper_unicode_scope_and_minimum_instances_match_node() {
    let mut fixture = Fixture::new();
    let source = fixture.path("topic-producer");
    for name in ["zeta", "Äther", "alpha", "文章", "🧪"] {
        let parent = fixture.root.join("autonomous-research/papers").join(name);
        fs::create_dir_all(&parent).unwrap();
        fs::copy(&source, parent.join("topic.sqlite")).unwrap();
    }
    fs::remove_file(source).unwrap();
    let definition = fixture.manifest["databases"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|v| v["role"] == "topic-producer")
        .unwrap();
    definition.as_object_mut().unwrap().remove("relativePath");
    definition["cardinality"] = json!("per-paper");
    definition["relativePathPattern"] = json!("autonomous-research/papers/{paperId}/topic.sqlite");
    let report = fixture.compare(false);
    assert_eq!(report["instances"].as_array().unwrap().len(), 14);
    observe_state_database_inventory_v1(&fixture.root, &fixture.manifest)
        .unwrap()
        .assert_current()
        .unwrap();
    fixture.manifest["databases"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|v| v["role"] == "topic-producer")
        .unwrap()["minimumInstances"] = json!(6);
    assert_blocked(&fixture.compare(false), "required_missing:topic-producer");
}
#[test]
fn unsafe_links_files_and_hidden_schema_never_mint_observations() {
    for mutation in [
        "hardlink",
        "symlink",
        "world-writable",
        "directory-link",
        "hidden-schema",
        "sparse-bound",
    ] {
        let fixture = Fixture::new();
        let path = fixture.path("native-store");
        match mutation {
            "hardlink" => fs::hard_link(&path, fixture.root.join("same-inode.alias")).unwrap(),
            "symlink" => {
                let renamed = fixture.root.join("renamed.alias");
                fs::rename(&path, &renamed).unwrap();
                symlink(renamed, &path).unwrap();
            }
            "world-writable" => {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o602)).unwrap()
            }
            "directory-link" => {
                let parent = fixture
                    .path("submission-handoff")
                    .parent()
                    .unwrap()
                    .to_owned();
                let moved = fixture.root.join("moved-handoff");
                fs::rename(&parent, &moved).unwrap();
                symlink(moved, parent).unwrap();
            }
            "hidden-schema" => Connection::open(path)
                .unwrap()
                .execute_batch("CREATE TABLE sqliteX(id TEXT PRIMARY KEY);")
                .unwrap(),
            "sparse-bound" => fs::OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_len(files::MAX_FILE_BYTES + 1)
                .unwrap(),
            _ => unreachable!(),
        }
        let result = observe_state_database_inventory_v1(&fixture.root, &fixture.manifest);
        assert!(result.is_err(), "{mutation}");
    }
}
#[test]
fn held_observation_rejects_namespace_replacement_new_database_and_sidecar_changes() {
    for mutation in [
        "replacement",
        "new-database",
        "shm-change",
        "root-replacement",
    ] {
        let fixture = Fixture::new();
        let path = fixture.path("native-store");
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch(
                "PRAGMA journal_mode=WAL; INSERT INTO fixture_records VALUES('wal','live');",
            )
            .unwrap();
        let evidence =
            observe_state_database_inventory_v1(&fixture.root, &fixture.manifest).unwrap();
        match mutation {
            "replacement" => {
                let replacement = fixture.root.join("replacement.tmp");
                fs::copy(&path, &replacement).unwrap();
                fs::rename(replacement, path).unwrap();
            }
            "new-database" => {
                fs::copy(path, fixture.root.join("new.sqlite")).unwrap();
            }
            "shm-change" => {
                let p = PathBuf::from(format!("{}-shm", path.display()));
                let mut bytes = fs::read(&p).unwrap();
                bytes[200] ^= 1;
                fs::write(p, bytes).unwrap();
            }
            "root-replacement" => {
                let renamed = fixture.root.with_extension("moved");
                fs::rename(&fixture.root, &renamed).unwrap();
                fs::create_dir(&fixture.root).unwrap();
                assert!(evidence.assert_current().is_err());
                fs::remove_dir(&fixture.root).unwrap();
                fs::rename(renamed, &fixture.root).unwrap();
                continue;
            }
            _ => unreachable!(),
        }
        assert!(evidence.assert_current().is_err(), "{mutation}");
    }
}
#[test]
fn private_snapshot_cleanup_error_and_mutation_guards_preserve_sources() {
    let fixture = Fixture::new();
    let observation =
        observe_state_database_inventory_v1(&fixture.root, &fixture.manifest).unwrap();
    let before = source_bytes(&fixture.root);
    let mut private_path = None;
    let failure: Result<()> = observation.with_database_snapshot("native-store", |path| {
        private_path = Some(path.to_owned());
        let metadata = fs::metadata(path).unwrap();
        assert_eq!(metadata.mode() & 0o777, 0o600);
        assert_ne!(
            metadata.ino(),
            fs::metadata(fixture.path("native-store")).unwrap().ino()
        );
        Err(error("fixture_callback_failed"))
    });
    assert_eq!(failure.unwrap_err().code, "fixture_callback_failed");
    assert!(!private_path.unwrap().exists());
    assert_eq!(source_bytes(&fixture.root), before);
    let failure = observation.with_database_snapshot("native-store", |_| {
        Connection::open(fixture.path("native-store"))
            .unwrap()
            .execute_batch("INSERT INTO fixture_records VALUES('mutation','after');")
            .unwrap();
        Ok(())
    });
    assert!(failure.is_err());
}

#[test]
fn snapshot_replacement_never_removes_foreign_entry_and_unwind_cleans_owned_files() {
    let fixture = Fixture::new();
    let observation =
        observe_state_database_inventory_v1(&fixture.root, &fixture.manifest).unwrap();
    let before = source_bytes(&fixture.root);
    let mut replaced_path = None;
    let result = observation.with_database_snapshot("native-store", |path| {
        replaced_path = Some(path.to_owned());
        fs::rename(path, path.with_extension("original")).unwrap();
        fs::write(path, b"foreign entry").unwrap();
        Ok(())
    });
    assert!(result.is_err());
    let path = replaced_path.unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"foreign entry");
    fs::remove_dir_all(path.parent().unwrap()).unwrap();
    let mut unwind_path = None;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _: Result<()> = observation.with_database_snapshot("native-store", |path| {
            unwind_path = Some(path.to_owned());
            panic!("isolated callback unwind");
        });
    }));
    assert!(result.is_err());
    assert!(!unwind_path.unwrap().exists());
    let mut aba_path = None;
    let result=observation.with_database_snapshot("native-store",|path|{
        aba_path=Some(path.to_owned());
        let parent=path.parent().unwrap();
        let saved=parent.with_extension("saved");
        fs::rename(parent,&saved).unwrap();
        fs::create_dir(parent).unwrap();
        fs::copy(fixture.path("resident-instance"),path).unwrap();
        let fake=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let count:i64=fake.query_row("SELECT count(*) FROM sqlite_schema WHERE name='autonomous_research_online_authority_journal_metadata'",[],|r|r.get(0)).unwrap();
        assert_eq!(count,1);
        drop(fake);
        fs::remove_dir_all(parent).unwrap();
        fs::rename(saved,parent).unwrap();
        Ok(count)
    });
    assert!(
        result.is_err(),
        "private directory ABA must not substitute inspected bytes"
    );
    assert!(!aba_path.unwrap().exists());
    assert_eq!(source_bytes(&fixture.root), before);
}

#[test]
fn namespace_entry_utf8_manifest_and_aggregate_file_limits_fail_closed() {
    let fixture = Fixture::new();
    for index in 0..10_001 {
        fs::write(fixture.root.join(format!("ignored-{index}")), b"").unwrap();
    }
    assert_eq!(
        inspect_state_database_inventory_v1(&fixture.root, &fixture.manifest)
            .unwrap_err()
            .code,
        "autonomous_research_state_database_inventory_limit_exceeded"
    );
    let fixture = Fixture::new();
    use std::os::unix::ffi::OsStringExt;
    fs::write(
        fixture.root.join(std::ffi::OsString::from_vec(vec![0xff])),
        b"",
    )
    .unwrap();
    assert_eq!(
        inspect_state_database_inventory_v1(&fixture.root, &fixture.manifest)
            .unwrap_err()
            .code,
        "autonomous_research_state_database_utf8_invalid"
    );
    let mut manifest = fixture.manifest.clone();
    manifest["databases"][0]["relativePath"] = json!("a".repeat(4097));
    assert_eq!(
        inspect_state_database_inventory_v1(&fixture.root, &manifest)
            .unwrap_err()
            .code,
        "autonomous_research_state_database_inventory_limit_exceeded"
    );
    let mut budget = files::Budget::default();
    for _ in 0..4 {
        budget.add(files::MAX_FILE_BYTES).unwrap();
    }
    assert_eq!(
        budget.add(1).unwrap_err().code,
        "autonomous_research_state_database_inventory_limit_exceeded"
    );
}

#[test]
fn crashed_writer_journal_is_rejected_without_source_recovery_and_zeroed_persist_is_supported() {
    let fixture = Fixture::new();
    let source = fixture.path("native-store");
    let binary = std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into());
    let child=Command::new(binary).args(["--input-type=module","--eval", "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=5; BEGIN IMMEDIATE; CREATE TABLE fixture_uncommitted(id INTEGER PRIMARY KEY,value TEXT)'); const insert=db.prepare('INSERT INTO fixture_uncommitted(value) VALUES(?)'); for(let n=0;n<200;n++)insert.run('x'.repeat(10000)); process.kill(process.pid,'SIGKILL');"]).arg(&source).output().unwrap();
    assert!(!child.status.success());
    let journal = PathBuf::from(format!("{}-journal", source.display()));
    let journal_bytes = fs::read(&journal).unwrap();
    assert!(journal_bytes.len() > 512);
    assert!(
        journal_bytes[..8].iter().any(|v| *v != 0),
        "fixture must contain a real pending rollback header"
    );
    let before = source_bytes(&fixture.root);
    assert_blocked(
        &inspect_state_database_inventory_v1(&fixture.root, &fixture.manifest).unwrap(),
        "rollback_journal_pending",
    );
    assert!(observe_state_database_inventory_v1(&fixture.root, &fixture.manifest).is_err());
    assert_eq!(
        source_bytes(&fixture.root),
        before,
        "observation must not recover the crashed writer"
    );
    // A normal SQLite opening performs the actual recovery before this fixture
    // continues. The inventory itself never invokes SQLite against the source.
    let db = Connection::open(&source).unwrap();
    db.query_row("SELECT count(*) FROM fixture_records", [], |r| {
        r.get::<_, i64>(0)
    })
    .unwrap();
    drop(db);
    fs::write(&journal, [0u8; 512]).unwrap();
    fs::set_permissions(&journal, fs::Permissions::from_mode(0o600)).unwrap();
    fixture.compare(false);
    let observed = observe_state_database_inventory_v1(&fixture.root, &fixture.manifest).unwrap();
    let before = source_bytes(&fixture.root);
    assert_eq!(
        observed.inspect_database_v1("native-store").unwrap()["quickCheck"],
        "ok"
    );
    assert_eq!(source_bytes(&fixture.root), before);
}

#[test]
fn pending_projection_reads_private_sqlite_and_live_open_requires_actual_instance_pins() {
    let fixture = Fixture::new();
    let source = fixture.path("native-store");
    let db = Connection::open(&source).unwrap();
    db.execute_batch("ALTER TABLE autonomous_research_online_mutation_authority_marker ADD COLUMN reservation_id TEXT; ALTER TABLE autonomous_research_online_mutation_finalization_receipt ADD COLUMN reservation_id TEXT; INSERT INTO autonomous_research_online_mutation_authority_marker VALUES('pending','test','reservation:pending'),('done','test','reservation:done'); INSERT INTO autonomous_research_online_mutation_finalization_receipt VALUES('done','test','reservation:done');").unwrap();
    drop(db);
    let observed = observe_state_database_inventory_v1(&fixture.root, &fixture.manifest).unwrap();
    let before = source_bytes(&fixture.root);
    let native = observed
        .inspect_pending_finalizations_v1("native-store")
        .unwrap();
    assert_eq!(native["pendingFinalizationCount"], 1);
    assert_eq!(
        native,
        fixture.oracle_request(json!({"operation":"pending","instanceId":"native-store"}))
    );
    assert_eq!(source_bytes(&fixture.root), before);
    let live = crate::online_runtime_activation::database::open_live_activation_database_v1(
        &observed,
        "native-store",
    )
    .unwrap();
    drop(live);
    Connection::open(source)
        .unwrap()
        .execute_batch("INSERT INTO fixture_records VALUES('after','changed');")
        .unwrap();
    assert!(
        crate::online_runtime_activation::database::open_live_activation_database_v1(
            &observed,
            "native-store"
        )
        .is_err()
    );
    // Startup deliberately updates one instance at a time. A different pinned
    // instance can be opened, but the complete old inventory is now stale.
    assert!(
        crate::online_runtime_activation::database::open_live_activation_database_v1(
            &observed,
            "resident-instance"
        )
        .is_ok()
    );
    assert!(observed.assert_current().is_err());
}

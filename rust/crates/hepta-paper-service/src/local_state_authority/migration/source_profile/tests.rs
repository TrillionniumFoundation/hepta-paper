use super::*;
use crate::sqlite_mutation_coordinator::hash_bytes;
use rusqlite::OpenFlags;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    oracle: Value,
}
impl Fixture {
    fn node() -> Self {
        let suffix = format!(
            "{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let root = PathBuf::from(format!("/tmp/hepta-source-profile-{suffix}"));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let service = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo = service.ancestors().nth(3).unwrap();
        let output = Command::new("node")
            .arg(service.join("src/local_state_authority/migration/source_profile/oracle.mjs"))
            .arg(repo)
            .arg(&root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let oracle: Value = serde_json::from_slice(&output.stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&oracle["profile"]).unwrap();
        Self { root, oracle }
    }
    fn database(&self) -> PathBuf {
        self.root.join("authority.sqlite")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn memory(sql: &str) -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(sql).unwrap();
    db
}
fn begin_read(db: &Connection) {
    db.execute_batch("BEGIN DEFERRED").unwrap();
    db.query_row("SELECT count(*) FROM main.sqlite_schema", [], |r| {
        r.get::<_, i64>(0)
    })
    .unwrap();
}
fn metadata(db: &Connection) -> Vec<Value> {
    let mut statement = db.prepare("SELECT json_array(singleton,configuration_hash,authority_id,key_id,scope_id,database_scope_hash,writer_manifest_hash,global_sequence,global_hash,schema_transition_state) FROM main.authority_metadata ORDER BY singleton").unwrap();
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|row| serde_json::from_str(&row.unwrap()).unwrap())
        .collect()
}
fn peer(fixture: &Fixture, blocked: bool) {
    let test = format!(
        "{}::sqlite_peer",
        module_path!().split_once("::").unwrap().1
    );
    let output = Command::new("/proc/self/exe")
        .args(["--exact", &test, "--nocapture"])
        .env("HEPTA_SOURCE_PROFILE_PEER_PATH", fixture.database())
        .env(
            "HEPTA_SOURCE_PROFILE_PEER_BLOCKED",
            if blocked { "1" } else { "0" },
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("source_profile_peer_checked"));
}

#[test]
fn sqlite_peer() {
    let Some(path) = std::env::var_os("HEPTA_SOURCE_PROFILE_PEER_PATH") else {
        return;
    };
    let blocked = std::env::var("HEPTA_SOURCE_PROFILE_PEER_BLOCKED").unwrap() == "1";
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    let result = db.execute_batch("BEGIN IMMEDIATE");
    if blocked {
        assert_eq!(
            result.unwrap_err().sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
    } else {
        result.unwrap();
        db.execute_batch("ROLLBACK").unwrap();
    }
    println!("source_profile_peer_checked");
}

#[test]
fn original_node_file_matches_complete_profile_without_byte_row_or_setting_changes() {
    let fixture = Fixture::node();
    assert_eq!(fixture.oracle["userVersion"], 0);
    assert_eq!(fixture.oracle["catalog"].as_array().unwrap().len(), 12);
    assert_eq!(
        fixture.oracle["metadata"][0]["schema_transition_state"],
        "uninitialized"
    );
    // Raw file reads occur only outside the owning SQLite connection lifetime.
    let before = fs::read(fixture.database()).unwrap();
    let profile;
    {
        let db = Connection::open_with_flags(fixture.database(), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
        db.execute_batch("PRAGMA query_only=ON").unwrap();
        begin_read(&db);
        let original_rows = metadata(&db);
        let original_changes = db.total_changes();
        let original_mode: String = db
            .query_row("PRAGMA main.journal_mode", [], |r| r.get(0))
            .unwrap();
        profile = inspect_source_schema(&db).unwrap();
        assert_eq!(profile.schema()["catalog"].as_array().unwrap().len(), 12);
        assert_eq!(profile.schema()["tables"].as_array().unwrap().len(), 6);
        let mutation = profile.schema()["tables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "authority_mutation")
            .unwrap();
        assert_eq!(mutation["indices"].as_array().unwrap().len(), 3);
        assert_eq!(
            profile.schema_hash(),
            hash(DOMAIN, profile.schema()).unwrap()
        );
        let report = super::super::inspect_legacy_authority_journal_schema_v1(&db).unwrap();
        assert_eq!(report["sourceSchema"], *profile.schema());
        assert_eq!(report["sourceSchemaHash"], profile.schema_hash());
        assert_eq!(
            report["evidenceScope"],
            "schema_only_no_migration_authority"
        );
        assert_eq!(metadata(&db), original_rows);
        assert_eq!(db.total_changes(), original_changes);
        assert_eq!(
            db.query_row("PRAGMA main.journal_mode", [], |r| r.get::<_, String>(0))
                .unwrap(),
            original_mode
        );
        assert_eq!(integer(&db, "PRAGMA query_only").unwrap(), 1);
        assert_eq!(
            db.transaction_state(Some("main")).unwrap(),
            TransactionState::Read
        );
        db.execute_batch("ROLLBACK").unwrap();
    }
    assert_eq!(
        hash_bytes(&fs::read(fixture.database()).unwrap()),
        hash_bytes(&before)
    );
    let db = memory(SOURCE_SCHEMA);
    begin_read(&db);
    assert_eq!(profile, inspect_source_schema(&db).unwrap());
}

#[test]
fn requires_a_real_main_snapshot_and_does_not_create_one_for_the_caller() {
    let db = memory(SOURCE_SCHEMA);
    assert_eq!(
        inspect_source_schema(&db).unwrap_err().code,
        "local_authority_source_schema_held_transaction_required"
    );
    db.execute_batch("BEGIN DEFERRED").unwrap();
    assert_eq!(
        inspect_source_schema(&db).unwrap_err().code,
        "local_authority_source_schema_held_transaction_required"
    );
    assert_eq!(
        db.transaction_state(Some("main")).unwrap(),
        TransactionState::None
    );
    db.execute_batch("ROLLBACK; ATTACH ':memory:' AS other; CREATE TABLE other.held(x); BEGIN DEFERRED; INSERT INTO other.held VALUES(1)").unwrap();
    assert_eq!(
        db.transaction_state(Some("other")).unwrap(),
        TransactionState::Write
    );
    assert_eq!(
        inspect_source_schema(&db).unwrap_err().code,
        "local_authority_source_schema_held_transaction_required"
    );
    db.execute_batch("ROLLBACK").unwrap();
    begin_read(&db);
    inspect_source_schema(&db).unwrap();
}

#[test]
fn refuses_native_mixed_extra_and_semantically_changed_schemas() {
    let native = include_str!("../../schema.sql");
    let variants = [
        native.to_owned(),
        format!(
            "{SOURCE_SCHEMA}\nCREATE TABLE authority_native_identity(singleton INTEGER PRIMARY KEY,key_hash TEXT NOT NULL) STRICT;"
        ),
        format!("{SOURCE_SCHEMA}\nCREATE TABLE unexpected(x);"),
        format!("{SOURCE_SCHEMA}\nCREATE INDEX unexpected ON authority_mutation(status);"),
        format!("{SOURCE_SCHEMA}\nCREATE VIEW unexpected AS SELECT * FROM authority_metadata;"),
        format!(
            "{SOURCE_SCHEMA}\nCREATE TRIGGER unexpected AFTER UPDATE ON authority_metadata BEGIN SELECT 1; END;"
        ),
        SOURCE_SCHEMA.replace(
            "global_sequence INTEGER NOT NULL UNIQUE",
            "global_sequence INTEGER NOT NULL",
        ),
        SOURCE_SCHEMA.replace("CHECK(global_sequence>=0)", "CHECK(global_sequence>=-1)"),
        SOURCE_SCHEMA.replace(
            "database_instance_id TEXT PRIMARY KEY",
            "database_instance_id TEXT PRIMARY KEY COLLATE NOCASE",
        ),
        SOURCE_SCHEMA.replace(
            "  global_hash TEXT NOT NULL,",
            "  global_hash TEXT NOT NULL DEFAULT 'changed',",
        ),
    ];
    for (index, sql) in variants.iter().enumerate() {
        let db = memory(sql);
        begin_read(&db);
        assert!(
            inspect_source_schema(&db).is_err(),
            "accepted altered schema {index}"
        );
        assert_eq!(
            db.transaction_state(Some("main")).unwrap(),
            TransactionState::Read
        );
    }
    let db = memory(SOURCE_SCHEMA);
    db.execute_batch("PRAGMA user_version=1").unwrap();
    begin_read(&db);
    assert_eq!(
        inspect_source_schema(&db).unwrap_err().code,
        "local_authority_source_schema_version_invalid"
    );
}

#[test]
fn physical_root_page_allocation_is_checked_but_does_not_change_structural_hash() {
    let expected = memory(SOURCE_SCHEMA);
    begin_read(&expected);
    let allocated = memory(&format!(
        "CREATE TABLE padding(x); {SOURCE_SCHEMA} DROP TABLE padding;"
    ));
    begin_read(&allocated);
    assert_ne!(
        rows(
            &expected,
            "SELECT rootpage FROM sqlite_schema ORDER BY type,name",
            []
        )
        .unwrap(),
        rows(
            &allocated,
            "SELECT rootpage FROM sqlite_schema ORDER BY type,name",
            []
        )
        .unwrap()
    );
    assert_eq!(
        inspect_source_schema(&expected).unwrap(),
        inspect_source_schema(&allocated).unwrap()
    );
}

#[test]
fn quick_check_rejects_corrupt_data_even_when_the_exact_schema_matches() {
    let db = memory(SOURCE_SCHEMA);
    db.execute_batch("PRAGMA ignore_check_constraints=ON; INSERT INTO authority_metadata VALUES(1,'config','authority','key','scope','scopehash','writers',-1,'head','uninitialized'); PRAGMA ignore_check_constraints=OFF").unwrap();
    begin_read(&db);
    assert_eq!(
        inspect_source_schema(&db).unwrap_err().code,
        "local_authority_source_schema_integrity_invalid"
    );
    assert_eq!(
        db.transaction_state(Some("main")).unwrap(),
        TransactionState::Read
    );
}

#[test]
fn query_helper_rejects_mutation_before_it_runs() {
    let db = memory(SOURCE_SCHEMA);
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert_eq!(
        rows(&db, "DROP TABLE authority_mutation", [])
            .unwrap_err()
            .code,
        "local_authority_source_schema_readonly_required"
    );
    inspect_source_schema(&db).unwrap();
    assert_eq!(integer(&db, "PRAGMA query_only").unwrap(), 0);
}

#[test]
fn oversized_catalogs_and_values_are_bounded_before_collection() {
    let many = (0..65)
        .map(|i| format!("CREATE TABLE extra_{i}(x);"))
        .collect::<String>();
    let huge = format!(
        "CREATE TABLE extra(x TEXT DEFAULT '{}');",
        "x".repeat(MAX_CELL_BYTES)
    );
    let cumulative = (0..16)
        .map(|i| {
            format!(
                "CREATE TABLE extra_{i}(x TEXT DEFAULT '{}');",
                "x".repeat(3000)
            )
        })
        .collect::<String>();
    for extra in [many, huge, cumulative] {
        let db = memory(&format!("{SOURCE_SCHEMA} {extra}"));
        begin_read(&db);
        let changes = db.total_changes();
        assert_eq!(
            inspect_source_schema(&db).unwrap_err().code,
            "local_authority_source_schema_limit_exceeded"
        );
        assert_eq!(
            db.transaction_state(Some("main")).unwrap(),
            TransactionState::Read
        );
        assert_eq!(db.total_changes(), changes);
    }
    let db = memory(SOURCE_SCHEMA);
    begin_read(&db);
    assert_eq!(
        rows(&db, "SELECT 1,2,3,4,5,6,7,8", []).unwrap_err().code,
        "local_authority_source_schema_limit_exceeded"
    );
    inspect_source_schema(&db).unwrap();
}

#[test]
fn genuine_delete_and_wal_writer_locks_survive_success_and_refusal() {
    for mode in ["DELETE", "WAL"] {
        let fixture = Fixture::node();
        {
            let db = Connection::open(fixture.database()).unwrap();
            db.pragma_update(None, "journal_mode", mode).unwrap();
        }
        let original = fs::read(fixture.database()).unwrap();
        {
            let db =
                Connection::open_with_flags(fixture.database(), OpenFlags::SQLITE_OPEN_READ_WRITE)
                    .unwrap();
            db.execute_batch("BEGIN IMMEDIATE").unwrap();
            let original_rows = metadata(&db);
            peer(&fixture, true);
            inspect_source_schema(&db).unwrap();
            peer(&fixture, true);
            // Real SQLite reproducer: with this flag ON even quick_check says
            // ok for a row violating the original Node CHECK constraint.
            db.execute_batch("PRAGMA ignore_check_constraints=ON; UPDATE authority_metadata SET global_sequence=-1").unwrap();
            let invalid_rows = metadata(&db);
            let before_rejection = db.total_changes();
            assert_eq!(
                rows(&db, "PRAGMA main.quick_check", []).unwrap(),
                vec![json!(["ok"])]
            );
            assert_eq!(
                inspect_source_schema(&db).unwrap_err().code,
                "local_authority_source_schema_connection_settings_invalid"
            );
            assert_eq!(integer(&db, "PRAGMA ignore_check_constraints").unwrap(), 1);
            assert_eq!(metadata(&db), invalid_rows);
            assert_eq!(db.total_changes(), before_rejection);
            assert_eq!(
                db.transaction_state(Some("main")).unwrap(),
                TransactionState::Write
            );
            peer(&fixture, true);
            // Only the test caller changes the flag/row. The inspector neither
            // repairs data nor resets settings on any of these refusal paths.
            db.execute_batch("PRAGMA ignore_check_constraints=OFF")
                .unwrap();
            assert_eq!(
                inspect_source_schema(&db).unwrap_err().code,
                "local_authority_source_schema_integrity_invalid"
            );
            assert_eq!(metadata(&db), invalid_rows);
            peer(&fixture, true);
            db.execute_batch(
                "UPDATE authority_metadata SET global_sequence=0; PRAGMA writable_schema=ON",
            )
            .unwrap();
            let before_rejection = db.total_changes();
            assert_eq!(
                inspect_source_schema(&db).unwrap_err().code,
                "local_authority_source_schema_connection_settings_invalid"
            );
            assert_eq!(integer(&db, "PRAGMA writable_schema").unwrap(), 1);
            assert_eq!(metadata(&db), original_rows);
            assert_eq!(db.total_changes(), before_rejection);
            assert_eq!(
                db.transaction_state(Some("main")).unwrap(),
                TransactionState::Write
            );
            peer(&fixture, true);
            db.execute_batch("PRAGMA writable_schema=OFF").unwrap();
            inspect_source_schema(&db).unwrap();
            // A failed inspection must neither roll back nor release any main
            // or SHM process lock. The test itself restores this version write.
            db.execute_batch("PRAGMA user_version=1").unwrap();
            assert_eq!(
                inspect_source_schema(&db).unwrap_err().code,
                "local_authority_source_schema_version_invalid"
            );
            peer(&fixture, true);
            assert_eq!(metadata(&db), original_rows);
            assert_eq!(
                db.transaction_state(Some("main")).unwrap(),
                TransactionState::Write
            );
            db.execute_batch("ROLLBACK").unwrap();
            peer(&fixture, false);
        }
        assert_eq!(fs::read(fixture.database()).unwrap(), original);
    }
}

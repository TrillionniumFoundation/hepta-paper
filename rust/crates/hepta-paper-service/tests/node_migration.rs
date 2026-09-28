use hepta_paper_service::node_migration::{NodeMigrationError, migrate_node_store_v1};
use rusqlite::Connection;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(1);

struct Temp(PathBuf);

impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-rust-node-migration-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }

    fn database(&self) -> PathBuf {
        let path = self.0.join("paper.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("PRAGMA user_version=1;").unwrap();
        drop(connection);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn applies_embedded_node_migrations_with_idempotent_receipt() {
    let temp = Temp::new();
    let path = temp.database();
    let receipt = migrate_node_store_v1(&path, Some(2)).expect("migration");
    assert_eq!(receipt.before_version, 0);
    assert_eq!(receipt.target_version, 2);
    assert_eq!(receipt.applied_versions, [1, 2]);
    assert!(!receipt.production_activation);
    assert!(!receipt.node_retirement_verified);

    let second = migrate_node_store_v1(&path, Some(2)).expect("idempotent migration");
    assert_eq!(second.before_version, 2);
    assert!(second.applied_versions.is_empty());
    assert_eq!(second.database_sha256, receipt.database_sha256);
}

#[test]
fn rejects_sidecars_before_mutating_the_database() {
    let temp = Temp::new();
    let path = temp.database();
    fs::write(format!("{}-wal", path.display()), b"active").unwrap();
    assert!(matches!(
        migrate_node_store_v1(&path, Some(1)),
        Err(NodeMigrationError::Sidecar)
    ));
}

#[test]
fn rejects_target_behind_applied_history() {
    let temp = Temp::new();
    let path = temp.database();
    migrate_node_store_v1(&path, Some(2)).expect("migration");
    assert!(matches!(
        migrate_node_store_v1(&path, Some(1)),
        Err(NodeMigrationError::Target)
    ));
}

#[test]
fn applies_the_complete_embedded_migration_catalog() {
    let temp = Temp::new();
    let path = temp.database();
    let receipt = migrate_node_store_v1(&path, None).expect("complete migration catalog");
    assert_eq!(receipt.before_version, 0);
    assert_eq!(receipt.target_version, 25);
    assert_eq!(receipt.applied_versions.len(), 25);
    assert_eq!(receipt.applied_versions.first(), Some(&1));
    assert_eq!(receipt.applied_versions.last(), Some(&25));
}

#[test]
fn rejects_migration_when_a_live_job_lease_is_present() {
    let temp = Temp::new();
    let path = temp.database();
    migrate_node_store_v1(&path, Some(2)).expect("initial migrations");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO jobs(job_id,deduplication_key,kind,status,spec_json,created_at,updated_at)
             VALUES ('job-1','dedupe-1','test','running','{}','now','now')",
            [],
        )
        .unwrap();
    drop(connection);
    assert!(matches!(
        migrate_node_store_v1(&path, Some(3)),
        Err(NodeMigrationError::ActiveLease)
    ));
}

#[test]
fn rejects_migration_when_a_response_consumer_lease_is_present() {
    let temp = Temp::new();
    let path = temp.database();
    migrate_node_store_v1(&path, Some(20)).expect("initial migrations");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO submission_outbox(
                message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,
                payload_json,created_at,updated_at
             ) VALUES ('message-1','paper-1','dispatch-1','provider-1','account-1',
                       'nonce-1','waiting_for_response','{}','now','now')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO submission_inbox(
                response_id,message_id,dispatch_hash,outcome,response_json,received_at
             ) VALUES ('response-1','message-1','dispatch-1','accepted','{}','now')",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO submission_response_consumption(
                response_id,message_id,provider,account_id,anchor_hash,state,
                claimed_by,lease_token,lease_expires_at,created_at,updated_at
             ) VALUES ('response-1','message-1','provider-1','account-1','anchor-1',
                       'IN_PROGRESS','worker-1','lease-1','later','now','now')",
            [],
        )
        .unwrap();
    drop(connection);
    assert!(matches!(
        migrate_node_store_v1(&path, Some(21)),
        Err(NodeMigrationError::ActiveLease)
    ));
}

#[test]
fn rejects_dangling_sidecars_without_following_or_replacing_them() {
    use std::os::unix::fs::symlink;
    for suffix in ["-wal", "-shm", "-journal"] {
        let temp = Temp::new();
        let path = temp.database();
        let before = fs::read(&path).unwrap();
        let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
        let missing = temp.0.join("unrelated-missing-target");
        symlink(&missing, &sidecar).unwrap();
        let result = migrate_node_store_v1(&path, Some(1));
        assert!(
            matches!(result, Err(NodeMigrationError::Sidecar)),
            "{suffix}: {result:?}"
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(fs::read_link(&sidecar).unwrap(), missing);
        assert!(!missing.exists());
    }
}

#[test]
fn ordinary_cli_refuses_actual_hot_journal_without_recovering_source_bytes() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    let temp = Temp::new();
    let path = temp.database();
    migrate_node_store_v1(&path, Some(2)).unwrap();
    let c = Connection::open(&path).unwrap();
    c.execute_batch(
        "CREATE TABLE crash_probe(id INTEGER PRIMARY KEY, payload BLOB);
        INSERT INTO crash_probe VALUES(1, zeroblob(262144));",
    )
    .unwrap();
    drop(c);
    // The real child spills uncommitted pages. Exiting without SQLite cleanup
    // leaves its actual hot rollback journal; no journal bytes are fabricated.
    let mut child = Command::new("python3")
        .args(["-u", "-c", "import sqlite3,sys,os
c=sqlite3.connect(sys.argv[1]);c.execute('PRAGMA cache_size=1');c.execute('BEGIN IMMEDIATE');c.execute('UPDATE crash_probe SET payload=randomblob(262144)');print('uncommitted',flush=True);sys.stdin.readline();os._exit(0)"])
        .arg(&path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line.trim(), "uncommitted");
    child.stdin.take().unwrap().write_all(b"exit\n").unwrap();
    assert!(child.wait().unwrap().success());
    let journal = PathBuf::from(format!("{}-journal", path.display()));
    let journal_before = fs::read(&journal).unwrap();
    assert!(journal_before.len() > 512);
    assert!(journal_before[..8].iter().any(|byte| *byte != 0));
    let before = fs::read(&path).unwrap();
    for _ in 0..2 {
        let result = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
            .arg("store-migrate")
            .arg(&path)
            .arg("3")
            .output()
            .unwrap();
        assert_eq!(
            result.status.code(),
            Some(1),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(String::from_utf8_lossy(&result.stderr).contains("sidecar"));
        assert_eq!(
            fs::read(&path).unwrap(),
            before,
            "refusal must not recover source"
        );
        assert_eq!(fs::read(&journal).unwrap(), journal_before);
    }
}

#[test]
fn late_schema_error_rolls_back_the_whole_requested_range() {
    use std::process::Command;
    let temp = Temp::new();
    let path = temp.database();
    let db = Connection::open(&path).unwrap();
    // This pre-existing incompatible table fails the second migration, after
    // the first migration's real DDL has already run inside the owner.
    db.execute_batch("CREATE TABLE jobs(incompatible TEXT);")
        .unwrap();
    drop(db);
    let before = fs::read(&path).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("store-migrate")
        .arg(&path)
        .arg("3")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert_eq!(
        fs::read(&path).unwrap(),
        before,
        "no intermediate migration may commit"
    );
    let db = Connection::open(&path).unwrap();
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='schema_migrations'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn wal_header_without_sidecars_is_refused_without_creating_them() {
    let temp = Temp::new();
    let path = temp.database();
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    drop(db);
    let before = fs::read(&path).unwrap();
    assert_eq!(before[18], 2);
    assert!(matches!(
        migrate_node_store_v1(&path, Some(1)),
        Err(NodeMigrationError::Sidecar)
    ));
    assert_eq!(fs::read(&path).unwrap(), before);
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(fs::symlink_metadata(format!("{}{suffix}", path.display())).is_err());
    }
}

#[test]
fn ordinary_node_and_rust_upgrade_preserve_real_results_and_same_schema_history() {
    use std::process::Command;
    let temp = Temp::new();
    let native = temp.database();
    migrate_node_store_v1(&native, Some(20)).unwrap();
    let db = Connection::open(&native).unwrap();
    db.execute_batch("INSERT INTO papers(slug,title,canonical_dir) VALUES ('retained','existing result','/local/result');
        INSERT INTO artifacts(slug,kind,path,sha256,bytes) VALUES ('retained','result','result.bin','retained-digest',17);").unwrap();
    drop(db);
    for name in ["workspace", "assets", "runtime", "legacy"] {
        let dir = temp.0.join(name);
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let original = temp.0.join("runtime/hepta-paper.sqlite");
    fs::copy(&native, &original).unwrap();
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let node = Command::new("node")
        .current_dir(&repository)
        .args(["paper-core/bin/hepta-store.mjs", "migrate"])
        .env("HEPTA_PAPER_WORKSPACE_ROOT", temp.0.join("workspace"))
        .env("HEPTA_PAPER_ASSET_ROOT", temp.0.join("assets"))
        .env("HEPTA_PAPER_RUNTIME_ROOT", temp.0.join("runtime"))
        .env("PAPER_FACTORY_LEGACY_ROOT", temp.0.join("legacy"))
        .output()
        .unwrap();
    assert!(
        node.status.success(),
        "{}",
        String::from_utf8_lossy(&node.stderr)
    );
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("store-migrate")
        .arg(&native)
        .arg("25")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["beforeVersion"], 20);
    assert_eq!(
        receipt["appliedVersions"],
        serde_json::json!([21, 22, 23, 24, 25])
    );
    assert_eq!(receipt["productionActivation"], false);
    assert_eq!(receipt["nodeRetirementVerified"], false);
    fn rows(path: &std::path::Path, sql: &str) -> Vec<Vec<String>> {
        let db =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut statement = db.prepare(sql).unwrap();
        let count = statement.column_count();
        statement
            .query_map([], |row| {
                (0..count).map(|i| row.get::<_, String>(i)).collect()
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }
    for sql in [
        "SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_schema WHERE substr(name,1,7)!='sqlite_' ORDER BY type,name",
        "SELECT CAST(version AS TEXT),name,migration_sha256 FROM schema_migrations ORDER BY version",
        "SELECT slug,title,canonical_dir FROM papers ORDER BY slug",
        "SELECT slug,kind,path,sha256,CAST(bytes AS TEXT) FROM artifacts ORDER BY artifact_id",
    ] {
        assert_eq!(rows(&native, sql), rows(&original, sql), "{sql}");
    }
    let before = fs::read(&native).unwrap();
    let replay = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("store-migrate")
        .arg(&native)
        .arg("25")
        .output()
        .unwrap();
    assert!(replay.status.success());
    let replay: serde_json::Value = serde_json::from_slice(&replay.stdout).unwrap();
    assert_eq!(replay["appliedVersions"], serde_json::json!([]));
    assert_eq!(replay["databaseSha256"], receipt["databaseSha256"]);
    assert_eq!(fs::read(&native).unwrap(), before);
}

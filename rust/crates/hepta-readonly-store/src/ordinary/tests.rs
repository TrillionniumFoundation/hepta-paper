use super::*;
use crate::{FixedInventoryBudgetV1, ReadOnlyStoreV1};
use std::{
    process::Command,
    sync::{
        MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    _lifecycle_guard: MutexGuard<'static, ()>,
}
impl Fixture {
    fn new() -> Self {
        let lifecycle_guard = crate::READ_ONLY_FIXTURE_DIRECTORY_LIFECYCLE
            .lock()
            .expect("read-only test fixture lifecycle poisoned");
        let root = PathBuf::from("/dev/shm").join(format!(
            "hepta-ordinary-store-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self {
            root,
            _lifecycle_guard: lifecycle_guard,
        }
    }
    fn database(&self) -> PathBuf {
        self.root.join("ordinary.sqlite")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn fixture_writer(path: &Path, wal: bool) -> Connection {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(if wal {
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA wal_autocheckpoint=0"
        } else {
            "PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF"
        })
        .unwrap();
    connection
}
fn oracle(path: &Path) -> String {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let node = PathBuf::from(
        std::env::var_os("HEPTA_TEST_NODE")
            .or_else(|| std::env::var_os("HEPTA_NODE_BINARY"))
            .expect("qualified Node"),
    );
    let result = Command::new(&node)
        .env_clear()
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", node.parent().unwrap().display()),
        )
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8")
        .arg(root.join("paper-core/bin/hepta-paper.mjs"))
        .args(["verify", "store", "--"])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        result.status.code() == Some(0) || result.status.code() == Some(1),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        result.stdout.starts_with(b"{"),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}
fn assert_report(path: &Path, store: &OrdinaryReadOnlyStoreV1) {
    let expected = oracle(path);
    let report = store.node_logical_integrity_report().unwrap();
    let actual = serde_json::to_vec(&report).unwrap();
    assert_eq!(
        hepta_legacy_compatibility::parse_and_encode_production_v1(&actual).unwrap(),
        hepta_legacy_compatibility::parse_and_encode_production_v1(expected.trim().as_bytes())
            .unwrap()
    );
}
#[test]
fn actual_node_arbitrary_schema_sql_values_and_column_insertion_hash_match() {
    let fixture = Fixture::new();
    let path = fixture.database();
    let writer = fixture_writer(&path, false);
    writer.execute_batch("CREATE TABLE custom(\"é\" TEXT,\"é\" TEXT,pk INTEGER PRIMARY KEY,bytes BLOB,number REAL,odd TEXT);INSERT INTO custom VALUES('first','second',2,x'000a7fff',1e21,CAST(x'eda080' AS TEXT));INSERT INTO custom VALUES('changed','earlier',1,x'00',1e-7,CAST(x'f08080af' AS TEXT));CREATE VIEW custom_view AS SELECT pk FROM custom;CREATE TABLE sqliteevil(x);INSERT INTO sqliteevil VALUES(1)").unwrap();
    drop(writer);
    assert!(ReadOnlyStoreV1::open(&path).is_err());
    let ordinary = OrdinaryReadOnlyStoreV1::open(&path).unwrap();
    assert_report(&path, &ordinary);
    ordinary.verify_unchanged().unwrap();
    assert!(!ordinary.coordination_observation().shm_created_by_read_open);
}
#[test]
fn actual_node_live_and_copied_closed_wal_read_match_and_shm_creation_is_observed() {
    let fixture = Fixture::new();
    let path = fixture.database();
    let writer = fixture_writer(&path, true);
    writer.execute_batch("CREATE TABLE arbitrary(pk INTEGER PRIMARY KEY,value TEXT);INSERT INTO arbitrary VALUES(1,'in-real-wal')").unwrap();
    let reader = OrdinaryReadOnlyStoreV1::open(&path).unwrap();
    assert_report(&path, &reader);
    assert!(reader.coordination_observation().shm_present_before_open);
    assert!(!reader.coordination_observation().shm_created_by_read_open);
    assert!(ReadOnlyStoreV1::open(&path).is_err());
    let closed = fixture.root.join("closed.sqlite");
    fs::copy(&path, &closed).unwrap();
    fs::copy(sidecar(&path, "-wal"), sidecar(&closed, "-wal")).unwrap();
    let closed_reader = OrdinaryReadOnlyStoreV1::open(&closed).unwrap();
    assert!(
        closed_reader
            .coordination_observation()
            .shm_created_by_read_open
    );
    assert_report(&closed, &closed_reader);
    closed_reader.verify_unchanged().unwrap();
}
#[test]
fn ordinary_rejects_replaced_files_symlinks_new_wal_and_changed_bytes_then_reopens_current_snapshot()
 {
    let fixture = Fixture::new();
    let path = fixture.database();
    let writer = fixture_writer(&path, false);
    writer
        .execute_batch("CREATE TABLE custom(x);INSERT INTO custom VALUES(1)")
        .unwrap();
    drop(writer);
    let reader = OrdinaryReadOnlyStoreV1::open(&path).unwrap();
    let replacement = fixture.root.join("replacement.sqlite");
    fs::copy(&path, &replacement).unwrap();
    fs::rename(&replacement, &path).unwrap();
    assert!(matches!(
        reader.verify_unchanged(),
        Err(ReadOnlyStoreError::DatabaseChanged)
    ));
    drop(reader);
    let reader = OrdinaryReadOnlyStoreV1::open(&path).unwrap();
    fs::write(sidecar(&path, "-wal"), b"new unrelated sidecar").unwrap();
    assert!(reader.verify_unchanged().is_err());
    drop(reader);
    fs::remove_file(sidecar(&path, "-wal")).unwrap();
    let reader = OrdinaryReadOnlyStoreV1::open(&path).unwrap();
    let external = fs::OpenOptions::new().write(true).open(&path).unwrap();
    external.write_at(&[0, 0, 0, 2], 60).unwrap();
    assert!(reader.verify_unchanged().is_err());
    drop(reader);
    let retry = OrdinaryReadOnlyStoreV1::open(&path).unwrap();
    assert_report(&path, &retry);
    assert_eq!(
        retry
            .node_logical_integrity_report()
            .unwrap()
            .total_row_count,
        1
    );
    let alias = fixture.root.join("alias.sqlite");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    let through_alias = OrdinaryReadOnlyStoreV1::open(&alias).unwrap();
    assert_report(&alias, &through_alias);
    fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&fixture.root, &alias).unwrap();
    assert!(through_alias.verify_unchanged().is_err());
}
#[test]
fn actual_node_accepts_ordinary_cell_beyond_explicit_native_safety_profile() {
    let fixture = Fixture::new();
    let path = fixture.database();
    let writer = fixture_writer(&path, false);
    writer
        .execute_batch(
            "CREATE TABLE custom(x);INSERT INTO custom VALUES(printf('%.*c',1048577,'a'))",
        )
        .unwrap();
    drop(writer);
    let expected: serde_json::Value = serde_json::from_str(&oracle(&path)).unwrap();
    assert_eq!(expected["totalRowCount"], 1);
    let reader = OrdinaryReadOnlyStoreV1::open(&path).unwrap();
    assert!(matches!(
        reader.node_logical_integrity_report(),
        Err(ReadOnlyStoreError::OrdinaryBudgetExceeded("cell_bytes_v1"))
    ));
    reader.verify_unchanged().unwrap();
}
#[test]
fn fixed_inventory_queries_are_real_independent_bounded_business_reads() {
    let fixture = Fixture::new();
    let path = fixture.database();
    let writer = fixture_writer(&path, false);
    writer.execute_batch("CREATE TABLE papers(slug,title,status,venue_target,paper_type,canonical_dir,source_dir,current_pdf,current_source_zip,current_verdict,next_action,updated_at,metadata_json);CREATE TABLE submission_ledger(slug,lifecycle_stage,submission_state,next_action,evidence_json);CREATE TABLE paper_campaigns(campaign_id,paper_id,spec_json);CREATE TABLE venues(venue_id,name,kind,cycle,deadline,metadata_json);INSERT INTO papers VALUES('p','Title','ready','v','article','old','new','','','ok','revise','2000','{\"campaignId\":\"c\"}');INSERT INTO submission_ledger VALUES('p','draft','local','review','{}');INSERT INTO paper_campaigns VALUES('c','p','{\"localOnly\":true}');INSERT INTO venues VALUES('v','Venue','journal','2026','2000','{}')").unwrap();
    let reader = OrdinaryReadOnlyStoreV1::open(&path).unwrap();
    let projection = reader
        .fixed_inventory_projection_v1(&FixedInventoryBudgetV1::default())
        .unwrap();
    assert!(projection.papers.ok);
    assert!(projection.venues.ok);
    assert_eq!(projection.papers.rows[0].source_dir.get(), "\"new\"");
    assert_eq!(projection.papers.rows[0].campaign_local_only.get(), "1");
    drop(reader);
    writer.execute_batch("DROP TABLE venues").unwrap();
    let reader = OrdinaryReadOnlyStoreV1::open(&path).unwrap();
    let projection = reader
        .fixed_inventory_projection_v1(&FixedInventoryBudgetV1::default())
        .unwrap();
    assert!(projection.papers.ok);
    assert!(!projection.venues.ok);
    drop(reader);
    writer.execute_batch("UPDATE papers SET metadata_json='malformed';CREATE TABLE venues(venue_id,name,kind,cycle,deadline,metadata_json)").unwrap();
    let reader = OrdinaryReadOnlyStoreV1::open(&path).unwrap();
    let projection = reader
        .fixed_inventory_projection_v1(&FixedInventoryBudgetV1::default())
        .unwrap();
    assert!(!projection.papers.ok);
    assert!(projection.papers.error.unwrap().contains("malformed JSON"));
    assert!(projection.venues.ok);
    drop(reader);
    writer
        .execute_batch(
            "UPDATE papers SET metadata_json='{}';UPDATE papers SET title=printf('%.*c',65537,'a')",
        )
        .unwrap();
    let reader = OrdinaryReadOnlyStoreV1::open(&path).unwrap();
    assert!(
        reader
            .fixed_inventory_projection_v1(&FixedInventoryBudgetV1::default())
            .unwrap()
            .papers
            .error
            .unwrap()
            .contains("inventory_cell_bytes_v1")
    );
    drop(reader);
    writer.execute_batch("UPDATE papers SET title='ok';UPDATE papers SET metadata_json='{\"campaignId\":\"c\"}';DELETE FROM submission_ledger;DELETE FROM paper_campaigns;WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO submission_ledger SELECT 'p','draft','local','review','{}' FROM n;WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO paper_campaigns SELECT 'c','p','{}' FROM n").unwrap();
    let reader = OrdinaryReadOnlyStoreV1::open(&path).unwrap();
    assert!(
        reader
            .fixed_inventory_projection_v1(&FixedInventoryBudgetV1::default())
            .unwrap()
            .papers
            .error
            .unwrap()
            .contains("inventory_joined_rows_v1")
    );
    drop(reader);
    writer.execute_batch("UPDATE papers SET title='ok';WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1025) INSERT INTO paper_campaigns SELECT x,x,'{}' FROM n").unwrap();
    let reader = OrdinaryReadOnlyStoreV1::open(&path).unwrap();
    assert!(
        reader
            .fixed_inventory_projection_v1(&FixedInventoryBudgetV1::default())
            .unwrap()
            .papers
            .error
            .unwrap()
            .contains("inventory_input_rows_v1")
    );
}

#[test]
fn ordinary_absolute_deadline_cancellation_actual_sql_interrupt_and_retry_are_closed() {
    let fixture = Fixture::new();
    let path = fixture.database();
    let writer = fixture_writer(&path, false);
    writer
        .execute_batch("CREATE TABLE actual(x TEXT);INSERT INTO actual VALUES('persisted')")
        .unwrap();
    drop(writer);
    let cancelled = Arc::new(AtomicBool::new(true));
    assert!(matches!(
        OrdinaryReadOnlyStoreV1::open_with_cancellation(
            &path,
            cancelled.clone(),
            Instant::now() + Duration::from_secs(30)
        ),
        Err(ReadOnlyStoreError::OrdinaryCancelled)
    ));
    cancelled.store(false, Ordering::Release);
    assert!(matches!(
        OrdinaryReadOnlyStoreV1::open_with_cancellation(&path, cancelled.clone(), Instant::now()),
        Err(ReadOnlyStoreError::OrdinaryDeadlineExceeded)
    ));
    let reader = OrdinaryReadOnlyStoreV1::open_with_cancellation(
        &path,
        cancelled.clone(),
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    let flag = cancelled.clone();
    let producer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(20));
        flag.store(true, Ordering::Release);
    });
    let result=reader.connection.query_row("WITH RECURSIVE actual(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM actual WHERE n<100000000) SELECT sum(n) FROM actual",[],|row|row.get::<_,i64>(0));
    producer.join().unwrap();
    assert!(result.is_err());
    assert!(matches!(
        reader.node_logical_integrity_report(),
        Err(ReadOnlyStoreError::OrdinaryCancelled)
    ));
    cancelled.store(false, Ordering::Release);
    reader.verify_unchanged().unwrap();
    assert_report(&path, &reader);
    let expired = OrdinaryReadOnlyStoreV1::open_with_cancellation(
        &path,
        cancelled,
        Instant::now() + Duration::from_millis(100),
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(110));
    assert!(matches!(
        expired.node_logical_integrity_report(),
        Err(ReadOnlyStoreError::OrdinaryDeadlineExceeded)
    ));
}
#[test]
fn actual_path_swap_restore_between_two_sqlite_opens_is_refused_by_directory_change() {
    let fixture = Fixture::new();
    let path = fixture.database();
    let writer = fixture_writer(&path, false);
    writer
        .execute_batch("CREATE TABLE actual(x);INSERT INTO actual VALUES('original')")
        .unwrap();
    drop(writer);
    let directory = HeldDirectory::open(fixture.root.clone()).unwrap();
    let held = HeldFile::open(
        path.clone(),
        true,
        ReadControl::new(
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(30),
        ),
    )
    .unwrap();
    let saved = fixture.root.join("saved.sqlite");
    fs::rename(&path, &saved).unwrap();
    let replacement = fixture_writer(&path, false);
    replacement
        .execute_batch("CREATE TABLE actual(x);INSERT INTO actual VALUES('adversarial')")
        .unwrap();
    drop(replacement);
    let adversarial = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(
        adversarial
            .query_row("SELECT x FROM actual", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "adversarial"
    );
    fs::remove_file(&path).unwrap();
    fs::rename(&saved, &path).unwrap();
    assert!(held.verify(true).is_err() || directory.verify().is_err());
    assert!(matches!(
        directory.verify(),
        Err(ReadOnlyStoreError::DatabaseChanged)
    ));
}

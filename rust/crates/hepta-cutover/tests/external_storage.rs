use hepta_cutover::{
    DurableCutoverCoordinatorV1 as Coordinator, DurableCutoverModeV1 as Mode,
    DurableCutoverStorageV2 as Storage,
};
use rusqlite::Connection;
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    database: PathBuf,
    storage: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-cutover-external-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let runtime = root.join("runtime");
        let storage = root.join("coordinator");
        for directory in [&runtime, &storage] {
            fs::create_dir(directory).unwrap();
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let database = runtime.join("native.sqlite");
        Connection::open(&database).unwrap().execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO records VALUES(1,'before')").unwrap();
        Self {
            root,
            database,
            storage,
        }
    }
    fn create(&self) -> Result<Coordinator, hepta_cutover::DurableCutoverError> {
        Coordinator::create_with_storage_v2(
            &self.database,
            "external:test",
            "node",
            "rust",
            Mode::LocalDrill,
            Storage::ExternalRoot {
                root: self.storage.clone(),
            },
        )
    }
    fn marker(&self) -> PathBuf {
        PathBuf::from(format!(
            "{}.rust-cutover.enrolled.json",
            self.database.display()
        ))
    }
    fn binding(&self) -> Value {
        serde_json::from_slice(&fs::read(self.marker()).unwrap()).unwrap()
    }
    fn journal(&self) -> PathBuf {
        self.storage
            .join(self.binding()["storageSlot"].as_str().unwrap())
            .join("journal.sqlite")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn bridge(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(relative)
}
fn node(f: &Fixture, module: &Path, script: &str) -> std::process::Output {
    Command::new("node")
        .args(["--input-type=module", "--eval", script])
        .env("HEPTA_TEST_BRIDGE", module)
        .env("HEPTA_TEST_DATABASE", &f.database)
        .output()
        .unwrap()
}
const PROBE: &str = r#"
import {pathToFileURL} from 'node:url';
const {createRustCutoverFence}=await import(pathToFileURL(process.env.HEPTA_TEST_BRIDGE));
const fence=createRustCutoverFence({dbPath:process.env.HEPTA_TEST_DATABASE});
try { console.log(fence.withWrite(()=> 'CALLBACK')); } finally {fence.close();}
"#;

#[test]
fn fresh_external_roundtrip_preserves_application_bytes_and_default_v1() {
    let f = Fixture::new();
    let before = fs::read(&f.database).unwrap();
    let coordinator = f.create().unwrap();
    let state = coordinator.inspect().unwrap();
    assert_eq!(f.binding()["version"], 2);
    assert_eq!(state.generation, 1);
    assert_eq!(fs::read(&f.database).unwrap(), before);
    assert!(!PathBuf::from(format!("{}.rust-cutover.sqlite", f.database.display())).exists());
    let hash = coordinator.external_storage_enrollment_hash_v2().unwrap();
    assert_eq!(
        Coordinator::open_with_expected_external_storage_v2(&f.database, &f.storage, Some(hash))
            .unwrap()
            .inspect()
            .unwrap(),
        state
    );
    assert!(
        Coordinator::open_with_expected_external_storage_v2(&f.database, &f.root, Some(hash))
            .is_err()
    );
    assert!(
        Coordinator::open_with_expected_external_storage_v2(
            &f.database,
            &f.storage,
            Some("sha256:wrong")
        )
        .is_err()
    );
    let output = node(
        &f,
        &bridge("paper-adapters/migration/rust-cutover-fence.mjs"),
        PROBE,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "CALLBACK");
    let old = node(
        &f,
        &bridge("rust/oracle/fixtures/rust-cutover-fence-v1.mjs"),
        PROBE,
    );
    assert!(!old.status.success());
    assert!(!String::from_utf8_lossy(&old.stdout).contains("CALLBACK"));
    let legacy = Fixture::new();
    let old =
        Coordinator::create(&legacy.database, "v1", "node", "rust", Mode::LocalDrill).unwrap();
    assert_eq!(legacy.binding()["version"], 1);
    assert!(old.external_storage_enrollment_hash_v2().is_none());
    assert!(legacy.create().is_err());
}

#[test]
fn duplicate_mixed_pending_and_unsafe_roots_are_refused_without_migration() {
    let f = Fixture::new();
    let _coordinator = f.create().unwrap();
    let original = fs::read(f.marker()).unwrap();
    assert!(f.create().is_err());
    let other = f.root.join("other");
    fs::create_dir(&other).unwrap();
    fs::set_permissions(&other, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        Coordinator::create_with_storage_v2(
            &f.database,
            "another",
            "node",
            "rust",
            Mode::LocalDrill,
            Storage::ExternalRoot {
                root: other.clone()
            }
        )
        .is_err()
    );
    assert_eq!(fs::read_dir(other).unwrap().count(), 0);
    assert_eq!(fs::read(f.marker()).unwrap(), original);
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let p = PathBuf::from(format!(
            "{}.rust-cutover.sqlite{suffix}",
            f.database.display()
        ));
        fs::write(&p, b"mixed").unwrap();
        assert!(Coordinator::open(&f.database).is_err());
        fs::remove_file(p).unwrap();
    }
    let linked = f.root.join("marker-link");
    fs::hard_link(f.marker(), &linked).unwrap();
    assert!(Coordinator::open(&f.database).is_err());
    fs::remove_file(linked).unwrap();
    let pending = Fixture::new();
    fs::write(
        pending.marker(),
        br#"{"version":2,"kind":"HeptaDurableCutoverEnrollmentPending"}"#,
    )
    .unwrap();
    assert!(pending.create().is_err());
    assert!(Coordinator::open(&pending.database).is_err());
    let output = node(
        &pending,
        &bridge("paper-adapters/migration/rust-cutover-fence.mjs"),
        PROBE,
    );
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let unsafe_root = Fixture::new();
    fs::set_permissions(&unsafe_root.storage, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(unsafe_root.create().is_err());
    assert!(!unsafe_root.marker().exists());
    assert!(
        Coordinator::create_with_storage_v2(
            &unsafe_root.database,
            "test",
            "node",
            "rust",
            Mode::LocalDrill,
            Storage::ExternalRoot {
                root: unsafe_root.database.parent().unwrap().into()
            }
        )
        .is_err()
    );
}

#[test]
fn retained_external_identity_and_schema_reject_substitution() {
    for attack in ["root", "slot", "marker", "journal", "target", "schema"] {
        let f = Fixture::new();
        let coordinator = f.create().unwrap();
        let selected = match attack {
            "root" => f.storage.clone(),
            "slot" => f.journal().parent().unwrap().into(),
            "marker" => f.marker(),
            "journal" => f.journal(),
            "target" => f.database.clone(),
            "schema" => {
                Connection::open(f.journal())
                    .unwrap()
                    .execute_batch("CREATE TABLE injected(id INTEGER)")
                    .unwrap();
                assert!(coordinator.inspect().is_err());
                assert!(Coordinator::open(&f.database).is_err());
                continue;
            }
            _ => unreachable!(),
        };
        let saved = selected.with_extension("saved");
        fs::rename(&selected, &saved).unwrap();
        if saved.is_dir() {
            fs::create_dir(&selected).unwrap();
            fs::set_permissions(&selected, fs::Permissions::from_mode(0o700)).unwrap();
        } else {
            fs::copy(&saved, &selected).unwrap();
            fs::set_permissions(&selected, fs::metadata(&saved).unwrap().permissions()).unwrap();
        }
        assert!(coordinator.inspect().is_err(), "{attack}");
        assert!(Coordinator::open(&f.database).is_err(), "{attack}");
    }
}

#[test]
fn external_node_writer_holds_same_journal_lock_until_actual_commit() {
    let f = Fixture::new();
    drop(f.create().unwrap());
    let script = r#"
import {pathToFileURL} from 'node:url';import {readSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';
const {createRustCutoverFence}=await import(pathToFileURL(process.env.HEPTA_TEST_BRIDGE));
const fence=createRustCutoverFence({dbPath:process.env.HEPTA_TEST_DATABASE});
fence.withWrite(()=>{const observer=createRustCutoverFence({dbPath:process.env.HEPTA_TEST_DATABASE});observer.inspect();observer.close();process.stdout.write('READY\n');readSync(0,Buffer.alloc(1),0,1,null);const db=new DatabaseSync(process.env.HEPTA_TEST_DATABASE);db.exec("INSERT INTO records VALUES(2,'node')");db.close();});fence.close();
"#;
    let mut child = Command::new("node")
        .args(["--input-type=module", "--eval", script])
        .env(
            "HEPTA_TEST_BRIDGE",
            bridge("paper-adapters/migration/rust-cutover-fence.mjs"),
        )
        .env("HEPTA_TEST_DATABASE", &f.database)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "READY");
    let path = f.database.clone();
    let (sender, receiver) = mpsc::channel();
    let task = std::thread::spawn(move || {
        let mut coordinator = Coordinator::open(path).unwrap();
        sender.send(coordinator.quiesce(0)).unwrap();
    });
    assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
    child.stdin.as_mut().unwrap().write_all(b"x").unwrap();
    assert!(
        receiver
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap()
            .writer_id
            .is_none()
    );
    task.join().unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(
        Connection::open(&f.database)
            .unwrap()
            .query_row("SELECT count(*) FROM records", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    let rejected = node(
        &f,
        &bridge("paper-adapters/migration/rust-cutover-fence.mjs"),
        PROBE,
    );
    assert!(!rejected.status.success());
    assert!(rejected.stdout.is_empty());
}

#[test]
fn second_rust_observer_drop_does_not_release_live_writer_sqlite_lock() {
    let f = Fixture::new();
    let mut coordinator = f.create().unwrap();
    let lease = coordinator.inspect().unwrap().writer_fence().unwrap();
    let script = r#"
import {pathToFileURL} from 'node:url';
const {createRustCutoverFence}=await import(pathToFileURL(process.env.HEPTA_TEST_BRIDGE));
const fence=createRustCutoverFence({dbPath:process.env.HEPTA_TEST_DATABASE});
process.stdout.write('STARTED\n');fence.withWrite(()=>process.stdout.write('CALLBACK\n'));fence.close();
"#;
    let mut child = None;
    let mut completed = None;
    let mut reader = None;
    coordinator
        .with_writer(&lease, "test", || {
            let mut peer = Command::new("node")
                .args(["--input-type=module", "--eval", script])
                .env(
                    "HEPTA_TEST_BRIDGE",
                    bridge("paper-adapters/migration/rust-cutover-fence.mjs"),
                )
                .env("HEPTA_TEST_DATABASE", &f.database)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut output = BufReader::new(peer.stdout.take().unwrap());
            let mut started = String::new();
            output.read_line(&mut started).unwrap();
            assert_eq!(started.trim(), "STARTED");
            let observer = Coordinator::open(&f.database).unwrap();
            observer.inspect().unwrap();
            drop(observer);
            let (sender, receiver) = mpsc::channel();
            reader = Some(std::thread::spawn(move || {
                let mut line = String::new();
                output.read_line(&mut line).unwrap();
                sender.send(line).unwrap();
            }));
            assert!(
                receiver.recv_timeout(Duration::from_millis(100)).is_err(),
                "second observer dropped the live process lock"
            );
            completed = Some(receiver);
            child = Some(peer);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        completed
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .trim(),
        "CALLBACK"
    );
    reader.unwrap().join().unwrap();
    let result = child.unwrap().wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn external_enrollment_keeps_the_real_ten_database_inventory_identical() {
    let root = std::env::temp_dir().join(format!(
        "hepta-recoverability-e2e-external-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let f = Fixture {
        database: root.join("runtime/hepta-paper.sqlite"),
        storage: root.join("coordinator"),
        root,
    };
    let mut oracle = Command::new("node")
        .arg(bridge("rust/oracle/state-recoverability-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    oracle
        .stdin
        .take()
        .unwrap()
        .write_all(
            serde_json::json!({"root":f.root,"mode":"fixture"})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let output = oracle.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["profile"]["node"], "v22.23.1");
    assert_eq!(response["profile"]["icu"], "78.2");
    assert_eq!(response["profile"]["cldr"], "48.0");
    let before = &response["value"]["inventory"];
    assert_eq!(before["instances"].as_array().unwrap().len(), 10);
    assert!(before["blockers"].as_array().unwrap().is_empty());
    fs::create_dir(&f.storage).unwrap();
    fs::set_permissions(&f.storage, fs::Permissions::from_mode(0o700)).unwrap();
    let _coordinator = f.create().unwrap();
    let script = r#"
import fs from 'node:fs';import {pathToFileURL} from 'node:url';
const {resolveAutonomousResearchStateDatabaseInventory}=await import(pathToFileURL(process.env.HEPTA_TEST_BRIDGE));
const f=JSON.parse(fs.readFileSync(process.env.HEPTA_TEST_FIXTURE));
process.stdout.write(JSON.stringify(resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:f.runtime,manifest:f.manifest})));
"#;
    let observed = Command::new("node")
        .args(["--input-type=module", "--eval", script])
        .env(
            "HEPTA_TEST_BRIDGE",
            bridge("paper-adapters/automation/autonomous-research-state-database-inventory.mjs"),
        )
        .env("HEPTA_TEST_FIXTURE", f.root.join("fixture.json"))
        .output()
        .unwrap();
    assert!(
        observed.status.success(),
        "{}",
        String::from_utf8_lossy(&observed.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&observed.stdout).unwrap(),
        *before
    );
}

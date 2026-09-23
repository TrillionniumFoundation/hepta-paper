use super::*;
use std::{
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
const CHILD_TEST: &str = "online_authority_evidence_cache::lock::tests::native_lock_child_process";

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-cache-native-lock-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn parent(&self) -> PathBuf {
        self.0.join("automation-cache/online-authority-evidence-v1")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct KillAndWait(Child);
impl KillAndWait {
    fn kill_and_wait(&mut self) {
        self.0.kill().unwrap();
        let status = self.0.wait().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(9));
    }
}
impl Drop for KillAndWait {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

fn digest(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}
fn input() -> Value {
    json!({"databaseScopeHash":digest('a'),"writerManifestHash":digest('b'),"expiresAt":"2026-09-16T00:01:01.000Z","activeRefreshReceipt":{"version":1,"kind":"AutonomousResearchOnlineMutationActiveRefreshReceipt","status":"autonomous_research_online_mutation_active_refresh_complete","externalActionPerformed":true,"journalRecorded":false,"journalReceipt":null,"globalSequence":1,"globalHash":digest('c'),"recordedAt":"2026-09-16T00:00:01.000Z","authorityEvidence":{"currentHead":{"fixture":"passive-only"},"activeChallenge":{"fixture":"passive-only"},"brokerScope":{"fixture":"passive-only"}}}})
}
fn oracle_write(root: &Path) -> Value {
    let executable = std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into());
    let mut child = Command::new(executable)
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../oracle/online-authority-evidence-cache-v1.mjs"),
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
        .write_all(
            &serde_json::to_vec(&json!([{"operation":"write","root":root,"input":input()}]))
                .unwrap(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn native_write(root: &Path) -> Result<Value> {
    let value = input();
    record_passive_authority_evidence_cache_v1(
        root,
        &value["activeRefreshReceipt"],
        &digest('a'),
        &digest('b'),
        value["expiresAt"].as_str().unwrap(),
    )
}
fn child(fixture: &Fixture, mode: &str) -> (KillAndWait, Value) {
    let mut child = KillAndWait(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", CHILD_TEST, "--ignored", "--nocapture"])
            .env("HEPTA_CACHE_NATIVE_LOCK_ROOT", &fixture.0)
            .env("HEPTA_CACHE_NATIVE_LOCK_MODE", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let started = Instant::now();
    loop {
        if let Ok(bytes) = fs::read(fixture.0.join("ready"))
            && let Ok(value) = serde_json::from_slice(&bytes)
        {
            return (child, value);
        }
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "native lock child exited before readiness"
        );
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "native lock child did not become ready"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn ready_and_wait(root: &Path, value: &Value) -> ! {
    fs::write(root.join("ready.tmp"), serde_json::to_vec(value).unwrap()).unwrap();
    fs::rename(root.join("ready.tmp"), root.join("ready")).unwrap();
    loop {
        std::thread::park_timeout(Duration::from_secs(1));
    }
}

// A separate native process is required: dropping a Rust lock in the parent is
// not crash recovery and cannot exercise Node's /proc owner-liveness check.
#[test]
#[ignore = "subprocess helper; the parent tests always terminate and reap it"]
fn native_lock_child_process() {
    let root = PathBuf::from(std::env::var_os("HEPTA_CACHE_NATIVE_LOCK_ROOT").unwrap());
    let mode = std::env::var("HEPTA_CACHE_NATIVE_LOCK_MODE").unwrap();
    let dir = Directory::open(&root, true).unwrap();
    let mut lock = TargetLock::acquire(&dir, &json!({"cacheHash":digest('d')})).unwrap();
    let stage_name = lock.stage_name.clone();
    if mode == "v4" {
        ready_and_wait(&root, &json!({"stage":stage_name,"version":4}));
    }
    if matches!(mode.as_str(), "v5" | "v6") {
        let stage = dir
            .create_with_before_write(
                &stage_name,
                b"synthetic interrupted cache payload",
                0o400,
                |stage| {
                    lock.bind_temporary(stage, false)?;
                    if mode == "v5" {
                        ready_and_wait(&root, &json!({"stage":stage_name,"version":5}));
                    }
                    Ok(())
                },
            )
            .unwrap();
        lock.bind_temporary(&stage, true).unwrap();
        ready_and_wait(&root, &json!({"stage":stage_name,"version":6}));
    }
    assert!(matches!(
        mode.as_str(),
        "before-publication" | "after-publication"
    ));
    // Stop on either side of the actual immutable-owner/hardlink/rename
    // publication protocol, before the old owner can be cleaned up.
    let stage = dir.create(&stage_name, b"", 0o600).unwrap();
    let mut record = lock.record.json().unwrap();
    let new_owner = format!(
        ".current.json.hepta-lock-owner-{}-{}-{}-{}.json",
        std::process::id(),
        process_start(std::process::id()).unwrap(),
        record["token"].as_str().unwrap(),
        random().unwrap()
    );
    let pending = format!(
        ".current.json.hepta-lock-publish-{}-{}",
        record["token"].as_str().unwrap(),
        random().unwrap()
    );
    let m = &stage.metadata;
    record["version"] = json!(5);
    record["ownerEntryName"] = json!(new_owner);
    record["temporaryEntryIdentity"] = json!({"device":m.dev().to_string(),"inode":m.ino().to_string(),"mode":m.mode().to_string(),"size":m.len(),"mtimeNs":(i128::from(m.mtime())*1_000_000_000+i128::from(m.mtime_nsec())).to_string(),"linkCount":m.nlink()});
    dir.create(&new_owner, &serde_json::to_vec(&record).unwrap(), 0o600)
        .unwrap();
    dir.link(&new_owner, &pending).unwrap();
    if mode == "after-publication" {
        dir.replace(&pending, LOCK).unwrap();
    }
    ready_and_wait(
        &root,
        &json!({"stage":stage_name,"owner":new_owner,"oldOwner":lock.owner_name,"pending":pending,"version":5}),
    );
}

#[test]
fn native_live_v4_v5_v6_locks_block_node_and_sigkill_allows_node_recovery() {
    for mode in ["v4", "v5", "v6"] {
        let fixture = Fixture::new();
        let (mut process, ready) = child(&fixture, mode);
        let parent = fixture.parent();
        let foreign = parent.join("foreign-preserve.txt");
        fs::write(&foreign, b"unrelated data").unwrap();
        let record: Value = serde_json::from_slice(&fs::read(parent.join(LOCK)).unwrap()).unwrap();
        assert_eq!(record["version"], ready["version"]);
        if mode != "v4" {
            let stage = fs::metadata(parent.join(ready["stage"].as_str().unwrap())).unwrap();
            assert_eq!(
                stage.mode() & 0o777,
                if mode == "v5" { 0o600 } else { 0o400 }
            );
            assert_eq!(stage.len() == 0, mode == "v5");
        }
        let blocked = oracle_write(&fixture.0);
        assert!(
            blocked["results"][0]["error"]
                .as_str()
                .unwrap()
                .contains("locked"),
            "{blocked}"
        );
        assert!(!parent.join("current.json").exists());
        process.kill_and_wait();
        let recovered = oracle_write(&fixture.0);
        assert!(recovered["results"][0].get("ok").is_some(), "{recovered}");
        assert_eq!(fs::read(&foreign).unwrap(), b"unrelated data");
        let directory = Directory::open(&fixture.0, false).unwrap();
        assert_eq!(
            directory.entries(4096).unwrap(),
            vec!["current.json", "foreign-preserve.txt"]
        );
    }
}

#[test]
fn native_reclaims_orphans_on_both_sides_of_owner_publication_and_preserves_foreign_stage() {
    for mode in ["before-publication", "after-publication"] {
        for replace_stage in [false, true] {
            let fixture = Fixture::new();
            let (mut process, ready) = child(&fixture, mode);
            let parent = fixture.parent();
            let stage_name = ready["stage"].as_str().unwrap();
            let stage = parent.join(stage_name);
            let old = parent.join(ready["oldOwner"].as_str().unwrap());
            let owner = parent.join(ready["owner"].as_str().unwrap());
            let pending = parent.join(ready["pending"].as_str().unwrap());
            assert_eq!(
                fs::metadata(&old).unwrap().nlink(),
                if mode == "before-publication" { 2 } else { 1 }
            );
            assert_eq!(fs::metadata(&owner).unwrap().nlink(), 2);
            assert_eq!(pending.exists(), mode == "before-publication");
            if replace_stage {
                fs::rename(&stage, fixture.0.join("detached-owned-stage")).unwrap();
                fs::write(&stage, b"foreign inode at formerly bound stage name").unwrap();
                fs::set_permissions(&stage, fs::Permissions::from_mode(0o600)).unwrap();
            }
            fs::write(parent.join("foreign-preserve.txt"), b"unrelated data").unwrap();
            process.kill_and_wait();
            native_write(&fixture.0).unwrap();
            assert!(!old.exists());
            assert!(!owner.exists());
            assert!(!pending.exists());
            assert!(!parent.join(LOCK).exists());
            assert_eq!(
                fs::read(parent.join("foreign-preserve.txt")).unwrap(),
                b"unrelated data"
            );
            let directory = Directory::open(&fixture.0, false).unwrap();
            let mut expected = vec!["current.json".to_owned(), "foreign-preserve.txt".to_owned()];
            if replace_stage {
                assert_eq!(
                    fs::read(stage).unwrap(),
                    b"foreign inode at formerly bound stage name"
                );
                expected.push(stage_name.to_owned());
                expected.sort();
            } else {
                assert!(!stage.exists());
            }
            assert_eq!(directory.entries(4096).unwrap(), expected);
        }
    }
}

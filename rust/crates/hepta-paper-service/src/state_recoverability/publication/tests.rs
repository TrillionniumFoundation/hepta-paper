use super::*;
use std::{
    io::{BufRead, BufReader},
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
    sync::{Arc, Barrier},
};
struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("hepta-backup-publication-{}", nonce().unwrap()));
        fs::create_dir(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        Self(p)
    }
    fn directory(&self) -> Directory {
        Directory::open_or_create(&self.0, false).unwrap()
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn competing_publishers_cannot_both_replace_same_expected_generation() {
    let root = Root::new();
    let dir = root.directory();
    let old = json!({"generation":1});
    publish_receipt(&dir, "receipt.json", &old, None).unwrap();
    let expected = hash_bytes(&fs::read(root.0.join("receipt.json")).unwrap());
    let barrier = Arc::new(Barrier::new(2));
    let results = std::thread::scope(|scope| {
        let mut tasks = Vec::new();
        for generation in [2, 3] {
            let barrier = barrier.clone();
            let expected = &expected;
            let path = &root.0;
            tasks.push(scope.spawn(move || {
                let directory = Directory::open_or_create(path, false).unwrap();
                barrier.wait();
                publish_receipt(
                    &directory,
                    "receipt.json",
                    &json!({"generation":generation}),
                    Some(expected),
                )
            }));
        }
        tasks
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(
        results
            .iter()
            .filter_map(|r| r.as_ref().err())
            .all(|e| e.code.ends_with("busy") || e.code.ends_with("conflict"))
    );
    let current: Value =
        serde_json::from_slice(&fs::read(root.0.join("receipt.json")).unwrap()).unwrap();
    assert!([json!(2), json!(3)].contains(&current["generation"]));
    assert!(
        fs::read_dir(&root.0)
            .unwrap()
            .filter_map(|r| r.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with(".pending-")
                && fs::read(e.path()).unwrap() == serde_json::to_vec(&old).unwrap())
    );
}
#[test]
fn process_death_releases_persistent_lock_and_staged_bytes_are_not_a_receipt() {
    let root = Root::new();
    let dir = root.directory();
    let lock = root.0.join(".publication-lock-receipt.json");
    let mut child=Command::new("python3").args(["-c","import os,fcntl,sys,time; f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); time.sleep(30)"]).arg(&lock).stdout(Stdio::piped()).spawn().unwrap();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert_eq!(ready.trim(), "locked");
    assert!(
        publish_receipt(&dir, "receipt.json", &json!({"ready":false}), None)
            .unwrap_err()
            .code
            .ends_with("busy")
    );
    child.kill().unwrap();
    child.wait().unwrap();
    dir.write_new(".pending-interrupted", b"{\"unverified\":true}")
        .unwrap();
    assert!(!root.0.join("receipt.json").exists());
    publish_receipt(&dir, "receipt.json", &json!({"generation":1}), None).unwrap();
    assert_eq!(
        fs::read(root.0.join(".pending-interrupted")).unwrap(),
        b"{\"unverified\":true}"
    );
    assert!(lock.exists());
}
#[test]
fn unsafe_lock_alias_and_stale_expected_hash_preserve_existing_receipt() {
    let root = Root::new();
    let dir = root.directory();
    dir.write_new("receipt.json", b"original").unwrap();
    let lock = root.0.join(".publication-lock-receipt.json");
    std::os::unix::fs::symlink(root.0.join("receipt.json"), &lock).unwrap();
    assert!(publish_receipt(&dir, "receipt.json", &json!({}), None).is_err());
    fs::remove_file(&lock).unwrap();
    assert!(
        publish_receipt(
            &dir,
            "receipt.json",
            &json!({}),
            Some(&hash_bytes(b"wrong"))
        )
        .unwrap_err()
        .code
        .ends_with("conflict")
    );
    assert_eq!(fs::read(root.0.join("receipt.json")).unwrap(), b"original");
}

use super::*;
use std::{
    os::unix::fs::PermissionsExt,
    sync::{
        Arc, Barrier,
        atomic::{AtomicBool, Ordering},
    },
};

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("hepta-directory-identity-{}", nonce().unwrap()));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
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
fn directory_identity_survives_link_count_changes_but_files_keep_link_checks() {
    let root = Root::new();
    let directory = root.directory();
    let before = fs::symlink_metadata(&root.0).unwrap();
    fs::create_dir(root.0.join("legitimate-child")).unwrap();
    let after = directory.held.metadata().unwrap();
    assert!(same_directory(&before, &after));
    directory.assert_current().unwrap();
    let file = root.0.join("file");
    fs::write(&file, b"private fixture").unwrap();
    let before = fs::symlink_metadata(&file).unwrap();
    fs::hard_link(&file, root.0.join("extra-link")).unwrap();
    let after = fs::symlink_metadata(&file).unwrap();
    assert!(
        !same(&before, &after),
        "ordinary file hardlink guard must remain"
    );
    assert!(
        !same_directory(&before, &after),
        "regular files are not directories"
    );
}

#[test]
fn unrelated_child_churn_does_not_fail_pinned_directory_currentness() {
    let root = Root::new();
    let directory = root.directory();
    let running = Arc::new(AtomicBool::new(true));
    let active = running.clone();
    let child = root.0.join("ordinary-child");
    let barrier = Arc::new(Barrier::new(2));
    let start = barrier.clone();
    let thread = std::thread::spawn(move || {
        start.wait();
        while active.load(Ordering::Relaxed) {
            fs::create_dir(&child).unwrap();
            fs::remove_dir(&child).unwrap();
        }
    });
    barrier.wait();
    let rejected = (0..20000)
        .filter(|_| directory.assert_current().is_err())
        .count();
    running.store(false, Ordering::Relaxed);
    thread.join().unwrap();
    assert_eq!(
        rejected, 0,
        "a changing child count does not replace the parent inode"
    );
}

#[test]
fn an_actual_directory_replacement_still_fails_and_preserves_foreign_data() {
    let root = Root::new();
    let path = root.0.join("selected");
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    let directory = Directory::open_or_create(&path, false).unwrap();
    fs::rename(&path, root.0.join("held-original")).unwrap();
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(path.join("foreign"), b"must remain").unwrap();
    assert!(directory.assert_current().is_err());
    assert_eq!(fs::read(path.join("foreign")).unwrap(), b"must remain");
}

#[test]
fn directory_publish_remains_valid_while_held_stage_children_change() {
    use nix::unistd::{UnlinkatFlags, unlinkat};
    let root = Root::new();
    let directory = root.directory();
    let stage = directory.child("pending").unwrap();
    let held = stage.held.try_clone().unwrap();
    let running = Arc::new(AtomicBool::new(true));
    let active = running.clone();
    let barrier = Arc::new(Barrier::new(2));
    let start = barrier.clone();
    let thread = std::thread::spawn(move || {
        start.wait();
        while active.load(Ordering::Relaxed) {
            mkdirat(held.as_fd(), "child", Mode::from_bits_truncate(0o700)).unwrap();
            unlinkat(held.as_fd(), "child", UnlinkatFlags::RemoveDir).unwrap();
        }
    });
    barrier.wait();
    let result = directory.publish_new(&stage, "final");
    running.store(false, Ordering::Relaxed);
    thread.join().unwrap();
    assert_eq!(result.unwrap(), root.0.join("final"));
    assert!(!root.0.join("pending").exists());
    Directory::open_or_create(&root.0.join("final"), false)
        .unwrap()
        .assert_current()
        .unwrap();
}

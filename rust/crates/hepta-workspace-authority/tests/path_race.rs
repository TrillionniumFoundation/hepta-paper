use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use hepta_workspace_authority::{WorkspaceError, WorkspaceRootV1};

static NEXT: AtomicU64 = AtomicU64::new(0);

#[test]
fn root_path_replacement_is_detected_against_the_open_descriptor() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let parent = std::env::temp_dir().join(format!(
        "hepta-workspace-root-race-{}-{nonce}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let root = parent.join("source");
    fs::create_dir_all(&root).expect("root");
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).expect("parent mode");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("root mode");
    fs::write(root.join("paper.tex"), b"original").expect("file");
    let opened = WorkspaceRootV1::open(&root, None).expect("opened root");
    let displaced = parent.join("displaced");
    fs::rename(&root, &displaced).expect("displace root");
    fs::create_dir(&root).expect("replacement root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("replacement mode");
    assert!(matches!(
        opened.inventory(),
        Err(WorkspaceError::RootChanged)
    ));
    fs::remove_dir_all(parent).expect("cleanup");
}

#[test]
fn nested_directory_symlink_replacement_is_rejected() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let parent = std::env::temp_dir().join(format!(
        "hepta-workspace-nested-race-{}-{nonce}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let root = parent.join("source");
    let external = parent.join("external");
    fs::create_dir_all(root.join("paper")).expect("paper");
    fs::create_dir(&external).expect("external");
    for selected in [&parent, &root, &root.join("paper"), &external] {
        fs::set_permissions(selected, fs::Permissions::from_mode(0o700)).expect("mode");
    }
    fs::write(root.join("paper/main.tex"), b"trusted").expect("trusted file");
    fs::write(external.join("main.tex"), b"untrusted").expect("external file");
    let opened = WorkspaceRootV1::open(&root, None).expect("opened root");
    fs::rename(root.join("paper"), root.join("paper-original")).expect("rename paper");
    symlink(&external, root.join("paper")).expect("replacement symlink");
    assert!(matches!(
        opened.inventory(),
        Err(WorkspaceError::SymlinkForbidden)
    ));
    fs::remove_dir_all(parent).expect("cleanup");
}

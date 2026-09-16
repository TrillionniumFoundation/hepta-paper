use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-native-cache-files-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self { root }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn rebound_named_directory_cannot_make_cleanup_unlink_foreign_held_entry() {
    let fixture = Fixture::new();
    let directory = Directory::open(&fixture.root, true).unwrap();
    let owned = directory
        .create("owned.tmp", b"original-owned", 0o600)
        .unwrap();
    let original_directory = fixture.root.join("original-cache-directory");
    fs::rename(&directory.path, &original_directory).unwrap();
    fs::create_dir(&directory.path).unwrap();
    // Named path now exposes our owned inode, while the actual held directory
    // has a different file at the cleanup name. A raw-path stat followed by
    // dirfd unlink would delete the foreign file.
    fs::rename(
        original_directory.join("owned.tmp"),
        directory.path.join("owned.tmp"),
    )
    .unwrap();
    fs::write(
        original_directory.join("owned.tmp"),
        b"foreign-must-survive",
    )
    .unwrap();
    let foreign = fs::metadata(original_directory.join("owned.tmp")).unwrap();
    assert_eq!(
        directory.stat("owned.tmp").unwrap().unwrap().ino(),
        foreign.ino()
    );
    assert!(owned.assert_current(&directory, "owned.tmp").is_err());
    assert!(directory.assert_current().is_err());
    directory.remove_owned("owned.tmp", &owned);
    assert_eq!(
        fs::read(original_directory.join("owned.tmp")).unwrap(),
        b"foreign-must-survive"
    );
    assert_eq!(
        fs::read(directory.path.join("owned.tmp")).unwrap(),
        b"original-owned"
    );
}

#[test]
fn cleanup_after_parent_rebinding_removes_only_own_held_inode() {
    let fixture = Fixture::new();
    let directory = Directory::open(&fixture.root, true).unwrap();
    let owned = directory
        .create("owned.tmp", b"original-owned", 0o600)
        .unwrap();
    let original_directory = fixture.root.join("original-cache-directory");
    fs::rename(&directory.path, &original_directory).unwrap();
    fs::create_dir(&directory.path).unwrap();
    fs::write(directory.path.join("owned.tmp"), b"foreign-named-file").unwrap();
    directory.remove_owned("owned.tmp", &owned);
    assert!(!original_directory.join("owned.tmp").exists());
    assert_eq!(owned.file.metadata().unwrap().nlink(), 0);
    assert_eq!(
        fs::read(directory.path.join("owned.tmp")).unwrap(),
        b"foreign-named-file"
    );
}

#[test]
fn metadata_never_follows_links_or_opens_fifo_and_prewrite_failure_cleans_own_stage() {
    let fixture = Fixture::new();
    let directory = Directory::open(&fixture.root, true).unwrap();
    let owned = directory.create("original.tmp", b"owned", 0o600).unwrap();
    symlink("original.tmp", directory.path.join("linked.tmp")).unwrap();
    assert!(directory.stat("linked.tmp").unwrap().unwrap().is_symlink());
    directory.remove_owned("linked.tmp", &owned);
    assert!(
        fs::symlink_metadata(directory.path.join("linked.tmp"))
            .unwrap()
            .is_symlink()
    );
    assert_eq!(
        fs::read(directory.path.join("original.tmp")).unwrap(),
        b"owned"
    );
    nix::unistd::mkfifo(
        &directory.path.join("pipe.tmp"),
        Mode::from_bits_truncate(0o600),
    )
    .unwrap();
    use std::os::unix::fs::FileTypeExt;
    assert!(
        directory
            .stat("pipe.tmp")
            .unwrap()
            .unwrap()
            .file_type()
            .is_fifo()
    );
    let result =
        directory.create_with_before_write("failed.tmp", b"never-written", 0o400, |stage| {
            assert_eq!(stage.metadata.len(), 0);
            assert_eq!(stage.metadata.mode() & 0o777, 0o600);
            assert_eq!(
                directory.stat("failed.tmp")?.unwrap().ino(),
                stage.metadata.ino()
            );
            let empty = directory.read_stage_for_cleanup("failed.tmp")?.unwrap();
            assert!(empty.bytes.is_empty());
            assert_eq!(empty.metadata.ino(), stage.metadata.ino());
            assert_eq!(
                directory
                    .read_stage_for_cleanup("failed.tmp")?
                    .unwrap()
                    .metadata
                    .ino(),
                stage.metadata.ino()
            );
            assert!(
                directory
                    .read("failed.tmp", MAXIMUM_BYTES, 0o600, 1)
                    .is_err()
            );
            Err(failure("test_prewrite_error"))
        });
    assert_eq!(
        result.err().unwrap().code,
        "autonomous_research_online_authority_evidence_cache_test_prewrite_error"
    );
    assert!(!directory.path.join("failed.tmp").exists());
    let completed = directory
        .create_with_before_write("completed.tmp", b"durable-final-body", 0o400, |stage| {
            assert_eq!(stage.metadata.len(), 0);
            Ok(())
        })
        .unwrap();
    assert_eq!(completed.metadata.mode() & 0o777, 0o400);
    assert_eq!(completed.bytes, b"durable-final-body");
    let mut cleanup = directory
        .read_stage_for_cleanup("completed.tmp")
        .unwrap()
        .unwrap();
    assert!(cleanup.bytes.is_empty());
    assert_eq!(cleanup.metadata.len(), completed.metadata.len());
    // An O_PATH descriptor cannot read the body at all; cleanup retains only
    // the verified inode and metadata, even for a completed nonempty stage.
    assert_eq!(
        cleanup
            .file
            .read(&mut [0_u8; 1])
            .unwrap_err()
            .raw_os_error(),
        Some(nix::errno::Errno::EBADF as i32)
    );
    assert_eq!(
        directory
            .read("completed.tmp", 100, 0o400, 1)
            .unwrap()
            .unwrap()
            .bytes,
        b"durable-final-body"
    );
    let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = directory.create_with_before_write("unwind.tmp", b"unused", 0o400, |_| {
            panic!("isolated prewrite unwind")
        });
    }));
    assert!(unwind.is_err());
    assert!(!directory.path.join("unwind.tmp").exists());
}

#[test]
fn held_directory_enumeration_has_independent_offsets_utf8_and_entry_bounds() {
    let fixture = Fixture::new();
    let directory = Directory::open(&fixture.root, true).unwrap();
    for name in ["second", "first", "文章"] {
        directory.create(name, b"test", 0o600).unwrap();
    }
    let first = directory.entries(3).unwrap();
    assert_eq!(first, directory.entries(3).unwrap());
    assert_eq!(first.len(), 3);
    assert_eq!(
        directory.entries(2).unwrap_err().code,
        "autonomous_research_online_authority_evidence_cache_entry_limit_exceeded"
    );
    assert_eq!(
        directory.entries(4097).unwrap_err().code,
        "autonomous_research_online_authority_evidence_cache_entry_limit_exceeded"
    );
    use std::os::unix::ffi::OsStringExt;
    fs::write(
        directory
            .path
            .join(std::ffi::OsString::from_vec(vec![0xff])),
        b"invalid-name",
    )
    .unwrap();
    assert_eq!(
        directory.entries(4096).unwrap_err().code,
        "autonomous_research_online_authority_evidence_cache_filename_utf8_invalid"
    );
}

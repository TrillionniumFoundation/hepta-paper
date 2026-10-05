use super::*;
use std::os::unix::fs::PermissionsExt;

struct AncestryFixture {
    root: PathBuf,
}
impl AncestryFixture {
    fn new() -> Self {
        Self::new_in(Path::new("/dev/shm"))
    }
    fn new_in(base: &Path) -> Self {
        let root = base.join(format!(
            "hepta-ordinary-ancestry-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("ancestor/database-parent")).unwrap();
        let fixture = Self { root };
        let writer = fixture_writer(&fixture.database(), false);
        writer
            .execute_batch("CREATE TABLE actual(x);INSERT INTO actual VALUES('original')")
            .unwrap();
        fixture
    }
    fn ancestor(&self) -> PathBuf {
        self.root.join("ancestor")
    }
    fn database(&self) -> PathBuf {
        self.ancestor().join("database-parent/store.sqlite")
    }
    fn reader(&self) -> OrdinaryReadOnlyStoreV1 {
        OrdinaryReadOnlyStoreV1::open(self.database()).unwrap()
    }
}
impl Drop for AncestryFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn default_temporary_directory_sibling_activity_uses_its_filesystem_policy() {
    use nix::sys::statfs::{
        BTRFS_SUPER_MAGIC, EXT4_SUPER_MAGIC, TMPFS_MAGIC, XFS_SUPER_MAGIC, fstatfs,
    };
    let fixture = AncestryFixture::new_in(&std::env::temp_dir());
    let reader = fixture.reader();
    let ancestor = File::open(fixture.ancestor()).unwrap();
    let kind = fstatfs(&ancestor).unwrap().filesystem_type();
    let before = FullIdentity::of(&ancestor.metadata().unwrap());
    fs::create_dir(fixture.ancestor().join("unrelated")).unwrap();
    assert_ne!(before, FullIdentity::of(&ancestor.metadata().unwrap()));
    if matches!(
        kind,
        TMPFS_MAGIC | EXT4_SUPER_MAGIC | XFS_SUPER_MAGIC | BTRFS_SUPER_MAGIC
    ) {
        reader.verify_unchanged().unwrap();
    } else {
        assert!(matches!(
            reader.verify_unchanged(),
            Err(ReadOnlyStoreError::DatabaseChanged)
        ));
    }
}

#[test]
fn unrelated_ancestor_sibling_create_remove_and_rename_preserve_actual_reader() {
    let fixture = AncestryFixture::new();
    let reader = fixture.reader();
    let original = reader.node_logical_integrity_report().unwrap();
    let before = FullIdentity::of(&fs::metadata(fixture.ancestor()).unwrap());
    let sibling = fixture.ancestor().join("unrelated");
    fs::create_dir(&sibling).unwrap();
    let after = FullIdentity::of(&fs::metadata(fixture.ancestor()).unwrap());
    assert_ne!(
        before, after,
        "reproduction must actually change ancestor metadata"
    );
    reader.verify_unchanged().unwrap();
    fs::write(sibling.join("unrelated.txt"), b"sibling content").unwrap();
    fs::rename(&sibling, fixture.ancestor().join("renamed")).unwrap();
    reader.verify_unchanged().unwrap();
    fs::remove_dir_all(fixture.ancestor().join("renamed")).unwrap();
    reader.verify_unchanged().unwrap();
    assert_eq!(
        original.logical_database_hash,
        reader
            .node_logical_integrity_report()
            .unwrap()
            .logical_database_hash
    );
}

#[test]
fn selected_ancestor_rename_restore_permanently_invalidates_actual_reader() {
    let fixture = AncestryFixture::new();
    let reader = fixture.reader();
    let aside = fixture.root.join("moved-ancestor");
    fs::rename(fixture.ancestor(), &aside).unwrap();
    fs::rename(&aside, fixture.ancestor()).unwrap();
    for _ in 0..2 {
        assert!(matches!(
            reader.verify_unchanged(),
            Err(ReadOnlyStoreError::DatabaseChanged)
        ));
    }
}

#[test]
fn selected_ancestor_replacement_and_symlink_refuse_actual_reader() {
    for symlink in [false, true] {
        let fixture = AncestryFixture::new();
        let reader = fixture.reader();
        let aside = fixture.root.join("moved-ancestor");
        fs::rename(fixture.ancestor(), &aside).unwrap();
        if symlink {
            std::os::unix::fs::symlink(&aside, fixture.ancestor()).unwrap();
        } else {
            fs::create_dir_all(fixture.ancestor().join("database-parent")).unwrap();
            fs::copy(
                aside.join("database-parent/store.sqlite"),
                fixture.database(),
            )
            .unwrap();
        }
        assert!(matches!(
            reader.verify_unchanged(),
            Err(ReadOnlyStoreError::DatabaseChanged)
        ));
    }
}

#[test]
fn selected_ancestor_permissions_and_restored_permissions_refuse_actual_reader() {
    for restore in [false, true] {
        let fixture = AncestryFixture::new();
        let reader = fixture.reader();
        let original = fs::metadata(fixture.ancestor()).unwrap().permissions();
        fs::set_permissions(
            fixture.ancestor(),
            fs::Permissions::from_mode(original.mode() ^ 0o020),
        )
        .unwrap();
        if restore {
            fs::set_permissions(fixture.ancestor(), original).unwrap();
        }
        for _ in 0..2 {
            assert!(matches!(
                reader.verify_unchanged(),
                Err(ReadOnlyStoreError::DatabaseChanged)
            ));
        }
    }
}

#[test]
fn main_mutation_and_new_wal_still_refuse_after_unrelated_ancestor_activity() {
    for wal in [false, true] {
        let fixture = AncestryFixture::new();
        let reader = fixture.reader();
        fs::create_dir(fixture.ancestor().join("unrelated")).unwrap();
        reader.verify_unchanged().unwrap();
        if wal {
            fs::write(sidecar(&fixture.database(), "-wal"), b"unexpected WAL").unwrap();
        } else {
            let external = fs::OpenOptions::new()
                .write(true)
                .open(fixture.database())
                .unwrap();
            external.write_at(&[0, 0, 0, 2], 60).unwrap();
        }
        assert!(matches!(
            reader.verify_unchanged(),
            Err(ReadOnlyStoreError::DatabaseChanged)
        ));
    }
}

#[test]
fn immediate_database_parent_keeps_full_metadata_guard() {
    let fixture = AncestryFixture::new();
    let reader = fixture.reader();
    let sibling = fixture
        .database()
        .parent()
        .unwrap()
        .join("unexpected-entry");
    fs::write(&sibling, b"created and then removed").unwrap();
    fs::remove_file(sibling).unwrap();
    assert!(matches!(
        reader.verify_unchanged(),
        Err(ReadOnlyStoreError::DatabaseChanged)
    ));
}

#[test]
fn concurrent_readers_tolerate_sibling_lifecycles_without_serialization() {
    let fixture = AncestryFixture::new();
    let paths: Vec<_> = (0..4)
        .map(|index| {
            let parent = fixture.ancestor().join(format!("parallel-{index}"));
            fs::create_dir(&parent).unwrap();
            let path = parent.join("store.sqlite");
            fs::copy(fixture.database(), &path).unwrap();
            path
        })
        .collect();
    let barrier = std::sync::Barrier::new(paths.len());
    std::thread::scope(|scope| {
        for (index, path) in paths.iter().enumerate() {
            let barrier = &barrier;
            let ancestor = fixture.ancestor();
            scope.spawn(move || {
                let reader = OrdinaryReadOnlyStoreV1::open(path);
                barrier.wait();
                let reader = reader.unwrap();
                for pass in 0..40 {
                    let sibling = ancestor.join(format!("churn-{index}-{pass}"));
                    fs::create_dir(&sibling).unwrap();
                    reader.verify_unchanged().unwrap();
                    fs::remove_dir(sibling).unwrap();
                    reader.verify_unchanged().unwrap();
                }
                assert_eq!(
                    reader
                        .node_logical_integrity_report()
                        .unwrap()
                        .total_row_count,
                    1
                );
            });
        }
    });
}

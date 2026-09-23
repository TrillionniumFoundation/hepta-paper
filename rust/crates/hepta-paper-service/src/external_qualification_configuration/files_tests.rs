use super::*;
use nix::unistd::mkfifo;
use std::{
    os::unix::fs::{FileTypeExt, PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-external-config-files-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("owned directory");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .expect("private directory mode");
        Self { root }
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.root.join(name);
        fs::write(&path, bytes).expect("owned public test bytes");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("explicit leaf mode");
        path
    }
    fn directory(&self, name: &str) -> PathBuf {
        let path = self.root.join(name);
        fs::create_dir(&path).expect("owned child directory");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("explicit directory mode");
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn actual_regular_config_bound_fifo_and_mode_are_checked_without_mutation() {
    let fixture = Fixture::new();
    let path = fixture.file("config", &vec![b'x'; 256 * 1024]);
    let mut owner = Observations::default();
    let observation = owner
        .file(&path, FileKind::Configuration)
        .expect("exact boundary");
    assert_eq!(observation.bytes.len(), 256 * 1024);
    owner.assert_current().expect("same actual object");
    drop(owner);
    fs::write(&path, vec![b'x'; 256 * 1024 + 1]).expect("one-byte excess");
    assert_eq!(
        Observations::default()
            .file(&path, FileKind::Configuration)
            .err()
            .expect("bound rejection")
            .code(),
        INVALID
    );
    fs::write(&path, b"{}").expect("small config");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o620)).expect("unsafe leaf mode");
    assert_eq!(
        Observations::default()
            .file(&path, FileKind::Configuration)
            .err()
            .expect("mode rejection")
            .code(),
        INVALID
    );
    let fifo = fixture.root.join("fifo");
    mkfifo(&fifo, Mode::from_bits_truncate(0o600)).expect("owned FIFO");
    assert_eq!(
        Observations::default()
            .file(&fifo, FileKind::Configuration)
            .err()
            .expect("nonblocking FIFO rejection")
            .code(),
        INVALID
    );
    assert!(
        fs::symlink_metadata(&fifo)
            .expect("FIFO retained")
            .file_type()
            .is_fifo()
    );
    assert_eq!(fs::read(&path).expect("original bytes"), b"{}");
}

#[test]
fn leaf_and_ancestor_symlinks_and_retained_parent_replacement_fail_closed() {
    let fixture = Fixture::new();
    let target = fixture.file("target", b"{}");
    let link = fixture.root.join("link");
    symlink(&target, &link).expect("owned leaf alias");
    assert_eq!(
        Observations::default()
            .file(&link, FileKind::Configuration)
            .err()
            .expect("leaf alias rejected")
            .code(),
        INVALID
    );
    fixture.directory("parent");
    let path = fixture.file("parent/config", b"{}");
    let alias = fixture.root.join("parent-alias");
    symlink(fixture.root.join("parent"), &alias).expect("owned ancestor alias");
    assert_eq!(
        Observations::default()
            .file(&alias.join("config"), FileKind::Configuration)
            .err()
            .expect("ancestor alias rejected")
            .code(),
        INVALID
    );
    let mut owner = Observations::default();
    owner
        .file(&path, FileKind::Configuration)
        .expect("actual retained config");
    fs::rename(fixture.root.join("parent"), fixture.root.join("old-parent"))
        .expect("replace observed parent name");
    fixture.directory("parent");
    fixture.file("parent/config", b"{}");
    assert_eq!(
        owner
            .assert_current()
            .expect_err("same bytes in different parent rejected")
            .code(),
        CHANGED
    );
    assert_eq!(
        fs::read(fixture.root.join("old-parent/config")).expect("original preserved"),
        b"{}"
    );
}

#[test]
fn retained_same_inode_same_length_changes_and_leaf_replacement_are_detected() {
    for replace in [false, true] {
        let fixture = Fixture::new();
        let path = fixture.file("config", b"original");
        let mut owner = Observations::default();
        owner
            .file(&path, FileKind::Configuration)
            .expect("actual baseline");
        let before = fs::metadata(&path).expect("metadata");
        if replace {
            let temporary = fixture.file("replacement", b"original");
            fs::rename(temporary, &path).expect("leaf replacement");
        } else {
            fs::write(&path, b"modified").expect("same-length in-place write");
            assert_eq!(fs::metadata(&path).expect("same inode").ino(), before.ino());
        }
        assert_eq!(fs::metadata(&path).expect("length").len(), before.len());
        assert_eq!(
            owner
                .assert_current()
                .expect_err("content/identity drift rejected")
                .code(),
            CHANGED
        );
    }
}

#[test]
fn actual_credential_directory_add_remove_rename_and_content_changes_are_detected() {
    for mutation in ["add", "remove", "rename", "content"] {
        let fixture = Fixture::new();
        let credential = fixture.directory("credentials");
        fixture.file("credentials/marker", b"nonsecret baseline");
        let mut owner = Observations::default();
        let identity = owner
            .credential(&credential)
            .expect("actual nonsecret credential tree");
        assert_eq!(
            identity["regularFileContentHashes"]
                .as_array()
                .expect("content hashes")
                .len(),
            1
        );
        owner.assert_current().expect("unchanged tree");
        match mutation {
            "add" => {
                fixture.file("credentials/new-marker", b"new nonsecret data");
            }
            "remove" => fs::remove_file(credential.join("marker")).expect("remove owned marker"),
            "rename" => fs::rename(credential.join("marker"), credential.join("renamed"))
                .expect("rename owned marker"),
            "content" => {
                fixture.file("credentials/marker", b"different baseline");
            }
            _ => unreachable!("source-owned finite fixture choices"),
        }
        assert!(owner.assert_current().is_err(), "{mutation}");
    }
}

#[test]
fn production_credential_limits_and_aggregate_reservation_refuse_before_large_read() {
    let mut count_budget = CredentialBudget::default();
    for _ in 0..MAXIMUM_CREDENTIAL_FILES {
        count_budget.add_file(1).expect("within production count");
    }
    assert_eq!(
        count_budget.add_file(1).expect_err("count excess").code(),
        CREDENTIAL_LARGE
    );
    let mut byte_budget = CredentialBudget::default();
    byte_budget
        .add_file(MAXIMUM_CREDENTIAL_BYTES)
        .expect("exact production byte budget");
    assert_eq!(
        byte_budget.add_file(1).expect_err("byte excess").code(),
        CREDENTIAL_LARGE
    );

    let fixture = Fixture::new();
    let credential = fixture.directory("credentials");
    let oversized = fixture.file("credentials/sparse-marker", b"x");
    // Only sparse length is extended: no 256 MiB allocation or content read.
    File::options()
        .write(true)
        .open(&oversized)
        .expect("owned sparse file")
        .set_len(MAXIMUM_CREDENTIAL_BYTES + 1)
        .expect("oversized metadata");
    assert_eq!(
        Observations::default()
            .credential(&credential)
            .expect_err("stat budget rejects sparse oversize")
            .code(),
        CREDENTIAL_LARGE
    );
    let tiny = fixture.file("tiny", b"x");
    let mut owner = Observations {
        bytes: MAXIMUM_OBSERVED_BYTES,
        ..Observations::default()
    };
    assert_eq!(
        owner
            .file(&tiny, FileKind::Argument)
            .err()
            .expect("aggregate reservation rejection")
            .code(),
        "external_qualification_observation_budget_exceeded"
    );
    let file = File::open(&tiny).expect("actual bounded stream");
    assert_eq!(
        read_hash(&file, 0, 0)
            .expect_err("one-byte growth witness")
            .code(),
        INVALID
    );
}

#[test]
fn credential_namespace_inventory_reserves_siblings_before_descendants() {
    let fixture = Fixture::new();
    fixture.file("first", b"a");
    fixture.file("second", b"b");
    let file = File::from(
        open(
            &fixture.root,
            OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .expect("retained real directory"),
    );
    assert_eq!(
        directory_names(&file, 2).expect("exact small listing budget"),
        vec!["first", "second"]
    );
    assert_eq!(
        directory_names(&file, 1)
            .expect_err("bounded enumeration")
            .code(),
        CREDENTIAL_LARGE
    );
}

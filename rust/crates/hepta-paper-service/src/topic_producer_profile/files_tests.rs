use super::*;
use std::{
    os::unix::{
        ffi::OsStringExt,
        fs::{PermissionsExt, symlink},
    },
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-topic-profile-owner-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let fixture = Self { root };
        fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o700)).unwrap();
        fixture
    }
    fn file(&self, relative: &str, contents: &[u8]) -> PathBuf {
        let path = self.root.join(relative);
        fs::write(&path, contents).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn retained_actual_file_detects_same_inode_same_length_content_change() {
    let fixture = Fixture::new();
    let path = fixture.file("document.json", br#"{"v":1}"#);
    let mut owner = Observations::default();
    let before = owner.file(&path, FileKind::Profile).unwrap().metadata.ino();
    owner.assert_current().unwrap();
    fs::write(&path, br#"{"v":2}"#).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().ino(), before);
    assert_eq!(
        owner.assert_current().unwrap_err().code(),
        format!("{}{CHANGED}", super::super::PREFIX)
    );
}

#[test]
fn retained_file_and_parent_replacement_do_not_rebase_observations() {
    for replace_parent in [false, true] {
        let fixture = Fixture::new();
        let parent = fixture.root.join("parent");
        fs::create_dir(&parent).unwrap();
        let path = parent.join("document.json");
        fs::write(&path, b"{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let mut owner = Observations::default();
        owner.file(&path, FileKind::Profile).unwrap();
        if replace_parent {
            fs::rename(&parent, fixture.root.join("old-parent")).unwrap();
            fs::create_dir(&parent).unwrap();
        } else {
            fs::rename(&path, parent.join("old.json")).unwrap();
        }
        fs::write(&path, b"{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(owner.assert_current().is_err());
    }
}

#[test]
fn profile_leaf_and_ancestor_symlinks_are_refused_without_following_them() {
    let fixture = Fixture::new();
    let path = fixture.file("document.json", b"{}");
    let leaf = fixture.root.join("link.json");
    symlink(&path, &leaf).unwrap();
    let directory = fixture.root.join("link-directory");
    symlink(&fixture.root, &directory).unwrap();
    for path in [leaf, directory.join("document.json")] {
        assert!(
            Observations::default()
                .file(&path, FileKind::Profile)
                .is_err()
        );
    }
    assert_eq!(fs::read(&path).unwrap(), b"{}");
}

#[test]
fn fifo_does_not_block_and_profile_permissions_and_dataset_hardlinks_are_checked() {
    let fixture = Fixture::new();
    let fifo = fixture.root.join("fifo");
    nix::unistd::mkfifo(&fifo, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
    let start = Instant::now();
    assert!(
        Observations::default()
            .file(&fifo, FileKind::Profile)
            .is_err()
    );
    assert!(start.elapsed() < Duration::from_secs(1));
    let unsafe_mode = fixture.file("unsafe.json", b"{}");
    fs::set_permissions(&unsafe_mode, fs::Permissions::from_mode(0o666)).unwrap();
    assert!(
        Observations::default()
            .file(&unsafe_mode, FileKind::Profile)
            .is_err()
    );
    let dataset = fixture.file("data", b"sample");
    fs::hard_link(&dataset, fixture.root.join("alias")).unwrap();
    assert!(
        Observations::default()
            .file(&dataset, FileKind::Dataset)
            .is_err()
    );
}

#[test]
fn actual_read_stream_refuses_growth_past_the_observed_length_without_large_files() {
    let fixture = Fixture::new();
    let path = fixture.file("data", b"abc");
    let file = File::open(&path).unwrap();
    let observed = file.metadata().unwrap();
    let (hash, bytes, count) = read_hash(&file, observed.len(), true).unwrap();
    assert_eq!(count, 3);
    assert_eq!(bytes, b"abc");
    assert_eq!(
        hash,
        format!("sha256:{}", hex::encode(Sha256::digest(b"abc")))
    );
    fs::write(&path, b"abcd").unwrap();
    assert_eq!(
        read_hash(&file, observed.len(), false).unwrap_err().code(),
        format!("{}{CHANGED}", super::super::PREFIX)
    );
}

#[test]
fn real_directory_listing_budget_is_reserved_before_tree_recursion() {
    let fixture = Fixture::new();
    fixture.file("a", b"a");
    fixture.file("b", b"b");
    let mut owner = Observations::default();
    owner.directory(&fixture.root).unwrap();
    let directory = &owner.directories[&fixture.root];
    assert_eq!(directory_names(&directory.file, 2).unwrap(), ["a", "b"]);
    assert!(directory_names(&directory.file, 1).is_err());
    owner.entries = MAXIMUM_ENTRIES - 1;
    assert_eq!(
        owner.names(&fixture.root).unwrap_err().code(),
        format!("{}{BOUND}", super::super::PREFIX)
    );
    assert!(owner.directories[&fixture.root].names.is_none());
}

#[test]
fn empty_directory_additions_and_removed_entries_invalidate_retained_tree() {
    for add in [true, false] {
        let fixture = Fixture::new();
        if !add {
            fixture.file("old", b"old");
        }
        let mut owner = Observations::default();
        owner.names(&fixture.root).unwrap();
        owner.assert_current().unwrap();
        if add {
            fs::create_dir(fixture.root.join("empty-child")).unwrap();
        } else {
            fs::remove_file(fixture.root.join("old")).unwrap();
        }
        assert!(owner.assert_current().is_err());
    }
}

#[test]
fn backslash_and_non_utf8_dataset_names_are_explicit_profile_refusals() {
    for name in [
        std::ffi::OsString::from("nested\\alias"),
        std::ffi::OsString::from_vec(vec![0xff]),
    ] {
        let fixture = Fixture::new();
        let path = fixture.root.join(name);
        fs::write(path, b"data").unwrap();
        let error = Observations::default().names(&fixture.root).unwrap_err();
        assert_eq!(
            error.code(),
            "autonomous_research_topic_producer_dataset_relative_name_unsupported"
        );
    }
}

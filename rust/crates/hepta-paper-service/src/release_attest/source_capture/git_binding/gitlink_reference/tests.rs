use super::*;
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::AtomicU64,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-gitlink-reference-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("nested")).unwrap();
        Self(root)
    }
    fn entry(&self) -> TreeEntry {
        TreeEntry {
            mode: 0o160000,
            oid: "d13d857909525f4173063dbd6a7f1f48a089ae93".into(),
        }
    }
    fn capture(&self) -> Result<GitlinkReference> {
        GitlinkReference::capture(&self.0, "nested/reference", &self.entry())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn actual_absent_and_empty_gitlink_references_bind_named_and_held_directory_identity() {
    let f = Fixture::new();
    let missing = f.capture().unwrap();
    assert_eq!(missing.value()["state"], "absent");
    missing.assert_current().unwrap();
    let path = f.0.join("nested/reference");
    fs::create_dir(&path).unwrap();
    assert!(missing.assert_current().is_err());
    let empty = f.capture().unwrap();
    assert_eq!(empty.value()["commit"], f.entry().oid);
    assert_eq!(empty.value()["state"], "empty_directory");
    empty.assert_current().unwrap();
    fs::rename(&path, f.0.join("nested/original")).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(empty.assert_current().is_err());
    let empty = f.capture().unwrap();
    fs::write(path.join(".hidden"), b"unobserved nested source").unwrap();
    assert!(empty.assert_current().is_err());
    assert!(
        f.capture()
            .err()
            .unwrap()
            .0
            .contains("gitlink_materialized")
    );
    fs::remove_file(path.join(".hidden")).unwrap();
    assert!(empty.assert_current().is_err());
    let empty = f.capture().unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(empty.assert_current().is_err());
}

#[test]
fn actual_gitlink_reference_profile_refuses_aliases_materialized_repositories_and_wrong_modes() {
    let f = Fixture::new();
    let path = f.0.join("nested/reference");
    fs::create_dir(&path).unwrap();
    fs::create_dir(path.join(".git")).unwrap();
    assert!(
        f.capture()
            .err()
            .unwrap()
            .0
            .contains("gitlink_materialized")
    );
    fs::remove_dir_all(&path).unwrap();
    fs::create_dir(f.0.join("outside")).unwrap();
    symlink(f.0.join("outside"), &path).unwrap();
    assert!(f.capture().is_err());
    fs::remove_file(&path).unwrap();
    fs::remove_dir(f.0.join("nested")).unwrap();
    symlink(f.0.join("outside"), f.0.join("nested")).unwrap();
    assert!(f.capture().is_err());
    fs::remove_file(f.0.join("nested")).unwrap();
    fs::create_dir(f.0.join("nested")).unwrap();
    fs::write(&path, b"not a directory").unwrap();
    assert!(f.capture().is_err());
    fs::remove_file(&path).unwrap();
    nix::unistd::mkfifo(&path, Mode::from_bits_truncate(0o600)).unwrap();
    assert!(f.capture().is_err());
    assert!(
        GitlinkReference::capture(
            &f.0,
            "nested/reference",
            &TreeEntry {
                mode: 0o100644,
                oid: f.entry().oid
            }
        )
        .is_err()
    );
    assert!(GitlinkReference::capture(&f.0, "nested/../outside", &f.entry()).is_err());
}

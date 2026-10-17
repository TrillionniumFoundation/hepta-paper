use super::*;
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-machine-intake-files-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn bounded_reader_rejects_oversize_fifo_symlink_and_writable_file() {
    let f = Fixture::new();
    let exact = f.write("exact.json", &vec![b' '; MAXIMUM_BYTES as usize]);
    let observed = ObservedJsonFile::read(&exact, &f.0).unwrap();
    assert_eq!(observed.bytes.len() as u64, MAXIMUM_BYTES);
    drop(observed);
    let larger = f.write("larger.json", &vec![b' '; MAXIMUM_BYTES as usize + 1]);
    assert!(ObservedJsonFile::read(&larger, &f.0).is_err());
    let small = f.write("small.json", b"0");
    assert!(ObservedJsonFile::read(&small, &f.0).is_err());
    let link = f.0.join("link.json");
    symlink(&exact, &link).unwrap();
    assert!(ObservedJsonFile::read(&link, &f.0).is_err());
    let pipe = f.0.join("pipe.json");
    nix::unistd::mkfifo(&pipe, Mode::from_bits_truncate(0o600)).unwrap();
    assert!(ObservedJsonFile::read(&pipe, &f.0).is_err());
    fs::set_permissions(&exact, fs::Permissions::from_mode(0o622)).unwrap();
    assert!(ObservedJsonFile::read(&exact, &f.0).is_err());
}
#[test]
fn retained_original_refuses_file_and_ancestor_rebinding() {
    let f = Fixture::new();
    let original = f.write("original.json", b"{}");
    let observation = ObservedJsonFile::read(&original, &f.0).unwrap();
    let replacement = f.write("replacement.json", b"{}");
    fs::rename(&replacement, &original).unwrap();
    assert!(observation.assert_current().is_err());
    drop(observation);
    let parent = f.0.join("parent");
    fs::create_dir(&parent).unwrap();
    let selected = parent.join("config.json");
    fs::write(&selected, b"{}").unwrap();
    fs::set_permissions(&selected, fs::Permissions::from_mode(0o600)).unwrap();
    let held = ObservedJsonFile::read(&selected, &f.0).unwrap();
    fs::rename(&parent, f.0.join("retired-parent")).unwrap();
    fs::create_dir(&parent).unwrap();
    fs::write(&selected, b"{}").unwrap();
    assert!(held.assert_current().is_err());
    assert_eq!(fs::read(selected).unwrap(), b"{}");
}
#[test]
fn in_place_content_change_is_not_current_even_with_same_length() {
    let f = Fixture::new();
    let original = f.write("original.json", b"{}");
    let observation = ObservedJsonFile::read(&original, &f.0).unwrap();
    fs::write(&original, b"[]").unwrap();
    // Explicitly change mode too, making this independent of filesystem timestamp resolution.
    fs::set_permissions(&original, fs::Permissions::from_mode(0o400)).unwrap();
    assert!(observation.assert_current().is_err());
}

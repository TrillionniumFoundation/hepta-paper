//! Descriptor-pinned receipt reads for the personal GPU check route.
//!
//! The Node implementation uses the scoped-file reader from the workflow
//! kernel.  This small adapter keeps the same boundary for the receipt used by
//! the Rust `--check` route: the parent must remain a real directory, the leaf a regular file, the opened descriptor must remain the same object throughout the
//! read, and a FIFO or symlink replacement must fail closed.

use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    os::unix::{fs::MetadataExt, fs::OpenOptionsExt},
    path::Path,
};

const MAX_RECEIPT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct PersonalGpuReceiptReadError;

impl std::fmt::Display for PersonalGpuReceiptReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("personal_gpu_receipt_read_blocked")
    }
}

impl std::error::Error for PersonalGpuReceiptReadError {}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
    mode: u32,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    link_count: u64,
}

impl FileIdentity {
    fn from_metadata(metadata: &Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            mode: metadata.mode(),
            size: metadata.len(),
            // Node's `mtimeNs` contains the complete timestamp.  Comparing
            // only nanoseconds is insufficient: whole-second rewrites must
            // invalidate a receipt read as well.
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
            link_count: metadata.nlink(),
        }
    }
}

fn blocked() -> PersonalGpuReceiptReadError {
    PersonalGpuReceiptReadError
}

/// Check the parent and candidate path identity without following a symlink.
///
/// The caller passes a lexical absolute path (the command boundary performs
/// Node-compatible `path.resolve` first). Node permits a symlink above the
/// parent scope, but never permits the scope itself or the leaf to be one.
fn path_identity(path: &Path) -> Result<FileIdentity, PersonalGpuReceiptReadError> {
    let parent = path.parent().ok_or_else(blocked)?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|_| blocked())?;
    if !parent_metadata.is_dir() || parent_metadata.file_type().is_symlink() {
        return Err(blocked());
    }
    let real_parent = fs::canonicalize(parent).map_err(|_| blocked())?;

    let metadata = fs::symlink_metadata(path).map_err(|_| blocked())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.nlink() != 1
        || metadata.len() > MAX_RECEIPT_BYTES
    {
        return Err(blocked());
    }
    if fs::canonicalize(path).map_err(|_| blocked())?.parent() != Some(real_parent.as_path()) {
        return Err(blocked());
    }
    Ok(FileIdentity::from_metadata(&metadata))
}

fn descriptor_identity(file: &File) -> Result<FileIdentity, PersonalGpuReceiptReadError> {
    let metadata = file.metadata().map_err(|_| blocked())?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > MAX_RECEIPT_BYTES {
        return Err(blocked());
    }
    Ok(FileIdentity::from_metadata(&metadata))
}

fn read_with_hooks<F, G>(
    path: &Path,
    mut before_open: F,
    mut after_read: G,
) -> Result<Vec<u8>, PersonalGpuReceiptReadError>
where
    F: FnMut(&Path),
    G: FnMut(&Path),
{
    let before = path_identity(path)?;
    before_open(path);

    // O_NONBLOCK is intentional.  If an attacker swaps the regular file for
    // a FIFO between lstat and open, this call cannot wait for a writer.
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| blocked())?;
    let opened = descriptor_identity(&file)?;
    if opened != before {
        return Err(blocked());
    }

    let mut bytes = Vec::new();
    (&file)
        .take(MAX_RECEIPT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| blocked())?;
    if bytes.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(blocked());
    }

    after_read(path);

    // Check both the retained descriptor and the path after reading.  The
    // descriptor catches in-place mutation; path_identity catches a parent or
    // leaf replacement/rebind while the descriptor was being read.
    let descriptor_after = descriptor_identity(&file)?;
    if descriptor_after != before {
        return Err(blocked());
    }
    let after = path_identity(path)?;
    if after != before {
        return Err(blocked());
    }
    Ok(bytes)
}

/// Read a personal GPU operational receipt under the Node-compatible scoped
/// file boundary.  Any identity, type, size, or race failure is fail-closed.
pub fn read_personal_gpu_receipt_v1(path: &Path) -> Result<Vec<u8>, PersonalGpuReceiptReadError> {
    read_with_hooks(path, |_| {}, |_| {})
}

#[cfg(test)]
mod tests {
    use super::*;
    use nix::{sys::stat::Mode, unistd::mkfifo};
    use std::{
        fs::{self, File},
        os::unix::fs::{PermissionsExt, symlink},
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{Duration, UNIX_EPOCH},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "hepta-personal-gpu-files-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).expect("temporary directory");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                .expect("temporary permissions");
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn receipt_path(root: &Path) -> PathBuf {
        let path = root.join("receipt.json");
        fs::write(&path, b"{}\n").expect("receipt");
        path
    }

    #[test]
    fn whole_second_mtime_change_is_rejected() {
        let root = Temp::new();
        let path = receipt_path(&root.0);
        File::options()
            .write(true)
            .open(&path)
            .expect("open receipt")
            .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1)))
            .expect("initial whole-second mtime");
        let result = read_with_hooks(
            &path,
            |_| {},
            |candidate| {
                let file = OpenOptions::new()
                    .write(true)
                    .open(candidate)
                    .expect("open receipt for mtime update");
                file.set_times(
                    fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(2)),
                )
                .expect("set whole-second mtime");
            },
        );
        assert_eq!(result, Err(blocked()));
    }

    #[test]
    fn parent_symlink_rebind_after_read_is_rejected() {
        let root = Temp::new();
        let parent = root.0.join("parent");
        let moved = root.0.join("moved");
        fs::create_dir(&parent).expect("parent");
        let path = parent.join("receipt.json");
        fs::write(&path, b"{}\n").expect("receipt");
        let result = read_with_hooks(
            &path,
            |_| {},
            |_| {
                fs::rename(&parent, &moved).expect("move parent");
                symlink(&moved, &parent).expect("rebind parent");
            },
        );
        assert_eq!(result, Err(blocked()));
    }

    #[test]
    fn fifo_swap_before_open_is_rejected_without_blocking() {
        let root = Temp::new();
        let path = receipt_path(&root.0);
        let result = read_with_hooks(
            &path,
            |candidate| {
                fs::remove_file(candidate).expect("remove receipt");
                mkfifo(candidate, Mode::from_bits_truncate(0o600)).expect("create fifo");
            },
            |_| {},
        );
        assert_eq!(result, Err(blocked()));
    }

    #[test]
    fn unchanged_regular_file_reads() {
        let root = Temp::new();
        let path = receipt_path(&root.0);
        assert_eq!(read_personal_gpu_receipt_v1(&path).unwrap(), b"{}\n");
        let metadata = File::open(path).unwrap().metadata().unwrap();
        assert!(metadata.is_file());
    }
}

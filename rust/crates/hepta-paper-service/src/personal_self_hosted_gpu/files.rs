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

fn read_kernel<F, G>(
    path: &Path,
    before_open: F,
    after_read: G,
    control: Option<(&std::sync::atomic::AtomicBool, std::time::Instant)>,
) -> Result<(File, Vec<u8>), String>
where
    F: FnOnce(&Path),
    G: FnOnce(&Path),
{
    let checkpoint = || match control {
        Some((flag, deadline)) => gpu_check_active_v1(flag, deadline),
        None => Ok(()),
    };
    checkpoint()?;
    let before = path_identity(path).map_err(|_| "personal_gpu_receipt_read_blocked")?;
    before_open(path);
    checkpoint()?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| "personal_gpu_receipt_read_blocked")?;
    let opened = descriptor_identity(&file).map_err(|_| "personal_gpu_receipt_read_blocked")?;
    if opened != before {
        return Err("personal_gpu_receipt_read_blocked".into());
    }
    let mut bytes = Vec::new();
    if control.is_some() {
        let mut reader = &file;
        let mut block = [0u8; 64 * 1024];
        loop {
            checkpoint()?;
            let maximum = usize::try_from(
                (before.size.saturating_sub(bytes.len() as u64) + 1).min(block.len() as u64),
            )
            .map_err(|_| "personal_gpu_receipt_read_blocked")?;
            let n = match reader.read(&mut block[..maximum]) {
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err("personal_gpu_receipt_read_blocked".into()),
            };
            if n == 0 {
                break;
            }
            if bytes
                .len()
                .checked_add(n)
                .is_none_or(|v| v as u64 > before.size || v as u64 > MAX_RECEIPT_BYTES)
            {
                return Err("personal_gpu_check_input_changed".into());
            }
            bytes.extend_from_slice(&block[..n]);
        }
        if bytes.len() as u64 != before.size {
            return Err("personal_gpu_check_input_changed".into());
        }
    } else {
        // The old None path retains its original maximum+one reader behavior.
        (&file)
            .take(MAX_RECEIPT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "personal_gpu_receipt_read_blocked")?;
        if bytes.len() as u64 > MAX_RECEIPT_BYTES {
            return Err("personal_gpu_receipt_read_blocked".into());
        }
    }
    after_read(path);
    checkpoint()?;
    if descriptor_identity(&file).map_err(|_| "personal_gpu_receipt_read_blocked")? != before
        || path_identity(path).map_err(|_| "personal_gpu_receipt_read_blocked")? != before
    {
        return Err("personal_gpu_receipt_read_blocked".into());
    }
    Ok((file, bytes))
}
fn read_with_hooks<F, G>(
    path: &Path,
    before_open: F,
    after_read: G,
) -> Result<Vec<u8>, PersonalGpuReceiptReadError>
where
    F: FnOnce(&Path),
    G: FnOnce(&Path),
{
    read_kernel(path, before_open, after_read, None)
        .map(|(_, bytes)| bytes)
        .map_err(|_| blocked())
}

/// Read a personal GPU operational receipt under the Node-compatible scoped
/// file boundary.  Any identity, type, size, or race failure is fail-closed.
pub fn read_personal_gpu_receipt_v1(path: &Path) -> Result<Vec<u8>, PersonalGpuReceiptReadError> {
    read_with_hooks(path, |_| {}, |_| {})
}

/// An ordinary successful read retains its original scoped reader and the
/// same cancellation/deadline through bounded encoding and final currentness.
pub(crate) struct RetainedPersonalGpuReceiptV1 {
    path: std::path::PathBuf,
    file: File,
    identity: Metadata,
    bytes: Vec<u8>,
    parent: File,
    parent_identity: Metadata,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    deadline: std::time::Instant,
}
pub(super) fn same_full(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.nlink() == b.nlink()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
pub(crate) fn gpu_check_active_v1(
    cancelled: &std::sync::atomic::AtomicBool,
    deadline: std::time::Instant,
) -> Result<(), String> {
    if cancelled.load(std::sync::atomic::Ordering::Acquire) {
        return Err("personal_gpu_check_cancelled".into());
    }
    if std::time::Instant::now() >= deadline {
        return Err("personal_gpu_check_deadline_exceeded".into());
    }
    Ok(())
}
impl RetainedPersonalGpuReceiptV1 {
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub(crate) fn assert_current(&self) -> Result<(), String> {
        gpu_check_active_v1(&self.cancelled, self.deadline)?;
        let expected = FileIdentity::from_metadata(&self.identity);
        let held = self
            .file
            .metadata()
            .map_err(|_| "personal_gpu_check_input_changed")?;
        let named =
            fs::symlink_metadata(&self.path).map_err(|_| "personal_gpu_check_input_changed")?;
        let parent_path = self
            .path
            .parent()
            .ok_or("personal_gpu_check_input_changed")?;
        let parent = self
            .parent
            .metadata()
            .map_err(|_| "personal_gpu_check_input_changed")?;
        let named_parent =
            fs::symlink_metadata(parent_path).map_err(|_| "personal_gpu_check_input_changed")?;
        if path_identity(&self.path).map_err(|_| "personal_gpu_check_input_changed")? != expected
            || !same_full(&self.identity, &held)
            || !same_full(&self.identity, &named)
            || !same_full(&self.parent_identity, &parent)
            || !same_full(&self.parent_identity, &named_parent)
        {
            return Err("personal_gpu_check_input_changed".into());
        }
        gpu_check_active_v1(&self.cancelled, self.deadline)
    }
}
pub(crate) fn read_retained_personal_gpu_receipt_v1(
    path: &Path,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    deadline: std::time::Instant,
) -> Result<RetainedPersonalGpuReceiptV1, String> {
    gpu_check_active_v1(&cancelled, deadline)?;
    // The SAME scoped-file kernel retains the original read FD. Full metadata
    // and parent checks are additive only for the explicit ordinary controls.
    let identity = fs::symlink_metadata(path).map_err(|_| "personal_gpu_receipt_read_blocked")?;
    let parent_path = path.parent().ok_or("personal_gpu_receipt_read_blocked")?;
    let parent = OpenOptions::new()
        .read(true)
        .custom_flags(
            nix::libc::O_NOFOLLOW
                | nix::libc::O_NONBLOCK
                | nix::libc::O_DIRECTORY
                | nix::libc::O_CLOEXEC,
        )
        .open(parent_path)
        .map_err(|_| "personal_gpu_receipt_read_blocked")?;
    let parent_identity = parent
        .metadata()
        .map_err(|_| "personal_gpu_receipt_read_blocked")?;
    if !same_full(
        &parent_identity,
        &fs::symlink_metadata(parent_path).map_err(|_| "personal_gpu_receipt_read_blocked")?,
    ) {
        return Err("personal_gpu_check_input_changed".into());
    }
    let (file, bytes) = read_kernel(path, |_| {}, |_| {}, Some((&cancelled, deadline)))?;
    let result = RetainedPersonalGpuReceiptV1 {
        path: path.to_owned(),
        file,
        identity,
        bytes,
        parent,
        parent_identity,
        cancelled,
        deadline,
    };
    result.assert_current()?;
    Ok(result)
}

/// Genuine ENOENT retains the original missing edge. An unreadable, aliased,
/// special or multiply linked existing leaf never becomes a writable absence.
pub(crate) struct MissingPersonalGpuReceiptV1<'a> {
    path: std::path::PathBuf,
    observed: crate::runtime_source_cas::observation::SourceObservation<'a>,
    parent: Option<(File, Metadata)>,
}
fn same_parent_object(a: &Metadata, b: &Metadata) -> bool {
    a.is_dir()
        && b.is_dir()
        && a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
}
impl RetainedPersonalGpuReceiptV1 {
    pub(super) fn publication_path(&self) -> &Path {
        &self.path
    }
    pub(super) fn require_publication_control(
        &self,
        cancelled: &std::sync::atomic::AtomicBool,
        deadline: std::time::Instant,
    ) -> Result<(), String> {
        if !std::ptr::eq(self.cancelled.as_ref(), cancelled) || self.deadline != deadline {
            return Err("personal_gpu_check_control_context_mismatch".into());
        }
        gpu_check_active_v1(cancelled, deadline)
    }
    pub(super) fn publication_metadata(&self) -> &Metadata {
        &self.identity
    }
    pub(super) fn assert_publication_leaf(&self, path: &Path, parent: &File) -> Result<(), String> {
        gpu_check_active_v1(&self.cancelled, self.deadline)?;
        if path != self.path
            || !same_full(
                &self.identity,
                &self
                    .file
                    .metadata()
                    .map_err(|_| "personal_gpu_check_input_changed")?,
            )
            || !same_full(
                &self.identity,
                &fs::symlink_metadata(path).map_err(|_| "personal_gpu_check_input_changed")?,
            )
            || !same_parent_object(
                &self.parent_identity,
                &parent
                    .metadata()
                    .map_err(|_| "personal_gpu_check_input_changed")?,
            )
            || !same_parent_object(
                &self.parent_identity,
                &self
                    .parent
                    .metadata()
                    .map_err(|_| "personal_gpu_check_input_changed")?,
            )
        {
            return Err("personal_gpu_check_input_changed".into());
        }
        gpu_check_active_v1(&self.cancelled, self.deadline)
    }
}
impl MissingPersonalGpuReceiptV1<'_> {
    pub(super) fn publication_path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn assert_current(&self) -> Result<(), String> {
        self.observed.assert_current()
    }
    pub(super) fn require_publication_control(
        &self,
        cancelled: &std::sync::atomic::AtomicBool,
        deadline: std::time::Instant,
    ) -> Result<(), String> {
        self.observed
            .require_control_context_v1(cancelled, deadline)
    }
    pub(super) fn parent_exists(&self) -> bool {
        self.parent.is_some()
    }
    pub(super) fn assert_publication_leaf(&self, path: &Path, parent: &File) -> Result<(), String> {
        if path != self.path {
            return Err("personal_gpu_check_input_changed".into());
        }
        match fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            _ => return Err("personal_gpu_check_input_changed".into()),
        }
        if let Some((held, identity)) = &self.parent
            && (!same_parent_object(
                identity,
                &held
                    .metadata()
                    .map_err(|_| "personal_gpu_check_input_changed")?,
            ) || !same_parent_object(
                identity,
                &parent
                    .metadata()
                    .map_err(|_| "personal_gpu_check_input_changed")?,
            ))
        {
            return Err("personal_gpu_check_input_changed".into());
        }
        Ok(())
    }
}
pub(crate) fn observe_missing_personal_gpu_receipt_v1<'a>(
    path: &Path,
    cancelled: &'a std::sync::atomic::AtomicBool,
    deadline: std::time::Instant,
) -> Result<MissingPersonalGpuReceiptV1<'a>, String> {
    let relative = path
        .strip_prefix("/")
        .map_err(|_| "personal_gpu_check_receipt_invalid")?;
    let mut observed =
        crate::runtime_source_cas::observation::SourceObservation::new_with_deadline(
            Path::new("/"),
            cancelled,
            deadline,
        )?;
    if observed.inventory_probe(relative)?.is_some() {
        return Err("personal_gpu_check_receipt_not_missing".into());
    }
    let parent_path = path.parent().ok_or("personal_gpu_check_receipt_invalid")?;
    let parent = match observed.inventory_probe(
        parent_path
            .strip_prefix("/")
            .map_err(|_| "personal_gpu_check_receipt_invalid")?,
    )? {
        Some(metadata) if metadata.directory => {
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(
                    nix::libc::O_NOFOLLOW
                        | nix::libc::O_NONBLOCK
                        | nix::libc::O_DIRECTORY
                        | nix::libc::O_CLOEXEC,
                )
                .open(parent_path)
                .map_err(|_| "personal_gpu_check_input_changed")?;
            let identity = file
                .metadata()
                .map_err(|_| "personal_gpu_check_input_changed")?;
            if !same_full(
                &identity,
                &fs::symlink_metadata(parent_path)
                    .map_err(|_| "personal_gpu_check_input_changed")?,
            ) {
                return Err("personal_gpu_check_input_changed".into());
            }
            Some((file, identity))
        }
        None => None,
        _ => return Err("personal_gpu_check_input_changed".into()),
    };
    observed.assert_current()?;
    Ok(MissingPersonalGpuReceiptV1 {
        path: path.to_owned(),
        observed,
        parent,
    })
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

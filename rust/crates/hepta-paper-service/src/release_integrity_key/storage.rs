use super::{EventV1, HookV1, Result, error};
use std::{
    fs::{self, DirBuilder, File, Metadata, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
};
use zeroize::Zeroizing;

pub(super) const PRIVATE_NAME: &str = "release-integrity-ed25519-private.pem";
pub(super) const PUBLIC_NAME: &str = "release-integrity-ed25519-public.pem";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Identity {
    pub dev: u64,
    pub ino: u64,
}
impl Identity {
    pub fn of(stat: &Metadata) -> Self {
        Self {
            dev: stat.dev(),
            ino: stat.ino(),
        }
    }
    pub fn matches(&self, stat: &Metadata) -> bool {
        *self == Self::of(stat)
    }
}
pub(super) struct Paths {
    pub root: PathBuf,
    pub private: PathBuf,
    pub public: PathBuf,
}
impl Paths {
    pub fn new(runtime: &Path) -> Self {
        let root = runtime.join("release-signing");
        Self {
            private: root.join(PRIVATE_NAME),
            public: root.join(PUBLIC_NAME),
            root,
        }
    }
}
pub(super) fn io_error(
    err: std::io::Error,
    operation: &str,
    path: &Path,
) -> super::ReleaseIntegrityKeyError {
    let (code, message) = match err.raw_os_error() {
        Some(nix::libc::ENOENT) => ("ENOENT", "no such file or directory"),
        Some(nix::libc::EEXIST) => ("EEXIST", "file already exists"),
        Some(nix::libc::EACCES) => ("EACCES", "permission denied"),
        Some(nix::libc::ENOTDIR) => ("ENOTDIR", "not a directory"),
        Some(nix::libc::EISDIR) => ("EISDIR", "illegal operation on a directory"),
        Some(nix::libc::ELOOP) => ("ELOOP", "too many symbolic links encountered"),
        Some(nix::libc::EPERM) => ("EPERM", "operation not permitted"),
        _ => ("EIO", "input/output error"),
    };
    error(format!(
        "{code}: {message}, {operation} '{}'",
        path.display()
    ))
}
pub(super) fn lstat(path: &Path) -> Result<Metadata> {
    fs::symlink_metadata(path).map_err(|e| io_error(e, "lstat", path))
}
pub(super) fn lstat_optional(path: &Path) -> Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_error(e, "lstat", path)),
    }
}
pub(super) fn normalize(path: &Path) -> Result<PathBuf> {
    let selected = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|e| io_error(e, "getcwd", path))?
            .join(path)
    };
    let mut result = PathBuf::new();
    for component in selected.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            _ => result.push(component),
        }
    }
    Ok(result)
}
pub(super) fn safe_directory(path: &Path, code: &str) -> Result<PathBuf> {
    let path = normalize(path)?;
    let mut selected = PathBuf::from("/");
    for part in path.components().skip(1) {
        selected.push(part);
        let metadata = lstat(&selected)?;
        if !metadata.is_dir() || metadata.is_symlink() {
            return Err(error(code));
        }
    }
    if fs::canonicalize(&path).map_err(|e| io_error(e, "realpath", &path))? != path {
        return Err(error(code));
    }
    Ok(path)
}
pub(super) type Chain = Vec<(PathBuf, Identity)>;
pub(super) fn snapshot(path: &Path) -> Result<Chain> {
    let path = normalize(path)?;
    let mut selected = PathBuf::from("/");
    let mut entries = vec![(selected.clone(), Identity::of(&lstat(&selected)?))];
    for part in path.components().skip(1) {
        selected.push(part);
        let meta = lstat(&selected)?;
        if !meta.is_dir() || meta.is_symlink() {
            return Err(error("release_integrity_directory_chain_unsafe"));
        }
        entries.push((selected.clone(), Identity::of(&meta)));
    }
    Ok(entries)
}
pub(super) fn unchanged(chain: &Chain) -> Result<()> {
    for (path, identity) in chain {
        let actual = lstat(path)?;
        if !actual.is_dir() || actual.is_symlink() || !identity.matches(&actual) {
            return Err(error("release_integrity_directory_chain_changed"));
        }
    }
    Ok(())
}
pub(super) fn private_directory(meta: &Metadata, uid: u32, code: &str) -> Result<()> {
    if !meta.is_dir() || meta.is_symlink() || meta.mode() & 0o7777 != 0o700 || meta.uid() != uid {
        Err(error(code))
    } else {
        Ok(())
    }
}
pub(super) fn private_chain(chain: &Chain, uid: u32, code: &str) -> Result<()> {
    unchanged(chain)?;
    let path = &chain.last().ok_or_else(|| error(code))?.0;
    private_directory(&lstat(path)?, uid, code)
}
pub(super) fn names(path: &Path) -> Result<Vec<String>> {
    let mut names = fs::read_dir(path)
        .map_err(|e| io_error(e, "scandir", path))?
        .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| io_error(e, "scandir", path))?;
    names.sort();
    Ok(names)
}
pub(super) struct KeyFile {
    pub bytes: Zeroizing<Vec<u8>>,
    path: PathBuf,
    metadata: Metadata,
}
impl KeyFile {
    pub fn assert_current(&self) -> Result<()> {
        unchanged_file(&self.path, &self.metadata)
    }
}
fn same_file_metadata(before: &Metadata, after: &Metadata) -> bool {
    Identity::of(before).matches(after)
        && before.file_type() == after.file_type()
        && before.mode() == after.mode()
        && before.uid() == after.uid()
        && before.gid() == after.gid()
        && before.nlink() == after.nlink()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
}
pub(super) fn unchanged_file(path: &Path, expected: &Metadata) -> Result<()> {
    let current = lstat(path)?;
    if !same_file_metadata(expected, &current) {
        return Err(error("release_integrity_key_file_changed_during_read"));
    }
    Ok(())
}
fn safe_file(meta: &Metadata, mode: u32, uid: u32) -> bool {
    meta.is_file()
        && !meta.is_symlink()
        && meta.nlink() == 1
        && meta.mode() & 0o7777 == mode
        && meta.uid() == uid
        && (1..=16 * 1024).contains(&meta.len())
}
pub(super) fn read_key(
    path: &Path,
    mode: u32,
    uid: u32,
    hooks: &mut dyn HookV1,
) -> Result<KeyFile> {
    let selected = lstat(path)?;
    if !safe_file(&selected, mode, uid) {
        return Err(error("release_integrity_key_file_unsafe"));
    }
    hooks.event(EventV1::BeforeReadFile, path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| io_error(e, "open", path))?;
    let before = file.metadata().map_err(|e| io_error(e, "fstat", path))?;
    let identity = Identity::of(&before);
    if !safe_file(&before, mode, uid) || !identity.matches(&selected) {
        return Err(error("release_integrity_key_file_unsafe"));
    }
    let mut bytes = Zeroizing::new(Vec::new());
    (&mut file)
        .take(16 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| io_error(e, "read", path))?;
    hooks.event(EventV1::AfterReadFile, path)?;
    let after = file.metadata().map_err(|e| io_error(e, "fstat", path))?;
    let current = lstat(path)?;
    if !same_file_metadata(&before, &after)
        || !same_file_metadata(&before, &current)
        || after.len() != before.len()
        || after.mtime() != before.mtime()
        || after.mtime_nsec() != before.mtime_nsec()
        || after.ctime() != before.ctime()
        || after.ctime_nsec() != before.ctime_nsec()
        || !identity.matches(&current)
        || !current.is_file()
        || current.is_symlink()
        || current.nlink() != 1
        || bytes.len() as u64 != before.len()
    {
        return Err(error("release_integrity_key_file_changed_during_read"));
    }
    Ok(KeyFile {
        bytes,
        path: path.to_owned(),
        metadata: before,
    })
}
pub(super) fn random_hex() -> Result<String> {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes)
        .map_err(|_| error("release_integrity_key_randomness_unavailable"))?;
    Ok(hex::encode(bytes))
}
fn quarantine(path: &Path) -> Result<PathBuf> {
    Ok(PathBuf::from(format!(
        "{}.{}.{}.quarantine",
        path.display(),
        std::process::id(),
        random_hex()?
    )))
}
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    nix::fcntl::renameat2(
        nix::fcntl::AT_FDCWD,
        from,
        nix::fcntl::AT_FDCWD,
        to,
        nix::fcntl::RenameFlags::RENAME_NOREPLACE,
    )
    .map_err(std::io::Error::from)
}
pub(super) fn remove_exact(path: &Path, identity: Identity, hooks: &mut dyn HookV1) -> bool {
    let Ok(quarantine) = quarantine(path) else {
        return false;
    };
    if hooks.event(EventV1::BeforeCleanupFileRename, path).is_err()
        || rename_no_replace(path, &quarantine).is_err()
    {
        return false;
    }
    let Ok(moved) = lstat(&quarantine) else {
        return false;
    };
    if !moved.is_file() || moved.is_symlink() || !identity.matches(&moved) {
        if fs::hard_link(&quarantine, path).is_ok()
            && lstat(path).is_ok_and(|restored| Identity::of(&moved).matches(&restored))
            && moved.is_file()
            && !moved.is_symlink()
        {
            let _ = remove_exact(&quarantine, Identity::of(&moved), hooks);
        }
        return false;
    }
    fs::remove_file(&quarantine).is_ok()
}
pub(super) fn remove_pair_directory(
    path: &Path,
    identity: Identity,
    publications: &[(PathBuf, Identity)],
    hooks: &mut dyn HookV1,
) -> bool {
    let Ok(quarantine) = quarantine(path) else {
        return false;
    };
    if hooks
        .event(EventV1::BeforeCleanupDirectoryRename, path)
        .is_err()
        || rename_no_replace(path, &quarantine).is_err()
    {
        return false;
    }
    let Ok(moved) = lstat(&quarantine) else {
        return false;
    };
    if !moved.is_dir() || moved.is_symlink() || !identity.matches(&moved) {
        return false;
    }
    for (publication, identity) in publications.iter().rev() {
        let Some(name) = publication.file_name() else {
            return false;
        };
        if !remove_exact(&quarantine.join(name), *identity, hooks) {
            return false;
        }
    }
    names(&quarantine).is_ok_and(|names| names.is_empty()) && fs::remove_dir(&quarantine).is_ok()
}
pub(super) fn remove_empty_directory(
    path: &Path,
    identity: Identity,
    hooks: &mut dyn HookV1,
) -> bool {
    let Ok(selected) = lstat(path) else {
        return false;
    };
    if !selected.is_dir()
        || selected.is_symlink()
        || !identity.matches(&selected)
        || !names(path).is_ok_and(|v| v.is_empty())
    {
        return false;
    }
    let Ok(quarantine) = quarantine(path) else {
        return false;
    };
    if hooks
        .event(EventV1::BeforeCleanupDirectoryRename, path)
        .is_err()
        || rename_no_replace(path, &quarantine).is_err()
    {
        return false;
    }
    let Ok(moved) = lstat(&quarantine) else {
        return false;
    };
    if !moved.is_dir()
        || moved.is_symlink()
        || !identity.matches(&moved)
        || !names(&quarantine).is_ok_and(|v| v.is_empty())
    {
        return false;
    }
    fs::remove_dir(&quarantine).is_ok()
}
pub(super) fn write_exclusive(
    path: &Path,
    bytes: &[u8],
    mode: u32,
    uid: u32,
    hooks: &mut dyn HookV1,
) -> Result<Identity> {
    hooks.event(EventV1::BeforeWriteFile, path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| io_error(e, "open", path))?;
    let opened = file.metadata().map_err(|e| io_error(e, "fstat", path))?;
    if !opened.is_file() || opened.nlink() != 1 {
        return Err(error("release_integrity_key_output_unsafe"));
    }
    let identity = Identity::of(&opened);
    let result = (|| {
        file.write_all(bytes)
            .map_err(|e| io_error(e, "write", path))?;
        file.set_permissions(fs::Permissions::from_mode(mode))
            .map_err(|e| io_error(e, "fchmod", path))?;
        file.sync_all().map_err(|e| io_error(e, "fsync", path))?;
        hooks.event(EventV1::AfterWriteFile, path)?;
        let committed = file.metadata().map_err(|e| io_error(e, "fstat", path))?;
        if !identity.matches(&committed)
            || committed.len() != bytes.len() as u64
            || committed.nlink() != 1
            || committed.mode() & 0o7777 != mode
            || committed.uid() != uid
        {
            return Err(error("release_integrity_key_output_postimage_mismatch"));
        }
        Ok(identity)
    })();
    drop(file);
    match result {
        Ok(value) => Ok(value),
        Err(err) => {
            if !remove_exact(path, identity, hooks) {
                Err(error(format!(
                    "release_integrity_key_output_rollback_incomplete:{err}"
                )))
            } else {
                Err(err)
            }
        }
    }
}
pub(super) fn harden_staging(path: &Path, uid: u32, hooks: &mut dyn HookV1) -> Result<Identity> {
    let before = lstat(path)?;
    if !before.is_dir() || before.is_symlink() || before.uid() != uid {
        return Err(error("release_integrity_key_staging_root_unsafe"));
    }
    hooks.event(EventV1::BeforeStagingOpen, path)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| io_error(e, "open", path))?;
    let opened = file.metadata().map_err(|e| io_error(e, "fstat", path))?;
    let identity = Identity::of(&opened);
    if !opened.is_dir() || !identity.matches(&before) || opened.uid() != uid {
        return Err(error("release_integrity_key_staging_root_unsafe"));
    }
    file.set_permissions(fs::Permissions::from_mode(0o700))
        .map_err(|e| io_error(e, "fchmod", path))?;
    let committed = file.metadata().map_err(|e| io_error(e, "fstat", path))?;
    let current = lstat(path)?;
    if !committed.is_dir()
        || !identity.matches(&committed)
        || !identity.matches(&current)
        || committed.mode() & 0o7777 != 0o700
        || committed.uid() != uid
    {
        return Err(error("release_integrity_key_staging_root_unsafe"));
    }
    Ok(identity)
}
pub(super) fn mkdir(path: &Path, mode: u32) -> std::io::Result<()> {
    DirBuilder::new().mode(mode).create(path)
}
pub(super) fn fsync_directory(path: &Path, expected: Option<Identity>) -> Result<()> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| io_error(e, "open", path))?;
    let metadata = file.metadata().map_err(|e| io_error(e, "fstat", path))?;
    if !metadata.is_dir() || expected.is_some_and(|id| !id.matches(&metadata)) {
        return Err(error("release_integrity_key_directory_identity_mismatch"));
    }
    file.sync_all().map_err(|e| io_error(e, "fsync", path))
}
pub(super) fn publish(
    source: &Path,
    destination: &Path,
    identity: Identity,
    mode: u32,
    uid: u32,
    hooks: &mut dyn HookV1,
) -> Result<(PathBuf, Identity)> {
    hooks.event(EventV1::BeforeLink, destination)?;
    fs::hard_link(source, destination).map_err(|e| {
        let mut err = io_error(e, "link", source);
        err.0.push_str(&format!(" -> '{}'", destination.display()));
        err
    })?;
    let selected = lstat(destination)?;
    if !selected.is_file()
        || selected.is_symlink()
        || !identity.matches(&selected)
        || selected.nlink() != 2
        || selected.mode() & 0o7777 != mode
        || selected.uid() != uid
    {
        if !remove_exact(destination, identity, hooks) {
            return Err(error("release_integrity_key_publish_rollback_incomplete"));
        }
        return Err(error("release_integrity_key_publish_postimage_mismatch"));
    }
    Ok((destination.to_owned(), identity))
}
pub(super) struct Lock {
    file: File,
    path: PathBuf,
    identity: Identity,
}
pub(super) fn acquire_lock(runtime: &Path, hooks: &mut dyn HookV1) -> Result<Lock> {
    let parent = runtime
        .parent()
        .ok_or_else(|| error("release_integrity_runtime_root_unsafe"))?;
    let name = runtime
        .file_name()
        .ok_or_else(|| error("release_integrity_runtime_root_unsafe"))?
        .to_string_lossy();
    let path = parent.join(format!(".{name}.release-integrity-key-provision.lock"));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                error("release_integrity_key_provision_locked")
            } else {
                io_error(e, "open", &path)
            }
        })?;
    let metadata = file.metadata().map_err(|e| io_error(e, "fstat", &path))?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(error("release_integrity_key_lock_unsafe"));
    }
    let identity = Identity::of(&metadata);
    if let Err(err) = file.sync_all() {
        drop(file);
        if !remove_exact(&path, identity, hooks) {
            return Err(error(format!(
                "release_integrity_key_lock_rollback_incomplete:{}",
                io_error(err, "fsync", &path)
            )));
        }
        return Err(io_error(err, "fsync", &path));
    }
    Ok(Lock {
        file,
        path,
        identity,
    })
}
pub(super) fn release_lock(lock: Lock, hooks: &mut dyn HookV1) -> bool {
    drop(lock.file);
    remove_exact(&lock.path, lock.identity, hooks)
}

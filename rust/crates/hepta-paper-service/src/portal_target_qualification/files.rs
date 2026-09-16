//! Descriptor-relative reads and durable, exclusive atomic local publication.
use super::{Document, Result, error};
use nix::{
    fcntl::{OFlag, RenameFlags, open, openat, renameat2},
    sys::stat::{Mode, mkdirat},
    unistd::{UnlinkatFlags, unlinkat},
};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::{self, File, Metadata},
    io::{Read, Write},
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
type Anchors = Vec<(PathBuf, Metadata)>;
fn identity(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino() && a.file_type() == b.file_type()
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    identity(a, b)
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
pub(super) fn normalize(path: Option<&Path>) -> Result<PathBuf> {
    let path = path.unwrap_or(Path::new(""));
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|_| error("portal_target_qualification_file_invalid"))?
            .join(path)
    };
    let mut selected = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::ParentDir => {
                selected.pop();
            }
            Component::CurDir => {}
            other => selected.push(other.as_os_str()),
        }
    }
    Ok(selected)
}
fn anchored_directory(path: &Path, create: bool) -> Result<(File, Anchors)> {
    let mut file = File::from(
        open(
            Path::new("/"),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| error("portal_target_qualification_file_invalid"))?,
    );
    let mut cursor = PathBuf::from("/");
    let mut anchors = vec![(
        cursor.clone(),
        file.metadata()
            .map_err(|_| error("portal_target_qualification_file_invalid"))?,
    )];
    for part in path.components() {
        let Component::Normal(part) = part else {
            continue;
        };
        let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let fd = match openat(file.as_fd(), Path::new(part), flags, Mode::empty()) {
            Ok(fd) => fd,
            Err(nix::errno::Errno::ENOENT) if create => {
                match mkdirat(
                    file.as_fd(),
                    Path::new(part),
                    Mode::from_bits_truncate(0o700),
                ) {
                    Ok(()) | Err(nix::errno::Errno::EEXIST) => {}
                    Err(_) => {
                        return Err(error("portal_target_qualification_registry_parent_invalid"));
                    }
                }
                openat(file.as_fd(), Path::new(part), flags, Mode::empty())
                    .map_err(|_| error("portal_target_qualification_registry_parent_invalid"))?
            }
            Err(_) => return Err(error("portal_target_qualification_file_invalid")),
        };
        file = File::from(fd);
        cursor.push(part);
        anchors.push((
            cursor.clone(),
            file.metadata()
                .map_err(|_| error("portal_target_qualification_file_invalid"))?,
        ));
    }
    Ok((file, anchors))
}
fn check_anchors(anchors: &Anchors) -> Result<()> {
    for (path, before) in anchors {
        let after = fs::symlink_metadata(path)
            .map_err(|_| error("portal_target_qualification_file_changed"))?;
        if !identity(before, &after) || after.is_symlink() {
            return Err(error("portal_target_qualification_file_changed"));
        }
    }
    Ok(())
}
pub(super) struct Snapshot {
    pub path: PathBuf,
    pub file_hash: String,
    pub document: Document,
    metadata: Metadata,
    anchors: Anchors,
}
impl Snapshot {
    pub fn assert_current(&self) -> Result<()> {
        check_anchors(&self.anchors)?;
        let after = fs::symlink_metadata(&self.path)
            .map_err(|_| error("portal_target_qualification_file_changed"))?;
        if !same(&self.metadata, &after) {
            return Err(error("portal_target_qualification_file_changed"));
        }
        Ok(())
    }
}
pub(super) fn read(path: Option<&Path>, expected: Option<&str>, code: &str) -> Result<Snapshot> {
    let selected = normalize(path)?;
    if !selected.exists() {
        return Err(error(format!("{code}:missing")));
    }
    let perform = || -> Result<Snapshot> {
        let parent = selected.parent().ok_or_else(|| error(code))?;
        let (directory, anchors) = anchored_directory(parent, false)?;
        let name = selected.file_name().ok_or_else(|| error(code))?;
        let fd = openat(
            directory.as_fd(),
            Path::new(name),
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| error(code))?;
        let mut file = File::from(fd);
        let before = file.metadata().map_err(|_| error(code))?;
        let uid = nix::unistd::getuid().as_raw();
        if !before.is_file()
            || before.nlink() != 1
            || !(2..=4 * 1024 * 1024).contains(&before.len())
            || before.mode() & 0o022 != 0
            || (before.uid() != 0 && before.uid() != uid)
        {
            return Err(error(code));
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| error(code))?;
        if before.len() != bytes.len() as u64
            || !same(&before, &file.metadata().map_err(|_| error(code))?)
        {
            return Err(error(code));
        }
        let file_hash = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
        if expected.is_some_and(|pin| pin != file_hash) {
            return Err(error(code));
        }
        let document = Document::parse(&bytes)?;
        let snapshot = Snapshot {
            path: selected.clone(),
            file_hash,
            document,
            metadata: before,
            anchors,
        };
        snapshot.assert_current()?;
        Ok(snapshot)
    };
    perform().map_err(|_| error(code))
}
pub(super) fn read_optional(path: &Path, code: &str) -> Result<Option<Snapshot>> {
    if !path.exists() {
        return Ok(None);
    }
    read(Some(path), None, code).map(Some)
}
fn at_metadata(directory: &File, name: &OsStr) -> Result<Metadata> {
    let fd = openat(
        directory.as_fd(),
        Path::new(name),
        OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| error("portal_target_qualification_file_changed"))?;
    File::from(fd)
        .metadata()
        .map_err(|_| error("portal_target_qualification_file_changed"))
}
fn unlink(directory: &File, name: &OsStr) -> Result<()> {
    unlinkat(
        directory.as_fd(),
        Path::new(name),
        UnlinkatFlags::NoRemoveDir,
    )
    .map_err(|_| error("portal_target_qualification_registry_write_failed"))
}
fn rename(directory: &File, from: &OsStr, to: &OsStr, flags: RenameFlags) -> Result<()> {
    renameat2(
        directory.as_fd(),
        Path::new(from),
        directory.as_fd(),
        Path::new(to),
        flags,
    )
    .map_err(|_| error("portal_target_qualification_registry_write_conflict"))
}
pub(super) struct RegistryLock {
    directory: File,
    anchors: Anchors,
    name: std::ffi::OsString,
    lock_name: std::ffi::OsString,
    lock_metadata: Metadata,
}
impl RegistryLock {
    pub fn acquire(path: &Path, plan: &str) -> Result<Self> {
        let parent = path
            .parent()
            .ok_or_else(|| error("portal_target_qualification_registry_parent_invalid"))?;
        let (directory, anchors) = anchored_directory(parent, true)
            .map_err(|_| error("portal_target_qualification_registry_parent_invalid"))?;
        let metadata = directory
            .metadata()
            .map_err(|_| error("portal_target_qualification_registry_parent_invalid"))?;
        let uid = nix::unistd::getuid().as_raw();
        if metadata.mode() & 0o022 != 0 || (metadata.uid() != 0 && metadata.uid() != uid) {
            return Err(error("portal_target_qualification_registry_parent_invalid"));
        }
        check_anchors(&anchors)?;
        let name = path
            .file_name()
            .ok_or_else(|| error("portal_target_qualification_registry_parent_invalid"))?
            .to_owned();
        let mut lock_name = name.clone();
        lock_name.push(".lock");
        let fd = openat(
            directory.as_fd(),
            Path::new(&lock_name),
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| error("portal_target_qualification_registry_locked"))?;
        let mut file = File::from(fd);
        let lock_metadata = file
            .metadata()
            .map_err(|_| error("portal_target_qualification_registry_write_failed"))?;
        let lock = Self {
            directory,
            anchors,
            name,
            lock_name,
            lock_metadata,
        };
        writeln!(file, "{plan}")
            .and_then(|_| file.sync_all())
            .map_err(|_| error("portal_target_qualification_registry_write_failed"))?;
        lock.assert_current()?;
        Ok(lock)
    }
    pub fn assert_current(&self) -> Result<()> {
        check_anchors(&self.anchors)?;
        let stat = self
            .directory
            .metadata()
            .map_err(|_| error("portal_target_qualification_registry_parent_invalid"))?;
        if stat.mode() & 0o022 != 0 {
            return Err(error("portal_target_qualification_registry_parent_invalid"));
        }
        if !identity(
            &self.lock_metadata,
            &at_metadata(&self.directory, &self.lock_name)?,
        ) {
            return Err(error("portal_target_qualification_registry_lock_changed"));
        }
        Ok(())
    }
    pub fn publish<'a>(
        &'a self,
        bytes: &[u8],
        prior: Option<&Snapshot>,
    ) -> Result<Publication<'a>> {
        self.assert_current()?;
        let temporary = std::ffi::OsString::from(format!(
            ".{}.{}.{}.tmp",
            self.name.to_string_lossy(),
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let fd = openat(
            self.directory.as_fd(),
            Path::new(&temporary),
            OFlag::O_RDWR | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|_| error("portal_target_qualification_registry_write_failed"))?;
        let mut file = File::from(fd);
        let result = (|| -> Result<Publication<'a>> {
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| error("portal_target_qualification_registry_write_failed"))?;
            let metadata = file
                .metadata()
                .map_err(|_| error("portal_target_qualification_registry_write_failed"))?;
            self.assert_current()?;
            if let Some(prior) = prior {
                prior.assert_current()?;
            }
            // NOREPLACE protects a previously absent destination. EXCHANGE retains
            // the prior inode for exact rollback and detects uncoordinated replacement.
            rename(
                &self.directory,
                &temporary,
                &self.name,
                if prior.is_some() {
                    RenameFlags::RENAME_EXCHANGE
                } else {
                    RenameFlags::RENAME_NOREPLACE
                },
            )?;
            let publication = Publication {
                lock: self,
                temporary: temporary.clone(),
                metadata,
                had_prior: prior.is_some(),
                finished: false,
            };
            if let Some(prior) = prior {
                let displaced = at_metadata(&self.directory, &temporary)?;
                // rename changes ctime, so compare identity plus content timestamps.
                if !identity(&prior.metadata, &displaced)
                    || prior.metadata.len() != displaced.len()
                    || prior.metadata.mtime() != displaced.mtime()
                    || prior.metadata.mtime_nsec() != displaced.mtime_nsec()
                {
                    publication.rollback()?;
                    return Err(error("portal_target_qualification_plan_stale"));
                }
            }
            if self.directory.sync_all().is_err() {
                publication.rollback()?;
                return Err(error("portal_target_qualification_registry_write_failed"));
            }
            Ok(publication)
        })();
        if result.is_err()
            && file
                .metadata()
                .ok()
                .zip(at_metadata(&self.directory, &temporary).ok())
                .is_some_and(|(ours, remaining)| identity(&ours, &remaining))
        {
            // A failed rollback may leave the displaced original at this name.
            // Remove only our unpublished inode, never the retained prior data.
            let _ = unlink(&self.directory, &temporary);
        }
        result
    }
}
impl Drop for RegistryLock {
    fn drop(&mut self) {
        if at_metadata(&self.directory, &self.lock_name)
            .is_ok_and(|m| identity(&m, &self.lock_metadata))
        {
            let _ = unlink(&self.directory, &self.lock_name);
            let _ = self.directory.sync_all();
        }
    }
}
pub(super) struct Publication<'a> {
    lock: &'a RegistryLock,
    temporary: std::ffi::OsString,
    metadata: Metadata,
    had_prior: bool,
    finished: bool,
}
impl Publication<'_> {
    fn ours(&self) -> Result<()> {
        let metadata = at_metadata(&self.lock.directory, &self.lock.name)?;
        if !identity(&metadata, &self.metadata)
            || metadata.len() != self.metadata.len()
            || metadata.mtime() != self.metadata.mtime()
            || metadata.mtime_nsec() != self.metadata.mtime_nsec()
        {
            return Err(error("portal_target_qualification_registry_write_conflict"));
        }
        Ok(())
    }
    pub fn commit(mut self) -> Result<()> {
        self.ours()?;
        if self.had_prior {
            unlink(&self.lock.directory, &self.temporary)?;
        }
        self.lock
            .directory
            .sync_all()
            .map_err(|_| error("portal_target_qualification_registry_write_failed"))?;
        self.finished = true;
        Ok(())
    }
    pub fn rollback(mut self) -> Result<()> {
        self.restore()?;
        self.finished = true;
        Ok(())
    }
    fn restore(&self) -> Result<()> {
        self.ours()?;
        if self.had_prior {
            rename(
                &self.lock.directory,
                &self.temporary,
                &self.lock.name,
                RenameFlags::RENAME_EXCHANGE,
            )?;
            unlink(&self.lock.directory, &self.temporary)?;
        } else {
            unlink(&self.lock.directory, &self.lock.name)?;
        }
        self.lock
            .directory
            .sync_all()
            .map_err(|_| error("portal_target_qualification_registry_write_failed"))
    }
}
impl Drop for Publication<'_> {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.restore();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "hepta-portal-atomic-unit-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            Self(root)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn private(path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    #[test]
    fn unpublished_and_replaced_registries_roll_back_on_scope_exit() {
        let root = Temp::new();
        let registry = root.0.join("registry.json");
        let lock = RegistryLock::acquire(&registry, "test-only-plan").unwrap();
        let publication = lock.publish(b"{\"new\":true}", None).unwrap();
        assert!(registry.exists());
        drop(publication);
        assert!(!registry.exists());
        private(&registry, b"{\"old\":true}");
        let before = read(Some(&registry), None, "fixture").unwrap();
        let publication = lock.publish(b"{\"new\":true}", Some(&before)).unwrap();
        assert_eq!(fs::read(&registry).unwrap(), b"{\"new\":true}");
        drop(publication);
        assert_eq!(fs::read(&registry).unwrap(), b"{\"old\":true}");
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 2);
        drop(lock);
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
    }
    #[test]
    fn destination_and_parent_replacement_are_detected_without_clobber() {
        let root = Temp::new();
        let parent = root.0.join("parent");
        fs::create_dir(&parent).unwrap();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        let registry = parent.join("registry.json");
        let lock = RegistryLock::acquire(&registry, "test-only-plan").unwrap();
        private(&registry, b"{\"unrelated\":true}");
        assert!(lock.publish(b"{}", None).is_err());
        assert_eq!(fs::read(&registry).unwrap(), b"{\"unrelated\":true}");
        let before = read(Some(&registry), None, "fixture").unwrap();
        let different = parent.join("different");
        private(&different, b"{\"replacement\":true}");
        fs::rename(&different, &registry).unwrap();
        assert!(lock.publish(b"{}", Some(&before)).is_err());
        assert_eq!(fs::read(&registry).unwrap(), b"{\"replacement\":true}");
        fs::rename(&parent, root.0.join("old-parent")).unwrap();
        fs::create_dir(&parent).unwrap();
        private(&registry, b"{\"outside\":true}");
        assert!(lock.publish(b"{}", None).is_err());
        assert_eq!(fs::read(&registry).unwrap(), b"{\"outside\":true}");
    }
    #[test]
    fn rollback_preserves_uncoordinated_new_writer_and_prior_backup() {
        let root = Temp::new();
        let registry = root.0.join("registry.json");
        private(&registry, b"{\"original\":true}");
        let before = read(Some(&registry), None, "fixture").unwrap();
        let lock = RegistryLock::acquire(&registry, "test-only-plan").unwrap();
        let publication = lock.publish(b"{\"ours\":true}", Some(&before)).unwrap();
        let replacement = root.0.join("replacement");
        private(&replacement, b"{\"other\":true}");
        fs::rename(&replacement, &registry).unwrap();
        assert!(publication.rollback().is_err());
        assert_eq!(fs::read(&registry).unwrap(), b"{\"other\":true}");
        assert!(fs::read_dir(&root.0).unwrap().any(|entry| {
            let path = entry.unwrap().path();
            path.extension().is_some_and(|e| e == "tmp")
                && fs::read(path).unwrap() == b"{\"original\":true}"
        }));
    }
    #[test]
    fn abrupt_process_exit_preserves_complete_publication_and_recovery_evidence() {
        const CHILD_ROOT: &str = "HEPTA_TEST_ONLY_PORTAL_ATOMIC_CRASH_ROOT";
        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            let registry = PathBuf::from(root).join("registry.json");
            let before = read(Some(&registry), None, "fixture").unwrap();
            let lock = RegistryLock::acquire(&registry, "test-only-crash-plan").unwrap();
            let _publication = lock.publish(b"{\"new\":true}", Some(&before)).unwrap();
            // Deliberately bypass all destructors in this isolated test process.
            std::process::exit(77);
        }
        let root = Temp::new();
        let registry = root.0.join("registry.json");
        private(&registry, b"{\"old\":true}");
        let output=std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact","portal_target_qualification::files::tests::abrupt_process_exit_preserves_complete_publication_and_recovery_evidence"])
            .env(CHILD_ROOT,&root.0).output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(77),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(&registry).unwrap(), b"{\"new\":true}");
        assert!(RegistryLock::acquire(&registry, "next-plan").is_err());
        assert_eq!(
            fs::read_to_string(root.0.join("registry.json.lock")).unwrap(),
            "test-only-crash-plan\n"
        );
        assert!(fs::read_dir(&root.0).unwrap().any(|entry| {
            let path = entry.unwrap().path();
            path.extension().is_some_and(|extension| extension == "tmp")
                && fs::read(path).unwrap() == b"{\"old\":true}"
        }));
    }
}

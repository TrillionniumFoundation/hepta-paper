use super::*;
#[cfg(test)]
mod tests;
use nix::{
    errno::Errno,
    fcntl::{AtFlags, OFlag, RenameFlags, openat, renameat2},
    sys::stat::{Mode, fchmod, mkdirat},
    unistd::{UnlinkatFlags, linkat, unlinkat},
};
use std::{
    fs::{self, File, Metadata},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{FileExt, MetadataExt},
    },
    path::{Component, PathBuf},
};
pub(super) fn same(a: &Metadata, b: &Metadata) -> bool {
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
fn name(s: &str) -> Result<&Path> {
    if s.is_empty() || s == "." || s == ".." || s.contains(['/', '\\', '\0']) {
        return Err(failure("path_invalid"));
    }
    Ok(Path::new(s))
}
pub(super) struct FileEntry {
    pub file: File,
    pub metadata: Metadata,
    pub bytes: Vec<u8>,
}
impl FileEntry {
    /// Transaction-only retained observation. Unlike opening a name again,
    /// this cannot close a descriptor belonging to a substituted SQLite file.
    /// Directory traversal and named lstat never open the named regular file.
    pub(super) fn assert_retained_bytes(&self, dir: &Directory, entry: &str) -> Result<()> {
        let entry = name(entry)?;
        dir.assert_current()?;
        for after_read in [false, true] {
            let named = fs::symlink_metadata(
                PathBuf::from(format!("/proc/self/fd/{}", dir.held.as_raw_fd())).join(entry),
            )
            .map_err(|_| failure("target_changed"))?;
            if !named.is_file()
                || named.is_symlink()
                || !same(&self.metadata, &named)
                || !same(
                    &self.metadata,
                    &self
                        .file
                        .metadata()
                        .map_err(|_| failure("target_changed"))?,
                )
            {
                return Err(failure("target_changed"));
            }
            if !after_read {
                if self.metadata.len() > MAXIMUM_BYTES
                    || self.bytes.len() as u64 != self.metadata.len()
                {
                    return Err(failure("size_invalid"));
                }
                let mut buffer = [0u8; 64 * 1024];
                for (index, expected) in self.bytes.chunks(buffer.len()).enumerate() {
                    let bytes = &mut buffer[..expected.len()];
                    self.file
                        .read_exact_at(bytes, (index * 64 * 1024) as u64)
                        .map_err(|_| failure("target_changed"))?;
                    if bytes != expected {
                        return Err(failure("target_changed"));
                    }
                }
            }
        }
        dir.assert_current()
    }
    pub fn same(&self, other: &Self) -> bool {
        same(&self.metadata, &other.metadata) && self.bytes == other.bytes
    }
    pub fn json(&self) -> Result<Value> {
        crate::sqlite_mutation_coordinator::authority::files::parse(
            &self.bytes,
            "autonomous_research_online_authority_evidence_cache_json_invalid",
        )
        .map_err(|_| failure("json_invalid"))
    }
    pub fn assert_current(&self, dir: &Directory, entry: &str) -> Result<()> {
        let named = dir.stat(entry)?.ok_or_else(|| failure("target_changed"))?;
        if !same(&self.metadata, &named)
            || !same(
                &self.metadata,
                &self
                    .file
                    .metadata()
                    .map_err(|_| failure("target_changed"))?,
            )
        {
            return Err(failure("target_changed"));
        }
        Ok(())
    }
}
pub(super) struct Directory {
    held: File,
    path: PathBuf,
    parents: Vec<(PathBuf, File)>,
}
/// Additional exact parent identity pins for the transaction-retained path.
/// No descriptors are cloned; the actual Directory continues to own them.
type ParentIdentity = (u64, u64, u32, u32, u32);
pub(super) struct RetainedParentIdentities {
    identities: Vec<(PathBuf, ParentIdentity)>,
}
fn parent_identity(metadata: &Metadata) -> ParentIdentity {
    (
        metadata.dev(),
        metadata.ino(),
        metadata.mode(),
        metadata.uid(),
        metadata.gid(),
    )
}
impl RetainedParentIdentities {
    pub(super) fn assert_current(&self, directory: &Directory) -> Result<()> {
        if self.identities.len() != directory.parents.len() + 1 {
            return Err(failure("parent_changed"));
        }
        for ((path, held), (expected_path, expected)) in directory
            .parents
            .iter()
            .map(|(path, file)| (path, file))
            .chain(std::iter::once((&directory.path, &directory.held)))
            .zip(&self.identities)
        {
            let named = fs::symlink_metadata(path).map_err(|_| failure("parent_changed"))?;
            let held = held.metadata().map_err(|_| failure("parent_changed"))?;
            if path != expected_path
                || !named.is_dir()
                || named.is_symlink()
                || parent_identity(&named) != *expected
                || parent_identity(&held) != *expected
            {
                return Err(failure("parent_changed"));
            }
        }
        Ok(())
    }
}
struct PendingCreatedEntry<'a> {
    directory: &'a Directory,
    name: &'a str,
    file: Option<FileEntry>,
}
impl Drop for PendingCreatedEntry<'_> {
    fn drop(&mut self) {
        if let Some(file) = &self.file {
            self.directory.remove_owned(self.name, file);
        }
    }
}
impl Directory {
    pub(super) fn retain_parent_identities(&self) -> Result<RetainedParentIdentities> {
        self.assert_current()?;
        let identities = self
            .parents
            .iter()
            .map(|(path, file)| (path, file))
            .chain(std::iter::once((&self.path, &self.held)))
            .map(|(path, file)| {
                Ok((
                    path.clone(),
                    parent_identity(&file.metadata().map_err(|_| failure("parent_changed"))?),
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        let retained = RetainedParentIdentities { identities };
        retained.assert_current(self)?;
        Ok(retained)
    }
    pub fn open(root: &Path, create: bool) -> Result<Self> {
        if !root.is_absolute()
            || root
                .components()
                .any(|p| !matches!(p, Component::RootDir | Component::Normal(_)))
        {
            return Err(failure("path_invalid"));
        }
        let mut held = File::open("/").map_err(|_| failure("path_invalid"))?;
        let mut path = PathBuf::from("/");
        let mut parents = Vec::new();
        let components: Vec<_> = root
            .components()
            .filter_map(|p| {
                if let Component::Normal(n) = p {
                    Some((n.to_owned(), false))
                } else {
                    None
                }
            })
            .chain([
                ("automation-cache".into(), true),
                ("online-authority-evidence-v1".into(), true),
            ])
            .collect();
        for (part, cache) in components {
            let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
            let child = match openat(&held, Path::new(&part), flags, Mode::empty()) {
                Ok(fd) => File::from(fd),
                Err(Errno::ENOENT) if create && cache => {
                    match mkdirat(&held, Path::new(&part), Mode::from_bits_truncate(0o700)) {
                        Ok(()) | Err(Errno::EEXIST) => (),
                        Err(_) => return Err(failure("parent_unsafe")),
                    };
                    File::from(
                        openat(&held, Path::new(&part), flags, Mode::empty())
                            .map_err(|_| failure("parent_unsafe"))?,
                    )
                }
                Err(_) => return Err(failure("parent_unsafe")),
            };
            if cache
                && child
                    .metadata()
                    .map_err(|_| failure("parent_unsafe"))?
                    .mode()
                    & 0o022
                    != 0
            {
                return Err(failure("parent_unsafe"));
            }
            parents.push((path.clone(), held));
            path.push(part);
            held = child;
        }
        let dir = Self {
            held,
            path,
            parents,
        };
        dir.assert_current()?;
        Ok(dir)
    }
    pub fn assert_current(&self) -> Result<()> {
        self.check_parents()
    }
    fn check_parents(&self) -> Result<()> {
        for (path, held) in &self.parents {
            Self::check_dir(path, held)?;
        }
        Self::check_dir(&self.path, &self.held)?;
        if self
            .held
            .metadata()
            .map_err(|_| failure("parent_unsafe"))?
            .mode()
            & 0o022
            != 0
        {
            return Err(failure("parent_unsafe"));
        }
        Ok(())
    }
    fn check_dir(path: &Path, held: &File) -> Result<()> {
        let named = fs::symlink_metadata(path).map_err(|_| failure("parent_changed"))?;
        let m = held.metadata().map_err(|_| failure("parent_changed"))?;
        if !named.is_dir() || named.is_symlink() || named.dev() != m.dev() || named.ino() != m.ino()
        {
            return Err(failure("parent_changed"));
        }
        Ok(())
    }
    pub fn stat(&self, entry: &str) -> Result<Option<Metadata>> {
        // Inspection and all namespace mutations must use the same held
        // directory. A raw path may have been rebound during error cleanup.
        // O_PATH does not open FIFOs/devices for I/O and O_NOFOLLOW exposes a
        // symlink's own metadata instead of its target's metadata.
        match openat(
            &self.held,
            name(entry)?,
            OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => File::from(fd)
                .metadata()
                .map(Some)
                .map_err(|_| failure("file_unsafe")),
            Err(Errno::ENOENT) => Ok(None),
            Err(_) => Err(failure("file_unsafe")),
        }
    }
    /// Fresh directory description per enumeration: cloning the held descriptor
    /// would share its seek offset and could hide entries on the next pass.
    pub fn entries(&self, max: usize) -> Result<Vec<String>> {
        if max > 4096 {
            return Err(failure("entry_limit_exceeded"));
        }
        self.assert_current()?;
        let mut directory = nix::dir::Dir::openat(
            &self.held,
            Path::new("."),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| failure("parent_unsafe"))?;
        let mut entries = Vec::new();
        for entry in directory.iter() {
            let entry = entry.map_err(|_| failure("parent_unsafe"))?;
            let name = entry
                .file_name()
                .to_str()
                .map_err(|_| failure("filename_utf8_invalid"))?;
            if matches!(name, "." | "..") {
                continue;
            }
            if entries.len() >= max {
                return Err(failure("entry_limit_exceeded"));
            }
            entries.push(name.to_owned());
        }
        self.assert_current()?;
        entries.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        Ok(entries)
    }
    pub fn read(&self, entry: &str, max: u64, mode: u32, links: u64) -> Result<Option<FileEntry>> {
        self.read_with_minimum(entry, max, mode, links, 2)
    }
    /// Read only a one-link stage in its writable or sealed intermediate mode.
    /// The lock owner must separately prove the exact stage inode before cleanup.
    pub fn read_stage_for_cleanup(&self, entry: &str) -> Result<Option<FileEntry>> {
        self.assert_current()?;
        let file = match openat(
            &self.held,
            name(entry)?,
            OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => File::from(fd),
            Err(Errno::ENOENT) => return Ok(None),
            Err(_) => return Err(failure("file_unsafe")),
        };
        let metadata = file.metadata().map_err(|_| failure("file_unsafe"))?;
        let mode = metadata.mode() & 0o777;
        let uid = nix::unistd::getuid().as_raw();
        if !metadata.is_file()
            || metadata.nlink() != 1
            || !matches!(mode, 0o400 | 0o600)
            || (metadata.uid() != uid && metadata.uid() != 0)
            || metadata.len() > MAXIMUM_BYTES
        {
            return Err(failure("file_unsafe"));
        }
        // Reclamation only needs identity. Do not read a body for every orphan
        // in a bounded directory scan: 4096 maximum-sized stages are 16 GiB.
        let observed = FileEntry {
            file,
            metadata,
            bytes: Vec::new(),
        };
        observed.assert_current(self, entry)?;
        self.assert_current()?;
        Ok(Some(observed))
    }
    fn read_with_minimum(
        &self,
        entry: &str,
        max: u64,
        mode: u32,
        links: u64,
        minimum: u64,
    ) -> Result<Option<FileEntry>> {
        if max > MAXIMUM_BYTES || minimum > max {
            return Err(failure("size_invalid"));
        }
        self.assert_current()?;
        let mut file = match openat(
            &self.held,
            name(entry)?,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => File::from(fd),
            Err(Errno::ENOENT) => return Ok(None),
            Err(_) => return Err(failure("file_unsafe")),
        };
        let metadata = file.metadata().map_err(|_| failure("file_unsafe"))?;
        let uid = nix::unistd::getuid().as_raw();
        if !metadata.is_file()
            || metadata.nlink() != links
            || metadata.mode() & 0o777 != mode
            || (metadata.uid() != uid && metadata.uid() != 0)
            || metadata.len() < minimum
            || metadata.len() > max
        {
            return Err(failure("file_unsafe"));
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(max + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| failure("file_unsafe"))?;
        if bytes.len() as u64 != metadata.len() {
            return Err(failure("target_changed"));
        }
        let observed = FileEntry {
            file,
            metadata,
            bytes,
        };
        observed.assert_current(self, entry)?;
        self.assert_current()?;
        Ok(Some(observed))
    }
    pub fn create(&self, entry: &str, bytes: &[u8], mode: u32) -> Result<FileEntry> {
        self.create_with_before_write(entry, bytes, mode, |_| Ok(()))
    }
    /// Bind a newly-created stage to its lock before any body write, so a v5
    /// crash record can identify an empty or partly written 0600 stage.
    pub fn create_with_before_write(
        &self,
        entry: &str,
        bytes: &[u8],
        mode: u32,
        before_write: impl FnOnce(&FileEntry) -> Result<()>,
    ) -> Result<FileEntry> {
        self.assert_current()?;
        let file = File::from(
            openat(
                &self.held,
                name(entry)?,
                OFlag::O_RDWR
                    | OFlag::O_CREAT
                    | OFlag::O_EXCL
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| failure("destination_locked"))?,
        );
        let created = FileEntry {
            metadata: file.metadata().map_err(|_| failure("file_unsafe"))?,
            file,
            bytes: bytes.to_vec(),
        };
        let mut pending = PendingCreatedEntry {
            directory: self,
            name: entry,
            file: Some(created),
        };
        {
            let created = pending
                .file
                .as_mut()
                .ok_or_else(|| failure("file_unsafe"))?;
            before_write(created)?;
            created
                .file
                .write_all(bytes)
                .map_err(|_| failure("write_failed"))?;
            fchmod(&created.file, Mode::from_bits_truncate(mode))
                .map_err(|_| failure("write_failed"))?;
            // Persist both the complete body and final mode, not just the
            // preceding writable intermediate state.
            created
                .file
                .sync_all()
                .map_err(|_| failure("write_failed"))?;
            created.metadata = created
                .file
                .metadata()
                .map_err(|_| failure("file_unsafe"))?;
            created.assert_current(self, entry)?;
            self.assert_current()?;
        }
        pending.file.take().ok_or_else(|| failure("file_unsafe"))
    }
    pub fn link(&self, old: &str, new: &str) -> Result<()> {
        linkat(
            &self.held,
            name(old)?,
            &self.held,
            name(new)?,
            AtFlags::empty(),
        )
        .map_err(|_| failure("destination_locked"))?;
        self.sync()
    }
    pub fn replace(&self, old: &str, new: &str) -> Result<()> {
        renameat2(
            &self.held,
            name(old)?,
            &self.held,
            name(new)?,
            RenameFlags::empty(),
        )
        .map_err(|_| failure("write_failed"))?;
        self.sync()
    }
    pub fn sync(&self) -> Result<()> {
        self.held.sync_all().map_err(|_| failure("write_failed"))
    }
    pub fn remove_owned(&self, entry: &str, owned: &FileEntry) {
        if let Ok(Some(m)) = self.stat(entry)
            && m.is_file()
            && !m.is_symlink()
            && m.dev() == owned.metadata.dev()
            && m.ino() == owned.metadata.ino()
            && let Ok(path) = name(entry)
        {
            let _ = unlinkat(&self.held, path, UnlinkatFlags::NoRemoveDir);
        }
    }
}

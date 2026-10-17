//! Mutable temporary database images. Ownership is by held inode, not just name;
//! cleanup never removes a replacement or recursively walks an untrusted tree.
use super::*;
use nix::{
    fcntl::{OFlag, openat},
    sys::stat::{Mode, mkdirat},
    unistd::{UnlinkatFlags, unlinkat},
};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    os::unix::fs::{FileExt, MetadataExt},
};

pub(super) struct MutableCopy {
    ancestors: Vec<files::Directory>,
    directory: files::Directory,
    name: String,
    files: Vec<(String, File)>,
}
impl MutableCopy {
    pub(super) fn create(source: &files::DatabaseObservation) -> Result<Self> {
        source.assert_current()?;
        let (_, ancestors) = files::open_root(&std::env::temp_dir())?;
        let parent = ancestors.last().ok_or_else(files::changed)?;
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| files::changed())?;
        let name = format!(
            "hepta-schema-projection-{}-{}",
            std::process::id(),
            hex::encode(random)
        );
        mkdirat(
            &parent.held,
            Path::new(&name),
            Mode::from_bits_truncate(0o700),
        )
        .map_err(|_| files::changed())?;
        let directory = parent.child_directory(std::ffi::OsStr::new(&name))?;
        let mut result = Self {
            ancestors,
            directory,
            name,
            files: Vec::new(),
        };
        for (name, origin) in [
            ("candidate.sqlite", Some(&source.source)),
            ("candidate.sqlite-wal", source.wal.as_ref()),
        ] {
            if let Some(origin) = origin {
                let target = result.create_file(name)?;
                origin.copy_to(target)?;
                ensure(
                    hash_file(target)? == origin.sha256,
                    "autonomous_research_online_schema_transition_private_copy_mismatch",
                )?;
            }
        }
        if source.wal.is_some() {
            // Do not copy the source SHM. Own an empty inode before SQLite
            // rebuilds this disposable coordination file from the copied WAL.
            result.create_file("candidate.sqlite-shm")?;
        }
        source.assert_current()?;
        result.assert_owned()?;
        Ok(result)
    }
    fn create_file(&mut self, name: &str) -> Result<&File> {
        let file = File::from(
            openat(
                &self.directory.held,
                Path::new(name),
                OFlag::O_RDWR
                    | OFlag::O_CREAT
                    | OFlag::O_EXCL
                    | OFlag::O_CLOEXEC
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_NONBLOCK,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|_| files::changed())?,
        );
        self.files.push((name.into(), file));
        self.files
            .last()
            .map(|(_, file)| file)
            .ok_or_else(files::changed)
    }
    pub(super) fn path(&self) -> PathBuf {
        self.directory.path.join("candidate.sqlite")
    }
    pub(super) fn has_wal(&self) -> Result<bool> {
        present(&self.directory.path.join("candidate.sqlite-wal"))
    }
    pub(super) fn assert_no_sidecars(&self) -> Result<()> {
        for name in [
            "candidate.sqlite-wal",
            "candidate.sqlite-shm",
            "candidate.sqlite-journal",
        ] {
            ensure(
                !present(&self.directory.path.join(name))?,
                "autonomous_research_online_schema_transition_wal_or_shm_present",
            )?;
        }
        Ok(())
    }
    pub(super) fn assert_owned(&self) -> Result<()> {
        for ancestor in &self.ancestors {
            ancestor.assert_current()?;
        }
        self.directory.assert_current()?;
        for (name, file) in &self.files {
            let path = self.directory.path.join(name);
            let named = match std::fs::symlink_metadata(path) {
                Ok(named) => named,
                Err(e)
                    if e.kind() == std::io::ErrorKind::NotFound && name != "candidate.sqlite" =>
                {
                    continue;
                }
                Err(_) => return Err(files::changed()),
            };
            let held = file.metadata().map_err(|_| files::changed())?;
            ensure(
                named.is_file()
                    && !named.file_type().is_symlink()
                    && named.nlink() == 1
                    && named.mode() & 0o077 == 0
                    && named.dev() == held.dev()
                    && named.ino() == held.ino(),
                "autonomous_research_online_schema_transition_private_copy_changed",
            )?;
        }
        for entry in std::fs::read_dir(self.directory.fd_path()).map_err(|_| files::changed())? {
            let entry = entry.map_err(|_| files::changed())?;
            ensure(
                self.files
                    .iter()
                    .any(|(name, _)| entry.file_name() == std::ffi::OsStr::new(name)),
                "autonomous_research_online_schema_transition_private_copy_changed",
            )?;
        }
        Ok(())
    }
    pub(super) fn sha256(&self) -> Result<String> {
        self.assert_owned()?;
        let file = &self
            .files
            .iter()
            .find(|(name, _)| name == "candidate.sqlite")
            .ok_or_else(files::changed)?
            .1;
        hash_file(file)
    }
}
fn present(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(files::changed()),
    }
}
fn hash_file(file: &File) -> Result<String> {
    let before = files::identity(&file.metadata().map_err(|_| files::changed())?);
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut offset = 0u64;
    loop {
        let count = file
            .read_at(&mut buffer, offset)
            .map_err(|_| files::changed())?;
        if count == 0 {
            break;
        }
        offset = offset
            .checked_add(count as u64)
            .ok_or_else(files::changed)?;
        ensure(
            offset <= files::MAX_FILE_BYTES,
            "autonomous_research_online_schema_transition_private_copy_limit",
        )?;
        digest.update(&buffer[..count]);
    }
    ensure(
        before == files::identity(&file.metadata().map_err(|_| files::changed())?),
        "autonomous_research_online_schema_transition_private_copy_changed",
    )?;
    Ok(format!("sha256:{}", hex::encode(digest.finalize())))
}
impl Drop for MutableCopy {
    fn drop(&mut self) {
        for (name, file) in &self.files {
            let named = std::fs::symlink_metadata(self.directory.fd_path().join(name));
            let held = file.metadata();
            if let (Ok(named), Ok(held)) = (named, held)
                && named.is_file()
                && !named.file_type().is_symlink()
                && named.dev() == held.dev()
                && named.ino() == held.ino()
            {
                let _ = unlinkat(
                    &self.directory.held,
                    Path::new(name),
                    UnlinkatFlags::NoRemoveDir,
                );
            }
        }
        if let Some(parent) = self.ancestors.last() {
            let named = std::fs::symlink_metadata(parent.fd_path().join(&self.name));
            let held = self.directory.held.metadata();
            if let (Ok(named), Ok(held)) = (named, held)
                && named.is_dir()
                && !named.file_type().is_symlink()
                && named.dev() == held.dev()
                && named.ino() == held.ino()
            {
                let _ = unlinkat(
                    &parent.held,
                    Path::new(&self.name),
                    UnlinkatFlags::RemoveDir,
                );
            }
        }
    }
}

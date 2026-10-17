use super::{Error, Result, ensure};
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
    unistd::Uid,
};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
};

pub(super) const MAXIMUM_RECEIPT_BYTES: usize = 16 * 1024 * 1024;
const INVALID: &str = "full_research_qualification_pointer_file_invalid";

pub(super) fn absolute(path: &Path) -> Result<PathBuf> {
    let joined = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|_| Error::new("qualification_stored_evidence_path_invalid"))?
            .join(path)
    };
    ensure(
        joined.to_str().is_some(),
        "qualification_stored_evidence_path_encoding_unsupported",
    )?;
    let mut result = PathBuf::from("/");
    for part in joined.components() {
        match part {
            Component::RootDir | Component::CurDir => (),
            Component::ParentDir => {
                result.pop();
            }
            Component::Normal(name) => result.push(name),
            _ => return Err(Error::new("qualification_stored_evidence_path_invalid")),
        }
    }
    Ok(result)
}

pub(super) fn database_exists(path: &Path, invalid: &str) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            ensure(
                metadata.is_file()
                    && !metadata.is_symlink()
                    && metadata.mode() & 0o022 == 0
                    && metadata.len() > 0
                    && metadata.len() <= 256 * 1024 * 1024,
                invalid,
            )?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(Error::new(invalid)),
    }
}

/// Plain captured data only. The read descriptor and all directory descriptors
/// are rechecked and closed inside capture, before private SQLite is opened.
pub(super) struct Mirror {
    pub bytes: Vec<u8>,
    path: PathBuf,
    metadata: Metadata,
    parents: Vec<(PathBuf, Metadata)>,
}

impl Mirror {
    pub fn capture(path: &Path) -> Result<Self> {
        ensure(
            path.is_absolute() && path.components().count() <= 128,
            INVALID,
        )?;
        ensure(
            fs::canonicalize(path).map_err(|_| Error::new(INVALID))? == path,
            INVALID,
        )?;
        let flags = OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let mut directory = File::from(
            open(Path::new("/"), flags, Mode::empty()).map_err(|_| Error::new(INVALID))?,
        );
        let mut cursor = PathBuf::from("/");
        let mut held_parents = Vec::new();
        let parent_path = path.parent().ok_or_else(|| Error::new(INVALID))?;
        for part in parent_path.components() {
            let Component::Normal(part) = part else {
                continue;
            };
            let next = File::from(
                openat(directory.as_fd(), Path::new(part), flags, Mode::empty())
                    .map_err(|_| Error::new(INVALID))?,
            );
            let metadata = directory.metadata().map_err(|_| Error::new(INVALID))?;
            held_parents.push((cursor.clone(), directory, metadata));
            cursor.push(part);
            directory = next;
        }
        let leaf = path.file_name().ok_or_else(|| Error::new(INVALID))?;
        let mut file = File::from(
            openat(
                directory.as_fd(),
                Path::new(leaf),
                OFlag::O_RDONLY | OFlag::O_NONBLOCK | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| Error::new(INVALID))?,
        );
        let metadata = file.metadata().map_err(|_| Error::new(INVALID))?;
        ensure(
            metadata.is_file()
                && metadata.uid() == Uid::current().as_raw()
                && metadata.mode() & 0o022 == 0
                && (1..=MAXIMUM_RECEIPT_BYTES as u64).contains(&metadata.len()),
            INVALID,
        )?;
        let mut bytes = Vec::new();
        file.by_ref()
            .take(metadata.len() + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::new(INVALID))?;
        ensure(bytes.len() as u64 == metadata.len(), INVALID)?;
        let parent_metadata = directory.metadata().map_err(|_| Error::new(INVALID))?;
        held_parents.push((cursor, directory, parent_metadata));
        let result = Self {
            bytes,
            path: path.to_owned(),
            metadata,
            parents: held_parents
                .iter()
                .map(|(path, _, metadata)| (path.clone(), metadata.clone()))
                .collect(),
        };
        result.assert_named_current()?;
        ensure(
            same_file(
                &result.metadata,
                &file.metadata().map_err(|_| Error::new(INVALID))?,
            ),
            INVALID,
        )?;
        for (_, file, metadata) in &held_parents {
            ensure(
                same_directory(metadata, &file.metadata().map_err(|_| Error::new(INVALID))?),
                INVALID,
            )?;
        }
        // Explicitly close regular and ancestor descriptors before returning
        // data that the caller can carry into the private SQLite callback.
        drop(file);
        drop(held_parents);
        Ok(result)
    }

    pub fn assert_named_current(&self) -> Result<()> {
        for (path, metadata) in &self.parents {
            ensure(
                same_directory(
                    metadata,
                    &fs::symlink_metadata(path).map_err(|_| Error::new(INVALID))?,
                ),
                INVALID,
            )?;
        }
        ensure(
            same_file(
                &self.metadata,
                &fs::symlink_metadata(&self.path).map_err(|_| Error::new(INVALID))?,
            ),
            INVALID,
        )
    }
}

fn same_directory(before: &Metadata, now: &Metadata) -> bool {
    now.is_dir()
        && !now.is_symlink()
        && before.dev() == now.dev()
        && before.ino() == now.ino()
        && before.uid() == now.uid()
        && before.gid() == now.gid()
        && before.mode() == now.mode()
}

fn same_file(before: &Metadata, now: &Metadata) -> bool {
    now.is_file()
        && !now.is_symlink()
        && before.dev() == now.dev()
        && before.ino() == now.ino()
        && before.uid() == now.uid()
        && before.gid() == now.gid()
        && before.mode() == now.mode()
        && before.nlink() == now.nlink()
        && before.len() == now.len()
        && before.mtime() == now.mtime()
        && before.mtime_nsec() == now.mtime_nsec()
        && before.ctime() == now.ctime()
        && before.ctime_nsec() == now.ctime_nsec()
}

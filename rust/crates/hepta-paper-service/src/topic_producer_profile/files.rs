use super::{Result, TopicProducerProfileError, ensure};
use nix::{
    dir::Dir,
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, Metadata},
    os::{
        fd::AsFd,
        unix::fs::{FileExt, MetadataExt},
    },
    path::{Component, Path, PathBuf},
};

#[cfg(test)]
#[path = "files_tests.rs"]
mod tests;

const MAXIMUM_DEPTH: usize = 128;
const MAXIMUM_ENTRIES: usize = 10_000;
const MAXIMUM_DESCRIPTORS: usize = 12_000;
const MAXIMUM_OBSERVED_BYTES: u64 = 1024 * 1024 * 1024;
const INVALID: &str = "source_file_invalid";
const CHANGED: &str = "source_observation_changed";
const BOUND: &str = "source_observation_bound_exceeded";

#[derive(Clone, Copy)]
pub(super) enum FileKind {
    Profile,
    Dataset,
    Implementation,
}
impl FileKind {
    fn maximum(self) -> u64 {
        match self {
            Self::Dataset => 256 * 1024 * 1024,
            _ => 1024 * 1024,
        }
    }
    fn validate(self, metadata: &Metadata) -> Result<()> {
        ensure(metadata.is_file() && !metadata.is_symlink(), INVALID)?;
        match self {
            Self::Profile => ensure(
                (2..=self.maximum()).contains(&metadata.len()) && metadata.mode() & 0o022 == 0,
                INVALID,
            ),
            Self::Dataset => {
                ensure(metadata.len() <= self.maximum(), BOUND)?;
                ensure(metadata.nlink() == 1, INVALID)
            }
            Self::Implementation => ensure(metadata.len() <= self.maximum(), BOUND),
        }
    }
}

pub(super) struct ObservedFile {
    pub bytes: Vec<u8>,
    pub hash: String,
    file: File,
    metadata: Metadata,
    path: PathBuf,
}
struct ObservedDirectory {
    file: File,
    metadata: Metadata,
    names: Option<Vec<String>>,
}

#[derive(Default)]
pub(super) struct Observations {
    directories: BTreeMap<PathBuf, ObservedDirectory>,
    files: Vec<ObservedFile>,
    entries: usize,
    bytes: u64,
}

pub(super) fn absolute(path: &Path, cwd: &Path) -> Result<PathBuf> {
    ensure(cwd.is_absolute(), "working_directory_profile_unsupported")?;
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        cwd.join(path)
    };
    ensure(
        path.to_str().is_some() && !path.as_os_str().is_empty(),
        "path_encoding_unsupported",
    )?;
    let mut absolute = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => (),
            Component::ParentDir => {
                absolute.pop();
            }
            Component::Normal(name) => absolute.push(name),
            _ => return Err(TopicProducerProfileError::new("path_profile_unsupported")),
        }
    }
    Ok(absolute)
}

impl Observations {
    pub fn directory(&mut self, path: &Path) -> Result<()> {
        if self.directories.contains_key(path) {
            return Ok(());
        }
        ensure(
            path.is_absolute() && path.components().count() <= MAXIMUM_DEPTH,
            "directory_depth_unsupported",
        )?;
        ensure(
            self.directories.len() + self.files.len() < MAXIMUM_DESCRIPTORS,
            BOUND,
        )?;
        let flags = OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let file = match path.parent() {
            Some(parent) => {
                self.directory(parent)?;
                let parent = self
                    .directories
                    .get(parent)
                    .ok_or_else(|| TopicProducerProfileError::new(INVALID))?;
                let name = path
                    .file_name()
                    .ok_or_else(|| TopicProducerProfileError::new(INVALID))?;
                File::from(
                    openat(parent.file.as_fd(), Path::new(name), flags, Mode::empty())
                        .map_err(|_| TopicProducerProfileError::new(INVALID))?,
                )
            }
            None => File::from(
                open(path, flags, Mode::empty())
                    .map_err(|_| TopicProducerProfileError::new(INVALID))?,
            ),
        };
        let metadata = file
            .metadata()
            .map_err(|_| TopicProducerProfileError::new(INVALID))?;
        ensure(metadata.is_dir(), INVALID)?;
        ensure(
            self.directories.len() + self.files.len() < MAXIMUM_DESCRIPTORS,
            BOUND,
        )?;
        self.directories.insert(
            path.to_owned(),
            ObservedDirectory {
                file,
                metadata,
                names: None,
            },
        );
        Ok(())
    }

    pub fn kind(&mut self, path: &Path) -> Result<Metadata> {
        let parent_path = path
            .parent()
            .ok_or_else(|| TopicProducerProfileError::new(INVALID))?;
        self.directory(parent_path)?;
        let parent = self
            .directories
            .get(parent_path)
            .ok_or_else(|| TopicProducerProfileError::new(INVALID))?;
        let name = path
            .file_name()
            .ok_or_else(|| TopicProducerProfileError::new(INVALID))?;
        let file = File::from(
            openat(
                parent.file.as_fd(),
                Path::new(name),
                OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| TopicProducerProfileError::new(INVALID))?,
        );
        file.metadata()
            .map_err(|_| TopicProducerProfileError::new(INVALID))
    }

    pub fn file(&mut self, path: &Path, kind: FileKind) -> Result<&ObservedFile> {
        if let Some(index) = self.files.iter().position(|file| file.path == path) {
            let file = &self.files[index];
            kind.validate(&file.metadata)?;
            return Ok(file);
        }
        let parent_path = path
            .parent()
            .ok_or_else(|| TopicProducerProfileError::new(INVALID))?;
        self.directory(parent_path)?;
        ensure(
            self.directories.len() + self.files.len() < MAXIMUM_DESCRIPTORS,
            BOUND,
        )?;
        let parent = self
            .directories
            .get(parent_path)
            .ok_or_else(|| TopicProducerProfileError::new(INVALID))?;
        let name = path
            .file_name()
            .ok_or_else(|| TopicProducerProfileError::new(INVALID))?;
        let file = File::from(
            openat(
                parent.file.as_fd(),
                Path::new(name),
                OFlag::O_RDONLY | OFlag::O_NONBLOCK | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| TopicProducerProfileError::new(INVALID))?,
        );
        let metadata = file
            .metadata()
            .map_err(|_| TopicProducerProfileError::new(INVALID))?;
        kind.validate(&metadata)?;
        let total = self
            .bytes
            .checked_add(metadata.len())
            .ok_or_else(|| TopicProducerProfileError::new(BOUND))?;
        ensure(total <= MAXIMUM_OBSERVED_BYTES, BOUND)?;
        // Reserve the actual observed length before reading, including repeated
        // mounts only once. Read no more than this length plus one growth byte.
        let (hash, bytes, count) =
            read_hash(&file, metadata.len(), matches!(kind, FileKind::Profile))?;
        ensure(count == metadata.len(), CHANGED)?;
        let observed = ObservedFile {
            bytes,
            hash,
            file,
            metadata,
            path: path.to_owned(),
        };
        observed.assert_namespace()?;
        self.bytes = total;
        self.files.push(observed);
        self.files
            .last()
            .ok_or_else(|| TopicProducerProfileError::new(INVALID))
    }

    pub fn names(&mut self, path: &Path) -> Result<Vec<String>> {
        self.directory(path)?;
        let directory = self
            .directories
            .get(path)
            .ok_or_else(|| TopicProducerProfileError::new(INVALID))?;
        if let Some(names) = &directory.names {
            return Ok(names.clone());
        }
        let names = directory_names(
            &directory.file,
            MAXIMUM_ENTRIES.saturating_sub(self.entries),
        )?;
        self.entries += names.len();
        let directory = self
            .directories
            .get_mut(path)
            .ok_or_else(|| TopicProducerProfileError::new(INVALID))?;
        ensure(
            same_metadata(
                &directory.metadata,
                &directory
                    .file
                    .metadata()
                    .map_err(|_| TopicProducerProfileError::new(CHANGED))?,
            ),
            CHANGED,
        )?;
        directory.names = Some(names.clone());
        Ok(names)
    }

    pub fn assert_current(&self) -> Result<()> {
        self.assert_directories()?;
        for file in &self.files {
            file.assert_namespace()?;
            let (hash, _, count) = read_hash(&file.file, file.metadata.len(), false)?;
            ensure(count == file.metadata.len() && hash == file.hash, CHANGED)?;
            file.assert_namespace()?;
        }
        self.assert_directories()
    }

    fn assert_directories(&self) -> Result<()> {
        for (path, directory) in &self.directories {
            let held = directory
                .file
                .metadata()
                .map_err(|_| TopicProducerProfileError::new(CHANGED))?;
            let named =
                fs::symlink_metadata(path).map_err(|_| TopicProducerProfileError::new(CHANGED))?;
            ensure(
                same_directory(&directory.metadata, &held)
                    && same_directory(&directory.metadata, &named),
                CHANGED,
            )?;
            if let Some(names) = &directory.names {
                ensure(
                    same_metadata(&directory.metadata, &held)
                        && same_metadata(&directory.metadata, &named)
                        && directory_names(&directory.file, MAXIMUM_ENTRIES)? == *names,
                    CHANGED,
                )?;
                let after = directory
                    .file
                    .metadata()
                    .map_err(|_| TopicProducerProfileError::new(CHANGED))?;
                ensure(same_metadata(&directory.metadata, &after), CHANGED)?;
            }
        }
        Ok(())
    }
}

impl ObservedFile {
    fn assert_namespace(&self) -> Result<()> {
        let held = self
            .file
            .metadata()
            .map_err(|_| TopicProducerProfileError::new(CHANGED))?;
        let named = fs::symlink_metadata(&self.path)
            .map_err(|_| TopicProducerProfileError::new(CHANGED))?;
        ensure(
            held.is_file()
                && named.is_file()
                && !named.is_symlink()
                && same_metadata(&self.metadata, &held)
                && same_metadata(&self.metadata, &named),
            CHANGED,
        )
    }
}

fn same_directory(before: &Metadata, now: &Metadata) -> bool {
    now.is_dir()
        && !now.is_symlink()
        && before.dev() == now.dev()
        && before.ino() == now.ino()
        && before.mode() == now.mode()
        && before.uid() == now.uid()
        && before.gid() == now.gid()
}
fn same_metadata(before: &Metadata, now: &Metadata) -> bool {
    before.dev() == now.dev()
        && before.ino() == now.ino()
        && before.mode() == now.mode()
        && before.uid() == now.uid()
        && before.gid() == now.gid()
        && before.nlink() == now.nlink()
        && before.len() == now.len()
        && before.mtime() == now.mtime()
        && before.mtime_nsec() == now.mtime_nsec()
        && before.ctime() == now.ctime()
        && before.ctime_nsec() == now.ctime_nsec()
}

fn directory_names(file: &File, maximum: usize) -> Result<Vec<String>> {
    let mut directory = Dir::openat(
        file.as_fd(),
        Path::new("."),
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| TopicProducerProfileError::new(INVALID))?;
    let mut names = Vec::new();
    for entry in directory.iter() {
        let entry = entry.map_err(|_| TopicProducerProfileError::new(INVALID))?;
        let bytes = entry.file_name().to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        ensure(names.len() < maximum, BOUND)?;
        let name = std::str::from_utf8(bytes)
            .map_err(|_| TopicProducerProfileError::new("dataset_relative_name_unsupported"))?;
        ensure(!name.contains('\\'), "dataset_relative_name_unsupported")?;
        names.push(name.to_owned());
    }
    // Match the original Linux scandir's initial lexical order; a later stable
    // ICU sort preserves this order for canonically equivalent collator ties.
    names.sort();
    Ok(names)
}

fn read_hash(file: &File, maximum: u64, retain: bool) -> Result<(String, Vec<u8>, u64)> {
    let mut digest = Sha256::new();
    let mut bytes = Vec::new();
    let mut offset = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let length = usize::try_from(
            maximum
                .saturating_sub(offset)
                .saturating_add(1)
                .min(buffer.len() as u64),
        )
        .map_err(|_| TopicProducerProfileError::new(BOUND))?;
        let count = match file.read_at(&mut buffer[..length], offset) {
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(TopicProducerProfileError::new(INVALID)),
        };
        if count == 0 {
            break;
        }
        offset = offset
            .checked_add(count as u64)
            .ok_or_else(|| TopicProducerProfileError::new(BOUND))?;
        ensure(offset <= maximum, CHANGED)?;
        digest.update(&buffer[..count]);
        if retain {
            bytes.extend_from_slice(&buffer[..count]);
        }
    }
    Ok((
        format!("sha256:{}", hex::encode(digest.finalize())),
        bytes,
        offset,
    ))
}

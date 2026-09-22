use super::{Error, Result, value::*};
use nix::{
    dir::Dir,
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, Metadata},
    os::{
        fd::AsFd,
        unix::fs::{FileExt, MetadataExt},
    },
    path::{Path, PathBuf},
};

#[cfg(test)]
#[path = "files_tests.rs"]
mod tests;

const MAXIMUM_FILES: usize = 21_000;
const MAXIMUM_DIRECTORIES: usize = 21_000;
const MAXIMUM_DEPTH: usize = 128;
const MAXIMUM_OBSERVED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub(super) const MAXIMUM_BINARY_BYTES: u64 = 1024 * 1024 * 1024;
const MAXIMUM_CREDENTIAL_FILES: usize = 10_000;
const MAXIMUM_CREDENTIAL_ENTRIES: usize = 20_000;
const MAXIMUM_CREDENTIAL_BYTES: u64 = 256 * 1024 * 1024;
const INVALID: &str = "external_qualification_integrity_file_invalid";
const CHANGED: &str = "external_qualification_process_identity_changed";
const IO: &str = "external_qualification_configuration_inspection_failed";
const CREDENTIAL_INVALID: &str = "external_qualification_credential_root_contents_invalid";
const CREDENTIAL_LARGE: &str = "external_qualification_credential_root_contents_too_large";

pub(super) struct FileObservation {
    pub path: PathBuf,
    pub metadata: Metadata,
    pub hash: String,
    pub bytes: Vec<u8>,
    requested: PathBuf,
    file: File,
    maximum: u64,
}

struct DirectoryObservation {
    file: File,
    metadata: Metadata,
    // Only credential directory listings are part of the configuration's tree.
    // Parent directory siblings outside these roots may change independently.
    entries: Option<Vec<String>>,
}

struct SkippedArgument {
    requested: PathBuf,
    observation: Option<(PathBuf, Metadata)>,
}

#[derive(Default)]
pub(super) struct Observations {
    directories: BTreeMap<PathBuf, DirectoryObservation>,
    files: Vec<FileObservation>,
    skipped_arguments: Vec<SkippedArgument>,
    interpreter_searches: Vec<Vec<PathBuf>>,
    bytes: u64,
}

#[derive(Clone, Copy)]
pub(super) enum FileKind {
    Configuration,
    PublicKey,
    Executable,
    Interpreter,
    Argument,
    Credential,
}

impl FileKind {
    fn maximum(self) -> u64 {
        match self {
            Self::Configuration => 256 * 1024,
            Self::PublicKey => 64 * 1024,
            Self::Credential => MAXIMUM_CREDENTIAL_BYTES,
            Self::Executable | Self::Interpreter | Self::Argument => MAXIMUM_BINARY_BYTES,
        }
    }

    fn retained_bytes(self) -> usize {
        match self {
            Self::Configuration => 256 * 1024,
            Self::PublicKey => 64 * 1024,
            Self::Executable => 4096,
            _ => 0,
        }
    }

    fn permits_symlink(self) -> bool {
        matches!(self, Self::Executable | Self::Interpreter | Self::Argument)
    }

    fn integrity_mode(self) -> bool {
        matches!(
            self,
            Self::Configuration | Self::PublicKey | Self::Executable
        )
    }
}

impl Observations {
    pub fn interpreter_search(&mut self, candidates_through_selected: Vec<PathBuf>) {
        self.interpreter_searches.push(candidates_through_selected);
    }

    fn directory(&mut self, path: &Path) -> Result<()> {
        if self.directories.contains_key(path) {
            return Ok(());
        }
        ensure(
            path.is_absolute() && path.components().count() <= MAXIMUM_DEPTH,
            "external_qualification_directory_depth_unsupported",
        )?;
        ensure(
            self.directories.len() < MAXIMUM_DIRECTORIES,
            "external_qualification_observation_budget_exceeded",
        )?;
        let flags = OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let file = match path.parent() {
            Some(parent) => {
                self.directory(parent)?;
                let parent = self.directories.get(parent).ok_or_else(|| Error::new(IO))?;
                let leaf = path.file_name().ok_or_else(|| Error::new(IO))?;
                File::from(
                    openat(parent.file.as_fd(), Path::new(leaf), flags, Mode::empty())
                        .map_err(|_| Error::new(IO))?,
                )
            }
            None => File::from(open(path, flags, Mode::empty()).map_err(|_| Error::new(IO))?),
        };
        let metadata = file.metadata().map_err(|_| Error::new(IO))?;
        ensure(metadata.is_dir(), IO)?;
        ensure(
            self.directories.len() < MAXIMUM_DIRECTORIES,
            "external_qualification_observation_budget_exceeded",
        )?;
        self.directories.insert(
            path.to_owned(),
            DirectoryObservation {
                file,
                metadata,
                entries: None,
            },
        );
        Ok(())
    }

    pub fn file(&mut self, requested: &Path, kind: FileKind) -> Result<&FileObservation> {
        ensure(
            self.files.len() < MAXIMUM_FILES,
            "external_qualification_observation_budget_exceeded",
        )?;
        let resolved = fs::canonicalize(requested).map_err(|_| Error::new(IO))?;
        path_text(&resolved)?;
        ensure(kind.permits_symlink() || resolved == requested, INVALID)?;
        let parent_path = resolved.parent().ok_or_else(|| Error::new(INVALID))?;
        self.directory(parent_path)?;
        let parent = self
            .directories
            .get(parent_path)
            .ok_or_else(|| Error::new(IO))?;
        let leaf = resolved.file_name().ok_or_else(|| Error::new(INVALID))?;
        let file = File::from(
            openat(
                parent.file.as_fd(),
                Path::new(leaf),
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| Error::new(IO))?,
        );
        let metadata = file.metadata().map_err(|_| Error::new(IO))?;
        let maximum = kind.maximum();
        ensure(
            metadata.is_file()
                && metadata.len() <= maximum
                && (!kind.integrity_mode() || (metadata.len() > 0 && metadata.mode() & 0o022 == 0))
                && (!matches!(kind, FileKind::Executable) || metadata.mode() & 0o111 != 0),
            INVALID,
        )?;
        let reserved = self
            .bytes
            .checked_add(metadata.len())
            .ok_or_else(|| Error::new("external_qualification_observation_budget_exceeded"))?;
        ensure(
            reserved <= MAXIMUM_OBSERVED_BYTES,
            "external_qualification_observation_budget_exceeded",
        )?;
        // An observed regular file can grow after fstat. Read at most its
        // reserved byte count plus the one-byte overrun witness, never a whole
        // extra binary after exhausting the aggregate observation budget.
        let (digest, bytes, count) = read_hash(&file, metadata.len(), kind.retained_bytes())?;
        ensure(
            count == metadata.len()
                && same_file(&metadata, &file.metadata().map_err(|_| Error::new(IO))?),
            "external_qualification_integrity_file_changed_during_hash",
        )?;
        self.bytes = reserved;
        let observation = FileObservation {
            path: resolved,
            requested: requested.to_owned(),
            file,
            metadata,
            hash: digest,
            bytes,
            maximum,
        };
        observation.assert_namespace()?;
        self.files.push(observation);
        self.files.last().ok_or_else(|| Error::new(IO))
    }

    pub fn argument(&mut self, requested: &Path, index: usize) -> Result<Option<Value>> {
        let observation = optional_metadata(requested)?;
        if observation
            .as_ref()
            .is_some_and(|(_, metadata)| metadata.is_file())
        {
            let file = self.file(requested, FileKind::Argument)?;
            return Ok(Some(json!({
                "index": index, "realpath": path_text(&file.path)?,
                "device": stat_number(file.metadata.dev()), "inode": stat_number(file.metadata.ino()),
                "mode": file.metadata.mode() & 0o777, "bytes": file.metadata.len(), "contentHash": file.hash,
            })));
        }
        self.skipped_arguments.push(SkippedArgument {
            requested: requested.to_owned(),
            observation,
        });
        Ok(None)
    }

    pub fn credential(&mut self, requested: &Path) -> Result<Value> {
        let resolved = fs::canonicalize(requested).map_err(|_| Error::new(IO))?;
        ensure(
            resolved == requested,
            "external_qualification_credential_root_invalid",
        )?;
        self.directory(&resolved)?;
        let root = self
            .directories
            .get(&resolved)
            .ok_or_else(|| Error::new(IO))?;
        ensure(
            root.metadata.mode() & 0o077 == 0,
            "external_qualification_credential_root_invalid",
        )?;
        let metadata = root.metadata.clone();
        let mut budget = CredentialBudget::default();
        let mut entries = Vec::new();
        let mut hashes = BTreeSet::new();
        self.visit_credentials(
            &resolved,
            Path::new(""),
            metadata.uid(),
            &mut budget,
            &mut entries,
            &mut hashes,
        )?;
        ensure(budget.files > 0 && budget.bytes > 0, CREDENTIAL_INVALID)?;
        let contents_hash = hash(
            "ExternalQualificationCredentialRootContentsIdentity",
            &json!({
                "entries": entries, "fileCount": budget.files, "totalBytes": budget.bytes,
            }),
        )?;
        let mut identity = json!({
            "realpath": path_text(&resolved)?, "device": stat_number(metadata.dev()),
            "inode": stat_number(metadata.ino()), "uid": metadata.uid(), "mode": metadata.mode() & 0o777,
            "contentsIdentityHash": contents_hash,
        });
        let identity_hash = hash("ExternalQualificationCredentialRootIdentity", &identity)?;
        identity["credentialRootIdentityHash"] = json!(identity_hash);
        identity["regularFileContentHashes"] = json!(hashes.into_iter().collect::<Vec<_>>());
        Ok(identity)
    }

    fn visit_credentials(
        &mut self,
        path: &Path,
        relative: &Path,
        uid: u32,
        budget: &mut CredentialBudget,
        entries: &mut Vec<Value>,
        hashes: &mut BTreeSet<String>,
    ) -> Result<()> {
        self.directory(path)?;
        let directory = self.directories.get(path).ok_or_else(|| Error::new(IO))?;
        let names = directory_names(&directory.file, MAXIMUM_CREDENTIAL_ENTRIES - budget.entries)?;
        budget.entries += names.len();
        // Enumerate a complete bounded directory before recursion/sorting, so
        // siblings reserve the same tree-wide budget as descendants.
        for name in &names {
            let child = path.join(name);
            let relative_child = relative.join(name);
            let directory = self.directories.get(path).ok_or_else(|| Error::new(IO))?;
            let child_fd = File::from(
                openat(
                    directory.file.as_fd(),
                    Path::new(name),
                    OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| Error::new(IO))?,
            );
            let metadata = child_fd.metadata().map_err(|_| Error::new(IO))?;
            ensure(
                !metadata.is_symlink() && metadata.uid() == uid && metadata.mode() & 0o077 == 0,
                CREDENTIAL_INVALID,
            )?;
            if metadata.is_dir() {
                self.directory(&child)?;
                let observed = self.directories.get(&child).ok_or_else(|| Error::new(IO))?;
                ensure(same_directory(&metadata, &observed.metadata), CHANGED)?;
                entries.push(json!({"path": format!("{}/", path_text(&relative_child)?), "mode": metadata.mode() & 0o777, "uid": metadata.uid()}));
                self.visit_credentials(&child, &relative_child, uid, budget, entries, hashes)?;
            } else if metadata.is_file() {
                ensure(
                    metadata.nlink() == 1 && metadata.len() > 0,
                    CREDENTIAL_INVALID,
                )?;
                budget.add_file(metadata.len())?;
                let file = self.file(&child, FileKind::Credential)?;
                ensure(same_file(&metadata, &file.metadata), CHANGED)?;
                entries.push(json!({"path": path_text(&relative_child)?, "mode": metadata.mode() & 0o777,
                    "uid": metadata.uid(), "linkCount": metadata.nlink(), "bytes": metadata.len(), "contentHash": file.hash}));
                hashes.insert(file.hash.clone());
            } else {
                return Err(Error::new(CREDENTIAL_INVALID));
            }
        }
        self.directories
            .get_mut(path)
            .ok_or_else(|| Error::new(IO))?
            .entries = Some(names);
        Ok(())
    }

    pub fn assert_current(&self) -> Result<()> {
        self.assert_directories()?;
        for candidates in &self.interpreter_searches {
            // The last path was the first executable candidate. A newly
            // executable earlier PATH entry changes resolution even if the
            // originally retained executable is still entirely unchanged.
            let selected = candidates.iter().find(|path| {
                fs::metadata(path)
                    .is_ok_and(|metadata| metadata.is_file() && metadata.mode() & 0o111 != 0)
            });
            ensure(selected.is_some() && selected == candidates.last(), CHANGED)?;
        }
        for file in &self.files {
            file.assert_namespace()?;
            let (hash, _, count) = read_hash(&file.file, file.metadata.len().min(file.maximum), 0)?;
            ensure(hash == file.hash && count == file.metadata.len(), CHANGED)?;
            file.assert_namespace()?;
        }
        for skipped in &self.skipped_arguments {
            let now = optional_metadata(&skipped.requested)?;
            ensure(
                match (&skipped.observation, now) {
                    (None, None) => true,
                    (Some((path, before)), Some((current_path, current))) => {
                        path == &current_path && same_file(before, &current)
                    }
                    _ => false,
                },
                CHANGED,
            )?;
        }
        self.assert_directories()
    }

    fn assert_directories(&self) -> Result<()> {
        for (path, directory) in &self.directories {
            ensure(
                same_directory(
                    &directory.metadata,
                    &directory.file.metadata().map_err(|_| Error::new(CHANGED))?,
                ) && same_directory(
                    &directory.metadata,
                    &fs::symlink_metadata(path).map_err(|_| Error::new(CHANGED))?,
                ),
                CHANGED,
            )?;
            if let Some(names) = &directory.entries {
                ensure(
                    directory_names(&directory.file, MAXIMUM_CREDENTIAL_ENTRIES)? == *names,
                    CHANGED,
                )?;
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct CredentialBudget {
    files: usize,
    bytes: u64,
    entries: usize,
}
impl CredentialBudget {
    fn add_file(&mut self, bytes: u64) -> Result<()> {
        self.files = self
            .files
            .checked_add(1)
            .ok_or_else(|| Error::new(CREDENTIAL_LARGE))?;
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or_else(|| Error::new(CREDENTIAL_LARGE))?;
        ensure(
            self.files <= MAXIMUM_CREDENTIAL_FILES && self.bytes <= MAXIMUM_CREDENTIAL_BYTES,
            CREDENTIAL_LARGE,
        )
    }
}

fn directory_names(file: &File, maximum: usize) -> Result<Vec<String>> {
    let mut directory = Dir::openat(
        file.as_fd(),
        Path::new("."),
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| Error::new(IO))?;
    let mut names = Vec::new();
    for entry in directory.iter() {
        let entry = entry.map_err(|_| Error::new(IO))?;
        let raw_name = entry.file_name().to_bytes();
        if raw_name == b"." || raw_name == b".." {
            continue;
        }
        ensure(names.len() < maximum, CREDENTIAL_LARGE)?;
        let name = std::str::from_utf8(raw_name)
            .map_err(|_| Error::new("external_qualification_path_encoding_unsupported"))?;
        names.push(name.to_owned());
    }
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    Ok(names)
}

impl FileObservation {
    fn assert_namespace(&self) -> Result<()> {
        ensure(
            fs::canonicalize(&self.requested).map_err(|_| Error::new(CHANGED))? == self.path
                && same_file(
                    &self.metadata,
                    &self.file.metadata().map_err(|_| Error::new(CHANGED))?,
                )
                && same_file(
                    &self.metadata,
                    &fs::symlink_metadata(&self.path).map_err(|_| Error::new(CHANGED))?,
                ),
            CHANGED,
        )
    }
}

fn optional_metadata(path: &Path) -> Result<Option<(PathBuf, Metadata)>> {
    let resolved = match fs::canonicalize(path) {
        Ok(path) => path,
        // The incumbent first calls existsSync, which returns false for path
        // lookup failures (including permission and ENOTDIR failures).
        Err(_) => return Ok(None),
    };
    let metadata = fs::metadata(&resolved).map_err(|_| Error::new(IO))?;
    Ok(Some((resolved, metadata)))
}

fn same_directory(before: &Metadata, now: &Metadata) -> bool {
    now.is_dir()
        && before.dev() == now.dev()
        && before.ino() == now.ino()
        && before.mode() == now.mode()
        && before.uid() == now.uid()
        && before.gid() == now.gid()
}

fn same_file(before: &Metadata, now: &Metadata) -> bool {
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

fn read_hash(file: &File, maximum: u64, retain: usize) -> Result<(String, Vec<u8>, u64)> {
    let mut digest = Sha256::new();
    let mut retained = Vec::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut offset = 0u64;
    loop {
        let remaining = maximum.saturating_sub(offset).saturating_add(1);
        let length =
            usize::try_from(remaining.min(buffer.len() as u64)).map_err(|_| Error::new(INVALID))?;
        let count = match file.read_at(&mut buffer[..length], offset) {
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(Error::new(IO)),
        };
        if count == 0 {
            break;
        }
        offset = offset
            .checked_add(count as u64)
            .ok_or_else(|| Error::new(INVALID))?;
        ensure(offset <= maximum, INVALID)?;
        digest.update(&buffer[..count]);
        let append = count.min(retain.saturating_sub(retained.len()));
        retained.extend_from_slice(&buffer[..append]);
    }
    Ok((
        format!("sha256:{}", hex::encode(digest.finalize())),
        retained,
        offset,
    ))
}

use super::*;
use nix::fcntl::{OFlag, openat};
use nix::sys::stat::Mode;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, Metadata},
    os::{
        fd::AsRawFd,
        unix::fs::{FileExt, MetadataExt},
    },
    path::{Component, PathBuf},
};
pub(super) const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
pub(super) fn identity(stat: &Metadata) -> Value {
    json!({"device":stat.dev().to_string(),"inode":stat.ino().to_string(),"mode":stat.mode().to_string(),"links":stat.nlink().to_string(),"bytes":stat.len().to_string(),"modifiedNs":(i128::from(stat.mtime())*1_000_000_000+i128::from(stat.mtime_nsec())).to_string(),"changedNs":(i128::from(stat.ctime())*1_000_000_000+i128::from(stat.ctime_nsec())).to_string()})
}
fn inode(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}
pub(super) struct Directory {
    pub path: PathBuf,
    pub held: File,
    pinned: Metadata,
}
impl Directory {
    pub fn assert_current(&self) -> Result<()> {
        let current = std::fs::symlink_metadata(&self.path).map_err(|_| changed())?;
        let held = self.held.metadata().map_err(|_| changed())?;
        ensure(
            current.is_dir()
                && !current.file_type().is_symlink()
                && inode(&self.pinned, &held)
                && inode(&held, &current)
                && current.mode() == self.pinned.mode(),
            "autonomous_research_state_database_changed_during_inspection:directory",
        )
    }
    pub fn child_directory(&self, name: &std::ffi::OsStr) -> Result<Self> {
        self.assert_current()?;
        let held = File::from(
            openat(
                &self.held,
                Path::new(name),
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_DIRECTORY,
                Mode::empty(),
            )
            .map_err(|_| changed())?,
        );
        let result = Self {
            path: self.path.join(name),
            pinned: held.metadata().map_err(|_| changed())?,
            held,
        };
        result.assert_current()?;
        Ok(result)
    }
    pub fn fd_path(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.held.as_raw_fd()))
    }
}
pub(super) fn open_root(root: &Path) -> Result<(PathBuf, Vec<Directory>)> {
    let root = if root.is_absolute() {
        root.to_owned()
    } else {
        std::env::current_dir().map_err(|_| changed())?.join(root)
    };
    ensure(
        root.to_str().is_some()
            && root.as_os_str()
                == std::fs::canonicalize(&root)
                    .map_err(|_| error("autonomous_research_state_database_runtime_root_invalid"))?
                    .as_os_str(),
        "autonomous_research_state_database_runtime_root_invalid",
    )?;
    let held = File::open("/").map_err(|_| changed())?;
    let mut parent = Directory {
        path: PathBuf::from("/"),
        pinned: held.metadata().map_err(|_| changed())?,
        held,
    };
    let mut parents = Vec::new();
    for part in root.components() {
        if let Component::Normal(name) = part {
            let next = parent.child_directory(name)?;
            parents.push(parent);
            parent = next;
        }
    }
    parents.push(parent);
    Ok((root, parents))
}
pub(super) fn parent(
    root: &Directory,
    relative: &Path,
) -> Result<(Vec<Directory>, std::ffi::OsString)> {
    ensure(
        !relative.is_absolute()
            && relative
                .components()
                .all(|c| matches!(c, Component::Normal(_))),
        "autonomous_research_state_database_path_outside_runtime",
    )?;
    let mut chain = Vec::new();
    let mut current = root;
    if let Some(path) = relative.parent() {
        for part in path.components() {
            let Component::Normal(name) = part else {
                return Err(changed());
            };
            let next = current.child_directory(name)?;
            chain.push(next);
            current = chain.last().ok_or_else(changed)?;
        }
    }
    Ok((chain, relative.file_name().ok_or_else(changed)?.to_owned()))
}
pub(super) fn changed() -> Error {
    error("autonomous_research_state_database_changed_during_snapshot")
}
#[derive(Default)]
pub(super) struct Budget {
    bytes: u64,
}
impl Budget {
    pub(super) fn add(&mut self, bytes: u64) -> Result<()> {
        self.bytes = self.bytes.checked_add(bytes).ok_or_else(changed)?;
        ensure(
            bytes <= MAX_FILE_BYTES && self.bytes <= MAX_TOTAL_BYTES,
            "autonomous_research_state_database_inventory_limit_exceeded",
        )
    }
}
pub(super) struct FileObservation {
    pub path: PathBuf,
    pub file: File,
    pub metadata: Value,
    pub sha256: String,
}
impl FileObservation {
    pub fn assert_namespace_current(&self) -> Result<()> {
        let named = std::fs::symlink_metadata(&self.path).map_err(|_| changed())?;
        let held = self.file.metadata().map_err(|_| changed())?;
        ensure(
            named.is_file()
                && !named.file_type().is_symlink()
                && named.nlink()
                    == self.metadata["links"]
                        .as_str()
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0)
                && inode(&named, &held)
                && named.mode()
                    == self.metadata["mode"]
                        .as_str()
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0),
            "autonomous_research_state_database_namespace_changed",
        )
    }
    fn hash(&self) -> Result<String> {
        let size = self.file.metadata().map_err(|_| changed())?.len();
        ensure(
            size <= MAX_FILE_BYTES,
            "autonomous_research_state_database_inventory_limit_exceeded",
        )?;
        let mut hasher = Sha256::new();
        let mut offset = 0u64;
        let mut bytes = [0u8; 64 * 1024];
        loop {
            let n = self
                .file
                .read_at(&mut bytes, offset)
                .map_err(|_| changed())?;
            if n == 0 {
                break;
            }
            offset = offset.checked_add(n as u64).ok_or_else(changed)?;
            ensure(
                offset <= MAX_FILE_BYTES,
                "autonomous_research_state_database_inventory_limit_exceeded",
            )?;
            hasher.update(&bytes[..n]);
        }
        ensure(
            offset == size,
            "autonomous_research_state_database_changed_during_snapshot",
        )?;
        Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
    }
    pub fn assert_current(&self) -> Result<()> {
        let named = std::fs::symlink_metadata(&self.path).map_err(|_| changed())?;
        let held = self.file.metadata().map_err(|_| changed())?;
        ensure(
            named.is_file()
                && !named.file_type().is_symlink()
                && named.nlink() == 1
                && inode(&named, &held)
                && identity(&named) == self.metadata
                && identity(&held) == self.metadata,
            "autonomous_research_state_database_changed_during_snapshot",
        )?;
        ensure(
            self.hash()? == self.sha256
                && identity(&self.file.metadata().map_err(|_| changed())?) == self.metadata,
            "autonomous_research_state_database_changed_during_snapshot",
        )
    }
    pub fn copy_to(&self, target: &File) -> Result<()> {
        let mut offset = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = self
                .file
                .read_at(&mut buffer, offset)
                .map_err(|_| changed())?;
            if n == 0 {
                break;
            }
            target
                .write_all_at(&buffer[..n], offset)
                .map_err(|_| changed())?;
            offset += n as u64;
            ensure(
                offset <= MAX_FILE_BYTES,
                "autonomous_research_state_database_inventory_limit_exceeded",
            )?;
        }
        target.sync_all().map_err(|_| changed())?;
        self.assert_current()
    }
}
fn observe(
    parent: &Directory,
    name: &std::ffi::OsStr,
    role: &str,
    budget: &mut Budget,
) -> Result<Option<FileObservation>> {
    parent.assert_current()?;
    let path = parent.path.join(name);
    let named = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(changed()),
    };
    ensure(
        named.is_file()
            && !named.file_type().is_symlink()
            && named.nlink() == 1
            && named.mode() & 0o002 == 0
            && (role == "submission-handoff" || named.mode() & 0o020 == 0),
        "autonomous_research_state_database_file_unsafe",
    )?;
    budget.add(named.len())?;
    let file = File::from(
        openat(
            &parent.held,
            Path::new(name),
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
            Mode::empty(),
        )
        .map_err(|_| changed())?,
    );
    ensure(
        identity(&file.metadata().map_err(|_| changed())?) == identity(&named),
        "autonomous_research_state_database_changed_during_snapshot",
    )?;
    let mut result = FileObservation {
        path,
        file,
        metadata: identity(&named),
        sha256: String::new(),
    };
    result.sha256 = result.hash()?;
    result.assert_current()?;
    Ok(Some(result))
}
pub(super) struct DatabaseObservation {
    pub parents: Vec<Directory>,
    pub source: FileObservation,
    pub wal: Option<FileObservation>,
    pub shm: Option<FileObservation>,
    journal: Option<FileObservation>,
}
impl DatabaseObservation {
    pub fn assert_source_namespace_current(&self) -> Result<()> {
        for parent in &self.parents {
            parent.assert_current()?;
        }
        self.source.assert_namespace_current()
    }
    pub fn observe(
        root: &Directory,
        relative: &Path,
        role: &str,
        budget: &mut Budget,
    ) -> Result<Self> {
        let (parents, name) = parent(root, relative)?;
        let directory = parents.last().unwrap_or(root);
        let source = observe(directory, &name, role, budget)?
            .ok_or_else(|| error("autonomous_research_state_database_file_unsafe"))?;
        let name = name.to_str().ok_or_else(changed)?;
        let wal = observe(
            directory,
            std::ffi::OsStr::new(&format!("{name}-wal")),
            role,
            budget,
        )?;
        let shm = observe(
            directory,
            std::ffi::OsStr::new(&format!("{name}-shm")),
            role,
            budget,
        )?;
        let journal = observe(
            directory,
            std::ffi::OsStr::new(&format!("{name}-journal")),
            role,
            budget,
        )?;
        if let Some(journal) = &journal {
            let mut header = [0u8; 8];
            let read = journal
                .file
                .read_at(&mut header, 0)
                .map_err(|_| changed())?;
            // A nonzero rollback header may represent uncommitted database
            // pages. Do not recover the source or treat those pages as current.
            // An empty/zeroed PERSIST journal is safe to pin and observe.
            ensure(
                header[..read].iter().all(|v| *v == 0),
                "autonomous_research_state_database_rollback_journal_pending",
            )?;
        }
        let result = Self {
            parents,
            source,
            wal,
            shm,
            journal,
        };
        result.assert_current()?;
        Ok(result)
    }
    pub fn assert_current(&self) -> Result<()> {
        for parent in &self.parents {
            parent.assert_current()?;
        }
        self.source.assert_current()?;
        for (suffix, file) in [
            ("-wal", &self.wal),
            ("-shm", &self.shm),
            ("-journal", &self.journal),
        ] {
            if let Some(file) = file {
                file.assert_current()?
            } else {
                let path = PathBuf::from(format!("{}{suffix}", self.source.path.display()));
                ensure(
                    matches!(std::fs::symlink_metadata(&path),Err(e)if e.kind()==std::io::ErrorKind::NotFound),
                    "autonomous_research_state_database_changed_during_snapshot",
                )?;
            }
        }
        Ok(())
    }
}

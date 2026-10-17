use super::*;
use crate::sqlite_mutation_coordinator::{authority::files::Snapshot, hash_bytes};
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use std::{
    fs::File,
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, PathBuf},
};
const CODE: &str = "autonomous_research_online_schema_transition_audit_receipt_invalid";
fn initial_file(path: &Path) -> Result<File> {
    if !path.is_absolute() || path.components().any(|p| matches!(p, Component::ParentDir)) {
        return Err(error(CODE));
    }
    let mut directory = File::from(
        open(
            Path::new("/"),
            OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_DIRECTORY,
            Mode::empty(),
        )
        .map_err(|_| error(CODE))?,
    );
    let mut parts = path
        .components()
        .filter_map(|p| {
            if let Component::Normal(v) = p {
                Some(v)
            } else {
                None
            }
        })
        .peekable();
    while let Some(part) = parts.next() {
        let last = parts.peek().is_none();
        let flags = OFlag::O_RDONLY
            | OFlag::O_NOFOLLOW
            | OFlag::O_CLOEXEC
            | OFlag::O_NONBLOCK
            | if last {
                OFlag::empty()
            } else {
                OFlag::O_DIRECTORY
            };
        let file = File::from(
            openat(directory.as_fd(), Path::new(part), flags, Mode::empty())
                .map_err(|_| error(CODE))?,
        );
        if last {
            return Ok(file);
        }
        directory = file;
    }
    Err(error(CODE))
}
pub(super) struct AuditSnapshot {
    snapshot: Snapshot,
    runtime_root: PathBuf,
    control_identity: (u64, u64, u32),
}
impl AuditSnapshot {
    pub fn load(runtime_root: &Path) -> Result<Self> {
        if !runtime_root.is_absolute() {
            return Err(error(CODE));
        }
        let control = runtime_root.join("autonomous-research/online-schema-transition");
        let metadata = std::fs::symlink_metadata(&control).map_err(|_| error(CODE))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.mode() & 0o022 != 0 {
            return Err(error(CODE));
        }
        let control_identity = (metadata.dev(), metadata.ino(), metadata.mode());
        let path = control.join("FINAL.json");
        // This first bounded read obtains a snapshot pin, not trusted content.
        // Held directory traversal, duplicate rejection and all signatures are
        // independently required before any opaque readiness can be returned.
        let mut initial = initial_file(&path)?;
        let metadata = initial.metadata().map_err(|_| error(CODE))?;
        if !metadata.is_file()
            || metadata.len() > 16 * 1024 * 1024
            || metadata.nlink() != 1
            || metadata.mode() & 0o022 != 0
            || (metadata.uid() != 0 && metadata.uid() != nix::unistd::getuid().as_raw())
        {
            return Err(error(CODE));
        }
        let mut bytes = Vec::new();
        initial
            .by_ref()
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| error(CODE))?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(error(CODE));
        }
        let snapshot = Snapshot::load(&path, &hash_bytes(&bytes), 16 * 1024 * 1024, CODE)?;
        let audit = Self {
            snapshot,
            runtime_root: runtime_root.into(),
            control_identity,
        };
        audit.assert_current()?;
        Ok(audit)
    }
    pub fn value(&self) -> Result<Value> {
        crate::sqlite_mutation_coordinator::contracts::schema_transition::normalize_schema_numbers_v1(&self.snapshot.json(CODE)?)
    }
    pub fn bytes(&self) -> &[u8] {
        self.snapshot.bytes()
    }
    pub fn runtime_root(&self) -> &Path {
        &self.runtime_root
    }
    pub fn assert_current(&self) -> Result<()> {
        let metadata = std::fs::symlink_metadata(
            self.runtime_root
                .join("autonomous-research/online-schema-transition"),
        )
        .map_err(|_| error("autonomous_research_online_schema_transition_audit_changed"))?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.mode() & 0o022 != 0
            || (metadata.dev(), metadata.ino(), metadata.mode()) != self.control_identity
        {
            return Err(error(
                "autonomous_research_online_schema_transition_audit_changed",
            ));
        }
        self.snapshot
            .assert_current()
            .map_err(|_| error("autonomous_research_online_schema_transition_audit_changed"))
    }
}

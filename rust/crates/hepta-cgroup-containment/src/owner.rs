//! Retained directory ownership. Namespace observations do not exclude arbitrary
//! same-UID mutation; final mkdir/open and name-based unlink require cooperation.

use std::{
    fs::{self, File},
    io::{Read, Write},
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

use nix::{
    errno::Errno,
    fcntl::{OFlag, OpenHow, ResolveFlag, open, openat, openat2},
    sys::{
        stat::{Mode, mkdirat},
        statfs::{CGROUP2_SUPER_MAGIC, fstatfs},
    },
    unistd::{UnlinkatFlags, unlinkat},
};

use crate::{
    CgroupAuthorityModeV1, CgroupV2Error, CgroupV2PolicyV1, MAX_CONTROL_BYTES,
    MAX_FIXTURE_PROCESS_SET_BYTES,
};

const MAXIMUM_EVENTS_BYTES: u64 = 4096;
const DIRECTORY_FLAGS: OFlag = OFlag::O_PATH
    .union(OFlag::O_DIRECTORY)
    .union(OFlag::O_NOFOLLOW)
    .union(OFlag::O_CLOEXEC);

#[derive(Clone, Copy)]
struct DirectoryIdentity {
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
    mode: u32,
}

impl DirectoryIdentity {
    fn capture(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            uid: metadata.uid(),
            gid: metadata.gid(),
            mode: metadata.mode(),
        }
    }

    fn matches(self, metadata: &fs::Metadata) -> bool {
        metadata.is_dir()
            && metadata.nlink() != 0
            && self.device == metadata.dev()
            && self.inode == metadata.ino()
            && self.uid == metadata.uid()
            && self.gid == metadata.gid()
            && self.mode == metadata.mode()
        // nlink and ctime may change when cooperating siblings/children change.
    }
}

pub(super) struct RootOwner {
    file: File,
    path: PathBuf,
    identity: DirectoryIdentity,
    production: bool,
}

impl RootOwner {
    pub(super) fn capture(policy: &CgroupV2PolicyV1) -> Result<Self, CgroupV2Error> {
        policy.validate_limits()?;
        let file = walk_directory(&policy.delegated_root)?;
        let metadata = file.metadata().map_err(io_error("root_metadata"))?;
        if !metadata.is_dir() || metadata.uid() != policy.owner_uid || metadata.mode() & 0o002 != 0
        {
            return Err(CgroupV2Error::InvalidHierarchy);
        }
        let production = policy.authority_mode == CgroupAuthorityModeV1::ProductionSystem;
        if production {
            if !policy.delegated_root.starts_with("/sys/fs/cgroup") {
                return Err(CgroupV2Error::InvalidHierarchy);
            }
            verify_cgroup2(&file)?;
            // Observe actual fixed kernel controls, not similarly named files
            // on an ordinary filesystem. No writable regular file is opened.
            for name in ["cgroup.controllers", "cgroup.subtree_control"] {
                let control = open_beneath(&file, name, OFlag::O_PATH, Mode::empty())
                    .map_err(errno_error("root_control"))?;
                verify_cgroup2(&control)?;
                if !control
                    .metadata()
                    .map_err(io_error("root_control"))?
                    .is_file()
                {
                    return Err(CgroupV2Error::InvalidHierarchy);
                }
            }
        }
        let owner = Self {
            file,
            path: policy.delegated_root.clone(),
            identity: DirectoryIdentity::capture(&metadata),
            production,
        };
        owner.assert_current()?;
        Ok(owner)
    }

    pub(super) fn identity(&self) -> (u64, u64) {
        (self.identity.device, self.identity.inode)
    }

    fn assert_current(&self) -> Result<(), CgroupV2Error> {
        let held = self.file.metadata().map_err(io_error("root_recheck"))?;
        let current = walk_directory(&self.path).map_err(|_| CgroupV2Error::NamespaceChanged)?;
        let observed = current.metadata().map_err(io_error("root_recheck"))?;
        if !self.identity.matches(&held) || !self.identity.matches(&observed) {
            return Err(CgroupV2Error::NamespaceChanged);
        }
        Ok(())
    }

    pub(super) fn create(self, leaf: &str) -> Result<OperationOwner, CgroupV2Error> {
        self.assert_current()?;
        mkdirat(self.file.as_fd(), leaf, Mode::S_IRWXU).map_err(errno_error("create"))?;
        // mkdirat does not return an FD. Cooperating namespace ownership is
        // required across mkdir/open; failure must not blindly unlink a name.
        self.assert_current()?;
        let file = open_beneath(&self.file, leaf, DIRECTORY_FLAGS, Mode::empty())
            .map_err(errno_error("operation_open"))?;
        OperationOwner::capture(self, leaf, file)
    }

    pub(super) fn recover(
        self,
        leaf: &str,
        expected: (u64, u64, i64, i64),
    ) -> Result<Option<OperationOwner>, CgroupV2Error> {
        self.assert_current()?;
        let file = match open_beneath(&self.file, leaf, DIRECTORY_FLAGS, Mode::empty()) {
            Ok(file) => file,
            Err(Errno::ENOENT) => {
                // Absence is observed under the already captured/checked root.
                self.assert_current()?;
                return Ok(None);
            }
            Err(error) => return Err(errno_error("recover")(error)),
        };
        let metadata = file.metadata().map_err(io_error("recover"))?;
        if operation_identity(&metadata) != expected {
            return Err(CgroupV2Error::RecoveryIdentityMismatch);
        }
        OperationOwner::capture(self, leaf, file).map(Some)
    }
}

#[derive(Clone, Copy)]
pub(super) enum Control {
    Procs,
    Events,
    Kill,
    PidsMax,
    MemoryMax,
    CpuMax,
}

impl Control {
    fn name(self) -> &'static str {
        match self {
            Self::Procs => "cgroup.procs",
            Self::Events => "cgroup.events",
            Self::Kill => "cgroup.kill",
            Self::PidsMax => "pids.max",
            Self::MemoryMax => "memory.max",
            Self::CpuMax => "cpu.max",
        }
    }
}

const FIXTURE_CONTROLS: [(Control, &str); 6] = [
    (Control::Procs, ""),
    (Control::Events, "populated 0\nfrozen 0"),
    (Control::Kill, "0"),
    (Control::PidsMax, "max"),
    (Control::MemoryMax, "max"),
    (Control::CpuMax, "max 100000"),
];

pub(super) struct OperationOwner {
    root: RootOwner,
    file: File,
    leaf: String,
    identity: DirectoryIdentity,
    failed: AtomicBool,
}

impl OperationOwner {
    fn capture(root: RootOwner, leaf: &str, file: File) -> Result<Self, CgroupV2Error> {
        let metadata = file.metadata().map_err(io_error("operation_metadata"))?;
        if !metadata.is_dir()
            || metadata.uid() != root.identity.uid
            || metadata.dev() != root.identity.device
        {
            return Err(CgroupV2Error::InvalidHierarchy);
        }
        if root.production {
            verify_cgroup2(&file)?;
        }
        let owner = Self {
            root,
            file,
            leaf: leaf.to_owned(),
            identity: DirectoryIdentity::capture(&metadata),
            failed: AtomicBool::new(false),
        };
        owner.assert_current()?;
        Ok(owner)
    }

    pub(super) fn failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }

    pub(super) fn invalidate(&self, error: CgroupV2Error) -> CgroupV2Error {
        self.failed.store(true, Ordering::Release);
        error
    }

    fn observe<T>(
        &self,
        action: impl FnOnce() -> Result<T, CgroupV2Error>,
    ) -> Result<T, CgroupV2Error> {
        if self.failed() {
            return Err(CgroupV2Error::OwnerRequiresInspection);
        }
        action().map_err(|error| self.invalidate(error))
    }

    pub(super) fn assert_current(&self) -> Result<(), CgroupV2Error> {
        self.observe(|| {
            self.root.assert_current()?;
            let held = self
                .file
                .metadata()
                .map_err(io_error("operation_recheck"))?;
            let current = open_beneath(&self.root.file, &self.leaf, DIRECTORY_FLAGS, Mode::empty())
                .map_err(|_| CgroupV2Error::NamespaceChanged)?;
            let observed = current.metadata().map_err(io_error("operation_recheck"))?;
            if !self.identity.matches(&held) || !self.identity.matches(&observed) {
                return Err(CgroupV2Error::NamespaceChanged);
            }
            Ok(())
        })
    }

    pub(super) fn root_identity(&self) -> Result<(u64, u64), CgroupV2Error> {
        self.assert_current()?;
        Ok(self.root.identity())
    }

    pub(super) fn directory_identity(&self) -> Result<(u64, u64, i64, i64), CgroupV2Error> {
        self.observe(|| {
            self.assert_current()?;
            let metadata = self.file.metadata().map_err(io_error("identity"))?;
            self.assert_current()?;
            Ok(operation_identity(&metadata))
        })
    }

    pub(super) fn create_fixture_controls(&self) -> Result<(), CgroupV2Error> {
        self.observe(|| {
            self.assert_current()?;
            for (control, contents) in FIXTURE_CONTROLS {
                let mut file = open_beneath(
                    &self.file,
                    control.name(),
                    OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NONBLOCK,
                    Mode::S_IRUSR | Mode::S_IWUSR,
                )
                .map_err(errno_error("fixture_control"))?;
                self.validate_control(&file)?;
                file.write_all(contents.as_bytes())
                    .map_err(io_error("fixture_control"))?;
            }
            self.assert_current()
        })
    }

    fn validate_control(&self, file: &File) -> Result<(), CgroupV2Error> {
        let metadata = file.metadata().map_err(io_error("control_metadata"))?;
        if !metadata.is_file() || metadata.dev() != self.identity.device {
            return Err(CgroupV2Error::InvalidControlFile);
        }
        if self.root.production {
            verify_cgroup2(file)?;
        } else if metadata.uid() != self.identity.uid
            || metadata.nlink() != 1
            || metadata.mode() & 0o7777 != 0o600
        {
            return Err(CgroupV2Error::InvalidControlFile);
        }
        Ok(())
    }

    fn open_control(&self, control: Control, write: bool) -> Result<File, CgroupV2Error> {
        let file = open_beneath(
            &self.file,
            control.name(),
            (if write {
                OFlag::O_WRONLY
            } else {
                OFlag::O_RDONLY
            }) | OFlag::O_NONBLOCK,
            Mode::empty(),
        )
        .map_err(errno_error("control_open"))?;
        self.validate_control(&file)?;
        Ok(file)
    }

    pub(super) fn write(&self, control: Control, value: &str) -> Result<(), CgroupV2Error> {
        self.write_with_boundary(control, value, || {})
    }

    // The production path and private regression share this actual I/O boundary.
    fn write_with_boundary(
        &self,
        control: Control,
        value: &str,
        before_open: impl FnOnce(),
    ) -> Result<(), CgroupV2Error> {
        let fixture_process_set = !self.root.production && matches!(control, Control::Procs);
        let maximum = if fixture_process_set {
            MAX_FIXTURE_PROCESS_SET_BYTES
        } else {
            MAX_CONTROL_BYTES
        };
        if (!fixture_process_set && value.is_empty())
            || value.len() > maximum
            || value.as_bytes().contains(&0)
        {
            return Err(CgroupV2Error::InvalidControlValue);
        }
        self.observe(|| {
            self.assert_current()?;
            before_open();
            let mut file = self.open_control(control, true)?;
            if !self.root.production {
                // Validation precedes truncation; no O_TRUNC on an unknown leaf.
                file.set_len(0)
                    .map_err(io_error("fixture_control_truncate"))?;
            }
            file.write_all(value.as_bytes())
                .map_err(io_error("control_write"))?;
            self.assert_current()
        })
    }

    pub(super) fn events(&self) -> Result<Vec<u8>, CgroupV2Error> {
        self.observe(|| {
            self.assert_current()?;
            let file = self.open_control(Control::Events, false)?;
            let mut bytes = Vec::new();
            file.take(MAXIMUM_EVENTS_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(io_error("events_read"))?;
            if bytes.len() as u64 > MAXIMUM_EVENTS_BYTES {
                return Err(CgroupV2Error::EventsMalformed);
            }
            self.assert_current()?;
            Ok(bytes)
        })
    }

    pub(super) fn remove(&self) -> Result<(), CgroupV2Error> {
        self.observe(|| {
            self.assert_current()?;
            if !self.root.production {
                for (control, _) in FIXTURE_CONTROLS {
                    // Validate fixed fixture leaves before deleting names. This
                    // is cooperative cleanup, not atomic expected-inode unlink.
                    let file = self.open_control(control, false)?;
                    drop(file);
                    unlinkat(
                        self.file.as_fd(),
                        control.name(),
                        UnlinkatFlags::NoRemoveDir,
                    )
                    .map_err(errno_error("fixture_cleanup"))?;
                }
            }
            self.assert_current()?;
            // Parent anchoring prevents ancestor redirection. The leaf still
            // requires cooperating namespace ownership across check/unlink.
            unlinkat(
                self.root.file.as_fd(),
                self.leaf.as_str(),
                UnlinkatFlags::RemoveDir,
            )
            .map_err(errno_error("remove"))?;
            let removed = self.file.metadata().map_err(io_error("removed_identity"))?;
            if removed.nlink() != 0 {
                return Err(CgroupV2Error::NamespaceChanged);
            }
            self.root.assert_current()?;
            if !self.root.production {
                // O_PATH itself cannot fsync. Open the same held directory's
                // dot entry; never reopen the caller-visible root pathname.
                let directory = open_beneath(
                    &self.root.file,
                    ".",
                    OFlag::O_RDONLY | OFlag::O_DIRECTORY,
                    Mode::empty(),
                )
                .map_err(errno_error("sync_parent"))?;
                if !self
                    .root
                    .identity
                    .matches(&directory.metadata().map_err(io_error("sync_parent"))?)
                {
                    return Err(CgroupV2Error::NamespaceChanged);
                }
                directory.sync_all().map_err(io_error("sync_parent"))?;
                self.root.assert_current()?;
            }
            Ok(())
        })
    }
}

fn operation_identity(metadata: &fs::Metadata) -> (u64, u64, i64, i64) {
    (
        metadata.dev(),
        metadata.ino(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    )
}

fn walk_directory(path: &Path) -> Result<File, CgroupV2Error> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
    {
        return Err(CgroupV2Error::InvalidHierarchy);
    }
    let mut file = File::from(
        open(Path::new("/"), DIRECTORY_FLAGS, Mode::empty()).map_err(errno_error("root_open"))?,
    );
    for part in path.components() {
        if let Component::Normal(name) = part {
            file = File::from(
                openat(
                    file.as_fd(),
                    Path::new(name),
                    DIRECTORY_FLAGS,
                    Mode::empty(),
                )
                .map_err(errno_error("root_open"))?,
            );
        }
    }
    Ok(file)
}

fn open_beneath(parent: &File, name: &str, flags: OFlag, mode: Mode) -> Result<File, Errno> {
    openat2(
        parent.as_fd(),
        name,
        OpenHow::new()
            .flags(flags | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC)
            .mode(mode)
            .resolve(
                ResolveFlag::RESOLVE_BENEATH
                    | ResolveFlag::RESOLVE_NO_SYMLINKS
                    | ResolveFlag::RESOLVE_NO_XDEV,
            ),
    )
    .map(File::from)
}

fn verify_cgroup2(file: &File) -> Result<(), CgroupV2Error> {
    if fstatfs(file)
        .map_err(errno_error("filesystem_type"))?
        .filesystem_type()
        != CGROUP2_SUPER_MAGIC
    {
        return Err(CgroupV2Error::InvalidHierarchy);
    }
    Ok(())
}

fn io_error(operation: &'static str) -> impl FnOnce(std::io::Error) -> CgroupV2Error {
    move |error| CgroupV2Error::Filesystem(operation, error.kind())
}

fn errno_error(operation: &'static str) -> impl FnOnce(Errno) -> CgroupV2Error {
    move |error| {
        CgroupV2Error::Filesystem(
            operation,
            std::io::Error::from_raw_os_error(error as i32).kind(),
        )
    }
}

#[cfg(test)]
mod tests;

//! Identity-bound Unix socket publication. A refused probe is evidence only
//! after the same owned inode and complete trusted namespace are rechecked.
//! As in the incumbent, same-UID lifecycle operations must be serialized by the
//! service manager: POSIX has no atomic conditional-unlink-by-inode operation.
use super::super::{Result, error, storage};
use nix::{
    errno::Errno,
    sys::socket::{AddressFamily, SockFlag, SockType, UnixAddr, connect, socket},
};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStrExt,
            fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

const CONFLICT: &str = "local_state_authority_socket_path_conflict";
const PUBLICATION: &str = "local_state_authority_socket_publication_failed";
const PARENT: &str = "local_state_authority_socket_parent_invalid";
const CHANGED: &str = "local_state_authority_socket_identity_changed";

fn identity(value: &Metadata) -> (u64, u64) {
    (value.dev(), value.ino())
}
fn directory_matches(value: &Metadata, expected: &Metadata) -> bool {
    value.is_dir()
        && !value.is_symlink()
        && identity(value) == identity(expected)
        && value.mode() == expected.mode()
        && value.uid() == expected.uid()
        && value.gid() == expected.gid()
}
fn owned_socket(value: &Metadata, links: u64) -> bool {
    value.file_type().is_socket()
        && !value.is_symlink()
        && value.nlink() == links
        && value.uid() == nix::unistd::geteuid().as_raw()
        && value.gid() == nix::unistd::getegid().as_raw()
}
fn present(path: &Path, code: &str) -> Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(error(code)),
    }
}
struct Parent {
    path: PathBuf,
    file: File,
    metadata: Metadata,
    ancestors: storage::Ancestors,
}
impl Parent {
    fn open(path: &Path) -> Result<Self> {
        if fs::canonicalize(path).ok().as_deref() != Some(path) {
            return Err(error(PARENT));
        }
        let ancestors = storage::Ancestors::capture(path).map_err(|_| error(PARENT))?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| error(PARENT))?;
        let metadata = file.metadata().map_err(|_| error(PARENT))?;
        let result = Self {
            path: path.into(),
            file,
            metadata,
            ancestors,
        };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<()> {
        self.ancestors
            .assert_open_directory(&self.file)
            .map_err(|_| error(PARENT))?;
        let current = fs::symlink_metadata(&self.path).map_err(|_| error(PARENT))?;
        if !directory_matches(&current, &self.metadata)
            || current.uid() != nix::unistd::geteuid().as_raw()
            || current.gid() != nix::unistd::getegid().as_raw()
            || current.mode() & 0o027 != 0
        {
            return Err(error(PARENT));
        }
        let owner = nix::unistd::geteuid().as_raw();
        let mut protected_child = current;
        let mut ancestor = self.path.parent().unwrap_or(&self.path);
        loop {
            let value = fs::symlink_metadata(ancestor).map_err(|_| error(PARENT))?;
            if !value.is_dir()
                || value.is_symlink()
                || (value.uid() != owner && value.uid() != 0)
                || (value.mode() & 0o022 != 0
                    && !(value.mode() & 0o1000 != 0
                        && (protected_child.uid() == owner || protected_child.uid() == 0)))
            {
                return Err(error(PARENT));
            }
            let Some(next) = ancestor.parent() else {
                break;
            };
            protected_child = value;
            ancestor = next;
        }
        Ok(())
    }
}

pub(super) struct PublishedSocket {
    path: PathBuf,
    parent: Arc<Parent>,
    metadata: Metadata,
}
impl PublishedSocket {
    pub(super) fn path(&self) -> &Path {
        &self.path
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        self.parent.assert_current().map_err(|_| error(CHANGED))?;
        let value = fs::symlink_metadata(&self.path).map_err(|_| error(CHANGED))?;
        if !owned_socket(&value, 1)
            || identity(&value) != identity(&self.metadata)
            || value.mode() & 0o7777 != 0o660
            || value.uid() != self.metadata.uid()
            || value.gid() != self.metadata.gid()
        {
            return Err(error(CHANGED));
        }
        Ok(())
    }
}
impl Drop for PublishedSocket {
    fn drop(&mut self) {
        // On namespace drift retain the name for an operator, rather than
        // following an administrator's new ancestor route while cleaning up.
        if self.parent.assert_current().is_ok()
            && fs::symlink_metadata(&self.path).is_ok_and(|v| {
                v.file_type().is_socket()
                    && v.uid() == self.metadata.uid()
                    && v.gid() == self.metadata.gid()
                    && identity(&v) == identity(&self.metadata)
            })
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[derive(PartialEq, Eq, Debug)]
enum Probe {
    Active,
    Refused,
    Absent,
    Uncertain,
}
fn probe(path: &Path) -> Probe {
    let Ok(address) = UnixAddr::new(path) else {
        return Probe::Uncertain;
    };
    let Ok(fd) = socket(
        AddressFamily::Unix,
        SockType::Stream,
        SockFlag::SOCK_NONBLOCK | SockFlag::SOCK_CLOEXEC,
        None,
    ) else {
        return Probe::Uncertain;
    };
    let stream = UnixStream::from(fd);
    let deadline = Instant::now() + Duration::from_millis(250);
    loop {
        if Instant::now() >= deadline {
            return Probe::Uncertain;
        }
        match connect(stream.as_raw_fd(), &address) {
            Ok(()) | Err(Errno::EISCONN) => return Probe::Active,
            Err(Errno::ECONNREFUSED) => return Probe::Refused,
            Err(Errno::ENOENT) => return Probe::Absent,
            Err(Errno::EINTR) => {}
            // In particular a full listen backlog (EAGAIN) is not evidence
            // that a listener died. Do not retry until a different outcome.
            Err(_) => return Probe::Uncertain,
        }
    }
}
fn remove_stale(path: &Path, parent: &Parent) -> Result<()> {
    let Some(before) = present(path, CONFLICT)? else {
        return Ok(());
    };
    if !owned_socket(&before, 1) {
        return Err(error(CONFLICT));
    }
    match probe(path) {
        Probe::Absent if present(path, CONFLICT)?.is_none() => {
            parent.assert_current()?;
            Ok(())
        }
        Probe::Refused => remove_refused(path, parent, &before),
        _ => Err(error(CONFLICT)),
    }
}
// Private continuation: the production caller reaches this only after a real
// ECONNREFUSED probe. Kept separate to test deterministic post-probe races.
fn remove_refused(path: &Path, parent: &Parent, before: &Metadata) -> Result<()> {
    parent.assert_current()?;
    let after = present(path, CONFLICT)?.ok_or_else(|| error(CONFLICT))?;
    if !owned_socket(&after, 1)
        || identity(&after) != identity(before)
        || after.uid() != before.uid()
        || after.gid() != before.gid()
        || after.mode() != before.mode()
        || after.ctime() != before.ctime()
        || after.ctime_nsec() != before.ctime_nsec()
    {
        return Err(error(CONFLICT));
    }
    fs::remove_file(path).map_err(|_| error(CONFLICT))?;
    Ok(())
}

struct Staging {
    path: PathBuf,
    parent: Arc<Parent>,
    metadata: Metadata,
    socket: Option<Metadata>,
}
impl Staging {
    fn create(parent: &Arc<Parent>) -> Result<Self> {
        // Match the incumbent's nine-byte staging component so valid Unix
        // socket paths do not lose usable sun_path space to a UUID suffix.
        // The random name is not authority: exclusive mkdir and private mode
        // protect it, and collisions never authorize reusing another path.
        const ALPHABET: &[u8; 62] =
            b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
        let mut created = None;
        for _ in 0..32 {
            parent.assert_current()?;
            let mut random = [0; 6];
            getrandom::fill(&mut random).map_err(|_| error(PUBLICATION))?;
            let suffix: String = random
                .into_iter()
                .map(|byte| char::from(ALPHABET[usize::from(byte) % ALPHABET.len()]))
                .collect();
            let path = parent.path.join(format!(".s-{suffix}"));
            match fs::DirBuilder::new().mode(0o700).create(&path) {
                Ok(()) => {
                    created = Some(path);
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(error(PUBLICATION)),
            }
        }
        let path = created.ok_or_else(|| error(PUBLICATION))?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| error(PUBLICATION))?;
        let result = Self {
            path,
            parent: Arc::clone(parent),
            metadata,
            socket: None,
        };
        // A restrictive umask may remove owner bits, but cannot grant access.
        // Pin the actual created inode before installing exact private mode.
        if !result.metadata.is_dir()
            || result.metadata.is_symlink()
            || result.metadata.uid() != nix::unistd::geteuid().as_raw()
            || result.metadata.gid() != nix::unistd::getegid().as_raw()
        {
            return Err(error(PUBLICATION));
        }
        fs::set_permissions(&result.path, fs::Permissions::from_mode(0o700))
            .map_err(|_| error(PUBLICATION))?;
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<()> {
        // Keeping the exact parent alive also guards error/drop cleanup: a
        // symlink back to the same staging inode is still namespace drift.
        self.parent.assert_current()?;
        let current = fs::symlink_metadata(&self.path).map_err(|_| error(PUBLICATION))?;
        if !current.is_dir()
            || current.is_symlink()
            || identity(&current) != identity(&self.metadata)
            || current.uid() != self.metadata.uid()
            || current.gid() != self.metadata.gid()
            || current.mode() & 0o7777 != 0o700
        {
            return Err(error(PUBLICATION));
        }
        Ok(())
    }
    fn clean(&self) -> Result<()> {
        self.assert_current()?;
        if let Some(expected) = &self.socket {
            let path = self.path.join("s");
            let current = present(&path, PUBLICATION)?.ok_or_else(|| error(PUBLICATION))?;
            if !current.file_type().is_socket()
                || identity(&current) != identity(expected)
                || current.uid() != expected.uid()
                || current.gid() != expected.gid()
            {
                return Err(error(PUBLICATION));
            }
            fs::remove_file(path).map_err(|_| error(PUBLICATION))?;
        }
        fs::remove_dir(&self.path).map_err(|_| error(PUBLICATION))?;
        Ok(())
    }
}
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = self.clean();
    }
}

pub(super) fn bind(path: &Path) -> Result<(UnixListener, PublishedSocket)> {
    if !path.is_absolute() || path.as_os_str().as_bytes().contains(&0) || path.file_name().is_none()
    {
        return Err(error("local_state_authority_server_configuration_invalid"));
    }
    let parent = Arc::new(Parent::open(path.parent().ok_or_else(|| error(PARENT))?)?);
    remove_stale(path, &parent)?;
    parent.assert_current()?;
    let mut staging = Staging::create(&parent)?;
    let temporary = staging.path.join("s");
    let listener = UnixListener::bind(&temporary).map_err(|_| error(PUBLICATION))?;
    let provisional = fs::symlink_metadata(&temporary).map_err(|_| error(PUBLICATION))?;
    staging.socket = Some(provisional);
    staging.assert_current()?;
    if !owned_socket(staging.socket.as_ref().unwrap(), 1) {
        return Err(error(PUBLICATION));
    }
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o660))
        .map_err(|_| error(PUBLICATION))?;
    let metadata = fs::symlink_metadata(&temporary).map_err(|_| error(PUBLICATION))?;
    if !owned_socket(&metadata, 1)
        || identity(&metadata) != identity(staging.socket.as_ref().unwrap())
        || metadata.mode() & 0o7777 != 0o660
    {
        return Err(error(PUBLICATION));
    }
    parent.assert_current()?;
    staging.assert_current()?;
    fs::hard_link(&temporary, path).map_err(|e| {
        error(if e.kind() == std::io::ErrorKind::AlreadyExists {
            CONFLICT
        } else {
            PUBLICATION
        })
    })?;
    let published = PublishedSocket {
        path: path.into(),
        parent,
        metadata,
    };
    staging.clean()?;
    published.assert_current()?;
    listener
        .set_nonblocking(true)
        .map_err(|_| error(PUBLICATION))?;
    Ok((listener, published))
}

#[cfg(test)]
mod tests;

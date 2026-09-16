//! Restricted live database handles for authenticated startup reconciliation.
//! Public fixed observations use actual inventory private copies instead.
//! Holding source descriptors and rechecking names is not a descriptor-bound
//! SQLite VFS or an immutable filesystem lease.
use super::*;
mod startup;
#[cfg(test)]
mod tests;
use crate::state_database_inventory::ObservedStateDatabaseInventoryV1;
use nix::fcntl::{OFlag, openat};
use nix::sys::stat::Mode;
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use std::fs::{File, Metadata};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

fn changed() -> RuntimeActivationErrorV1 {
    error("autonomous_research_online_runtime_activation_database_identity_changed")
}
fn unsafe_file() -> RuntimeActivationErrorV1 {
    error("autonomous_research_online_runtime_activation_database_unsafe")
}
fn identity(stat: &Metadata) -> Value {
    json!({"device":stat.dev().to_string(),"inode":stat.ino().to_string(),"mode":stat.mode().to_string(),
        "links":stat.nlink().to_string(),"bytes":stat.len().to_string(),
        "modifiedNs":(i128::from(stat.mtime())*1_000_000_000+i128::from(stat.mtime_nsec())).to_string(),
        "changedNs":(i128::from(stat.ctime())*1_000_000_000+i128::from(stat.ctime_nsec())).to_string()})
}
fn file_safe(stat: &Metadata, role: &str) -> Result<()> {
    if !stat.is_file()
        || stat.mode() & 0o002 != 0
        || (role != "submission-handoff" && stat.mode() & 0o020 != 0)
    {
        return Err(unsafe_file());
    }
    Ok(())
}
fn same_inode(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}
fn relative_path(instance: &Value) -> Result<&Path> {
    let value = instance["sourceRelativePath"]
        .as_str()
        .filter(|v| !v.is_empty() && !v.contains('\0'))
        .ok_or_else(changed)?;
    let path = Path::new(value);
    if value
        .split('/')
        .any(|c| c.is_empty() || c == "." || c == "..")
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || path.is_absolute()
    {
        return Err(changed());
    }
    Ok(path)
}
struct Parent {
    path: PathBuf,
    held: File,
}
impl Parent {
    fn assert_current(&self) -> Result<()> {
        let named = std::fs::symlink_metadata(&self.path).map_err(|_| changed())?;
        let held = self.held.metadata().map_err(|_| changed())?;
        if !named.is_dir() || named.file_type().is_symlink() || !same_inode(&named, &held) {
            return Err(changed());
        }
        Ok(())
    }
}
fn parents(runtime_root: &Path, relative: &Path) -> Result<(Vec<Parent>, PathBuf)> {
    let root = if runtime_root.is_absolute() {
        runtime_root.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|_| changed())?
            .join(runtime_root)
    };
    // Deliberately reject symlink components and dot traversal. Node permits
    // some lexically unusual paths; the native supported path profile is exact.
    if root
        .components()
        .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
    {
        return Err(changed());
    }
    let mut parent = Parent {
        path: PathBuf::from("/"),
        held: File::open("/").map_err(|_| changed())?,
    };
    let mut chain = Vec::new();
    let directory_path = root.join(relative.parent().ok_or_else(changed)?);
    for component in directory_path.components() {
        let Component::Normal(name) = component else {
            continue;
        };
        parent.assert_current()?;
        let held = File::from(
            openat(
                &parent.held,
                name,
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| changed())?,
        );
        let path = parent.path.join(name);
        chain.push(parent);
        parent = Parent { path, held };
    }
    let path = parent.path.join(relative.file_name().ok_or_else(changed)?);
    chain.push(parent);
    Ok((chain, path))
}
/// No public constructor or arbitrary connection callback. Fixed in-crate
/// recovery operations require real pinned authorities and coordinator checks.
/// This raw live handle is never exposed as readonly inventory evidence.
pub(crate) struct LiveActivationDatabaseV1 {
    connection: Connection,
    held: File,
    path: PathBuf,
    parents: Vec<Parent>,
    role: String,
    snapshot: Value,
}
impl LiveActivationDatabaseV1 {
    fn metadata(&self) -> Result<Metadata> {
        for parent in &self.parents {
            parent.assert_current()?;
        }
        let named = std::fs::symlink_metadata(&self.path).map_err(|_| changed())?;
        let held = self.held.metadata().map_err(|_| changed())?;
        file_safe(&held, &self.role)?;
        if named.file_type().is_symlink()
            || !same_inode(&named, &held)
            || identity(&named) != identity(&held)
        {
            return Err(changed());
        }
        Ok(held)
    }
    pub(crate) fn assert_current(&self) -> Result<()> {
        if identity(&self.metadata()?) != self.snapshot {
            return Err(changed());
        }
        Ok(())
    }
}
// Private core. Only the opaque-inventory constructor below calls this in
// production; tests use the hook to force deterministic namespace races.
fn open_live_activation_database_with_hook_v1(
    runtime_root: &Path,
    instance: &Value,
    before_sqlite_open: impl FnOnce(),
) -> Result<LiveActivationDatabaseV1> {
    let relative = relative_path(instance)?;
    let (parents, path) = parents(runtime_root, relative)?;
    let parent = parents.last().ok_or_else(changed)?;
    let named = std::fs::symlink_metadata(&path).map_err(|_| changed())?;
    let role = instance["role"].as_str().unwrap_or_default().to_owned();
    file_safe(&named, &role)?;
    if named.file_type().is_symlink() {
        return Err(unsafe_file());
    }
    let held = File::from(
        openat(
            &parent.held,
            relative.file_name().ok_or_else(changed)?,
            OFlag::O_RDWR | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| changed())?,
    );
    let stat = held.metadata().map_err(|_| changed())?;
    file_safe(&stat, &role)?;
    let snapshot = identity(&stat);
    if !same_inode(&named, &stat) || snapshot != instance["sourceFileIdentity"] {
        return Err(changed());
    }
    before_sqlite_open();
    for parent in &parents {
        parent.assert_current()?;
    }
    if identity(&std::fs::symlink_metadata(&path).map_err(|_| changed())?) != snapshot {
        return Err(changed());
    }
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|e| {
        error(format!(
            "autonomous_research_online_runtime_activation_database_open_failed:{e}"
        ))
    })?;
    let opened = LiveActivationDatabaseV1 {
        connection,
        held,
        path,
        parents,
        role,
        snapshot,
    };
    opened.assert_current()?;
    Ok(opened)
}
/// Rechecks one instance from a real previously observed inventory. This permits
/// the reconciler's already-authorized writes to other instances while requiring
/// the selected source and sidecars to remain exactly as observed. The caller
/// must compare a fresh complete inventory after reconciling all instances.
pub(crate) fn open_live_activation_database_v1(
    inventory: &ObservedStateDatabaseInventoryV1,
    instance_id: &str,
) -> Result<LiveActivationDatabaseV1> {
    let instance = inventory
        .current_database_instance(instance_id)
        .map_err(|e| error(e.to_string()))?;
    open_live_activation_database_with_hook_v1(inventory.runtime_root(), instance, || {})
}

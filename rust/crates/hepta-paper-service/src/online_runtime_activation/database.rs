//! Existing-database opening with held descriptors and identity rechecks.
//! A snapshot is not a future immutability lease. This module does not create a
//! database, install schema, reconcile an authority, or authorize online writes.
use super::*;
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
/// Only fixed observations are public. Each use rechecks the name and
/// held descriptor; post-action checks permit content changes while rejecting
/// file replacement, permission/link changes and directory rebinding.
pub struct ActivationDatabaseV1 {
    connection: Connection,
    held: File,
    path: PathBuf,
    parents: Vec<Parent>,
    role: String,
    snapshot: Value,
}
impl ActivationDatabaseV1 {
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
    pub fn observed_identity(&self) -> &Value {
        &self.snapshot
    }
    pub fn assert_current(&self) -> Result<()> {
        if identity(&self.metadata()?) != self.snapshot {
            return Err(changed());
        }
        Ok(())
    }
    /// Observe SQLite's live schema and integrity using fixed read statements.
    /// This is local evidence only, never backup or authority qualification.
    pub fn inspect(&mut self) -> Result<Value> {
        self.with_connection(|db| {
            let query = |sql: &str| -> Result<i64> { db.query_row(sql, [], |r| r.get(0)).map_err(|e| error(e.to_string())) };
            let quick: String = db.query_row("PRAGMA quick_check;", [], |r| r.get(0)).map_err(|e| error(e.to_string()))?;
            let mut statement = db.prepare("PRAGMA foreign_key_check;").map_err(|e| error(e.to_string()))?;
            let mut rows = statement.query([]).map_err(|e| error(e.to_string()))?;
            let mut foreign_key_count = 0_u64;
            while rows.next().map_err(|e| error(e.to_string()))?.is_some() { foreign_key_count += 1; }
            let schema_hash = crate::sqlite_mutation_coordinator::storage::exact_schema_hash_v1(db).map_err(|e| error(e.to_string()))?;
            Ok(json!({"quickCheck":quick,"foreignKeyViolationCount":foreign_key_count,"schemaHash":schema_hash,
                "userVersion":query("PRAGMA user_version;")?,"applicationId":query("PRAGMA application_id;")?}))
        })
    }

    fn with_connection<R>(
        &mut self,
        action: impl FnOnce(&mut Connection) -> Result<R>,
    ) -> Result<R> {
        self.assert_current()?;
        let previous = self.snapshot.clone();
        let result = action(&mut self.connection);
        let next = identity(&self.metadata()?);
        if ["device", "inode", "mode", "links"]
            .iter()
            .any(|k| previous[k] != next[k])
        {
            return Err(changed());
        }
        self.snapshot = next;
        result
    }
}
/// Open an existing SQLite database against the inventory's exact file identity.
/// The hook is an observation seam for deterministic race tests, not authority.
pub fn open_runtime_activation_database_with_hook_v1(
    runtime_root: &Path,
    instance: &Value,
    before_sqlite_open: impl FnOnce(),
) -> Result<ActivationDatabaseV1> {
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
    let opened = ActivationDatabaseV1 {
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
pub fn open_runtime_activation_database_v1(
    runtime_root: &Path,
    instance: &Value,
) -> Result<ActivationDatabaseV1> {
    open_runtime_activation_database_with_hook_v1(runtime_root, instance, || {})
}

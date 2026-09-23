//! SQLite may resolve /proc/self/fd back to a mutable source pathname. Copy the
//! already pinned bytes into a private file first, so no SQLite read reopens the
//! source. This is a bounded observation, not a same-user exclusion lease.
use super::*;
use rusqlite::{Connection, OpenFlags};
use std::{
    fs::{File, Metadata, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
};
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_state_backup_source_database_invalid")
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.nlink() == b.nlink()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
pub(super) struct PrivateSqliteSnapshot {
    root: PathBuf,
    root_identity: Metadata,
    path: PathBuf,
    file: File,
    identity: Metadata,
}
impl PrivateSqliteSnapshot {
    pub fn new(source: &Snapshot) -> Result<Self> {
        source.assert_current().map_err(|_| invalid())?;
        let base = fs::canonicalize(std::env::temp_dir()).map_err(|_| invalid())?;
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| invalid())?;
        let root = base.join(format!(
            "hepta-verified-restore-source-{}",
            hex::encode(random)
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .map_err(|_| invalid())?;
        let root_identity = fs::symlink_metadata(&root).map_err(|_| invalid())?;
        if !root_identity.is_dir()
            || root_identity.mode() & 0o777 != 0o700
            || root_identity.uid() != nix::unistd::getuid().as_raw()
        {
            return Err(invalid());
        }
        let path = root.join("snapshot.sqlite");
        let mut file = match OpenOptions::new()
            .write(true)
            .read(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(&path)
        {
            Ok(f) => f,
            Err(_) => {
                let _ = fs::remove_dir(&root);
                return Err(invalid());
            }
        };
        if file.write_all(source.bytes()).is_err() {
            let _ = fs::remove_file(&path);
            let _ = fs::remove_dir(&root);
            return Err(invalid());
        }
        let identity = file.metadata().map_err(|_| invalid())?;
        let copied = Self {
            root,
            root_identity,
            path,
            file,
            identity,
        };
        copied.assert_current()?;
        source.assert_current().map_err(|_| invalid())?;
        Ok(copied)
    }
    pub fn assert_current(&self) -> Result<()> {
        let root = fs::symlink_metadata(&self.root).map_err(|_| invalid())?;
        let file = fs::symlink_metadata(&self.path).map_err(|_| invalid())?;
        let held = self.file.metadata().map_err(|_| invalid())?;
        if !root.is_dir()
            || root.is_symlink()
            || root.dev() != self.root_identity.dev()
            || root.ino() != self.root_identity.ino()
            || root.mode() & 0o777 != 0o700
            || root.uid() != self.root_identity.uid()
            || file.is_symlink()
            || !same(&file, &self.identity)
            || !same(&held, &self.identity)
            || held.nlink() != 1
            || held.mode() & 0o777 != 0o600
        {
            return Err(invalid());
        }
        for suffix in ["-wal", "-shm", "-journal"] {
            if !absent(&PathBuf::from(format!("{}{suffix}", self.path.display()))) {
                return Err(invalid());
            }
        }
        Ok(())
    }
    pub fn open(&self) -> Result<Connection> {
        use std::os::unix::ffi::OsStrExt;
        self.assert_current()?;
        let mut encoded = String::new();
        for byte in self.path.as_os_str().as_bytes() {
            if byte.is_ascii_alphanumeric() || b"/._-".contains(byte) {
                encoded.push(char::from(*byte));
            } else {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
        let database = Connection::open_with_flags(
            format!("file:{encoded}?mode=ro&immutable=1"),
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NOFOLLOW
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| invalid())?;
        database
            .pragma_update(None, "trusted_schema", false)
            .map_err(|_| invalid())?;
        self.assert_current()?;
        Ok(database)
    }
}
impl Drop for PrivateSqliteSnapshot {
    fn drop(&mut self) {
        // Remove only the paths still naming this allocation. Unknown replacement
        // files and extra directory entries are preserved instead of recursively removed.
        let owned_root = fs::symlink_metadata(&self.root).is_ok_and(|m| {
            m.is_dir()
                && !m.is_symlink()
                && m.dev() == self.root_identity.dev()
                && m.ino() == self.root_identity.ino()
        });
        if owned_root {
            if fs::symlink_metadata(&self.path).is_ok_and(|m| {
                m.is_file()
                    && !m.is_symlink()
                    && m.dev() == self.identity.dev()
                    && m.ino() == self.identity.ino()
            }) {
                let _ = fs::remove_file(&self.path);
            }
            let _ = fs::remove_dir(&self.root);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn fixture() -> (PathBuf, Snapshot) {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).unwrap();
        let root =
            std::env::temp_dir().join(format!("hepta-source-copy-test-{}", hex::encode(bytes)));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let file = root.join("original.sqlite");
        let db = Connection::open(&file).unwrap();
        db.execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO records VALUES(1,'pinned');").unwrap();
        drop(db);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let pin = crate::sqlite_mutation_coordinator::hash_bytes(&fs::read(&file).unwrap());
        let snapshot = Snapshot::load(&file, &pin, 1024 * 1024, "fixture").unwrap();
        (root, snapshot)
    }
    #[test]
    fn source_parent_aba_cannot_change_the_sqlite_bytes_being_inspected() {
        let (root, snapshot) = fixture();
        let copied = PrivateSqliteSnapshot::new(&snapshot).unwrap();
        let moved = root.with_extension("held");
        fs::rename(&root, &moved).unwrap();
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let alternate = Connection::open(root.join("original.sqlite")).unwrap();
        alternate.execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO records VALUES(1,'substituted');").unwrap();
        drop(alternate);
        let database = copied.open().unwrap();
        let observed: String = database
            .query_row("SELECT value FROM records WHERE id=1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(observed, "pinned");
        drop(database);
        fs::remove_dir_all(&root).unwrap();
        fs::rename(&moved, &root).unwrap();
        snapshot.assert_current().unwrap();
        copied.assert_current().unwrap();
        let copy_root = copied.root.clone();
        drop(copied);
        assert!(!copy_root.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn private_copy_rebinding_is_rejected_and_competing_bytes_are_not_deleted() {
        let (root, snapshot) = fixture();
        let copied = PrivateSqliteSnapshot::new(&snapshot).unwrap();
        let moved = copied.path.with_extension("held");
        fs::rename(&copied.path, &moved).unwrap();
        fs::write(&copied.path, b"competing file").unwrap();
        assert!(copied.open().is_err());
        let copy_root = copied.root.clone();
        let copy_path = copied.path.clone();
        drop(copied);
        assert_eq!(fs::read(copy_path).unwrap(), b"competing file");
        fs::remove_dir_all(copy_root).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

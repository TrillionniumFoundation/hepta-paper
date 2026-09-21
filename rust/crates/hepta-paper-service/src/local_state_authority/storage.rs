//! Inputs are captured before SQLite and retained until after its connection
//! closes. A native journal is never silently substituted for an old Node DB.
use super::*;
use ed25519_dalek::pkcs8::DecodePrivateKey;
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};
use zeroize::Zeroizing;

pub(super) use super::configuration::validate_configuration;
fn fresh_snapshot(path: &Path, maximum: u64, code: &str) -> Result<Snapshot> {
    // There is no SQLite handle yet. Temporary hashing descriptors close here.
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| error(code))?;
    let metadata = file.metadata().map_err(|_| error(code))?;
    if !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > maximum
        || metadata.nlink() != 1
    {
        return Err(error(code));
    }
    let mut bytes = Zeroizing::new(Vec::new());
    (&mut file)
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error(code))?;
    if bytes.len() as u64 != metadata.len() {
        return Err(error(code));
    }
    let pin = hash_bytes(&bytes);
    drop(file);
    Snapshot::load(path, &pin, maximum, code)
}
pub(super) struct Inputs {
    configuration: Snapshot,
    key: Snapshot,
    parent_path: PathBuf,
    parent: File,
    parent_identity: Metadata,
    ancestors: Ancestors,
    database: Option<DatabaseIdentity>,
}
pub(super) struct DatabaseIdentity {
    path: PathBuf,
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
}

/// Pre-open observations of the complete directory namespace. No descriptor is
/// created or cloned here; current checks remain safe while SQLite holds locks.
/// Directory contents may change normally (mtime/nlink are deliberately absent).
pub(super) struct Ancestors {
    directories: Vec<(PathBuf, DirectoryIdentity)>,
}
struct DirectoryIdentity {
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    gid: u32,
}
impl DirectoryIdentity {
    fn from_metadata(value: &Metadata) -> Self {
        Self {
            device: value.dev(),
            inode: value.ino(),
            mode: value.mode(),
            uid: value.uid(),
            gid: value.gid(),
        }
    }
    fn matches(&self, value: &Metadata) -> bool {
        value.is_dir()
            && !value.is_symlink()
            && value.dev() == self.device
            && value.ino() == self.inode
            && value.mode() == self.mode
            && value.uid() == self.uid
            && value.gid() == self.gid
    }
}
impl Ancestors {
    pub(super) fn capture(directory: &Path) -> Result<Self> {
        let code = "local_state_authority_directory_namespace_invalid";
        if !directory.is_absolute()
            || directory
                .components()
                .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
        {
            return Err(error(code));
        }
        let mut paths = directory.ancestors().collect::<Vec<_>>();
        paths.reverse();
        let mut directories = Vec::with_capacity(paths.len());
        for path in paths {
            // Inspect each prefix itself, rather than lstat only at the leaf:
            // lstat of a leaf would still follow symlinks in earlier components.
            let value = fs::symlink_metadata(path).map_err(|_| error(code))?;
            if !value.is_dir() || value.is_symlink() {
                return Err(error(code));
            }
            directories.push((path.to_path_buf(), DirectoryIdentity::from_metadata(&value)));
        }
        let result = Self { directories };
        result.assert_current()?;
        Ok(result)
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        let code = "local_state_authority_directory_namespace_changed";
        for (path, expected) in &self.directories {
            let value = fs::symlink_metadata(path).map_err(|_| error(code))?;
            if !expected.matches(&value) {
                return Err(error(code));
            }
        }
        Ok(())
    }
    /// Bind the already-opened final directory to the same observation. This
    /// takes only metadata from its held FD and performs named lstat checks.
    pub(super) fn assert_open_directory(&self, directory: &File) -> Result<()> {
        self.assert_current()?;
        let code = "local_state_authority_directory_namespace_changed";
        let value = directory.metadata().map_err(|_| error(code))?;
        if !self
            .directories
            .last()
            .is_some_and(|(_, expected)| expected.matches(&value))
        {
            return Err(error(code));
        }
        Ok(())
    }
}
impl Inputs {
    pub(super) fn load(path: &Path) -> Result<(Self, Context)> {
        let code = "local_state_authority_configuration_invalid";
        let configuration = fresh_snapshot(path, 1024 * 1024, code)?;
        let value = configuration.json(code)?;
        validate_configuration(&value)?;
        let key_code = "local_state_authority_private_key_invalid";
        let mut key = fresh_snapshot(
            Path::new(text(&value, "privateKeyPath")?),
            64 * 1024,
            key_code,
        )?;
        let key_meta = key.file.metadata().map_err(|_| error(key_code))?;
        if key_meta.mode() & 0o077 != 0 || key_meta.uid() != nix::unistd::geteuid().as_raw() {
            key.clear_secret_bytes();
            return Err(error(key_code));
        }
        let decoded = std::str::from_utf8(key.bytes())
            .ok()
            .and_then(|pem| SigningKey::from_pkcs8_pem(pem).ok());
        key.clear_secret_bytes();
        let signing_key = decoded.ok_or_else(|| error(key_code))?;
        let parent_path = Path::new(text(&value, "stateDatabasePath")?)
            .parent()
            .ok_or_else(|| error(code))?
            .to_path_buf();
        // Installation/provisioning must create this private directory first.
        // Do not recursively create through a potentially replaced namespace.
        if fs::canonicalize(&parent_path).ok().as_ref() != Some(&parent_path) {
            return Err(error("local_state_authority_state_directory_invalid"));
        }
        let ancestors = Ancestors::capture(&parent_path)?;
        let parent = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(&parent_path)
            .map_err(|_| error("local_state_authority_state_directory_invalid"))?;
        let parent_identity = parent.metadata().map_err(|_| error(code))?;
        let result = Self {
            configuration,
            key,
            parent_path,
            parent,
            parent_identity,
            ancestors,
            database: None,
        };
        result.assert_current()?;
        Ok((result, Context::new(value, signing_key)?))
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        self.ancestors.assert_open_directory(&self.parent)?;
        self.configuration.assert_current()?;
        self.key.assert_current()?;
        if let Some(db) = &self.database {
            let value = fs::symlink_metadata(&db.path)
                .map_err(|_| error("local_state_authority_state_database_changed"))?;
            if !value.is_file()
                || value.mode() & 0o7777 != 0o600
                || value.nlink() != 1
                || value.uid() != db.uid
                || value.gid() != db.gid
                || value.dev() != db.device
                || value.ino() != db.inode
            {
                return Err(error("local_state_authority_state_database_changed"));
            }
        }
        let code = "local_state_authority_state_directory_changed";
        for value in [
            self.parent.metadata().map_err(|_| error(code))?,
            fs::symlink_metadata(&self.parent_path).map_err(|_| error(code))?,
        ] {
            if !value.is_dir()
                || value.mode() & 0o7777 != 0o700
                || value.uid() != nix::unistd::geteuid().as_raw()
                || value.dev() != self.parent_identity.dev()
                || value.ino() != self.parent_identity.ino()
                || value.gid() != self.parent_identity.gid()
            {
                return Err(error(code));
            }
        }
        Ok(())
    }
    pub(super) fn bind_database(&mut self, identity: DatabaseIdentity) -> Result<()> {
        self.database = Some(identity);
        self.assert_current()
    }
}

pub(super) fn open_database(context: &Context) -> Result<(Connection, DatabaseIdentity)> {
    let path = Path::new(text(&context.configuration, "stateDatabasePath")?);
    let code = "local_state_authority_state_database_invalid";
    // Create only one private file, with no overwrite. Close this raw descriptor
    // before SQLite can acquire either main-file or WAL locks.
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => drop(file),
        Err(cause) if cause.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(error(code)),
    }
    let before = fs::symlink_metadata(path).map_err(|_| error(code))?;
    if !before.is_file()
        || before.nlink() != 1
        || before.mode() & 0o7777 != 0o600
        || before.uid() != nix::unistd::geteuid().as_raw()
    {
        return Err(error(code));
    }
    let mut db = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let count: i64 = db.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        [],
        |r| r.get(0),
    )?;
    if !(version == 1 || (version == 0 && count == 0)) {
        return Err(error(
            "local_state_authority_explicit_journal_migration_required",
        ));
    }
    if version == 1 {
        assert_schema(&db)?;
    }
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if count == 0 {
        tx.execute_batch(include_str!("schema.sql"))?;
        let config = &context.configuration;
        let genesis = hash(
            "HeptaLocalStateAuthorityGenesisGlobalHead",
            &json!({
            "authorityId":config["authorityId"],"keyId":config["keyId"],"scopeId":config["scopeId"],
            "databaseScopeHash":config["databaseScopeHash"],"writerManifestHash":config["writerManifestHash"]}),
        )?;
        tx.execute(
            "INSERT INTO authority_metadata VALUES(1,?,?,?,?,?,?,0,?,'uninitialized')",
            rusqlite::params![
                hash(
                    "HeptaLocalAutonomousResearchStateAuthorityConfiguration",
                    config
                )?,
                text(config, "authorityId")?,
                text(config, "keyId")?,
                text(config, "scopeId")?,
                text(config, "databaseScopeHash")?,
                text(config, "writerManifestHash")?,
                genesis
            ],
        )?;
        tx.execute(
            "INSERT INTO authority_native_identity VALUES(1,?)",
            [hash_bytes(context.signing_key.verifying_key().as_bytes())],
        )?;
        tx.pragma_update(None, "user_version", 1)?;
    }
    let config = &context.configuration;
    let key_hash: String = tx.query_row(
        "SELECT key_hash FROM authority_native_identity WHERE singleton=1",
        [],
        |r| r.get(0),
    )?;
    if key_hash != hash_bytes(context.signing_key.verifying_key().as_bytes()) {
        return Err(error("local_state_authority_persisted_identity_mismatch"));
    }
    super::schema_rebind::activate_finalized(&tx, context)?;
    let current = metadata(&tx)?;
    if current.configuration_hash
        != hash(
            "HeptaLocalAutonomousResearchStateAuthorityConfiguration",
            config,
        )?
        || current.authority_id != text(config, "authorityId")?
        || current.key_id != text(config, "keyId")?
        || current.scope_id != text(config, "scopeId")?
        || current.database_scope_hash != text(config, "databaseScopeHash")?
        || current.writer_manifest_hash != text(config, "writerManifestHash")?
    {
        return Err(error("local_state_authority_persisted_identity_mismatch"));
    }
    tx.commit()?;
    let after = fs::symlink_metadata(path).map_err(|_| error(code))?;
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || after.nlink() != 1
        || after.mode() & 0o7777 != 0o600
        || before.uid() != after.uid()
    {
        return Err(error(code));
    }
    Ok((
        db,
        DatabaseIdentity {
            path: path.into(),
            device: before.dev(),
            inode: before.ino(),
            uid: before.uid(),
            gid: before.gid(),
        },
    ))
}

pub(super) fn assert_schema(db: &Connection) -> Result<()> {
    type SchemaRow = (String, String, String, Option<String>);
    fn rows(db: &Connection) -> Result<Vec<SchemaRow>> {
        let mut query = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")?;
        Ok(query
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }
    // A memory-only reference opens no descriptor that can alias the journal.
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(include_str!("schema.sql"))?;
    if rows(db)? != rows(&expected)? {
        return Err(error("local_state_authority_native_schema_invalid"));
    }
    Ok(())
}

#[cfg(test)]
mod tests;

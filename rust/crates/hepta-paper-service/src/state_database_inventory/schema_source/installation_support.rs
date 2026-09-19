//! Private live handles for the installation owner. No public callback can
//! borrow/replace a SQLite connection or mint an installation capability.
use super::*;
use rusqlite::limits::Limit;
use std::os::unix::fs::FileExt;
pub(crate) struct LockedSchemaDatabase {
    source: SchemaSource,
    connection: Connection,
    owner: (u32, u32),
}
impl SchemaSource {
    pub(crate) fn installation_bytes(&self, expected_sha: &str) -> Result<Vec<u8>> {
        self.assert_current()?;
        ensure(
            self.database.wal.is_none()
                && self.database.shm.is_none()
                && self.database.source.sha256 == expected_sha,
            "autonomous_research_online_schema_transition_normalized_source_mismatch",
        )?;
        let file = &self.database.source.file;
        let len = file.metadata().map_err(|_| files::changed())?.len();
        ensure(
            len <= files::MAX_FILE_BYTES,
            "autonomous_research_online_schema_transition_preimage_limit",
        )?;
        let mut bytes = vec![0u8; usize::try_from(len).map_err(|_| files::changed())?];
        file.read_exact_at(&mut bytes, 0)
            .map_err(|_| files::changed())?;
        ensure(
            crate::sqlite_mutation_coordinator::hash_bytes(&bytes) == expected_sha,
            "autonomous_research_online_schema_transition_normalized_source_mismatch",
        )?;
        self.assert_current()?;
        Ok(bytes)
    }
    pub(crate) fn installation_memory_copy(&self, expected_sha: &str) -> Result<Connection> {
        self.installation_memory_copy_inner(expected_sha, &mut |_| Ok(()))
    }
    fn installation_memory_copy_inner(
        &self,
        expected_sha: &str,
        checkpoint: &mut dyn FnMut(&str) -> Result<()>,
    ) -> Result<Connection> {
        self.installation_bytes(expected_sha)?;
        // Copy from the held descriptor and verify the destination's complete
        // signed hash before giving SQLite any name. Never reopen the public
        // preimage path and assume it still names the bytes verified above.
        let candidate = copy::MutableCopy::create(&self.database)?;
        candidate.assert_no_sidecars()?;
        ensure(
            candidate.sha256()? == expected_sha,
            "autonomous_research_online_schema_transition_preimage_invalid",
        )?;
        checkpoint("before_private_open")?;
        let origin = Connection::open_with_flags(
            candidate.path(),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        origin.busy_timeout(std::time::Duration::ZERO)?;
        origin.execute_batch("PRAGMA trusted_schema=OFF; BEGIN DEFERRED;")?;
        let mut target = Connection::open_in_memory()?;
        {
            let backup = rusqlite::backup::Backup::new(&origin, &mut target)?;
            backup.run_to_completion(128, std::time::Duration::ZERO, None)?;
        }
        origin.execute_batch("ROLLBACK;")?;
        drop(origin);
        checkpoint("after_private_backup")?;
        candidate.assert_no_sidecars()?;
        candidate.assert_owned()?;
        ensure(
            candidate.sha256()? == expected_sha,
            "autonomous_research_online_schema_transition_preimage_invalid",
        )?;
        self.assert_current()?;
        configure(&target)?;
        Ok(target)
    }
    pub(crate) fn installation_identity(&self, row: &Value, root: &Value) -> Result<()> {
        self.normalization_support_stable_installation()?;
        ensure(
            &self.root_identity == root
                && self.description["sourceFileIdentityHash"] == row["sourceFileIdentityHash"]
                && self.description["sourceRelativePath"] == row["sourceRelativePath"]
                && self.description["databaseRole"] == row["databaseRole"],
            "autonomous_research_online_schema_transition_database_identity_changed",
        )
    }
    // This deliberately allows expected file-length/content changes but never
    // allows a different inode, permissions, hardlink or directory identity.
    fn normalization_support_stable_installation(&self) -> Result<()> {
        for parent in self.ancestors.iter().chain(&self.database.parents) {
            parent.assert_current()?;
        }
        ensure(
            root_identity(self.ancestors.last().ok_or_else(files::changed)?)? == self.root_identity,
            "autonomous_research_online_schema_transition_runtime_root_identity_changed",
        )?;
        let named =
            std::fs::symlink_metadata(&self.database.source.path).map_err(|_| files::changed())?;
        let held = self
            .database
            .source
            .file
            .metadata()
            .map_err(|_| files::changed())?;
        let before = &self.database.source.metadata;
        for stat in [&named, &held] {
            let now = files::identity(stat);
            ensure(
                stat.is_file()
                    && !stat.file_type().is_symlink()
                    && stat.nlink() == 1
                    && ["device", "inode", "mode"]
                        .iter()
                        .all(|k| now[*k] == before[*k]),
                "autonomous_research_online_schema_transition_database_identity_changed",
            )?;
        }
        Ok(())
    }
}
fn configure(connection: &Connection) -> Result<()> {
    connection.busy_timeout(std::time::Duration::ZERO)?;
    connection.set_limit(
        Limit::SQLITE_LIMIT_LENGTH,
        connection
            .limit(Limit::SQLITE_LIMIT_LENGTH)?
            .min(16 * 1024 * 1024),
    )?;
    connection.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;")?;
    Ok(())
}
impl LockedSchemaDatabase {
    pub(crate) fn acquire(source: SchemaSource, row: &Value, root: &Value) -> Result<Self> {
        source.assert_current()?;
        source.installation_identity(row, root)?;
        ensure(
            source.database.wal.is_none() && source.database.shm.is_none(),
            "autonomous_research_online_schema_transition_wal_or_shm_present",
        )?;
        let connection = Connection::open_with_flags(
            &source.database.source.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        configure(&connection)?;
        let mode: String = connection.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
        ensure(
            mode == "delete",
            "autonomous_research_online_schema_transition_journal_mode_invalid",
        )?;
        let locking: String =
            connection.query_row("PRAGMA locking_mode=EXCLUSIVE", [], |r| r.get(0))?;
        ensure(
            locking == "exclusive",
            "autonomous_research_online_schema_transition_locking_mode_invalid",
        )?;
        connection.execute_batch("BEGIN EXCLUSIVE;")?;
        let stat = source
            .database
            .source
            .file
            .metadata()
            .map_err(|_| files::changed())?;
        let result = Self {
            source,
            connection,
            owner: (stat.uid(), stat.gid()),
        };
        result.source.assert_current()?;
        result.assert_identity(row, root)?;
        Ok(result)
    }
    pub(crate) fn observed_sha256(&self) -> &str {
        &self.source.database.source.sha256
    }
    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }
    pub(crate) fn connection_mut(&mut self) -> &mut Connection {
        &mut self.connection
    }
    pub(crate) fn assert_identity(&self, row: &Value, root: &Value) -> Result<()> {
        self.source.installation_identity(row, root)?;
        for stat in [
            self.source.database.source.file.metadata(),
            std::fs::symlink_metadata(&self.source.database.source.path),
        ] {
            let stat = stat.map_err(|_| files::changed())?;
            ensure(
                (stat.uid(), stat.gid()) == self.owner,
                "autonomous_research_online_schema_transition_database_identity_changed",
            )?;
        }
        Ok(())
    }
    pub(crate) fn commit(
        &mut self,
        row: &Value,
        root: &Value,
        final_guard: &mut dyn FnMut() -> Result<()>,
    ) -> Result<()> {
        self.assert_identity(row, root)?;
        ensure(
            !self.connection.is_autocommit(),
            "autonomous_research_online_schema_transition_installation_transaction_required",
        )?;
        final_guard()?;
        self.connection.execute_batch("COMMIT;")?;
        self.source
            .database
            .source
            .file
            .sync_all()
            .map_err(|_| files::changed())?;
        self.assert_identity(row, root)
    }
    pub(crate) fn assert_namespace(&self, manifest: &Value, instances: &Value) -> Result<()> {
        self.source.assert_registered_namespace(manifest, instances)
    }
    pub(crate) fn begin_exclusive_again(&self) -> Result<()> {
        ensure(
            self.connection.is_autocommit(),
            "autonomous_research_online_schema_transition_installation_transaction_required",
        )?;
        self.connection.execute_batch("BEGIN EXCLUSIVE;")?;
        Ok(())
    }
}
impl Drop for LockedSchemaDatabase {
    fn drop(&mut self) {
        if !self.connection.is_autocommit() {
            let _ = self.connection.execute_batch("ROLLBACK;");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn signed_preimage_private_copy_survives_public_parent_aba_without_copying_foreign_rows() {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).unwrap();
        let root =
            std::env::temp_dir().join(format!("hepta-installation-copy-{}", hex::encode(nonce)));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        for (name, value) in [("current", "signed"), ("foreign", "foreign")] {
            let path = root.join(name);
            std::fs::create_dir(&path).unwrap();
            let database = Connection::open(path.join("source.preimage")).unwrap();
            database
                .execute_batch("CREATE TABLE business(value TEXT);")
                .unwrap();
            database
                .execute("INSERT INTO business VALUES(?)", [value])
                .unwrap();
            drop(database);
        }
        let current = root.join("current");
        let foreign = root.join("foreign");
        let saved = root.join("saved");
        let source =
            SchemaSource::observe(&current, Path::new("source.preimage"), "native-store").unwrap();
        let sha = source.normalization_state()["sourceSha256"]
            .as_str()
            .unwrap()
            .to_owned();
        let copy = source
            .installation_memory_copy_inner(&sha, &mut |phase| {
                if phase == "before_private_open" {
                    std::fs::rename(&current, &saved).unwrap();
                    std::fs::rename(&foreign, &current).unwrap();
                } else {
                    std::fs::rename(&current, &foreign).unwrap();
                    std::fs::rename(&saved, &current).unwrap();
                }
                Ok(())
            })
            .unwrap();
        let actual: String = copy
            .query_row("SELECT value FROM business", [], |r| r.get(0))
            .unwrap();
        assert_eq!(actual, "signed");
        drop(copy);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }
}

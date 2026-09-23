//! Durable, compare-and-exchange publication for the schema transition audit receipt.
//! The receipt is only a serialized record; loading it never creates authority or
//! an activation capability. Historical signatures must be checked by the caller.
use super::*;
use crate::state_database_inventory::schema_source::maintenance_lock::SchemaMaintenanceLock;
const NAME: &str = "FINAL.json";
const MAX_BYTES: usize = 16 * 1024 * 1024;

pub(crate) struct SchemaFinalizationRepository<'a> {
    root: &'a SchemaMaintenanceLock,
    directory: publication::Directory,
}
impl<'a> SchemaFinalizationRepository<'a> {
    pub(crate) fn open(root: &'a SchemaMaintenanceLock, create: bool) -> Result<Self> {
        root.assert_current()?;
        let directory = publication::Directory::open_or_create(
            &root
                .runtime_root()?
                .join("autonomous-research/online-schema-transition"),
            create,
        )?;
        let result = Self { root, directory };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<()> {
        self.root.assert_current()?;
        self.directory.assert_current()
    }
    pub(crate) fn load(&self) -> Result<Option<(Value, Vec<u8>, String)>> {
        self.assert_current()?;
        let path = self.directory.path.join(NAME);
        if matches!(std::fs::symlink_metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(None);
        }
        let observed = files::ObservedFile::open(&path, MAX_BYTES as u64)?;
        let bytes = observed.bytes(MAX_BYTES as u64)?;
        let value = crate::sqlite_mutation_coordinator::authority::files::parse(
            &bytes,
            "autonomous_research_online_schema_transition_final_receipt_invalid",
        )?;
        observed.assert_current()?;
        self.assert_current()?;
        let digest = hash_bytes(&bytes);
        Ok(Some((value, bytes, digest)))
    }
    /// Publish with the held-directory CAS lock. Existing bytes are replaced only
    /// when `expected` matches; same receipt publication is idempotent and any
    /// displaced prior bytes remain hidden crash evidence.
    pub(crate) fn publish(&self, receipt: &Value, expected: Option<&str>) -> Result<String> {
        self.assert_current()?;
        let bytes = serde_json::to_vec(receipt).map_err(|e| error(e.to_string()))?;
        ensure(
            bytes.len() <= MAX_BYTES,
            "autonomous_research_online_schema_transition_final_receipt_limit",
        )?;
        publication::publish_receipt(&self.directory, NAME, receipt, expected)?;
        let actual = self.load()?.ok_or_else(|| {
            error("autonomous_research_online_schema_transition_final_receipt_missing")
        })?;
        ensure(
            actual.0 == *receipt && actual.2 == hash_bytes(&bytes),
            "autonomous_research_online_schema_transition_final_receipt_changed",
        )?;
        Ok(actual.2)
    }
    pub(crate) fn assert_unchanged(&self, expected: &str) -> Result<()> {
        ensure(
            self.load()?.is_some_and(|(_, _, hash)| hash == expected),
            "autonomous_research_online_schema_transition_final_receipt_changed",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state_database_inventory::schema_source::{
        SchemaSource, maintenance_lock::SchemaMaintenanceLock,
    };
    use rusqlite::Connection;
    use serde_json::json;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn temporary_runtime() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "hepta-schema-finalization-repository-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("state.sqlite");
        let database = Connection::open(&path).unwrap();
        database
            .execute_batch(
                "PRAGMA journal_mode=DELETE;
                 PRAGMA user_version=1;
                 CREATE TABLE fixture(id INTEGER PRIMARY KEY, value TEXT NOT NULL);",
            )
            .unwrap();
        drop(database);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        root
    }

    #[test]
    fn publication_is_bounded_cas_and_exact_byte_round_trip() {
        let root = temporary_runtime();
        let source =
            SchemaSource::observe(&root, Path::new("state.sqlite"), "native-store").unwrap();
        let lock = SchemaMaintenanceLock::acquire(&source).unwrap();
        let repository = SchemaFinalizationRepository::open(&lock, true).unwrap();
        let receipt = json!({"version":1,"kind":"test-final-receipt","value":"one"});
        let expected_bytes = serde_json::to_vec(&receipt).unwrap();
        let digest = repository.publish(&receipt, None).unwrap();
        let (loaded, bytes, loaded_digest) = repository.load().unwrap().unwrap();
        assert_eq!(loaded, receipt);
        assert_eq!(bytes, expected_bytes);
        assert_eq!(loaded_digest, digest);
        repository.assert_unchanged(&digest).unwrap();

        let replacement = json!({"version":1,"kind":"test-final-receipt","value":"two"});
        let conflict = repository.publish(&replacement, Some("sha256:wrong"));
        assert_eq!(
            conflict.unwrap_err().code,
            "autonomous_research_state_backup_receipt_publication_conflict"
        );
        let (_, unchanged, unchanged_digest) = repository.load().unwrap().unwrap();
        assert_eq!(unchanged, expected_bytes);
        assert_eq!(unchanged_digest, digest);
        drop(repository);
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }
}

//! Reuse the validated held-directory receipt CAS for a private normalization
//! journal. It is serialized progress, never a constructor for authority.
use super::*;
use crate::{
    sqlite_mutation_coordinator::authority::files::parse,
    state_database_inventory::schema_source::maintenance_lock::SchemaMaintenanceLock,
};
const NAME: &str = "NORMALIZATION.native.v1.json";
const MAX_BYTES: usize = 4 * 1024 * 1024;
pub(crate) struct NormalizationRepository<'a> {
    root: &'a SchemaMaintenanceLock,
    directory: publication::Directory,
}
impl<'a> NormalizationRepository<'a> {
    pub(crate) fn open(root: &'a SchemaMaintenanceLock, create: bool) -> Result<Self> {
        root.assert_current()?;
        let path = root
            .runtime_root()?
            .join("autonomous-research/online-schema-transition");
        let directory = publication::Directory::open_or_create(&path, create)?;
        let result = Self { root, directory };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<()> {
        self.root.assert_current()?;
        self.directory.assert_current()
    }
    pub(crate) fn load(&self) -> Result<Option<(Value, String)>> {
        self.assert_current()?;
        let path = self.directory.path.join(NAME);
        if matches!(std::fs::symlink_metadata(&path),Err(e)if e.kind()==std::io::ErrorKind::NotFound)
        {
            return Ok(None);
        }
        let observed = files::ObservedFile::open(&path, MAX_BYTES as u64)?;
        let bytes = observed.bytes(MAX_BYTES as u64)?;
        let value = parse(
            &bytes,
            "autonomous_research_online_schema_transition_normalization_journal_invalid",
        )?;
        observed.assert_current()?;
        self.assert_current()?;
        Ok(Some((value, hash_bytes(&bytes))))
    }
    pub(crate) fn publish(&self, value: &Value, expected: Option<&str>) -> Result<String> {
        self.assert_current()?;
        let bytes = serde_json::to_vec(value).map_err(|e| error(e.to_string()))?;
        ensure(
            bytes.len() <= MAX_BYTES,
            "autonomous_research_online_schema_transition_normalization_journal_limit",
        )?;
        publication::publish_receipt(&self.directory, NAME, value, expected)?;
        self.assert_current()?;
        let actual = self.load()?.ok_or_else(|| {
            error("autonomous_research_online_schema_transition_normalization_journal_missing")
        })?;
        ensure(
            actual.0 == *value && actual.1 == hash_bytes(&bytes),
            "autonomous_research_online_schema_transition_normalization_journal_changed",
        )?;
        Ok(actual.1)
    }
}

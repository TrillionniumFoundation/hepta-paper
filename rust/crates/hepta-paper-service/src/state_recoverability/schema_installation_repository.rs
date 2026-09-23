//! Immutable, signed-hash-bound normalized preimages. Progress JSON is never
//! evidence of database contents; every recovery reloads the real source bytes.
use super::*;
use crate::state_database_inventory::schema_source::{
    SchemaSource, maintenance_lock::SchemaMaintenanceLock,
};
use nix::fcntl::{RenameFlags, renameat2};
use std::path::Path;
pub(crate) struct InstallationPreimages<'a> {
    root: &'a SchemaMaintenanceLock,
    directory: publication::Directory,
}
impl<'a> InstallationPreimages<'a> {
    pub(crate) fn open(
        root: &'a SchemaMaintenanceLock,
        plan: &Value,
        create: bool,
    ) -> Result<Self> {
        root.assert_current()?;
        let digest = text(plan, "planHash")?;
        ensure(
            crate::sqlite_mutation_coordinator::sha(&plan["planHash"]),
            "autonomous_research_online_schema_transition_installation_plan_invalid",
        )?;
        let suffix = digest.strip_prefix("sha256:").ok_or_else(|| {
            error("autonomous_research_online_schema_transition_installation_plan_invalid")
        })?;
        let path = root
            .runtime_root()?
            .join("autonomous-research/online-schema-transition")
            .join(format!("preimages-{suffix}"));
        let directory = publication::Directory::open_or_create(&path, create)?;
        let result = Self { root, directory };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<()> {
        self.root.assert_current()?;
        self.directory.assert_current()
    }
    fn name(id: &str) -> String {
        format!(
            "{}.preimage",
            hash_bytes(id.as_bytes()).trim_start_matches("sha256:")
        )
    }
    pub(crate) fn store(&self, row: &Value, bytes: &[u8]) -> Result<()> {
        self.assert_current()?;
        let expected = text(row, "expectedNormalizedSourceSha256")?;
        ensure(
            bytes.len() <= 256 * 1024 * 1024 && hash_bytes(bytes) == expected,
            "autonomous_research_online_schema_transition_preimage_invalid",
        )?;
        let name = Self::name(text(row, "databaseInstanceId")?);
        let path = self.directory.path.join(&name);
        if matches!(std::fs::symlink_metadata(&path),Err(e)if e.kind()==std::io::ErrorKind::NotFound)
        {
            // A crash while writing must not leave a partial file at the final
            // immutable name. Retain a private staging artifact; only publish
            // the completed, synced image through atomic no-replace rename.
            let staging = self
                .directory
                .child(&format!("staged-{}", publication::nonce()?))?;
            staging.write_new("image", bytes)?;
            let observed =
                files::ObservedFile::open(&staging.path.join("image"), 256 * 1024 * 1024)?;
            ensure(
                hash_bytes(&observed.bytes(256 * 1024 * 1024)?) == expected,
                "autonomous_research_online_schema_transition_preimage_invalid",
            )?;
            observed.assert_current()?;
            self.assert_current()?;
            renameat2(
                &staging.held,
                "image",
                &self.directory.held,
                name.as_str(),
                RenameFlags::RENAME_NOREPLACE,
            )
            .map_err(|_| {
                error("autonomous_research_online_schema_transition_preimage_publication_conflict")
            })?;
            self.directory
                .held
                .sync_all()
                .map_err(|e| error(e.to_string()))?;
            staging.held.sync_all().map_err(|e| error(e.to_string()))?;
        }
        self.load(row)?.assert_current()?;
        self.assert_current()
    }
    pub(crate) fn load(&self, row: &Value) -> Result<SchemaSource> {
        self.assert_current()?;
        let name = Self::name(text(row, "databaseInstanceId")?);
        let source = SchemaSource::observe(
            &self.directory.path,
            Path::new(&name),
            text(row, "databaseRole")?,
        )?;
        source.installation_bytes(text(row, "expectedNormalizedSourceSha256")?)?;
        self.assert_current()?;
        Ok(source)
    }
}

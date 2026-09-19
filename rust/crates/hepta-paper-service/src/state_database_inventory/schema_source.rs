//! Internal file observations for migration planning. A pre-transition database
//! need not satisfy the live-inventory schema and cannot become a ready inventory.
mod copy;
use super::{files, *};
use crate::online_schema_transition::target_schema::{
    SchemaTransitionTargetV1, project_schema_transition_target_v1,
};
use crate::sqlite_mutation_coordinator::DATABASE_ROLES;
use rusqlite::{Connection, OpenFlags};
use std::os::unix::fs::MetadataExt;

pub(crate) struct SchemaSource {
    ancestors: Vec<files::Directory>,
    database: files::DatabaseObservation,
    description: Value,
    root_identity: Value,
}
impl SchemaSource {
    pub(crate) fn observe(root: &Path, relative: &Path, role: &str) -> Result<Self> {
        ensure(
            DATABASE_ROLES.contains(&role)
                && relative.to_str().is_some_and(|s| {
                    !s.is_empty() && s.split('/').all(|part| !["", ".", ".."].contains(&part))
                }),
            "autonomous_research_online_schema_transition_database_path_invalid",
        )?;
        let (_, ancestors) = files::open_root(root)?;
        let root = ancestors.last().ok_or_else(files::changed)?;
        let root_identity = root_identity(root)?;
        let database = files::DatabaseObservation::observe(
            root,
            relative,
            role,
            &mut files::Budget::default(),
        )?;
        let stable = json!({"device":database.source.metadata["device"],"inode":database.source.metadata["inode"],"mode":database.source.metadata["mode"],"links":database.source.metadata["links"]});
        let journal = hash(
            "AutonomousResearchOnlineSchemaTransitionJournalPreimage",
            &json!({
                "durableWalState":state(database.wal.as_ref()),
                "ephemeralSharedMemoryState":state(database.shm.as_ref()),
                "sharedMemoryCarriesNoDurableDatabaseContent":true,
            }),
        )?;
        let description = json!({
            "databaseRole":role,"sourceRelativePath":relative.to_str(),
            "sourceSha256":database.source.sha256,"sourceFileIdentity":database.source.metadata,
            "sourceFileIdentityHash":hash("AutonomousResearchOnlineSchemaTransitionSourceFileIdentity",&stable)?,
            "journalPreimageHash":journal,
        });
        let result = Self {
            ancestors,
            database,
            description,
            root_identity,
        };
        result.assert_current()?;
        Ok(result)
    }
    pub(crate) fn assert_current(&self) -> Result<()> {
        for ancestor in &self.ancestors {
            ancestor.assert_current()?;
        }
        ensure(
            root_identity(self.ancestors.last().ok_or_else(files::changed)?)? == self.root_identity,
            "autonomous_research_online_schema_transition_runtime_root_identity_changed",
        )?;
        self.database.assert_current()
    }
    pub(crate) fn pristine_preimage(
        &self,
        instance: &Value,
        scope: &Value,
        writer: &Value,
        manifest_hash: &str,
        documents: Option<&crate::pristine_runtime_state::PinnedMachineGenesisDocumentsV1>,
    ) -> Result<crate::pristine_runtime_state::PristineDatabaseInspectionV1> {
        self.assert_current()?;
        let candidate = copy::MutableCopy::create(&self.database)?;
        candidate.assert_owned()?;
        let mut database = Connection::open_with_flags(
            candidate.path(),
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        let contract:String=database.query_row("SELECT schema_contract_id FROM autonomous_research_online_mutation_authority_metadata WHERE singleton=1;",[],|r|r.get(0))?;
        let result = crate::pristine_runtime_state::inspect_pristine_database_state_v1(
            &mut database,
            crate::pristine_runtime_state::PristineDatabaseOptionsV1 {
                database_role: text(instance, "role")?,
                database_instance_id: text(instance, "instanceId")?,
                schema_contract_id: &contract,
                schema_hash: text(instance, "schemaHash")?,
                state_database_manifest_hash: manifest_hash,
                phase: "pre-rebind",
                machine_genesis: documents,
            },
        )?;
        let online = &result.value()["semanticBindings"]["onlineAuthority"];
        ensure(
            &online["databaseScopeHash"] == scope && &online["writerManifestHash"] == writer,
            "autonomous_research_pristine_schema_rebind_local_preimage_invalid",
        )?;
        drop(database);
        candidate.assert_owned()?;
        self.assert_current()?;
        Ok(result)
    }
    pub(crate) fn project(&self, target: &SchemaTransitionTargetV1) -> Result<Value> {
        self.assert_current()?;
        let candidate = copy::MutableCopy::create(&self.database)?;
        candidate.assert_owned()?;
        // Only a private, owned copy is opened by SQLite. No source URI or live
        // handle is exposed. Its bytes may change, but its inode may not.
        let database = Connection::open_with_flags(
            candidate.path(),
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        database.busy_timeout(std::time::Duration::from_secs(10))?;
        let mode: String = database.query_row("PRAGMA journal_mode;", [], |r| r.get(0))?;
        if candidate.has_wal()? && mode == "delete" {
            let mode: String = database.query_row("PRAGMA journal_mode=WAL;", [], |r| r.get(0))?;
            ensure(
                mode == "wal",
                "autonomous_research_online_schema_transition_simulated_stale_sidecar_cleanup_failed",
            )?;
        }
        let busy: i64 = database.query_row("PRAGMA wal_checkpoint(TRUNCATE);", [], |r| r.get(0))?;
        ensure(
            busy == 0,
            "autonomous_research_online_schema_transition_simulated_checkpoint_busy",
        )?;
        let mode: String = database.query_row("PRAGMA journal_mode=DELETE;", [], |r| r.get(0))?;
        ensure(
            mode == "delete",
            "autonomous_research_online_schema_transition_simulated_journal_mode_invalid",
        )?;
        database.execute_batch("PRAGMA synchronous=FULL;")?;
        // Drop closes SQLite before computing the actual normalized file hash.
        drop(database);
        candidate.assert_no_sidecars()?;
        candidate.assert_owned()?;
        let normalized = candidate.sha256()?;
        let mut database = Connection::open_with_flags(
            candidate.path(),
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        let hidden = database.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name LIKE 'sqlite_%' LIMIT 1;")?.exists([])?;
        ensure(
            !hidden,
            "autonomous_research_online_schema_transition_hidden_user_schema_object",
        )?;
        let projected = project_schema_transition_target_v1(&mut database, target)?;
        drop(database);
        candidate.assert_no_sidecars()?;
        candidate.assert_owned()?;
        ensure(
            candidate.sha256()? == normalized,
            "autonomous_research_online_schema_transition_private_projection_changed",
        )?;
        self.assert_current()?;
        let mut result = self.description.clone();
        let output = result.as_object_mut().ok_or_else(files::changed)?;
        output.insert("expectedNormalizedSourceSha256".into(), json!(normalized));
        output.insert("preSchemaHash".into(), projected["preSchemaHash"].clone());
        output.insert(
            "expectedPostSchemaHash".into(),
            projected["expectedPostSchemaHash"].clone(),
        );
        output.insert("quickCheck".into(), projected["quickCheck"].clone());
        output.insert(
            "foreignKeyViolationCount".into(),
            projected["foreignKeyViolationCount"].clone(),
        );
        Ok(result)
    }
}
fn state(file: Option<&files::FileObservation>) -> Value {
    match file {
        Some(file) => json!({"state":"present","fileIdentity":file.metadata,"sha256":file.sha256}),
        None => json!({"state":"absent"}),
    }
}

fn root_identity(root: &files::Directory) -> Result<Value> {
    root.assert_current()?;
    let stat = root.held.metadata().map_err(|_| files::changed())?;
    Ok(
        json!({"resolved":root.path,"device":stat.dev().to_string(),"inode":stat.ino().to_string(),"mode":stat.mode().to_string(),"uid":stat.uid().to_string(),"gid":stat.gid().to_string()}),
    )
}

pub(crate) mod maintenance_lock;

pub(crate) mod normalization_support;

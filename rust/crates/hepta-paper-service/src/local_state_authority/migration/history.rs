//! Public-key-only observation of one exact legacy SQL snapshot. Neither this
//! owner nor its serializable report can authorize source mutation or shutdown.
use super::{
    archive, backup_history, mutation_history, offline_image, schema_history, source_profile,
    source_rows,
};
use crate::local_state_authority::storage;
use crate::sqlite_mutation_coordinator::{
    Result,
    authority::{
        MutationAuthorityTransportV1, PinnedMutationAuthorityV1,
        ProcessMutationAuthorityTransportV1, files::Snapshot,
    },
    error, hash, hash_bytes, text,
};
use rusqlite::{Connection, TransactionState};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

struct NoTransport;
struct ObservedSnapshot {
    rows: source_rows::JournalRows,
    report: Value,
    transaction: TransactionState,
    changes: u64,
}
impl MutationAuthorityTransportV1 for NoTransport {
    fn invoke(&mut self, _: &Value) -> Result<Value> {
        Err(error("local_authority_history_transport_unavailable"))
    }
}

/// Independently pinned configuration and public key retained for a read-only
/// observation. Load this owner before opening the source SQLite connection,
/// and retain it until that connection has closed. The referenced daemon
/// private-key path is validated as configuration text and is never opened.
///
/// File hashes are input identity pins, not service-maintenance authorization.
/// A successful report validates only the held SQL snapshot under this public
/// key; it never proves source-file provenance, installed service retirement,
/// exclusive key custody, production qualification or live migration permission.
pub struct LegacyAuthorityJournalVerifierV1 {
    configuration: Value,
    configuration_hash: String,
    configuration_file_hash: String,
    configuration_file: Snapshot,
    authority: PinnedMutationAuthorityV1<NoTransport>,
    process: Option<ProcessMutationAuthorityTransportV1>,
}
/// Both detached representations come from one exact public-key-verified read
/// snapshot. Construction conveys no stop, publication or migration authority.
pub(crate) struct PendingFinalizedAuthorityImagesV1 {
    pub(crate) native: offline_image::OfflineNativeAuthorityImageV1,
    pub(crate) legacy: archive::OfflineLegacyAuthorityArchiveV1,
}
impl LegacyAuthorityJournalVerifierV1 {
    pub fn load(
        daemon_configuration_path: &Path,
        expected_daemon_configuration_file_hash: &str,
        online_configuration_path: &Path,
        expected_online_configuration_file_hash: &str,
    ) -> Result<Self> {
        let code = "local_authority_history_configuration_invalid";
        let configuration_file = Snapshot::load(
            daemon_configuration_path,
            expected_daemon_configuration_file_hash,
            1024 * 1024,
            code,
        )?;
        let configuration = configuration_file.json(code)?;
        storage::validate_configuration(&configuration)?;
        let authority = PinnedMutationAuthorityV1::load(
            online_configuration_path,
            expected_online_configuration_file_hash,
            NoTransport,
        )?;
        let mut trust = configuration
            .as_object()
            .cloned()
            .ok_or_else(|| error(code))?;
        for name in ["privateKeyPath", "stateDatabasePath", "socketPath"] {
            trust.remove(name);
        }
        trust.insert(
            "kind".into(),
            json!("AutonomousResearchOnlineMutationAuthorityTrust"),
        );
        if Value::Object(trust) != *authority.trust() {
            return Err(error(
                "local_authority_history_configuration_trust_mismatch",
            ));
        }
        let result = Self {
            configuration_hash: hash(
                "HeptaLocalAutonomousResearchStateAuthorityConfiguration",
                &configuration,
            )?,
            configuration,
            configuration_file_hash: expected_daemon_configuration_file_hash.to_owned(),
            configuration_file,
            authority,
            process: None,
        };
        result.current()?;
        Ok(result)
    }
    pub(crate) fn current(&self) -> Result<()> {
        self.configuration_file.assert_current()?;
        self.authority.current()?;
        if let Some(process) = &self.process {
            process.current()?;
        }
        Ok(())
    }
    /// Retain the real process/public configuration loader without invoking RPC.
    /// Neither a process configuration hash nor its command is a public trust
    /// configuration; the separately pinned public file is loaded explicitly.
    pub(crate) fn load_process(
        daemon_configuration_path: &Path,
        expected_daemon_configuration_file_hash: &str,
        process_configuration_path: &Path,
        expected_process_configuration_file_hash: &str,
    ) -> Result<Self> {
        let process = ProcessMutationAuthorityTransportV1::load(
            process_configuration_path,
            expected_process_configuration_file_hash,
        )?;
        process.current()?;
        let (path, pin) = process.public_configuration_pin();
        let mut result = Self::load(
            daemon_configuration_path,
            expected_daemon_configuration_file_hash,
            path,
            pin,
        )?;
        result.process = Some(process);
        result.current()?;
        Ok(result)
    }
    pub(crate) fn source_database_path(&self) -> Result<&Path> {
        Ok(Path::new(text(&self.configuration, "stateDatabasePath")?))
    }
    pub(crate) fn daemon_configuration(&self) -> &Value {
        &self.configuration
    }
    pub(crate) fn public_key_sha256(&self) -> String {
        hash_bytes(self.authority.verification_key().as_bytes())
    }
    pub(super) fn protected_input_paths(&self) -> Result<Vec<std::path::PathBuf>> {
        let source = self.source_database_path()?;
        let parent = source
            .parent()
            .ok_or_else(|| error("local_authority_history_source_path_invalid"))?;
        let mut paths = vec![
            parent.to_path_buf(),
            self.configuration_file.path.clone(),
            Path::new(text(&self.configuration, "privateKeyPath")?).to_path_buf(),
            Path::new(text(&self.configuration, "socketPath")?).to_path_buf(),
        ];
        paths.extend(
            self.authority
                .retained_configuration_paths()
                .into_iter()
                .map(Path::to_path_buf),
        );
        Ok(paths)
    }
    /// Inspect a caller-owned actual main READ/WRITE transaction. This method
    /// opens no file, clones no descriptor, invokes no transport, changes no
    /// PRAGMA and neither begins nor ends the caller's transaction.
    ///
    /// Admission is deliberately bounded and refuses pending operations. Finalized
    /// backup rows are admitted only when their complete signatures bind the exact
    /// zero-mutation terminal head; their fencing booleans are never trusted as
    /// authority. Limits are rejection conditions, never permission to omit rows.
    pub fn inspect(&self, database: &Connection) -> Result<Value> {
        Ok(self.observe_snapshot(database)?.report)
    }
    /// Copy a completely verified, already-held main READ snapshot through
    /// SQLite's backup API into fresh memory, then serialize that original
    /// Node format. This preserves the original schema rather than migrating it.
    /// The opaque bytes have no archive-publication or maintenance authority.
    /// A main WRITE transaction is refused because SQLite backup cannot read
    /// from its own active writer. Source settings/transaction remain owned by
    /// the caller; this operation never opens another source descriptor.
    pub fn build_offline_legacy_archive(
        &self,
        database: &Connection,
    ) -> Result<archive::OfflineLegacyAuthorityArchiveV1> {
        archive::require_read_snapshot(database)?;
        let source = self.observe_snapshot(database)?;
        let copied = archive::copy_snapshot(database)?;
        copied.execute_batch("BEGIN DEFERRED")?;
        copied.query_row("SELECT count(*) FROM main.sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        })?;
        let copied_history = self.inspect(&copied)?;
        if copied_history != source.report {
            return Err(error("local_authority_archive_copied_history_mismatch"));
        }
        copied.execute_batch("ROLLBACK")?;
        let result = archive::seal(copied, &source.report)?;
        self.current()?;
        if database.total_changes() != source.changes
            || database.transaction_state(Some("main"))? != source.transaction
        {
            return Err(error("local_authority_history_transaction_changed"));
        }
        Ok(result)
    }
    /// Build a detached, serialized native SQLite image in newly allocated
    /// memory. The original six tables, rowids and TEXT bytes are preserved.
    /// This performs the same complete pinned history validation as `inspect`.
    ///
    /// No source path is opened or written and no destination path is accepted.
    /// The returned bytes are an offline review artifact, never permission to
    /// publish them, replace a live journal, stop Node or start a native service.
    pub fn build_offline_native_image(
        &self,
        database: &Connection,
    ) -> Result<offline_image::OfflineNativeAuthorityImageV1> {
        let snapshot = self.observe_snapshot(database)?;
        let image = offline_image::build_image(
            &snapshot.rows,
            self.authority.verification_key(),
            &snapshot.report,
        )?;
        self.current()?;
        if database.total_changes() != snapshot.changes
            || database.transaction_state(Some("main"))? != snapshot.transaction
        {
            return Err(error("local_authority_history_transaction_changed"));
        }
        Ok(image)
    }
    /// Distinct from ordinary settled inspection: validate exactly one signed
    /// finalized successor against the prepared target observation, preserving
    /// its still-reserved source epoch for the existing native activation owner.
    /// The caller owns the read transaction and every source-file lifetime.
    pub(crate) fn build_pending_target_restart_images(
        &self,
        database: &Connection,
        target_observation: &Value,
        target_configuration_hash: &str,
    ) -> Result<PendingFinalizedAuthorityImagesV1> {
        archive::require_read_snapshot(database)?;
        let expected = Some((target_observation, target_configuration_hash));
        let source = self.observe_snapshot_for_restart(database, expected, false)?;
        let native = offline_image::build_image(
            &source.rows,
            self.authority.verification_key(),
            &source.report,
        )?;
        let copied = archive::copy_snapshot(database)?;
        copied.execute_batch("BEGIN DEFERRED")?;
        copied.query_row("SELECT count(*) FROM main.sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        })?;
        let copied_history = self
            .observe_snapshot_for_restart(&copied, expected, false)?
            .report;
        if copied_history != source.report {
            return Err(error("local_authority_archive_copied_history_mismatch"));
        }
        copied.execute_batch("ROLLBACK")?;
        let legacy = archive::seal(copied, &source.report)?;
        self.current()?;
        if database.total_changes() != source.changes
            || database.transaction_state(Some("main"))? != source.transaction
        {
            return Err(error("local_authority_history_transaction_changed"));
        }
        Ok(PendingFinalizedAuthorityImagesV1 { native, legacy })
    }
    fn observe_snapshot(&self, database: &Connection) -> Result<ObservedSnapshot> {
        self.observe_snapshot_for_restart(database, None, false)
    }
    pub(crate) fn inspect_native_journal_snapshot(
        &self,
        database: &Connection,
        pending: Option<(&Value, &str)>,
    ) -> Result<Value> {
        Ok(self
            .observe_snapshot_for_restart(database, pending, true)?
            .report)
    }
    fn observe_snapshot_for_restart(
        &self,
        database: &Connection,
        pending: Option<(&Value, &str)>,
        native: bool,
    ) -> Result<ObservedSnapshot> {
        self.current()?;
        let transaction = database.transaction_state(Some("main"))?;
        let changes = database.total_changes();
        let profile = if native {
            source_profile::inspect_native_schema(database, &self.public_key_sha256())?
        } else {
            source_profile::inspect_source_schema(database)?
        };
        let rows =
            source_rows::read_source_rows_for_profile(database, profile.schema_rebind_present())?;
        let schema = match pending {
            Some((observation, target_hash)) => {
                schema_history::verify_pending_finalized_history_v1(
                    &rows,
                    &self.configuration,
                    self.authority.verification_key(),
                    observation,
                    target_hash,
                )?
            }
            None => schema_history::verify_schema_history_v1(
                &rows,
                &self.configuration,
                self.authority.verification_key(),
            )?,
        };
        if schema.trust() != self.authority.trust() {
            return Err(error("local_authority_history_terminal_trust_mismatch"));
        }
        let (head, mutation_report) = if pending.is_some() {
            // The separate pending schema composition admits only a pristine
            // zero-mutation source. Its metadata is intentionally reserved;
            // the ordinary settled mutation replay must remain finalized-only.
            if !rows.mutations().is_empty() {
                return Err(error("local_authority_history_pending_mutations_invalid"));
            }
            (
                schema.genesis().clone(),
                json!({"version":1,
                "kind":"HeptaLegacyAuthorityMutationHistoryObservationV1",
                "evidenceScope":"empty_mutation_set_in_signed_pending_source_epoch_no_migration_authority",
                "mutationRows":0,"finalizedMutations":0,"abortedTailMutations":0}),
            )
        } else if schema.initialized() {
            let observation = mutation_history::verify_mutation_history_v1(
                &rows,
                schema.genesis(),
                schema.trust(),
                self.authority.verification_key(),
            )?;
            (observation.head().clone(), observation.report().clone())
        } else {
            if !rows.mutations().is_empty() || !rows.heads().is_empty() {
                return Err(error("local_authority_history_uninitialized_rows_invalid"));
            }
            (
                schema.genesis().clone(),
                json!({"finalizedCount":0,"abortedCount":0}),
            )
        };
        self.assert_terminal(&rows, &head, schema.initialized(), pending.is_some())?;
        let backup_report = backup_history::verify_backup_history_v1(
            &rows,
            &head,
            &self.configuration,
            self.authority.verification_key(),
        )?;
        self.current()?;
        if database.total_changes() != changes
            || database.transaction_state(Some("main"))? != transaction
        {
            return Err(error("local_authority_history_transaction_changed"));
        }
        let report = json!({
            "version":1,"kind":"HeptaLocalStateAuthorityLegacyHistoryInspectionV1",
            "evidenceScope":"signed_history_observation_no_migration_authority",
            "historyState":if pending.is_some() {"signed_finalized_rebind_source_epoch_preserved"} else if schema.initialized() {"settled_signed_history"} else {"uninitialized_no_signed_history"},
            "sourceSchemaHash":profile.schema_hash(),"sourceSchemaProfile":profile.profile_id(),
            "sourceLogicalHash":rows.logical_hash(),
            "logicalHashProfile":"HeptaLocalStateAuthorityLegacySqlRowsV1",
            "configurationHash":self.configuration_hash,
            "configurationFileSha256":self.configuration_file_hash,
            "onlineConfigurationHash":self.authority.configuration_hash(),
            "publicKeySha256":hash_bytes(self.authority.verification_key().as_bytes()),
            "rowCounts":rows.counts(),"head":head,
            "schemaHistory":schema.report(),"mutationHistory":mutation_report,
            "backupHistory":backup_report,
        });
        Ok(ObservedSnapshot {
            rows,
            report,
            transaction,
            changes,
        })
    }
    fn assert_terminal(
        &self,
        rows: &source_rows::JournalRows,
        head: &Value,
        initialized: bool,
        pending: bool,
    ) -> Result<()> {
        let code = "local_authority_history_terminal_state_mismatch";
        let [metadata] = rows.metadata() else {
            return Err(error(code));
        };
        if metadata.len() != 11
            || metadata[0] != 1
            || metadata[1] != 1
            || metadata[2] != self.configuration_hash
            || metadata[8] != head["globalSequence"]
            || metadata[9] != head["globalHash"]
            || metadata[10]
                != if pending {
                    "reserved"
                } else if initialized {
                    "finalized"
                } else {
                    "uninitialized"
                }
        {
            return Err(error(code));
        }
        for (index, name) in [
            "authorityId",
            "keyId",
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
        ]
        .iter()
        .enumerate()
        {
            if metadata[index + 3] != self.configuration[*name] {
                return Err(error(code));
            }
        }
        let mut actual = BTreeMap::new();
        for row in rows.heads() {
            if row.len() != 7 {
                return Err(error(code));
            }
            let id = row[1].as_str().ok_or_else(|| error(code))?;
            let value = json!({"databaseInstanceId":id,"databaseRole":row[2],"sequence":row[3],"hash":row[4],"schemaHash":row[5],"stateHash":row[6]});
            if actual.insert(id, value).is_some() {
                return Err(error(code));
            }
        }
        let mut expected = BTreeMap::new();
        for value in head["databaseHeads"]
            .as_array()
            .ok_or_else(|| error(code))?
        {
            let id = value["databaseInstanceId"]
                .as_str()
                .ok_or_else(|| error(code))?;
            let mut fields = value.as_object().cloned().ok_or_else(|| error(code))?;
            fields.remove("schemaContractId");
            if expected.insert(id, Value::Object(fields)).is_some() {
                return Err(error(code));
            }
        }
        if actual != expected {
            return Err(error(code));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;

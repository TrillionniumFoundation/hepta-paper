//! Public-key-only observation of one exact legacy SQL snapshot. Neither this
//! owner nor its serializable report can authorize source mutation or shutdown.
use super::{mutation_history, offline_image, schema_history, source_profile, source_rows};
use crate::local_state_authority::storage;
use crate::sqlite_mutation_coordinator::{
    Result,
    authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1, files::Snapshot},
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
        };
        result.current()?;
        Ok(result)
    }
    pub(super) fn current(&self) -> Result<()> {
        self.configuration_file.assert_current()?;
        self.authority.current()
    }
    pub(super) fn source_database_path(&self) -> Result<&Path> {
        Ok(Path::new(text(&self.configuration, "stateDatabasePath")?))
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
    /// First-version admission is deliberately bounded and refuses all backup
    /// rows and pending operations. Limits are rejection conditions, never
    /// permission to omit historical rows. See the migration history handoff.
    pub fn inspect(&self, database: &Connection) -> Result<Value> {
        Ok(self.observe_snapshot(database)?.report)
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
    fn observe_snapshot(&self, database: &Connection) -> Result<ObservedSnapshot> {
        self.current()?;
        let transaction = database.transaction_state(Some("main"))?;
        let changes = database.total_changes();
        let profile = source_profile::inspect_source_schema(database)?;
        let rows = source_rows::read_source_rows(database)?;
        if !rows.backups().is_empty() {
            return Err(error(
                "local_authority_history_backup_provenance_unsupported",
            ));
        }
        let schema = schema_history::verify_schema_history_v1(
            &rows,
            &self.configuration,
            self.authority.verification_key(),
        )?;
        if schema.trust() != self.authority.trust() {
            return Err(error("local_authority_history_terminal_trust_mismatch"));
        }
        let (head, mutation_report) = if schema.initialized() {
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
        self.assert_terminal(&rows, &head, schema.initialized())?;
        self.current()?;
        if database.total_changes() != changes
            || database.transaction_state(Some("main"))? != transaction
        {
            return Err(error("local_authority_history_transaction_changed"));
        }
        let report = json!({
            "version":1,"kind":"HeptaLocalStateAuthorityLegacyHistoryInspectionV1",
            "evidenceScope":"signed_history_observation_no_migration_authority",
            "historyState":if schema.initialized() {"settled_signed_history"} else {"uninitialized_no_signed_history"},
            "sourceSchemaHash":profile.schema_hash(),"sourceLogicalHash":rows.logical_hash(),
            "logicalHashProfile":"HeptaLocalStateAuthorityLegacySqlRowsV1",
            "configurationHash":self.configuration_hash,
            "configurationFileSha256":self.configuration_file_hash,
            "onlineConfigurationHash":self.authority.configuration_hash(),
            "publicKeySha256":hash_bytes(self.authority.verification_key().as_bytes()),
            "rowCounts":rows.counts(),"head":head,
            "schemaHistory":schema.report(),"mutationHistory":mutation_report,
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
                != if initialized {
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

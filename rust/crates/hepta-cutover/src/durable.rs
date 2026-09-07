//! Crash-recoverable, cross-runtime writer epochs. The coordinator lock is held
//! for the entire application mutation; a handoff cannot overlap an old write.
//! This protocol does not translate the legacy database into the HPCW schema.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

use hepta_campaign_writer::{
    CampaignWriterPolicyV1, WriterCutoverAuthorizationV1, WriterCutoverPolicyV1,
    WriterCutoverSubjectV1, WriterCutoverTrustStoreV1, inspect_writer_database_preimage_v1,
    verify_writer_cutover_authorization_v1, writer_database_preimage_hash_v1,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const SCHEMA: &str = "
CREATE TABLE hepta_cutover_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), state_json TEXT NOT NULL);
CREATE TABLE hepta_cutover_journal(revision INTEGER PRIMARY KEY, event TEXT NOT NULL,
  evidence_json TEXT NOT NULL, state_json TEXT NOT NULL, previous_hash TEXT NOT NULL, entry_hash TEXT NOT NULL);
CREATE TRIGGER hepta_cutover_no_journal_update BEFORE UPDATE ON hepta_cutover_journal
BEGIN SELECT RAISE(ABORT, 'cutover_journal_append_only'); END;
CREATE TRIGGER hepta_cutover_no_journal_delete BEFORE DELETE ON hepta_cutover_journal
BEGIN SELECT RAISE(ABORT, 'cutover_journal_append_only'); END;";

/// Local drills cannot confer any production authority.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableCutoverModeV1 {
    LocalDrill,
    Production,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurableCutoverPhaseV1 {
    Planned,
    Quiesced,
    BackedUp,
    ShadowVerified,
    Canary,
    Active,
    RolledBack,
}

/// Persisted state, also consumed by the Node fence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurableCutoverStateV1 {
    pub version: u16,
    pub cutover_id: String,
    pub database_path: String,
    pub mode: DurableCutoverModeV1,
    pub phase: DurableCutoverPhaseV1,
    pub old_writer_id: String,
    pub new_writer_id: String,
    pub writer_id: Option<String>,
    pub generation: u64,
    pub token: String,
    pub revision: u64,
    pub shadow_cases: u64,
    pub shadow_mismatches: u64,
    pub canary_scopes: Vec<String>,
    pub production_activation: bool,
    pub activation_receipt_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriterFenceV1 {
    pub writer_id: String,
    pub generation: u64,
    pub token: String,
}

impl DurableCutoverStateV1 {
    pub fn writer_fence(&self) -> Option<WriterFenceV1> {
        self.writer_id.as_ref().map(|writer| WriterFenceV1 {
            writer_id: writer.clone(),
            generation: self.generation,
            token: self.token.clone(),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Enrollment {
    version: u16,
    database_path: String,
    database_identity: String,
    journal_identity: String,
}

/// Exact output comparison; these receipts report measured parity, never external
/// qualification. The caller must actually execute both implementations.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowComparisonV1 {
    pub case_id: String,
    pub node_output_hash: String,
    pub rust_output_hash: String,
    pub equal: bool,
    pub production_qualification: bool,
}

/// Coordinator database is a sidecar, independent from either application schema.
pub struct DurableCutoverCoordinatorV1 {
    database_path: PathBuf,
    journal_path: PathBuf,
    marker_path: PathBuf,
    enrollment: Enrollment,
    connection: Connection,
}

impl DurableCutoverCoordinatorV1 {
    /// Enrolls an existing database once. Existing enrollment is never replaced.
    /// All writers must use the fence before this protocol can be authoritative.
    pub fn create(
        database_path: impl AsRef<Path>,
        cutover_id: &str,
        old_writer_id: &str,
        new_writer_id: &str,
        mode: DurableCutoverModeV1,
    ) -> Result<Self, DurableCutoverError> {
        if !super::valid_identifier(cutover_id)
            || !super::valid_identifier(old_writer_id)
            || !super::valid_identifier(new_writer_id)
            || old_writer_id == new_writer_id
        {
            return Err(DurableCutoverError::InvalidInput);
        }
        let database_path = canonical_file(database_path.as_ref())?;
        let (journal_path, marker_path) = sidecars(&database_path);
        if marker_path.exists() {
            return Err(DurableCutoverError::AlreadyEnrolled);
        }
        let journal = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&journal_path)?;
        journal.sync_all()?;
        let enrollment = Enrollment {
            version: 1,
            database_path: path_string(&database_path)?,
            database_identity: identity(&fs::symlink_metadata(&database_path)?),
            journal_identity: identity(&journal.metadata()?),
        };
        let mut connection = open_connection(&journal_path)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(SCHEMA)?;
        let state = DurableCutoverStateV1 {
            version: 1,
            cutover_id: cutover_id.into(),
            database_path: enrollment.database_path.clone(),
            mode,
            phase: DurableCutoverPhaseV1::Planned,
            old_writer_id: old_writer_id.into(),
            new_writer_id: new_writer_id.into(),
            writer_id: Some(old_writer_id.into()),
            generation: 1,
            token: format!("{cutover_id}:1"),
            revision: 0,
            shadow_cases: 0,
            shadow_mismatches: 0,
            canary_scopes: Vec::new(),
            production_activation: false,
            activation_receipt_hash: None,
        };
        append(
            &tx,
            &state,
            "enrolled",
            &serde_json::json!({"productionQualification": false}),
            "",
        )?;
        tx.commit()?;
        // Publish marker last; a crash before publication remains fail-closed.
        let mut marker = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&marker_path)?;
        marker.write_all(&serde_json::to_vec(&enrollment)?)?;
        marker.sync_all()?;
        sync_parent(&marker_path)?;
        let coordinator = Self {
            database_path,
            journal_path,
            marker_path,
            enrollment,
            connection,
        };
        coordinator.validate_identity()?;
        Ok(coordinator)
    }

    /// Opens an enrollment, checks every committed journal link and final state.
    /// Uncommitted transitions are rolled back by SQLite after a process crash.
    pub fn open(database_path: impl AsRef<Path>) -> Result<Self, DurableCutoverError> {
        let database_path = canonical_file(database_path.as_ref())?;
        let (journal_path, marker_path) = sidecars(&database_path);
        let bytes = fs::read(&marker_path)?;
        if bytes.len() > 16_384 {
            return Err(DurableCutoverError::IdentityChanged);
        }
        let enrollment: Enrollment = serde_json::from_slice(&bytes)?;
        let connection = open_connection(&journal_path)?;
        let coordinator = Self {
            database_path,
            journal_path,
            marker_path,
            enrollment,
            connection,
        };
        coordinator.validate_identity()?;
        coordinator.verify_journal()?;
        Ok(coordinator)
    }

    pub fn inspect(&self) -> Result<DurableCutoverStateV1, DurableCutoverError> {
        self.validate_identity()?;
        load_state(&self.connection)
    }

    pub fn verify_journal(&self) -> Result<(), DurableCutoverError> {
        let mut statement = self.connection.prepare(
            "SELECT revision,event,evidence_json,state_json,previous_hash,entry_hash FROM hepta_cutover_journal ORDER BY revision")?;
        let rows = statement.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        let mut previous = String::new();
        let mut last = None;
        for (expected, row) in rows.enumerate() {
            let (revision, event, evidence, state, prior, hash) = row?;
            let revision =
                u64::try_from(revision).map_err(|_| DurableCutoverError::JournalCorrupt)?;
            let parsed: DurableCutoverStateV1 = serde_json::from_str(&state)?;
            if revision != expected as u64
                || parsed.revision != revision
                || prior != previous
                || hash != entry_hash(revision, &event, &evidence, &state, &prior)?
            {
                return Err(DurableCutoverError::JournalCorrupt);
            }
            previous = hash;
            last = Some(parsed);
        }
        if last.as_ref() != Some(&load_state(&self.connection)?) {
            return Err(DurableCutoverError::JournalCorrupt);
        }
        Ok(())
    }

    /// A fence is held across the entire synchronous application commit. The
    /// coordinator transaction itself remains read-only, so rollback releases it.
    pub fn with_writer<T>(
        &mut self,
        lease: &WriterFenceV1,
        scope: &str,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, DurableCutoverError> {
        self.validate_identity()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = load_state(&tx)?;
        if state.writer_fence().as_ref() != Some(lease) {
            return Err(DurableCutoverError::StaleWriter);
        }
        if state.phase == DurableCutoverPhaseV1::Canary
            && !state.canary_scopes.iter().any(|allowed| allowed == scope)
        {
            return Err(DurableCutoverError::CanaryScopeRejected);
        }
        if !matches!(
            state.phase,
            DurableCutoverPhaseV1::Planned
                | DurableCutoverPhaseV1::Canary
                | DurableCutoverPhaseV1::Active
                | DurableCutoverPhaseV1::RolledBack
        ) {
            return Err(DurableCutoverError::WriterDisabled);
        }
        let result = action().map_err(DurableCutoverError::Application);
        // Dropping a read-only transaction cannot undo the application commit.
        drop(tx);
        result
    }

    /// Waits for any previous fenced mutation, then removes write ownership.
    pub fn quiesce(
        &mut self,
        expected_revision: u64,
    ) -> Result<DurableCutoverStateV1, DurableCutoverError> {
        self.change(expected_revision, "quiesced", |state| {
            require_phase(state, DurableCutoverPhaseV1::Planned)?;
            advance_epoch(state, None)?;
            state.phase = DurableCutoverPhaseV1::Quiesced;
            Ok(serde_json::json!({"allParticipatingWritersFenced":true}))
        })
    }

    /// Creates a SQLite-consistent backup, restores it to a new file and checks
    /// integrity plus exact copied bytes. It never overwrites the live database.
    pub fn backup_restore_drill(
        &mut self,
        expected_revision: u64,
        backup_path: &Path,
        restore_path: &Path,
    ) -> Result<DurableCutoverStateV1, DurableCutoverError> {
        let source_path = self.database_path.clone();
        if backup_path.exists()
            || restore_path.exists()
            || !backup_path.is_absolute()
            || !restore_path.is_absolute()
            || backup_path == restore_path
        {
            return Err(DurableCutoverError::InvalidInput);
        }
        self.change(expected_revision, "backup_restore_verified", |state| {
            require_phase(state, DurableCutoverPhaseV1::Quiesced)?;
            let source =
                Connection::open_with_flags(&source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            source.execute("VACUUM INTO ?1", [path_string(backup_path)?])?;
            drop(source);
            let mut backup = File::open(backup_path)?;
            let mut restored = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(restore_path)?;
            std::io::copy(&mut backup, &mut restored)?;
            restored.sync_all()?;
            drop(restored);
            for path in [backup_path, restore_path] {
                let connection =
                    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
                let result: String =
                    connection.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
                if result != "ok" {
                    return Err(DurableCutoverError::RestoreMismatch);
                }
            }
            let backup_hash = hash_file(backup_path)?;
            if hash_file(restore_path)? != backup_hash {
                return Err(DurableCutoverError::RestoreMismatch);
            }
            state.phase = DurableCutoverPhaseV1::BackedUp;
            Ok(
                serde_json::json!({"backupHash":backup_hash,"restoredHash":backup_hash,
                "liveDatabaseReplaced":false,"productionQualification":false}),
            )
        })
    }

    /// Records a real byte comparison. A failed case remains in the append-only
    /// journal and prevents that enrollment from being promoted.
    pub fn compare_shadow(
        &mut self,
        expected_revision: u64,
        case_id: &str,
        node: &[u8],
        rust: &[u8],
    ) -> Result<ShadowComparisonV1, DurableCutoverError> {
        if !super::valid_identifier(case_id) {
            return Err(DurableCutoverError::InvalidInput);
        }
        let comparison = ShadowComparisonV1 {
            case_id: case_id.into(),
            node_output_hash: hash_bytes(node),
            rust_output_hash: hash_bytes(rust),
            equal: node == rust,
            production_qualification: false,
        };
        self.change(expected_revision, "shadow_comparison", |state| {
            if !matches!(
                state.phase,
                DurableCutoverPhaseV1::BackedUp | DurableCutoverPhaseV1::ShadowVerified
            ) {
                return Err(DurableCutoverError::IllegalTransition);
            }
            state.shadow_cases = increment(state.shadow_cases)?;
            if !comparison.equal {
                state.shadow_mismatches = increment(state.shadow_mismatches)?;
            }
            state.phase = DurableCutoverPhaseV1::ShadowVerified;
            Ok(serde_json::to_value(&comparison)?)
        })?;
        Ok(comparison)
    }

    /// Local canary only; the production path always needs independently signed
    /// authority. A canary is globally single-writer, restricted by exact scope.
    pub fn start_local_canary(
        &mut self,
        expected_revision: u64,
        scopes: Vec<String>,
    ) -> Result<DurableCutoverStateV1, DurableCutoverError> {
        validate_scopes(&scopes)?;
        self.change(expected_revision, "local_canary_started", |state| {
            require_local(state)?;
            require_shadow(state)?;
            advance_epoch(state, Some(state.new_writer_id.clone()))?;
            state.canary_scopes = scopes;
            state.phase = DurableCutoverPhaseV1::Canary;
            Ok(serde_json::json!({"productionQualification":false}))
        })
    }

    /// Production transfer verifies the existing Ed25519 cutover contract against
    /// the exact subject, current time and database preimage while writers are fenced.
    /// This does not independently qualify business parity or schema translation.
    #[allow(clippy::too_many_arguments)]
    pub fn start_production_canary(
        &mut self,
        expected_revision: u64,
        scopes: Vec<String>,
        authorization: &WriterCutoverAuthorizationV1,
        subject: &WriterCutoverSubjectV1,
        trust: &WriterCutoverTrustStoreV1,
        writer_policy: CampaignWriterPolicyV1,
        now_unix_ms: u64,
    ) -> Result<DurableCutoverStateV1, DurableCutoverError> {
        validate_scopes(&scopes)?;
        let target = self.database_path.clone();
        self.change(expected_revision, "production_canary_authorized", |state| {
            if state.mode != DurableCutoverModeV1::Production {
                return Err(DurableCutoverError::ProductionAuthorityRequired);
            }
            require_shadow(state)?;
            let verified = verify_writer_cutover_authorization_v1(
                authorization,
                subject,
                now_unix_ms,
                WriterCutoverPolicyV1::default(),
                trust,
            )?;
            if verified.cutover_id() != state.cutover_id {
                return Err(DurableCutoverError::ProductionAuthorityRequired);
            }
            let preimage = inspect_writer_database_preimage_v1(&target, writer_policy)?;
            if writer_database_preimage_hash_v1(&preimage)? != authorization.database_preimage_hash
            {
                return Err(DurableCutoverError::DatabasePreimageChanged);
            }
            advance_epoch(state, Some(state.new_writer_id.clone()))?;
            state.canary_scopes = scopes;
            state.phase = DurableCutoverPhaseV1::Canary;
            state.production_activation = true;
            state.activation_receipt_hash = Some(verified.authorization_hash().as_str().into());
            Ok(
                serde_json::json!({"authorizationHash":state.activation_receipt_hash,
                "productionQualification":false,"schemaTranslationVerified":false}),
            )
        })
    }

    /// Local promotion keeps the nonproduction marker. Production expansion
    /// requires a new externally defined authorization and is not inferred here.
    pub fn promote_local(
        &mut self,
        expected_revision: u64,
    ) -> Result<DurableCutoverStateV1, DurableCutoverError> {
        self.change(expected_revision, "local_canary_promoted", |state| {
            require_local(state)?;
            require_phase(state, DurableCutoverPhaseV1::Canary)?;
            state.phase = DurableCutoverPhaseV1::Active;
            state.canary_scopes.clear();
            Ok(serde_json::json!({"productionQualification":false}))
        })
    }

    /// Return local ownership without restoring any old backup. This preserves
    /// committed records and invalidates both old Node and Rust epoch tokens.
    /// Production reverse-schema compatibility is deliberately not fabricated.
    pub fn rollback_local(
        &mut self,
        expected_revision: u64,
    ) -> Result<DurableCutoverStateV1, DurableCutoverError> {
        self.change(expected_revision, "local_ownership_rolled_back", |state| {
            require_local(state)?;
            if matches!(
                state.phase,
                DurableCutoverPhaseV1::Planned | DurableCutoverPhaseV1::RolledBack
            ) {
                return Err(DurableCutoverError::IllegalTransition);
            }
            advance_epoch(state, Some(state.old_writer_id.clone()))?;
            state.phase = DurableCutoverPhaseV1::RolledBack;
            state.canary_scopes.clear();
            Ok(
                serde_json::json!({"committedDataPreserved":true,"liveDatabaseReplaced":false,
                "productionQualification":false}),
            )
        })
    }

    fn change(
        &mut self,
        expected_revision: u64,
        event: &str,
        apply: impl FnOnce(&mut DurableCutoverStateV1) -> Result<serde_json::Value, DurableCutoverError>,
    ) -> Result<DurableCutoverStateV1, DurableCutoverError> {
        self.validate_identity()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut state = load_state(&tx)?;
        if state.revision != expected_revision {
            return Err(DurableCutoverError::RevisionConflict);
        }
        let previous: String = tx.query_row(
            "SELECT entry_hash FROM hepta_cutover_journal WHERE revision=?1",
            [to_sql_integer(state.revision)?],
            |r| r.get(0),
        )?;
        let evidence = apply(&mut state)?;
        state.revision = increment(state.revision)?;
        append(&tx, &state, event, &evidence, &previous)?;
        tx.commit()?;
        Ok(state)
    }

    fn validate_identity(&self) -> Result<(), DurableCutoverError> {
        let target = canonical_file(&self.database_path)?;
        let journal = canonical_file(&self.journal_path)?;
        canonical_file(&self.marker_path)?;
        let marker: Enrollment = serde_json::from_slice(&fs::read(&self.marker_path)?)?;
        if marker.version != 1
            || marker.database_path != path_string(&target)?
            || marker.database_identity != identity(&fs::metadata(target)?)
            || marker.journal_identity != identity(&fs::metadata(journal)?)
            || marker.database_identity != self.enrollment.database_identity
            || marker.journal_identity != self.enrollment.journal_identity
        {
            return Err(DurableCutoverError::IdentityChanged);
        }
        Ok(())
    }
}

fn require_local(state: &DurableCutoverStateV1) -> Result<(), DurableCutoverError> {
    if state.mode != DurableCutoverModeV1::LocalDrill {
        return Err(DurableCutoverError::ProductionAuthorityRequired);
    }
    Ok(())
}
fn require_phase(
    state: &DurableCutoverStateV1,
    phase: DurableCutoverPhaseV1,
) -> Result<(), DurableCutoverError> {
    if state.phase != phase {
        return Err(DurableCutoverError::IllegalTransition);
    }
    Ok(())
}
fn require_shadow(state: &DurableCutoverStateV1) -> Result<(), DurableCutoverError> {
    require_phase(state, DurableCutoverPhaseV1::ShadowVerified)?;
    if state.shadow_cases == 0 || state.shadow_mismatches != 0 {
        return Err(DurableCutoverError::ShadowMismatch);
    }
    Ok(())
}
fn validate_scopes(scopes: &[String]) -> Result<(), DurableCutoverError> {
    if scopes.is_empty() || scopes.len() > 128 || scopes.iter().any(|s| !super::valid_identifier(s))
    {
        return Err(DurableCutoverError::InvalidInput);
    }
    Ok(())
}
fn advance_epoch(
    state: &mut DurableCutoverStateV1,
    writer: Option<String>,
) -> Result<(), DurableCutoverError> {
    state.generation = increment(state.generation)?;
    state.token = format!("{}:{}", state.cutover_id, state.generation);
    state.writer_id = writer;
    Ok(())
}
fn increment(value: u64) -> Result<u64, DurableCutoverError> {
    value
        .checked_add(1)
        .filter(|v| *v <= MAX_SAFE_INTEGER)
        .ok_or(DurableCutoverError::NumericOverflow)
}
fn append(
    connection: &Connection,
    state: &DurableCutoverStateV1,
    event: &str,
    evidence: &serde_json::Value,
    previous: &str,
) -> Result<(), DurableCutoverError> {
    let state_json = serde_json::to_string(state)?;
    let evidence_json = serde_json::to_string(evidence)?;
    let hash = entry_hash(state.revision, event, &evidence_json, &state_json, previous)?;
    connection.execute(
        "INSERT INTO hepta_cutover_journal VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            to_sql_integer(state.revision)?,
            event,
            evidence_json,
            state_json,
            previous,
            hash
        ],
    )?;
    connection.execute("INSERT INTO hepta_cutover_state VALUES(1,?1) ON CONFLICT(singleton) DO UPDATE SET state_json=excluded.state_json",[state_json])?;
    Ok(())
}
fn entry_hash(
    revision: u64,
    event: &str,
    evidence: &str,
    state: &str,
    previous: &str,
) -> Result<String, DurableCutoverError> {
    Ok(hash_bytes(&serde_json::to_vec(&(
        "HeptaDurableCutoverJournalV1",
        revision,
        event,
        evidence,
        state,
        previous,
    ))?))
}

fn to_sql_integer(value: u64) -> Result<i64, DurableCutoverError> {
    i64::try_from(value).map_err(|_| DurableCutoverError::NumericOverflow)
}
fn load_state(connection: &Connection) -> Result<DurableCutoverStateV1, DurableCutoverError> {
    // One SELECT observes state, journal tail and predecessor in the same SQLite
    // snapshot, including read-only inspect() callers outside a transaction.
    // Mutation paths already hold their BEGIN IMMEDIATE transaction here.
    let (state_json, revision, event, evidence, tail_state, previous, hash, predecessor) =
        connection
            .query_row(
                "SELECT s.state_json,j.revision,j.event,j.evidence_json,j.state_json,
                    j.previous_hash,j.entry_hash,p.entry_hash
             FROM hepta_cutover_state AS s
             JOIN hepta_cutover_journal AS j
               ON j.revision=(SELECT MAX(revision) FROM hepta_cutover_journal)
             LEFT JOIN hepta_cutover_journal AS p ON p.revision=j.revision-1
             WHERE s.singleton=1",
                [],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, Option<String>>(7)?,
                    ))
                },
            )
            .optional()?
            .ok_or(DurableCutoverError::JournalCorrupt)?;
    if state_json.len() > 131_072 || state_json != tail_state {
        return Err(DurableCutoverError::JournalCorrupt);
    }
    let state: DurableCutoverStateV1 =
        serde_json::from_str(&state_json).map_err(|_| DurableCutoverError::JournalCorrupt)?;
    let revision = u64::try_from(revision).map_err(|_| DurableCutoverError::JournalCorrupt)?;
    if state.version != 1
        || state.generation == 0
        || state.generation > MAX_SAFE_INTEGER
        || state.revision > MAX_SAFE_INTEGER
        || state.revision != revision
        || !super::valid_identifier(&state.cutover_id)
        || !super::valid_identifier(&state.old_writer_id)
        || !super::valid_identifier(&state.new_writer_id)
        || state.old_writer_id == state.new_writer_id
        || state.token != format!("{}:{}", state.cutover_id, state.generation)
        || hash != entry_hash(revision, &event, &evidence, &tail_state, &previous)?
        || (revision == 0 && !previous.is_empty())
        || (revision > 0 && predecessor.as_deref() != Some(previous.as_str()))
    {
        return Err(DurableCutoverError::JournalCorrupt);
    }
    Ok(state)
}
fn open_connection(path: &Path) -> Result<Connection, DurableCutoverError> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(Duration::from_secs(10))?;
    connection.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;",
    )?;
    Ok(connection)
}
fn sidecars(path: &Path) -> (PathBuf, PathBuf) {
    let base = path.as_os_str().to_string_lossy();
    (
        PathBuf::from(format!("{base}.rust-cutover.sqlite")),
        PathBuf::from(format!("{base}.rust-cutover.enrolled.json")),
    )
}
fn canonical_file(path: &Path) -> Result<PathBuf, DurableCutoverError> {
    let metadata = fs::symlink_metadata(path)?;
    if !path.is_absolute()
        || !metadata.is_file()
        || metadata.file_type().is_symlink()
        || fs::canonicalize(path)? != path
    {
        return Err(DurableCutoverError::IdentityChanged);
    }
    Ok(path.to_owned())
}
fn path_string(path: &Path) -> Result<String, DurableCutoverError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or(DurableCutoverError::InvalidInput)
}
fn identity(metadata: &fs::Metadata) -> String {
    format!("{}:{}", metadata.dev(), metadata.ino())
}
fn sync_parent(path: &Path) -> Result<(), DurableCutoverError> {
    File::open(path.parent().ok_or(DurableCutoverError::InvalidInput)?)?.sync_all()?;
    Ok(())
}
fn hash_bytes(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}
fn hash_file(path: &Path) -> Result<String, DurableCutoverError> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("sha256:{}", hex::encode(hash.finalize())))
}

#[derive(Debug, Error)]
pub enum DurableCutoverError {
    #[error("cutover filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("cutover sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("cutover serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("cutover signed authority rejected: {0}")]
    Authority(#[from] hepta_campaign_writer::CampaignWriterError),
    #[error("cutover input invalid")]
    InvalidInput,
    #[error("database already enrolled")]
    AlreadyEnrolled,
    #[error("cutover file identity changed")]
    IdentityChanged,
    #[error("cutover append-only journal corrupt")]
    JournalCorrupt,
    #[error("cutover revision conflict")]
    RevisionConflict,
    #[error("cutover transition illegal")]
    IllegalTransition,
    #[error("cutover writer epoch stale")]
    StaleWriter,
    #[error("cutover writer disabled")]
    WriterDisabled,
    #[error("cutover canary scope rejected")]
    CanaryScopeRejected,
    #[error("cutover shadow outputs differ")]
    ShadowMismatch,
    #[error("cutover restored backup mismatch")]
    RestoreMismatch,
    #[error("independent production authority required")]
    ProductionAuthorityRequired,
    #[error("signed database preimage changed")]
    DatabasePreimageChanged,
    #[error("cutover integer overflow")]
    NumericOverflow,
    #[error("application mutation failed: {0}")]
    Application(String),
}

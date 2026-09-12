//! Crash-durable control-plane result journal in the campaign writer transaction.

use std::collections::BTreeSet;

use super::*;

/// Exact optional schema for the durable control stream and result group.
pub const CONTROL_STREAM_SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS control_streams_v1 (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(campaign_id),
  initial_state_hash TEXT NOT NULL,
  verifier_hash TEXT NOT NULL,
  next_sequence INTEGER NOT NULL CHECK(next_sequence > 0)
) STRICT;
CREATE TABLE IF NOT EXISTS control_results_v1 (
  campaign_id TEXT NOT NULL REFERENCES control_streams_v1(campaign_id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  result_hash TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  actual_cost_microusd INTEGER NOT NULL CHECK(actual_cost_microusd >= 0),
  writer_generation INTEGER NOT NULL CHECK(writer_generation > 0),
  PRIMARY KEY(campaign_id, sequence),
  UNIQUE(campaign_id, result_hash),
  UNIQUE(campaign_id, attempt_id)
) STRICT;
"#;
/// Exact optional schema marking an explicitly local-only writer database.
pub const LOCAL_WRITER_SCHEMA_V1: &str = r#"
CREATE TABLE local_writer_identity_v1 (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  purpose TEXT NOT NULL CHECK(purpose = 'local_only')
) STRICT;
"#;
const MAXIMUM_ENTRY_BYTES: usize = 4 * 1024 * 1024;
const MAXIMUM_BATCH_ENTRIES: usize = 4_096;

/// One prepared result and its immutable receipt, persisted in the same transaction.
/// Verification capability checking is performed by the sealed control sequencer;
/// this lower storage layer enforces fencing, immutable retries, budget and sequence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurableControlEntryV1 {
    pub sequence: u64,
    pub result_hash: Sha256Digest,
    pub attempt_id: String,
    pub plan_hash: Sha256Digest,
    pub result_json: String,
    pub receipt_json: String,
    pub actual_cost_microusd: u64,
}

/// Replayable persisted control stream. Entries are ordered by commit sequence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DurableControlLogV1 {
    pub initial_state_hash: Sha256Digest,
    pub verifier_hash: Sha256Digest,
    pub next_sequence: u64,
    pub entries: Vec<DurableControlEntryV1>,
}

impl CampaignWriterStoreV1 {
    /// Read one consistent local-only campaign/control snapshot without acquiring
    /// a writer or changing campaign data. SQLite may coordinate existing WAL
    /// readers; this is not an immutable-file/production inspection API.
    pub fn read_local_control_snapshot(
        path: impl AsRef<Path>,
        policy: CampaignWriterPolicyV1,
        campaign_id: &str,
    ) -> Result<(CampaignSnapshotV1, DurableControlLogV1, u64), CampaignWriterError> {
        let policy = policy.validate()?;
        validate_identifier(campaign_id)?;
        inspect_database_file(path.as_ref(), policy)?;
        let before = fs::symlink_metadata(path.as_ref())
            .map_err(|error| CampaignWriterError::Filesystem("local_read", error.kind()))?;
        let connection = Connection::open_with_flags(
            path.as_ref(),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.busy_timeout(Duration::from_millis(policy.busy_timeout_ms))?;
        connection.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;")?;
        verify_schema(&connection)?;
        assert_local_marker(&connection)?;
        validate_event_chain(&connection)?;
        let campaign = load_campaign_from(&connection, campaign_id)?;
        let log = load_log(&connection, campaign_id)?;
        let clock_floor = from_i64(connection.query_row(
            "SELECT updated_at_unix_ms FROM campaigns WHERE campaign_id=?1",
            [campaign_id],
            |row| row.get(0),
        )?)?;
        connection.execute_batch("COMMIT;")?;
        let after = fs::symlink_metadata(path.as_ref())
            .map_err(|error| CampaignWriterError::Filesystem("local_read", error.kind()))?;
        if !same_database_identity(&before, &after) {
            return Err(CampaignWriterError::DatabasePreimageChanged);
        }
        Ok((campaign, log, clock_floor))
    }

    /// Creates a NEW disposable/local database, durably marked non-production.
    /// Existing paths are never adopted, and no signed production permit is minted.
    pub fn create_local(
        path: impl AsRef<Path>,
        policy: CampaignWriterPolicyV1,
    ) -> Result<Self, CampaignWriterError> {
        let policy = policy.validate()?;
        inspect_absent_destination(path.as_ref(), policy.owner_uid)?;
        // Reserve the destination exclusively before SQLite can open it. A crash
        // before the local marker commits leaves an unmarked database that cannot
        // be reopened through the local path.
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path.as_ref())
            .and_then(|file| file.sync_all())
            .map_err(|error| CampaignWriterError::Filesystem("create_local", error.kind()))?;
        sync_parent(path.as_ref())?;
        let mut store = Self::open_internal(path, policy, None)?;
        let tx = store
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(LOCAL_WRITER_SCHEMA_V1)?;
        tx.execute(
            "INSERT INTO local_writer_identity_v1 VALUES(1, 'local_only')",
            [],
        )?;
        tx.commit()?;
        store.local_only = true;
        store.checkpoint()?;
        Ok(store)
    }

    /// Reopens only a database carrying the durable local-only identity marker.
    /// This path rejects an existing Node database or signed production writer DB.
    pub fn open_local(
        path: impl AsRef<Path>,
        policy: CampaignWriterPolicyV1,
    ) -> Result<Self, CampaignWriterError> {
        let policy = policy.validate()?;
        inspect_database_file(path.as_ref(), policy)?;
        let connection = Connection::open_with_flags(
            path.as_ref(),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        verify_schema(&connection)?;
        assert_local_marker(&connection)?;
        drop(connection);
        let mut store = Self::open_internal(path, policy, None)?;
        // Repeat under the exclusive SQLite connection; do not trust the precheck.
        assert_local_marker(&store.connection)?;
        store.local_only = true;
        Ok(store)
    }

    /// Whether this connection belongs to an explicitly marked local-only store.
    #[must_use]
    pub fn is_local_only(&self) -> bool {
        self.local_only
    }

    /// Reads the complete durable stream for inspection, export or typed replay.
    /// Authority and result-capability checks remain the sequencer's responsibility.
    pub fn load_control_log(
        &self,
        campaign_id: &str,
    ) -> Result<DurableControlLogV1, CampaignWriterError> {
        validate_identifier(campaign_id)?;
        load_log(&self.connection, campaign_id)
    }

    /// Binds a durable stream to a campaign and trusted verifier exactly once.
    pub fn open_control_log(
        &mut self,
        writer: &WriterLeaseV1,
        campaign_id: &str,
        initial_state_hash: &Sha256Digest,
        verifier_hash: &Sha256Digest,
        now_unix_ms: u64,
    ) -> Result<DurableControlLogV1, CampaignWriterError> {
        validate_identifier(campaign_id)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_writer(&tx, writer, now_unix_ms)?;
        load_campaign_from(&tx, campaign_id)?;
        tx.execute_batch(CONTROL_STREAM_SCHEMA_V1)?;
        tx.execute(
            "INSERT INTO control_streams_v1(campaign_id,initial_state_hash,verifier_hash,next_sequence)
             VALUES(?1,?2,?3,1) ON CONFLICT(campaign_id) DO NOTHING",
            params![campaign_id, initial_state_hash.as_str(), verifier_hash.as_str()],
        )?;
        let log = load_log(&tx, campaign_id)?;
        if &log.initial_state_hash != initial_state_hash || &log.verifier_hash != verifier_hash {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        tx.commit()?;
        Ok(log)
    }

    /// Atomically appends verified control results, receipts, budget debits and
    /// campaign events. A replay must match every persisted byte and is free.
    /// Any failed item rolls back the complete transaction, including prior items.
    pub fn append_control_batch(
        &mut self,
        writer: &WriterLeaseV1,
        campaign_id: &str,
        expected_next_sequence: u64,
        entries: &[DurableControlEntryV1],
        now_unix_ms: u64,
    ) -> Result<(), CampaignWriterError> {
        if entries.is_empty() || entries.len() > MAXIMUM_BATCH_ENTRIES {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        let mut identities = BTreeSet::new();
        let mut attempts = BTreeSet::new();
        for entry in entries {
            validate_identifier(&entry.attempt_id)?;
            if entry.result_json.is_empty()
                || entry.result_json.len() > MAXIMUM_ENTRY_BYTES
                || entry.receipt_json.is_empty()
                || entry.receipt_json.len() > MAXIMUM_ENTRY_BYTES
                || !identities.insert(&entry.result_hash)
                || !attempts.insert(&entry.attempt_id)
                || entry.plan_hash != entries[0].plan_hash
            {
                return Err(CampaignWriterError::ControlLogConflict);
            }
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_writer(&tx, writer, now_unix_ms)?;
        let campaign = load_campaign_from(&tx, campaign_id)?;
        let mut next_sequence: u64 = from_i64(tx.query_row(
            "SELECT next_sequence FROM control_streams_v1 WHERE campaign_id = ?1",
            [campaign_id],
            |row| row.get(0),
        )?)?;
        if next_sequence != expected_next_sequence {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        let mut spent = 0_u64;
        let mut inserted = 0_u64;
        for entry in entries {
            if let Some(existing) = load_entry_by_hash(&tx, campaign_id, &entry.result_hash)? {
                if existing != *entry {
                    return Err(CampaignWriterError::ControlLogConflict);
                }
                continue;
            }
            if campaign.state != CampaignStateV1::Running || entry.sequence != next_sequence {
                return Err(CampaignWriterError::ControlLogConflict);
            }
            spent = spent
                .checked_add(entry.actual_cost_microusd)
                .ok_or(CampaignWriterError::NumericOverflow)?;
            if spent > campaign.budget_remaining_microusd {
                return Err(CampaignWriterError::ResourceUnavailable);
            }
            tx.execute(
                "INSERT INTO control_results_v1(campaign_id,sequence,result_hash,attempt_id,
                 plan_hash,result_json,receipt_json,actual_cost_microusd,writer_generation)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    campaign_id,
                    to_i64(entry.sequence)?,
                    entry.result_hash.as_str(),
                    entry.attempt_id,
                    entry.plan_hash.as_str(),
                    entry.result_json,
                    entry.receipt_json,
                    to_i64(entry.actual_cost_microusd)?,
                    to_i64(writer.generation)?
                ],
            )?;
            append_event(
                &tx,
                campaign_id,
                "control_result_integrated",
                entry,
                now_unix_ms,
            )?;
            inserted += 1;
            next_sequence = next_sequence
                .checked_add(1)
                .ok_or(CampaignWriterError::NumericOverflow)?;
        }
        if inserted > 0 {
            let revision = campaign
                .revision
                .checked_add(inserted)
                .ok_or(CampaignWriterError::NumericOverflow)?;
            tx.execute(
                "UPDATE campaigns SET revision=?1,budget_remaining_microusd=?2,
                updated_at_unix_ms=?3 WHERE campaign_id=?4",
                params![
                    to_i64(revision)?,
                    to_i64(campaign.budget_remaining_microusd - spent)?,
                    to_i64(now_unix_ms)?,
                    campaign_id
                ],
            )?;
            tx.execute(
                "UPDATE control_streams_v1 SET next_sequence=?1 WHERE campaign_id=?2",
                params![to_i64(next_sequence)?, campaign_id],
            )?;
        }
        // Check size before COMMIT: a post-commit validation error would falsely
        // report rollback and invite an unsafe retry by a caller.
        let pages: i64 = tx.query_row("PRAGMA page_count", [], |row| row.get(0))?;
        let page_size: i64 = tx.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        if from_i64(pages)?
            .checked_mul(from_i64(page_size)?)
            .is_none_or(|bytes| bytes > self.policy.maximum_database_bytes)
        {
            return Err(CampaignWriterError::DatabaseTooLarge);
        }
        tx.commit()?;
        Ok(())
    }
}

fn assert_local_marker(connection: &Connection) -> Result<(), CampaignWriterError> {
    let marker = connection
        .query_row(
            "SELECT purpose FROM local_writer_identity_v1 WHERE singleton=1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| CampaignWriterError::NotLocalDatabase)?;
    if marker != "local_only" {
        return Err(CampaignWriterError::NotLocalDatabase);
    }
    Ok(())
}

/// Exact schema comparison, including optional groups. Replaying the trusted
/// DDL lets SQLite normalize its own SQL text; unknown triggers, partial groups,
/// altered constraints and extra tables are rejected before a writer opens.
pub(crate) fn verify_known_schema(connection: &Connection) -> Result<(), CampaignWriterError> {
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(SCHEMA)?;
    let control_count: i64 = connection.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('control_streams_v1','control_results_v1')",
        [], |row| row.get(0),
    )?;
    match control_count {
        0 => (),
        2 => expected.execute_batch(CONTROL_STREAM_SCHEMA_V1)?,
        _ => return Err(CampaignWriterError::SchemaMismatch),
    }
    let local_count: i64 = connection.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='local_writer_identity_v1'",
        [],
        |row| row.get(0),
    )?;
    if local_count == 1 {
        expected.execute_batch(LOCAL_WRITER_SCHEMA_V1)?;
    }
    if schema_rows(connection)? != schema_rows(&expected)? {
        return Err(CampaignWriterError::SchemaMismatch);
    }
    Ok(())
}

type SchemaRow = (String, String, String, Option<String>);

fn schema_rows(connection: &Connection) -> Result<Vec<SchemaRow>, CampaignWriterError> {
    let mut statement = connection.prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name"
    )?;
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn load_log(
    connection: &Connection,
    campaign_id: &str,
) -> Result<DurableControlLogV1, CampaignWriterError> {
    let (initial, verifier, next): (String, String, i64) = connection.query_row(
        "SELECT initial_state_hash,verifier_hash,next_sequence FROM control_streams_v1 WHERE campaign_id=?1",
        [campaign_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let mut statement = connection.prepare("SELECT sequence,result_hash,attempt_id,plan_hash,result_json,
        receipt_json,actual_cost_microusd FROM control_results_v1 WHERE campaign_id=?1 ORDER BY sequence")?;
    let entries = statement
        .query_map([campaign_id], entry_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(DurableControlLogV1 {
        initial_state_hash: Sha256Digest::from_str(&initial)
            .map_err(|_| CampaignWriterError::ControlLogConflict)?,
        verifier_hash: Sha256Digest::from_str(&verifier)
            .map_err(|_| CampaignWriterError::ControlLogConflict)?,
        next_sequence: from_i64(next)?,
        entries,
    })
}

fn load_entry_by_hash(
    connection: &Connection,
    campaign_id: &str,
    hash: &Sha256Digest,
) -> Result<Option<DurableControlEntryV1>, CampaignWriterError> {
    connection
        .query_row(
            "SELECT sequence,result_hash,attempt_id,plan_hash,result_json,receipt_json,
        actual_cost_microusd FROM control_results_v1 WHERE campaign_id=?1 AND result_hash=?2",
            params![campaign_id, hash.as_str()],
            entry_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DurableControlEntryV1> {
    let result_hash: String = row.get(1)?;
    let plan_hash: String = row.get(3)?;
    Ok(DurableControlEntryV1 {
        sequence: from_i64(row.get(0)?).map_err(to_sqlite_error)?,
        result_hash: Sha256Digest::from_str(&result_hash)
            .map_err(|_| to_sqlite_error(CampaignWriterError::ControlLogConflict))?,
        attempt_id: row.get(2)?,
        plan_hash: Sha256Digest::from_str(&plan_hash)
            .map_err(|_| to_sqlite_error(CampaignWriterError::ControlLogConflict))?,
        result_json: row.get(4)?,
        receipt_json: row.get(5)?,
        actual_cost_microusd: from_i64(row.get(6)?).map_err(to_sqlite_error)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_open_rejects_unmarked_writer_database() {
        let root =
            std::env::temp_dir().join(format!("hepta-unmarked-local-{}", std::process::id()));
        fs::create_dir(&root).expect("private root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("mode");
        let policy = CampaignWriterPolicyV1::strict(fs::metadata(&root).expect("metadata").uid());
        let path = root.join("writer.sqlite");
        drop(CampaignWriterStoreV1::open_internal(&path, policy, None).expect("unmarked store"));
        assert!(matches!(
            CampaignWriterStoreV1::open_local(&path, policy),
            Err(CampaignWriterError::NotLocalDatabase)
        ));
        assert!(CampaignWriterStoreV1::create_local(&path, policy).is_err());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn local_open_rejects_an_internal_name_lookalike_table() {
        let root =
            std::env::temp_dir().join(format!("hepta-schema-lookalike-{}", std::process::id()));
        fs::create_dir(&root).expect("private root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("mode");
        let policy = CampaignWriterPolicyV1::strict(fs::metadata(&root).expect("metadata").uid());
        let path = root.join("writer.sqlite");
        let store = CampaignWriterStoreV1::create_local(&path, policy).expect("local store");
        // LIKE 'sqlite_%' incorrectly treats '_' as any character and would
        // hide this attacker-added user table from strict schema comparison.
        store
            .connection
            .execute_batch("CREATE TABLE sqliteXrogue(value TEXT)")
            .expect("unexpected table");
        drop(store);
        assert!(matches!(
            CampaignWriterStoreV1::open_local(&path, policy),
            Err(CampaignWriterError::SchemaMismatch)
        ));
        fs::remove_dir_all(root).expect("cleanup");
    }

    /// This branch exits without running destructors while SQLite has an open
    /// transaction. The parent proves restart discards its partial budget update.
    #[test]
    fn local_crash_child() {
        let Ok(path) = std::env::var("HEPTA_CONTROL_CRASH_DB") else {
            return;
        };
        let path = PathBuf::from(path);
        let policy = CampaignWriterPolicyV1::strict(
            fs::metadata(path.parent().expect("parent"))
                .expect("metadata")
                .uid(),
        );
        let mut store = CampaignWriterStoreV1::create_local(&path, policy).expect("local DB");
        let lease = WriterLeaseV1 {
            generation: 1,
            token: "crash-test".into(),
            expires_at_unix_ms: 100_000,
        };
        let writer = store.acquire_writer(lease, 1).expect("writer");
        store
            .create_campaign(&writer, "crash-campaign", 100, 1, 0, 2)
            .expect("campaign");
        store.connection.execute_batch(
            "BEGIN IMMEDIATE;
             UPDATE campaigns SET budget_remaining_microusd=0,revision=1 WHERE campaign_id='crash-campaign';"
        ).expect("uncommitted write");
        // No drop/rollback/connection close occurs here.
        std::process::exit(73);
    }

    #[test]
    fn restart_after_process_exit_rolls_back_uncommitted_campaign_change() {
        let root = std::env::temp_dir().join(format!("hepta-control-crash-{}", std::process::id()));
        fs::create_dir(&root).expect("private root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("mode");
        let path = root.join("crash.sqlite");
        let status = std::process::Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "control::tests::local_crash_child",
                "--nocapture",
            ])
            .env("HEPTA_CONTROL_CRASH_DB", &path)
            .status()
            .expect("crash process");
        assert_eq!(status.code(), Some(73));
        let policy = CampaignWriterPolicyV1::strict(fs::metadata(&root).expect("metadata").uid());
        let store = CampaignWriterStoreV1::open_local(&path, policy).expect("recover WAL");
        let campaign = store.load_campaign("crash-campaign").expect("campaign");
        assert_eq!(campaign.budget_remaining_microusd, 100);
        assert_eq!(campaign.revision, 0);
        store.validate_integrity().expect("recovered integrity");
        drop(store);
        fs::remove_dir_all(root).expect("cleanup");
    }
}

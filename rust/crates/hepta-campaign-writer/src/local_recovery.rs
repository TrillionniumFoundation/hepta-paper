//! Immutable local workflow projection replay. This never acquires a writer.
use super::*;
use workflow_amendment::AppliedLocalWorkflowChangeV1;

/// Original immutable workflow inputs, not caller-supplied current database state.
#[derive(Clone, Debug)]
pub struct LocalRecoverySeedV1 {
    pub campaign_id: String,
    pub budget_microusd: u64,
    pub cpu_units: u64,
    pub gpu_units: u64,
    pub created_at_unix_ms: u64,
    pub writer_lease: WriterLeaseV1,
}

/// Verified local projection. An expired historical lease is not renewed.
pub struct LocalRecoverySnapshotV1 {
    pub campaign: CampaignSnapshotV1,
    pub log: DurableControlLogV1,
    pub clock_floor: u64,
    pub changes: Vec<String>,
    pub writer_lease: WriterLeaseV1,
    pub event_count: usize,
}

fn no_sidecars(path: &Path) -> Result<(), CampaignWriterError> {
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        match fs::symlink_metadata(PathBuf::from(name)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            _ => return Err(CampaignWriterError::DatabasePreimageChanged),
        }
    }
    Ok(())
}

impl CampaignWriterStoreV1 {
    /// Explicit local maintenance using a normal SQLite connection so SQLite
    /// itself owns WAL/SHM cleanup (the runtime's exclusive-locking connection
    /// can otherwise leave an earlier reader's SHM file behind).
    pub fn quiesce_local_for_backup(
        path: &Path,
        policy: CampaignWriterPolicyV1,
    ) -> Result<(), CampaignWriterError> {
        let policy = policy.validate()?;
        inspect_database_file(path, policy)?;
        let db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        db.busy_timeout(Duration::from_millis(policy.busy_timeout_ms))?;
        db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;")?;
        verify_schema(&db)?;
        assert_local_marker(&db)?;
        validate_event_chain(&db)?;
        let integrity: String = db.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if integrity != "ok" {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        db.execute_batch("PRAGMA journal_mode=WAL;")?;
        let _: i64 = db.query_row("SELECT count(*) FROM campaigns", [], |r| r.get(0))?;
        let (busy, _, _): (i64, i64, i64) =
            db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?;
        if busy != 0 {
            return Err(CampaignWriterError::CheckpointIncomplete);
        }
        let mode: String = db.query_row("PRAGMA journal_mode=DELETE", [], |r| r.get(0))?;
        if mode != "delete" {
            return Err(CampaignWriterError::CheckpointIncomplete);
        }
        drop(db);
        no_sidecars(path)?;
        File::open(path)
            .and_then(|f| f.sync_all())
            .map_err(|e| CampaignWriterError::Filesystem("quiesce_sync", e.kind()))?;
        Ok(())
    }

    /// Read a quiesced, sidecar-free local-only database using immutable=1.
    /// The caller must exclude every writer. Bytes and filesystem identity are
    /// checked again after replay; no WAL/SHM, checkpoint, lease or schema write.
    pub fn read_immutable_local_recovery(
        path: &Path,
        policy: CampaignWriterPolicyV1,
        seed: &LocalRecoverySeedV1,
    ) -> Result<LocalRecoverySnapshotV1, CampaignWriterError> {
        let policy = policy.validate()?;
        validate_identifier(&seed.campaign_id)?;
        seed.writer_lease.validate(seed.created_at_unix_ms)?;
        if !path.is_absolute() || fs::canonicalize(path).ok().as_deref() != Some(path) {
            return Err(CampaignWriterError::DatabasePathInvalid);
        }
        inspect_parent(
            path.parent()
                .ok_or(CampaignWriterError::DatabasePathInvalid)?,
            policy.owner_uid,
        )?;
        inspect_database_file(path, policy)?;
        no_sidecars(path)?;
        let before = fs::symlink_metadata(path)
            .map_err(|e| CampaignWriterError::Filesystem("recovery_identity", e.kind()))?;
        let preimage = hash_file(path, policy.maximum_database_bytes)?;
        // Percent-encode all non-path-unreserved bytes; ? and # must not inject URI options.
        let encoded: String = path
            .as_os_str()
            .as_encoded_bytes()
            .iter()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"/-_.~".contains(b) {
                    char::from(*b).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        let connection = Connection::open_with_flags(
            format!("file:{encoded}?mode=ro&immutable=1"),
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.execute_batch(
            "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; BEGIN;",
        )?;
        verify_schema(&connection)?;
        assert_local_marker(&connection)?;
        let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if integrity != "ok" {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        for (sql, expected) in [
            ("SELECT count(*) FROM pragma_foreign_key_check", 0),
            ("SELECT count(*) FROM campaigns", 1),
            ("SELECT count(*) FROM control_streams_v1", 1),
            ("SELECT count(*) FROM nodes", 0),
            ("SELECT count(*) FROM writer_lease", 1),
        ] {
            if connection.query_row(sql, [], |r| r.get::<_, i64>(0))? != expected {
                return Err(CampaignWriterError::ControlLogConflict);
            }
        }
        let (count, bytes): (i64, i64) = connection.query_row(
            "SELECT count(*),coalesce(sum(length(result_json)+length(receipt_json)),0) FROM control_results_v1",
            [], |r| Ok((r.get(0)?,r.get(1)?)),
        )?;
        if count > 128 || bytes > 64 * 1024 * 1024 {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        let wrong_generation: i64 = connection.query_row(
            "SELECT count(*) FROM control_results_v1 WHERE writer_generation != ?1",
            [to_i64(seed.writer_lease.generation)?],
            |r| r.get(0),
        )?;
        if wrong_generation != 0 {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        let events: i64 =
            connection.query_row("SELECT count(*) FROM campaign_events", [], |r| r.get(0))?;
        if events <= 0 || events > 4096 {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        validate_event_chain(&connection)?;
        let log = load_log(&connection, &seed.campaign_id)?;
        let changes = workflow_amendment::load_changes(&connection, &seed.campaign_id)?;
        let (campaign, clock_floor, writer_lease) =
            replay_projection(&connection, seed, &log, &changes)?;
        let output = LocalRecoverySnapshotV1 {
            campaign,
            log,
            clock_floor,
            writer_lease,
            event_count: events as usize,
            changes: changes
                .iter()
                .map(|r| serde_json::to_string(r).map_err(|_| CampaignWriterError::Serialization))
                .collect::<Result<_, _>>()?,
        };
        connection.execute_batch("COMMIT;")?;
        drop(connection);
        inspect_database_file(path, policy)?;
        no_sidecars(path)?;
        let after = fs::symlink_metadata(path)
            .map_err(|e| CampaignWriterError::Filesystem("recovery_identity", e.kind()))?;
        if !same_database_identity(&before, &after)
            || before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
            || preimage != hash_file(path, policy.maximum_database_bytes)?
        {
            return Err(CampaignWriterError::DatabasePreimageChanged);
        }
        Ok(output)
    }
}

fn payload_matches<T: Serialize>(payload: &str, value: &T) -> Result<bool, CampaignWriterError> {
    Ok(hash_serialized("HeptaCampaignEventPayloadV1", value)?.as_str() == payload)
}

fn replay_projection(
    db: &Connection,
    seed: &LocalRecoverySeedV1,
    log: &DurableControlLogV1,
    changes: &[AppliedLocalWorkflowChangeV1],
) -> Result<(CampaignSnapshotV1, u64, WriterLeaseV1), CampaignWriterError> {
    let mut query = db.prepare("SELECT campaign_id,event_kind,payload_hash,recorded_at_unix_ms FROM campaign_events ORDER BY sequence")?;
    let mut rows = query.query([])?;
    let mut state = CampaignStateV1::Running;
    let mut budget = seed.budget_microusd;
    let mut revision = 0u64;
    let mut last = 0u64;
    let mut created = false;
    let mut committed = 0usize;
    let mut amended = 0usize;
    let mut lease = seed.writer_lease.clone();
    while let Some(row) = rows.next()? {
        let campaign: String = row.get(0)?;
        let kind: String = row.get(1)?;
        let payload: String = row.get(2)?;
        let now = from_i64(row.get(3)?)?;
        if campaign != seed.campaign_id || now < last || now == 0 || now >= lease.expires_at_unix_ms
        {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        if !created {
            if kind != "campaign_created"
                || now != seed.created_at_unix_ms
                || !payload_matches(
                    &payload,
                    &CampaignCreatedEventV1 {
                        budget_microusd: seed.budget_microusd,
                        cpu_units: seed.cpu_units,
                        gpu_units: seed.gpu_units,
                    },
                )?
            {
                return Err(CampaignWriterError::ControlLogConflict);
            }
            created = true;
            last = now;
            continue;
        }
        if matches!(
            state,
            CampaignStateV1::Cancelled | CampaignStateV1::Completed
        ) {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        match kind.as_str() {
            "control_result_integrated" => {
                let entry = log
                    .entries
                    .get(committed)
                    .ok_or(CampaignWriterError::ControlLogConflict)?;
                if state != CampaignStateV1::Running
                    || entry.sequence != committed as u64 + 1
                    || !payload_matches(&payload, entry)?
                {
                    return Err(CampaignWriterError::ControlLogConflict);
                }
                budget = budget
                    .checked_sub(entry.actual_cost_microusd)
                    .ok_or(CampaignWriterError::ResourceUnavailable)?;
                committed += 1;
            }
            "local_workflow_amended_v1" => {
                let record = changes
                    .get(amended)
                    .ok_or(CampaignWriterError::ControlLogConflict)?;
                if record.change.expected_revision != revision
                    || record.change.committed_steps != committed as u64
                    || record.recorded_at_unix_ms != now
                    || record.change.previous_lease != lease
                    || !payload_matches(&payload, record)?
                {
                    return Err(CampaignWriterError::ControlLogConflict);
                }
                budget = budget
                    .checked_add(record.change.additional_budget_microusd)
                    .ok_or(CampaignWriterError::NumericOverflow)?;
                lease = record.change.next_lease.clone();
                amended += 1;
            }
            "campaign_state_changed" => {
                let mut found = None;
                for next in [
                    CampaignStateV1::Running,
                    CampaignStateV1::Paused,
                    CampaignStateV1::Cancelled,
                    CampaignStateV1::Completed,
                ] {
                    if payload_matches(&payload, &CampaignStateEventV1 { next_state: next })? {
                        found = Some(next);
                    }
                }
                let next = found.ok_or(CampaignWriterError::ControlLogConflict)?;
                if (next == CampaignStateV1::Running && state != CampaignStateV1::Paused)
                    || (next == CampaignStateV1::Paused && state != CampaignStateV1::Running)
                {
                    return Err(CampaignWriterError::ControlLogConflict);
                }
                state = next;
            }
            _ => return Err(CampaignWriterError::ControlLogConflict),
        }
        revision = revision
            .checked_add(1)
            .ok_or(CampaignWriterError::NumericOverflow)?;
        last = now;
    }
    let campaign = load_campaign_from(db, &seed.campaign_id)?;
    let (stored_lease, created_at, updated_at) = {
        let lease = db.query_row(
            "SELECT generation,token,expires_at_unix_ms FROM writer_lease WHERE singleton=1",
            [],
            |r| {
                Ok(WriterLeaseV1 {
                    generation: from_i64(r.get(0)?).map_err(to_sqlite_error)?,
                    token: r.get(1)?,
                    expires_at_unix_ms: from_i64(r.get(2)?).map_err(to_sqlite_error)?,
                })
            },
        )?;
        let (created, updated): (i64, i64) = db.query_row(
            "SELECT created_at_unix_ms,updated_at_unix_ms FROM campaigns WHERE campaign_id=?1",
            [&seed.campaign_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        (lease, from_i64(created)?, from_i64(updated)?)
    };
    if !created
        || committed != log.entries.len()
        || amended != changes.len()
        || log.next_sequence != committed as u64 + 1
        || campaign.revision != revision
        || campaign.state != state
        || campaign.budget_remaining_microusd != budget
        || campaign.cpu_remaining != seed.cpu_units
        || campaign.gpu_remaining != seed.gpu_units
        || stored_lease != lease
        || created_at != seed.created_at_unix_ms
        || updated_at != last
    {
        return Err(CampaignWriterError::ControlLogConflict);
    }
    Ok((campaign, last, lease))
}

//! Append-only local workflow amendments in the existing writer database.
//! This schema is optional, versioned and valid only beside the local marker.
//! It does not introduce a second progress ledger or production write entrypoint.

use super::*;

pub const LOCAL_WORKFLOW_AMENDMENT_SCHEMA_V1: &str = r#"
CREATE TABLE local_workflow_amendments_v1 (
  campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id),
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  operation_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  PRIMARY KEY(campaign_id, ordinal),
  UNIQUE(campaign_id, operation_id)
) STRICT;
"#;
const MAX_DOCUMENT: usize = 16 * 1024 * 1024;
const MAX_HISTORY: usize = 64 * 1024 * 1024;
const MAX_AMENDMENTS: usize = 128;

/// Storage contract; the service additionally checks the typed definition,
/// unchanged committed prefix, registry, pending dispatch and repair policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalWorkflowChangeV1 {
    pub operation_id: String,
    pub request_hash: Sha256Digest,
    pub previous_definition_hash: Sha256Digest,
    pub definition_hash: Sha256Digest,
    pub definition_json: String,
    pub expected_revision: u64,
    pub committed_steps: u64,
    pub additional_budget_microusd: u64,
    pub previous_lease: WriterLeaseV1,
    pub next_lease: WriterLeaseV1,
    pub repair_rejected_review: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedLocalWorkflowChangeV1 {
    pub version: u16,
    pub campaign_id: String,
    pub ordinal: u64,
    pub applied_revision: u64,
    pub recorded_at_unix_ms: u64,
    pub change: LocalWorkflowChangeV1,
}

fn has_table(connection: &Connection) -> Result<bool, CampaignWriterError> {
    Ok(connection.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='local_workflow_amendments_v1'",
        [], |row| row.get::<_, i64>(0),
    )? == 1)
}

fn validate_change(change: &LocalWorkflowChangeV1) -> Result<(), CampaignWriterError> {
    validate_identifier(&change.operation_id)?;
    if change.definition_json.is_empty()
        || change.definition_json.len() > MAX_DOCUMENT
        || change.committed_steps > 128
        || change.previous_lease.generation != change.next_lease.generation
        || change.previous_lease.token != change.next_lease.token
        || change.next_lease.expires_at_unix_ms < change.previous_lease.expires_at_unix_ms
        || change.previous_definition_hash == change.definition_hash
    {
        return Err(CampaignWriterError::ControlLogConflict);
    }
    let actual = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(change.definition_json.as_bytes()))
    );
    if actual != change.definition_hash.as_str() {
        return Err(CampaignWriterError::ControlLogConflict);
    }
    to_i64(change.additional_budget_microusd)?;
    to_i64(change.next_lease.expires_at_unix_ms)?;
    Ok(())
}

/// The complete receipt is bound into the existing event hash chain. Missing,
/// extra, reordered or changed rows fail closed, including read-only inspection.
pub(crate) fn load_changes(
    connection: &Connection,
    campaign_id: &str,
) -> Result<Vec<AppliedLocalWorkflowChangeV1>, CampaignWriterError> {
    if !has_table(connection)? {
        let events: i64 = connection.query_row(
            "SELECT count(*) FROM campaign_events WHERE event_kind='local_workflow_amended_v1'",
            [],
            |row| row.get(0),
        )?;
        if events != 0 {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        return Ok(Vec::new());
    }
    super::assert_local_marker(connection)?;
    let mut query = connection.prepare(
        "SELECT ordinal,operation_id,receipt_json FROM local_workflow_amendments_v1 WHERE campaign_id=?1 ORDER BY ordinal"
    )?;
    let mut rows = query.query([campaign_id])?;
    let mut output: Vec<AppliedLocalWorkflowChangeV1> = Vec::new();
    let mut total = 0usize;
    while let Some(row) = rows.next()? {
        let ordinal = from_i64(row.get(0)?)?;
        let operation: String = row.get(1)?;
        let text: String = row.get(2)?;
        total = total
            .checked_add(text.len())
            .ok_or(CampaignWriterError::NumericOverflow)?;
        if total > MAX_HISTORY || output.len() >= MAX_AMENDMENTS {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        let record: AppliedLocalWorkflowChangeV1 =
            serde_json::from_str(&text).map_err(|_| CampaignWriterError::ControlLogConflict)?;
        validate_change(&record.change)?;
        if record.version != 1
            || record.campaign_id != campaign_id
            || record.ordinal != ordinal
            || ordinal != output.len() as u64 + 1
            || record.change.operation_id != operation
            || record.change.expected_revision.checked_add(1) != Some(record.applied_revision)
            || record.recorded_at_unix_ms == 0
        {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        if let Some(previous) = output.last()
            && (previous.change.definition_hash != record.change.previous_definition_hash
                || previous.applied_revision > record.change.expected_revision
                || previous.change.committed_steps > record.change.committed_steps
                || previous.recorded_at_unix_ms > record.recorded_at_unix_ms)
        {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        let digest = hash_serialized("HeptaCampaignEventPayloadV1", &record)?;
        let matching: i64 = connection.query_row(
            "SELECT count(*) FROM campaign_events WHERE campaign_id=?1 AND event_kind='local_workflow_amended_v1' AND payload_hash=?2 AND recorded_at_unix_ms=?3",
            params![campaign_id, digest.as_str(), to_i64(record.recorded_at_unix_ms)?], |row| row.get(0),
        )?;
        if matching != 1 {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        output.push(record);
    }
    let events: i64 = connection.query_row(
        "SELECT count(*) FROM campaign_events WHERE campaign_id=?1 AND event_kind='local_workflow_amended_v1'",
        [campaign_id], |row| row.get(0),
    )?;
    if from_i64(events)? != output.len() as u64 {
        return Err(CampaignWriterError::ControlLogConflict);
    }
    Ok(output)
}

impl CampaignWriterStoreV1 {
    /// Atomically amend local definition identity, budget, revision and lease.
    /// Exact response-loss replay returns the immutable original receipt, even
    /// after later changes or lease expiry; it performs no mutation or renewal.
    pub fn apply_local_workflow_change(
        &mut self,
        campaign_id: &str,
        change_json: &str,
        now: u64,
    ) -> Result<String, CampaignWriterError> {
        if change_json.len() > MAX_DOCUMENT * 2 {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        let change: LocalWorkflowChangeV1 = serde_json::from_str(change_json)
            .map_err(|_| CampaignWriterError::ControlLogConflict)?;
        if !self.local_only {
            return Err(CampaignWriterError::NotLocalDatabase);
        }
        validate_identifier(campaign_id)?;
        validate_change(&change)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        super::assert_local_marker(&tx)?;
        let changes = load_changes(&tx, campaign_id)?;
        if let Some(original) = changes
            .iter()
            .find(|r| r.change.operation_id == change.operation_id)
        {
            if original.change != change {
                return Err(CampaignWriterError::ControlLogConflict);
            }
            return serde_json::to_string(original).map_err(|_| CampaignWriterError::Serialization);
        }
        if changes.len() >= MAX_AMENDMENTS {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        assert_writer(&tx, &change.previous_lease, now)?;
        if load_writer_lease(&tx)?.as_ref() != Some(&change.previous_lease) {
            return Err(CampaignWriterError::StaleWriterGeneration);
        }
        change.next_lease.validate(now)?;
        let campaign = load_campaign_from(&tx, campaign_id)?;
        if campaign.revision != change.expected_revision {
            return Err(CampaignWriterError::StaleCampaignRevision);
        }
        if matches!(
            campaign.state,
            CampaignStateV1::Cancelled | CampaignStateV1::Completed
        ) {
            return Err(CampaignWriterError::TerminalCampaignCannotReopen);
        }
        let clock = from_i64(tx.query_row(
            "SELECT updated_at_unix_ms FROM campaigns WHERE campaign_id=?1",
            [campaign_id],
            |row| row.get(0),
        )?)?;
        if now < clock {
            return Err(CampaignWriterError::InvalidWriterLease);
        }
        let count = from_i64(tx.query_row(
            "SELECT count(*) FROM control_results_v1 WHERE campaign_id=?1",
            [campaign_id],
            |row| row.get(0),
        )?)?;
        let active: i64 = tx.query_row(
            "SELECT count(*) FROM nodes WHERE campaign_id=?1 AND status IN ('claimed','prepared')",
            [campaign_id],
            |row| row.get(0),
        )?;
        if count != change.committed_steps
            || active != 0
            || changes
                .last()
                .is_some_and(|r| r.change.definition_hash != change.previous_definition_hash)
        {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        let remaining = campaign
            .budget_remaining_microusd
            .checked_add(change.additional_budget_microusd)
            .ok_or(CampaignWriterError::NumericOverflow)?;
        let revision = campaign
            .revision
            .checked_add(1)
            .ok_or(CampaignWriterError::NumericOverflow)?;
        let record = AppliedLocalWorkflowChangeV1 {
            version: 1,
            campaign_id: campaign_id.to_owned(),
            ordinal: changes.len() as u64 + 1,
            applied_revision: revision,
            recorded_at_unix_ms: now,
            change,
        };
        let serialized =
            serde_json::to_string(&record).map_err(|_| CampaignWriterError::Serialization)?;
        let total = changes.iter().try_fold(serialized.len(), |n, r| {
            serde_json::to_vec(r)
                .map_err(|_| CampaignWriterError::Serialization)
                .and_then(|b| {
                    n.checked_add(b.len())
                        .ok_or(CampaignWriterError::NumericOverflow)
                })
        })?;
        if total > MAX_HISTORY {
            return Err(CampaignWriterError::ControlLogConflict);
        }
        if !has_table(&tx)? {
            tx.execute_batch(LOCAL_WORKFLOW_AMENDMENT_SCHEMA_V1)?;
        }
        tx.execute(
            "INSERT INTO local_workflow_amendments_v1(campaign_id,ordinal,operation_id,receipt_json) VALUES(?1,?2,?3,?4)",
            params![campaign_id, to_i64(record.ordinal)?, record.change.operation_id, serialized],
        )?;
        tx.execute(
            "UPDATE campaigns SET budget_remaining_microusd=?1,revision=?2,updated_at_unix_ms=?3 WHERE campaign_id=?4",
            params![to_i64(remaining)?, to_i64(revision)?, to_i64(now)?, campaign_id],
        )?;
        tx.execute(
            "UPDATE writer_lease SET expires_at_unix_ms=?1 WHERE singleton=1",
            [to_i64(record.change.next_lease.expires_at_unix_ms)?],
        )?;
        append_event(&tx, campaign_id, "local_workflow_amended_v1", &record, now)?;
        let pages = from_i64(tx.query_row("PRAGMA page_count", [], |row| row.get(0))?)?;
        let size = from_i64(tx.query_row("PRAGMA page_size", [], |row| row.get(0))?)?;
        if pages
            .checked_mul(size)
            .is_none_or(|n| n > self.policy.maximum_database_bytes)
        {
            return Err(CampaignWriterError::DatabaseTooLarge);
        }
        tx.commit()?;
        Ok(serialized)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> (Temp, CampaignWriterStoreV1, LocalWorkflowChangeV1) {
        let root = std::env::temp_dir().join(format!(
            "hepta-change-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let policy = CampaignWriterPolicyV1::strict(fs::metadata(&root).unwrap().uid());
        let mut store = CampaignWriterStoreV1::create_local(root.join("db"), policy).unwrap();
        let lease = WriterLeaseV1 {
            generation: 1,
            token: "test-local-token".into(),
            expires_at_unix_ms: 100,
        };
        let writer = store.acquire_writer(lease.clone(), 1).unwrap();
        store
            .create_campaign(&writer, "test", 100, 20, 20, 1)
            .unwrap();
        let initial: Sha256Digest = format!("sha256:{}", "1".repeat(64)).parse().unwrap();
        store
            .open_control_log(&writer, "test", &initial, &initial, 1)
            .unwrap();
        let change = LocalWorkflowChangeV1 {
            operation_id: "amend-1".into(),
            request_hash: initial.clone(),
            previous_definition_hash: initial,
            definition_hash: format!("sha256:{}", hex::encode(Sha256::digest(b"{}")))
                .parse()
                .unwrap(),
            definition_json: "{}".into(),
            expected_revision: 0,
            committed_steps: 0,
            additional_budget_microusd: 50,
            previous_lease: lease.clone(),
            next_lease: WriterLeaseV1 {
                expires_at_unix_ms: 200,
                ..lease
            },
            repair_rejected_review: false,
        };
        (Temp(root), store, change)
    }
    #[test]
    fn amendment_is_atomic_with_budget_event_and_lease_and_retry_never_renews() {
        let (_temp, mut store, change) = fixture();
        let input = serde_json::to_string(&change).unwrap();
        let first = store
            .apply_local_workflow_change("test", &input, 2)
            .unwrap();
        assert_eq!(
            store
                .load_campaign("test")
                .unwrap()
                .budget_remaining_microusd,
            150
        );
        assert_eq!(
            load_writer_lease(&store.connection)
                .unwrap()
                .unwrap()
                .expires_at_unix_ms,
            200
        );
        assert_eq!(
            store
                .apply_local_workflow_change("test", &input, 500)
                .unwrap(),
            first
        );
        assert_eq!(load_changes(&store.connection, "test").unwrap().len(), 1);
        assert_eq!(store.load_campaign("test").unwrap().revision, 1);
        store.validate_integrity().unwrap();
    }
    #[test]
    fn event_insert_failure_rolls_back_every_amendment_effect() {
        let (_temp, mut store, change) = fixture();
        store.connection.execute_batch("CREATE TEMP TRIGGER reject_change BEFORE INSERT ON campaign_events WHEN NEW.event_kind='local_workflow_amended_v1' BEGIN SELECT RAISE(ABORT,'test interruption'); END;").unwrap();
        assert!(
            store
                .apply_local_workflow_change("test", &serde_json::to_string(&change).unwrap(), 2)
                .is_err()
        );
        let campaign = store.load_campaign("test").unwrap();
        assert_eq!(campaign.revision, 0);
        assert_eq!(campaign.budget_remaining_microusd, 100);
        assert_eq!(
            load_writer_lease(&store.connection).unwrap().unwrap(),
            change.previous_lease
        );
        assert!(load_changes(&store.connection, "test").unwrap().is_empty());
        assert!(!has_table(&store.connection).unwrap());
    }
    #[test]
    fn missing_receipt_or_changed_receipt_cannot_pass_event_binding() {
        for delete in [true, false] {
            let (_temp, mut store, change) = fixture();
            store
                .apply_local_workflow_change("test", &serde_json::to_string(&change).unwrap(), 2)
                .unwrap();
            if delete {
                store
                    .connection
                    .execute("DELETE FROM local_workflow_amendments_v1", [])
                    .unwrap();
            } else {
                store
                    .connection
                    .execute(
                        "UPDATE local_workflow_amendments_v1 SET receipt_json='{}'",
                        [],
                    )
                    .unwrap();
            }
            assert!(load_changes(&store.connection, "test").is_err());
        }
    }
    #[test]
    fn forged_generation_expired_lease_overflow_and_revision_reject_without_mutation() {
        for case in 0..5 {
            let (_temp, mut store, mut change) = fixture();
            let now = if case == 0 { 101 } else { 2 };
            match case {
                1 => change.next_lease.generation += 1,
                2 => change.additional_budget_microusd = u64::MAX,
                3 => change.expected_revision += 1,
                4 => change.committed_steps += 1,
                _ => (),
            }
            assert!(
                store
                    .apply_local_workflow_change(
                        "test",
                        &serde_json::to_string(&change).unwrap(),
                        now
                    )
                    .is_err()
            );
            assert_eq!(
                store
                    .load_campaign("test")
                    .unwrap()
                    .budget_remaining_microusd,
                100
            );
            assert!(load_changes(&store.connection, "test").unwrap().is_empty());
        }
    }
}

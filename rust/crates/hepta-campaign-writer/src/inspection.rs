//! Read-only, local-only event projection. No writer lease or payload is exposed.
use super::*;

const MAX_EVENTS: u64 = 100_000;

/// Cursor binds both the immutable page prefix and the last delivered global event.
/// Sequence numbers are global: filtering a campaign may leave gaps.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalEventCursorV1 {
    pub campaign_id: String,
    pub after_sequence: u64,
    pub after_event_hash: Sha256Digest,
    pub snapshot_sequence: u64,
    pub snapshot_event_hash: Sha256Digest,
}

/// Hash-only event metadata; never raw prompts, payloads, token or result bytes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalEventV1 {
    pub sequence: u64,
    pub event_kind: String,
    pub payload_hash: Sha256Digest,
    pub previous_event_hash: Option<Sha256Digest>,
    pub event_hash: Sha256Digest,
    pub recorded_at_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalEventPageV1 {
    pub version: u16,
    pub campaign_id: String,
    pub snapshot_sequence: u64,
    pub snapshot_event_hash: Sha256Digest,
    pub events: Vec<LocalEventV1>,
    pub next_cursor: Option<LocalEventCursorV1>,
}

fn event_identity(
    connection: &Connection,
    sequence: u64,
) -> Result<(String, Sha256Digest), CampaignWriterError> {
    let (campaign, hash): (String, String) = connection.query_row(
        "SELECT campaign_id,event_hash FROM campaign_events WHERE sequence=?1",
        [to_i64(sequence)?],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok((
        campaign,
        hash.parse()
            .map_err(|_| CampaignWriterError::EventChainInvalid)?,
    ))
}

impl CampaignWriterStoreV1 {
    /// Page an existing local event chain in one read transaction. Appended events
    /// do not enter a cursor's frozen prefix. Changed/deleted anchors fail closed.
    /// The complete chain is verified, with a 100000-event local inspection bound.
    /// This is not an authenticated provenance or production inspection API.
    pub fn read_local_event_page(
        path: impl AsRef<Path>,
        policy: CampaignWriterPolicyV1,
        campaign_id: &str,
        cursor: Option<&LocalEventCursorV1>,
        limit: u16,
    ) -> Result<LocalEventPageV1, CampaignWriterError> {
        let policy = policy.validate()?;
        validate_identifier(campaign_id)?;
        if !(1..=256).contains(&limit) {
            return Err(CampaignWriterError::InvalidPolicy);
        }
        inspect_database_file(path.as_ref(), policy)?;
        let before = fs::symlink_metadata(path.as_ref())
            .map_err(|error| CampaignWriterError::Filesystem("local_events", error.kind()))?;
        let connection = Connection::open_with_flags(
            path.as_ref(),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.busy_timeout(Duration::from_millis(policy.busy_timeout_ms))?;
        connection.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;")?;
        verify_schema(&connection)?;
        assert_local_marker(&connection)?;
        load_campaign_from(&connection, campaign_id)?;
        let count = from_i64(connection.query_row(
            "SELECT COUNT(*) FROM (SELECT 1 FROM campaign_events LIMIT 100001)",
            [],
            |r| r.get(0),
        )?)?;
        if count > MAX_EVENTS {
            return Err(CampaignWriterError::InvalidPolicy);
        }
        validate_event_chain(&connection)?;
        let (first, last): (i64, i64) = connection.query_row(
            "SELECT MIN(sequence),MAX(sequence) FROM campaign_events",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let tail = from_i64(last)?;
        if first != 1 || tail != count {
            return Err(CampaignWriterError::EventChainInvalid);
        }
        let (after_sequence, snapshot_sequence, snapshot_event_hash) = if let Some(cursor) = cursor
        {
            if cursor.campaign_id != campaign_id
                || cursor.after_sequence == 0
                || cursor.after_sequence > cursor.snapshot_sequence
                || cursor.snapshot_sequence > tail
            {
                return Err(CampaignWriterError::ControlLogConflict);
            }
            let (owner, anchor) = event_identity(&connection, cursor.after_sequence)?;
            let (_, snapshot) = event_identity(&connection, cursor.snapshot_sequence)?;
            if owner != campaign_id
                || anchor != cursor.after_event_hash
                || snapshot != cursor.snapshot_event_hash
            {
                return Err(CampaignWriterError::ControlLogConflict);
            }
            (cursor.after_sequence, cursor.snapshot_sequence, snapshot)
        } else {
            (0, tail, event_identity(&connection, tail)?.1)
        };
        let mut statement = connection.prepare(
            "SELECT sequence,event_kind,payload_hash,previous_event_hash,event_hash,recorded_at_unix_ms
             FROM campaign_events WHERE campaign_id=?1 AND sequence>?2 AND sequence<=?3 ORDER BY sequence LIMIT ?4")?;
        let mut rows = statement.query(params![
            campaign_id,
            to_i64(after_sequence)?,
            to_i64(snapshot_sequence)?,
            i64::from(limit) + 1
        ])?;
        let mut events = Vec::new();
        while let Some(row) = rows.next()? {
            let kind: String = row.get(1)?;
            // Closed persisted event vocabulary prevents arbitrary text leaking via logs.
            if !matches!(
                kind.as_str(),
                "campaign_created"
                    | "node_claimed"
                    | "result_prepared"
                    | "result_integrated"
                    | "failed_pre_provider"
                    | "ambiguous"
                    | "cancelled"
                    | "campaign_state_changed"
                    | "control_result_integrated"
                    | "local_workflow_amended_v1"
            ) {
                return Err(CampaignWriterError::EventChainInvalid);
            }
            let digest = |value: String| {
                value
                    .parse()
                    .map_err(|_| CampaignWriterError::EventChainInvalid)
            };
            events.push(LocalEventV1 {
                sequence: from_i64(row.get(0)?)?,
                event_kind: kind,
                payload_hash: digest(row.get(2)?)?,
                previous_event_hash: row.get::<_, Option<String>>(3)?.map(digest).transpose()?,
                event_hash: digest(row.get(4)?)?,
                recorded_at_unix_ms: from_i64(row.get(5)?)?,
            });
        }
        let more = events.len() > usize::from(limit);
        events.truncate(usize::from(limit));
        let next_cursor = if more {
            let last = events
                .last()
                .ok_or(CampaignWriterError::ControlLogConflict)?;
            Some(LocalEventCursorV1 {
                campaign_id: campaign_id.into(),
                after_sequence: last.sequence,
                after_event_hash: last.event_hash.clone(),
                snapshot_sequence,
                snapshot_event_hash: snapshot_event_hash.clone(),
            })
        } else {
            None
        };
        drop(rows);
        drop(statement);
        connection.execute_batch("COMMIT;")?;
        let after = fs::symlink_metadata(path.as_ref())
            .map_err(|error| CampaignWriterError::Filesystem("local_events", error.kind()))?;
        if !same_database_identity(&before, &after) {
            return Err(CampaignWriterError::DatabasePreimageChanged);
        }
        Ok(LocalEventPageV1 {
            version: 1,
            campaign_id: campaign_id.into(),
            snapshot_sequence,
            snapshot_event_hash,
            events,
            next_cursor,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    struct Fixture {
        root: PathBuf,
        policy: CampaignWriterPolicyV1,
        lease: WriterLeaseV1,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "hepta-local-events-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let owner = fs::metadata(&root).unwrap().uid();
            let mut store = CampaignWriterStoreV1::create_local(
                root.join("campaign.sqlite"),
                CampaignWriterPolicyV1::strict(owner),
            )
            .unwrap();
            let lease = store
                .acquire_writer(
                    WriterLeaseV1 {
                        generation: 1,
                        token: "never-export-this-token".into(),
                        expires_at_unix_ms: 10000,
                    },
                    100,
                )
                .unwrap();
            store
                .create_campaign(&lease, "one", 100, 100, 100, 100)
                .unwrap();
            let policy = store.policy;
            drop(store);
            Self {
                root,
                policy,
                lease,
            }
        }
        fn read(
            &self,
            campaign: &str,
            cursor: Option<&LocalEventCursorV1>,
            limit: u16,
        ) -> Result<LocalEventPageV1, CampaignWriterError> {
            CampaignWriterStoreV1::read_local_event_page(
                self.root.join("campaign.sqlite"),
                self.policy,
                campaign,
                cursor,
                limit,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn local_event_pages_are_hash_bound_filtered_and_read_only() {
        let f = Fixture::new();
        let mut store =
            CampaignWriterStoreV1::open_local(f.root.join("campaign.sqlite"), f.policy).unwrap();
        store
            .create_campaign(&f.lease, "two", 100, 100, 100, 101)
            .unwrap();
        let revision = store.load_campaign("one").unwrap().revision;
        store
            .set_campaign_state(&f.lease, "one", revision, CampaignStateV1::Paused, 102)
            .unwrap();
        store.checkpoint().unwrap();
        drop(store);
        let before = fs::read(f.root.join("campaign.sqlite")).unwrap();
        let page = f.read("one", None, 1).unwrap();
        let cursor = page.next_cursor.unwrap();
        let second = f.read("one", Some(&cursor), 1).unwrap();
        assert_eq!(second.events[0].event_kind, "campaign_state_changed");
        assert_eq!(second.events[0].sequence, 3);
        assert!(second.next_cursor.is_none());
        assert!(
            !serde_json::to_string(&second)
                .unwrap()
                .contains("never-export")
        );
        assert_eq!(before, fs::read(f.root.join("campaign.sqlite")).unwrap());
    }

    #[test]
    fn local_event_reader_rejects_corruption_and_sequence_relabeling() {
        let f = Fixture::new();
        let conn = Connection::open(f.root.join("campaign.sqlite")).unwrap();
        conn.execute("UPDATE campaign_events SET sequence=2", [])
            .unwrap();
        assert!(matches!(
            f.read("one", None, 1),
            Err(CampaignWriterError::EventChainInvalid)
        ));
        conn.execute(
            "UPDATE campaign_events SET sequence=1,event_hash=?1",
            [format!("sha256:{}", "0".repeat(64))],
        )
        .unwrap();
        assert!(f.read("one", None, 1).is_err());
    }

    #[test]
    fn local_event_reader_rejects_zero_origin_even_with_matching_tail_count() {
        let f = Fixture::new();
        let mut store =
            CampaignWriterStoreV1::open_local(f.root.join("campaign.sqlite"), f.policy).unwrap();
        store
            .create_campaign(&f.lease, "two", 100, 100, 100, 101)
            .unwrap();
        drop(store);
        let conn = Connection::open(f.root.join("campaign.sqlite")).unwrap();
        conn.execute("UPDATE campaign_events SET sequence=0 WHERE sequence=1", [])
            .unwrap();
        assert!(matches!(
            f.read("one", None, 1),
            Err(CampaignWriterError::EventChainInvalid)
        ));
    }

    #[test]
    fn local_event_reader_rejects_production_marker_drift_and_unsafe_paths() {
        let f = Fixture::new();
        assert!(f.read("missing", None, 1).is_err());
        assert!(f.read("one", None, 0).is_err());
        assert!(f.read("one", None, 257).is_err());
        let alias = f.root.join("alias.sqlite");
        std::os::unix::fs::symlink(f.root.join("campaign.sqlite"), &alias).unwrap();
        assert!(
            CampaignWriterStoreV1::read_local_event_page(&alias, f.policy, "one", None, 1).is_err()
        );
        let conn = Connection::open(f.root.join("campaign.sqlite")).unwrap();
        conn.execute("DELETE FROM local_writer_identity_v1", [])
            .unwrap();
        assert!(f.read("one", None, 1).is_err());
    }
}

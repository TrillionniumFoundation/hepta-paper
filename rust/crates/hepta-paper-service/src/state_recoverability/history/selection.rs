//! Read-only discovery of authenticated historical snapshots. Candidate status
//! grants no authority; only the complete replay/publication path returns a
//! current source. A selected candidate's replay failure never becomes renewal.
use super::*;
use std::os::unix::fs::MetadataExt;

pub(in super::super) fn replay_best_heartbeat_history<
    B: StateBackupAuthorityTransportV1,
    O: MutationAuthorityTransportV1,
>(
    service: &mut BackupRecoveryServiceV1<B, O>,
    clock: &mut dyn MutationClockV1,
    now: i64,
    maximum_age: i64,
) -> Result<Option<CurrentRestoreSourcesV1>> {
    if matches!(fs::symlink_metadata(&service.options.backup_root), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(None);
    }
    let root = Directory::open_or_create(&service.options.backup_root, false)?;
    let mut candidates = Vec::new();
    for (count, entry) in fs::read_dir(&root.path).map_err(|_| invalid())?.enumerate() {
        ensure(
            count < 4096,
            "autonomous_research_state_backup_source_candidate_limit",
        )?;
        let entry = entry.map_err(|_| invalid())?;
        let name = entry.file_name().into_string().map_err(|_| invalid())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| invalid())?;
        if metadata.is_dir() && !metadata.is_symlink() && !name.starts_with('.') {
            candidates.push((entry.path(), metadata.mtime(), metadata.mtime_nsec()));
        }
    }
    root.assert_current()?;
    if candidates.is_empty() {
        return Ok(None);
    }
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    candidates.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then(b.2.cmp(&a.2))
            .then_with(|| collator.compare(&b.0.to_string_lossy(), &a.0.to_string_lossy()))
    });
    let inventory = service.inventory()?;
    let mut skipped = Vec::new();
    for (path, seconds, nanos) in candidates {
        // This stage performs only local reads/signature checks. No candidate
        // probe reserves a backup or asks either authority for evidence.
        let candidate = match HistoricalBackupCandidateV1::load(
            service,
            &path,
            &inventory,
            now,
            maximum_age,
        ) {
            Ok(candidate) => candidate,
            Err(cause) => {
                let blocker = cause
                    .code
                    .split(':')
                    .next()
                    .filter(|s| {
                        s.starts_with("autonomous_research_state_")
                            && s.bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                    })
                    .unwrap_or("autonomous_research_state_backup_candidate_invalid");
                skipped.push(json!({
                    "candidateDirectoryNameHash":hash("AutonomousResearchStateBackupCandidateDirectoryName", &json!(path.file_name().and_then(|s| s.to_str()).unwrap_or_default()))?,
                    "modifiedAt":iso(seconds.saturating_mul(1000).saturating_add(nanos / 1_000_000))?,
                    "blockers":[blocker],
                }));
                continue;
            }
        };
        // A newly finalized snapshot whose actual bytes have not changed is
        // not a historical-journal candidate. In particular, a missing drill
        // must retain the original fresh-renewal path instead of turning the
        // complete-journal assertion below into a new fatal error. An actual
        // heartbeat changes the resident database and signed journal bytes.
        if candidate.bundle["content"]["inventoryHash"] == inventory.value()["inventoryHash"] {
            root.assert_current()?;
            inventory
                .assert_current()
                .map_err(|e| error(e.to_string()))?;
            // Do not select an older historical candidate past a newer,
            // authenticated current snapshot that needs its original renewal.
            return Ok(None);
        }
        root.assert_current()?;
        let mut source = replay_candidate(
            service,
            candidate,
            inventory,
            clock,
            now,
            ReplayPolicy::Automatic,
        )?;
        root.assert_current()?;
        source.inspection["skippedCandidates"] = skipped.into();
        return Ok(Some(source));
    }
    root.assert_current()?;
    inventory
        .assert_current()
        .map_err(|e| error(e.to_string()))?;
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_generated_value_is_rejected_by_sqlite_before_row_materialization() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE generated(v INTEGER, result BLOB GENERATED ALWAYS AS (zeroblob(v)) VIRTUAL); INSERT INTO generated(v) VALUES(16777217)").unwrap();
        equivalence::limit_private_sqlite(&db).unwrap();
        assert_eq!(
            db.limit(rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH)
                .unwrap(),
            16 * 1024 * 1024
        );
        let error = db
            .query_row::<Vec<u8>, _, _>("SELECT result FROM generated", [], |r| r.get(0))
            .unwrap_err();
        assert_eq!(error.sqlite_error_code(), Some(rusqlite::ErrorCode::TooBig));
        assert!(equivalence::effective_digest(&db).is_err());
        db.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH, 1024)
            .unwrap();
        equivalence::limit_private_sqlite(&db).unwrap();
        assert_eq!(
            db.limit(rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH)
                .unwrap(),
            1024,
            "a caller's stricter limit must not be raised"
        );
        assert!(db.is_autocommit());
    }

    #[test]
    fn automatic_proof_observes_unkeyed_duplicates_and_generated_blob_values() {
        let left = Connection::open_in_memory().unwrap();
        let right = Connection::open_in_memory().unwrap();
        for db in [&left, &right] {
            db.execute_batch("CREATE TABLE loose(value); INSERT INTO loose VALUES(NULL),(NULL); CREATE TABLE computed(value, derived TEXT GENERATED ALWAYS AS (typeof(value)||hex(value)) STORED, virtual_length INT GENERATED ALWAYS AS (length(value)) VIRTUAL); INSERT INTO computed(value) VALUES('ab');").unwrap();
        }
        let expected = equivalence::effective_digest(&left).unwrap();
        assert_eq!(expected, equivalence::effective_digest(&right).unwrap());
        right.execute("INSERT INTO loose VALUES(NULL)", []).unwrap();
        assert_ne!(expected, equivalence::effective_digest(&right).unwrap());
        right
            .execute("DELETE FROM loose WHERE rowid=3", [])
            .unwrap();
        assert_eq!(expected, equivalence::effective_digest(&right).unwrap());
        right
            .execute("UPDATE computed SET value = X'6162'", [])
            .unwrap();
        let values: (String, i64) = right
            .query_row("SELECT derived,virtual_length FROM computed", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(values, ("blob6162".into(), 2));
        assert_ne!(expected, equivalence::effective_digest(&right).unwrap());
        assert!(left.is_autocommit() && right.is_autocommit());
    }
}

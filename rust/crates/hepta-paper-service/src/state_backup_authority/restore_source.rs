//! Read-only validation of a stored restore-drill source. It does not perform a
//! fresh restore drill or issue an epoch permit; a live head/lease check remains
//! necessary before the recoverability controller can authorize an action.
use super::*;
use std::{collections::BTreeSet, fs, path::PathBuf};
mod private_sqlite;
mod validation;

pub struct StoredRestoreSourceOptionsV1<'a> {
    pub bundle_path: &'a Path,
    pub bundle_file_hash: &'a str,
    pub restore_receipt_file_hash: &'a str,
    pub state_database_manifest: &'a Value,
    pub current_inventory: &'a Value,
    pub now: i64,
}
pub struct VerifiedStoredRestoreSourceV1 {
    inspection: Value,
    snapshot_files: Vec<Snapshot>,
    inventory_hash: String,
    performed_at: i64,
    bundle_path: PathBuf,
    database_paths: BTreeSet<String>,
}
impl VerifiedStoredRestoreSourceV1 {
    pub fn inspection(&self) -> &Value {
        &self.inspection
    }
    /// Checks the inspected bytes and exact current inventory claim again. The
    /// caller must independently obtain that inventory from observed live files.
    pub fn assert_current(&self, inventory: &Value, now: i64) -> Result<()> {
        if hash(
            "AutonomousResearchStateRestoreSourceInventoryBinding",
            inventory,
        )? != self.inventory_hash
            || now < self.performed_at
            || now - self.performed_at > 86_400_000
        {
            return Err(error(
                "autonomous_research_state_backup_restore_source_stale",
            ));
        }
        database_set(&self.bundle_path, &self.database_paths)?;
        for file in &self.snapshot_files {
            file.assert_current()
                .map_err(|_| error("autonomous_research_state_backup_source_database_changed"))?;
        }
        Ok(())
    }
}
fn database_set(root: &Path, expected: &BTreeSet<String>) -> Result<()> {
    let code = "autonomous_research_state_backup_source_database_set_invalid";
    let present = fs::read_dir(root.join("databases"))
        .map_err(|_| error(code))?
        .take(expected.len() + 1)
        .map(|entry| {
            entry
                .map(|e| format!("databases/{}", e.file_name().to_string_lossy()))
                .map_err(|_| error(code))
        })
        .collect::<Result<BTreeSet<_>>>()?;
    ensure(&present == expected, code)
}
fn ensure(valid: bool, code: &str) -> Result<()> {
    if valid { Ok(()) } else { Err(error(code)) }
}
fn without(value: &Value, key: &str) -> Result<Value> {
    let mut o = value
        .as_object()
        .cloned()
        .ok_or_else(|| error("autonomous_research_state_backup_document_invalid"))?;
    o.remove(key);
    Ok(Value::Object(o))
}
fn strings(value: &Value, key: &str) -> Result<Vec<String>> {
    value
        .as_array()
        .ok_or_else(|| error("autonomous_research_state_backup_database_record_invalid"))?
        .iter()
        .map(|v| {
            v[key]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| error("autonomous_research_state_backup_database_record_invalid"))
        })
        .collect()
}
fn backup_path(value: &Value) -> bool {
    value.as_str().is_some_and(|v| {
        v.strip_prefix("databases/")
            .and_then(|v| v.strip_suffix(".sqlite"))
            .is_some_and(|s| {
                !s.is_empty()
                    && s.as_bytes()[0].is_ascii_alphanumeric()
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
            })
    })
}
fn absent(path: &Path) -> bool {
    matches!(fs::symlink_metadata(path),Err(e)if e.kind()==std::io::ErrorKind::NotFound)
}
fn inspect_database(file: &Snapshot, entry: &Value, definition: &Value) -> Result<()> {
    let invalid = || error("autonomous_research_state_backup_source_database_invalid");
    for suffix in ["-journal", "-wal", "-shm"] {
        if !absent(&PathBuf::from(format!("{}{suffix}", file.path.display()))) {
            return Err(invalid());
        }
    }
    let private = private_sqlite::PrivateSqliteSnapshot::new(file)?;
    let database = private.open()?;
    let checks = database
        .prepare("PRAGMA quick_check;")
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|_| invalid())?;
    let foreign = database
        .prepare("PRAGMA foreign_key_check;")
        .and_then(|mut s| {
            s.query_map([], |_| Ok(()))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|_| invalid())?;
    let rows=database.prepare("SELECT type,name,tbl_name,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name,sql;").and_then(|mut s|s.query_map([],|r|Ok(json!({"type":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"tbl_name":r.get::<_,String>(2)?,"sql":r.get::<_,String>(3)?})))?.collect::<rusqlite::Result<Vec<_>>>()).map_err(|_|invalid())?;
    // Keep the original Node hash projection, but inspect the full user-object
    // surface separately: LIKE's '_' wildcard also hides valid sqliteX names.
    let objects = database
        .prepare("SELECT type || ':' || name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*';")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<BTreeSet<_>>>()
        })
        .map_err(|_| invalid())?;
    let user: i64 = database
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|_| invalid())?;
    let application: i64 = database
        .pragma_query_value(None, "application_id", |r| r.get(0))
        .map_err(|_| invalid())?;
    ensure(
        checks == ["ok"]
            && foreign.is_empty()
            && entry["schemaHash"] == hash("AutonomousResearchStateDatabaseSchema", &json!(rows))?
            && number(&entry["userVersion"]) == Some(user)
            && number(&entry["applicationId"]) == Some(application)
            && definition["requiredSchemaObjects"]
                .as_array()
                .is_some_and(|a| {
                    a.iter()
                        .all(|v| v.as_str().is_some_and(|s| objects.contains(s)))
                }),
        "autonomous_research_state_backup_source_database_invalid",
    )?;
    drop(database);
    private.assert_current()?;
    file.assert_current().map_err(|_| invalid())
}
fn validate_bundle(bundle: &Value, manifest: &Value) -> Result<()> {
    let manifest_hash = manifest::state_database_manifest_hash_v1(manifest)?;
    ensure(
        number(&bundle["version"]) == Some(1)
            && bundle["kind"] == "AutonomousResearchStateBackupBundleManifest"
            && bundle["status"] == "autonomous_research_state_backup_recorded"
            && sha(&bundle["snapshotContentHash"])
            && bundle["bundleManifestHash"]
                == hash(
                    "AutonomousResearchStateBackupBundleManifest",
                    &without(bundle, "bundleManifestHash")?,
                )?,
        "autonomous_research_state_backup_bundle_manifest_hash_invalid",
    )?;
    let content = &bundle["content"];
    ensure(
        content["manifestHash"] == manifest_hash && content["manifestId"] == manifest["manifestId"],
        "autonomous_research_state_backup_database_manifest_mismatch",
    )?;
    ensure(
        number(&content["version"]) == Some(1)
            && content["kind"] == "AutonomousResearchStateBackupContent"
            && [
                "inventoryHash",
                "databaseScopeHash",
                "authorityReservationHash",
            ]
            .iter()
            .all(|k| sha(&content[k]))
            && content["databases"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
            && bundle["snapshotContentHash"]
                == hash("AutonomousResearchStateBackupContent", content)?,
        "autonomous_research_state_backup_content_hash_invalid",
    )?;
    ensure(
        content["databaseScopeHash"]
            == manifest::state_database_scope_hash_v1(&content["databases"])?
            && bundle["productionStateMutated"] == false,
        "autonomous_research_state_backup_scope_hash_invalid",
    )?;
    let reservation = &bundle["authorityReservation"];
    let finalization = &bundle["authorityFinalization"];
    ensure(
        content["inventoryHash"] == reservation["inventoryHash"]
            && content["databaseScopeHash"] == reservation["databaseScopeHash"]
            && content["authorityReservationHash"]
                == state_backup_authority_receipt_hash_v1(reservation)?
            && finalization["snapshotContentHash"] == bundle["snapshotContentHash"]
            && equal(
                &finalization["headSequence"],
                &content["authorityHead"]["sequence"],
            )
            && finalization["headHash"] == content["authorityHead"]["hash"],
        "autonomous_research_state_backup_authority_scope_binding_invalid",
    )?;
    for key in ["instanceId", "sourceRelativePath", "backupRelativePath"] {
        let values = strings(&content["databases"], key)?;
        ensure(
            values.iter().collect::<BTreeSet<_>>().len() == values.len(),
            "autonomous_research_state_backup_database_identity_duplicate",
        )?;
    }
    let entries = content["databases"]
        .as_array()
        .ok_or_else(|| error("autonomous_research_state_backup_database_record_invalid"))?;
    for entry in entries {
        ensure(
            entry["instanceId"].as_str().is_some_and(|s| !s.is_empty())
                && manifest::relative(&entry["sourceRelativePath"])
                && backup_path(&entry["backupRelativePath"])
                && sha(&entry["backupSha256"])
                && entry["schemaContractId"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
                && sha(&entry["schemaHash"])
                && number(&entry["bytes"]).is_some_and(|v| v > 0)
                && entry["quickCheck"] == "ok"
                && number(&entry["foreignKeyViolationCount"]) == Some(0),
            "autonomous_research_state_backup_database_record_invalid",
        )?;
        ensure(
            manifest["databases"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v["role"] == entry["role"])),
            "autonomous_research_state_backup_unregistered_role",
        )?;
    }
    for definition in manifest["databases"].as_array().into_iter().flatten() {
        let count = entries
            .iter()
            .filter(|v| v["role"] == definition["role"])
            .count() as i64;
        ensure(
            number(&definition["minimumInstances"]).is_some_and(|minimum| count >= minimum)
                && (definition["cardinality"] != "singleton" || count == 1),
            "autonomous_research_state_backup_role_cardinality_invalid",
        )?;
    }
    Ok(())
}
pub fn verify_stored_restore_source_v1<T: StateBackupAuthorityTransportV1>(
    authority: &PinnedStateBackupAuthorityV1<T>,
    options: StoredRestoreSourceOptionsV1<'_>,
) -> Result<VerifiedStoredRestoreSourceV1> {
    authority.current()?;
    ensure(
        options.bundle_path.is_absolute()
            && fs::canonicalize(options.bundle_path).ok().as_deref() == Some(options.bundle_path),
        "autonomous_research_state_backup_source_bundle_unsafe",
    )?;
    let manifest_path = options
        .bundle_path
        .join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json");
    let restore_path = options.bundle_path.join("RESTORE_DRILL_RECEIPT.json");
    let manifest_file = Snapshot::load(
        &manifest_path,
        options.bundle_file_hash,
        64 * 1024 * 1024,
        "autonomous_research_state_backup_bundle_manifest_hash_invalid",
    )?;
    let restore_file = Snapshot::load(
        &restore_path,
        options.restore_receipt_file_hash,
        256 * 1024 * 1024,
        "autonomous_research_state_backup_restore_drill_receipt_invalid",
    )?;
    let bundle =
        manifest_file.json("autonomous_research_state_backup_bundle_manifest_hash_invalid")?;
    let restore =
        restore_file.json("autonomous_research_state_backup_restore_drill_receipt_invalid")?;
    validate_bundle(&bundle, options.state_database_manifest)?;
    let entries = bundle["content"]["databases"]
        .as_array()
        .ok_or_else(|| error("autonomous_research_state_backup_database_record_invalid"))?;
    let total = entries.iter().try_fold(0u64, |total, entry| {
        number(&entry["bytes"])
            .and_then(|value| u64::try_from(value).ok())
            .and_then(|bytes| total.checked_add(bytes))
    });
    ensure(
        entries.len() <= 256 && total.is_some_and(|bytes| bytes <= 1024 * 1024 * 1024),
        "autonomous_research_state_backup_source_resource_limit",
    )?;
    // The legacy comparison is JSON.stringify, which observes nested member
    // order. Parse the already pinned, duplicate-free raw bytes to retain it.
    if restore["completeFinalizedMutationJournal"] == true {
        let raw: crate::online_runtime_activation::ordered_json::Json =
            serde_json::from_slice(restore_file.bytes()).map_err(|_| {
                error("autonomous_research_state_backup_restore_drill_receipt_invalid")
            })?;
        let recovered = raw
            .get("recoveredDatabaseHeads")
            .ok_or_else(|| {
                error("autonomous_research_state_backup_restore_journal_binding_invalid")
            })?
            .stringify()
            .map_err(|e| error(e.to_string()))?;
        let signed = raw
            .get("authorityJournalRangeReceipt")
            .and_then(|v| v.get("databaseHeads"))
            .ok_or_else(|| {
                error("autonomous_research_state_backup_restore_journal_binding_invalid")
            })?
            .stringify()
            .map_err(|e| error(e.to_string()))?;
        ensure(
            recovered == signed,
            "autonomous_research_state_backup_restore_journal_binding_invalid",
        )?;
    }

    validation::validate_restore(authority, &bundle, &restore, options.bundle_path)?;
    let performed = instant(&restore["performedAt"])
        .ok_or_else(|| error("autonomous_research_state_backup_restore_source_stale"))?;
    ensure(
        options.now >= performed && options.now - performed <= 86_400_000,
        "autonomous_research_state_backup_restore_source_stale",
    )?;
    validation::bind_inventory(&bundle, &restore, options.current_inventory)?;
    let databases = bundle["content"]["databases"]
        .as_array()
        .ok_or_else(|| error("autonomous_research_state_backup_database_record_invalid"))?;
    let expected = databases
        .iter()
        .map(|v| text(v, "backupRelativePath").map(str::to_owned))
        .collect::<Result<BTreeSet<_>>>()?;
    database_set(options.bundle_path, &expected)?;
    let mut snapshots = vec![manifest_file, restore_file];
    let mut sources = vec![
        json!({"role":"autonomous_state_backup_manifest","path":manifest_path}),
        json!({"role":"autonomous_state_restore_drill_receipt","path":restore_path}),
    ];
    for entry in databases {
        let path = options.bundle_path.join(text(entry, "backupRelativePath")?);
        let file = Snapshot::load(
            &path,
            text(entry, "backupSha256")?,
            256 * 1024 * 1024,
            "autonomous_research_state_backup_source_database_invalid",
        )?;
        ensure(
            file.file
                .metadata()
                .is_ok_and(|m| number(&entry["bytes"]) == i64::try_from(m.len()).ok()),
            "autonomous_research_state_backup_source_database_invalid",
        )?;
        let definition = options.state_database_manifest["databases"]
            .as_array()
            .and_then(|a| a.iter().find(|d| d["role"] == entry["role"]))
            .ok_or_else(|| error("autonomous_research_state_backup_unregistered_role"))?;
        inspect_database(&file, entry, definition)?;
        sources.push(json!({"role":format!("autonomous_state_database:{}",text(entry,"instanceId")?),"path":path}));
        snapshots.push(file);
    }
    let current = &restore["authorityCurrentHeadReceipt"];
    let mut ids = strings(&bundle["content"]["databases"], "instanceId")?;
    ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let mut inspection = json!({"version":1,"kind":"AutonomousResearchStateBackupSourcesInspection","status":"autonomous_research_state_backup_sources_ready","bundlePath":options.bundle_path,"manifestId":bundle["content"]["manifestId"],"manifestHash":bundle["content"]["manifestHash"],"bundleManifestHash":bundle["bundleManifestHash"],"snapshotContentHash":bundle["snapshotContentHash"],"snapshotCreatedAt":bundle["content"]["createdAt"],"inventoryHash":bundle["content"]["inventoryHash"],"databaseScopeHash":bundle["content"]["databaseScopeHash"],"databaseInstanceIds":ids,"restoreDrillReceiptHash":restore["restoreDrillReceiptHash"],"restoreDrillPerformedAt":restore["performedAt"],"authorityId":current["authorityId"],"keyId":current["keyId"],"headSequence":current["headSequence"],"headHash":current["headHash"],"sources":sources,"skippedCandidates":[],"blockers":[]});
    if restore["completeFinalizedMutationJournal"] == true {
        for (target, source) in [
            ("recoverabilityProtocol", "recoverabilityProtocol"),
            ("recoverabilityBindingHash", "recoverabilityBindingHash"),
            (
                "completeFinalizedMutationJournal",
                "completeFinalizedMutationJournal",
            ),
            ("journalReplayMutationCount", "journalReplayMutationCount"),
            (
                "journalRangeReceiptHash",
                "authorityJournalRangeReceiptHash",
            ),
            ("recoveredDatabaseHeads", "recoveredDatabaseHeads"),
        ] {
            inspection[target] = restore[source].clone();
        }
    }
    let result = VerifiedStoredRestoreSourceV1 {
        inspection,
        snapshot_files: snapshots,
        inventory_hash: hash(
            "AutonomousResearchStateRestoreSourceInventoryBinding",
            options.current_inventory,
        )?,
        performed_at: performed,
        bundle_path: options.bundle_path.to_owned(),
        database_paths: expected,
    };
    result.assert_current(options.current_inventory, options.now)?;
    authority.current()?;
    Ok(result)
}

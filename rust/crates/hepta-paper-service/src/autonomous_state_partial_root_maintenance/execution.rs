use super::plan::PlanState;
use super::{
    AutonomousStatePartialRootMaintenanceOptions, MISSING_ROLES, Result, error, plan, record_hash,
};
use crate::{
    autonomous_state_provision::{files::Snapshot, schema},
    state_database_inventory::inspect_state_database_inventory_v1,
};
use nix::fcntl::{OFlag, RenameFlags, open, renameat2};
use nix::sys::stat::Mode;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Component, Path, PathBuf},
};

struct LockedDatabase {
    role: String,
    path: PathBuf,
    planned: Value,
    connection: Connection,
}

const PLAN_DOCUMENT: &str = "MAINTENANCE_PLAN.json";
const PREPARED_DIRECTORY: &str = "prepared";
const PREPARED_MANIFEST: &str = "PREPARED_MANIFEST.json";
const TERMINAL_RECEIPT: &str = "MAINTENANCE_RECEIPT.json";
const REPAIRED_OBJECTS: &[&str] = &[
    "index:idx_autonomous_research_supervisor_external_action_history",
    "index:idx_autonomous_research_supervisor_external_action_one_active",
    "table:autonomous_research_supervisor_external_action_journal",
];

#[cfg(debug_assertions)]
fn crash_point(point: &str) {
    if std::env::var("HEPTA_PARTIAL_ROOT_TEST_CRASH_AT").as_deref() == Ok(point) {
        let _ = nix::sys::signal::raise(nix::sys::signal::Signal::SIGKILL);
    }
}

#[cfg(not(debug_assertions))]
fn crash_point(_: &str) {}

fn rescue_path(rescue_root: &Path, plan_id: &str) -> Result<PathBuf> {
    if !super::valid_hash(plan_id) {
        return Err(error("autonomous_state_partial_root_plan_invalid"));
    }
    Ok(rescue_root.join(format!(
        "partial-root-rescue-{}",
        plan_id.trim_start_matches("sha256:")
    )))
}

fn plan_identifier(plan: &Value) -> Result<String> {
    let mut payload = plan.clone();
    let object = payload
        .as_object_mut()
        .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
    object.remove("maintenancePlanId");
    record_hash(
        "AutonomousResearchStatePartialRootMaintenancePlan",
        &payload,
    )
}

fn validate_plan_document(plan: &Value, expected: &str) -> Result<()> {
    if plan["kind"] != "AutonomousResearchStatePartialRootMaintenancePlan"
        || plan["version"] != 1
        || plan["maintenancePlanId"].as_str() != Some(expected)
        || plan_identifier(plan)? != expected
    {
        return Err(error("autonomous_state_partial_root_plan_document_invalid"));
    }
    Ok(())
}

fn read_json_regular(path: &Path, code: &str) -> Result<Value> {
    let snapshot = Snapshot::read(path).map_err(|_| error(code))?;
    let value = serde_json::from_slice(&snapshot.bytes).map_err(|_| error(code))?;
    snapshot.assert_current().map_err(|_| error(code))?;
    Ok(value)
}

fn write_json_new(path: &Path, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(error("autonomous_state_partial_root_record_too_large"));
    }
    bytes.push(b'\n');
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}

fn atomic_json(directory: &Path, final_name: &str, value: &Value) -> Result<()> {
    if fs::symlink_metadata(directory)
        .map(|metadata| !metadata.is_dir() || metadata.file_type().is_symlink())
        .unwrap_or(true)
    {
        return Err(error(
            "autonomous_state_partial_root_record_directory_invalid",
        ));
    }
    let stage_name = format!(".{final_name}.{}", random_suffix()?);
    let stage = directory.join(&stage_name);
    write_json_new(&stage, value)?;
    sync_directory(directory)?;
    let parent = File::from(
        open(
            directory,
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| error("autonomous_state_partial_root_record_directory_invalid"))?,
    );
    let rename = renameat2(
        parent.as_fd(),
        stage_name.as_str(),
        parent.as_fd(),
        final_name,
        RenameFlags::RENAME_NOREPLACE,
    );
    if rename.is_err() {
        let _ = fs::remove_file(&stage);
        return Err(error("autonomous_state_partial_root_record_publish_failed"));
    }
    sync_directory(directory)?;
    Ok(())
}

fn file_hash(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 32 * 1024];
    let mut total = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| error("autonomous_state_partial_root_database_too_large"))?;
        if total > 256 * 1024 * 1024 {
            return Err(error("autonomous_state_partial_root_database_too_large"));
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn file_identity(path: &Path) -> Result<Value> {
    let stat = fs::symlink_metadata(path)?;
    if !stat.is_file() || stat.file_type().is_symlink() || stat.nlink() != 1 {
        return Err(error(
            "autonomous_state_partial_root_database_identity_invalid",
        ));
    }
    Ok(json!({
        "device":stat.dev().to_string(),"inode":stat.ino().to_string(),
        "mode":stat.mode().to_string(),"links":stat.nlink().to_string(),
        "bytes":stat.len().to_string(),
        "modifiedNs":(i128::from(stat.mtime())*1_000_000_000+i128::from(stat.mtime_nsec())).to_string(),
        "changedNs":(i128::from(stat.ctime())*1_000_000_000+i128::from(stat.ctime_nsec())).to_string()
    }))
}

fn assert_planned_file(path: &Path, planned: &Value) -> Result<()> {
    if file_identity(path)? != planned["sourceFileIdentity"]
        || file_hash(path)? != planned["sourceSha256"]
    {
        return Err(error(
            "autonomous_state_partial_root_database_identity_changed",
        ));
    }
    Ok(())
}

fn acquire_locks(state: &PlanState) -> Result<Vec<LockedDatabase>> {
    let runtime = Path::new(
        state.plan["runtimeRoot"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?,
    );
    let mut result = Vec::new();
    for planned in state.plan["instances"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?
    {
        let role = planned["role"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
        let relative = planned["sourceRelativePath"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
        let path = runtime.join(relative);
        plan::no_sidecars(&path, role)?;
        assert_planned_file(&path, planned)?;
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(std::time::Duration::ZERO)?;
        let mode: String = connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        if mode != "delete" {
            return Err(error(format!(
                "autonomous_state_partial_root_journal_mode_invalid:{role}"
            )));
        }
        connection.execute_batch("BEGIN EXCLUSIVE")?;
        plan::no_sidecars(&path, role)?;
        assert_planned_file(&path, planned)?;
        if plan::business_state_hash_connection(&connection, role)? != planned["businessStateHash"]
        {
            return Err(error(format!(
                "autonomous_state_partial_root_business_state_changed:{role}"
            )));
        }
        result.push(LockedDatabase {
            role: role.to_owned(),
            path,
            planned: planned.clone(),
            connection,
        });
    }
    Ok(result)
}

fn rollback_locks(locks: &mut [LockedDatabase]) {
    for locked in locks.iter_mut().rev() {
        if !locked.connection.is_autocommit() {
            let _ = locked.connection.execute_batch("ROLLBACK");
        }
    }
}

fn private_parent(root: &Path, relative: &Path) -> Result<PathBuf> {
    let mut cursor = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(error("autonomous_state_partial_root_path_invalid"));
        };
        cursor.push(name);
        if !cursor.exists() {
            fs::create_dir(&cursor)?;
        }
        fs::set_permissions(&cursor, fs::Permissions::from_mode(0o700))?;
    }
    Ok(cursor)
}

fn verify_sqlite(path: &Path, expected_hash: Option<&str>) -> Result<()> {
    if let Some(expected) = expected_hash
        && file_hash(path)? != expected
    {
        return Err(error("autonomous_state_partial_root_copy_hash_mismatch"));
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let quick: String = db.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    let foreign = db.prepare("PRAGMA foreign_key_check")?.exists([])?;
    db.close().map_err(|(_, cause)| cause)?;
    if quick != "ok" || foreign {
        return Err(error(
            "autonomous_state_partial_root_copy_integrity_invalid",
        ));
    }
    Ok(())
}

fn random_suffix() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| error("autonomous_state_partial_root_random_unavailable"))?;
    Ok(hex::encode(bytes))
}

fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

struct Rescue {
    path: PathBuf,
    manifest_hash: String,
}

fn validate_rescue(state: &PlanState, path: &Path) -> Result<Rescue> {
    let plan_id = state.plan["maintenancePlanId"]
        .as_str()
        .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
    let stored_plan = read_json_regular(
        &path.join(PLAN_DOCUMENT),
        "autonomous_state_partial_root_rescue_plan_invalid",
    )?;
    validate_plan_document(&stored_plan, plan_id)?;
    if stored_plan != state.plan {
        return Err(error("autonomous_state_partial_root_rescue_plan_mismatch"));
    }
    let manifest = read_json_regular(
        &path.join("RESCUE_MANIFEST.json"),
        "autonomous_state_partial_root_rescue_manifest_invalid",
    )?;
    let mut unhashed = manifest.clone();
    unhashed
        .as_object_mut()
        .ok_or_else(|| error("autonomous_state_partial_root_rescue_manifest_invalid"))?
        .remove("rescueManifestHash");
    let expected_hash = record_hash(
        "AutonomousResearchStatePartialRootRescueBundleManifest",
        &unhashed,
    )?;
    if manifest["maintenancePlanId"].as_str() != Some(plan_id)
        || manifest["rescueManifestHash"].as_str() != Some(&expected_hash)
        || manifest["copyRestoreVerified"] != true
    {
        return Err(error(
            "autonomous_state_partial_root_rescue_manifest_invalid",
        ));
    }
    let rows = manifest["databases"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_rescue_manifest_invalid"))?;
    let planned = state.plan["instances"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
    if rows.len() != planned.len() {
        return Err(error(
            "autonomous_state_partial_root_rescue_manifest_invalid",
        ));
    }
    for row in rows {
        let role = row["role"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_rescue_manifest_invalid"))?;
        let original = planned
            .iter()
            .find(|value| value["role"].as_str() == Some(role))
            .ok_or_else(|| error("autonomous_state_partial_root_rescue_manifest_invalid"))?;
        let relative = row["sourceRelativePath"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_rescue_manifest_invalid"))?;
        if original["sourceRelativePath"].as_str() != Some(relative)
            || row["sourceSha256"] != original["sourceSha256"]
            || row["backupSha256"] != original["sourceSha256"]
            || row["copyRestoreVerified"] != true
        {
            return Err(error(
                "autonomous_state_partial_root_rescue_manifest_invalid",
            ));
        }
        let backup = path.join(relative);
        verify_sqlite(
            &backup,
            row["backupSha256"]
                .as_str()
                .ok_or_else(|| error("autonomous_state_partial_root_rescue_manifest_invalid"))?
                .into(),
        )?;
    }
    Ok(Rescue {
        path: path.to_path_buf(),
        manifest_hash: expected_hash,
    })
}

fn create_rescue(state: &PlanState, locks: &[LockedDatabase]) -> Result<Rescue> {
    let root = PathBuf::from(
        state.plan["rescueRoot"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?,
    );
    let plan_id = state.plan["maintenancePlanId"]
        .as_str()
        .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
    let final_path = rescue_path(&root, plan_id)?;
    if fs::symlink_metadata(&final_path).is_ok() {
        return validate_rescue(state, &final_path);
    }
    let stage_name = format!(".partial-root-rescue-{}", random_suffix()?);
    let stage = root.join(&stage_name);
    fs::create_dir(&stage)?;
    fs::set_permissions(&stage, fs::Permissions::from_mode(0o700))?;
    sync_directory(&root)?;
    let outcome: Result<Rescue> = (|| {
        let mut databases = Vec::new();
        for locked in locks {
            let relative = Path::new(
                locked.planned["sourceRelativePath"]
                    .as_str()
                    .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?,
            );
            let destination_parent =
                private_parent(&stage, relative.parent().unwrap_or_else(|| Path::new("")))?;
            let destination = destination_parent.join(
                relative
                    .file_name()
                    .ok_or_else(|| error("autonomous_state_partial_root_path_invalid"))?,
            );
            let mut source = File::open(&locked.path)?;
            let mut target = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&destination)?;
            std::io::copy(&mut source, &mut target)?;
            target.sync_all()?;
            drop(target);
            let expected = locked.planned["sourceSha256"]
                .as_str()
                .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
            verify_sqlite(&destination, Some(expected))?;
            let restore = destination.with_extension("sqlite.restore-drill");
            fs::copy(&destination, &restore)?;
            fs::set_permissions(&restore, fs::Permissions::from_mode(0o600))?;
            File::open(&restore)?.sync_all()?;
            verify_sqlite(&restore, Some(expected))?;
            fs::remove_file(&restore)?;
            sync_directory(&destination_parent)?;
            databases.push(json!({
                "instanceId":locked.planned["instanceId"],"role":locked.role,
                "sourceRelativePath":locked.planned["sourceRelativePath"],
                "sourceSha256":expected,"backupSha256":expected,
                "bytes":fs::metadata(&destination)?.len(),"copyRestoreVerified":true
            }));
        }
        let mut body = json!({
            "version":1,"kind":"AutonomousResearchStatePartialRootRescueBundleManifest",
            "status":"autonomous_research_state_partial_root_rescue_bundle_verified",
            "maintenancePlanId":state.plan["maintenancePlanId"],
            "stateDatabaseManifestHash":state.plan["stateDatabaseManifestHash"],
            "databaseScopeHash":state.plan["databaseScopeHash"],"databases":databases,
            "copyRestoreVerified":true
        });
        body["rescueManifestHash"] = json!(record_hash(
            "AutonomousResearchStatePartialRootRescueBundleManifest",
            &body,
        )?);
        write_json_new(&stage.join(PLAN_DOCUMENT), &state.plan)?;
        write_json_new(&stage.join("RESCUE_MANIFEST.json"), &body)?;
        sync_directory(&stage)?;
        let parent = File::from(
            open(
                &root,
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| error("autonomous_state_partial_root_rescue_root_invalid"))?,
        );
        renameat2(
            parent.as_fd(),
            stage_name.as_str(),
            parent.as_fd(),
            final_path
                .file_name()
                .ok_or_else(|| error("autonomous_state_partial_root_rescue_root_invalid"))?,
            RenameFlags::RENAME_NOREPLACE,
        )
        .map_err(|_| error("autonomous_state_partial_root_rescue_publish_failed"))?;
        sync_directory(&root)?;
        validate_rescue(state, &final_path)
    })();
    if outcome.is_err() && stage.exists() {
        let _ = fs::remove_dir_all(&stage);
    }
    outcome
}

#[derive(Clone)]
struct PreparedEntry {
    role: String,
    relative: String,
    sha256: String,
    bytes: u64,
}

struct Prepared {
    root: PathBuf,
    entries: Vec<PreparedEntry>,
    manifest_hash: String,
}

fn prepared_entry_from_value(value: &Value) -> Result<PreparedEntry> {
    let role = value["role"]
        .as_str()
        .ok_or_else(|| error("autonomous_state_partial_root_prepared_manifest_invalid"))?
        .to_owned();
    let relative = value["sourceRelativePath"]
        .as_str()
        .ok_or_else(|| error("autonomous_state_partial_root_prepared_manifest_invalid"))?
        .to_owned();
    let path = Path::new(&relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !MISSING_ROLES.contains(&role.as_str())
    {
        return Err(error(
            "autonomous_state_partial_root_prepared_manifest_invalid",
        ));
    }
    if !super::valid_hash(value["schemaHash"].as_str().unwrap_or("")) {
        return Err(error(
            "autonomous_state_partial_root_prepared_manifest_invalid",
        ));
    }
    Ok(PreparedEntry {
        role,
        relative,
        sha256: value["sourceSha256"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_prepared_manifest_invalid"))?
            .to_owned(),
        bytes: value["bytes"]
            .as_u64()
            .ok_or_else(|| error("autonomous_state_partial_root_prepared_manifest_invalid"))?,
    })
}

fn load_prepared(state: &PlanState, rescue: &Rescue) -> Result<Prepared> {
    let root = rescue.path.join(PREPARED_DIRECTORY);
    let manifest = read_json_regular(
        &root.join(PREPARED_MANIFEST),
        "autonomous_state_partial_root_prepared_manifest_invalid",
    )?;
    let plan_id = state.plan["maintenancePlanId"]
        .as_str()
        .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
    let mut unhashed = manifest.clone();
    unhashed
        .as_object_mut()
        .ok_or_else(|| error("autonomous_state_partial_root_prepared_manifest_invalid"))?
        .remove("preparedManifestHash");
    let manifest_hash = record_hash(
        "AutonomousResearchStatePartialRootPreparedManifest",
        &unhashed,
    )?;
    if manifest["maintenancePlanId"].as_str() != Some(plan_id)
        || manifest["preparedManifestHash"].as_str() != Some(&manifest_hash)
        || manifest["nativeSchemaBundleHash"]
            != state.plan["maintenanceIdentity"]["nativeSchemaBundleHash"]
    {
        return Err(error(
            "autonomous_state_partial_root_prepared_manifest_invalid",
        ));
    }
    let rows = manifest["databases"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_prepared_manifest_invalid"))?;
    if rows.len() != MISSING_ROLES.len() {
        return Err(error(
            "autonomous_state_partial_root_prepared_manifest_invalid",
        ));
    }
    let mut entries = Vec::new();
    for row in rows {
        let entry = prepared_entry_from_value(row)?;
        if entries
            .iter()
            .any(|existing: &PreparedEntry| existing.role == entry.role)
        {
            return Err(error(
                "autonomous_state_partial_root_prepared_manifest_invalid",
            ));
        }
        let candidate = root.join(&entry.relative);
        let metadata = fs::symlink_metadata(&candidate)
            .map_err(|_| error("autonomous_state_partial_root_prepared_database_missing"))?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.nlink() != 1
            || metadata.len() != entry.bytes
            || file_hash(&candidate)? != entry.sha256
        {
            return Err(error(
                "autonomous_state_partial_root_prepared_database_invalid",
            ));
        }
        verify_sqlite(&candidate, Some(&entry.sha256))?;
        entries.push(entry);
    }
    entries.sort_by(|left, right| left.role.cmp(&right.role));
    let expected = MISSING_ROLES
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    if entries
        .iter()
        .map(|value| value.role.clone())
        .collect::<Vec<_>>()
        != expected
    {
        return Err(error(
            "autonomous_state_partial_root_prepared_manifest_invalid",
        ));
    }
    Ok(Prepared {
        root,
        entries,
        manifest_hash,
    })
}

fn prepare_missing(state: &PlanState, rescue: &Rescue) -> Result<Prepared> {
    if fs::symlink_metadata(rescue.path.join(PREPARED_DIRECTORY)).is_ok() {
        return load_prepared(state, rescue);
    }
    let stage_name = format!(".partial-root-prepared-{}", random_suffix()?);
    let stage = rescue.path.join(&stage_name);
    fs::create_dir(&stage)?;
    fs::set_permissions(&stage, fs::Permissions::from_mode(0o700))?;
    sync_directory(&rescue.path)?;
    let when = state.plan["writerQuiescenceObservedAt"]
        .as_str()
        .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
    let images = schema::build_partial_missing(&state.manifest, &state.machine, &state.topic, when)
        .map_err(|cause| error(cause.0))?;
    let outcome: Result<()> = (|| {
        let mut databases = Vec::new();
        for image in &images {
            let relative = Path::new(&image.relative);
            if relative.is_absolute()
                || relative
                    .components()
                    .any(|component| !matches!(component, Component::Normal(_)))
            {
                return Err(error("autonomous_state_partial_root_staging_path_invalid"));
            }
            let destination_parent =
                private_parent(&stage, relative.parent().unwrap_or_else(|| Path::new("")))?;
            let destination = destination_parent.join(
                relative
                    .file_name()
                    .ok_or_else(|| error("autonomous_state_partial_root_staging_path_invalid"))?,
            );
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&destination)?;
            file.write_all(&image.bytes)?;
            file.sync_all()?;
            drop(file);
            let sha256 = schema::bytes_hash(&image.bytes);
            if file_hash(&destination)? != sha256 {
                return Err(error("autonomous_state_partial_root_staged_hash_mismatch"));
            }
            verify_sqlite(&destination, Some(&sha256))?;
            sync_directory(&destination_parent)?;
            databases.push(json!({
                "role":image.role,"sourceRelativePath":image.relative,
                "sourceSha256":sha256,"bytes":image.bytes.len(),
                "schemaHash":image.schema_hash
            }));
        }
        databases.sort_by(|left, right| left["role"].as_str().cmp(&right["role"].as_str()));
        let mut manifest = json!({
            "version":1,"kind":"AutonomousResearchStatePartialRootPreparedManifest",
            "maintenancePlanId":state.plan["maintenancePlanId"],
            "nativeSchemaBundleHash":state.plan["maintenanceIdentity"]["nativeSchemaBundleHash"],
            "initializationAt":when,"databases":databases
        });
        manifest["preparedManifestHash"] = json!(record_hash(
            "AutonomousResearchStatePartialRootPreparedManifest",
            &manifest,
        )?);
        write_json_new(&stage.join(PREPARED_MANIFEST), &manifest)?;
        sync_directory(&stage)?;
        let parent = File::from(
            open(
                &rescue.path,
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| error("autonomous_state_partial_root_rescue_invalid"))?,
        );
        renameat2(
            parent.as_fd(),
            stage_name.as_str(),
            parent.as_fd(),
            PREPARED_DIRECTORY,
            RenameFlags::RENAME_NOREPLACE,
        )
        .map_err(|_| error("autonomous_state_partial_root_prepared_publish_failed"))?;
        sync_directory(&rescue.path)?;
        Ok(())
    })();
    if let Err(cause) = outcome {
        if stage.exists() {
            let _ = fs::remove_dir_all(&stage);
        }
        return Err(cause);
    }
    load_prepared(state, rescue)
}

fn install_supervisor_repair(locks: &mut [LockedDatabase]) -> Result<()> {
    let locked = locks
        .iter_mut()
        .find(|locked| locked.role == "supervisor-state")
        .ok_or_else(|| error("autonomous_state_partial_root_supervisor_missing"))?;
    let before = locked.planned["businessStateHash"]
        .as_str()
        .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
    for statement in schema::supervisor_repair_statements().map_err(|cause| error(cause.0))? {
        locked.connection.execute_batch(&statement)?;
    }
    if plan::business_state_hash_connection(&locked.connection, "supervisor-state")? != before {
        return Err(error(
            "autonomous_state_partial_root_supervisor_business_state_changed",
        ));
    }
    Ok(())
}

fn publish_missing(state: &PlanState, prepared: &Prepared) -> Result<Vec<PathBuf>> {
    let runtime = Path::new(
        state.plan["runtimeRoot"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?,
    );
    let plan_id = state.plan["maintenancePlanId"]
        .as_str()
        .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
    let mut installed = Vec::new();
    let outcome: Result<()> = (|| {
        for entry in &prepared.entries {
            let relative = Path::new(&entry.relative);
            let source = prepared.root.join(relative);
            if file_hash(&source)? != entry.sha256 {
                return Err(error(
                    "autonomous_state_partial_root_prepared_database_changed",
                ));
            }
            let target = runtime.join(relative);
            let parent = target
                .parent()
                .ok_or_else(|| error("autonomous_state_partial_root_target_invalid"))?;
            if !parent.exists() {
                let relative_parent = parent
                    .strip_prefix(runtime)
                    .map_err(|_| error("autonomous_state_partial_root_target_invalid"))?;
                private_parent(runtime, relative_parent)?;
            }
            if fs::symlink_metadata(&target).is_ok() {
                return Err(error(format!(
                    "autonomous_state_partial_root_target_appeared:{}",
                    entry.role
                )));
            }
            let temp_name = format!(
                ".partial-root-publish-{}-{}",
                plan_id.trim_start_matches("sha256:"),
                random_suffix()?
            );
            let temp = parent.join(&temp_name);
            let mut input = File::open(&source)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temp)?;
            std::io::copy(&mut input, &mut output)?;
            output.sync_all()?;
            drop(output);
            if file_hash(&temp)? != entry.sha256 {
                let _ = fs::remove_file(&temp);
                return Err(error("autonomous_state_partial_root_publish_copy_invalid"));
            }
            verify_sqlite(&temp, Some(&entry.sha256))?;
            let parent_fd = File::from(
                open(
                    parent,
                    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| error("autonomous_state_partial_root_target_parent_invalid"))?,
            );
            let target_name = target
                .file_name()
                .ok_or_else(|| error("autonomous_state_partial_root_target_invalid"))?;
            let renamed = renameat2(
                parent_fd.as_fd(),
                temp_name.as_str(),
                parent_fd.as_fd(),
                target_name,
                RenameFlags::RENAME_NOREPLACE,
            );
            if renamed.is_err() {
                let _ = fs::remove_file(&temp);
                return Err(error(format!(
                    "autonomous_state_partial_root_target_appeared:{}",
                    entry.role
                )));
            }
            sync_directory(parent)?;
            installed.push(target.clone());
            if installed.len() == 1 {
                crash_point("after_first_publish");
            }
        }
        sync_directory(runtime)?;
        crash_point("after_publish_all");
        Ok(())
    })();
    if let Err(cause) = outcome {
        for path in installed.iter().rev() {
            let _ = fs::remove_file(path);
            if let Some(parent) = path.parent() {
                let _ = sync_directory(parent);
            }
        }
        return Err(cause);
    }
    Ok(installed)
}

fn post_inventory(plan_value: &Value, manifest: &Value) -> Result<Value> {
    let runtime = Path::new(
        plan_value["runtimeRoot"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?,
    );
    let report = inspect_state_database_inventory_v1(runtime, manifest).map_err(|cause| {
        error(format!(
            "autonomous_state_partial_root_post_inventory:{cause}"
        ))
    })?;
    let instances = report["instances"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_post_inventory_invalid"))?;
    if instances.len() != 10 {
        return Err(error(
            "autonomous_state_partial_root_post_inventory_invalid",
        ));
    }
    let definitions = manifest["databases"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_manifest_invalid"))?;
    let mut expected_blockers = Vec::new();
    for instance in instances {
        let role = instance["role"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_post_inventory_invalid"))?;
        let definition = definitions
            .iter()
            .find(|row| row["role"] == role)
            .ok_or_else(|| error("autonomous_state_partial_root_manifest_invalid"))?;
        let mut missing = instance["missingSchemaObjects"]
            .as_array()
            .ok_or_else(|| error("autonomous_state_partial_root_post_inventory_invalid"))?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        missing.sort();
        let mut expected = plan::expected_missing(role, definition)?;
        if role == "supervisor-state" {
            expected.retain(|entry| !REPAIRED_OBJECTS.contains(&entry.as_str()));
        }
        if missing != expected
            || instance["quickCheck"] != "ok"
            || instance["foreignKeyViolationCount"].as_i64() != Some(0)
        {
            return Err(error(format!(
                "autonomous_state_partial_root_post_schema_invalid:{role}"
            )));
        }
        plan::no_sidecars(
            &runtime.join(instance["sourceRelativePath"].as_str().unwrap_or_default()),
            role,
        )?;
        if !missing.is_empty() {
            expected_blockers.push(format!(
                "autonomous_research_state_database_schema_contract_mismatch:{}:{}:{}",
                instance["instanceId"].as_str().unwrap_or(role),
                instance["schemaContractId"].as_str().unwrap_or_default(),
                missing.join(",")
            ));
        }
    }
    expected_blockers.sort();
    let mut blockers = report["blockers"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_post_inventory_invalid"))?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    blockers.sort();
    if blockers != expected_blockers
        || !super::valid_hash(report["databaseScopeHash"].as_str().unwrap_or(""))
    {
        return Err(error(
            "autonomous_state_partial_root_post_inventory_invalid",
        ));
    }
    Ok(report)
}

fn verify_preserved_business(plan_value: &Value) -> Result<Vec<Value>> {
    let runtime = Path::new(
        plan_value["runtimeRoot"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?,
    );
    let mut result = Vec::new();
    for planned in plan_value["instances"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?
    {
        let role = planned["role"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
        let relative = planned["sourceRelativePath"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
        let path = runtime.join(relative);
        let after = plan::business_state_hash(&path, role)?;
        if after != planned["businessStateHash"] {
            return Err(error(format!(
                "autonomous_state_partial_root_business_state_changed:{role}"
            )));
        }
        let post_hash = file_hash(&path)?;
        let exact = role == "supervisor-state" || post_hash == planned["sourceSha256"];
        if !exact {
            return Err(error(format!(
                "autonomous_state_partial_root_unscoped_database_changed:{role}"
            )));
        }
        result.push(json!({
            "instanceId":planned["instanceId"],"role":role,
            "preBusinessStateHash":planned["businessStateHash"],"postBusinessStateHash":after,
            "preSourceSha256":planned["sourceSha256"],"postSourceSha256":post_hash,
            "sourceBytesPreserved":if role=="supervisor-state" {Value::Null} else {json!(true)}
        }));
    }
    Ok(result)
}

fn cleanup_installed(installed: &[PathBuf]) {
    for path in installed.iter().rev() {
        let _ = fs::remove_file(path);
        if let Some(parent) = path.parent() {
            let _ = sync_directory(parent);
        }
    }
}

fn current_manifest(plan_value: &Value) -> Result<Value> {
    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let manifest = super::manifest(&workspace_root)?;
    let current_hash = record_hash("AutonomousResearchStateDatabaseManifest", &manifest)?;
    if plan_value["stateDatabaseManifestHash"].as_str() != Some(&current_hash) {
        return Err(error("autonomous_state_partial_root_manifest_changed"));
    }
    Ok(manifest)
}

fn load_stored_state(
    options: &AutonomousStatePartialRootMaintenanceOptions,
    expected_plan_id: &str,
) -> Result<(PlanState, Rescue)> {
    let path = rescue_path(&options.rescue_root, expected_plan_id)?;
    let plan_value = read_json_regular(
        &path.join(PLAN_DOCUMENT),
        "autonomous_state_partial_root_rescue_plan_invalid",
    )?;
    validate_plan_document(&plan_value, expected_plan_id)?;
    if plan_value["runtimeRoot"].as_str() != options.runtime_root.to_str()
        || plan_value["rescueRoot"].as_str() != options.rescue_root.to_str()
    {
        return Err(error(
            "autonomous_state_partial_root_rescue_subject_mismatch",
        ));
    }
    let manifest = current_manifest(&plan_value)?;
    let state = PlanState {
        plan: plan_value,
        manifest,
        machine: Value::Null,
        topic: Value::Null,
    };
    let rescue = validate_rescue(&state, &path)?;
    Ok((state, rescue))
}

fn clear_non_hot_rollback_journal(database_path: &Path) -> Result<()> {
    let journal = PathBuf::from(format!("{}-journal", database_path.display()));
    let metadata = match fs::symlink_metadata(&journal) {
        Ok(value) => value,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(cause) => return Err(cause.into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.nlink() != 1 {
        return Err(error(
            "autonomous_state_partial_root_recovery_journal_unsafe",
        ));
    }
    let mut file = File::open(&journal)?;
    let mut header = [0u8; 8];
    file.read_exact(&mut header)?;
    drop(file);
    // SQLite zeros the rollback-journal magic once recovery has made the
    // transaction non-hot. Only that inert form is removed; a live/hot
    // journal remains a hard recovery stop.
    if header != [0u8; 8] {
        return Err(error("autonomous_state_partial_root_recovery_journal_hot"));
    }
    fs::remove_file(&journal)?;
    sync_directory(
        database_path
            .parent()
            .ok_or_else(|| error("autonomous_state_partial_root_target_invalid"))?,
    )?;
    Ok(())
}

fn repair_object_count(plan_value: &Value) -> Result<usize> {
    let runtime = Path::new(
        plan_value["runtimeRoot"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?,
    );
    let supervisor = plan_value["instances"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["role"] == "supervisor-state"))
        .ok_or_else(|| error("autonomous_state_partial_root_supervisor_missing"))?;
    let relative = supervisor["sourceRelativePath"]
        .as_str()
        .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
    let path = runtime.join(relative);
    for suffix in ["-wal", "-shm"] {
        if fs::symlink_metadata(PathBuf::from(format!("{}{}", path.display(), suffix))).is_ok() {
            return Err(error(
                "autonomous_state_partial_root_recovery_sidecar_invalid",
            ));
        }
    }
    let database = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    database.busy_timeout(std::time::Duration::ZERO)?;
    let quick: String = database.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if quick != "ok" {
        return Err(error(
            "autonomous_state_partial_root_recovery_integrity_invalid",
        ));
    }
    let mut statement =
        database.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")?;
    let objects = statement
        .query_map([], |row| {
            Ok(format!(
                "{}:{}",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    database.close().map_err(|(_, cause)| cause)?;
    clear_non_hot_rollback_journal(&path)?;
    plan::no_sidecars(&path, "supervisor-state")?;
    Ok(REPAIRED_OBJECTS
        .iter()
        .filter(|expected| objects.iter().any(|actual| actual == **expected))
        .count())
}

fn verify_pre_repair_state(state: &PlanState) -> Result<Value> {
    let runtime = Path::new(
        state.plan["runtimeRoot"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?,
    );
    let inventory = plan::canonical_partial_inventory(runtime, &state.manifest)?;
    for planned in state.plan["instances"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?
    {
        let role = planned["role"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
        let relative = planned["sourceRelativePath"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
        let path = runtime.join(relative);
        if plan::business_state_hash(&path, role)? != planned["businessStateHash"] {
            return Err(error(format!(
                "autonomous_state_partial_root_rollback_business_state_changed:{role}"
            )));
        }
        if role != "supervisor-state" && file_hash(&path)? != planned["sourceSha256"] {
            return Err(error(format!(
                "autonomous_state_partial_root_rollback_unscoped_database_changed:{role}"
            )));
        }
    }
    Ok(inventory)
}

fn prepared_if_present(state: &PlanState, rescue: &Rescue) -> Result<Option<Prepared>> {
    let path = rescue.path.join(PREPARED_DIRECTORY);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            load_prepared(state, rescue).map(Some)
        }
        Ok(_) => Err(error("autonomous_state_partial_root_prepared_invalid")),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(cause) => Err(cause.into()),
    }
}

fn target_for_entry(plan_value: &Value, entry: &PreparedEntry) -> Result<PathBuf> {
    let runtime = Path::new(
        plan_value["runtimeRoot"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?,
    );
    Ok(runtime.join(&entry.relative))
}

fn assert_prepared_targets(plan_value: &Value, prepared: &Prepared) -> Result<()> {
    for entry in &prepared.entries {
        let target = target_for_entry(plan_value, entry)?;
        let metadata = fs::symlink_metadata(&target).map_err(|_| {
            error(format!(
                "autonomous_state_partial_root_committed_target_missing:{}",
                entry.role
            ))
        })?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.nlink() != 1
            || metadata.len() != entry.bytes
            || file_hash(&target)? != entry.sha256
        {
            return Err(error(format!(
                "autonomous_state_partial_root_committed_target_changed:{}",
                entry.role
            )));
        }
        verify_sqlite(&target, Some(&entry.sha256))?;
        plan::no_sidecars(&target, &entry.role)?;
    }
    Ok(())
}

fn missing_target_paths(state: &PlanState) -> Result<Vec<(String, PathBuf)>> {
    let runtime = Path::new(
        state.plan["runtimeRoot"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?,
    );
    let definitions = state.manifest["databases"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_manifest_invalid"))?;
    let mut result = Vec::new();
    for role in MISSING_ROLES {
        let row = definitions
            .iter()
            .find(|row| row["role"].as_str() == Some(role))
            .ok_or_else(|| error("autonomous_state_partial_root_manifest_invalid"))?;
        let relative = row["relativePath"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_manifest_invalid"))?;
        result.push((role.to_string(), runtime.join(relative)));
    }
    Ok(result)
}

fn assert_no_missing_targets(state: &PlanState) -> Result<()> {
    for (role, path) in missing_target_paths(state)? {
        if fs::symlink_metadata(&path).is_ok() {
            return Err(error(format!(
                "autonomous_state_partial_root_rollback_target_present:{role}"
            )));
        }
    }
    Ok(())
}

fn cleanup_interrupted_publication(state: &PlanState, prepared: Option<&Prepared>) -> Result<()> {
    let plan_id = state.plan["maintenancePlanId"]
        .as_str()
        .ok_or_else(|| error("autonomous_state_partial_root_plan_invalid"))?;
    for (role, target) in missing_target_paths(state)? {
        if let Ok(metadata) = fs::symlink_metadata(&target) {
            let entry = prepared
                .and_then(|prepared| prepared.entries.iter().find(|entry| entry.role == role))
                .ok_or_else(|| {
                    error(format!(
                        "autonomous_state_partial_root_unowned_target_present:{role}"
                    ))
                })?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.nlink() != 1
                || metadata.len() != entry.bytes
                || file_hash(&target)? != entry.sha256
            {
                return Err(error(format!(
                    "autonomous_state_partial_root_interrupted_target_changed:{role}"
                )));
            }
            plan::no_sidecars(&target, &role)?;
            fs::remove_file(&target)?;
            if let Some(parent) = target.parent() {
                sync_directory(parent)?;
            }
        }
        if let Some(parent) = target.parent()
            && let Ok(entries) = fs::read_dir(parent)
        {
            let prefix = format!(
                ".partial-root-publish-{}-",
                plan_id.trim_start_matches("sha256:")
            );
            for candidate in entries.flatten() {
                let name = candidate.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with(&prefix) {
                    continue;
                }
                let path = candidate.path();
                let metadata = fs::symlink_metadata(&path)?;
                if metadata.is_file() && !metadata.file_type().is_symlink() && metadata.nlink() == 1
                {
                    fs::remove_file(&path)?;
                    sync_directory(parent)?;
                } else {
                    return Err(error(
                        "autonomous_state_partial_root_publish_residue_unsafe",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn receipt_identifier(receipt: &Value) -> Result<String> {
    let mut payload = receipt.clone();
    payload
        .as_object_mut()
        .ok_or_else(|| error("autonomous_state_partial_root_receipt_invalid"))?
        .remove("maintenanceReceiptHash");
    record_hash(
        "AutonomousResearchStatePartialRootMaintenanceReceipt",
        &payload,
    )
}

fn build_success_receipt(state: &PlanState, rescue: &Rescue, prepared: &Prepared) -> Result<Value> {
    assert_prepared_targets(&state.plan, prepared)?;
    let inventory = post_inventory(&state.plan, &state.manifest)?;
    let business_state = verify_preserved_business(&state.plan)?;
    let mut receipt = json!({
        "version":1,"kind":"AutonomousResearchStatePartialRootMaintenanceReceipt",
        "status":"autonomous_research_state_partial_root_business_repair_complete","ready":true,
        "maintenancePlanId":state.plan["maintenancePlanId"],
        "stateDatabaseManifestHash":state.plan["stateDatabaseManifestHash"],
        "preRepairDatabaseScopeHash":state.plan["databaseScopeHash"],
        "postRepairDatabaseScopeHash":inventory["databaseScopeHash"],
        "repairedSupervisorBusinessObjects":REPAIRED_OBJECTS,
        "installedRoles":MISSING_ROLES,"businessState":business_state,
        "businessStateAndRowsPreserved":true,"unscopedExistingDatabaseBytesPreserved":true,
        "rescueBundlePath":rescue.path,"rescueManifestHash":rescue.manifest_hash,
        "preparedManifestHash":prepared.manifest_hash,
        "rescueCopyRestoreVerified":true,"interruptedAttemptRolledBack":false,
        "retryRequiresFreshPlan":false,"onlineSchemaTransitionRequired":true,
        "externalAuthorityInvoked":false,"productionActivation":false,"nodeRetirement":false
    });
    receipt["maintenanceReceiptHash"] = json!(receipt_identifier(&receipt)?);
    Ok(receipt)
}

fn build_rollback_receipt(
    state: &PlanState,
    rescue: &Rescue,
    prepared: Option<&Prepared>,
) -> Result<Value> {
    let inventory = verify_pre_repair_state(state)?;
    assert_no_missing_targets(state)?;
    let mut receipt = json!({
        "version":1,"kind":"AutonomousResearchStatePartialRootMaintenanceReceipt",
        "status":"autonomous_research_state_partial_root_interruption_rolled_back","ready":false,
        "maintenancePlanId":state.plan["maintenancePlanId"],
        "stateDatabaseManifestHash":state.plan["stateDatabaseManifestHash"],
        "preRepairDatabaseScopeHash":state.plan["databaseScopeHash"],
        "postRollbackDatabaseScopeHash":inventory["databaseScopeHash"],
        "repairedSupervisorBusinessObjects":[],
        "installedRoles":[],
        "businessStateAndRowsPreserved":true,"unscopedExistingDatabaseBytesPreserved":true,
        "rescueBundlePath":rescue.path,"rescueManifestHash":rescue.manifest_hash,
        "preparedManifestHash":prepared.map(|value| value.manifest_hash.clone()),
        "rescueCopyRestoreVerified":true,"interruptedAttemptRolledBack":true,
        "retryRequiresFreshPlan":true,"onlineSchemaTransitionRequired":true,
        "externalAuthorityInvoked":false,"productionActivation":false,"nodeRetirement":false
    });
    receipt["maintenanceReceiptHash"] = json!(receipt_identifier(&receipt)?);
    Ok(receipt)
}

fn persist_terminal(rescue: &Rescue, receipt: &Value) -> Result<Value> {
    let path = rescue.path.join(TERMINAL_RECEIPT);
    if fs::symlink_metadata(&path).is_ok() {
        let stored = read_json_regular(
            &path,
            "autonomous_state_partial_root_terminal_receipt_invalid",
        )?;
        if receipt_identifier(&stored)? != stored["maintenanceReceiptHash"] || stored != *receipt {
            return Err(error(
                "autonomous_state_partial_root_terminal_receipt_conflict",
            ));
        }
        return Ok(stored);
    }
    atomic_json(&rescue.path, TERMINAL_RECEIPT, receipt)?;
    crash_point("after_terminal");
    let stored = read_json_regular(
        &path,
        "autonomous_state_partial_root_terminal_receipt_invalid",
    )?;
    if stored != *receipt {
        return Err(error(
            "autonomous_state_partial_root_terminal_receipt_conflict",
        ));
    }
    Ok(stored)
}

pub(super) fn recover_or_replay(
    options: &AutonomousStatePartialRootMaintenanceOptions,
    expected_plan_id: &str,
) -> Result<Option<Value>> {
    let rescue_path = rescue_path(&options.rescue_root, expected_plan_id)?;
    match fs::symlink_metadata(&rescue_path) {
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(cause) => return Err(cause.into()),
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(error("autonomous_state_partial_root_rescue_invalid"));
        }
        Ok(_) => {}
    }
    let (state, rescue) = load_stored_state(options, expected_plan_id)?;
    let repair_count = repair_object_count(&state.plan)?;
    let prepared = prepared_if_present(&state, &rescue)?;
    let terminal_path = rescue.path.join(TERMINAL_RECEIPT);
    let terminal_exists = fs::symlink_metadata(&terminal_path).is_ok();

    if terminal_exists {
        let expected = match repair_count {
            0 => {
                assert_no_missing_targets(&state)?;
                build_rollback_receipt(&state, &rescue, prepared.as_ref())?
            }
            count if count == REPAIRED_OBJECTS.len() => {
                let prepared = prepared.as_ref().ok_or_else(|| {
                    error("autonomous_state_partial_root_committed_prepared_missing")
                })?;
                build_success_receipt(&state, &rescue, prepared)?
            }
            _ => {
                return Err(error(
                    "autonomous_state_partial_root_supervisor_repair_indeterminate",
                ));
            }
        };
        return persist_terminal(&rescue, &expected).map(Some);
    }

    let receipt = match repair_count {
        0 => {
            cleanup_interrupted_publication(&state, prepared.as_ref())?;
            build_rollback_receipt(&state, &rescue, prepared.as_ref())?
        }
        count if count == REPAIRED_OBJECTS.len() => {
            let prepared = prepared
                .as_ref()
                .ok_or_else(|| error("autonomous_state_partial_root_committed_prepared_missing"))?;
            build_success_receipt(&state, &rescue, prepared)?
        }
        _ => {
            return Err(error(
                "autonomous_state_partial_root_supervisor_repair_indeterminate",
            ));
        }
    };
    persist_terminal(&rescue, &receipt).map(Some)
}

pub(super) fn execute(
    options: &AutonomousStatePartialRootMaintenanceOptions,
    state: PlanState,
) -> Result<Value> {
    let mut locks = acquire_locks(&state)?;
    let mut installed: Vec<PathBuf> = Vec::new();
    let mut rescue: Option<Rescue> = None;
    let mut prepared: Option<Prepared> = None;
    let mut committed = false;
    let before_commit: Result<()> = (|| {
        plan::assert_selected_current(options, &state.plan)?;
        rescue = Some(create_rescue(&state, &locks)?);
        crash_point("after_rescue");
        prepared = Some(prepare_missing(
            &state,
            rescue
                .as_ref()
                .ok_or_else(|| error("autonomous_state_partial_root_rescue_missing"))?,
        )?);
        crash_point("after_prepared");
        plan::assert_selected_current(options, &state.plan)?;
        install_supervisor_repair(&mut locks)?;
        installed = publish_missing(
            &state,
            prepared
                .as_ref()
                .ok_or_else(|| error("autonomous_state_partial_root_prepared_missing"))?,
        )?;
        for locked in locks
            .iter_mut()
            .filter(|locked| locked.role != "supervisor-state")
        {
            if !locked.connection.is_autocommit() {
                locked.connection.execute_batch("ROLLBACK")?;
            }
        }
        let supervisor = locks
            .iter_mut()
            .find(|locked| locked.role == "supervisor-state")
            .ok_or_else(|| error("autonomous_state_partial_root_supervisor_missing"))?;
        supervisor.connection.execute_batch("COMMIT")?;
        committed = true;
        Ok(())
    })();
    if let Err(cause) = before_commit {
        if !committed {
            cleanup_installed(&installed);
            rollback_locks(&mut locks);
        }
        return Err(error(format!(
            "{}; maintenanceState={}; rescueBundle={}; automaticRetryAllowed=false",
            cause.0,
            if committed {
                "committed"
            } else {
                "not_committed"
            },
            rescue
                .as_ref()
                .map(|value| value.path.display().to_string())
                .unwrap_or_default(),
        )));
    }
    drop(locks);
    crash_point("after_supervisor_commit");
    let rescue = rescue
        .as_ref()
        .ok_or_else(|| error("autonomous_state_partial_root_rescue_missing"))?;
    let prepared = prepared
        .as_ref()
        .ok_or_else(|| error("autonomous_state_partial_root_prepared_missing"))?;
    let receipt = build_success_receipt(&state, rescue, prepared).map_err(|cause| {
        error(format!(
            "{}; maintenanceState=committed; rescueBundle={}; automaticRetryAllowed=false",
            cause.0,
            rescue.path.display(),
        ))
    })?;
    persist_terminal(rescue, &receipt)
}

//! Read-only resident supervisor health, with an inode-pinned effective-WAL
//! private SQLite snapshot.
//! The optional full composition consumes actual intake, resident prerequisites
//! and passive state safety. No returned diagnostic grants dispatch authority.
//! It never invokes a provider, recovery command or authority RPC; inherited
//! current-code observation executes read-only Git queries.
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use std::path::Path;

const SCOPE: &str = "resident-autonomous-research-supervisor";
const DATABASE_RELATIVE: &str = "autonomous-research/supervisor/resident-instance.sqlite";
const SHA256: &str = "sha256:";

fn error(code: &str) -> String {
    code.to_owned()
}
fn iso_now(now_millis: i64) -> Result<String, String> {
    crate::sqlite_mutation_coordinator::clock::iso(now_millis).map_err(|e| e.to_string())
}
fn parse_millis(value: Option<&str>) -> Option<i64> {
    crate::journal_connector_coverage::qualification::canonical_instant_millis(value?)
}
fn safe_id(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    !value.is_empty()
        && value.len() <= 256
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:@/-".contains(&b))
}
fn valid_hash(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    value.len() == SHA256.len() + 64
        && value.starts_with(SHA256)
        && value[SHA256.len()..].bytes().all(|b| b.is_ascii_hexdigit())
}
fn optional_string(row: &rusqlite::Row<'_>, column: &str) -> rusqlite::Result<Value> {
    let value: Option<String> = row.get(column)?;
    Ok(value
        .filter(|s| !s.is_empty())
        .map(Value::String)
        .unwrap_or(Value::Null))
}
fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut out = serde_json::Map::new();
    for (target, source) in [
        ("scopeId", "scope_id"),
        ("status", "status"),
        ("ownerId", "owner_id"),
        ("leaseToken", "lease_token"),
        ("startedAt", "started_at"),
        ("lastHeartbeatAt", "last_heartbeat_at"),
        ("leaseExpiresAt", "lease_expires_at"),
        ("startupReconciledAt", "startup_reconciled_at"),
        (
            "startupReconciliationReceiptHash",
            "startup_reconciliation_receipt_hash",
        ),
        (
            "fullyAutonomousPrerequisiteIdentityHash",
            "fully_autonomous_prerequisite_identity_hash",
        ),
        ("machineIntakeReconciledAt", "machine_intake_reconciled_at"),
        (
            "machineIntakeReconciliationReceiptHash",
            "machine_intake_reconciliation_receipt_hash",
        ),
        (
            "machineIntakeConfigurationHash",
            "machine_intake_configuration_hash",
        ),
        (
            "machineIntakeDatasetSnapshotHash",
            "machine_intake_dataset_snapshot_hash",
        ),
        (
            "machineIntakeReconciliationFailedAt",
            "machine_intake_reconciliation_failed_at",
        ),
        (
            "machineIntakeReconciliationFailure",
            "machine_intake_reconciliation_failure",
        ),
        ("lastCycleAt", "last_cycle_at"),
        ("lastCycleReceiptHash", "last_cycle_receipt_hash"),
        ("stoppedAt", "stopped_at"),
        ("stopReason", "stop_reason"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
    ] {
        out.insert(target.into(), optional_string(row, source)?);
    }
    for (target, source) in [
        ("leaseGeneration", "lease_generation"),
        ("leaseDurationMs", "lease_duration_ms"),
        ("heartbeatIntervalMs", "heartbeat_interval_ms"),
        ("recoveredLeaseCount", "recovered_lease_count"),
    ] {
        out.insert(target.into(), json!(row.get::<_, i64>(source)?));
    }
    out.insert(
        "fullyAutonomousRequired".into(),
        json!(row.get::<_, i64>("fully_autonomous_required")? == 1),
    );
    Ok(Value::Object(out))
}
fn paired(value: &Value, hash: &str, at: &str) -> bool {
    value[hash].is_null() == value[at].is_null()
        && (value[hash].is_null()
            || (valid_hash(value[hash].as_str()) && parse_millis(value[at].as_str()).is_some()))
}
fn state_valid(value: &Value) -> bool {
    if value["scopeId"] != SCOPE
        || !matches!(value["status"].as_str(), Some("running" | "stopped"))
        || value["leaseGeneration"].as_i64().is_none_or(|v| v < 1)
        || value["leaseDurationMs"]
            .as_i64()
            .is_none_or(|v| !(1_000..=1_800_000).contains(&v))
        || value["heartbeatIntervalMs"].as_i64().is_none_or(|v| {
            v < 250 || v.saturating_mul(2) >= value["leaseDurationMs"].as_i64().unwrap_or(0)
        })
        || parse_millis(value["createdAt"].as_str()).is_none()
        || parse_millis(value["updatedAt"].as_str()).is_none()
        || !paired(
            value,
            "startupReconciliationReceiptHash",
            "startupReconciledAt",
        )
        || !paired(
            value,
            "machineIntakeReconciliationReceiptHash",
            "machineIntakeReconciledAt",
        )
        || value["machineIntakeReconciliationReceiptHash"].is_null()
            != value["machineIntakeConfigurationHash"].is_null()
        || (!value["machineIntakeReconciliationReceiptHash"].is_null()
            && (!valid_hash(value["machineIntakeConfigurationHash"].as_str())
                || value["startupReconciliationReceiptHash"].is_null()))
        || (value["machineIntakeDatasetSnapshotHash"].is_string()
            && (!valid_hash(value["machineIntakeDatasetSnapshotHash"].as_str())
                || value["machineIntakeReconciliationReceiptHash"].is_null()))
        || value["machineIntakeReconciliationFailure"].is_null()
            != value["machineIntakeReconciliationFailedAt"].is_null()
        || (value["machineIntakeReconciliationFailure"].is_string()
            && (value["machineIntakeReconciliationFailure"]
                .as_str()
                .unwrap_or_default()
                .len()
                > 1000
                || value["startupReconciliationReceiptHash"].is_null()))
        || !paired(value, "lastCycleReceiptHash", "lastCycleAt")
    {
        return false;
    }
    if value["fullyAutonomousRequired"] == true
        && !value["startupReconciliationReceiptHash"].is_null()
        && !valid_hash(value["fullyAutonomousPrerequisiteIdentityHash"].as_str())
    {
        return false;
    }
    if value["fullyAutonomousRequired"] != true
        && !value["fullyAutonomousPrerequisiteIdentityHash"].is_null()
    {
        return false;
    }
    if value["machineIntakeReconciliationReceiptHash"].is_string()
        && !value["lastCycleReceiptHash"].is_null()
        && !valid_hash(value["lastCycleReceiptHash"].as_str())
    {
        return false;
    }
    if value["status"] == "stopped" {
        return value["ownerId"].is_null()
            && value["leaseToken"].is_null()
            && value["leaseExpiresAt"].is_null();
    }
    safe_id(value["ownerId"].as_str())
        && safe_id(value["leaseToken"].as_str())
        && parse_millis(value["startedAt"].as_str()).is_some()
        && parse_millis(value["lastHeartbeatAt"].as_str()).is_some()
        && parse_millis(value["leaseExpiresAt"].as_str()).is_some()
        && parse_millis(value["leaseExpiresAt"].as_str()).unwrap_or(0)
            > parse_millis(value["lastHeartbeatAt"].as_str()).unwrap_or(0)
        && parse_millis(value["leaseExpiresAt"].as_str()).unwrap_or(0)
            - parse_millis(value["lastHeartbeatAt"].as_str()).unwrap_or(0)
            <= value["leaseDurationMs"].as_i64().unwrap_or(0) + 1_000
}

fn inspect_private(path: &Path) -> Result<Value, String> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| {
        error("autonomous_research_supervisor_instance_state_invalid_or_migration_required")
    })?;
    db.pragma_update(None, "trusted_schema", false)
        .map_err(|_| {
            error("autonomous_research_supervisor_instance_state_invalid_or_migration_required")
        })?;
    db.query_row(
        "SELECT * FROM autonomous_research_supervisor_instance WHERE scope_id=?1",
        [SCOPE],
        map_row,
    )
    .optional()
    .map_err(|_| {
        error("autonomous_research_supervisor_instance_state_invalid_or_migration_required")
    })?
    .ok_or_else(|| error("autonomous_research_supervisor_instance_missing"))
}

/// Return Node-compatible base/startup/machine-intake readiness from an
/// inode-pinned effective-WAL private snapshot. Current V1 intake checks have a separate
/// composition below, including strict receipt diagnostics. The full mode below
/// additionally observes actual native resident prerequisites and state safety.
pub fn inspect_supervisor_health_v1(runtime_root: &Path, now_millis: i64) -> Result<Value, String> {
    let inspected_at = iso_now(now_millis)?;
    let relative = Path::new(DATABASE_RELATIVE);
    let named = runtime_root.join(relative);
    if !named.exists() {
        return Ok(report(
            None,
            vec!["autonomous_research_supervisor_instance_missing".into()],
            inspected_at,
        ));
    }
    let instance = match crate::state_database_inventory::with_database_effective_snapshot_path_v1(
        runtime_root,
        relative,
        "resident-instance",
        inspect_private,
    ) {
        Ok(value) => value,
        Err(e) if e.code == "autonomous_research_supervisor_instance_missing" => {
            return Ok(report(
                None,
                vec!["autonomous_research_supervisor_instance_missing".into()],
                inspected_at,
            ));
        }
        Err(_) => {
            return Ok(json!({
                "version":1,"kind":"AutonomousResearchSupervisorInstanceStatus",
                "status":"autonomous_research_supervisor_instance_unhealthy",
                "ready":false,"healthy":false,"startupReady":false,
                "fullyAutonomousPrerequisitesReady":false,
                "machineIntakeReconciliationReady":false,"instance":null,
                "blockers":["autonomous_research_supervisor_instance_state_invalid_or_migration_required"],
                "healthBlockers":["autonomous_research_supervisor_instance_state_invalid_or_migration_required"],
                "stateError":"autonomous_research_supervisor_instance_database_invalid",
                "inspectedAt":inspected_at,"statusReadOnly":true
            }));
        }
    };
    let mut health: Vec<String> = Vec::new();
    if instance["status"] != "running" {
        health.push("autonomous_research_supervisor_instance_stopped".into());
    }
    let valid = state_valid(&instance);
    if !valid {
        health.push("autonomous_research_supervisor_instance_state_invalid".into());
    }
    if valid
        && parse_millis(instance["lastHeartbeatAt"].as_str())
            .is_some_and(|v| v > now_millis.saturating_add(30_000))
    {
        health.push("autonomous_research_supervisor_instance_heartbeat_from_future".into());
    }
    if valid && parse_millis(instance["leaseExpiresAt"].as_str()).is_some_and(|v| v <= now_millis) {
        health.push("autonomous_research_supervisor_instance_heartbeat_expired".into());
    }
    let healthy = health.is_empty();
    let startup = healthy && instance["startupReconciliationReceiptHash"].is_string();
    let fully = startup
        && (!instance["fullyAutonomousRequired"]
            .as_bool()
            .unwrap_or(false)
            || valid_hash(instance["fullyAutonomousPrerequisiteIdentityHash"].as_str()));
    let machine = startup
        && instance["machineIntakeReconciliationReceiptHash"].is_string()
        && instance["machineIntakeConfigurationHash"].is_string();
    let mut blockers = health.clone();
    if healthy && !startup {
        blockers.push("autonomous_research_supervisor_startup_reconciliation_incomplete".into());
    }
    if startup && !fully {
        blockers.push("autonomous_research_supervisor_full_prerequisites_required".into());
    }
    if startup && !machine {
        blockers.push("autonomous_research_machine_intake_reconciliation_required".into());
    }
    let ready = machine && fully && blockers.is_empty();
    Ok(json!({
        "version":1,"kind":"AutonomousResearchSupervisorInstanceStatus",
        "status": if ready {"autonomous_research_supervisor_instance_ready"}
            else if healthy {"autonomous_research_supervisor_instance_healthy_starting"}
            else {"autonomous_research_supervisor_instance_unhealthy"},
        "ready":ready,"healthy":healthy,"startupReady":startup,
        "fullyAutonomousPrerequisitesReady":fully,
        "machineIntakeReconciliationReady":machine,"instance":instance,
        "blockers":blockers,"healthBlockers":health,
        "inspectedAt":inspected_at,"statusReadOnly":true
    }))
}
fn report(instance: Option<Value>, blockers: Vec<String>, inspected_at: String) -> Value {
    json!({
        "version":1,"kind":"AutonomousResearchSupervisorInstanceStatus",
        "status":"autonomous_research_supervisor_instance_unhealthy",
        "ready":false,"healthy":false,"startupReady":false,
        "fullyAutonomousPrerequisitesReady":false,
        "machineIntakeReconciliationReady":false,"instance":instance,
        "blockers":blockers,"healthBlockers":blockers,
        "inspectedAt":inspected_at,"statusReadOnly":true
    })
}

/// Compare the actual builtin V1 intake observation with the resident's recorded
/// configuration and dataset identity. This is a read-only diagnostic; intake
/// V2 and other explicitly unsupported native profiles remain blocked.
pub fn inspect_supervisor_health_current_intake_v1(
    runtime_root: &Path,
    environment: &std::collections::BTreeMap<String, String>,
    working_directory: &Path,
    now_millis: i64,
) -> Result<Value, String> {
    inspect_supervisor_health_intake_v1(
        runtime_root,
        environment,
        working_directory,
        now_millis,
        false,
    )
}

/// Compose one actual intake observation with the original strict receipt's data
/// bindings. Strict readiness is diagnostic and does not grant cycle authority.
pub fn inspect_supervisor_health_strict_intake_v1(
    runtime_root: &Path,
    environment: &std::collections::BTreeMap<String, String>,
    working_directory: &Path,
    now_millis: i64,
) -> Result<Value, String> {
    inspect_supervisor_health_intake_v1(
        runtime_root,
        environment,
        working_directory,
        now_millis,
        true,
    )
}

fn inspect_supervisor_health_intake_v1(
    runtime_root: &Path,
    environment: &std::collections::BTreeMap<String, String>,
    working_directory: &Path,
    now_millis: i64,
    strict_mode: bool,
) -> Result<Value, String> {
    let (status, intake) =
        observe_status_and_intake(runtime_root, environment, working_directory, now_millis)?;
    let strict =
        inspect_optional_strict(runtime_root, environment, &intake, now_millis, strict_mode);
    Ok(project_completed_observations(
        status, &intake, None, None, strict,
    ))
}

/// Actual inputs for the full original health composition. This type accepts no
/// caller-generated report, key, authority or readiness override. Repository
/// selection is explicit for embedders; the incumbent CLI fixes its source tree.
pub struct FullSupervisorHealthOptionsV1<'a> {
    pub runtime_root: &'a Path,
    pub repository_root: &'a Path,
    pub working_directory: &'a Path,
    pub environment: &'a std::collections::BTreeMap<String, String>,
    pub external_qualification_config: Option<&'a Path>,
    pub now_millis: i64,
    pub strict_mode: bool,
}

/// Compose one actual observation per stage in original order. Each function
/// completes and drops all source/private-SQLite owners before the next starts.
/// Call before acquiring caller-owned business SQLite or database descriptors;
/// configured resource aliases can otherwise close process-scoped SQLite locks.
/// The result is a completed diagnostic, not a live/atomic readiness grant.
pub fn inspect_supervisor_health_fully_autonomous_v1(
    options: &FullSupervisorHealthOptionsV1<'_>,
) -> Result<Value, String> {
    use crate::{
        native_workspace::resolve_native_workspace_root_v1,
        resident_prerequisites::{
            ResidentPrerequisiteInspectionOptions,
            inspect_autonomous_research_resident_prerequisites_v1,
        },
        state_recoverability::safety_inspection::{
            StateSafetyInspectionOptionsV1, inspect_autonomous_research_state_safety_v1,
        },
    };
    let runtime_root =
        resolve_native_workspace_root_v1(options.working_directory, options.runtime_root, None)?;
    let repository_root =
        resolve_native_workspace_root_v1(options.working_directory, options.repository_root, None)?;
    let (status, intake) = observe_status_and_intake(
        &runtime_root,
        options.environment,
        options.working_directory,
        options.now_millis,
    )?;
    let prerequisites = inspect_autonomous_research_resident_prerequisites_v1(
        &ResidentPrerequisiteInspectionOptions {
            runtime_root: &runtime_root,
            repository_root: &repository_root,
            working_directory: options.working_directory,
            environment: options.environment,
            external_qualification_config: options.external_qualification_config,
            external_action_recovery_config: None,
            now_millis: options.now_millis,
        },
    )
    .map_err(|error| error.code().to_owned())?;
    let safety = inspect_autonomous_research_state_safety_v1(&StateSafetyInspectionOptionsV1 {
        workspace_root: repository_root,
        runtime_root: runtime_root.clone(),
        working_directory: options.working_directory.to_owned(),
        now: options.now_millis,
        environment: options.environment.clone(),
    })
    .unwrap_or_else(|_| unavailable_state_safety());
    let strict = inspect_optional_strict(
        &runtime_root,
        options.environment,
        &intake,
        options.now_millis,
        options.strict_mode,
    );
    Ok(project_completed_observations(
        status,
        &intake,
        Some(prerequisites),
        Some(safety),
        strict,
    ))
}

fn observe_status_and_intake(
    runtime_root: &Path,
    environment: &std::collections::BTreeMap<String, String>,
    working_directory: &Path,
    now_millis: i64,
) -> Result<(Value, Value), String> {
    let status = inspect_supervisor_health_v1(runtime_root, now_millis)?;
    let intake = crate::machine_intake::inspect_machine_intake_status_v1(
        runtime_root,
        environment,
        working_directory,
        now_millis,
    );
    Ok((status, intake))
}

fn inspect_optional_strict(
    runtime_root: &Path,
    environment: &std::collections::BTreeMap<String, String>,
    intake: &Value,
    now_millis: i64,
    strict_mode: bool,
) -> Option<Value> {
    // Previous source/snapshot stages have completed; strict receipt observation
    // uses the same actual intake value, never a second intake capture.
    strict_mode.then(|| crate::strict_machine_intake_reconciliation::inspect_strict_machine_intake_reconciliation_v1(
        runtime_root,
        environment.get("HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH").map(String::as_str),
        environment.get("HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY").map(String::as_str),
        intake,
        now_millis,
    ))
}

fn unavailable_state_safety() -> Value {
    // Exact original CLI catch projection; source producer errors do not become
    // empty success or invented online/authority status.
    json!({"version":1,"kind":"AutonomousResearchStateSafetyInspectionUnavailable",
        "status":"autonomous_research_state_safety_blocked","ready":false,
        "blockers":["autonomous_research_state_safety_inspection_failed"]})
}

fn project_completed_observations(
    mut status: Value,
    intake: &Value,
    prerequisites: Option<Value>,
    safety: Option<Value>,
    strict: Option<Value>,
) -> Value {
    let current_dataset = intake["topicProducerDatasetSnapshotHash"].clone();
    let reconciled_dataset = status["instance"]["machineIntakeDatasetSnapshotHash"].clone();
    let current = intake["coldStartAutonomyReady"] == true
        && status["ready"] == true
        && intake["configurationHash"] == status["instance"]["machineIntakeConfigurationHash"]
        && current_dataset == reconciled_dataset;
    let prerequisite_current = prerequisites.as_ref().is_some_and(|prerequisites| {
        prerequisites["ready"] == true
            && prerequisites["autonomousResearchResidentPrerequisiteIdentityHash"]
                == status["instance"]["fullyAutonomousPrerequisiteIdentityHash"]
    });
    let safety_ready = safety
        .as_ref()
        .is_some_and(|safety| safety["ready"] == true);
    let safety_blockers = safety
        .as_ref()
        .and_then(|safety| safety.get("blockers"))
        .filter(|blockers| !blockers.is_null())
        .cloned()
        .unwrap_or_else(|| json!([]));
    let fully_ready = current
        && status["fullyAutonomousPrerequisitesReady"] == true
        && prerequisite_current
        && safety_ready;
    let strict_ready = strict
        .as_ref()
        .is_some_and(|status| status["ready"] == true);
    let fields = json!({
        "currentMachineIntakeReady":current,
        "currentMachineIntakeConfigurationHash":intake["configurationHash"],
        "currentTopicProducerDatasetSnapshotHash":current_dataset,
        "reconciledTopicProducerDatasetSnapshotHash":reconciled_dataset,
        "residentPrerequisites":prerequisites,"residentPrerequisiteIdentityCurrent":prerequisite_current,
        "autonomousStateSafety":safety,"autonomousStateSafetyReady":safety_ready,
        "autonomousStateSafetyBlockers":safety_blockers,"fullyAutonomousReady":fully_ready,
        "strictMachineIntakeReconciliation":strict,"strictMachineIntakeReconciliationReady":strict_ready,
        "currentMachineIntakeBlockers":intake["blockers"]
    });
    if let (Some(report), Some(fields)) = (status.as_object_mut(), fields.as_object()) {
        report.extend(fields.clone());
    }
    status
}

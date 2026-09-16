//! Read-only resident lease fencing against the actual supervisor SQLite row.
use super::files::{ObservedFile, no_sidecars};
use super::*;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::path::{Path, PathBuf};
const SCOPE: &str = "resident-autonomous-research-supervisor";
const DATABASE: &str = "autonomous-research/supervisor/resident-instance.sqlite";
fn safe(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:@/-".contains(&b))
}
fn fail() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_supervisor_instance_lease_fence_conflict")
}
/// Identity is a claim, not proof: assert_current reads the actual database on
/// every call. Neither a JSON context nor a caller callback can prove this lease.
pub struct ResidentLeaseV1 {
    path: PathBuf,
    owner: String,
    token: String,
    generation: i64,
}
pub struct ObservedResidentLeaseV1 {
    value: Value,
    snapshot: ObservedFile,
    observed_at: i64,
}
impl ObservedResidentLeaseV1 {
    pub fn value(&self) -> &Value {
        &self.value
    }
    pub(super) fn assert_valid_at(&self, now: i64) -> Result<()> {
        let expires = timestamp(&self.value["leaseExpiresAt"]).ok_or_else(fail)?;
        if now < self.observed_at || now >= expires {
            return Err(fail());
        }
        Ok(())
    }
    pub fn assert_current(&self, now: i64) -> Result<()> {
        self.assert_valid_at(now)?;
        no_sidecars(&self.snapshot.path)?;
        self.snapshot.assert_current()
    }
}
impl ResidentLeaseV1 {
    pub fn new(runtime_root: &Path, owner: &str, token: &str, generation: i64) -> Result<Self> {
        ensure(
            runtime_root.is_absolute()
                && safe(owner)
                && safe(token)
                && (1..=9_007_199_254_740_991).contains(&generation),
            "autonomous_research_supervisor_instance_lease_identity_invalid",
        )?;
        Ok(Self {
            path: runtime_root.join(DATABASE),
            owner: owner.into(),
            token: token.into(),
            generation,
        })
    }
    pub fn assert_current(&self, now: i64) -> Result<ObservedResidentLeaseV1> {
        self.assert_current_with_hook(now, || {})
    }
    /// A deterministic observation hook for race tests; it cannot mint a lease.
    pub fn assert_current_with_hook(
        &self,
        now: i64,
        after_read: impl FnOnce(),
    ) -> Result<ObservedResidentLeaseV1> {
        let observed_at = iso(now)?;
        let snapshot = ObservedFile::open(&self.path, 256 * 1024 * 1024)?;
        no_sidecars(&self.path)?;
        // SQLite may canonicalize a /proc descriptor URI before opening. Read
        // the held inode into a private copy first instead of reopening live state.
        let scratch = super::sqlite_copy::Scratch::new()?;
        scratch
            .directory
            .write_new("resident.sqlite", &snapshot.bytes(256 * 1024 * 1024)?)?;
        let database = Connection::open_with_flags(
            scratch.directory.path.join("resident.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NOFOLLOW
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| fail())?;
        database
            .pragma_update(None, "trusted_schema", false)
            .map_err(|_| fail())?;
        let value=database.query_row("SELECT * FROM autonomous_research_supervisor_instance WHERE scope_id=?1 AND status='running' AND owner_id=?2 AND lease_token=?3 AND lease_generation=?4 AND julianday(lease_expires_at)>julianday(?5)",rusqlite::params![SCOPE,self.owner,self.token,self.generation,observed_at],map_row).optional().map_err(|_|fail())?.ok_or_else(fail)?;
        ensure(
            valid(&value),
            "autonomous_research_supervisor_instance_lease_fence_conflict",
        )?;
        after_read();
        let observed = ObservedResidentLeaseV1 {
            value,
            snapshot,
            observed_at: now,
        };
        observed.assert_current(now)?;
        Ok(observed)
    }
}
fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut value = serde_json::Map::new();
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
        let raw: Option<String> = row.get(source)?;
        value.insert(
            target.into(),
            raw.filter(|v| !v.is_empty())
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
    }
    for (target, source) in [
        ("leaseGeneration", "lease_generation"),
        ("leaseDurationMs", "lease_duration_ms"),
        ("heartbeatIntervalMs", "heartbeat_interval_ms"),
        ("recoveredLeaseCount", "recovered_lease_count"),
    ] {
        value.insert(target.into(), json!(row.get::<_, i64>(source)?));
    }
    value.insert(
        "fullyAutonomousRequired".into(),
        json!(row.get::<_, i64>("fully_autonomous_required")? == 1),
    );
    Ok(Value::Object(value))
}
fn paired(v: &Value, hash: &str, at: &str) -> bool {
    v[hash].is_null() == v[at].is_null()
        && (v[hash].is_null() || (sha(&v[hash]) && timestamp(&v[at]).is_some()))
}
fn sha(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 71 && s.starts_with("sha256:") && s[7..].bytes().all(|b| b.is_ascii_hexdigit())
    })
}
fn valid(v: &Value) -> bool {
    let lease = v["leaseDurationMs"].as_i64().unwrap_or(-1);
    let heartbeat = v["heartbeatIntervalMs"].as_i64().unwrap_or(-1);
    let machine = &v["machineIntakeReconciliationReceiptHash"];
    let failure = &v["machineIntakeReconciliationFailure"];
    let Some(last) = timestamp(&v["lastHeartbeatAt"]) else {
        return false;
    };
    let Some(expires) = timestamp(&v["leaseExpiresAt"]) else {
        return false;
    };
    v["scopeId"] == SCOPE
        && v["status"] == "running"
        && v["leaseGeneration"]
            .as_i64()
            .is_some_and(|v| (1..=9_007_199_254_740_991).contains(&v))
        && (1000..=1_800_000).contains(&lease)
        && heartbeat >= 250
        && heartbeat.saturating_mul(2) < lease
        && ["createdAt", "updatedAt", "startedAt"]
            .iter()
            .all(|k| timestamp(&v[k]).is_some())
        && ["ownerId", "leaseToken"]
            .iter()
            .all(|k| v[k].as_str().is_some_and(safe))
        && expires > last
        && expires - last <= lease + 1000
        && paired(v, "startupReconciliationReceiptHash", "startupReconciledAt")
        && (v["fullyAutonomousRequired"] == true
            || v["fullyAutonomousPrerequisiteIdentityHash"].is_null())
        && (v["fullyAutonomousRequired"] != true
            || v["startupReconciliationReceiptHash"].is_null()
            || sha(&v["fullyAutonomousPrerequisiteIdentityHash"]))
        && paired(
            v,
            "machineIntakeReconciliationReceiptHash",
            "machineIntakeReconciledAt",
        )
        && machine.is_null() == v["machineIntakeConfigurationHash"].is_null()
        && (machine.is_null()
            || (sha(&v["machineIntakeConfigurationHash"])
                && !v["startupReconciliationReceiptHash"].is_null()))
        && (v["machineIntakeDatasetSnapshotHash"].is_null()
            || (sha(&v["machineIntakeDatasetSnapshotHash"]) && !machine.is_null()))
        && failure.is_null() == v["machineIntakeReconciliationFailedAt"].is_null()
        && (failure.is_null()
            || (timestamp(&v["machineIntakeReconciliationFailedAt"]).is_some()
                && failure
                    .as_str()
                    .is_some_and(|s| s.encode_utf16().count() <= 1000)
                && !v["startupReconciliationReceiptHash"].is_null()))
        && (machine.is_null() || failure.is_null())
        && paired(v, "lastCycleReceiptHash", "lastCycleAt")
}

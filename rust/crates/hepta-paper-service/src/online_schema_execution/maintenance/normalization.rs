//! Real bounded live journal normalization. Serialized progress is not authority:
//! resume repeats pinned signature, full physical scope and exact byte projection.
use super::*;
use crate::{
    online_schema_execution::plan::{
        SchemaTransitionPlanOptionsV1, normalization_support::restore_normalization_plan,
    },
    pristine_runtime_state::PinnedMachineGenesisDocumentsV1,
    sqlite_mutation_coordinator::{text, timestamp},
    state_database_inventory::{
        inspect_state_database_inventory_v1,
        schema_source::{
            SchemaSource, maintenance_lock::SchemaMaintenanceLock,
            normalization_support::normalize_step,
        },
    },
    state_recoverability::schema_normalization_repository::NormalizationRepository,
};
use serde_json::json;
use std::path::Path;

fn ensure(valid: bool, code: &str) -> Result<()> {
    if valid { Ok(()) } else { Err(error(code)) }
}
/// Held root-inode lock and real authority token. No public constructor,
/// deserializer, raw connection or source path mutation callback is exposed.
pub struct NormalizedSchemaMaintenanceV1 {
    maintenance: QuiescedSchemaMaintenanceV1,
    lock: SchemaMaintenanceLock,
    journal: Value,
    journal_hash: String,
}
impl NormalizedSchemaMaintenanceV1 {
    pub fn records(&self) -> &Value {
        &self.journal["normalizationRecords"]
    }
    pub fn plan(&self) -> &Value {
        self.maintenance.plan()
    }
    pub fn journal_hash(&self) -> &str {
        &self.journal_hash
    }
    pub fn assert_current<T: MutationAuthorityTransportV1>(
        &mut self,
        authority: &PinnedMutationAuthorityV1<T>,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        self.lock.assert_current()?;
        let repo = NormalizationRepository::open(&self.lock, false)?;
        let (value, hash) = repo.load()?.ok_or_else(|| {
            error("autonomous_research_online_schema_transition_normalization_journal_missing")
        })?;
        ensure(
            value == self.journal && hash == self.journal_hash,
            "autonomous_research_online_schema_transition_normalization_journal_changed",
        )?;
        self.maintenance.assert_current(authority, clock)
    }
}
/// Fault hooks are observation-only test/operational checkpoints. They cannot
/// create authority or supply a database handle, nor suppress any verification.
pub trait SchemaNormalizationCheckpointV1 {
    fn checkpoint(&mut self, name: &str, database_instance_id: &str) -> Result<()>;
}
pub struct NoSchemaNormalizationCheckpointV1;
impl SchemaNormalizationCheckpointV1 for NoSchemaNormalizationCheckpointV1 {
    fn checkpoint(&mut self, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
}
fn scope_guard<T: MutationAuthorityTransportV1>(
    maintenance: &mut QuiescedSchemaMaintenanceV1,
    lock: &SchemaMaintenanceLock,
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
) -> Result<()> {
    let before = clock.now_millis()?;
    maintenance.advance_clock(before)?;
    lock.assert_current()?;
    ensure(
        maintenance.plan.authority_configuration_hash() == authority.configuration_hash(),
        "autonomous_research_online_schema_transition_authority_configuration_mismatch",
    )?;
    maintenance.plan.refresh_normalization_scope()?;
    let verify_at = clock.now_millis()?;
    maintenance.advance_clock(verify_at)?;
    let receipt = authority.verify_schema_transition_reservation(
        maintenance.reservation.value(),
        &maintenance.request,
        verify_at,
    )?;
    let after = clock.now_millis()?;
    maintenance.advance_clock(after)?;
    super::assert_lease(receipt.value(), maintenance.plan.value(), verify_at, after)?;
    maintenance.reservation = receipt;
    Ok(())
}
fn execute<T: MutationAuthorityTransportV1>(
    mut maintenance: QuiescedSchemaMaintenanceV1,
    lock: SchemaMaintenanceLock,
    mut journal: Value,
    mut journal_hash: String,
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
    checkpoint: &mut dyn SchemaNormalizationCheckpointV1,
) -> Result<NormalizedSchemaMaintenanceV1> {
    let count = maintenance.plan()["instances"]
        .as_array()
        .ok_or_else(|| error("autonomous_research_online_schema_transition_inventory_invalid"))?
        .len();
    // Records are observations recomputed from actual files; journal flags never
    // skip a source check, even after a process exited before publishing progress.
    let mut records = Vec::new();
    for index in 0..count {
        scope_guard(&mut maintenance, &lock, authority, clock)?;
        let id = text(
            &maintenance.plan()["instances"][index],
            "databaseInstanceId",
        )?
        .to_owned();
        let existing = maintenance.plan.normalized_record(index)?;
        let source = maintenance.plan.source_for_step(index)?;
        let before_sha = source.normalization_state()["sourceSha256"].clone();
        let already_normalized = existing.is_some();
        if existing.is_none() {
            normalize_step(
                &source,
                &mut || scope_guard(&mut maintenance, &lock, authority, clock),
                &mut |name| checkpoint.checkpoint(name, &id),
            )?;
        }
        scope_guard(&mut maintenance, &lock, authority, clock)?;
        let mut record = maintenance.plan.normalized_record(index)?.ok_or_else(|| {
            error("autonomous_research_online_schema_transition_normalized_source_mismatch")
        })?;
        record["beforeSha256"] = before_sha;
        if already_normalized {
            let row = &maintenance.plan()["instances"][index];
            record[if row["preSchemaHash"] == row["expectedPostSchemaHash"] {
                "alreadyInstalled"
            } else {
                "alreadyNormalized"
            }] = json!(true);
        }
        records.push(record);
        checkpoint.checkpoint("before_normalization_progress_publication", &id)?;
        scope_guard(&mut maintenance, &lock, authority, clock)?;
        ensure(
            maintenance.plan.normalized_record(index)?.is_some(),
            "autonomous_research_online_schema_transition_normalized_source_mismatch",
        )?;
        journal["normalizationRecords"] = json!(records);
        journal["checkedAtMillis"] = json!(maintenance.checked_at);
        let repo = NormalizationRepository::open(&lock, false)?;
        journal_hash = repo.publish(&journal, Some(&journal_hash))?;
        checkpoint.checkpoint("after_normalization_progress_publication", &id)?;
    }
    scope_guard(&mut maintenance, &lock, authority, clock)?;
    for index in 0..count {
        ensure(
            maintenance.plan.normalized_record(index)?.is_some(),
            "autonomous_research_online_schema_transition_normalized_source_mismatch",
        )?;
    }
    let mut result = NormalizedSchemaMaintenanceV1 {
        maintenance,
        lock,
        journal,
        journal_hash,
    };
    result.assert_current(authority, clock)?;
    Ok(result)
}
/// Consume a real fresh, signed all-database quiescence token. The journal is
/// initialized durably before any SQLite source write; competing runs fail closed.
pub fn normalize_schema_maintenance_v1<T: MutationAuthorityTransportV1>(
    mut maintenance: QuiescedSchemaMaintenanceV1,
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
    checkpoint: &mut dyn SchemaNormalizationCheckpointV1,
) -> Result<NormalizedSchemaMaintenanceV1> {
    maintenance.assert_current(authority, clock)?;
    let lock = SchemaMaintenanceLock::acquire(maintenance.plan.first_source()?)?;
    scope_guard(&mut maintenance, &lock, authority, clock)?;
    let journal = json!({"version":1,"kind":"NativeSchemaJournalNormalizationProgress","runtimeRootIdentity":lock.identity(),"authorityConfigurationHash":maintenance.plan.authority_configuration_hash(),"plan":maintenance.plan(),"request":maintenance.request(),"reservation":maintenance.reservation(),"checkedAtMillis":maintenance.checked_at,"normalizationRecords":[]});
    // Strict JSON parsing canonicalizes safe integral Number spellings while
    // preserving the signed JS-number semantics; float-spelled receipts remain
    // verifiable after durable serialization and process recovery.
    let journal = crate::sqlite_mutation_coordinator::authority::files::parse(
        &serde_json::to_vec(&journal).map_err(|e| error(e.to_string()))?,
        "autonomous_research_online_schema_transition_normalization_journal_invalid",
    )?;
    let repo = NormalizationRepository::open(&lock, true)?;
    ensure(
        repo.load()?.is_none(),
        "autonomous_research_online_schema_transition_normalization_resume_required",
    )?;
    let journal_hash = repo.publish(&journal, None)?;
    drop(repo);
    scope_guard(&mut maintenance, &lock, authority, clock)?;
    execute(
        maintenance,
        lock,
        journal,
        journal_hash,
        authority,
        clock,
        checkpoint,
    )
}
pub struct ResumeSchemaNormalizationOptionsV1<'a> {
    pub runtime_root: &'a Path,
    pub state_database_manifest: &'a Value,
    pub writer_manifest: &'a Value,
    pub expected_transition_id: &'a str,
    pub machine_genesis: Option<&'a PinnedMachineGenesisDocumentsV1>,
}
/// Recovery accepts stored data only after actual re-verification. Expired leases
/// or an old engine's incompatible reserved bytes cannot authorize another write.
pub fn resume_schema_normalization_v1<T: MutationAuthorityTransportV1>(
    options: ResumeSchemaNormalizationOptionsV1<'_>,
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
    checkpoint: &mut dyn SchemaNormalizationCheckpointV1,
) -> Result<NormalizedSchemaMaintenanceV1> {
    let inventory =
        inspect_state_database_inventory_v1(options.runtime_root, options.state_database_manifest)?;
    let row = inventory["instances"]
        .as_array()
        .and_then(|v| v.first())
        .ok_or_else(|| error("autonomous_research_online_schema_transition_inventory_invalid"))?;
    let source = SchemaSource::observe(
        options.runtime_root,
        Path::new(text(row, "sourceRelativePath")?),
        text(row, "role")?,
    )?;
    let lock = SchemaMaintenanceLock::acquire(&source)?;
    let repo = NormalizationRepository::open(&lock, false)?;
    let (journal, journal_hash) = repo.load()?.ok_or_else(|| {
        error("autonomous_research_online_schema_transition_normalization_journal_missing")
    })?;
    ensure(
        journal["version"] == 1
            && journal["kind"] == "NativeSchemaJournalNormalizationProgress"
            && journal["plan"]["transitionId"] == options.expected_transition_id
            && journal["runtimeRootIdentity"] == *lock.identity()
            && journal["authorityConfigurationHash"] == authority.configuration_hash(),
        "autonomous_research_online_schema_transition_normalization_journal_invalid",
    )?;
    let now = clock.now_millis()?;
    let checked = int(&journal, "checkedAtMillis")?;
    let planned = timestamp(&journal["plan"]["plannedAt"])
        .ok_or_else(|| error("autonomous_research_online_schema_transition_clock_invalid"))?;
    ensure(
        now >= checked && now >= planned,
        "autonomous_research_online_schema_transition_clock_regressed",
    )?;
    let reservation = authority.verify_schema_transition_reservation(
        &journal["reservation"],
        &journal["request"],
        now,
    )?;
    assert_lease(reservation.value(), &journal["plan"], now, now)?;
    let plan = restore_normalization_plan(
        &journal,
        SchemaTransitionPlanOptionsV1 {
            runtime_root: options.runtime_root,
            state_database_manifest: options.state_database_manifest,
            writer_manifest: options.writer_manifest,
            requested_lease_ms: int(&journal["plan"], "requestedLeaseMs")?,
            required_execution_window_ms: int(&journal["plan"], "requiredExecutionWindowMs")?,
            expected_pre_rebind_pristine_runtime_state_hash:
                journal["plan"]["prePristineRuntimeStateHash"].as_str(),
            machine_genesis: options.machine_genesis,
        },
        authority,
    )?;
    ensure(
        plan.normalization_root() == lock.runtime_root()?,
        "autonomous_research_online_schema_transition_runtime_root_identity_changed",
    )?;
    let mut maintenance = QuiescedSchemaMaintenanceV1 {
        plan,
        request: journal["request"].clone(),
        reservation,
        checked_at: now,
    };
    scope_guard(&mut maintenance, &lock, authority, clock)?;
    drop(repo);
    execute(
        maintenance,
        lock,
        journal,
        journal_hash,
        authority,
        clock,
        checkpoint,
    )
}

pub mod installation;

pub mod finalization;

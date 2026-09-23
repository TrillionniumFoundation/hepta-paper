//! Real signed schema/genesis installation and commit-before-progress recovery.
//! Private normalized preimages prove every row; serialized completion flags do
//! not authorize a write or establish that a post-schema database is legitimate.
mod metadata;
mod state;
use super::*;
use crate::{
    online_schema_execution::plan::installation_support::{
        validate_installation_inventory, validate_installation_journal,
    },
    online_schema_transition::target_schema::{
        SchemaTransitionTargetV1, apply_schema_transition_statements_v1,
    },
    pristine_runtime_state::{
        PristineDatabaseInspectionV1, PristineDatabaseOptionsV1,
        inspect_pristine_database_in_transaction_v1, pristine_runtime_state_hash_v1,
    },
    sqlite_mutation_coordinator::{
        contracts::schema_transition::schema_transition_receipt_hash_v1, hash,
        storage::exact_schema_hash_v1,
    },
    state_database_inventory::schema_source::installation_support::LockedSchemaDatabase,
    state_recoverability::schema_installation_repository::InstallationPreimages,
};
use rusqlite::Connection;

/// Exact bounded logical state digest used by passive startup recovery. The
/// named table's rows are excluded; schema and every other table remain in the
/// digest, so an authorized receipt append cannot hide business or marker
/// changes.
pub(crate) fn digest_excluding_table_v1(database: &Connection, table: &str) -> Result<String> {
    state::digest_excluding_table_v1(database, table)
}

pub trait SchemaInstallationCheckpointV1 {
    fn checkpoint(&mut self, point: &str, database_instance_id: &str) -> Result<()>;
}
pub struct NoSchemaInstallationCheckpointV1;
impl SchemaInstallationCheckpointV1 for NoSchemaInstallationCheckpointV1 {
    fn checkpoint(&mut self, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
}
/// The lease margin is checked again after every external checkpoint and pinned
/// verifier/file read. Zero or caller booleans cannot disable the boundary.
pub struct SchemaInstallationOptionsV1<'a> {
    pub commit_safety_margin_ms: i64,
    pub machine_genesis: Option<&'a PinnedMachineGenesisDocumentsV1>,
}
impl Default for SchemaInstallationOptionsV1<'_> {
    fn default() -> Self {
        Self {
            commit_safety_margin_ms: 1000,
            machine_genesis: None,
        }
    }
}
struct ExpectedDatabase {
    preimage: SchemaSource,
    before: Connection,
    after: Connection,
    record: Value,
}
struct InstallationContext {
    lock: SchemaMaintenanceLock,
    manifest: Value,
    journal: Value,
    journal_hash: String,
    reservation: VerifiedMutationReceiptV1,
    checked_at: i64,
    margin: i64,
}
/// Retains the root maintenance lock and all ten exclusive database transactions.
/// It is neither externally finalized nor an active runtime capability.
pub struct InstalledSchemaMaintenanceV1 {
    context: InstallationContext,
    databases: Vec<LockedSchemaDatabase>,
    expected: Vec<ExpectedDatabase>,
}
impl InstalledSchemaMaintenanceV1 {
    pub fn records(&self) -> &Value {
        &self.context.journal["installations"]
    }
    pub fn plan(&self) -> &Value {
        &self.context.journal["plan"]
    }
    pub fn journal_hash(&self) -> &str {
        &self.context.journal_hash
    }
    pub fn assert_current<T: MutationAuthorityTransportV1>(
        &mut self,
        authority: &PinnedMutationAuthorityV1<T>,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        for (actual, expected) in self.databases.iter().zip(&self.expected) {
            expected.preimage.assert_current()?;
            state::compare_installation_state_v1(&expected.after, actual.connection())?;
        }
        guard(&mut self.context, &self.databases, authority, clock)
    }
}
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_online_schema_transition_installation_invalid")
}
fn validate_commit_safety_margin(commit_safety_margin_ms: i64, plan: &Value) -> Result<()> {
    let required_execution_window_ms = int(plan, "requiredExecutionWindowMs")?;
    ensure(
        commit_safety_margin_ms >= 1 && commit_safety_margin_ms < required_execution_window_ms,
        "autonomous_research_online_schema_transition_safety_margin_invalid",
    )
}
fn advance(context: &mut InstallationContext, now: i64) -> Result<()> {
    ensure(
        now >= context.checked_at,
        "autonomous_research_online_schema_transition_clock_regressed",
    )?;
    context.checked_at = now;
    Ok(())
}
fn final_clock(context: &mut InstallationContext, clock: &mut dyn MutationClockV1) -> Result<()> {
    let after = clock.now_millis()?;
    advance(context, after)?;
    let expires = timestamp(&context.reservation.value()["expiresAt"]).ok_or_else(invalid)?;
    ensure(
        after < expires
            && expires
                .checked_sub(after)
                .is_some_and(|left| left >= context.margin),
        "autonomous_research_online_schema_transition_lease_expiring_before_commit",
    )
}
fn guard<T: MutationAuthorityTransportV1>(
    context: &mut InstallationContext,
    databases: &[LockedSchemaDatabase],
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
) -> Result<()> {
    advance(context, clock.now_millis()?)?;
    context.lock.assert_current()?;
    ensure(
        context.journal["authorityConfigurationHash"] == authority.configuration_hash(),
        "autonomous_research_online_schema_transition_authority_configuration_mismatch",
    )?;
    let plan = &context.journal["plan"];
    let instances = plan["instances"].as_array().ok_or_else(invalid)?;
    for (database, row) in databases.iter().zip(instances) {
        database.assert_identity(row, context.lock.identity())?;
    }
    // Namespace checks do not open live SQLite while our EXCLUSIVE locks are held.
    let first = instances.first().ok_or_else(invalid)?;
    if databases.is_empty() {
        let source = SchemaSource::observe(
            context.lock.runtime_root()?,
            Path::new(text(first, "sourceRelativePath")?),
            text(first, "databaseRole")?,
        )?;
        source.assert_registered_namespace(&context.manifest, &plan["instances"])?;
    } else {
        databases[0].assert_namespace(&context.manifest, &plan["instances"])?;
    }
    let repo = NormalizationRepository::open(&context.lock, false)?;
    let (journal, digest) = repo.load()?.ok_or_else(invalid)?;
    ensure(
        journal == context.journal && digest == context.journal_hash,
        "autonomous_research_online_schema_transition_installation_journal_changed",
    )?;
    let verify_at = clock.now_millis()?;
    advance(context, verify_at)?;
    let receipt = authority.verify_schema_transition_reservation(
        &context.journal["reservation"],
        &context.journal["request"],
        verify_at,
    )?;
    let after = clock.now_millis()?;
    advance(context, after)?;
    let expires = timestamp(&receipt.value()["expiresAt"]).ok_or_else(invalid)?;
    ensure(
        after < expires
            && expires
                .checked_sub(after)
                .is_some_and(|left| left >= context.margin),
        "autonomous_research_online_schema_transition_lease_expiring_before_commit",
    )?;
    context.reservation = receipt;
    Ok(())
}
fn pristine(
    database: &Connection,
    plan: &Value,
    row: &Value,
    phase: &str,
    documents: Option<&PinnedMachineGenesisDocumentsV1>,
) -> Result<PristineDatabaseInspectionV1> {
    inspect_pristine_database_in_transaction_v1(
        database,
        PristineDatabaseOptionsV1 {
            database_role: text(row, "databaseRole")?,
            database_instance_id: text(row, "databaseInstanceId")?,
            schema_contract_id: text(
                row,
                if phase == "pre-rebind" {
                    "preSchemaContractId"
                } else {
                    "schemaContractId"
                },
            )?,
            schema_hash: text(
                row,
                if phase == "pre-rebind" {
                    "preSchemaHash"
                } else {
                    "expectedPostSchemaHash"
                },
            )?,
            state_database_manifest_hash: text(plan, "stateDatabaseManifestHash")?,
            phase,
            machine_genesis: documents,
        },
    )
}
fn page_bytes(database: &Connection) -> Result<u64> {
    let pages: i64 = database.query_row("PRAGMA main.page_count", [], |r| r.get(0))?;
    let size: i64 = database.query_row("PRAGMA main.page_size", [], |r| r.get(0))?;
    let bytes = pages
        .checked_mul(size)
        .and_then(|v| u64::try_from(v).ok())
        .ok_or_else(invalid)?;
    ensure(
        bytes <= 256 * 1024 * 1024,
        "autonomous_research_online_schema_transition_installation_size_limit",
    )?;
    Ok(bytes)
}
fn health(database: &Connection, expected_schema: &Value) -> Result<()> {
    page_bytes(database)?;
    let mut quick = database.prepare("PRAGMA main.quick_check")?;
    let values = quick
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ensure(
        values == ["ok"]
            && !database
                .prepare("PRAGMA main.foreign_key_check")?
                .exists([])?
            && expected_schema == &exact_schema_hash_v1(database)?,
        "autonomous_research_online_schema_transition_post_schema_invalid",
    )
}
fn prepare_expected(
    context: &InstallationContext,
    options: &SchemaInstallationOptionsV1<'_>,
) -> Result<Vec<ExpectedDatabase>> {
    let repo = InstallationPreimages::open(&context.lock, &context.journal["plan"], false)?;
    let plan = &context.journal["plan"];
    let mut result = Vec::new();
    let mut inspections = Vec::new();
    let mut total_bytes = 0u64;
    for row in plan["instances"].as_array().ok_or_else(invalid)? {
        let preimage = repo.load(row)?;
        let before =
            preimage.installation_memory_copy(text(row, "expectedNormalizedSourceSha256")?)?;
        before.execute_batch("BEGIN DEFERRED")?;
        health(&before, &row["preSchemaHash"])?;
        if plan["version"].as_f64() == Some(2.) {
            let inspected = pristine(&before, plan, row, "pre-rebind", options.machine_genesis)?;
            ensure(
                inspected.value()["pristineStateHash"] == row["prePristineStateHash"],
                "autonomous_research_pristine_schema_rebind_local_preimage_invalid",
            )?;
            inspections.push(inspected);
        }
        let mut after =
            preimage.installation_memory_copy(text(row, "expectedNormalizedSourceSha256")?)?;
        after.execute_batch("BEGIN IMMEDIATE")?;
        let target = SchemaTransitionTargetV1::for_role(
            text(row, "databaseRole")?,
            Some(text(plan, "plannedAt")?),
        )?;
        apply_schema_transition_statements_v1(&mut after, &target)?;
        metadata::install(&after, plan, row, context.reservation.value())?;
        health(&after, &row["expectedPostSchemaHash"])?;
        total_bytes = total_bytes
            .checked_add(page_bytes(&after)?)
            .ok_or_else(invalid)?;
        ensure(
            total_bytes <= 1024 * 1024 * 1024,
            "autonomous_research_online_schema_transition_installation_size_limit",
        )?;
        let post = if plan["version"].as_f64() == Some(2.) {
            Some(pristine(
                &after,
                plan,
                row,
                "post-rebind",
                options.machine_genesis,
            )?)
        } else {
            None
        };
        let record = metadata::record(
            plan,
            context.reservation.value(),
            row,
            post.as_ref()
                .and_then(|v| v.value()["pristineStateHash"].as_str()),
        )?;
        preimage.assert_current()?;
        result.push(ExpectedDatabase {
            preimage,
            before,
            after,
            record,
        });
    }
    if plan["version"].as_f64() == Some(2.) {
        ensure(
            pristine_runtime_state_hash_v1(&inspections)? == plan["prePristineRuntimeStateHash"],
            "autonomous_research_pristine_schema_rebind_expected_state_mismatch",
        )?;
    }
    Ok(result)
}
fn execute<T: MutationAuthorityTransportV1>(
    mut context: InstallationContext,
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
    options: SchemaInstallationOptionsV1<'_>,
    checkpoint: &mut dyn SchemaInstallationCheckpointV1,
) -> Result<InstalledSchemaMaintenanceV1> {
    guard(&mut context, &[], authority, clock)?;
    let expected = prepare_expected(&context, &options)?;
    guard(&mut context, &[], authority, clock)?;
    let rows = context.journal["plan"]["instances"]
        .as_array()
        .ok_or_else(invalid)?
        .clone();
    let mut databases = Vec::new();
    for row in &rows {
        let source = SchemaSource::observe(
            context.lock.runtime_root()?,
            Path::new(text(row, "sourceRelativePath")?),
            text(row, "databaseRole")?,
        )?;
        databases.push(LockedSchemaDatabase::acquire(
            source,
            row,
            context.lock.identity(),
        )?);
        guard(&mut context, &databases, authority, clock)?;
    }
    let mut completed = Vec::new();
    for index in 0..rows.len() {
        let row = &rows[index];
        let id = text(row, "databaseInstanceId")?;
        guard(&mut context, &databases, authority, clock)?;
        expected[index].preimage.assert_current()?;
        let installed = state::compare_installation_state_v1(
            &expected[index].after,
            databases[index].connection(),
        )
        .is_ok();
        if !installed {
            state::compare_installation_state_v1(
                &expected[index].before,
                databases[index].connection(),
            )?;
            ensure(
                databases[index].observed_sha256() == text(row, "expectedNormalizedSourceSha256")?,
                "autonomous_research_online_schema_transition_normalized_source_mismatch",
            )?;
            let target = SchemaTransitionTargetV1::for_role(
                text(row, "databaseRole")?,
                Some(text(&context.journal["plan"], "plannedAt")?),
            )?;
            apply_schema_transition_statements_v1(databases[index].connection_mut(), &target)?;
            metadata::install(
                databases[index].connection(),
                &context.journal["plan"],
                row,
                context.reservation.value(),
            )?;
            health(
                databases[index].connection(),
                &row["expectedPostSchemaHash"],
            )?;
            state::compare_installation_state_v1(
                &expected[index].after,
                databases[index].connection(),
            )?;
            checkpoint.checkpoint("before_instance_commit", id)?;
            guard(&mut context, &databases, authority, clock)?;
            // A callback can modify the private expected artifact or public
            // pins. Recheck all evidence before the final clock and COMMIT.
            expected[index].preimage.assert_current()?;
            state::compare_installation_state_v1(
                &expected[index].after,
                databases[index].connection(),
            )?;
            guard(&mut context, &databases, authority, clock)?;
            let root_identity = context.lock.identity().clone();
            databases[index].commit(row, &root_identity, &mut || {
                final_clock(&mut context, clock)
            })?;
            // This hook is deliberately BEFORE progress publication. A real
            // exit here proves recovery cannot rely on a completion flag.
            checkpoint.checkpoint("after_instance_commit_before_publication", id)?;
            databases[index].begin_exclusive_again()?;
            state::compare_installation_state_v1(
                &expected[index].after,
                databases[index].connection(),
            )?;
        }
        completed.push(expected[index].record.clone());
        guard(&mut context, &databases, authority, clock)?;
        context.journal["installationPhase"] = json!("installing");
        context.journal["installations"] = json!(completed);
        context.journal["checkedAtMillis"] = json!(context.checked_at);
        let repo = NormalizationRepository::open(&context.lock, false)?;
        context.journal_hash = repo.publish(&context.journal, Some(&context.journal_hash))?;
        checkpoint.checkpoint("after_installation_progress_publication", id)?;
    }
    let mut result = InstalledSchemaMaintenanceV1 {
        context,
        databases,
        expected,
    };
    result.assert_current(authority, clock)?;
    Ok(result)
}
/// Consume actual normalized maintenance. All ten signed normalized byte images
/// are persisted no-clobber before the first live database write.
pub fn install_schema_maintenance_v1<T: MutationAuthorityTransportV1>(
    mut normalized: NormalizedSchemaMaintenanceV1,
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
    options: SchemaInstallationOptionsV1<'_>,
    checkpoint: &mut dyn SchemaInstallationCheckpointV1,
) -> Result<InstalledSchemaMaintenanceV1> {
    validate_commit_safety_margin(options.commit_safety_margin_ms, normalized.plan())?;
    normalized.assert_current(authority, clock)?;
    let manifest = normalized.maintenance.plan.installation_manifest().clone();
    let repo = InstallationPreimages::open(&normalized.lock, normalized.plan(), true)?;
    for (index, row) in normalized.plan()["instances"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .enumerate()
    {
        let source = normalized.maintenance.plan.source_for_step(index)?;
        repo.store(
            row,
            &source.installation_bytes(text(row, "expectedNormalizedSourceSha256")?)?,
        )?;
    }
    drop(repo);
    normalized.assert_current(authority, clock)?;
    let context = InstallationContext {
        lock: normalized.lock,
        manifest,
        journal: normalized.journal,
        journal_hash: normalized.journal_hash,
        reservation: normalized.maintenance.reservation,
        checked_at: normalized.maintenance.checked_at,
        margin: options.commit_safety_margin_ms,
    };
    execute(context, authority, clock, options, checkpoint)
}
pub struct ResumeSchemaInstallationOptionsV1<'a> {
    pub runtime_root: &'a Path,
    pub state_database_manifest: &'a Value,
    pub writer_manifest: &'a Value,
    pub expected_transition_id: &'a str,
    /// Independently retained original plan hash; never take this pin from the
    /// untrusted progress file being recovered. Node's plannedAt is not signed.
    pub expected_plan_hash: &'a str,
    pub installation: SchemaInstallationOptionsV1<'a>,
}
/// Re-verify the real signed reservation and normalized preimages, then compare
/// every actual database to either its exact pre-state or deterministic post-state.
/// This does not reconstruct or deserialize a Normalized capability from JSON.
pub fn resume_schema_installation_v1<T: MutationAuthorityTransportV1>(
    options: ResumeSchemaInstallationOptionsV1<'_>,
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
    checkpoint: &mut dyn SchemaInstallationCheckpointV1,
) -> Result<InstalledSchemaMaintenanceV1> {
    let inventory =
        inspect_state_database_inventory_v1(options.runtime_root, options.state_database_manifest)?;
    let first = inventory["instances"]
        .as_array()
        .and_then(|v| v.first())
        .ok_or_else(invalid)?;
    let source = SchemaSource::observe(
        options.runtime_root,
        Path::new(text(first, "sourceRelativePath")?),
        text(first, "role")?,
    )?;
    let lock = SchemaMaintenanceLock::acquire(&source)?;
    let repo = NormalizationRepository::open(&lock, false)?;
    let (journal, journal_hash) = repo.load()?.ok_or_else(invalid)?;
    ensure(
        journal["version"].as_f64() == Some(1.)
            && journal["kind"] == "NativeSchemaJournalNormalizationProgress"
            && journal["runtimeRootIdentity"] == *lock.identity()
            && journal["plan"]["transitionId"] == options.expected_transition_id
            && journal["plan"]["planHash"] == options.expected_plan_hash,
        "autonomous_research_online_schema_transition_installation_journal_invalid",
    )?;
    validate_installation_journal(
        &journal,
        options.state_database_manifest,
        options.writer_manifest,
        authority,
    )?;
    validate_installation_inventory(
        &inventory,
        options.state_database_manifest,
        &journal["plan"],
    )?;
    validate_commit_safety_margin(
        options.installation.commit_safety_margin_ms,
        &journal["plan"],
    )?;
    let now = clock.now_millis()?;
    ensure(
        now >= int(&journal, "checkedAtMillis")?
            && timestamp(&journal["plan"]["plannedAt"]).is_some_and(|planned| now >= planned),
        "autonomous_research_online_schema_transition_clock_regressed",
    )?;
    let reservation = authority.verify_schema_transition_reservation(
        &journal["reservation"],
        &journal["request"],
        now,
    )?;
    drop(repo);
    let context = InstallationContext {
        lock,
        manifest: options.state_database_manifest.clone(),
        journal,
        journal_hash,
        reservation,
        checked_at: now,
        margin: options.installation.commit_safety_margin_ms,
    };
    execute(context, authority, clock, options.installation, checkpoint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn commit_safety_margin_matches_node_window_rule() {
        let plan = json!({"requiredExecutionWindowMs": 30_000});
        assert!(validate_commit_safety_margin(1, &plan).is_ok());
        assert!(validate_commit_safety_margin(29_999, &plan).is_ok());
        assert_eq!(
            validate_commit_safety_margin(0, &plan).unwrap_err().code,
            "autonomous_research_online_schema_transition_safety_margin_invalid"
        );
        assert_eq!(
            validate_commit_safety_margin(30_000, &plan)
                .unwrap_err()
                .code,
            "autonomous_research_online_schema_transition_safety_margin_invalid"
        );
        assert_eq!(
            validate_commit_safety_margin(30_001, &plan)
                .unwrap_err()
                .code,
            "autonomous_research_online_schema_transition_safety_margin_invalid"
        );
    }
}

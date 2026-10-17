//! Internal recapture after expected normalization writes. Every newly accepted
//! byte image must project to the exact digest in the real signed reservation.
use super::*;
fn ensure(valid: bool, code: &str) -> Result<()> {
    if valid { Ok(()) } else { Err(error(code)) }
}
use crate::state_database_inventory::schema_source::SchemaSource;

fn inventory_row(inventory: &Value, index: usize) -> Result<&Value> {
    inventory
        .get("instances")
        .and_then(Value::as_array)
        .and_then(|rows| rows.get(index))
        .ok_or_else(invalid)
}

fn is_installed_row(observed: &Value, reserved: &Value) -> bool {
    observed["schemaHash"] == reserved["expectedPostSchemaHash"]
}

/// Re-observe a target-schema source after a prior installation. The original
/// source descriptor intentionally rejects changed bytes, so an installed
/// state must be accepted only through the exact signed identity/path/schema
/// pins and with both SQLite sidecars absent.
fn observe_installed_source(
    plan: &ObservedSchemaTransitionPlanV1,
    index: usize,
    inventory: &Value,
) -> Result<Option<SchemaSource>> {
    let reserved = plan.value["instances"].get(index).ok_or_else(invalid)?;
    let observed = inventory_row(inventory, index)?;
    if !is_installed_row(observed, reserved) {
        return Ok(None);
    }
    let source = SchemaSource::observe(
        &plan.runtime_root,
        Path::new(text(reserved, "sourceRelativePath")?),
        text(reserved, "databaseRole")?,
    )?;
    ensure(
        source.root_matches(plan.first_source()?),
        "autonomous_research_online_schema_transition_runtime_root_identity_changed",
    )?;
    let state = source.normalization_state();
    ensure(
        state["sidecarsPresent"] == false
            && state["sourceFileIdentityHash"] == reserved["sourceFileIdentityHash"]
            && state["sourceSha256"] == observed["sourceSha256"],
        "autonomous_research_online_schema_transition_reserved_normalized_projection_mismatch",
    )?;
    Ok(Some(source))
}

/// Validate the complete physical scope while accepting a database that has
/// already committed the signed target schema. This mirrors the Node oracle's
/// `installedState` branch without weakening the authority or inode pins.
fn current_scope_allow_installed(plan: &ObservedSchemaTransitionPlanV1) -> Result<Value> {
    let inventory = inspect_state_database_inventory_v1(&plan.runtime_root, &plan.manifest)?;
    validate_inventory(&inventory, &plan.manifest)?;
    ensure(
        inventory["databaseScopeHash"] == plan.value["databaseScopeHash"],
        "autonomous_research_online_schema_transition_normalization_scope_changed",
    )?;
    let rows = inventory["instances"].as_array().ok_or_else(invalid)?;
    let expected = plan.value["instances"].as_array().ok_or_else(invalid)?;
    ensure(
        rows.len() == expected.len(),
        "autonomous_research_online_schema_transition_normalization_scope_changed",
    )?;
    for (index, (observed, reserved)) in rows.iter().zip(expected).enumerate() {
        for (a, b) in [
            ("role", "databaseRole"),
            ("instanceId", "databaseInstanceId"),
            ("sourceRelativePath", "sourceRelativePath"),
            ("schemaContractId", "schemaContractId"),
        ] {
            ensure(
                observed[a] == reserved[b],
                "autonomous_research_online_schema_transition_normalization_scope_changed",
            )?;
        }
        ensure(
            observed["schemaHash"] == reserved["preSchemaHash"]
                || observed["schemaHash"] == reserved["expectedPostSchemaHash"],
            "autonomous_research_online_schema_transition_normalization_scope_changed",
        )?;
        if let Some(source) = observe_installed_source(plan, index, &inventory)? {
            source.assert_current()?;
            continue;
        }
        // Non-installed rows may be in the original or normalized physical
        // state while a WAL checkpoint is completing. The full source
        // identity/projection check is performed by `refresh_normalization_scope`
        // below; do not hash the same live file a second time here.
    }
    let final_inventory = inspect_state_database_inventory_v1(&plan.runtime_root, &plan.manifest)?;
    ensure(
        final_inventory == inventory,
        "autonomous_research_online_schema_transition_database_changed_during_simulation",
    )?;
    Ok(inventory)
}

impl ObservedSchemaTransitionPlanV1 {
    pub(in crate::online_schema_execution) fn assert_current_allow_installed(&self) -> Result<()> {
        let inventory = current_scope_allow_installed(self)?;
        if inventory == self.inventory {
            for source in &self.sources {
                source.assert_current()?;
            }
        }
        Ok(())
    }
}

impl ObservedSchemaTransitionPlanV1 {
    pub(in crate::online_schema_execution) fn normalization_root(&self) -> &Path {
        &self.runtime_root
    }
    pub(in crate::online_schema_execution) fn first_source(&self) -> Result<&SchemaSource> {
        self.sources.first().map(|v| &v.source).ok_or_else(invalid)
    }
    pub(in crate::online_schema_execution) fn source_for_step(
        &self,
        index: usize,
    ) -> Result<SchemaSource> {
        let row = self.value["instances"].get(index).ok_or_else(invalid)?;
        let source = SchemaSource::observe(
            &self.runtime_root,
            Path::new(text(row, "sourceRelativePath")?),
            text(row, "databaseRole")?,
        )?;
        ensure(
            source.root_matches(self.first_source()?),
            "autonomous_research_online_schema_transition_runtime_root_identity_changed",
        )?;
        Ok(source)
    }
    pub(in crate::online_schema_execution) fn normalized_record(
        &self,
        index: usize,
    ) -> Result<Option<Value>> {
        let reserved = self.value["instances"].get(index).ok_or_else(invalid)?;
        let source = self.sources.get(index).ok_or_else(invalid)?;
        let state = match source
            .assert_current()
            .map(|_| source.source.normalization_state())
        {
            Ok(state) => state,
            Err(original) => {
                let inventory =
                    inspect_state_database_inventory_v1(&self.runtime_root, &self.manifest)?;
                let Some(installed) = observe_installed_source(self, index, &inventory)? else {
                    return Err(original);
                };
                let state = installed.normalization_state();
                return Ok(Some(json!({
                    "databaseRole":reserved["databaseRole"],
                    "databaseInstanceId":reserved["databaseInstanceId"],
                    "journalPreimageHash":reserved["journalPreimageHash"],
                    "beforeSha256":state["sourceSha256"],
                    "normalizedSha256":state["sourceSha256"],
                    "journalMode":"delete",
                    "sidecarsPresent":false,
                    "alreadyInstalled":true,
                })));
            }
        };
        if state["sidecarsPresent"] != false {
            return Ok(None);
        }
        let inventory = inspect_state_database_inventory_v1(&self.runtime_root, &self.manifest)?;
        if let Some(installed) = observe_installed_source(self, index, &inventory)? {
            let state = installed.normalization_state();
            return Ok(Some(json!({
                "databaseRole":reserved["databaseRole"],
                "databaseInstanceId":reserved["databaseInstanceId"],
                "journalPreimageHash":reserved["journalPreimageHash"],
                "beforeSha256":state["sourceSha256"],
                "normalizedSha256":state["sourceSha256"],
                "journalMode":"delete",
                "sidecarsPresent":false,
                "alreadyInstalled":true,
            })));
        }
        if state["sourceSha256"] != reserved["expectedNormalizedSourceSha256"] {
            return Ok(None);
        }
        Ok(Some(
            json!({"databaseRole":reserved["databaseRole"],"databaseInstanceId":reserved["databaseInstanceId"],"journalPreimageHash":reserved["journalPreimageHash"],"beforeSha256":reserved["sourceSha256"],"normalizedSha256":state["sourceSha256"],"journalMode":"delete","sidecarsPresent":false}),
        ))
    }
    pub(in crate::online_schema_execution) fn refresh_normalization_scope(&mut self) -> Result<()> {
        // A real schema observation remains valid when every held source and
        // sidecar byte/identity is unchanged and the complete actual namespace
        // still contains exactly the registered scope. Never use journal flags.
        let unchanged = (|| -> Result<()> {
            self.first_source()?
                .assert_registered_namespace(&self.manifest, &self.value["instances"])?;
            for source in &self.sources {
                source.assert_current()?;
            }
            self.first_source()?
                .assert_registered_namespace(&self.manifest, &self.value["instances"])?;
            for source in &self.sources {
                source.assert_current()?;
            }
            Ok(())
        })();
        if unchanged.is_ok() {
            return Ok(());
        }
        let before = current_scope_allow_installed(self)?;
        let actual = before["instances"].as_array().ok_or_else(invalid)?;
        let expected = self.value["instances"].as_array().ok_or_else(invalid)?;
        ensure(
            actual.len() == expected.len(),
            "autonomous_research_online_schema_transition_normalization_scope_changed",
        )?;
        let mut sources = Vec::new();
        for (index, (observed, reserved)) in actual.iter().zip(expected).enumerate() {
            for (a, b) in [
                ("role", "databaseRole"),
                ("instanceId", "databaseInstanceId"),
                ("sourceRelativePath", "sourceRelativePath"),
                ("schemaContractId", "schemaContractId"),
            ] {
                ensure(
                    observed[a] == reserved[b],
                    "autonomous_research_online_schema_transition_normalization_scope_changed",
                )?;
            }
            let physical = SchemaSource::observe(
                &self.runtime_root,
                Path::new(text(reserved, "sourceRelativePath")?),
                text(reserved, "databaseRole")?,
            )?;
            if is_installed_row(observed, reserved) {
                let state = physical.normalization_state();
                ensure(
                    state["sidecarsPresent"] == false
                        && state["sourceFileIdentityHash"] == reserved["sourceFileIdentityHash"]
                        && state["sourceSha256"] == observed["sourceSha256"],
                    "autonomous_research_online_schema_transition_reserved_normalized_projection_mismatch",
                )?;
                let mut projection = reserved.clone();
                projection["sourceSha256"] = observed["sourceSha256"].clone();
                let source = ObservedSchemaTransitionSourceV1 {
                    source: physical,
                    projection,
                };
                ensure(
                    source.source.root_matches(self.first_source()?),
                    "autonomous_research_online_schema_transition_runtime_root_identity_changed",
                )?;
                sources.push(source);
                continue;
            }
            ensure(
                observed["schemaHash"] == reserved["preSchemaHash"],
                "autonomous_research_online_schema_transition_normalization_scope_changed",
            )?;
            // Reuse only our own previously computed projection when every real
            // source and sidecar identity/hash is unchanged. Caller progress is
            // never used as a projection cache.
            let previous = self.sources.get(index).ok_or_else(invalid)?;
            let projection =
                if physical.normalization_state() == previous.source.normalization_state() {
                    previous.projection.clone()
                } else {
                    physical.project(&SchemaTransitionTargetV1::for_role(
                        text(reserved, "databaseRole")?,
                        Some(text(&self.value, "plannedAt")?),
                    )?)?
                };
            let source = ObservedSchemaTransitionSourceV1 {
                source: physical,
                projection,
            };
            ensure(
                source.source.root_matches(self.first_source()?),
                "autonomous_research_online_schema_transition_runtime_root_identity_changed",
            )?;
            for key in [
                "sourceFileIdentityHash",
                "preSchemaHash",
                "expectedPostSchemaHash",
                "expectedNormalizedSourceSha256",
            ] {
                ensure(
                    source.value()[key] == reserved[key],
                    "autonomous_research_online_schema_transition_reserved_normalized_projection_mismatch",
                )?;
            }
            ensure(
                source.value()["sourceSha256"] == observed["sourceSha256"],
                "autonomous_research_online_schema_transition_database_changed_during_simulation",
            )?;
            sources.push(source);
        }
        ensure(
            inspect_state_database_inventory_v1(&self.runtime_root, &self.manifest)? == before,
            "autonomous_research_online_schema_transition_database_changed_during_simulation",
        )?;
        for source in &sources {
            source.assert_current()?;
        }
        self.sources = sources;
        self.inventory = before;
        Ok(())
    }
}

pub(in crate::online_schema_execution) fn restore_normalization_plan<
    T: MutationAuthorityTransportV1,
>(
    journal: &Value,
    options: SchemaTransitionPlanOptionsV1<'_>,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<ObservedSchemaTransitionPlanV1> {
    let original = &journal["plan"];
    let mut base = original.clone();
    let object = base.as_object_mut().ok_or_else(invalid)?;
    object.remove("planHash");
    object.remove("transitionId");
    ensure(
        original["planHash"] == hash("AutonomousResearchOnlineSchemaTransitionPlan", &base)?
            && original["transitionId"] == schema_transition_identity_v1(original)?,
        "autonomous_research_online_schema_transition_normalization_journal_invalid",
    )?;
    let planned_at = crate::sqlite_mutation_coordinator::timestamp(&original["plannedAt"])
        .ok_or_else(invalid)?;
    let current =
        inspect_state_database_inventory_v1(options.runtime_root, options.state_database_manifest)?;
    let installed = current["instances"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .zip(original["instances"].as_array().ok_or_else(invalid)?)
        .any(|(observed, reserved)| is_installed_row(observed, reserved));
    let mut fresh = if installed {
        validate_inventory(&current, options.state_database_manifest)?;
        ensure(
            current["databaseScopeHash"] == original["databaseScopeHash"]
                && authority.trust()["databaseScopeHash"] == current["databaseScopeHash"],
            "autonomous_research_online_schema_transition_authority_scope_mismatch",
        )?;
        let mut sources = Vec::new();
        let mut root_identity = None;
        for (index, (observed, reserved)) in current["instances"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .zip(original["instances"].as_array().ok_or_else(invalid)?)
            .enumerate()
        {
            for (a, b) in [
                ("role", "databaseRole"),
                ("instanceId", "databaseInstanceId"),
                ("sourceRelativePath", "sourceRelativePath"),
                ("schemaContractId", "schemaContractId"),
            ] {
                ensure(
                    observed[a] == reserved[b],
                    "autonomous_research_online_schema_transition_normalization_scope_changed",
                )?;
            }
            let physical = SchemaSource::observe(
                options.runtime_root,
                Path::new(text(reserved, "sourceRelativePath")?),
                text(reserved, "databaseRole")?,
            )?;
            if let Some(expected_root) = &root_identity {
                ensure(
                    physical.original_root_identity() == expected_root,
                    "autonomous_research_online_schema_transition_runtime_root_identity_changed",
                )?;
            } else {
                root_identity = Some(physical.original_root_identity().clone());
            }
            let mut projection = reserved.clone();
            if is_installed_row(observed, reserved) {
                ensure(
                    physical.normalization_state()["sidecarsPresent"] == false
                        && physical.normalization_state()["sourceFileIdentityHash"]
                            == reserved["sourceFileIdentityHash"]
                        && physical.normalization_state()["sourceSha256"]
                            == observed["sourceSha256"],
                    "autonomous_research_online_schema_transition_reserved_normalized_projection_mismatch",
                )?;
                projection["sourceSha256"] = observed["sourceSha256"].clone();
            } else {
                ensure(
                    observed["schemaHash"] == reserved["preSchemaHash"],
                    "autonomous_research_online_schema_transition_normalization_scope_changed",
                )?;
                let projected = observe_schema_transition_source_v1(
                    options.runtime_root,
                    Path::new(text(reserved, "sourceRelativePath")?),
                    text(reserved, "databaseRole")?,
                    Some(text(original, "plannedAt")?),
                )?;
                for key in [
                    "sourceFileIdentityHash",
                    "preSchemaHash",
                    "expectedPostSchemaHash",
                    "expectedNormalizedSourceSha256",
                ] {
                    ensure(
                        projected.value()[key] == reserved[key],
                        "autonomous_research_online_schema_transition_reserved_normalized_projection_mismatch",
                    )?;
                }
                sources.push(projected);
                continue;
            }
            sources.push(ObservedSchemaTransitionSourceV1 {
                source: physical,
                projection,
            });
            let _ = index;
        }
        ObservedSchemaTransitionPlanV1 {
            value: original.clone(),
            runtime_root: std::fs::canonicalize(options.runtime_root).map_err(|_| {
                error("autonomous_research_online_schema_transition_runtime_root_identity_invalid")
            })?,
            manifest: options.state_database_manifest.clone(),
            inventory: current,
            sources,
            authority_configuration_hash: authority.configuration_hash().to_owned(),
        }
    } else {
        build_schema_transition_plan_v1(options, authority, &mut || Ok(planned_at))?
    };
    for key in [
        "version",
        "kind",
        "protocol",
        "scopeId",
        "databaseScopeHash",
        "writerManifestHash",
        "stateDatabaseManifestHash",
        "schemaBundleHash",
        "authorityJournalSchemaContractId",
        "authorityJournalSchemaHash",
        "markerSchemaHash",
        "requestedLeaseMs",
        "requiredExecutionWindowMs",
        "transitionMode",
        "sourceWriterManifestHash",
        "prePristineRuntimeStateHash",
    ] {
        ensure(
            fresh.value[key] == original[key],
            "autonomous_research_online_schema_transition_normalization_journal_plan_mismatch",
        )?;
    }
    let observed = fresh.value["instances"].as_array().ok_or_else(invalid)?;
    let reserved = original["instances"].as_array().ok_or_else(invalid)?;
    ensure(
        observed.len() == reserved.len(),
        "autonomous_research_online_schema_transition_normalization_journal_plan_mismatch",
    )?;
    for (a, b) in observed.iter().zip(reserved) {
        for key in [
            "databaseRole",
            "databaseInstanceId",
            "sourceRelativePath",
            "preSchemaContractId",
            "schemaContractId",
            "prePristineStateHash",
            "preSchemaHash",
            "expectedPostSchemaHash",
            "sourceFileIdentityHash",
            "expectedNormalizedSourceSha256",
        ] {
            ensure(
                a[key] == b[key],
                "autonomous_research_online_schema_transition_reserved_normalized_projection_mismatch",
            )?;
        }
    }
    ensure(
        fresh.first_source()?.original_root_identity() == &journal["runtimeRootIdentity"],
        "autonomous_research_online_schema_transition_runtime_root_identity_changed",
    )?;
    fresh.value = original.clone();
    let request = fresh.reserve_request(authority, text(&journal["request"], "requestedAt")?)?;
    ensure(
        request == journal["request"],
        "autonomous_research_online_schema_transition_normalization_journal_request_mismatch",
    )?;
    if installed {
        fresh.assert_current_allow_installed()?;
    } else {
        fresh.assert_current()?;
    }
    Ok(fresh)
}

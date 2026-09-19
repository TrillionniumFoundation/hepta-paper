//! Internal recapture after expected normalization writes. Every newly accepted
//! byte image must project to the exact digest in the real signed reservation.
use super::*;
fn ensure(valid: bool, code: &str) -> Result<()> {
    if valid { Ok(()) } else { Err(error(code)) }
}
use crate::state_database_inventory::schema_source::SchemaSource;

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
        let state = source.source.normalization_state();
        source.assert_current()?;
        if state["sidecarsPresent"] != false
            || state["sourceSha256"] != reserved["expectedNormalizedSourceSha256"]
        {
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
        let before = inspect_state_database_inventory_v1(&self.runtime_root, &self.manifest)?;
        validate_inventory(&before, &self.manifest)?;
        ensure(
            before["databaseScopeHash"] == self.value["databaseScopeHash"],
            "autonomous_research_online_schema_transition_normalization_scope_changed",
        )?;
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
                ("schemaHash", "preSchemaHash"),
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
    let mut fresh = build_schema_transition_plan_v1(options, authority, &mut || Ok(planned_at))?;
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
    fresh.assert_current()?;
    Ok(fresh)
}

//! Full registered-scope local planning. The plan is still not maintenance
//! authority: actual external reservation verification is a separate step.
use super::*;
use crate::{
    online_schema_transition::target_schema::schema_transition_bundle_hash_v1,
    pristine_runtime_state::{PinnedMachineGenesisDocumentsV1, pristine_runtime_state_hash_v1},
    sqlite_mutation_coordinator::{
        DATABASE_ROLES,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock::{MutationClockV1, iso},
        contracts::schema_transition::*,
        error, hash,
        manifest::writer_manifest_hash_v1,
        text,
    },
    state_backup_authority::manifest::{
        state_database_manifest_hash_v1, state_database_scope_hash_v1,
    },
    state_database_inventory::inspect_state_database_inventory_v1,
};
use serde_json::json;
use std::{collections::BTreeSet, path::PathBuf};

pub struct SchemaTransitionPlanOptionsV1<'a> {
    pub runtime_root: &'a Path,
    pub state_database_manifest: &'a Value,
    pub writer_manifest: &'a Value,
    pub requested_lease_ms: i64,
    pub required_execution_window_ms: i64,
    pub expected_pre_rebind_pristine_runtime_state_hash: Option<&'a str>,
    pub machine_genesis: Option<&'a PinnedMachineGenesisDocumentsV1>,
}
/// Local planning is based on real registered files, not a caller inventory.
/// This private-field object cannot be deserialized or authorize source writes.
pub struct ObservedSchemaTransitionPlanV1 {
    value: Value,
    runtime_root: PathBuf,
    manifest: Value,
    inventory: Value,
    sources: Vec<ObservedSchemaTransitionSourceV1>,
    authority_configuration_hash: String,
}
impl ObservedSchemaTransitionPlanV1 {
    pub fn value(&self) -> &Value {
        &self.value
    }
    pub fn authority_configuration_hash(&self) -> &str {
        &self.authority_configuration_hash
    }
    pub fn assert_current(&self) -> Result<()> {
        for source in &self.sources {
            source.assert_current()?;
        }
        if inspect_state_database_inventory_v1(&self.runtime_root, &self.manifest)?
            != self.inventory
        {
            return Err(error(
                "autonomous_research_online_schema_transition_database_changed_during_simulation",
            ));
        }
        for source in &self.sources {
            source.assert_current()?;
        }
        Ok(())
    }
    /// A request value has no authority until a pinned client checks the actual
    /// signed response. This also validates lease parameters against that trust.
    pub fn reserve_request<T: MutationAuthorityTransportV1>(
        &self,
        authority: &PinnedMutationAuthorityV1<T>,
        requested_at: &str,
    ) -> Result<Value> {
        if authority.configuration_hash() != self.authority_configuration_hash {
            return Err(error(
                "autonomous_research_online_schema_transition_authority_configuration_mismatch",
            ));
        }
        let mut request = self.value.clone();
        let map = request.as_object_mut().ok_or_else(invalid)?;
        map.remove("planHash");
        map.remove("plannedAt");
        map.insert(
            "kind".into(),
            json!("AutonomousResearchOnlineSchemaTransitionReserveRequest"),
        );
        map.insert("requestedAt".into(), json!(requested_at));
        // prePristineRuntimeStateHash is a v2 request field only.
        if map.get("version") == Some(&json!(1)) {
            map.remove("prePristineRuntimeStateHash");
        }
        assert_schema_transition_reserve_request_v1(&request, authority.trust())?;
        Ok(request)
    }
}
/// Read-only exact pre-rebind observation for an independently selected review
/// pin. It retains the same source descriptors/inventory as the real planner and
/// cannot be deserialized into a plan or reservation.
pub struct ObservedSchemaTransitionPristinePreimageV1 {
    value: Value,
    runtime_root: PathBuf,
    manifest: Value,
    inventory: Value,
    sources: Vec<ObservedSchemaTransitionSourceV1>,
    authority_configuration_hash: String,
}
impl ObservedSchemaTransitionPristinePreimageV1 {
    pub fn value(&self) -> &Value {
        &self.value
    }
    pub fn assert_current<T: MutationAuthorityTransportV1>(
        &self,
        authority: &PinnedMutationAuthorityV1<T>,
    ) -> Result<()> {
        if authority.configuration_hash() != self.authority_configuration_hash {
            return Err(error(
                "autonomous_research_online_schema_transition_authority_configuration_mismatch",
            ));
        }
        for source in &self.sources {
            source.assert_current()?;
        }
        if inspect_state_database_inventory_v1(&self.runtime_root, &self.manifest)?
            != self.inventory
        {
            return Err(error(
                "autonomous_research_online_schema_transition_database_changed_during_simulation",
            ));
        }
        for source in &self.sources {
            source.assert_current()?;
        }
        Ok(())
    }
}

struct ObservedPlanInputsV1 {
    runtime_root: PathBuf,
    manifest: Value,
    inventory: Value,
    manifest_hash: String,
    writer_hash: String,
    source_writer_hash: String,
    rebind: bool,
    planned_at: String,
    sources: Vec<ObservedSchemaTransitionSourceV1>,
    instances: Vec<Value>,
    pre_pristine_runtime: String,
    authority_configuration_hash: String,
}

fn observe_plan_inputs_v1<T: MutationAuthorityTransportV1>(
    options: &SchemaTransitionPlanOptionsV1<'_>,
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
) -> Result<ObservedPlanInputsV1> {
    let inventory =
        inspect_state_database_inventory_v1(options.runtime_root, options.state_database_manifest)?;
    validate_inventory(&inventory, options.state_database_manifest)?;
    let manifest_hash = state_database_manifest_hash_v1(options.state_database_manifest)?;
    let writer_hash = writer_manifest_hash_v1(options.writer_manifest)?;
    let trust = authority.trust();
    if trust["databaseScopeHash"] != inventory["databaseScopeHash"] {
        return Err(error(
            "autonomous_research_online_schema_transition_authority_scope_mismatch",
        ));
    }
    let source_writer_hash = text(trust, "writerManifestHash")?.to_owned();
    let rebind = source_writer_hash != writer_hash;
    let planned_at = iso(clock.now_millis()?)?;
    let mut sources = Vec::new();
    let mut instances = Vec::new();
    let mut pristine = Vec::new();
    for instance in inventory["instances"].as_array().ok_or_else(invalid)? {
        let role = text(instance, "role")?;
        let source = observe_schema_transition_source_v1(
            options.runtime_root,
            Path::new(text(instance, "sourceRelativePath")?),
            role,
            Some(&planned_at),
        )?;
        if source.value()["preSchemaHash"] != instance["schemaHash"]
            || source.value()["sourceSha256"] != instance["sourceSha256"]
        {
            return Err(error(
                "autonomous_research_online_schema_transition_database_changed_during_simulation",
            ));
        }
        let (pre_contract, pre_pristine) = if rebind {
            let inspection = source.source.pristine_preimage(
                instance,
                &inventory["databaseScopeHash"],
                &trust["writerManifestHash"],
                &manifest_hash,
                options.machine_genesis,
            )?;
            let result = (
                inspection.value()["schemaContractId"].clone(),
                inspection.value()["pristineStateHash"].clone(),
            );
            pristine.push(inspection);
            result
        } else {
            (
                instance["schemaContractId"].clone(),
                json!(hash(
                    "AutonomousResearchInitialSchemaTransitionPristineStateNotApplicable",
                    &json!({"databaseInstanceId":instance["instanceId"]})
                )?),
            )
        };
        let mut row = json!({"databaseRole":role,"databaseInstanceId":instance["instanceId"],"sourceRelativePath":instance["sourceRelativePath"],"preSchemaContractId":pre_contract,"schemaContractId":instance["schemaContractId"],"prePristineStateHash":pre_pristine});
        for key in [
            "preSchemaHash",
            "expectedPostSchemaHash",
            "sourceSha256",
            "sourceFileIdentityHash",
            "journalPreimageHash",
            "expectedNormalizedSourceSha256",
        ] {
            row[key] = source.value()[key].clone();
        }
        instances.push(row);
        sources.push(source);
    }
    let pre_pristine_runtime = if rebind {
        pristine_runtime_state_hash_v1(&pristine)?
    } else {
        hash(
            "AutonomousResearchInitialSchemaTransitionPristineStateNotApplicable",
            &json!({"databaseScopeHash":inventory["databaseScopeHash"]}),
        )?
    };
    Ok(ObservedPlanInputsV1 {
        runtime_root: std::fs::canonicalize(options.runtime_root).map_err(|_| {
            error("autonomous_research_online_schema_transition_runtime_root_identity_invalid")
        })?,
        manifest: options.state_database_manifest.clone(),
        inventory,
        manifest_hash,
        writer_hash,
        source_writer_hash,
        rebind,
        planned_at,
        sources,
        instances,
        pre_pristine_runtime,
        authority_configuration_hash: authority.configuration_hash().to_owned(),
    })
}

/// Observe the exact v2 pristine preimage without creating a plan, request,
/// reservation or control file. A second invocation must independently pin the
/// returned hash before `build_schema_transition_plan_v1` can succeed.
pub fn inspect_schema_transition_pristine_preimage_v1<T: MutationAuthorityTransportV1>(
    options: SchemaTransitionPlanOptionsV1<'_>,
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
) -> Result<ObservedSchemaTransitionPristinePreimageV1> {
    let observed = observe_plan_inputs_v1(&options, authority, clock)?;
    if !observed.rebind {
        return Err(error(
            "autonomous_research_pristine_schema_rebind_not_required",
        ));
    }
    let value = json!({
        "version": 1,
        "kind": "AutonomousResearchPristineSchemaRebindPreimageObservation",
        "status": "autonomous_research_pristine_schema_rebind_review_required",
        "databaseScopeHash": observed.inventory["databaseScopeHash"],
        "inventoryStatus": observed.inventory["status"],
        "inventoryHash": observed.inventory["inventoryHash"],
        "inventoryBlockers": observed.inventory["blockers"],
        "stateDatabaseManifestHash": observed.manifest_hash,
        "sourceWriterManifestHash": observed.source_writer_hash,
        "writerManifestHash": observed.writer_hash,
        "prePristineRuntimeStateHash": observed.pre_pristine_runtime,
        "instanceCount": observed.instances.len(),
        "plannedAt": observed.planned_at,
        "mutationPerformed": false,
        "authorityInvoked": false,
        "executionAuthority": false,
        "releaseAuthority": false,
        "submissionAuthority": false,
        "productionActivation": false,
        "nodeRetirement": false,
    });
    let result = ObservedSchemaTransitionPristinePreimageV1 {
        value,
        runtime_root: observed.runtime_root,
        manifest: observed.manifest,
        inventory: observed.inventory,
        sources: observed.sources,
        authority_configuration_hash: observed.authority_configuration_hash,
    };
    result.assert_current(authority)?;
    Ok(result)
}

fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_online_schema_transition_inventory_invalid")
}
fn target_names() -> Result<BTreeSet<String>> {
    let mut result = BTreeSet::new();
    for role in ["native-store", "resident-instance", "submission-handoff"] {
        let value = SchemaTransitionTargetV1::for_role(role, None)?.value();
        for pair in value["objects"].as_array().ok_or_else(invalid)? {
            result.insert(pair[0].as_str().ok_or_else(invalid)?.to_owned());
        }
    }
    Ok(result)
}
fn validate_inventory(inventory: &Value, manifest: &Value) -> Result<()> {
    let rows = inventory["instances"].as_array().ok_or_else(invalid)?;
    let blockers = inventory["blockers"].as_array().ok_or_else(invalid)?;
    let names = target_names()?;
    let roles = rows
        .iter()
        .map(|v| text(v, "role"))
        .collect::<Result<BTreeSet<_>>>()?;
    let ids = rows
        .iter()
        .map(|v| text(v, "instanceId"))
        .collect::<Result<BTreeSet<_>>>()?;
    if rows.len() != DATABASE_ROLES.len()
        || roles != DATABASE_ROLES.iter().copied().collect()
        || ids.len() != rows.len()
        || !rows
            .windows(2)
            .all(|v| v[0]["instanceId"].as_str() < v[1]["instanceId"].as_str())
        || inventory["manifestId"] != "hepta-paper-autonomous-research-state-databases-v1"
        || inventory["manifestHash"] != state_database_manifest_hash_v1(manifest)?
        || inventory["databaseScopeHash"] != state_database_scope_hash_v1(&inventory["instances"])?
    {
        return Err(invalid());
    }
    for blocker in blockers {
        let blocker = blocker.as_str().ok_or_else(invalid)?;
        let allowed = rows.iter().any(|row| {
            let prefix = format!(
                "autonomous_research_state_database_schema_contract_mismatch:{}:{}:",
                row["instanceId"].as_str().unwrap_or_default(),
                row["schemaContractId"].as_str().unwrap_or_default()
            );
            blocker.starts_with(&prefix)
                && row["missingSchemaObjects"]
                    .as_array()
                    .is_some_and(|missing| {
                        !missing.is_empty()
                            && missing.iter().all(|v| {
                                v.as_str()
                                    .and_then(|s| s.split_once(':'))
                                    .is_some_and(|(_, name)| names.contains(name))
                            })
                    })
        });
        if !allowed {
            return Err(invalid());
        }
    }
    for row in rows {
        let definition = manifest["databases"]
            .as_array()
            .and_then(|rows| rows.iter().find(|v| v["role"] == row["role"]))
            .ok_or_else(invalid)?;
        let objects = row["schemaObjects"].as_array().ok_or_else(invalid)?;
        if row["quickCheck"] != "ok"
            || row["foreignKeyViolationCount"].as_f64() != Some(0.)
            || definition["requiredSchemaObjects"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .any(|v| {
                    v.as_str()
                        .and_then(|s| s.split_once(':'))
                        .is_none_or(|(_, name)| !names.contains(name) && !objects.contains(v))
                })
        {
            return Err(error(
                "autonomous_research_online_schema_transition_business_schema_not_preprovisioned",
            ));
        }
    }
    Ok(())
}
/// Builds both initial v1 and pristine-rebind v2 plans from actual inventory and
/// fixed DDL. A pinned authority supplies the subject, not a caller trust JSON.
pub fn build_schema_transition_plan_v1<T: MutationAuthorityTransportV1>(
    options: SchemaTransitionPlanOptionsV1<'_>,
    authority: &PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
) -> Result<ObservedSchemaTransitionPlanV1> {
    let observed = observe_plan_inputs_v1(&options, authority, clock)?;
    if observed.rebind
        && options.expected_pre_rebind_pristine_runtime_state_hash
            != Some(observed.pre_pristine_runtime.as_str())
    {
        return Err(error(
            "autonomous_research_pristine_schema_rebind_expected_state_mismatch",
        ));
    }
    let inventory = observed.inventory;
    let manifest_hash = observed.manifest_hash;
    let writer_hash = observed.writer_hash;
    let rebind = observed.rebind;
    let planned_at = observed.planned_at;
    let sources = observed.sources;
    let instances = observed.instances;
    let pre_pristine_runtime = observed.pre_pristine_runtime;
    let trust = authority.trust();
    let data: Value =
        serde_json::from_str(include_str!("../online_schema_transition/schema_data.json"))
            .map_err(|e| error(e.to_string()))?;
    let journal_hash = hash(
        "AutonomousResearchOnlineAuthorityJournalSchema",
        &json!({"version":data["version"],"contractId":data["contractId"],"statements":data["journal"]}),
    )?;
    let marker_hash = hash(
        "AutonomousResearchOnlineMutationMarkerSchema",
        &json!({"version":1,"protocol":"external-linearizable-reserve-apply-finalize-v1","statements":data["marker"]}),
    )?;
    let mut base = json!({"version":if rebind{2}else{1},"kind":"AutonomousResearchOnlineSchemaTransitionPlan","protocol":if rebind{PRISTINE_SCHEMA_REBIND_PROTOCOL_V2}else{SCHEMA_TRANSITION_PROTOCOL_V1},"scopeId":trust["scopeId"],"databaseScopeHash":inventory["databaseScopeHash"],"writerManifestHash":writer_hash,"stateDatabaseManifestHash":manifest_hash,"schemaBundleHash":schema_transition_bundle_hash_v1()?,"authorityJournalSchemaContractId":data["contractId"],"authorityJournalSchemaHash":journal_hash,"markerSchemaHash":marker_hash,"instances":instances,"plannedAt":planned_at,"requestedLeaseMs":options.requested_lease_ms,"requiredExecutionWindowMs":options.required_execution_window_ms});
    if rebind {
        base["transitionMode"] = json!("pristine-finalized-writer-manifest-rebind");
        base["sourceWriterManifestHash"] = trust["writerManifestHash"].clone();
        base["prePristineRuntimeStateHash"] = json!(pre_pristine_runtime);
    }
    base["transitionInventoryHash"] = json!(schema_transition_inventory_hash_v1(&base)?);
    let plan_hash = hash("AutonomousResearchOnlineSchemaTransitionPlan", &base)?;
    base["transitionId"] = json!(schema_transition_identity_v1(&base)?);
    base["planHash"] = json!(plan_hash);
    let result = ObservedSchemaTransitionPlanV1 {
        value: base,
        runtime_root: std::fs::canonicalize(options.runtime_root).map_err(|_| {
            error("autonomous_research_online_schema_transition_runtime_root_identity_invalid")
        })?,
        manifest: options.state_database_manifest.clone(),
        inventory,
        sources,
        authority_configuration_hash: authority.configuration_hash().to_owned(),
    };
    result.reserve_request(authority, &planned_at)?;
    result.assert_current()?;
    Ok(result)
}

pub(in crate::online_schema_execution) mod normalization_support;

pub(crate) mod installation_support;

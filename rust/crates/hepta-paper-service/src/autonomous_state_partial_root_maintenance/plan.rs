use super::*;
use crate::{
    autonomous_state_provision::schema,
    machine_intake::configuration::verify_configuration_v2,
    online_schema_transition::target_schema::SchemaTransitionTargetV1,
    state_database_inventory::{
        inspect_state_database_inventory_v1, with_database_effective_snapshot_path_v1,
    },
    topic_producer_profile::{
        TopicProducerProfileReadOptionsV1, read_autonomous_research_topic_producer_profile_v1,
    },
};
use rusqlite::{Connection, OpenFlags, types::ValueRef};

pub(crate) struct PlanState {
    pub plan: Value,
    pub manifest: Value,
    pub machine: Value,
    pub topic: Value,
}

fn target_objects(role: &str) -> Result<BTreeSet<String>> {
    let target = SchemaTransitionTargetV1::for_role(role, None).map_err(|cause| {
        error(format!(
            "autonomous_state_partial_root_target_schema:{cause}"
        ))
    })?;
    let value = target.value();
    let mut result = BTreeSet::new();
    for row in value["objects"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_target_schema_invalid"))?
    {
        let pair = row
            .as_array()
            .ok_or_else(|| error("autonomous_state_partial_root_target_schema_invalid"))?;
        let object = pair
            .get(1)
            .ok_or_else(|| error("autonomous_state_partial_root_target_schema_invalid"))?;
        let kind = object["type"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_target_schema_invalid"))?;
        let name = object["name"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_target_schema_invalid"))?;
        result.insert(format!("{kind}:{name}"));
    }
    Ok(result)
}

pub(crate) fn expected_missing(role: &str, definition: &Value) -> Result<Vec<String>> {
    let targets = target_objects(role)?;
    let mut result = definition["requiredSchemaObjects"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_manifest_invalid"))?
        .iter()
        .filter_map(Value::as_str)
        .filter(|entry| targets.contains(*entry))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if role == "supervisor-state" {
        result.extend([
            "index:idx_autonomous_research_supervisor_external_action_history".to_owned(),
            "index:idx_autonomous_research_supervisor_external_action_one_active".to_owned(),
            "table:autonomous_research_supervisor_external_action_journal".to_owned(),
        ]);
    }
    result.sort();
    result.dedup();
    Ok(result)
}

pub(crate) fn no_sidecars(path: &Path, role: &str) -> Result<()> {
    for suffix in ["-wal", "-shm", "-journal"] {
        if fs::symlink_metadata(PathBuf::from(format!("{}{}", path.display(), suffix))).is_ok() {
            return Err(error(format!(
                "autonomous_state_partial_root_sidecar_forbidden:{role}:{suffix}"
            )));
        }
    }
    Ok(())
}

pub(crate) fn canonical_partial_inventory(runtime: &Path, manifest: &Value) -> Result<Value> {
    let report = inspect_state_database_inventory_v1(runtime, manifest)
        .map_err(|cause| error(format!("autonomous_state_partial_root_inventory:{cause}")))?;
    let instances = report["instances"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_inventory_invalid"))?;
    let mut roles = instances
        .iter()
        .filter_map(|row| row["role"].as_str())
        .collect::<Vec<_>>();
    roles.sort_unstable();
    if roles != EXISTING_ROLES {
        return Err(error("autonomous_state_partial_root_role_closure_invalid"));
    }
    let definitions = manifest["databases"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_manifest_invalid"))?;
    let mut expected_blockers = MISSING_ROLES
        .iter()
        .map(|role| format!("autonomous_research_state_database_required_missing:{role}"))
        .collect::<Vec<_>>();
    for instance in instances {
        let role = instance["role"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_inventory_invalid"))?;
        let definition = definitions
            .iter()
            .find(|row| row["role"] == role)
            .ok_or_else(|| error("autonomous_state_partial_root_manifest_invalid"))?;
        let mut missing = instance["missingSchemaObjects"]
            .as_array()
            .ok_or_else(|| error("autonomous_state_partial_root_inventory_invalid"))?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        missing.sort();
        if missing != expected_missing(role, definition)?
            || instance["quickCheck"] != "ok"
            || instance["foreignKeyViolationCount"].as_i64() != Some(0)
        {
            return Err(error(format!(
                "autonomous_state_partial_root_schema_gap_invalid:{role}"
            )));
        }
        let relative = instance["sourceRelativePath"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_inventory_invalid"))?;
        no_sidecars(&runtime.join(relative), role)?;
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
        .ok_or_else(|| error("autonomous_state_partial_root_inventory_invalid"))?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    blockers.sort();
    if blockers != expected_blockers
        || !valid_hash(report["databaseScopeHash"].as_str().unwrap_or(""))
    {
        return Err(error(
            "autonomous_state_partial_root_inventory_blockers_invalid",
        ));
    }
    Ok(report)
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub(crate) fn business_state_hash(path: &Path, role: &str) -> Result<String> {
    let database = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let result = business_state_hash_connection(&database, role);
    database.close().map_err(|(_, cause)| cause)?;
    result
}

pub(crate) fn business_state_hash_connection(database: &Connection, role: &str) -> Result<String> {
    let targets = target_objects(role)?;
    let ignored = targets
        .iter()
        .filter_map(|entry| entry.strip_prefix("table:"))
        .collect::<BTreeSet<_>>();
    let mut statement = database.prepare(
        "SELECT name,coalesce(sql,'') FROM sqlite_schema \
         WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let tables = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut projection = Vec::new();
    for (name, sql) in tables {
        if ignored.contains(name.as_str())
            || (role == "supervisor-state"
                && name == "autonomous_research_supervisor_external_action_journal")
        {
            continue;
        }
        let query = format!("SELECT * FROM {} ORDER BY rowid", quote_identifier(&name));
        let fallback = format!("SELECT * FROM {}", quote_identifier(&name));
        let mut statement = database
            .prepare(&query)
            .or_else(|_| database.prepare(&fallback))?;
        let columns = statement.column_count();
        if columns > 256 {
            return Err(error("autonomous_state_partial_root_business_state_bound"));
        }
        let mut rows = statement.query([])?;
        let mut values = Vec::new();
        while let Some(row) = rows.next()? {
            if values.len() >= 1_000_000 {
                return Err(error("autonomous_state_partial_root_business_state_bound"));
            }
            let mut cells = Vec::with_capacity(columns);
            for index in 0..columns {
                cells.push(match row.get_ref(index)? {
                    ValueRef::Null => json!(["null"]),
                    ValueRef::Integer(value) => json!(["integer", value]),
                    ValueRef::Real(value) => {
                        json!(["realBits", format!("{:016x}", value.to_bits())])
                    }
                    ValueRef::Text(value) => json!(["textHex", hex::encode(value)]),
                    ValueRef::Blob(value) => json!(["blobHex", hex::encode(value)]),
                });
            }
            values.push(json!(cells));
        }
        projection.push(json!({
            "name":name,
            "schemaHash":hash_bytes(sql.as_bytes()),
            "rows":values
        }));
    }
    record_hash(
        "AutonomousResearchStatePartialRootBusinessState",
        &json!(projection),
    )
}

fn plan_instances(runtime: &Path, inventory: &Value) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    for instance in inventory["instances"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_partial_root_inventory_invalid"))?
    {
        let role = instance["role"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_inventory_invalid"))?;
        let relative = instance["sourceRelativePath"]
            .as_str()
            .ok_or_else(|| error("autonomous_state_partial_root_inventory_invalid"))?;
        let state =
            with_database_effective_snapshot_path_v1(runtime, Path::new(relative), role, |path| {
                business_state_hash(path, role).map_err(|cause| cause.0)
            })
            .map_err(|cause| {
                error(format!(
                    "autonomous_state_partial_root_business_state:{cause}"
                ))
            })?;
        let mut value = instance.clone();
        value["businessStateHash"] = json!(state);
        result.push(value);
    }
    result.sort_by(|a, b| a["instanceId"].as_str().cmp(&b["instanceId"].as_str()));
    Ok(result)
}

fn full_policy(options: &AutonomousStatePartialRootMaintenanceOptions) -> Result<Value> {
    let mut policy = json!({
        "version":1,
        "kind":"RuntimeReproducibilityRefreshPolicy",
        "budgetEpochMs":86_400_000,
        "maximumAttemptsPerEpoch":options.maximum_attempts_per_epoch,
        "maximumCostUsdPerEpoch":options.maximum_cost_usd_per_epoch,
        "leaseMs":600_000,
        "baseBackoffMs":30_000,
        "maximumBackoffMs":300_000,
        "renewalLeadMs":3_600_000,
        "actionSafetyMarginMs":900_000
    });
    policy["runtimeReproducibilityRefreshPolicyHash"] =
        json!(record_hash("RuntimeReproducibilityRefreshPolicy", &policy,)?);
    Ok(policy)
}

fn validated_inputs(
    options: &AutonomousStatePartialRootMaintenanceOptions,
) -> Result<(Value, Value)> {
    let machine_snapshot = Snapshot::read(&options.machine_intake_config).map_err(|_| {
        error("autonomous_state_partial_root_machine_intake_config_identity_invalid")
    })?;
    let machine: Value = serde_json::from_slice(&machine_snapshot.bytes)?;
    if !verify_configuration_v2(&machine) {
        return Err(error(
            "autonomous_state_partial_root_machine_configuration_invalid",
        ));
    }
    let topic_snapshot = Snapshot::read(&options.topic_producer_profile).map_err(|_| {
        error("autonomous_state_partial_root_topic_producer_profile_identity_invalid")
    })?;
    let topic: Value = serde_json::from_slice(&topic_snapshot.bytes)?;
    let environment = BTreeMap::new();
    let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let working_directory =
        std::env::current_dir().map_err(|_| error("autonomous_state_partial_root_cwd_invalid"))?;
    let owner =
        read_autonomous_research_topic_producer_profile_v1(&TopicProducerProfileReadOptionsV1 {
            profile_path: Some(&options.topic_producer_profile),
            dataset_root: Some(&options.dataset_root),
            repository_root: &repository_root,
            working_directory: &working_directory,
            environment: &environment,
            expected_profile_hash: machine["machineProducerProfileHash"].as_str(),
            expected_provider_configuration_hash: topic["providerConfigurationHash"].as_str(),
        })
        .map_err(|_| error("autonomous_state_partial_root_topic_or_dataset_invalid"))?;
    if owner.identity()["producerProfile"] != topic {
        return Err(error("autonomous_state_partial_root_topic_changed"));
    }
    machine_snapshot
        .assert_current()
        .map_err(|_| error("autonomous_state_partial_root_machine_intake_config_changed"))?;
    topic_snapshot
        .assert_current()
        .map_err(|_| error("autonomous_state_partial_root_topic_producer_profile_changed"))?;
    owner
        .assert_current()
        .map_err(|_| error("autonomous_state_partial_root_topic_or_dataset_changed"))?;
    Ok((machine, topic))
}

pub(crate) fn build(options: &AutonomousStatePartialRootMaintenanceOptions) -> Result<PlanState> {
    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let runtime = options.runtime_root.clone();
    let rescue = options.rescue_root.clone();
    let runtime_meta = safe_root(&runtime, "runtime_root")?;
    let rescue_meta = safe_root(&rescue, "rescue_root")?;
    if runtime.starts_with(&rescue)
        || rescue.starts_with(&runtime)
        || runtime_meta.dev() != rescue_meta.dev()
    {
        return Err(error("autonomous_state_partial_root_rescue_root_invalid"));
    }
    let manifest = manifest(&workspace_root)?;
    let inventory = canonical_partial_inventory(&runtime, &manifest)?;
    let (machine, topic) = validated_inputs(options)?;
    let policy = full_policy(options)?;
    let writer_manifest = state_backup_writer_manifest_v1()
        .map_err(|_| error("autonomous_state_partial_root_writer_manifest_invalid"))?;
    let writer_hash = writer_manifest_hash_v1(&writer_manifest)
        .map_err(|_| error("autonomous_state_partial_root_writer_manifest_invalid"))?;
    let quiescence = receipt(
        &runtime,
        &options.writer_quiescence_receipt,
        inventory["databaseScopeHash"].as_str().unwrap_or(""),
        &writer_hash,
    )?;
    let cost = topic["maximumProviderCanaryCostUsdPerUtcDay"]
        .as_f64()
        .ok_or_else(|| error("autonomous_state_partial_root_topic_invalid"))?
        / topic["maximumProviderCanaryAttemptsPerUtcDay"]
            .as_f64()
            .ok_or_else(|| error("autonomous_state_partial_root_topic_invalid"))?;
    if !cost.is_finite() || cost <= 0.0 {
        return Err(error("autonomous_state_partial_root_topic_invalid"));
    }
    let maintenance_identity = json!({
        "nativeSchemaBundleHash":schema::bundle_hash().map_err(|cause| error(cause.0))?,
        "machineIntakeConfigurationHash":machine["configurationHash"],
        "machineIntakeGenesisAuthorityMode":"root-owned-configuration",
        "providerCanaryPairMaximumCostUsd":cost,
        "providerConfigurationHash":topic["providerConfigurationHash"],
        "runtimeReproducibilityRefreshPolicyHash":policy["runtimeReproducibilityRefreshPolicyHash"],
        "topicProducerProfileHash":topic["producerProfileHash"],
        "writerManifestHash":writer_hash,
    });
    let instances = plan_instances(&runtime, &inventory)?;
    let mut payload = json!({
        "version":1,
        "kind":"AutonomousResearchStatePartialRootMaintenancePlan",
        "status":"autonomous_research_state_partial_root_maintenance_plan_ready",
        "ready":true,
        "protocol":"offline-partial-native-root-pre-transition-business-repair-v1",
        "runtimeRoot":runtime,
        "rescueRoot":rescue,
        "stateDatabaseManifestHash":record_hash("AutonomousResearchStateDatabaseManifest",&manifest)?,
        "databaseScopeHash":inventory["databaseScopeHash"],
        "existingRoles":EXISTING_ROLES,
        "missingRoles":MISSING_ROLES,
        "instances":instances,
        "maintenanceIdentity":maintenance_identity,
        "writerQuiescenceReceiptHash":quiescence["receiptHash"],
        "writerQuiescenceObservedAt":quiescence["observedAt"],
        "rescueBundleAndCopyRestoreVerificationRequired":true,
        "exclusiveDatabaseLocksRequired":true,
        "onlineSchemaTransitionRequired":true,
        "externalAuthorityInvocationAllowed":false,
        "sqliteSchemaAndBusinessStateVerified":true,
        "writerLeaseStateVerified":true,
        "configurationSemanticIdentityVerified":true,
        "runtimeReproducibilityPolicy":policy,
    });
    payload["maintenancePlanId"] = json!(record_hash(
        "AutonomousResearchStatePartialRootMaintenancePlan",
        &payload,
    )?);
    Ok(PlanState {
        plan: payload,
        manifest,
        machine,
        topic,
    })
}

pub(crate) fn assert_selected_current(
    options: &AutonomousStatePartialRootMaintenanceOptions,
    selected: &Value,
) -> Result<()> {
    let current = build(options)?;
    if current.plan != *selected {
        return Err(error("autonomous_state_partial_root_plan_changed"));
    }
    Ok(())
}

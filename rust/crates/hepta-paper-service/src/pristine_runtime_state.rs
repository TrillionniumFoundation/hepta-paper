//! Actual local SQLite pristine observations. These are historical read snapshots,
//! not writer quiescence, deployment qualification, or active runtime authority.
mod baseline;
mod ledger;
pub(crate) mod machine;
pub(crate) mod migrations;
mod query;
use crate::sqlite_mutation_coordinator::{Result, error, hash, sha};
pub use machine::PinnedMachineGenesisDocumentsV1;
use query::{fail, field_number, number, rows, string, timestamp};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub struct PristineDatabaseOptionsV1<'a> {
    pub database_role: &'a str,
    pub database_instance_id: &'a str,
    pub schema_contract_id: &'a str,
    pub schema_hash: &'a str,
    pub state_database_manifest_hash: &'a str,
    pub phase: &'a str,
    pub machine_genesis: Option<&'a PinnedMachineGenesisDocumentsV1>,
}
/// Created only after real SQLite reads. This object does not keep a lease on
/// the source database and cannot grant online mutation or runtime activation.
pub struct PristineDatabaseInspectionV1 {
    value: Value,
}
impl PristineDatabaseInspectionV1 {
    pub fn value(&self) -> &Value {
        &self.value
    }
}
fn common_policy() -> Value {
    json!({
        "autonomous_research_online_mutation_authority_marker":[0],
        "autonomous_research_online_mutation_authority_metadata":[1],
        "autonomous_research_online_mutation_finalization_receipt":[0]
    })
}
fn role_policy() -> Value {
    json!({
        "native-store":{"automation_resource_limits":[1],"automation_resource_peaks":[1],"autonomous_submission_handoff_cutover":[1],"receipt_ledger":"semantic-any-row-count","schema_migrations":[25],"store_metadata":[29]},
        "submission-handoff":{"handoff_cutover":[1],"handoff_instance":[1],"handoff_schema_migrations":[1,2]},
        "machine-intake":{"autonomous_research_machine_intake_authority_genesis":[1],"autonomous_research_machine_intake_metadata":[1]},
        "topic-producer":{"autonomous_research_topic_producer_metadata":[1]},
        "supervisor-state":{},"resident-instance":{"autonomous_research_online_authority_journal_metadata":[1]},
        "runtime-reproducibility-refresh":{"runtime_reproducibility_refresh_state":[1]},
        "runtime-reproducibility-publication":{},"external-qualification":{},
        "full-research-qualification-publication":{"full_research_qualification_pointer_lease":[1]}
    })
}
pub fn pristine_runtime_state_policy_hash_v1(manifest_hash: &str) -> Result<String> {
    hash(
        "AutonomousResearchPristineRuntimeStatePolicy",
        &json!({"stateDatabaseManifestHash":manifest_hash,"commonBaselineRowCounts":common_policy(),"roleBaselineRowCounts":role_policy(),"phaseSpecificHandoffMigrationCounts":{"pre-rebind":1,"post-rebind":2,"adoption":2},"unlistedTablePolicy":"exactly-zero-rows"}),
    )
}
fn policy(role: &str, phase: &str) -> Result<Value> {
    let mut value = common_policy();
    let roles = role_policy();
    let role = roles
        .get(role)
        .and_then(Value::as_object)
        .ok_or_else(|| fail("role_unsupported"))?;
    let map = value
        .as_object_mut()
        .ok_or_else(|| fail("fixed_policy_invalid"))?;
    map.extend(role.iter().map(|(k, v)| (k.clone(), v.clone())));
    if map.contains_key("handoff_schema_migrations") {
        map.insert(
            "handoff_schema_migrations".into(),
            json!([if phase == "pre-rebind" { 1 } else { 2 }]),
        );
    }
    Ok(value)
}
fn online(database: &Connection, input: &PristineDatabaseOptionsV1<'_>) -> Result<Value> {
    let row = query::one(
        database,
        "SELECT * FROM autonomous_research_online_mutation_authority_metadata WHERE singleton=1",
    )?;
    if field_number(&row, "singleton") != Some(1.)
        || field_number(&row, "schema_version") != Some(1.)
        || row["protocol"] != "external-linearizable-reserve-apply-finalize-v1"
        || row["database_role"] != input.database_role
        || row["database_instance_id"] != input.database_instance_id
        || row["schema_contract_id"] != input.schema_contract_id
        || row["schema_hash"] != input.schema_hash
        || [
            "database_scope_hash",
            "writer_manifest_hash",
            "genesis_global_hash",
            "genesis_database_hash",
            "genesis_state_hash",
        ]
        .iter()
        .any(|k| !sha(&row[*k]))
        || field_number(&row, "genesis_global_sequence") != Some(0.)
        || field_number(&row, "genesis_database_sequence") != Some(0.)
        || timestamp(&row["provisioned_at"]).is_none()
    {
        return Err(fail("online_authority_metadata_invalid"));
    }
    if input.database_role == "resident-instance" {
        let journal = query::one(
            database,
            "SELECT * FROM autonomous_research_online_authority_journal_metadata WHERE singleton=1",
        )?;
        let data = baseline::schema_data()?;
        let expected = hash(
            "AutonomousResearchOnlineAuthorityJournalSchema",
            &json!({"version":data["version"],"contractId":data["contractId"],"statements":data["journal"]}),
        )?;
        if field_number(&journal, "singleton") != Some(1.)
            || field_number(&journal, "schema_version") != Some(1.)
            || journal["schema_contract_id"] != "autonomous-research-online-authority-journal-v1"
            || journal["schema_contract_hash"] != expected
        {
            return Err(fail("online_authority_journal_invalid"));
        }
    }
    Ok(
        json!({"databaseScopeHash":row["database_scope_hash"],"writerManifestHash":row["writer_manifest_hash"],"globalSequence":field_number(&row, "genesis_global_sequence"),"globalHash":row["genesis_global_hash"],"databaseSequence":field_number(&row, "genesis_database_sequence"),"databaseHash":row["genesis_database_hash"],"stateHash":row["genesis_state_hash"]}),
    )
}
/// All database observations share one real SQLite read transaction. Caller
/// transactions are refused so the helper cannot roll back a caller's work.
pub fn inspect_pristine_database_state_v1(
    database: &mut Connection,
    input: PristineDatabaseOptionsV1<'_>,
) -> Result<PristineDatabaseInspectionV1> {
    if [
        input.database_role,
        input.database_instance_id,
        input.schema_contract_id,
        input.schema_hash,
        input.state_database_manifest_hash,
    ]
    .iter()
    .any(|s| s.is_empty())
        || !["pre-rebind", "post-rebind", "adoption"].contains(&input.phase)
    {
        return Err(fail("inspection_input_invalid"));
    }
    if !database.is_autocommit() {
        return Err(fail("caller_transaction_active"));
    }
    let transaction = database.transaction_with_behavior(TransactionBehavior::Deferred)?;
    let result = inspect_pristine_database_in_transaction_v1(&transaction, input)?;
    transaction.rollback()?;
    Ok(result)
}

/// Internal fixed observation of a transaction owned by schema installation.
/// It never begins, commits or rolls back the caller's transaction.
pub(crate) fn inspect_pristine_database_in_transaction_v1(
    database: &Connection,
    input: PristineDatabaseOptionsV1<'_>,
) -> Result<PristineDatabaseInspectionV1> {
    if [
        input.database_role,
        input.database_instance_id,
        input.schema_contract_id,
        input.schema_hash,
        input.state_database_manifest_hash,
    ]
    .iter()
    .any(|s| s.is_empty())
        || !["pre-rebind", "post-rebind", "adoption"].contains(&input.phase)
    {
        return Err(fail("inspection_input_invalid"));
    }
    if database.is_autocommit() {
        return Err(fail("installation_transaction_required"));
    }
    let policy = policy(input.database_role, input.phase)?;
    // Preserve the historical hash projection, but reject ordinary tables that
    // the legacy LIKE underscore wildcard would otherwise silently hide.
    let hidden = query::one(
        database,
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name LIKE 'sqlite_%' LIMIT 1",
    )?;
    if !hidden.is_null() {
        let mut failure = fail("hidden_user_table");
        failure.details = json!({"databaseRole":input.database_role,"databaseInstanceId":input.database_instance_id,"tableName":hidden["name"]});
        return Err(failure);
    }
    let tables = rows(
        database,
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 257",
        &[],
        257,
        1024 * 1024,
    )?;
    if tables.len() > 256 {
        return Err(fail("table_limit_exceeded"));
    }
    let table_names = tables
        .iter()
        .map(|v| string(&v["name"]))
        .collect::<Result<Vec<_>>>()?;
    if let Some(map) = policy.as_object() {
        for name in map.keys() {
            if !table_names.contains(&name.as_str()) {
                let mut e = fail("baseline_table_missing");
                e.details = json!({"databaseRole":input.database_role,"databaseInstanceId":input.database_instance_id,"tableName":name});
                return Err(e);
            }
        }
    }
    let mut bindings = baseline::inspect(database, &input)?;
    bindings["onlineAuthority"] = online(database, &input)?;
    let mut states = Vec::new();
    for table in table_names {
        let count: i64 = database.query_row(
            &format!("SELECT count(*) FROM {}", query::identifier(table)),
            [],
            |r| r.get(0),
        )?;
        let allowed = policy.get(table);
        if allowed != Some(&json!("semantic-any-row-count"))
            && !allowed.and_then(Value::as_array).map_or(count == 0, |a| {
                a.iter().any(|v| number(v) == Some(count as f64))
            })
        {
            let mut e = fail(if allowed.is_some() {
                "baseline_row_count_invalid"
            } else {
                "business_rows_present"
            });
            e.details = json!({"databaseRole":input.database_role,"databaseInstanceId":input.database_instance_id,"tableName":table,"rowCount":count});
            return Err(e);
        }
        let (columns, rows_hash) = query::canonical_rows(database, table, count)?;
        states.push(json!({"tableName":table,"classification":if allowed.is_some(){"permitted-baseline"}else{"business-empty"},"rowCount":count,"columns":columns,"rowsHash":rows_hash}));
    }
    let mut payload = json!({"databaseRole":input.database_role,"databaseInstanceId":input.database_instance_id,"schemaContractId":input.schema_contract_id,"schemaHash":input.schema_hash,"phase":input.phase,"stateDatabaseManifestHash":input.state_database_manifest_hash,"policyHash":pristine_runtime_state_policy_hash_v1(input.state_database_manifest_hash)?,"tableStates":states,"semanticBindings":bindings,"businessRowCount":0});
    let state_hash = hash("AutonomousResearchPristineDatabaseState", &payload)?;
    payload["version"] = json!(1);
    payload["kind"] = json!("AutonomousResearchPristineDatabaseStateInspection");
    payload["status"] = json!("autonomous_research_pristine_database_state_ready");
    payload["pristineStateHash"] = json!(state_hash);
    if let Some(documents) = input.machine_genesis {
        documents.assert_current()?;
    }
    Ok(PristineDatabaseInspectionV1 { value: payload })
}
/// The inputs must originate in actual inspections, but the resulting digest is
/// still a historical observation, not a current deployment capability.
pub fn pristine_runtime_state_hash_v1(
    inspections: &[PristineDatabaseInspectionV1],
) -> Result<String> {
    let values = inspections.iter().map(|v| &v.value).collect::<Vec<_>>();
    if values.len() != 10 {
        return Err(error(
            "autonomous_research_pristine_runtime_state_inspections_invalid",
        ));
    }
    let roles = values
        .iter()
        .map(|v| string(&v["databaseRole"]))
        .collect::<Result<BTreeSet<_>>>()?;
    let phases = values
        .iter()
        .map(|v| string(&v["phase"]))
        .collect::<Result<BTreeSet<_>>>()?;
    if roles.len() != 10 || phases.len() != 1 {
        return Err(error(
            "autonomous_research_pristine_runtime_state_role_or_phase_invalid",
        ));
    }
    let binding = |role| {
        values
            .iter()
            .find(|v| v["databaseRole"] == role)
            .map(|v| &v["semanticBindings"])
            .ok_or_else(|| {
                error("autonomous_research_pristine_runtime_state_cross_database_binding_invalid")
            })
    };
    let native = binding("native-store")?;
    let handoff = binding("submission-handoff")?;
    let machine = binding("machine-intake")?;
    let topic = binding("topic-producer")?;
    let expected = hash(
        "AutonomousSubmissionHandoffDatabaseIdentity",
        &json!({"cutoverId":handoff["cutoverId"],"databasePath":"submission-handoff.sqlite","migrationHash":baseline::schema_data()?["handoff"][0]["migrationHash"],"instanceNonce":handoff["instanceNonce"]}),
    )?;
    let first = &values[0]["semanticBindings"]["onlineAuthority"];
    if native["cutoverId"] != handoff["cutoverId"]
        || native["handoffDatabaseIdentityHash"] != expected
        || handoff["nativeCutoverIdentityHash"] != expected
        || machine["machineIntakeConfigurationHash"] != topic["machineIntakeConfigurationHash"]
        || machine["producerProfileHash"] != topic["producerProfileHash"]
        || values.iter().any(|v| {
            [
                "databaseScopeHash",
                "writerManifestHash",
                "globalSequence",
                "globalHash",
            ]
            .iter()
            .any(|k| v["semanticBindings"]["onlineAuthority"][*k] != first[*k])
        })
    {
        return Err(error(
            "autonomous_research_pristine_runtime_state_cross_database_binding_invalid",
        ));
    }
    let mut projection = values
        .into_iter()
        .map(|v| {
            let mut row = serde_json::Map::new();
            for k in [
                "databaseRole",
                "databaseInstanceId",
                "schemaContractId",
                "schemaHash",
                "phase",
                "policyHash",
                "pristineStateHash",
            ] {
                row.insert(k.to_owned(), v[k].clone());
            }
            Value::Object(row)
        })
        .collect::<Vec<_>>();
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    projection.sort_by(|a, b| {
        collator.compare(
            a["databaseInstanceId"].as_str().unwrap_or(""),
            b["databaseInstanceId"].as_str().unwrap_or(""),
        )
    });
    hash("AutonomousResearchPristineRuntimeState", &json!(projection))
}

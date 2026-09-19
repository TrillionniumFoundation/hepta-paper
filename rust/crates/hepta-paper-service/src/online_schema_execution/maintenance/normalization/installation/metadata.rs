//! Fixed metadata/genesis installation. Only the parent holding real signed
//! maintenance and all database locks invokes these private operations.
use super::*;
use rusqlite::{params_from_iter, types::Value as SqlValue};
const MARKER: &str = "autonomous_research_online_mutation_authority_metadata";
const FIELDS: [&str; 15] = [
    "singleton",
    "schema_version",
    "protocol",
    "database_role",
    "database_instance_id",
    "schema_contract_id",
    "schema_hash",
    "database_scope_hash",
    "writer_manifest_hash",
    "genesis_global_sequence",
    "genesis_global_hash",
    "genesis_database_sequence",
    "genesis_database_hash",
    "genesis_state_hash",
    "provisioned_at",
];
fn rows(database: &Connection, table: &str, fields: &[&str]) -> Result<Vec<Vec<SqlValue>>> {
    let mut statement = database.prepare(&format!(
        "SELECT {} FROM main.{table} LIMIT 3",
        fields.join(",")
    ))?;
    let mut result = Vec::new();
    let mut cursor = statement.query([])?;
    while let Some(row) = cursor.next()? {
        result.push(
            (0..fields.len())
                .map(|i| row.get(i))
                .collect::<std::result::Result<Vec<_>, _>>()?,
        );
    }
    Ok(result)
}
fn string(value: &Value, key: &str) -> Result<SqlValue> {
    Ok(SqlValue::Text(text(value, key)?.to_owned()))
}
fn integer(value: &Value, key: &str) -> Result<SqlValue> {
    Ok(SqlValue::Integer(int(value, key)?))
}
fn expected(plan: &Value, instance: &Value, genesis: &Value) -> Result<Vec<SqlValue>> {
    Ok(vec![
        SqlValue::Integer(1),
        SqlValue::Integer(1),
        SqlValue::Text("external-linearizable-reserve-apply-finalize-v1".into()),
        string(instance, "databaseRole")?,
        string(instance, "databaseInstanceId")?,
        string(instance, "schemaContractId")?,
        string(instance, "expectedPostSchemaHash")?,
        string(plan, "databaseScopeHash")?,
        string(plan, "writerManifestHash")?,
        integer(genesis, "globalSequence")?,
        string(genesis, "globalHash")?,
        integer(genesis, "databaseSequence")?,
        string(genesis, "databaseHash")?,
        string(genesis, "stateHash")?,
        string(plan, "plannedAt")?,
    ])
}
pub(super) fn install(
    database: &Connection,
    plan: &Value,
    instance: &Value,
    reservation: &Value,
) -> Result<()> {
    ensure(
        !database.is_autocommit(),
        "autonomous_research_online_schema_transition_installation_transaction_required",
    )?;
    let genesis = reservation["databaseGenesis"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["databaseInstanceId"] == instance["databaseInstanceId"])
        })
        .ok_or_else(|| error("autonomous_research_online_schema_transition_genesis_missing"))?;
    let expected = expected(plan, instance, genesis)?;
    let existing = rows(database, MARKER, &FIELDS)?;
    if existing.is_empty() {
        ensure(
            plan["version"].as_f64() != Some(2.),
            "autonomous_research_pristine_schema_rebind_marker_metadata_required",
        )?;
        database.execute(
            &format!(
                "INSERT INTO main.{MARKER}({}) VALUES({})",
                FIELDS.join(","),
                vec!["?"; FIELDS.len()].join(",")
            ),
            params_from_iter(&expected),
        )?;
    } else if existing.len() == 1 && existing[0] == expected {
        // Exact idempotent metadata. Full expected database equality is checked
        // by the parent; this alone cannot prove a completed installation.
    } else if plan["version"].as_f64() == Some(2.) {
        let old = reservation["previousDatabaseHeads"]
            .as_array()
            .and_then(|rows| {
                rows.iter()
                    .find(|row| row["databaseInstanceId"] == instance["databaseInstanceId"])
            })
            .ok_or_else(|| {
                error("autonomous_research_pristine_schema_rebind_marker_metadata_conflict")
            })?;
        let mut previous = expected.clone();
        previous[5] = string(instance, "preSchemaContractId")?;
        previous[6] = string(instance, "preSchemaHash")?;
        previous[8] = string(plan, "sourceWriterManifestHash")?;
        previous[9] = integer(reservation, "previousGlobalSequence")?;
        previous[10] = string(reservation, "previousGlobalHash")?;
        previous[11] = integer(old, "sequence")?;
        previous[12] = string(old, "hash")?;
        previous[13] = string(old, "stateHash")?;
        // The old provisioned timestamp is intentionally retained only for
        // validating the old row. It is replaced by the actual observed plan time, independently pinned for recovery.
        if let Some(row) = existing.first() {
            previous[14] = row[14].clone();
        }
        let markers: i64 = database.query_row(
            "SELECT count(*) FROM main.autonomous_research_online_mutation_authority_marker",
            [],
            |r| r.get(0),
        )?;
        let finalized: i64 = database.query_row(
            "SELECT count(*) FROM main.autonomous_research_online_mutation_finalization_receipt",
            [],
            |r| r.get(0),
        )?;
        ensure(
            existing.len() == 1 && existing[0] == previous && markers == 0 && finalized == 0,
            "autonomous_research_pristine_schema_rebind_marker_metadata_conflict",
        )?;
        database.execute_batch(
            "DROP TRIGGER main.autonomous_research_online_mutation_metadata_no_update;",
        )?;
        let values = expected[5..].iter();
        let changed=database.execute("UPDATE main.autonomous_research_online_mutation_authority_metadata SET schema_contract_id=?,schema_hash=?,database_scope_hash=?,writer_manifest_hash=?,genesis_global_sequence=?,genesis_global_hash=?,genesis_database_sequence=?,genesis_database_hash=?,genesis_state_hash=?,provisioned_at=? WHERE singleton=1",params_from_iter(values))?;
        ensure(
            changed == 1,
            "autonomous_research_pristine_schema_rebind_marker_metadata_update_failed",
        )?;
        database.execute_batch("CREATE TRIGGER autonomous_research_online_mutation_metadata_no_update\nBEFORE UPDATE ON autonomous_research_online_mutation_authority_metadata\nBEGIN SELECT RAISE(ABORT, 'autonomous_research_online_mutation_metadata_immutable'); END;")?;
    } else {
        return Err(error(
            "autonomous_research_online_schema_transition_marker_metadata_conflict",
        ));
    }
    ensure(
        rows(database, MARKER, &FIELDS)? == vec![expected],
        "autonomous_research_pristine_schema_rebind_marker_metadata_postcondition_failed",
    )?;
    if instance["databaseRole"] == "resident-instance" {
        let fields = [
            "singleton",
            "schema_version",
            "schema_contract_id",
            "schema_contract_hash",
        ];
        let expected = vec![
            SqlValue::Integer(1),
            SqlValue::Integer(1),
            string(plan, "authorityJournalSchemaContractId")?,
            string(plan, "authorityJournalSchemaHash")?,
        ];
        let existing = rows(
            database,
            "autonomous_research_online_authority_journal_metadata",
            &fields,
        )?;
        if existing.is_empty() {
            database.execute("INSERT INTO main.autonomous_research_online_authority_journal_metadata(singleton,schema_version,schema_contract_id,schema_contract_hash) VALUES(?,?,?,?)",params_from_iter(&expected))?;
        } else {
            ensure(
                existing == vec![expected],
                "autonomous_research_online_schema_transition_journal_metadata_conflict",
            )?;
        }
    }
    Ok(())
}
pub(super) fn record(
    plan: &Value,
    reservation: &Value,
    instance: &Value,
    post_pristine: Option<&str>,
) -> Result<Value> {
    let payload = json!({"transitionId":plan["transitionId"],"reservationReceiptHash":schema_transition_receipt_hash_v1(reservation)?,"databaseRole":instance["databaseRole"],"databaseInstanceId":instance["databaseInstanceId"],"schemaContractId":instance["schemaContractId"],"preSchemaHash":instance["preSchemaHash"],"postSchemaHash":instance["expectedPostSchemaHash"],"prePristineStateHash":instance["prePristineStateHash"],"postPristineStateHash":post_pristine.map(Value::from).unwrap_or_else(||instance["prePristineStateHash"].clone())});
    let mut record = payload.clone();
    let object = record.as_object_mut().ok_or_else(|| {
        error("autonomous_research_online_schema_transition_installation_invalid")
    })?;
    object.remove("transitionId");
    object.remove("reservationReceiptHash");
    object.insert(
        "installationHash".into(),
        json!(hash(
            "AutonomousResearchOnlineSchemaTransitionDatabaseInstallation",
            &payload
        )?),
    );
    Ok(record)
}

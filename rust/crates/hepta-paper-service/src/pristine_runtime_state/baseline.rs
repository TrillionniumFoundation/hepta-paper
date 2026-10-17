use super::{
    PristineDatabaseOptionsV1,
    query::{fail, field_number, null_field, one, rows, timestamp},
};
use crate::sqlite_mutation_coordinator::{Result, error, hash_bytes, sha};
use rusqlite::Connection;
use serde_json::{Value, json};
pub(super) fn schema_data() -> Result<Value> {
    serde_json::from_str(include_str!("../online_schema_transition/schema_data.json"))
        .map_err(|e| error(e.to_string()))
}
fn native(db: &Connection) -> Result<Value> {
    let migrations = rows(
        db,
        "SELECT version,name,migration_sha256,applied_at FROM schema_migrations ORDER BY version",
        &[],
        10000,
        4 * 1024 * 1024,
    )?;
    if migrations.len() != super::migrations::NATIVE_MIGRATIONS.len()
        || migrations
            .iter()
            .zip(super::migrations::NATIVE_MIGRATIONS)
            .enumerate()
            .any(|(i, (row, (name, sql)))| {
                field_number(row, "version") != Some((i + 1) as f64)
                    || row["name"] != *name
                    || row["migration_sha256"] != hash_bytes(sql)
                    || timestamp(&row["applied_at"]).is_none()
            })
    {
        return Err(fail("native_migrations_invalid"));
    }
    let metadata = rows(
        db,
        "SELECT key,value FROM store_metadata ORDER BY key",
        &[],
        10000,
        4 * 1024 * 1024,
    )?;
    let mut map = serde_json::Map::new();
    for row in metadata {
        map.insert(
            super::query::string(&row["key"])?.to_owned(),
            row["value"].clone(),
        );
    }
    let expected: Value =
        serde_json::from_str(include_str!("policy_data.json")).map_err(|e| error(e.to_string()))?;
    if Value::Object(map) != expected["nativeMetadata"] {
        return Err(fail("native_metadata_invalid"));
    }
    let limits = one(db, "SELECT * FROM automation_resource_limits")?;
    let peaks = one(db, "SELECT * FROM automation_resource_peaks")?;
    if limits["scope"] != "global"
        || [
            ("agent_limit", 4.),
            ("cpu_limit", 4.),
            ("gpu_limit", 1.),
            ("memory_mib_limit", 8192.),
        ]
        .iter()
        .any(|(k, n)| field_number(&limits, k) != Some(*n))
        || ["created_at", "updated_at"]
            .iter()
            .any(|k| timestamp(&limits[*k]).is_none())
        || peaks["scope"] != "global"
        || ["agent_peak", "cpu_peak", "gpu_peak", "memory_mib_peak"]
            .iter()
            .any(|k| field_number(&peaks, k) != Some(0.))
        || timestamp(&peaks["updated_at"]).is_none()
    {
        return Err(fail("native_resource_baseline_invalid"));
    }
    super::ledger::inspect(db)?;
    let cutover = one(
        db,
        "SELECT * FROM autonomous_submission_handoff_cutover WHERE singleton=1",
    )?;
    if cutover["cutover_id"] != "autonomous-submission-handoff-cutover-v1"
        || !sha(&cutover["handoff_database_identity_hash"])
        || field_number(&cutover, "legacy_autonomous_row_count") != Some(0.)
        || field_number(&cutover, "legacy_quarantined_row_count") != Some(0.)
        || timestamp(&cutover["activated_at"]).is_none()
    {
        return Err(fail("native_cutover_invalid"));
    }
    Ok(
        json!({"handoffDatabaseIdentityHash":cutover["handoff_database_identity_hash"],"cutoverId":cutover["cutover_id"]}),
    )
}
fn handoff(db: &Connection, phase: &str) -> Result<Value> {
    let migrations = rows(
        db,
        "SELECT version,name,migration_sha256,applied_at FROM handoff_schema_migrations ORDER BY version",
        &[],
        10000,
        4 * 1024 * 1024,
    )?;
    let data = schema_data()?;
    let expected = data["handoff"]
        .as_array()
        .ok_or_else(|| fail("fixed_schema_invalid"))?;
    let expected_count = if phase == "pre-rebind" { 1 } else { 2 };
    let instance = one(db, "SELECT * FROM handoff_instance WHERE singleton=1")?;
    let cutover = one(db, "SELECT * FROM handoff_cutover WHERE singleton=1")?;
    let nonce = instance["instance_nonce"].as_str().unwrap_or("");
    let valid_nonce = regex::Regex::new(
        "(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )
    .map_err(|e| error(e.to_string()))?
    .is_match(nonce);
    if migrations.len() != expected_count
        || migrations.iter().zip(expected).any(|(row, want)| {
            field_number(row, "version") != field_number(want, "version")
                || row["name"] != want["name"]
                || row["migration_sha256"] != want["migrationHash"]
                || timestamp(&row["applied_at"]).is_none()
        })
        || !valid_nonce
        || timestamp(&instance["provisioned_at"]).is_none()
        || cutover["cutover_id"] != "autonomous-submission-handoff-cutover-v1"
        || !sha(&cutover["native_cutover_identity_hash"])
        || cutover["status"] != "active"
        || ["prepared_at", "activated_at"]
            .iter()
            .any(|k| timestamp(&cutover[*k]).is_none())
    {
        return Err(fail("handoff_baseline_invalid"));
    }
    Ok(
        json!({"instanceNonce":instance["instance_nonce"],"nativeCutoverIdentityHash":cutover["native_cutover_identity_hash"],"cutoverId":cutover["cutover_id"]}),
    )
}
pub(super) fn inspect(db: &Connection, input: &PristineDatabaseOptionsV1<'_>) -> Result<Value> {
    match input.database_role {
        "native-store" => native(db),
        "submission-handoff" => handoff(db, input.phase),
        "machine-intake" => super::machine::inspect(db, input.machine_genesis),
        "topic-producer" => {
            let row = one(
                db,
                "SELECT * FROM autonomous_research_topic_producer_metadata WHERE singleton=1",
            )?;
            if [
                "machine_intake_configuration_hash",
                "producer_profile_hash",
                "provider_configuration_hash",
                "implementation_sha256",
            ]
            .iter()
            .any(|k| !sha(&row[*k]))
                || ["lease_generation", "generation_high_watermark"]
                    .iter()
                    .any(|k| field_number(&row, k) != Some(0.))
                || ["last_observed_at", "last_produced_at", "next_attempt_at"]
                    .iter()
                    .any(|k| !null_field(&row, k))
            {
                return Err(fail("topic_producer_metadata_invalid"));
            }
            Ok(
                json!({"machineIntakeConfigurationHash":row["machine_intake_configuration_hash"],"producerProfileHash":row["producer_profile_hash"],"providerConfigurationHash":row["provider_configuration_hash"],"implementationSha256":row["implementation_sha256"]}),
            )
        }
        "runtime-reproducibility-refresh" => {
            let row = one(db, "SELECT * FROM runtime_reproducibility_refresh_state")?;
            if row["scope_id"] != "resident-runtime-image-reproducibility"
                || row["status"] != "refresh_unobserved"
                || [
                    "consecutive_failures",
                    "recovered_lease_count",
                    "lease_generation",
                ]
                .iter()
                .any(|k| field_number(&row, k) != Some(0.))
                || ["next_attempt_at", "created_at", "updated_at"]
                    .iter()
                    .any(|k| row[*k] != "1970-01-01T00:00:00.000Z")
                || [
                    "last_error",
                    "last_configuration_identity_hash",
                    "last_receipt_hash",
                    "last_receipt_content_hash",
                    "last_issued_at",
                    "last_expires_at",
                    "lease_owner",
                    "lease_token",
                    "lease_expires_at",
                ]
                .iter()
                .any(|k| !null_field(&row, k))
            {
                return Err(fail("runtime_refresh_baseline_invalid"));
            }
            Ok(json!({}))
        }
        "full-research-qualification-publication" => {
            let row = one(
                db,
                "SELECT * FROM full_research_qualification_pointer_lease",
            )?;
            if field_number(&row, "singleton_id") != Some(1.)
                || ["lease_generation", "recovered_lease_count"]
                    .iter()
                    .any(|k| field_number(&row, k) != Some(0.))
                || ["lease_owner", "lease_token", "lease_expires_at"]
                    .iter()
                    .any(|k| !null_field(&row, k))
                || row["updated_at"] != "1970-01-01T00:00:00.000Z"
            {
                return Err(fail("qualification_lease_baseline_invalid"));
            }
            Ok(json!({}))
        }
        _ => Ok(json!({})),
    }
}

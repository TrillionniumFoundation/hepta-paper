//! Fresh in-memory construction only. The publisher alone owns filesystem writes.
use super::{Result, error, input_hash, inputs::Inputs};
use crate::pristine_runtime_state::migrations::NATIVE_MIGRATIONS;
use rusqlite::{Connection, MAIN_DB, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const TEMPLATES: &str = include_str!("business-schemas.v1.json");
const HANDOFF: &str = include_str!("../online_schema_transition/schema_data.json");
const CUTOVER: &str = "autonomous-submission-handoff-cutover-v1";
const EPOCH: &str = "1970-01-01T00:00:00.000Z";
pub(super) fn bytes_hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
pub(super) fn bundle_hash() -> Result<String> {
    input_hash(
        "NativeBusinessSchemaBundleV1",
        &json!({
            "business":bytes_hash(TEMPLATES.as_bytes()),"handoff":bytes_hash(HANDOFF.as_bytes()),
            "native":NATIVE_MIGRATIONS.iter().map(|(name,sql)| json!({"name":name,"sha256":bytes_hash(sql)})).collect::<Vec<_>>()
        }),
    )
}
pub(super) struct Image {
    pub role: String,
    pub relative: String,
    pub bytes: Vec<u8>,
    pub schema_hash: String,
}
impl Image {
    pub fn observation(&self) -> Value {
        json!({"role":self.role,"sourceRelativePath":self.relative,"bytes":self.bytes.len(),
            "sourceSha256":bytes_hash(&self.bytes),"businessSchemaHash":self.schema_hash})
    }
}
fn schema_rows(db: &Connection) -> Result<Value> {
    let mut statement = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name")?;
    let rows = statement
        .query_map([], |r| {
            Ok(json!({"type":r.get::<_,String>(0)?,
        "name":r.get::<_,String>(1)?,"tbl_name":r.get::<_,String>(2)?,"sql":r.get::<_,String>(3)?}))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if rows.len() > 2048 {
        return Err(error("autonomous_state_provisioning_schema_bound"));
    }
    Ok(json!(rows))
}
fn uuid() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| error("autonomous_state_provisioning_random_unavailable"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let s = hex::encode(bytes);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &s[..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..]
    ))
}
fn text(value: &Value) -> Result<&str> {
    value
        .as_str()
        .ok_or_else(|| error("autonomous_state_provisioning_schema_data_invalid"))
}
fn seed_genesis(db: &Connection, inputs: &Inputs) -> Result<()> {
    let (envelope, trust, signers) = &inputs.authority;
    let configuration = &inputs.machine["configurationHash"];
    let profile = &inputs.topic["producerProfileHash"];
    let envelope_hash = input_hash(
        "AutonomousResearchMachineIntakeAuthorityGenesisEnvelope",
        envelope,
    )?;
    let trust_hash = input_hash("AuthorityTrustStore", trust)?;
    let payload = json!({"version":1,"kind":"AutonomousResearchMachineIntakeAuthorityGenesis",
        "origin":"fresh-v2-genesis","configurationHash":configuration,"producerProfileHash":profile,
        "authorityGeneration":1,"externalGenesisEnvelopeHash":envelope_hash,
        "ownerTrustStoreHash":trust_hash,"createdAt":envelope["validFrom"]});
    db.execute("INSERT INTO autonomous_research_machine_intake_metadata(singleton,configured_source_authority_hash,authorized_machine_producer_profile_hash,authority_generation,last_authority_rotation_receipt_hash) VALUES(1,?1,?2,1,NULL)",
        params![text(configuration)?,text(profile)?])?;
    db.execute("INSERT INTO autonomous_research_machine_intake_authority_genesis(singleton,origin,configuration_hash,producer_profile_hash,authority_generation,external_genesis_envelope_hash,external_genesis_envelope_json,owner_trust_store_hash,owner_trust_store_snapshot_json,verified_signers_json,genesis_payload_json,genesis_hash,created_at) VALUES(1,'fresh-v2-genesis',?1,?2,1,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![text(configuration)?,text(profile)?,envelope_hash,serde_json::to_string(envelope)?,trust_hash,
            serde_json::to_string(trust)?,serde_json::to_string(signers)?,serde_json::to_string(&payload)?,
            input_hash("AutonomousResearchMachineIntakeAuthorityGenesis",&payload)?,text(&envelope["validFrom"])?])?;
    Ok(())
}
fn seed_business(db: &Connection, role: &str, inputs: &Inputs) -> Result<()> {
    match role {
        "machine-intake" => seed_genesis(db, inputs)?,
        "topic-producer" => {
            db.execute("INSERT INTO autonomous_research_topic_producer_metadata(singleton,machine_intake_configuration_hash,producer_profile_hash,provider_configuration_hash,implementation_sha256) VALUES(1,?1,?2,?3,?4)",
            params![text(&inputs.machine["configurationHash"])?,text(&inputs.topic["producerProfileHash"])?,
                text(&inputs.topic["providerConfigurationHash"])?,text(&inputs.topic["implementationSha256"])?])?;
        }
        "runtime-reproducibility-refresh" => {
            db.execute("INSERT INTO runtime_reproducibility_refresh_state(scope_id,status,consecutive_failures,next_attempt_at,recovered_lease_count,lease_generation,created_at,updated_at) VALUES('resident-runtime-image-reproducibility','refresh_unobserved',0,?1,0,0,?1,?1)", [EPOCH])?;
        }
        "full-research-qualification-publication" => {
            db.execute("INSERT INTO full_research_qualification_pointer_lease(singleton_id,lease_generation,recovered_lease_count,updated_at) VALUES(1,0,0,?1)", [EPOCH])?;
        }
        "external-qualification"
        | "resident-instance"
        | "runtime-reproducibility-publication"
        | "supervisor-state" => (),
        _ => return Err(error("autonomous_state_provisioning_unknown_role")),
    }
    Ok(())
}
pub(super) fn build(inputs: &Inputs, when: &str) -> Result<Vec<Image>> {
    let templates: Value = serde_json::from_str(TEMPLATES)?;
    let handoff: Value = serde_json::from_str(HANDOFF)?;
    let nonce = uuid()?;
    let identity = input_hash(
        "AutonomousSubmissionHandoffDatabaseIdentity",
        &json!({
            "cutoverId":CUTOVER,"databasePath":"submission-handoff.sqlite",
            "migrationHash":handoff["handoff"][0]["migrationHash"],"instanceNonce":nonce
        }),
    )?;
    let definitions = inputs.manifest["databases"]
        .as_array()
        .ok_or_else(|| error("autonomous_state_provisioning_manifest_invalid"))?;
    if definitions.len() != 10 {
        return Err(error("autonomous_state_provisioning_manifest_invalid"));
    }
    let mut images = Vec::new();
    let mut total = 0usize;
    for definition in definitions {
        let role = text(&definition["role"])?;
        let relative = text(&definition["relativePath"])?;
        let db = Connection::open_in_memory()?;
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;")?;
        if role == "native-store" {
            for (i, (name, sql)) in NATIVE_MIGRATIONS.iter().enumerate() {
                db.execute_batch(
                    std::str::from_utf8(sql)
                        .map_err(|_| error("autonomous_state_provisioning_sql_encoding"))?,
                )?;
                db.execute(
                    "INSERT INTO schema_migrations(version,name,migration_sha256) VALUES(?1,?2,?3)",
                    params![(i + 1) as i64, name, bytes_hash(sql)],
                )?;
            }
            db.execute("INSERT INTO autonomous_submission_handoff_cutover(singleton,cutover_id,handoff_database_identity_hash,legacy_autonomous_row_count,legacy_quarantined_row_count,activated_at) VALUES(1,?1,?2,0,0,?3)",params![CUTOVER,identity,when])?;
        } else if role == "submission-handoff" {
            for migration in handoff["handoff"]
                .as_array()
                .ok_or_else(|| error("autonomous_state_provisioning_handoff_invalid"))?
            {
                let sql = text(&migration["sql"])?;
                if migration["migrationHash"] != bytes_hash(sql.as_bytes()) {
                    return Err(error("autonomous_state_provisioning_handoff_invalid"));
                }
                db.execute_batch(sql)?;
                db.execute("INSERT INTO handoff_schema_migrations(version,name,migration_sha256,applied_at) VALUES(?1,?2,?3,?4)",params![migration["version"].as_i64(),text(&migration["name"])?,text(&migration["migrationHash"])?,when])?;
            }
            db.execute("INSERT INTO handoff_instance(singleton,instance_nonce,provisioned_at) VALUES(1,?1,?2)",params![nonce,when])?;
            db.execute("INSERT INTO handoff_cutover(singleton,cutover_id,native_cutover_identity_hash,status,prepared_at,activated_at) VALUES(1,?1,?2,'active',?3,?3)",params![CUTOVER,identity,when])?;
        } else {
            let objects = templates["roles"][role]["objects"]
                .as_array()
                .ok_or_else(|| error("autonomous_state_provisioning_unknown_role"))?;
            for table in [true, false] {
                for object in objects.iter().filter(|o| (o["type"] == "table") == table) {
                    db.execute_batch(text(&object["sql"])?)?;
                }
            }
            if schema_rows(&db)? != json!(objects) {
                return Err(error("autonomous_state_provisioning_template_drift"));
            }
            seed_business(&db, role, inputs)?;
        }
        let check: String = db.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if check != "ok" || db.prepare("PRAGMA foreign_key_check")?.exists([])? {
            return Err(error("autonomous_state_provisioning_integrity_failed"));
        }
        let schema_hash = input_hash("NativeBusinessSchemaObjectsV1", &schema_rows(&db)?)?;
        let serialized = db.serialize(MAIN_DB)?.to_vec();
        total = total
            .checked_add(serialized.len())
            .ok_or_else(|| error("autonomous_state_provisioning_byte_bound"))?;
        if serialized.len() > 32 * 1024 * 1024 || total > 128 * 1024 * 1024 {
            return Err(error("autonomous_state_provisioning_byte_bound"));
        }
        images.push(Image {
            role: role.to_owned(),
            relative: relative.to_owned(),
            bytes: serialized,
            schema_hash,
        });
        db.close().map_err(|(_, e)| e)?;
    }
    Ok(images)
}

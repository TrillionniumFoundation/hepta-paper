use super::query::{canonical_timestamp as timestamp, one, rows, string};
use crate::sqlite_mutation_coordinator::{
    Result,
    authority::files::{Snapshot, parse},
    error, hash, keys, sha,
};
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signature, VerifyingKey, pkcs8::DecodePublicKey};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::Path};
const ERROR: &str = "autonomous_research_machine_intake_authority_state_invalid";
const PAYLOAD: &[&str] = &[
    "authorityGeneration",
    "configurationHash",
    "createdAt",
    "externalGenesisEnvelopeHash",
    "kind",
    "origin",
    "ownerTrustStoreHash",
    "producerProfileHash",
    "version",
];
const ENVELOPE: &[&str] = &[
    "authorityGeneration",
    "configurationHash",
    "expiresAt",
    "kind",
    "nonce",
    "ownerTrustStoreHash",
    "producerProfileHash",
    "signatures",
    "signedAt",
    "status",
    "validFrom",
    "version",
];
const TRUST_KEY: &[&str] = &[
    "algorithm",
    "effectiveFrom",
    "expiresAt",
    "keyId",
    "organization",
    "publicKeyPem",
    "revokedAt",
    "roles",
    "status",
    "subjectId",
];
/// Explicit byte pins bind public external genesis documents. This verifies local
/// historical signatures; it does not qualify an external service or its liveness.
/// Other rotation/bootstrap documents are securely read because the original
/// genesis loader requires their presence, although genesis does not interpret them.
pub struct PinnedMachineGenesisDocumentsV1 {
    snapshots: Vec<Snapshot>,
    owner: Value,
    envelope: Value,
}
impl PinnedMachineGenesisDocumentsV1 {
    pub fn load(
        owner: (&Path, &str),
        envelope: (&Path, &str),
        rotation: (&Path, &str),
        bootstrap: (&Path, &str),
    ) -> Result<Self> {
        let mut snapshots = Vec::new();
        let mut documents = Vec::new();
        for (path, pin) in [owner, envelope, rotation, bootstrap] {
            let snapshot = Snapshot::load(path, pin, 1024 * 1024, ERROR)?;
            documents.push(snapshot.json(ERROR)?);
            snapshots.push(snapshot);
        }
        let mut documents = documents.into_iter();
        let owner = documents.next().ok_or_else(|| error(ERROR))?;
        let envelope = documents.next().ok_or_else(|| error(ERROR))?;
        Ok(Self {
            snapshots,
            owner,
            envelope,
        })
    }
    pub fn assert_current(&self) -> Result<()> {
        for snapshot in &self.snapshots {
            snapshot.assert_current()?;
        }
        Ok(())
    }
}
fn parsed(row: &Value, key: &str) -> Result<Value> {
    parse(
        string(&row[key]).map_err(|_| error(ERROR))?.as_bytes(),
        ERROR,
    )
}
fn canonical(v: &Value) -> Result<Vec<u8>> {
    let normalized =
        hepta_legacy_compatibility::production_stable_json_v1(v).map_err(|_| error(ERROR))?;
    let parsed: Value = serde_json::from_slice(&normalized).map_err(|_| error(ERROR))?;
    serde_json::to_vec(&parsed).map_err(|_| error(ERROR))
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|n| n != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}
fn subject_string(value: &Value) -> Result<String> {
    Ok(match value {
        Value::String(value) => value.clone(),
        Value::Object(_) => "[object Object]".to_owned(),
        Value::Array(values) => values
            .iter()
            .map(|v| {
                if v.is_null() {
                    Ok(String::new())
                } else {
                    subject_string(v)
                }
            })
            .collect::<Result<Vec<_>>>()?
            .join(","),
        _ => String::from_utf8(
            hepta_legacy_compatibility::production_stable_json_v1(value)
                .map_err(|_| error(ERROR))?,
        )
        .map_err(|_| error(ERROR))?,
    })
}
pub(crate) fn verify_external(
    documents: &PinnedMachineGenesisDocumentsV1,
    configuration: &Value,
    profile: &Value,
    created: &Value,
) -> Result<(Value, Value, Value)> {
    documents.assert_current()?;
    let envelope = &documents.envelope;
    let trust = &documents.owner;
    let when = timestamp(created).ok_or_else(|| error(ERROR))?;
    let signed = timestamp(&envelope["signedAt"]).ok_or_else(|| error(ERROR))?;
    let valid = timestamp(&envelope["validFrom"]).ok_or_else(|| error(ERROR))?;
    let expires = timestamp(&envelope["expiresAt"]).ok_or_else(|| error(ERROR))?;
    let nonce = envelope["nonce"].as_str().unwrap_or("");
    let valid_nonce = (16..=256).contains(&nonce.len())
        && nonce
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:@-".contains(&b));
    let trust_keys = trust["keys"].as_array().ok_or_else(|| error(ERROR))?;
    let signatures = envelope["signatures"]
        .as_array()
        .ok_or_else(|| error(ERROR))?;
    if !keys(envelope, ENVELOPE)
        || envelope["version"].as_f64() != Some(1.)
        || envelope["kind"] != "AutonomousResearchMachineIntakeAuthorityGenesisEnvelope"
        || envelope["status"] != "external_genesis_authority_verified"
        || envelope["configurationHash"] != *configuration
        || envelope["producerProfileHash"] != *profile
        || envelope["authorityGeneration"].as_f64() != Some(1.)
        || envelope["ownerTrustStoreHash"] != hash("AuthorityTrustStore", trust)?
        || !valid_nonce
        || signed > valid
        || signed > when
        || when < valid
        || when >= expires
        || expires - signed > 31 * 24 * 60 * 60 * 1000
        || !keys(trust, &["version", "kind", "keys"])
        || trust["version"].as_f64() != Some(1.)
        || trust["kind"] != "AuthorityTrustStore"
        || trust_keys.len() < 2
        || trust_keys.len() > 64
        || signatures.len() != 2
    {
        return Err(error(ERROR));
    }
    let mut ids = BTreeSet::new();
    for key in trust_keys {
        let effective = timestamp(&key["effectiveFrom"]).ok_or_else(|| error(ERROR))?;
        let expires = timestamp(&key["expiresAt"]).ok_or_else(|| error(ERROR))?;
        if !keys(key, TRUST_KEY)
            || key["keyId"].as_str().is_none_or(str::is_empty)
            || !ids.insert(string(&key["keyId"]).map_err(|_| error(ERROR))?)
            || key["algorithm"] != "ed25519"
            || key["status"] != "active"
            || !key["revokedAt"].is_null()
            || effective >= expires
            || key["publicKeyPem"]
                .as_str()
                .is_none_or(|s| s.contains("PRIVATE KEY"))
            || key["roles"].as_array().is_none_or(Vec::is_empty)
        {
            return Err(error(ERROR));
        }
    }
    let mut body = envelope.clone();
    if let Some(map) = body.as_object_mut() {
        map.remove("signatures");
        map.remove("signature");
    }
    let bytes = canonical(&body)?;
    let mut roles = BTreeSet::new();
    let mut subjects = BTreeSet::new();
    let mut signer_ids = BTreeSet::new();
    let mut signers = Vec::new();
    for signature in signatures {
        let key_id = string(&signature["keyId"]).map_err(|_| error(ERROR))?;
        let role = string(&signature["role"]).map_err(|_| error(ERROR))?;
        let key = trust_keys
            .iter()
            .find(|k| k["keyId"] == key_id)
            .ok_or_else(|| error(ERROR))?;
        let effective = timestamp(&key["effectiveFrom"]).ok_or_else(|| error(ERROR))?;
        let expiry = timestamp(&key["expiresAt"]).ok_or_else(|| error(ERROR))?;
        if !keys(signature, &["algorithm", "keyId", "role", "value"])
            || signature["algorithm"] != "ed25519"
            || !signer_ids.insert(key_id)
            || key["roles"]
                .as_array()
                .is_none_or(|roles| !roles.iter().any(|v| v == role))
            || signed < effective
            || signed >= expiry
            || when < effective
            || when >= expiry
        {
            return Err(error(ERROR));
        }
        let pem = string(&key["publicKeyPem"]).map_err(|_| error(ERROR))?;
        let verifier = VerifyingKey::from_public_key_pem(pem).map_err(|_| error(ERROR))?;
        let signature = Base64::decode_vec(string(&signature["value"]).map_err(|_| error(ERROR))?)
            .map_err(|_| error(ERROR))?;
        let signature = Signature::from_slice(&signature).map_err(|_| error(ERROR))?;
        verifier
            .verify_strict(&bytes, &signature)
            .map_err(|_| error(ERROR))?;
        let subject = if truthy(&key["subjectId"]) {
            subject_string(&key["subjectId"])?
        } else {
            key_id.to_owned()
        };
        if !subjects.insert(subject.clone()) {
            return Err(error(ERROR));
        }
        roles.insert(role);
        signers.push(json!({"keyId":key_id,"subjectId":subject,"organization":if truthy(&key["organization"]) {key["organization"].clone()} else {Value::Null},"role":role}));
    }
    if !roles.contains("capability_owner") || !roles.contains("operational_observer") {
        return Err(error(ERROR));
    }
    Ok((envelope.clone(), trust.clone(), json!(signers)))
}
pub(super) fn inspect(
    db: &Connection,
    documents: Option<&PinnedMachineGenesisDocumentsV1>,
) -> Result<Value> {
    let row = one(
        db,
        "SELECT * FROM autonomous_research_machine_intake_metadata WHERE singleton=1",
    )?;
    let configuration = &row["configured_source_authority_hash"];
    let profile = &row["authorized_machine_producer_profile_hash"];
    if !sha(configuration)
        || !sha(profile)
        || row
            .get("authority_generation")
            .map(super::query::number)
            .unwrap_or(Some(1.))
            != Some(1.)
        || !row["last_authority_rotation_receipt_hash"].is_null()
    {
        return Err(error(ERROR));
    }
    let table = one(
        db,
        "SELECT name FROM sqlite_schema WHERE type='table' AND name='autonomous_research_machine_intake_authority_rotation'",
    )?;
    if !table.is_null() {
        let count: i64 = db.query_row(
            "SELECT count(*) FROM autonomous_research_machine_intake_authority_rotation",
            [],
            |r| r.get(0),
        )?;
        if count != 0 {
            return Err(error(ERROR));
        }
    }
    let genesis = rows(
        db,
        "SELECT * FROM autonomous_research_machine_intake_authority_genesis ORDER BY singleton",
        &[],
        2,
        4 * 1024 * 1024,
    )?;
    let [row] = genesis.as_slice() else {
        return Err(error(ERROR));
    };
    let payload = parsed(row, "genesis_payload_json")?;
    let persisted_envelope = parsed(row, "external_genesis_envelope_json")?;
    let persisted_trust = parsed(row, "owner_trust_store_snapshot_json")?;
    let persisted_signers = parsed(row, "verified_signers_json")?;
    if timestamp(&row["created_at"]).is_none() {
        return Err(error(ERROR));
    }
    let (envelope, trust, signers) = if row["origin"] == "fresh-v2-root-owned-configuration" {
        let trust = json!({"version":1,"kind":"AuthorityTrustStore","keys":[]});
        let trust_hash = hash("AuthorityTrustStore", &trust)?;
        let configuration_text = string(configuration)?;
        let profile_text = string(profile)?;
        let envelope = json!({"version":1,"kind":"AutonomousResearchMachineIntakeAuthorityGenesisEnvelope","status":"root_owned_configuration_genesis_verified","configurationHash":configuration,"producerProfileHash":profile,"authorityGeneration":1,"ownerTrustStoreHash":trust_hash,"nonce":format!("root-owned:{}:{}",&configuration_text[7..31],&profile_text[7..31]),"signedAt":row["created_at"],"validFrom":row["created_at"],"expiresAt":null,"signatures":[]});
        (envelope, trust, json!([]))
    } else {
        verify_external(
            documents.ok_or_else(|| error(ERROR))?,
            configuration,
            profile,
            &row["created_at"],
        )?
    };
    let equal = |a: &Value, b: &Value| -> Result<bool> {
        Ok(hash(
            "AutonomousResearchMachineIntakeAuthorityEvidenceEquality",
            a,
        )? == hash(
            "AutonomousResearchMachineIntakeAuthorityEvidenceEquality",
            b,
        )?)
    };
    if !keys(&payload, PAYLOAD)
        || payload["version"].as_f64() != Some(1.)
        || payload["kind"] != "AutonomousResearchMachineIntakeAuthorityGenesis"
        || row["singleton"].as_f64() != Some(1.)
        || !["fresh-v2-genesis", "fresh-v2-root-owned-configuration"]
            .iter()
            .any(|s| row["origin"] == *s)
        || row["authority_generation"].as_f64() != Some(1.)
        || row["created_at"] != envelope["validFrom"]
        || row["configuration_hash"] != *configuration
        || row["producer_profile_hash"] != *profile
        || payload["origin"] != row["origin"]
        || payload["configurationHash"] != row["configuration_hash"]
        || payload["producerProfileHash"] != row["producer_profile_hash"]
        || payload["authorityGeneration"].as_f64() != Some(1.)
        || payload["createdAt"] != row["created_at"]
        || payload["externalGenesisEnvelopeHash"] != row["external_genesis_envelope_hash"]
        || payload["ownerTrustStoreHash"] != row["owner_trust_store_hash"]
        || row["external_genesis_envelope_hash"]
            != hash(
                "AutonomousResearchMachineIntakeAuthorityGenesisEnvelope",
                &envelope,
            )?
        || row["owner_trust_store_hash"] != hash("AuthorityTrustStore", &trust)?
        || !equal(&persisted_envelope, &envelope)?
        || !equal(&persisted_trust, &trust)?
        || !equal(&persisted_signers, &signers)?
        || row["genesis_hash"] != hash("AutonomousResearchMachineIntakeAuthorityGenesis", &payload)?
    {
        return Err(error(ERROR));
    }
    Ok(json!({"machineIntakeConfigurationHash":configuration,"producerProfileHash":profile}))
}

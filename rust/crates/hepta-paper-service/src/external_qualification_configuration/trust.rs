use super::{
    Error, Result,
    files::{FileKind, Observations},
    value::*,
};
use ed25519_dalek::pkcs8::{DecodePublicKey, EncodePublicKey, PublicKeyBytes};
use hepta_legacy_compatibility::ProductionCollationV1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path};
use unicode_normalization::UnicodeNormalization;

const SIGNER_KEYS: &[&str] = &[
    "algorithm",
    "effectiveFrom",
    "expiresAt",
    "keyId",
    "keyVersion",
    "organization",
    "publicKeyPath",
    "revokedAt",
    "role",
    "status",
    "subjectId",
];

pub(super) struct Signer {
    pub identity: Value,
    pub pem: String,
    tuple: String,
}

pub(super) struct TrustSet {
    pub keys: Vec<Signer>,
    pub public_keys: Value,
    pub active_index: usize,
    pub hash: String,
}

pub(super) fn load_set(
    value: &Value,
    configuration: &Path,
    observed: &mut Observations,
) -> Result<TrustSet> {
    const INVALID: &str = "external_qualification_trusted_signer_trust_set_invalid";
    ensure(
        exact(value, &["keys", "kind", "version"])
            && value["version"].as_f64() == Some(1.0)
            && value["kind"] == "ResearchExecutionReleaseAttestorTrustSet"
            && value["keys"]
                .as_array()
                .is_some_and(|keys| (1..=32).contains(&keys.len())),
        INVALID,
    )?;
    let values = value["keys"]
        .as_array()
        .ok_or_else(|| Error::new(INVALID))?;
    let mut keys = values
        .iter()
        .map(|value| load_signer(value, false, configuration, observed))
        .collect::<Result<Vec<_>>>()?;
    let collator = ProductionCollationV1::load()
        .map_err(|_| Error::new("external_qualification_json_profile_unsupported"))?;
    keys.sort_by(|left, right| collator.compare(&left.tuple, &right.tuple));
    let mut tuples = BTreeSet::new();
    let mut hashes = BTreeSet::new();
    let mut active = None;
    let mut active_count = 0usize;
    for (index, key) in keys.iter().enumerate() {
        ensure(
            tuples.insert(key.tuple.clone())
                && hashes.insert(string(&key.identity["publicKeySpkiHash"])),
            "external_qualification_trusted_signer_trust_set_identity_collision",
        )?;
        if key.identity["signer"]["status"] == "active"
            && key.identity["signer"]["revokedAt"].is_null()
        {
            active = Some(index);
            active_count += 1;
        }
    }
    const ACTIVE: &str = "external_qualification_exactly_one_active_trusted_signer_required";
    ensure(active_count == 1, ACTIVE)?;
    let active_index = active.ok_or_else(|| Error::new(ACTIVE))?;
    let public_keys = Value::Array(
        keys.iter()
            .map(|key| {
                let mut signer = key.identity["signer"].clone();
                signer["publicKeySpkiHash"] = key.identity["publicKeySpkiHash"].clone();
                signer
            })
            .collect(),
    );
    let hash = hash(
        "ResearchExecutionReleaseAttestorTrustSet",
        &json!({"version": 1, "keys": public_keys}),
    )?;
    Ok(TrustSet {
        keys,
        public_keys,
        active_index,
        hash,
    })
}

pub(super) fn load_signer(
    value: &Value,
    verifier: bool,
    configuration: &Path,
    observed: &mut Observations,
) -> Result<Signer> {
    let label = if verifier {
        "verifier_attestor"
    } else {
        "trusted_signer"
    };
    let invalid = format!("external_qualification_{label}_invalid");
    let role = if verifier {
        "external_qualification_independent_verifier"
    } else {
        "research_execution_release_attestor"
    };
    let effective = canonical(&value["effectiveFrom"]);
    let expiry = canonical(&value["expiresAt"]);
    let revoked = canonical(&value["revokedAt"]);
    ensure(
        exact(value, SIGNER_KEYS)
            && safe_id(&value["keyId"], 3)
            && safe_id(&value["keyVersion"], 1)
            && safe_id(&value["subjectId"], 3)
            && value["organization"]
                .as_str()
                .is_some_and(organization_valid)
            && value["algorithm"] == "ed25519"
            && value["role"] == role
            && (value["status"] == "active" || (!verifier && value["status"] == "retiring"))
            && (!verifier || value["revokedAt"].is_null())
            && (value["revokedAt"].is_null() || revoked.is_some())
            && matches!((effective, expiry), (Some(start), Some(end)) if end > start),
        &invalid,
    )?;
    let file = observed.file(
        &relative(&value["publicKeyPath"], configuration)?,
        FileKind::PublicKey,
    )?;
    let invalid_key = format!("external_qualification_{label}_public_key_invalid");
    let text = String::from_utf8_lossy(&file.bytes);
    ensure(
        !text.contains("-----BEGIN PRIVATE KEY-----")
            && !text.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----"),
        &invalid_key,
    )?;
    let start = text
        .find("-----BEGIN PUBLIC KEY-----")
        .ok_or_else(|| Error::new(&invalid_key))?;
    let tail = &text[start..];
    let end = tail
        .find("-----END PUBLIC KEY-----")
        .ok_or_else(|| Error::new(&invalid_key))?
        + "-----END PUBLIC KEY-----".len();
    let pem = tail[..end].to_owned();
    // PublicKeyBytes parses the Ed25519 SPKI without imposing signature-point
    // validity rules which Node's configuration reader does not apply.
    let key = PublicKeyBytes::from_public_key_pem(&pem).map_err(|_| Error::new(&invalid_key))?;
    let der = key
        .to_public_key_der()
        .map_err(|_| Error::new(&invalid_key))?;
    let spki_hash = format!("sha256:{}", hex::encode(Sha256::digest(der.as_bytes())));
    let signer = json!({
        "keyId": string(&value["keyId"]), "keyVersion": string(&value["keyVersion"]),
        "subjectId": string(&value["subjectId"]), "organization": value["organization"],
        "role": value["role"], "algorithm": value["algorithm"], "status": value["status"],
        "effectiveFrom": value["effectiveFrom"], "expiresAt": value["expiresAt"], "revokedAt": value["revokedAt"],
    });
    let tuple = format!(
        "{}:{}",
        string(&value["keyId"]),
        string(&value["keyVersion"])
    );
    Ok(Signer {
        identity: json!({"signer": signer, "publicKeyContentHash": file.hash, "publicKeySpkiHash": spki_hash}),
        pem,
        tuple,
    })
}

fn canonical(value: &Value) -> Option<i64> {
    crate::journal_connector_coverage::qualification::canonical_instant_millis(value.as_str()?)
}

fn organization_valid(value: &str) -> bool {
    (1..=160).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b" ._():-".contains(&byte))
}

fn organization_identity(value: &Value) -> String {
    string(value)
        .nfkc()
        .collect::<String>()
        .split(whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub(super) fn verify_independence(trusted: &TrustSet, verifier: &Signer) -> Result<()> {
    let verifier_signer = &verifier.identity["signer"];
    ensure(
        !trusted.keys.iter().any(|key| {
            key.identity["signer"]["keyId"] == verifier_signer["keyId"]
                || key.identity["signer"]["subjectId"] == verifier_signer["subjectId"]
                || key.identity["publicKeySpkiHash"] == verifier.identity["publicKeySpkiHash"]
        }),
        "external_qualification_independent_verifier_attestor_required",
    )?;
    let organization = organization_identity(&verifier_signer["organization"]);
    ensure(
        !organization.is_empty()
            && !trusted.keys.iter().any(|key| {
                organization_identity(&key.identity["signer"]["organization"]) == organization
            }),
        "external_qualification_independent_verifier_organization_required",
    )
}

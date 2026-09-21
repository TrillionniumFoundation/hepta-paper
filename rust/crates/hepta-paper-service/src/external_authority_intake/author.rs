//! Passive Rust verifier for the externally provisioned research-author
//! identity configuration.
//!
//! This module intentionally has no provider, signer, or state boundary.  It
//! reads one pinned JSON configuration, verifies the independently provisioned
//! Ed25519 evidence, and returns the same fail-closed inspection fields as the
//! incumbent Node composition.  A v1 configuration is parsed and reported but
//! cannot become runtime-ready: the stable identity policy is a v2 contract.

use base64ct::{Base64, Encoding};
use ed25519_dalek::pkcs8::{DecodePublicKey, EncodePublicKey};
use ed25519_dalek::{Signature, VerifyingKey};
use hepta_legacy_compatibility::{
    ProductionCollationV1, production_hash_record_v1, production_stable_json_v1,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

mod wire_order;

const SUBJECT_KIND: &str = "ExternalPrincipalIdentityAttestationSubject";
const CONFIG_KIND: &str = "AutonomousResearchAuthorIdentityConfiguration";
const SIGNER_ROLE: &str = "external_principal_identity_attestor";
const MAXIMUM_CONFIG_BYTES: u64 = 1024 * 1024;
const SHA256_PREFIX: &str = "sha256:";

const CONFIG_V1_KEYS: &[&str] = &[
    "authorityEnvelope",
    "configurationHash",
    "kind",
    "maximumLifetimeMs",
    "signerKeyIds",
    "signerRole",
    "status",
    "subject",
    "trustStore",
    "trustStoreHash",
    "version",
];
const CONFIG_V2_KEYS: &[&str] = &[
    "authorityEnvelope",
    "configurationHash",
    "identityPolicy",
    "kind",
    "maximumLifetimeMs",
    "signerKeyIds",
    "signerRole",
    "status",
    "subject",
    "trustStore",
    "trustStoreHash",
    "version",
];
const SUBJECT_KEYS: &[&str] = &[
    "assuranceProfile",
    "attestedAt",
    "challengeHash",
    "credentialRootIdentityHash",
    "expiresAt",
    "hostIdentityHash",
    "kind",
    "principalId",
    "processIdentityHash",
    "provider",
    "providerAccountIdentityHash",
    "serviceId",
    "signerPublicKeySpkiHash",
    "trustDomainIdentityHash",
    "version",
];
const POLICY_KEYS: &[&str] = &[
    "assuranceProfile",
    "credentialRootIdentityHash",
    "kind",
    "platformAttestationRequired",
    "principalId",
    "provider",
    "providerAccountIdentityHash",
    "serviceId",
    "signerPublicKeySpkiHash",
    "trustDomainIdentityHash",
    "version",
];
const ENVELOPE_KEYS: &[&str] = &[
    "expiresAt",
    "kind",
    "signatures",
    "signedAt",
    "subjectHash",
    "subjectKind",
    "version",
];
const SIGNATURE_KEYS: &[&str] = &["algorithm", "keyId", "role", "value"];
const TRUST_KEY_KEYS: &[&str] = &[
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

fn exact(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

fn string(value: &Value) -> Option<&str> {
    value.as_str()
}

fn sha(value: &Value) -> bool {
    let Some(value) = string(value) else {
        return false;
    };
    value.strip_prefix(SHA256_PREFIX).is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn sha_string(value: &str) -> bool {
    value.strip_prefix(SHA256_PREFIX).is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn identifier(value: &Value) -> bool {
    let Some(value) = string(value) else {
        return false;
    };
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 192
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(byte))
}

fn instant(value: &Value) -> Option<i64> {
    let text = string(value)?.as_bytes();
    if text.len() != 24
        || text[4] != b'-'
        || text[7] != b'-'
        || text[10] != b'T'
        || text[13] != b':'
        || text[16] != b':'
        || text[19] != b'.'
        || text[23] != b'Z'
    {
        return None;
    }
    let number = |a: usize, b: usize| {
        let value = &text[a..b];
        value.iter().all(u8::is_ascii_digit).then(|| {
            value
                .iter()
                .fold(0_i64, |acc, byte| acc * 10 + i64::from(byte - b'0'))
        })
    };
    let (year, month, day, hour, minute, second, millis) = (
        number(0, 4)?,
        number(5, 7)?,
        number(8, 10)?,
        number(11, 13)?,
        number(14, 16)?,
        number(17, 19)?,
        number(20, 23)?,
    );
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    };
    if day < 1 || day > max_day || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let adjusted = year - i64::from(month <= 2);
    let era = if adjusted >= 0 {
        adjusted
    } else {
        adjusted - 399
    } / 400;
    let year_of_era = adjusted - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let days = era * 146097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year
        - 719468;
    Some(((days * 24 + hour) * 60 + minute) * 60000 + second * 1000 + millis)
}

pub(super) fn is_canonical_instant(value: &str) -> bool {
    instant(&Value::String(value.to_owned())).is_some()
}

fn canonical_hash(kind: &str, value: &Value) -> Option<String> {
    production_hash_record_v1(kind, value)
        .ok()
        .map(|hash| hash.as_str().to_owned())
}

fn normalize_numbers(value: &mut Value) {
    match value {
        Value::Number(_) => {
            if let Some(normalized) = production_stable_json_v1(value)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            {
                *value = normalized;
            }
        }
        Value::Array(values) => values.iter_mut().for_each(normalize_numbers),
        Value::Object(values) => values.values_mut().for_each(normalize_numbers),
        _ => {}
    }
}

fn bytes_hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// Open a single regular, non-link, owner-private file and make sure its
/// identity did not change while it was read. Relative and dotted paths use
/// the same lexical `path.resolve` behavior as the incumbent Node command;
/// the final real path must still equal that normalized candidate.
fn resolve_path(path: &Path) -> Option<PathBuf> {
    let source = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    let mut resolved = PathBuf::new();
    for component in source.components() {
        match component {
            Component::Prefix(_) => return None,
            Component::RootDir => resolved.push("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                if resolved != Path::new("/") && !resolved.pop() {
                    return None;
                }
            }
            Component::Normal(value) => resolved.push(value),
        }
    }
    resolved.is_absolute().then_some(resolved)
}

fn read_pinned(path: &Path) -> Option<Vec<u8>> {
    let candidate = resolve_path(path)?;
    let canonical = fs::canonicalize(&candidate).ok()?;
    if canonical != candidate {
        return None;
    }
    let before = fs::symlink_metadata(&candidate).ok()?;
    let uid = nix::unistd::Uid::current().as_raw();
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.nlink() != 1
        || before.len() < 1
        || before.len() > MAXIMUM_CONFIG_BYTES
        || (before.mode() & 0o022) != 0
        || (before.uid() != 0 && before.uid() != uid)
    {
        return None;
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(&candidate)
        .ok()?;
    let opened = file.metadata().ok()?;
    if !same_identity(&before, &opened) {
        return None;
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAXIMUM_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let after = file.metadata().ok()?;
    let path_after = fs::symlink_metadata(&candidate).ok()?;
    (bytes.len() as u64 == before.len()
        && same_identity(&before, &after)
        && same_identity(&before, &path_after))
    .then_some(bytes)
}

fn same_identity(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.nlink() == right.nlink()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

fn blocked(blocker: &str) -> Value {
    json!({
        "status": "production_external_author_identity_input_blocked",
        "readyForRuntimeBinding": false,
        "configured": false,
        "configurationVersion": null,
        "stablePolicyPinned": false,
        "configurationPinned": false,
        "observedConfigurationHash": null,
        "authoritySubjectHash": null,
        "authorityEnvelopeHash": null,
        "authorityVerificationReceiptHash": null,
        "attestationExpiresAt": null,
        "cryptographicAuthorityReady": false,
        "externalActionPerformed": false,
        "blockers": [blocker]
    })
}

fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut result = Vec::new();
    for value in values {
        if !result.contains(&value) {
            result.push(value);
        }
    }
    result
}

fn subject_valid(subject: &Value, now: Option<i64>, maximum_lifetime: u64) -> bool {
    let Some(object) = subject.as_object() else {
        return false;
    };
    let Some(hash) = object.get("externalPrincipalIdentityAttestationSubjectHash") else {
        return false;
    };
    let payload = Value::Object(
        object
            .iter()
            .filter(|(key, _)| *key != "externalPrincipalIdentityAttestationSubjectHash")
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    );
    exact(&payload, SUBJECT_KEYS)
        && sha(hash)
        && canonical_hash(SUBJECT_KIND, &payload).as_deref() == string(hash)
        && payload["version"] == 1
        && payload["kind"] == SUBJECT_KIND
        && ["serviceId", "principalId", "provider"]
            .iter()
            .all(|key| identifier(&payload[*key]))
        && [
            "providerAccountIdentityHash",
            "credentialRootIdentityHash",
            "hostIdentityHash",
            "processIdentityHash",
            "trustDomainIdentityHash",
            "signerPublicKeySpkiHash",
            "challengeHash",
        ]
        .iter()
        .all(|key| sha(&payload[*key]))
        && matches!(
            string(&payload["assuranceProfile"]),
            Some("operator-attested-external-principal-v1")
                | Some("pinned-provider-account-attestation-v1")
                | Some("pinned-provider-account-and-platform-attestation-v1")
        )
        && instant(&payload["attestedAt"])
            .zip(instant(&payload["expiresAt"]))
            .is_some_and(|(start, end)| {
                end > start
                    && end - start <= maximum_lifetime as i64
                    && now.is_none_or(|at| at >= start && at < end)
            })
}

fn policy_for(subject: &Value) -> Option<Value> {
    Some(json!({
        "version": 1,
        "kind": "AutonomousResearchAuthorIdentityPolicy",
        "serviceId": subject["serviceId"],
        "principalId": subject["principalId"],
        "provider": subject["provider"],
        "providerAccountIdentityHash": subject["providerAccountIdentityHash"],
        "credentialRootIdentityHash": subject["credentialRootIdentityHash"],
        "trustDomainIdentityHash": subject["trustDomainIdentityHash"],
        "signerPublicKeySpkiHash": subject["signerPublicKeySpkiHash"],
        "assuranceProfile": subject["assuranceProfile"],
        "platformAttestationRequired": true,
    }))
}

#[derive(Clone)]
struct TrustKey {
    value: Value,
    key: VerifyingKey,
    spki_hash: String,
}

struct TrustStore {
    keys: Vec<TrustKey>,
    hash: String,
}

fn parse_trust_store(value: &Value, expected_ids: &[String]) -> Result<TrustStore, String> {
    if !exact(value, &["version", "kind", "keys"])
        || value["version"] != 1
        || value["kind"] != "AuthorityTrustStore"
        || !value["keys"]
            .as_array()
            .is_some_and(|keys| (1..=256).contains(&keys.len()))
    {
        return Err("pinned_external_evidence_trust_store_invalid".into());
    }
    let mut keys = Vec::new();
    let mut ids = BTreeSet::new();
    let mut spkis = BTreeSet::new();
    let mut input_ids = Vec::new();
    for candidate in value["keys"].as_array().expect("checked above") {
        if !exact(candidate, TRUST_KEY_KEYS)
            || !identifier(&candidate["keyId"])
            || !identifier(&candidate["subjectId"])
            || candidate["algorithm"] != "ed25519"
            || candidate["status"] != "active"
            || (!candidate["organization"].is_null() && !candidate["organization"].is_string())
        {
            return Err("pinned_external_evidence_trust_key_invalid".into());
        }
        let roles = candidate["roles"]
            .as_array()
            .ok_or("pinned_external_evidence_trust_key_invalid")?;
        let raw_roles = roles
            .iter()
            .map(|role| role.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or("pinned_external_evidence_trust_key_invalid")?;
        let mut canonical_roles = raw_roles.clone();
        canonical_roles.sort();
        canonical_roles.dedup();
        if roles.is_empty()
            || raw_roles != canonical_roles
            || raw_roles
                .iter()
                .any(|role| !identifier(&Value::String(role.clone())))
            || candidate["publicKeyPem"]
                .as_str()
                .is_none_or(|pem| pem.contains("PRIVATE KEY"))
        {
            return Err("pinned_external_evidence_trust_key_invalid".into());
        }
        for key in ["effectiveFrom", "expiresAt", "revokedAt"] {
            if !candidate[key].is_null() && instant(&candidate[key]).is_none() {
                return Err("pinned_external_evidence_trust_key_invalid".into());
            }
        }
        if let (Some(start), Some(end)) = (
            instant(&candidate["effectiveFrom"]),
            instant(&candidate["expiresAt"]),
        ) && end <= start
        {
            return Err("pinned_external_evidence_trust_key_invalid".into());
        }
        let pem = candidate["publicKeyPem"]
            .as_str()
            .ok_or("pinned_external_evidence_trust_key_invalid")?;
        let key = VerifyingKey::from_public_key_pem(pem)
            .map_err(|_| "pinned_external_evidence_trust_key_invalid")?;
        let der = key
            .to_public_key_der()
            .map_err(|_| "pinned_external_evidence_trust_key_invalid")?;
        let spki_hash = bytes_hash(der.as_bytes());
        let id = candidate["keyId"].as_str().unwrap().to_owned();
        input_ids.push(id.clone());
        if !ids.insert(id.clone()) || !spkis.insert(spki_hash.clone()) {
            return Err("pinned_external_evidence_trust_key_invalid".into());
        }
        let canonical = json!({
            "keyId": id, "subjectId": candidate["subjectId"], "organization": candidate["organization"],
            "algorithm": "ed25519", "publicKeyPem": pem, "roles": canonical_roles, "status": "active",
            "effectiveFrom": candidate["effectiveFrom"], "expiresAt": candidate["expiresAt"], "revokedAt": candidate["revokedAt"],
        });
        keys.push(TrustKey {
            value: canonical,
            key,
            spki_hash,
        });
    }
    let role_ok = keys.iter().any(|key| {
        key.value["roles"]
            .as_array()
            .is_some_and(|roles| roles.iter().any(|role| role == SIGNER_ROLE))
    });
    if !role_ok {
        return Err("pinned_external_evidence_trust_role_missing".into());
    }
    let collation = ProductionCollationV1::load()
        .map_err(|_| "pinned_external_evidence_trust_store_invalid")?;
    if input_ids
        .windows(2)
        .any(|window| collation.compare(&window[0], &window[1]).is_gt())
    {
        return Err("pinned_external_evidence_trust_key_invalid".into());
    }
    if expected_ids.is_empty() || expected_ids.iter().any(|id| !ids.contains(id)) {
        return Err("pinned_external_evidence_expected_key_missing".into());
    }
    keys.sort_by(|left, right| {
        collation.compare(
            left.value["keyId"].as_str().unwrap(),
            right.value["keyId"].as_str().unwrap(),
        )
    });
    let canonical = json!({"version":1,"kind":"AuthorityTrustStore","keys":keys.iter().map(|key| key.value.clone()).collect::<Vec<_>>()});
    let hash = canonical_hash("PinnedExternalEvidenceTrustStore", &canonical)
        .ok_or("pinned_external_evidence_trust_store_invalid")?;
    Ok(TrustStore { keys, hash })
}

type EnvelopeVerification = (String, String, Vec<String>, Vec<String>, Vec<String>);

struct EnvelopeErrors(Vec<String>);

impl From<&str> for EnvelopeErrors {
    fn from(value: &str) -> Self {
        Self(vec![value.to_owned()])
    }
}

// The incumbent coerces the three signature reference fields with
// String(value || ''). Arrays therefore retain Array#join semantics.
fn javascript_string(value: &Value) -> Option<String> {
    Some(match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(_) => String::from_utf8(production_stable_json_v1(value).ok()?).ok()?,
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    Some(String::new())
                } else {
                    javascript_string(value)
                }
            })
            .collect::<Option<Vec<_>>>()?
            .join(","),
        Value::Object(value) => {
            if value.contains_key("toString") {
                return None;
            }
            "[object Object]".to_owned()
        }
    })
}

fn signature_string(value: &Value) -> Result<String, EnvelopeErrors> {
    if value.is_null() || value == false || value.as_f64().is_some_and(|number| number == 0.0) {
        return Ok(String::new());
    }
    javascript_string(value)
        .ok_or_else(|| "immutable_signed_json_authority_signature_invalid".into())
}

fn envelope_valid(
    value: &Value,
    subject_hash: &str,
    trust: &TrustStore,
    expected_ids: &[String],
    now: i64,
    maximum_lifetime: u64,
) -> Result<EnvelopeVerification, EnvelopeErrors> {
    if !exact(value, ENVELOPE_KEYS) {
        return Err("pinned_external_evidence_envelope_shape_invalid".into());
    }
    if value["version"] != 1
        || value["kind"] != "PinnedExternalEvidenceEnvelope"
        || !identifier(&value["subjectKind"])
        || !sha(&value["subjectHash"])
        || value["subjectKind"] != SUBJECT_KIND
        || value["subjectHash"] != subject_hash
        || !value["signatures"]
            .as_array()
            .is_some_and(|items| (1..=16).contains(&items.len()))
    {
        return Err("pinned_external_evidence_envelope_invalid".into());
    }
    let signed = instant(&value["signedAt"]).ok_or("pinned_external_evidence_envelope_invalid")?;
    let expires =
        instant(&value["expiresAt"]).ok_or("pinned_external_evidence_envelope_invalid")?;
    if expires <= signed
        || signed > now
        || expires <= now
        || expires - signed > maximum_lifetime as i64
    {
        return Err("immutable_signed_json_authority_time_window_invalid".into());
    }
    let payload = Value::Object(
        value
            .as_object()
            .unwrap()
            .iter()
            .filter(|(key, _)| *key != "signatures")
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    );
    let payload_bytes = canonical_json(&payload);
    let signatures = value["signatures"].as_array().unwrap();
    let mut seen = BTreeSet::new();
    let mut verified = Vec::new();
    for signature in signatures {
        let key_id = signature_string(&signature["keyId"])?;
        if !exact(signature, SIGNATURE_KEYS)
            || signature["algorithm"] != "ed25519"
            || signature_string(&signature["role"])? != SIGNER_ROLE
            || key_id.is_empty()
            || !seen.insert(key_id.clone())
        {
            return Err("immutable_signed_json_authority_signature_invalid".into());
        }
        let key = trust
            .keys
            .iter()
            .find(|key| key.value["keyId"] == key_id)
            .ok_or("immutable_signed_json_authority_signature_invalid")?;
        if !key.value["roles"]
            .as_array()
            .is_some_and(|roles| roles.iter().any(|role| role == SIGNER_ROLE))
        {
            return Err("immutable_signed_json_authority_signature_invalid".into());
        }
        let encoded = signature_string(&signature["value"])?;
        let bytes = Base64::decode_vec(&encoded)
            .map_err(|_| "immutable_signed_json_authority_signature_invalid")?;
        if bytes.len() != 64 || Base64::encode_string(&bytes) != encoded {
            return Err("immutable_signed_json_authority_signature_invalid".into());
        }
        let signature = Signature::from_slice(&bytes)
            .map_err(|_| "immutable_signed_json_authority_signature_invalid")?;
        key.key
            .verify_strict(&payload_bytes, &signature)
            .map_err(|_| "immutable_signed_json_authority_signature_invalid")?;
        verified.push(key_id);
    }
    verified.sort();
    let mut blockers = Vec::new();
    if verified != expected_ids {
        blockers.push("pinned_external_evidence_signer_key_binding_invalid".to_owned());
    }
    // Node finishes every signature before evaluating key-time policy, so a
    // later bad signature takes precedence over an earlier expired key.
    for key_id in &verified {
        let key = trust
            .keys
            .iter()
            .find(|key| key.value["keyId"] == *key_id)
            .unwrap();
        let effective = instant(&key.value["effectiveFrom"]);
        let key_expires = instant(&key.value["expiresAt"]);
        let revoked = instant(&key.value["revokedAt"]);
        if effective.is_some_and(|at| signed < at)
            || key_expires.is_some_and(|at| signed >= at)
            || revoked.is_some_and(|at| signed >= at)
        {
            blockers.push("pinned_external_evidence_signer_outside_key_time_window".to_owned());
        }
    }
    if !blockers.is_empty() {
        return Err(EnvelopeErrors(unique(blockers)));
    }
    let envelope_hash = canonical_hash("PinnedExternalEvidenceEnvelope", value)
        .ok_or("pinned_external_evidence_envelope_invalid")?;
    let mut verified_subject_ids = verified
        .iter()
        .filter_map(|key_id| {
            trust
                .keys
                .iter()
                .find(|key| key.value["keyId"] == *key_id)
                .and_then(|key| key.value["subjectId"].as_str())
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    let mut verified_spki_hashes = verified
        .iter()
        .filter_map(|key_id| {
            trust
                .keys
                .iter()
                .find(|key| key.value["keyId"] == *key_id)
                .map(|key| key.spki_hash.clone())
        })
        .collect::<Vec<_>>();
    verified_subject_ids.sort();
    verified_spki_hashes.sort();
    Ok((
        envelope_hash,
        value["expiresAt"].as_str().unwrap().to_owned(),
        verified,
        verified_subject_ids,
        verified_spki_hashes,
    ))
}

fn canonical_envelope_hash(value: &Value) -> Option<String> {
    if !exact(value, ENVELOPE_KEYS)
        || value["version"] != 1
        || value["kind"] != "PinnedExternalEvidenceEnvelope"
        || !identifier(&value["subjectKind"])
        || !sha(&value["subjectHash"])
        || instant(&value["signedAt"])
            .zip(instant(&value["expiresAt"]))
            .is_none_or(|(signed, expires)| expires <= signed)
        || !value["signatures"].as_array().is_some_and(|items| {
            (1..=16).contains(&items.len()) && items.iter().all(|item| exact(item, SIGNATURE_KEYS))
        })
    {
        return None;
    }
    canonical_hash("PinnedExternalEvidenceEnvelope", value)
}

fn blocked_receipt_hash(
    subject_hash: &str,
    envelope_hash: &str,
    trust_hash: &str,
    now: &str,
    blockers: &[String],
) -> Option<String> {
    let payload = json!({
        "version": 1,
        "kind": "PinnedExternalEvidenceVerificationReceipt",
        "status": "pinned_external_evidence_verification_blocked",
        "verificationPolicy": "pinned-canonical-json-ed25519-v1",
        "subjectKind": SUBJECT_KIND,
        "subjectHash": subject_hash,
        "requiredRole": SIGNER_ROLE,
        "trustStoreHash": trust_hash,
        "envelopeHash": envelope_hash,
        "verifiedKeyIds": [],
        "verifiedSubjectIds": [],
        "verifiedPublicKeySpkiHashes": [],
        "signedAt": null,
        "expiresAt": null,
        "verifiedAt": now,
        "cryptographicAuthorityReady": false,
        "externalActionPerformed": false,
        "blockers": blockers,
    });
    canonical_hash("PinnedExternalEvidenceVerificationReceipt", &payload)
}

fn canonical_json(value: &Value) -> Vec<u8> {
    match value {
        Value::Object(object) => {
            let mut fields = object.iter().collect::<Vec<_>>();
            fields.sort_by(|left, right| left.0.cmp(right.0));
            let mut out = Vec::from(*b"{");
            for (index, (key, value)) in fields.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                out.extend(serde_json::to_vec(key).unwrap());
                out.push(b':');
                out.extend(canonical_json(value));
            }
            out.push(b'}');
            out
        }
        Value::Array(items) => {
            let mut out = Vec::from(*b"[");
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                out.extend(canonical_json(item));
            }
            out.push(b']');
            out
        }
        _ => serde_json::to_vec(value).unwrap_or_default(),
    }
}

/// Inspect an author configuration without invoking any external action.
pub(super) fn inspect_author(path: Option<&Path>, expected_hash: Option<&str>, now: &str) -> Value {
    let Some(path) = path else {
        return blocked("autonomous_research_author_identity_configuration_path_missing");
    };
    let Some(bytes) = read_pinned(path) else {
        return blocked("autonomous_research_author_identity_configuration_file_invalid");
    };
    let mut parsed = match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) => value,
        Err(_) => return blocked("autonomous_research_author_identity_configuration_file_invalid"),
    };
    if !wire_order::canonical_configuration_key_order(&bytes) {
        return blocked("autonomous_research_author_identity_configuration_verification_failed");
    }
    normalize_numbers(&mut parsed);
    let version = parsed["version"].as_u64();
    let keys = if version == Some(2) {
        CONFIG_V2_KEYS
    } else {
        CONFIG_V1_KEYS
    };
    let valid_shape = exact(&parsed, keys)
        && version.is_some_and(|version| version == 1 || version == 2)
        && parsed["kind"] == CONFIG_KIND
        && parsed["status"] == "autonomous_research_author_identity_configured"
        && parsed["signerRole"] == SIGNER_ROLE
        && parsed["signerKeyIds"]
            .as_array()
            .is_some_and(|ids| (1..=4).contains(&ids.len()) && ids.iter().all(identifier))
        && parsed["maximumLifetimeMs"]
            .as_u64()
            .is_some_and(|lifetime| (1_000..=86_400_000).contains(&lifetime));
    let observed_hash = parsed["configurationHash"].as_str().map(str::to_owned);
    let configuration_payload = parsed.as_object().map(|object| {
        Value::Object(
            object
                .iter()
                .filter(|(key, _)| *key != "configurationHash")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        )
    });
    let configuration_hash_valid = configuration_payload
        .as_ref()
        .and_then(|payload| canonical_hash(CONFIG_KIND, payload))
        .as_deref()
        == observed_hash.as_deref();
    if !valid_shape
        || !observed_hash.as_deref().is_some_and(sha_string)
        || !configuration_hash_valid
    {
        return blocked("autonomous_research_author_identity_configuration_verification_failed");
    }
    // `readAutonomousResearchAuthorIdentityConfiguration` verifies the full
    // static configuration before the composition exposes a configured
    // report.  Keep that distinction: malformed subjects, trust stores,
    // policies, and envelope bindings are configuration failures, while an
    // otherwise valid configuration with an expired subject/signature is a
    // configured-but-blocked inspection.
    let static_subject = &parsed["subject"];
    // The incumbent builder validates the subject against this configuration's
    // selected lifetime, rather than the verifier's wider default window.
    // Keep that distinction so a recomputed hash cannot make an overlong
    // subject appear statically configured.
    let static_lifetime = parsed["maximumLifetimeMs"].as_u64().unwrap();
    let static_subject_valid = subject_valid(static_subject, None, static_lifetime)
        && static_subject["assuranceProfile"]
            == "pinned-provider-account-and-platform-attestation-v1";
    let static_policy_valid = version != Some(2)
        || (exact(&parsed["identityPolicy"], POLICY_KEYS)
            && policy_for(static_subject).as_ref() == Some(&parsed["identityPolicy"]));
    let static_input_ids = parsed["signerKeyIds"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut static_ids = static_input_ids.clone();
    static_ids.sort();
    static_ids.dedup();
    let static_ids_valid = static_ids == static_input_ids;
    let static_trust = parse_trust_store(&parsed["trustStore"], &static_ids);
    let static_trust_valid = static_trust
        .as_ref()
        .is_ok_and(|trust| parsed["trustStoreHash"] == trust.hash);
    let static_envelope_valid =
        canonical_envelope_hash(&parsed["authorityEnvelope"]).is_some_and(|_| {
            parsed["authorityEnvelope"]["subjectKind"] == SUBJECT_KIND
                && parsed["authorityEnvelope"]["subjectHash"]
                    == static_subject["externalPrincipalIdentityAttestationSubjectHash"]
        });
    if !static_subject_valid
        || !static_policy_valid
        || !static_ids_valid
        || !static_trust_valid
        || !static_envelope_valid
    {
        return blocked("autonomous_research_author_identity_configuration_verification_failed");
    }
    let mut report =
        blocked("autonomous_research_author_identity_configuration_verification_failed");
    let object = report.as_object_mut().unwrap();
    object.insert("configured".into(), Value::Bool(true));
    object.insert("configurationVersion".into(), parsed["version"].clone());
    object.insert(
        "observedConfigurationHash".into(),
        Value::String(observed_hash.clone().unwrap()),
    );
    let expected = expected_hash.map(str::to_ascii_lowercase);
    let pin_blocker = match expected.as_deref() {
        None => Some("autonomous_research_author_identity_configuration_pin_required"),
        Some(expected) if expected != observed_hash.as_deref().unwrap() => {
            Some("autonomous_research_author_identity_configuration_pin_mismatch")
        }
        Some(_) => None,
    };
    let configuration_pinned = pin_blocker.is_none();
    let mut blockers = pin_blocker
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let lifetime = parsed["maximumLifetimeMs"].as_u64().unwrap();
    let subject = &parsed["subject"];
    let subject_hash = subject["externalPrincipalIdentityAttestationSubjectHash"]
        .as_str()
        .unwrap_or_default();
    let subject_current = instant(&Value::String(now.to_owned()))
        .zip(instant(&subject["attestedAt"]))
        .zip(instant(&subject["expiresAt"]))
        .is_some_and(|((at, start), end)| at >= start && at < end);
    let platform =
        subject["assuranceProfile"] == "pinned-provider-account-and-platform-attestation-v1";
    if version != Some(2) {
        blockers.push("autonomous_research_author_identity_stable_policy_v2_required".into());
    }
    if !subject_valid(subject, instant(&Value::String(now.to_owned())), lifetime)
        || !platform
        || !subject_current
    {
        blockers.push("autonomous_research_author_identity_subject_not_current".into());
    }
    if version == Some(2)
        && (!exact(&parsed["identityPolicy"], POLICY_KEYS)
            || policy_for(subject).as_ref() != Some(&parsed["identityPolicy"]))
    {
        blockers.push("autonomous_research_author_identity_policy_binding_invalid".into());
    }
    let input_trust_ids = parsed["signerKeyIds"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut trust_ids = input_trust_ids.clone();
    trust_ids.sort();
    trust_ids.dedup();
    if trust_ids != input_trust_ids {
        blockers
            .push("autonomous_research_author_identity_configuration_verification_failed".into());
    }
    let trust = parse_trust_store(&parsed["trustStore"], &trust_ids);
    let trust = match trust {
        Ok(trust) => trust,
        Err(blocker) => {
            blockers.push(blocker);
            object.insert("blockers".into(), json!(unique(blockers)));
            return report;
        }
    };
    if parsed["trustStoreHash"] != trust.hash {
        blockers
            .push("autonomous_research_author_identity_configuration_verification_failed".into());
    }
    let envelope = envelope_valid(
        &parsed["authorityEnvelope"],
        subject_hash,
        &trust,
        &trust_ids,
        instant(&Value::String(now.to_owned())).unwrap_or_default(),
        lifetime,
    );
    let envelope_candidate_hash = canonical_envelope_hash(&parsed["authorityEnvelope"]);
    let mut envelope_hash = None;
    let mut receipt_hash = None;
    let mut expires_at = None;
    let cryptographic_ready = if let Ok((
        hash,
        expires,
        verified_key_ids,
        verified_subject_ids,
        verified_spki_hashes,
    )) = &envelope
    {
        envelope_hash = Some(hash.clone());
        expires_at = Some(expires.clone());
        let receipt = json!({
            "version": 1, "kind": "PinnedExternalEvidenceVerificationReceipt", "status": "pinned_external_evidence_verified",
            "verificationPolicy": "pinned-canonical-json-ed25519-v1", "subjectKind": SUBJECT_KIND,
            "subjectHash": subject_hash, "requiredRole": SIGNER_ROLE, "trustStoreHash": trust.hash,
            "envelopeHash": hash, "verifiedKeyIds": verified_key_ids, "verifiedSubjectIds": verified_subject_ids,
            "verifiedPublicKeySpkiHashes": verified_spki_hashes,
            "signedAt": parsed["authorityEnvelope"]["signedAt"], "expiresAt": expires,
            "verifiedAt": now, "cryptographicAuthorityReady": true, "externalActionPerformed": false, "blockers": [],
        });
        receipt_hash = canonical_hash("PinnedExternalEvidenceVerificationReceipt", &receipt);
        true
    } else if let Err(EnvelopeErrors(envelope_blockers)) = envelope {
        if let Some(hash) = envelope_candidate_hash {
            envelope_hash = Some(hash.clone());
            receipt_hash =
                blocked_receipt_hash(subject_hash, &hash, &trust.hash, now, &envelope_blockers);
        }
        blockers.extend(envelope_blockers);
        false
    } else {
        false
    };
    object.insert("stablePolicyPinned".into(), Value::Bool(version == Some(2)));
    object.insert(
        "configurationPinned".into(),
        Value::Bool(configuration_pinned),
    );
    object.insert(
        "authoritySubjectHash".into(),
        Value::String(subject_hash.to_owned()),
    );
    object.insert(
        "authorityEnvelopeHash".into(),
        envelope_hash.map_or(Value::Null, Value::String),
    );
    object.insert(
        "authorityVerificationReceiptHash".into(),
        receipt_hash.map_or(Value::Null, Value::String),
    );
    object.insert(
        "attestationExpiresAt".into(),
        expires_at.map_or(Value::Null, Value::String),
    );
    object.insert(
        "cryptographicAuthorityReady".into(),
        Value::Bool(cryptographic_ready),
    );
    blockers = unique(blockers);
    let ready =
        version == Some(2) && configuration_pinned && blockers.is_empty() && cryptographic_ready;
    object.insert("readyForRuntimeBinding".into(), Value::Bool(ready));
    object.insert(
        "status".into(),
        Value::String(
            if ready {
                "production_external_author_identity_input_ready_for_runtime_binding"
            } else {
                "production_external_author_identity_input_blocked"
            }
            .into(),
        ),
    );
    object.insert("blockers".into(), json!(blockers));
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_and_missing_inputs_fail_closed() {
        assert_eq!(
            inspect_author(None, None, "2026-07-29T04:00:00.000Z")["blockers"],
            json!(["autonomous_research_author_identity_configuration_path_missing"])
        );
    }
}

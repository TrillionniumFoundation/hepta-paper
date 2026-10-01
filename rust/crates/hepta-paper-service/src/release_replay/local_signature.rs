//! Native local integrity signatures. A signature never promotes a blocked
//! replay diagnostic into release, academic, reviewer or submission authority.
use crate::release_integrity_key::{
    LOCAL_RELEASE_INTEGRITY_AUTHORITY_LIMIT, LoadedReleaseIntegrityKeyV1,
};
use base64ct::{Base64, Encoding};
use ed25519_dalek::{
    Signature, Signer, SigningKey, VerifyingKey,
    pkcs8::{DecodePrivateKey, DecodePublicKey},
};
use hepta_legacy_compatibility::production_stable_json_v1;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalReleaseIntegritySignatureV1 {
    pub version: u16,
    pub kind: String,
    pub role: String,
    pub algorithm: String,
    pub public_key_fingerprint: String,
    pub public_key_pem: String,
    pub payload_hash: String,
    pub signature: String,
    pub authority_limit: String,
}
fn error(suffix: &str) -> String {
    format!("release_replay_local_signature_{suffix}")
}
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn canonical(payload: &Value) -> Result<Vec<u8>, String> {
    crate::release_replay::production_core::budget(&[payload])?;
    let bytes = production_stable_json_v1(payload).map_err(|_| error("payload_invalid"))?;
    if bytes.len() >= 4 * 1024 * 1024 {
        return Err(error("payload_budget_exceeded"));
    }
    Ok(bytes)
}
pub fn verify_local_release_integrity_signature_v1(
    payload: &Value,
    signature: &LocalReleaseIntegritySignatureV1,
    pinned_public_key_pem: &str,
    pinned_public_key_fingerprint: &str,
) -> Result<(), String> {
    if signature.version != 1
        || signature.kind != "ReleaseIntegritySignature"
        || signature.role != "local_release_integrity"
        || signature.algorithm != "ed25519"
        || signature.authority_limit != LOCAL_RELEASE_INTEGRITY_AUTHORITY_LIMIT
        || signature.public_key_pem != pinned_public_key_pem
        || signature.public_key_fingerprint != pinned_public_key_fingerprint
        || signature.public_key_fingerprint != digest(signature.public_key_pem.as_bytes())
        || signature.public_key_pem.len() > 16 * 1024
        || signature.signature.len() != 88
    {
        return Err(error("contract_invalid"));
    }
    let bytes = canonical(payload)?;
    if signature.payload_hash != digest(&bytes) {
        return Err(error("payload_hash_mismatch"));
    }
    let decoded = Base64::decode_vec(&signature.signature)
        .map_err(|_| error("signature_encoding_invalid"))?;
    if decoded.len() != 64 || Base64::encode_string(&decoded) != signature.signature {
        return Err(error("signature_encoding_invalid"));
    }
    let public = VerifyingKey::from_public_key_pem(&signature.public_key_pem)
        .map_err(|_| error("public_key_invalid"))?;
    let signature = Signature::from_slice(&decoded).map_err(|_| error("signature_invalid"))?;
    public
        .verify_strict(&bytes, &signature)
        .map_err(|_| error("signature_invalid"))
}
/// Internal producer accepts only its own source-bound blocked inspection. The
/// ordinary composition computes that inspection before this function is called.
pub(crate) fn sign_blocked_replay_diagnostic_v1(
    payload: &Value,
    key: &LoadedReleaseIntegrityKeyV1,
) -> Result<(LocalReleaseIntegritySignatureV1, Vec<u8>), String> {
    if payload["status"] != "release_attestation_blocked"
        || payload["sourceBound"] != true
        || payload["releaseEvidenceReady"] != false
        || payload["physicalDeletionAllowed"] != false
        || payload["nodeRetirement"] != false
        || payload["externalActionPerformed"] != false
        || !matches!(payload["version"].as_u64(), Some(3 | 4 | 8 | 9 | 10))
    {
        return Err(error("blocked_diagnostic_contract_invalid"));
    }
    let bytes = canonical(payload)?;
    let mut unhashed = payload.clone();
    let actual_hash = unhashed
        .as_object_mut()
        .and_then(|v| v.remove("reportHash"))
        .ok_or_else(|| error("diagnostic_hash_missing"))?;
    let expected_hash =
        hepta_control_plane::canonical_hash_v1(&json!({"kind":payload["kind"],"value":unhashed}))
            .map_err(|_| error("diagnostic_hash_invalid"))?
            .to_string();
    if actual_hash != expected_hash {
        return Err(error("diagnostic_hash_mismatch"));
    }
    key.assert_current().map_err(|_| error("key_changed"))?;
    let private = key
        .private_key_pem()
        .ok_or_else(|| error("private_key_required"))?;
    let private = std::str::from_utf8(private).map_err(|_| error("private_key_invalid"))?;
    let signing_key =
        SigningKey::from_pkcs8_pem(private).map_err(|_| error("private_key_invalid"))?;
    if serde_json::from_slice::<Value>(&bytes).map_err(|_| error("wire_invalid"))? != *payload {
        return Err(error("payload_wire_value_changed"));
    }
    let signature = LocalReleaseIntegritySignatureV1 {
        version: 1,
        kind: "ReleaseIntegritySignature".into(),
        role: "local_release_integrity".into(),
        algorithm: "ed25519".into(),
        public_key_fingerprint: key.public_key_fingerprint.clone(),
        public_key_pem: key.public_key_pem.clone(),
        payload_hash: digest(&bytes),
        signature: Base64::encode_string(&signing_key.sign(&bytes).to_bytes()),
        authority_limit: LOCAL_RELEASE_INTEGRITY_AUTHORITY_LIMIT.into(),
    };
    verify_local_release_integrity_signature_v1(
        payload,
        &signature,
        &key.public_key_pem,
        &key.public_key_fingerprint,
    )?;
    key.assert_current().map_err(|_| error("key_changed"))?;
    // Embed already canonical payload bytes. Re-serializing a Value envelope
    // would change property insertion order and break Node JSON.stringify.
    let mut wire =
        b"{\"version\":1,\"kind\":\"NativeBlockedReplayIntegrityReceipt\",\"payload\":".to_vec();
    wire.extend_from_slice(&bytes);
    wire.extend_from_slice(b",\"signature\":");
    wire.extend(serde_json::to_vec(&signature).map_err(|_| error("wire_invalid"))?);
    wire.extend_from_slice(b"}\n");
    Ok((signature, wire))
}

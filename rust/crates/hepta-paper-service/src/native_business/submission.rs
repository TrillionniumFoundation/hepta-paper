use std::collections::{BTreeMap, BTreeSet};

use hepta_codex_protocol::Sha256Digest;
use serde::Serialize;
use serde_json::json;

use super::{
    MAX_TEXT_BYTES, NativeBusinessError, NativeBusinessOutputV1, hash_serialized,
    validate_identifier, validate_inline_text,
};

const MAXIMUM_SUPPLEMENTARY_ARTIFACTS: usize = 64;
const MAXIMUM_METADATA_FIELDS: usize = 64;
const MAXIMUM_METADATA_VALUE_BYTES: usize = 2_048;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubmissionPackageBodyV1<'a> {
    version: u16,
    venue: &'a str,
    manuscript_hash: &'a Sha256Digest,
    supplementary_hashes: &'a [Sha256Digest],
    metadata: &'a BTreeMap<String, String>,
    idempotency_key: &'a str,
    external_action_authorized: bool,
    external_action_performed: bool,
}

pub(super) fn submission_package(
    venue: String,
    manuscript_hash: Sha256Digest,
    mut supplementary_hashes: Vec<Sha256Digest>,
    metadata: BTreeMap<String, String>,
    idempotency_key: String,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    validate_identifier(&venue, 128)?;
    validate_identifier(&idempotency_key, 128)?;
    if supplementary_hashes.len() > MAXIMUM_SUPPLEMENTARY_ARTIFACTS
        || metadata.is_empty()
        || metadata.len() > MAXIMUM_METADATA_FIELDS
    {
        return Err(NativeBusinessError::Contract);
    }
    supplementary_hashes.sort();
    let unique = supplementary_hashes.iter().collect::<BTreeSet<_>>();
    if unique.len() != supplementary_hashes.len()
        || supplementary_hashes.iter().any(|hash| hash == &manuscript_hash)
    {
        return Err(NativeBusinessError::Contract);
    }
    for (key, value) in &metadata {
        validate_identifier(key, 128)?;
        validate_inline_text(value, MAXIMUM_METADATA_VALUE_BYTES)?;
    }

    let body = SubmissionPackageBodyV1 {
        version: 1,
        venue: &venue,
        manuscript_hash: &manuscript_hash,
        supplementary_hashes: &supplementary_hashes,
        metadata: &metadata,
        idempotency_key: &idempotency_key,
        external_action_authorized: false,
        external_action_performed: false,
    };
    let package_hash = hash_serialized("HeptaNativeSubmissionPackageV1", &body)?;
    let artifact = serde_json::to_vec(&body).map_err(|_| NativeBusinessError::Encoding)?;
    if artifact.is_empty() || artifact.len() > MAX_TEXT_BYTES {
        return Err(NativeBusinessError::OutputLimit);
    }
    Ok(NativeBusinessOutputV1 {
        artifacts: vec![artifact],
        evidence: json!({
            "version": 1,
            "capability": "submission_prepared_intent",
            "packageHash": package_hash,
            "venue": venue,
            "idempotencyKey": idempotency_key,
            "externalActionAuthorized": false,
            "externalActionPerformed": false,
            "requiresExternalAuthority": true,
            "scope": "prepared_result_only"
        }),
    })
}

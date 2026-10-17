use super::*;
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signature, VerifyingKey};
use hepta_legacy_compatibility::ProductionCollationV1;
use std::collections::BTreeSet;

pub(super) const ROLES: [&str; 3] = [
    "nested_runtime_platform_independent_qualifier",
    "nested_runtime_startup_conformance_independent_attestor",
    "nested_runtime_authority_independence_attestor",
];
pub(super) const AUTHORITY_FIELDS: [&str; 3] = [
    "qualificationAuthority",
    "conformanceAuthority",
    "authorityIndependenceAuthority",
];
pub(super) struct TrustKey {
    pub value: Value,
    pub spki: String,
    pub key: VerifyingKey,
}
pub(super) struct Trust {
    pub keys: Vec<TrustKey>,
    pub hash: String,
}

pub(super) fn configuration(v: &Value) -> Result<()> {
    ensure(
        exact(
            v,
            &[
                "authorityIndependenceAuthority",
                "authorityIndependenceBundlePath",
                "authorityIndependenceMaximumLifetimeMs",
                "conformanceAuthority",
                "conformanceBundlePath",
                "conformanceMaximumLifetimeMs",
                "conformanceMaximumObservationAgeMs",
                "deploymentOperator",
                "expectedTrustStoreContentHash",
                "expectedTrustStoreHash",
                "kind",
                "qualificationAuthority",
                "qualificationBundlePath",
                "qualificationMaximumLifetimeMs",
                "trustStorePath",
                "version",
            ],
        ) && v["version"] == 2
            && v["kind"] == "NestedRuntimePlatformQualificationConfiguration"
            && sha(&v["expectedTrustStoreContentHash"])
            && sha(&v["expectedTrustStoreHash"])
            && bounded(&v["qualificationMaximumLifetimeMs"], 90 * 86_400_000)
            && bounded(&v["conformanceMaximumLifetimeMs"], 900_000)
            && bounded(&v["authorityIndependenceMaximumLifetimeMs"], 900_000)
            && bounded(
                &v["conformanceMaximumObservationAgeMs"],
                v["conformanceMaximumLifetimeMs"]
                    .as_u64()
                    .unwrap_or(0)
                    .min(600_000),
            ),
        "nested_runtime_platform_configuration_invalid",
    )?;
    for name in AUTHORITY_FIELDS {
        let a = &v[name];
        ensure(
            exact(
                a,
                &[
                    "keyIds",
                    "organizations",
                    "publicKeySpkiHashes",
                    "subjectIds",
                ],
            ) && [
                "keyIds",
                "organizations",
                "publicKeySpkiHashes",
                "subjectIds",
            ]
            .iter()
            .all(|k| a[*k].as_array().is_some_and(|v| v.len() == 1))
                && id(&a["keyIds"][0])
                && id(&a["subjectIds"][0])
                && sha(&a["publicKeySpkiHashes"][0])
                && org(&a["organizations"][0]),
            "nested_runtime_platform_authority_binding_invalid",
        )?;
    }
    for i in 0..3 {
        for j in i + 1..3 {
            let (a, b) = (&v[AUTHORITY_FIELDS[i]], &v[AUTHORITY_FIELDS[j]]);
            ensure(
                ["keyIds", "subjectIds", "publicKeySpkiHashes"]
                    .iter()
                    .all(|k| a[*k][0] != b[*k][0]),
                "nested_runtime_platform_authorities_not_independent",
            )?;
            ensure(
                org_identity(&a["organizations"][0]) != org_identity(&b["organizations"][0]),
                "nested_runtime_platform_authority_organizations_not_independent",
            )?;
        }
    }
    let d = &v["deploymentOperator"];
    ensure(
        exact(
            d,
            &[
                "identitySubjectHash",
                "organization",
                "principalId",
                "provider",
                "trustDomainIdentityHash",
            ],
        ) && id(&d["principalId"])
            && id(&d["provider"])
            && sha(&d["identitySubjectHash"])
            && sha(&d["trustDomainIdentityHash"]),
        "nested_runtime_deployment_operator_binding_invalid",
    )?;
    ensure(
        org(&d["organization"]),
        "nested_runtime_platform_authority_binding_invalid",
    )?;
    ensure(
        AUTHORITY_FIELDS
            .iter()
            .all(|k| org_identity(&v[*k]["organizations"][0]) != org_identity(&d["organization"])),
        "nested_runtime_deployment_operator_control_domain_not_independent",
    )
}
fn public_key(v: &Value) -> Result<(VerifyingKey, String)> {
    let pem = s(v);
    let trimmed = pem.trim();
    ensure(
        pem.len() <= 4096 && !pem.contains("PRIVATE KEY"),
        "pinned_external_evidence_trust_key_invalid",
    )?;
    let body = trimmed
        .strip_prefix("-----BEGIN PUBLIC KEY-----")
        .and_then(|v| v.strip_suffix("-----END PUBLIC KEY-----"))
        .ok_or_else(|| {
            NestedRuntimeQualificationError::from("pinned_external_evidence_trust_key_invalid")
        })?;
    let encoded = body.split_ascii_whitespace().collect::<String>();
    let der = Base64::decode_vec(&encoded).map_err(|_| {
        NestedRuntimeQualificationError::from("pinned_external_evidence_trust_key_invalid")
    })?;
    ensure(
        der.len() == 44
            && der[..12]
                == [
                    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
                ],
        "pinned_external_evidence_trust_key_not_ed25519",
    )?;
    let raw: [u8; 32] = der[12..].try_into().map_err(|_| {
        NestedRuntimeQualificationError::from("pinned_external_evidence_trust_key_invalid")
    })?;
    Ok((
        VerifyingKey::from_bytes(&raw).map_err(|_| {
            NestedRuntimeQualificationError::from("pinned_external_evidence_trust_key_invalid")
        })?,
        digest(&der),
    ))
}
pub(super) fn trust(v: &Value) -> Result<Trust> {
    ensure(
        exact(v, &["version", "kind", "keys"])
            && v["version"] == 1
            && v["kind"] == "AuthorityTrustStore"
            && v["keys"]
                .as_array()
                .is_some_and(|a| (1..=256).contains(&a.len())),
        "nested_runtime_platform_trust_store_identity_mismatch",
    )?;
    let mut keys = Vec::new();
    let mut seen_id = BTreeSet::new();
    let mut seen_spki = BTreeSet::new();
    for key in v["keys"]
        .as_array()
        .ok_or("pinned_external_evidence_trust_store_invalid")?
    {
        let allowed = [
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
        ensure(
            key.as_object()
                .is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str())))
                && key_id(&key["keyId"])
                && key_id(&key["subjectId"])
                && key["algorithm"] == "ed25519"
                && key["status"] == "active",
            "nested_runtime_platform_trust_store_identity_mismatch",
        )?;
        let raw_roles = key["roles"].as_array().ok_or_else(|| {
            NestedRuntimeQualificationError::from(
                "nested_runtime_platform_trust_store_identity_mismatch",
            )
        })?;
        ensure(
            !raw_roles.is_empty() && raw_roles.len() <= 256 && raw_roles.iter().all(key_id),
            "nested_runtime_platform_trust_store_identity_mismatch",
        )?;
        let roles = raw_roles
            .iter()
            .map(|v| s(v).to_owned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        for field in ["effectiveFrom", "expiresAt", "revokedAt"] {
            ensure(
                key[field].is_null() || instant(&key[field]).is_some(),
                "nested_runtime_platform_trust_store_identity_mismatch",
            )?;
        }
        if !key["effectiveFrom"].is_null() && !key["expiresAt"].is_null() {
            ensure(
                instant(&key["expiresAt"]) > instant(&key["effectiveFrom"]),
                "nested_runtime_platform_trust_store_identity_mismatch",
            )?;
        }
        let (public, spki) = public_key(&key["publicKeyPem"]).map_err(|_| {
            NestedRuntimeQualificationError::from(
                "nested_runtime_platform_trust_store_identity_mismatch",
            )
        })?;
        ensure(
            seen_id.insert(s(&key["keyId"]).to_owned()) && seen_spki.insert(spki.clone()),
            "nested_runtime_platform_trust_store_identity_mismatch",
        )?;
        let canonical = json!({"keyId":key["keyId"],"subjectId":key["subjectId"],"organization":key["organization"],"algorithm":"ed25519","publicKeyPem":key["publicKeyPem"],"roles":roles,"status":"active","effectiveFrom":key["effectiveFrom"],"expiresAt":key["expiresAt"],"revokedAt":key["revokedAt"]});
        keys.push(TrustKey {
            value: canonical,
            spki,
            key: public,
        });
    }
    let collation = ProductionCollationV1::load().map_err(|_| {
        NestedRuntimeQualificationError::from("nested_runtime_platform_hash_encoding_invalid")
    })?;
    let mut canonical = keys.iter().map(|k| k.value.clone()).collect::<Vec<_>>();
    canonical.sort_by(|a, b| collation.compare(s(&a["keyId"]), s(&b["keyId"])));
    let hash = hash(
        "PinnedExternalEvidenceTrustStore",
        &json!({"version":1,"kind":"AuthorityTrustStore","keys":canonical}),
    )?;
    Ok(Trust { keys, hash })
}
pub(super) fn binding(trust: &Trust, a: &Value) -> Result<()> {
    let k = trust
        .keys
        .iter()
        .find(|k| k.value["keyId"] == a["keyIds"][0]);
    ensure(
        k.is_some_and(|k| {
            k.value["subjectId"] == a["subjectIds"][0]
                && a["publicKeySpkiHashes"][0] == k.spki
                && org_identity(&k.value["organization"]) == org_identity(&a["organizations"][0])
        }),
        "nested_runtime_platform_trust_key_authority_binding_mismatch",
    )
}
pub(super) fn envelope(
    v: &Value,
    i: &subjects::Inspection,
    t: &Trust,
    a: &Value,
    role: &str,
    now: i64,
    max: u64,
) -> Result<bool> {
    if !i.ready() {
        return Ok(false);
    }
    ensure(
        t.keys.iter().any(|key| {
            key.value["roles"]
                .as_array()
                .is_some_and(|roles| roles.iter().any(|value| value == role))
        }),
        "pinned_external_evidence_trust_role_missing",
    )?;
    ensure(
        exact(
            v,
            &[
                "expiresAt",
                "kind",
                "signatures",
                "signedAt",
                "subjectHash",
                "subjectKind",
                "version",
            ],
        ),
        "pinned_external_evidence_envelope_shape_invalid",
    )?;
    ensure(
        v["version"] == 1
            && v["kind"] == "PinnedExternalEvidenceEnvelope"
            && key_id(&v["subjectKind"])
            && sha(&v["subjectHash"])
            && instant(&v["signedAt"]).is_some()
            && instant(&v["expiresAt"]).is_some()
            && instant(&v["expiresAt"]) > instant(&v["signedAt"])
            && v["signatures"].as_array().is_some_and(|a| {
                (1..=16).contains(&a.len())
                    && a.iter()
                        .all(|x| exact(x, &["algorithm", "keyId", "role", "value"]))
            }),
        "pinned_external_evidence_envelope_invalid",
    )?;
    ensure(
        v["subjectKind"]
            == i.value
                .as_ref()
                .ok_or("pinned_external_evidence_subject_binding_invalid")?["kind"]
            && v["subjectHash"].as_str() == i.subject_hash.as_deref(),
        "pinned_external_evidence_subject_binding_invalid",
    )?;
    let signed = instant(&v["signedAt"]).ok_or("pinned_external_evidence_envelope_invalid")?;
    let expires = instant(&v["expiresAt"]).ok_or("pinned_external_evidence_envelope_invalid")?;
    ensure(
        signed <= now && expires > now && expires - signed <= max as i64,
        "immutable_signed_json_authority_time_window_invalid",
    )?;
    let mut payload = v.clone();
    payload
        .as_object_mut()
        .ok_or("pinned_external_evidence_envelope_shape_invalid")?
        .remove("signatures");
    // All envelope fields are closed ASCII strings or the exact integer 1;
    // BTreeMap order is Node's ordinal signing order for this vocabulary.
    let bytes = serde_json::to_vec(&payload).map_err(|_| {
        NestedRuntimeQualificationError::from("nested_runtime_platform_hash_encoding_invalid")
    })?;
    let mut seen = BTreeSet::new();
    let mut verified = Vec::new();
    for signature in v["signatures"]
        .as_array()
        .ok_or("pinned_external_evidence_envelope_invalid")?
    {
        let key = t
            .keys
            .iter()
            .find(|k| k.value["keyId"] == signature["keyId"]);
        ensure(
            signature["algorithm"] == "ed25519"
                && signature["role"] == role
                && seen.insert(s(&signature["keyId"]).to_owned())
                && key.is_some_and(|k| {
                    k.value["roles"]
                        .as_array()
                        .is_some_and(|roles| roles.iter().any(|r| r == role))
                }),
            "immutable_signed_json_authority_signature_invalid",
        )?;
        let key = key.ok_or("immutable_signed_json_authority_signature_invalid")?;
        let encoded = s(&signature["value"]);
        let sig = Base64::decode_vec(encoded).map_err(|_| {
            NestedRuntimeQualificationError::from(
                "immutable_signed_json_authority_signature_invalid",
            )
        })?;
        ensure(
            sig.len() == 64 && Base64::encode_string(&sig) == encoded,
            "immutable_signed_json_authority_signature_invalid",
        )?;
        let sig = Signature::from_slice(&sig).map_err(|_| {
            NestedRuntimeQualificationError::from(
                "immutable_signed_json_authority_signature_invalid",
            )
        })?;
        key.key.verify_strict(&bytes, &sig).map_err(|_| {
            NestedRuntimeQualificationError::from(
                "immutable_signed_json_authority_signature_invalid",
            )
        })?;
        for (field, invalid) in [
            (
                "effectiveFrom",
                instant(&key.value["effectiveFrom"]).is_some_and(|n| signed < n),
            ),
            (
                "expiresAt",
                instant(&key.value["expiresAt"]).is_some_and(|n| signed >= n),
            ),
            (
                "revokedAt",
                instant(&key.value["revokedAt"]).is_some_and(|n| signed >= n),
            ),
        ] {
            let _ = field;
            ensure(
                !invalid,
                "pinned_external_evidence_signer_outside_key_time_window",
            )?;
        }
        verified.push(key);
    }
    ensure(
        verified.len() == 1 && verified[0].value["keyId"] == a["keyIds"][0],
        "pinned_external_evidence_signer_key_binding_invalid",
    )?;
    let subject = i
        .value
        .as_ref()
        .ok_or("pinned_external_evidence_subject_binding_invalid")?;
    ensure(
        v["signedAt"] == subject["issuedAt"]
            && v["expiresAt"] == subject["expiresAt"]
            && verified[0].value["subjectId"] == a["subjectIds"][0]
            && a["publicKeySpkiHashes"][0] == verified[0].spki,
        "nested_runtime_platform_receipt_authority_or_time_binding_invalid",
    )?;
    Ok(true)
}

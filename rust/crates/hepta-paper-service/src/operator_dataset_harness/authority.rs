use super::{contract::*, control_check, json::*};
use hepta_legacy_compatibility::ProductionJsonValue as Json;
use serde_json::Value;
use std::{
    sync::atomic::AtomicBool,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub(super) fn actual_millis() -> Result<i64, String> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "operator_dataset_actual_clock_invalid")?
            .as_millis(),
    )
    .map_err(|_| "operator_dataset_actual_clock_invalid".into())
}
fn local_store(value: &Value) -> bool {
    value["authorityScope"] == LOCAL_SCOPE
        && value["evidenceClass"] == LOCAL_EVIDENCE
        && value["academicPromotionEligible"] == false
        && value["externalTrustClaimed"] == false
        && value["keyPurpose"] == LOCAL_PURPOSE
}
fn local_key(value: &Value) -> bool {
    value["keyPurpose"] == LOCAL_PURPOSE
        && value["authorityScope"] == LOCAL_SCOPE
        && value["academicPromotionEligible"] == false
        && value["externalTrustClaimed"] == false
        && value["roles"]
            .as_array()
            .is_some_and(|roles| roles.len() == 1 && roles[0] == LOCAL_ROLE)
}
pub(super) struct Verification {
    pub report: Json,
    pub blockers: Vec<String>,
    pub window: Option<(i64, i64)>,
}
pub(super) fn verify(
    document: &Json,
    local: bool,
    trust: &Value,
    now: i64,
    c: &AtomicBool,
    d: Instant,
) -> Result<Verification, String> {
    control_check(c, d)?;
    let document_value: Value = serde_json::from_slice(&wire(document)?)
        .map_err(|_| "operator_dataset_authority_scalar_json_domain_refused")?;
    let signatures = document_value["signatures"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let keys = trust["keys"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let key_id = |value: &Value| {
        if crate::native_business::local_submission_preflight::local_submission_truthy(value) {
            crate::release_state::javascript_string(value)
        } else {
            String::new()
        }
    };
    let signing_keys = signatures
        .iter()
        .filter_map(|signature| {
            keys.iter()
                .rev()
                .find(|key| key_id(&key["keyId"]) == key_id(&signature["keyId"]))
        })
        .collect::<Vec<_>>();
    let mut blockers = Vec::new();
    if local {
        if !local_store(trust) {
            blockers.push(
                "operator_dataset_authority:local_golden_dataset_trust_store_scope_invalid".into(),
            );
        }
        if signatures.len() != 1
            || signatures[0]["role"] != LOCAL_ROLE
            || signing_keys.len() != 1
            || !local_key(signing_keys[0])
        {
            blockers.push(
                "operator_dataset_authority:local_golden_dataset_signing_key_purpose_invalid"
                    .into(),
            );
        }
    } else {
        if local_store(trust) {
            blockers.push("operator_dataset_authority:local_golden_dataset_trust_store_forbids_nonlocal_authority".into());
        }
        if signatures
            .iter()
            .any(|signature| signature["role"] == LOCAL_ROLE)
            || signing_keys.iter().any(|key| local_key(key))
        {
            blockers.push("operator_dataset_authority:local_golden_dataset_key_cannot_authorize_nonlocal_authority".into());
        }
    }
    let verification=crate::journal_connector_coverage::qualification_authority::verify_operator_dataset_authority_v1(&document_value,trust,c,d)?;
    blockers.extend(
        verification
            .blockers
            .iter()
            .map(|blocker| format!("operator_dataset_authority:{blocker}")),
    );
    let signed = crate::journal_connector_coverage::qualification::canonical_instant_millis(
        &or_string(get(document, "signedAt"))?,
    );
    let expires = crate::journal_connector_coverage::qualification::canonical_instant_millis(
        &or_string(get(document, "expiresAt"))?,
    );
    let mut time_blockers = Vec::new();
    if signed.is_none() {
        time_blockers.extend([
            "authority_signed_at_invalid",
            "authority_valid_from_invalid",
        ]);
    }
    if expires.is_none() {
        time_blockers.push("authority_expires_at_invalid");
    }
    if signed.is_some_and(|signed| now < signed) {
        time_blockers.push("authority_not_yet_valid");
    }
    if expires.is_some_and(|expires| now >= expires) {
        time_blockers.push("authority_expired");
    }
    if let (Some(signed), Some(expires)) = (signed, expires) {
        if expires <= signed {
            time_blockers.push("authority_expiry_not_after_signature");
        }
        if expires - signed > 31 * 24 * 60 * 60 * 1000 {
            time_blockers.push("authority_lifetime_exceeds_policy");
        }
    }
    let time_valid = time_blockers.is_empty();
    blockers.extend(
        time_blockers
            .into_iter()
            .map(|blocker| format!("operator_dataset_authority:{blocker}")),
    );
    let from_value = |name: &str| -> Result<Json, String> {
        hepta_legacy_compatibility::parse_production_json_v1(
            &serde_json::to_vec(&verification.report[name]).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())
    };
    let signatures = verification
        .signatures
        .iter()
        .map(|signature| {
            let source = hepta_legacy_compatibility::parse_production_json_v1(
                &serde_json::to_vec(&signature.value).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            Ok(object([
                ("keyId", get(&source, "keyId").clone()),
                ("role", get(&source, "role").clone()),
                ("subjectId", get(&source, "subjectId").clone()),
                ("organization", get(&source, "organization").clone()),
                (
                    "cryptographicallyVerified",
                    get(&source, "cryptographicallyVerified").clone(),
                ),
            ]))
        })
        .collect::<Result<Vec<_>, String>>()?;
    // Incumbent Set projection uses Array.sort without a locale comparator:
    // compare complete UTF-16 sequences, including supplementary characters.
    let mut subjects = array(&from_value("verifiedSubjectIds")?).to_vec();
    let mut subject_units = subjects
        .drain(..)
        .map(|subject| Ok((units(&subject)?, subject)))
        .collect::<Result<Vec<_>, String>>()?;
    subject_units.sort_by(|left, right| left.0.cmp(&right.0));
    let subjects = Json::Array(
        subject_units
            .into_iter()
            .map(|(_, subject)| subject)
            .collect(),
    );
    let report = object([
        (
            "status",
            text(if blockers.is_empty() {
                "operator_dataset_authority_verified"
            } else {
                "operator_dataset_authority_blocked"
            }),
        ),
        (
            "cryptographicSignaturesVerified",
            from_value("cryptographicSignaturesVerified")?,
        ),
        ("verifiedSignatures", Json::Array(signatures)),
        ("verifiedRoles", from_value("verifiedRoles")?),
        ("verifiedSubjectIds", subjects),
        ("timeWindowValid", Json::Bool(time_valid)),
        (
            "signedAt",
            if signed.is_some() {
                get(document, "signedAt").clone()
            } else {
                Json::Null
            },
        ),
        (
            "expiresAt",
            if expires.is_some() {
                get(document, "expiresAt").clone()
            } else {
                Json::Null
            },
        ),
    ]);
    control_check(c, d)?;
    Ok(Verification {
        report,
        blockers,
        window: signed.zip(expires),
    })
}

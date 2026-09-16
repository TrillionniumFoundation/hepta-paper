//! Active authority and bounded unresolved-reservation contracts.
use super::*;
const CHALLENGE_REQUEST_KEYS: &[&str] = &[
    "version",
    "kind",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "challengeNonce",
    "requestedAt",
];
const CHALLENGE_RECEIPT_KEYS: &[&str] = &[
    "version",
    "kind",
    "status",
    "authorityId",
    "keyId",
    "requestHash",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "globalSequence",
    "globalHash",
    "databaseHeads",
    "challengeNonce",
    "challengedAt",
    "expiresAt",
    "signature",
];
const SCOPE_REQUEST_KEYS: &[&str] = &[
    "version",
    "kind",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "staticInspectionReceiptHash",
    "astGateReceiptHash",
    "codeProvenanceHash",
    "operationCount",
    "operationIds",
    "requiredDatabaseRoles",
    "coveredDatabaseRoles",
    "nonce",
    "requestedAt",
];
const SCOPE_RECEIPT_KEYS: &[&str] = &[
    "version",
    "kind",
    "status",
    "authorityId",
    "keyId",
    "requestHash",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "staticInspectionReceiptHash",
    "astGateReceiptHash",
    "codeProvenanceHash",
    "operationCount",
    "operationIds",
    "requiredDatabaseRoles",
    "coveredDatabaseRoles",
    "globalSequence",
    "globalHash",
    "observedAt",
    "expiresAt",
    "signature",
];
const LIST_REQUEST_KEYS: &[&str] = &[
    "version",
    "kind",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "databaseRole",
    "databaseInstanceId",
    "nonce",
    "requestedAt",
];
const LIST_RECEIPT_KEYS: &[&str] = &[
    "version",
    "kind",
    "status",
    "authorityId",
    "keyId",
    "requestHash",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "databaseRole",
    "databaseInstanceId",
    "nonce",
    "requestedAt",
    "unresolvedReservationCount",
    "unresolvedReservationSetHash",
    "unresolvedReservations",
    "observedAt",
    "expiresAt",
    "signature",
];

pub fn verify_active_challenge_v1(
    receipt: &Value,
    request: &Value,
    trust: &Value,
    now: i64,
    expected_instances: Option<&Value>,
    verify: &impl Fn(&Value) -> bool,
) -> Result<bool> {
    assert_authority_trust_v1(trust)?;
    if !common(
        request,
        CHALLENGE_REQUEST_KEYS,
        "AutonomousResearchOnlineMutationActiveChallengeRequest",
    ) || !scoped(request, trust)
        || !safe(&request["challengeNonce"])
        || timestamp(&request["requestedAt"]).is_none()
    {
        return Err(error(
            "autonomous_research_online_mutation_observation_request_invalid",
        ));
    }
    Ok(keys(receipt, CHALLENGE_RECEIPT_KEYS)
        && receipt["version"] == 1
        && receipt["kind"] == "AutonomousResearchOnlineMutationActiveChallengeReceipt"
        && receipt["status"] == "autonomous_research_online_mutation_active_challenge_verified"
        && receipt["requestHash"]
            == hash(
                "AutonomousResearchOnlineMutationActiveChallengeRequest",
                request,
            )?
        && receipt["protocol"] == request["protocol"]
        && scoped(receipt, request)
        && integer(&receipt["globalSequence"], 0)
        && sha(&receipt["globalHash"])
        && database_heads_valid(&receipt["databaseHeads"], expected_instances)
        && signed(receipt, trust, verify)
        && live(receipt, trust, "challengedAt", now)
        && receipt["challengeNonce"] == request["challengeNonce"])
}
pub fn assert_scope_request_v1(request: &Value, trust: &Value) -> Result<()> {
    assert_authority_trust_v1(trust)?;
    let mut required = DATABASE_ROLES.to_vec();
    required.sort_unstable();
    if !common(
        request,
        SCOPE_REQUEST_KEYS,
        "AutonomousResearchOnlineMutationScopeRequest",
    ) || !scoped(request, trust)
        || ![
            "staticInspectionReceiptHash",
            "astGateReceiptHash",
            "codeProvenanceHash",
        ]
        .iter()
        .all(|k| sha(&request[k]))
        || request["staticInspectionReceiptHash"] != request["astGateReceiptHash"]
        || !integer(&request["operationCount"], 1)
        || !sorted(&request["operationIds"], safe)
        || request["operationIds"]
            .as_array()
            .map(Vec::len)
            .map(|v| json!(v))
            != Some(request["operationCount"].clone())
        || request["requiredDatabaseRoles"] != json!(required)
        || !sorted(&request["coveredDatabaseRoles"], role)
        || !safe(&request["nonce"])
        || timestamp(&request["requestedAt"]).is_none()
    {
        return Err(error(
            "autonomous_research_online_mutation_scope_request_invalid",
        ));
    }
    Ok(())
}
pub fn verify_scope_receipt_v1(
    receipt: &Value,
    request: &Value,
    trust: &Value,
    now: i64,
    verify: &impl Fn(&Value) -> bool,
) -> Result<bool> {
    assert_scope_request_v1(request, trust)?;
    Ok(keys(receipt, SCOPE_RECEIPT_KEYS)
        && receipt["version"] == 1
        && receipt["kind"] == "AutonomousResearchOnlineMutationScopeReceipt"
        && receipt["status"] == "autonomous_research_online_mutation_scope_observed"
        && receipt["requestHash"] == hash("AutonomousResearchOnlineMutationScopeRequest", request)?
        && matches(
            receipt,
            request,
            &[
                "protocol",
                "scopeId",
                "databaseScopeHash",
                "writerManifestHash",
                "staticInspectionReceiptHash",
                "astGateReceiptHash",
                "codeProvenanceHash",
                "operationCount",
                "operationIds",
                "requiredDatabaseRoles",
                "coveredDatabaseRoles",
            ],
        )
        && integer(&receipt["globalSequence"], 0)
        && sha(&receipt["globalHash"])
        && signed(receipt, trust, verify)
        && live(receipt, trust, "observedAt", now))
}
pub fn assert_unresolved_list_request_v1(request: &Value, trust: &Value) -> Result<()> {
    if !common(
        request,
        LIST_REQUEST_KEYS,
        "AutonomousResearchOnlineUnresolvedReservationListRequest",
    ) || !scoped(request, trust)
        || !role(&request["databaseRole"])
        || !safe(&request["databaseInstanceId"])
        || !safe(&request["nonce"])
        || timestamp(&request["requestedAt"]).is_none()
    {
        return Err(error(
            "autonomous_research_online_unresolved_reservation_list_request_invalid",
        ));
    }
    Ok(())
}
pub fn unresolved_reservation_set_hash_v1(entries: &Value) -> Result<String> {
    let entries = entries
        .as_array()
        .ok_or_else(|| error("autonomous_research_online_unresolved_reservation_set_invalid"))?;
    let mut projection = Vec::new();
    for entry in entries {
        let mut value = serde_json::Map::new();
        if let Some(attempt) = entry
            .get("reserveRequest")
            .and_then(|r| r.get("mutationAttemptId"))
        {
            value.insert("mutationAttemptId".into(), attempt.clone());
        }
        value.insert(
            "reserveRequestHash".into(),
            json!(hash(
                "AutonomousResearchOnlineMutationReserveRequest",
                &entry["reserveRequest"]
            )?),
        );
        value.insert(
            "reservationReceiptHash".into(),
            json!(hash(
                "AutonomousResearchOnlineMutationReservationReceipt",
                &entry["reservation"]
            )?),
        );
        projection.push(Value::Object(value));
    }
    hash(
        "AutonomousResearchOnlineUnresolvedReservationSet",
        &json!(projection),
    )
}
pub fn verify_unresolved_list_v1(
    receipt: &Value,
    request: &Value,
    trust: &Value,
    now: i64,
    verify: &impl Fn(&Value) -> bool,
) -> Result<bool> {
    assert_unresolved_list_request_v1(request, trust)?;
    let Some(entries) = receipt["unresolvedReservations"]
        .as_array()
        .filter(|a| a.len() <= 1)
    else {
        return Ok(false);
    };
    for entry in entries {
        let reserve = &entry["reserveRequest"];
        let reservation = &entry["reservation"];
        let Some(issued) = timestamp(&reservation["issuedAt"]) else {
            return Ok(false);
        };
        if !keys(entry, &["reserveRequest", "reservation"])
            || !matches(
                reserve,
                request,
                &[
                    "scopeId",
                    "databaseScopeHash",
                    "writerManifestHash",
                    "databaseRole",
                    "databaseInstanceId",
                ],
            )
            || !matches(
                reservation,
                request,
                &["databaseRole", "databaseInstanceId"],
            )
            || reservation["mutationAttemptId"] != reserve["mutationAttemptId"]
            || !verify_reservation_v1(reservation, reserve, trust, issued, verify).unwrap_or(false)
        {
            return Ok(false);
        }
    }
    let (Some(observed), Some(expires), Some(age)) = (
        timestamp(&receipt["observedAt"]),
        timestamp(&receipt["expiresAt"]),
        trust["maximumObservationAgeMs"].as_i64(),
    ) else {
        return Ok(false);
    };
    Ok(trust["version"] == 1
        && trust["kind"] == "AutonomousResearchOnlineMutationAuthorityTrust"
        && safe(&trust["authorityId"])
        && safe(&trust["keyId"])
        && integer(&trust["maximumObservationAgeMs"], 1000)
        && keys(receipt, LIST_RECEIPT_KEYS)
        && receipt["version"] == 1
        && receipt["kind"] == "AutonomousResearchOnlineUnresolvedReservationListReceipt"
        && receipt["status"] == "autonomous_research_online_unresolved_reservations_observed"
        && receipt["authorityId"] == trust["authorityId"]
        && receipt["keyId"] == trust["keyId"]
        && receipt["requestHash"]
            == hash(
                "AutonomousResearchOnlineUnresolvedReservationListRequest",
                request,
            )?
        && matches(receipt, request, &LIST_REQUEST_KEYS[2..])
        && receipt["unresolvedReservationCount"] == json!(entries.len())
        && sha(&receipt["unresolvedReservationSetHash"])
        && receipt["unresolvedReservationSetHash"]
            == unresolved_reservation_set_hash_v1(&receipt["unresolvedReservations"])?
        && observed <= now.saturating_add(5000)
        && now.saturating_sub(observed) <= age
        && expires > now
        && expires > observed
        && expires - observed <= age
        && verify(receipt))
}

pub mod activation;
pub mod schema_transition;
use super::*;
use base64ct::{Base64, Encoding};
pub(super) const RESERVE_REQUEST_KEYS: &[&str] = &[
    "version",
    "kind",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "databaseRole",
    "databaseInstanceId",
    "writerId",
    "operationId",
    "codeProvenanceHash",
    "mutationAttemptId",
    "globalPreviousSequence",
    "globalPreviousHash",
    "databasePreviousSequence",
    "databasePreviousHash",
    "schemaContractId",
    "schemaHash",
    "preStateHash",
    "postStateHash",
    "changesetEncoding",
    "changesetBase64",
    "changesetByteLength",
    "changesetHash",
    "authorizationReceiptHashes",
    "sideEffectReservationHashes",
    "requestedAt",
    "requestedLeaseMs",
];
pub(super) const RESERVATION_KEYS: &[&str] = &[
    "version",
    "kind",
    "status",
    "authorityId",
    "keyId",
    "requestHash",
    "reservationId",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "databaseRole",
    "databaseInstanceId",
    "writerId",
    "operationId",
    "codeProvenanceHash",
    "mutationAttemptId",
    "globalPreviousSequence",
    "globalPreviousHash",
    "globalSequence",
    "globalHash",
    "databasePreviousSequence",
    "databasePreviousHash",
    "databaseSequence",
    "databaseHash",
    "schemaContractId",
    "schemaHash",
    "preStateHash",
    "postStateHash",
    "changesetEncoding",
    "changesetBase64",
    "changesetByteLength",
    "changesetHash",
    "authorizationReceiptHashes",
    "sideEffectReservationHashes",
    "issuedAt",
    "expiresAt",
    "signature",
];
pub(super) const FINALIZE_REQUEST_KEYS: &[&str] = &[
    "version",
    "kind",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "reservationId",
    "reservationReceiptHash",
    "databaseRole",
    "databaseInstanceId",
    "writerId",
    "operationId",
    "globalSequence",
    "globalHash",
    "databaseSequence",
    "databaseHash",
    "schemaHash",
    "postStateHash",
    "changesetHash",
    "localMarkerHash",
    "authorizationReceiptHashes",
    "sideEffectReservationHashes",
    "committedAt",
];
pub(super) const FINALIZATION_KEYS: &[&str] = &[
    "version",
    "kind",
    "status",
    "authorityId",
    "keyId",
    "requestHash",
    "reservationId",
    "reservationReceiptHash",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "databaseRole",
    "databaseInstanceId",
    "writerId",
    "operationId",
    "globalSequence",
    "globalHash",
    "databaseSequence",
    "databaseHash",
    "schemaHash",
    "postStateHash",
    "changesetHash",
    "localMarkerHash",
    "authorizationReceiptHashes",
    "sideEffectReservationHashes",
    "sideEffectPermitHash",
    "finalizedAt",
    "signature",
];
pub(super) const HEAD_REQUEST_KEYS: &[&str] = &[
    "version",
    "kind",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "nonce",
    "requestedAt",
];
pub(super) const HEAD_RECEIPT_KEYS: &[&str] = &[
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
    "unresolvedReservationCount",
    "observedAt",
    "expiresAt",
    "signature",
];
pub(super) const ABORT_REQUEST_KEYS: &[&str] = &[
    "version",
    "kind",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "reservationId",
    "reservationReceiptHash",
    "databaseRole",
    "databaseInstanceId",
    "writerId",
    "operationId",
    "mutationAttemptId",
    "globalSequence",
    "globalHash",
    "databaseSequence",
    "databaseHash",
    "changesetHash",
    "reason",
    "requestedAt",
];
pub(super) const RESOLUTION_REQUEST_KEYS: &[&str] = &[
    "version",
    "kind",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "mutationAttemptId",
    "reserveRequestHash",
    "requestedAt",
];
pub(super) const RESOLUTION_RECEIPT_KEYS: &[&str] = &[
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
    "mutationAttemptId",
    "reserveRequestHash",
    "requestedAt",
    "resolution",
    "reservation",
    "observedAt",
    "signature",
];
pub(super) const ABORT_RECEIPT_KEYS: &[&str] = &[
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
    "reservationId",
    "reservationReceiptHash",
    "databaseRole",
    "databaseInstanceId",
    "writerId",
    "operationId",
    "mutationAttemptId",
    "globalSequence",
    "globalHash",
    "databaseSequence",
    "databaseHash",
    "changesetHash",
    "reason",
    "requestedAt",
    "abortedAt",
    "signature",
];

pub fn assert_authority_trust_v1(trust: &Value) -> Result<()> {
    if trust["version"].as_f64() != Some(1.0)
        || trust["kind"] != "AutonomousResearchOnlineMutationAuthorityTrust"
        || !["authorityId", "keyId", "scopeId"]
            .iter()
            .all(|k| safe(&trust[k]))
        || !["databaseScopeHash", "writerManifestHash"]
            .iter()
            .all(|k| sha(&trust[k]))
        || !["maximumReservationLeaseMs", "maximumObservationAgeMs"]
            .iter()
            .all(|k| integer(&trust[k], 1000))
    {
        return Err(error(
            "autonomous_research_online_mutation_authority_trust_invalid",
        ));
    }
    Ok(())
}
fn common(v: &Value, expected: &[&str], kind: &str) -> bool {
    keys(v, expected)
        && v["version"].as_f64() == Some(1.0)
        && v["kind"] == kind
        && v["protocol"] == ONLINE_MUTATION_PROTOCOL
        && safe(&v["scopeId"])
        && sha(&v["databaseScopeHash"])
        && sha(&v["writerManifestHash"])
}
fn matches(a: &Value, b: &Value, names: &[&str]) -> bool {
    names.iter().all(|k| match (a.get(*k), b.get(*k)) {
        (Some(left @ Value::Number(_)), Some(right @ Value::Number(_))) => {
            integer(left, 0) && integer(right, 0) && left.as_f64() == right.as_f64()
        }
        (left, right) => left == right,
    })
}
fn scoped(a: &Value, b: &Value) -> bool {
    matches(
        a,
        b,
        &["scopeId", "databaseScopeHash", "writerManifestHash"],
    )
}
fn copied(value: &Value, names: &[&str]) -> serde_json::Map<String, Value> {
    names
        .iter()
        .filter_map(|key| value.get(*key).map(|v| ((*key).into(), v.clone())))
        .collect()
}
pub fn online_mutation_receipt_hash_v1(receipt: &Value) -> Result<String> {
    hash(
        receipt["kind"]
            .as_str()
            .filter(|v| !v.is_empty())
            .unwrap_or("InvalidOnlineMutationReceipt"),
        receipt,
    )
}
pub fn online_mutation_signed_payload_v1(receipt: &Value) -> Result<String> {
    let mut unsigned = receipt.as_object().cloned().unwrap_or_default();
    unsigned.remove("signature");
    hash(
        "AutonomousResearchOnlineMutationAuthoritySignedPayload",
        &Value::Object(unsigned),
    )
}
pub fn online_mutation_state_hash_v1(input: &Value) -> Result<String> {
    if !keys(
        input,
        &[
            "databaseRole",
            "databaseInstanceId",
            "writerId",
            "operationId",
            "schemaHash",
            "previousStateHash",
            "changesetHash",
            "databaseSequence",
            "authorizationReceiptHashes",
            "sideEffectReservationHashes",
        ],
    ) || !role(&input["databaseRole"])
        || !["databaseInstanceId", "writerId", "operationId"]
            .iter()
            .all(|k| safe(&input[k]))
        || !["schemaHash", "previousStateHash", "changesetHash"]
            .iter()
            .all(|k| sha(&input[k]))
        || !integer(&input["databaseSequence"], 1)
        || !sorted(&input["authorizationReceiptHashes"], sha)
        || !sorted(&input["sideEffectReservationHashes"], sha)
    {
        return Err(error(
            "autonomous_research_online_mutation_state_hash_input_invalid",
        ));
    }
    hash("AutonomousResearchOnlineMutationState", input)
}
pub fn online_mutation_local_marker_hash_v1(
    reservation: &Value,
    committed_at: &Value,
) -> Result<String> {
    if !safe(&reservation["reservationId"]) || timestamp(committed_at).is_none() {
        return Err(error(
            "autonomous_research_online_mutation_local_marker_input_invalid",
        ));
    }
    let mut v = copied(
        reservation,
        &[
            "reservationId",
            "databaseRole",
            "databaseInstanceId",
            "writerId",
            "operationId",
            "globalSequence",
            "globalHash",
            "databaseSequence",
            "databaseHash",
            "schemaHash",
            "preStateHash",
            "postStateHash",
            "changesetHash",
        ],
    );
    v.insert(
        "reservationReceiptHash".into(),
        json!(online_mutation_receipt_hash_v1(reservation)?),
    );
    v.insert("committedAt".into(), committed_at.clone());
    hash(
        "AutonomousResearchOnlineMutationLocalMarker",
        &Value::Object(v),
    )
}
pub fn canonical_changeset_v1(encoded: &str) -> Result<Vec<u8>> {
    let b = Base64::decode_vec(encoded)
        .map_err(|_| error("autonomous_research_online_mutation_changeset_invalid"))?;
    if b.is_empty() || Base64::encode_string(&b) != encoded {
        return Err(error(
            "autonomous_research_online_mutation_changeset_invalid",
        ));
    }
    Ok(b)
}
fn changeset_valid(v: &Value) -> Result<bool> {
    let Some(encoded) = v["changesetBase64"].as_str() else {
        return Ok(false);
    };
    let b = match Base64::decode_vec(encoded) {
        Ok(b) => b,
        Err(_) => return Ok(false),
    };
    if v["changesetEncoding"] != "base64"
        || b.is_empty()
        || b.len() > 16 * 1024 * 1024
        || v["changesetByteLength"].as_f64() != Some(b.len() as f64)
        || !sha(&v["changesetHash"])
    {
        return Ok(false);
    }
    Ok(hash_bytes(&canonical_changeset_v1(encoded)?) == v["changesetHash"])
}
pub fn assert_reserve_request_v1(request: &Value, trust: &Value) -> Result<()> {
    assert_authority_trust_v1(trust)?;
    let valid = common(
        request,
        RESERVE_REQUEST_KEYS,
        "AutonomousResearchOnlineMutationReserveRequest",
    ) && scoped(request, trust)
        && role(&request["databaseRole"])
        && [
            "databaseInstanceId",
            "writerId",
            "operationId",
            "mutationAttemptId",
            "schemaContractId",
        ]
        .iter()
        .all(|k| safe(&request[k]))
        && [
            "codeProvenanceHash",
            "globalPreviousHash",
            "databasePreviousHash",
            "schemaHash",
            "preStateHash",
            "postStateHash",
        ]
        .iter()
        .all(|k| sha(&request[k]))
        && integer(&request["globalPreviousSequence"], 0)
        && integer(&request["databasePreviousSequence"], 0)
        && request["preStateHash"] != request["postStateHash"]
        && changeset_valid(request)?
        && sorted(&request["authorizationReceiptHashes"], sha)
        && sorted(&request["sideEffectReservationHashes"], sha)
        && timestamp(&request["requestedAt"]).is_some()
        && integer(&request["requestedLeaseMs"], 1000)
        && int(request, "requestedLeaseMs")? <= int(trust, "maximumReservationLeaseMs")?;
    if !valid {
        return Err(error(
            "autonomous_research_online_mutation_reserve_request_invalid",
        ));
    }
    let mut state = copied(
        request,
        &[
            "databaseRole",
            "databaseInstanceId",
            "writerId",
            "operationId",
            "schemaHash",
            "changesetHash",
            "authorizationReceiptHashes",
            "sideEffectReservationHashes",
        ],
    );
    state.insert("previousStateHash".into(), request["preStateHash"].clone());
    state.insert(
        "databaseSequence".into(),
        json!(int(request, "databasePreviousSequence")? + 1),
    );
    if request["postStateHash"] != online_mutation_state_hash_v1(&Value::Object(state))? {
        return Err(error(
            "autonomous_research_online_mutation_reserve_request_invalid",
        ));
    }
    Ok(())
}
fn signed(receipt: &Value, trust: &Value, verify: &impl Fn(&Value) -> bool) -> bool {
    matches(receipt, trust, &["authorityId", "keyId"]) && verify(receipt)
}
pub fn verify_reservation_v1(
    receipt: &Value,
    request: &Value,
    trust: &Value,
    now: i64,
    verify: &impl Fn(&Value) -> bool,
) -> Result<bool> {
    assert_reserve_request_v1(request, trust)?;
    let (Some(issued), Some(expires)) = (
        timestamp(&receipt["issuedAt"]),
        timestamp(&receipt["expiresAt"]),
    ) else {
        return Ok(false);
    };
    Ok(keys(receipt, RESERVATION_KEYS)
        && receipt["version"].as_f64() == Some(1.0)
        && receipt["kind"] == "AutonomousResearchOnlineMutationReservationReceipt"
        && receipt["status"] == "autonomous_research_online_mutation_reserved"
        && safe(&receipt["reservationId"])
        && receipt["requestHash"]
            == hash("AutonomousResearchOnlineMutationReserveRequest", request)?
        && matches(
            receipt,
            request,
            &[
                "protocol",
                "scopeId",
                "databaseScopeHash",
                "writerManifestHash",
                "databaseRole",
                "databaseInstanceId",
                "writerId",
                "operationId",
                "codeProvenanceHash",
                "mutationAttemptId",
                "globalPreviousSequence",
                "globalPreviousHash",
                "databasePreviousSequence",
                "databasePreviousHash",
                "schemaContractId",
                "schemaHash",
                "preStateHash",
                "postStateHash",
                "changesetEncoding",
                "changesetBase64",
                "changesetByteLength",
                "changesetHash",
                "authorizationReceiptHashes",
                "sideEffectReservationHashes",
            ],
        )
        && integer(&receipt["globalSequence"], 0)
        && int(receipt, "globalSequence")? == int(request, "globalPreviousSequence")? + 1
        && sha(&receipt["globalHash"])
        && integer(&receipt["databaseSequence"], 0)
        && int(receipt, "databaseSequence")? == int(request, "databasePreviousSequence")? + 1
        && sha(&receipt["databaseHash"])
        && changeset_valid(receipt)?
        && issued <= now.saturating_add(5000)
        && expires > now
        && expires > issued
        && expires - issued <= int(request, "requestedLeaseMs")?
        && signed(receipt, trust, verify))
}
pub fn build_finalize_request_v1(reservation: &Value, committed_at: &Value) -> Result<Value> {
    let mut value = copied(
        reservation,
        &[
            "protocol",
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
            "reservationId",
            "databaseRole",
            "databaseInstanceId",
            "writerId",
            "operationId",
            "globalSequence",
            "globalHash",
            "databaseSequence",
            "databaseHash",
            "schemaHash",
            "postStateHash",
            "changesetHash",
            "authorizationReceiptHashes",
            "sideEffectReservationHashes",
        ],
    );
    value.insert("version".into(), json!(1));
    value.insert(
        "kind".into(),
        json!("AutonomousResearchOnlineMutationFinalizeRequest"),
    );
    value.insert(
        "reservationReceiptHash".into(),
        json!(online_mutation_receipt_hash_v1(reservation)?),
    );
    value.insert(
        "localMarkerHash".into(),
        json!(online_mutation_local_marker_hash_v1(
            reservation,
            committed_at
        )?),
    );
    value.insert("committedAt".into(), committed_at.clone());
    Ok(Value::Object(value))
}
pub fn assert_finalize_request_v1(request: &Value, reservation: &Value) -> Result<()> {
    if !common(
        request,
        FINALIZE_REQUEST_KEYS,
        "AutonomousResearchOnlineMutationFinalizeRequest",
    ) || !safe(&request["reservationId"])
        || request["reservationId"] != reservation["reservationId"]
        || request["reservationReceiptHash"] != online_mutation_receipt_hash_v1(reservation)?
        || !role(&request["databaseRole"])
        || !["databaseInstanceId", "writerId", "operationId"]
            .iter()
            .all(|k| safe(&request[k]))
        || ![
            "reservationReceiptHash",
            "globalHash",
            "databaseHash",
            "schemaHash",
            "postStateHash",
            "changesetHash",
            "localMarkerHash",
        ]
        .iter()
        .all(|k| sha(&request[k]))
        || !["globalSequence", "databaseSequence"]
            .iter()
            .all(|k| integer(&request[k], -9_007_199_254_740_991))
        || !sorted(&request["authorizationReceiptHashes"], sha)
        || !sorted(&request["sideEffectReservationHashes"], sha)
        || timestamp(&request["committedAt"]).is_none()
        || request["localMarkerHash"]
            != online_mutation_local_marker_hash_v1(reservation, &request["committedAt"])?
    {
        return Err(error(
            "autonomous_research_online_mutation_finalize_request_invalid",
        ));
    }
    if !matches(
        request,
        reservation,
        &[
            "protocol",
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
            "databaseRole",
            "databaseInstanceId",
            "writerId",
            "operationId",
            "globalSequence",
            "globalHash",
            "databaseSequence",
            "databaseHash",
            "schemaHash",
            "postStateHash",
            "changesetHash",
            "authorizationReceiptHashes",
            "sideEffectReservationHashes",
        ],
    ) {
        return Err(error(
            "autonomous_research_online_mutation_finalize_request_reservation_mismatch",
        ));
    }
    Ok(())
}
pub fn verify_finalization_v1(
    receipt: &Value,
    request: &Value,
    reservation: &Value,
    trust: &Value,
    now: i64,
    verify: &impl Fn(&Value) -> bool,
) -> Result<bool> {
    assert_authority_trust_v1(trust)?;
    assert_finalize_request_v1(request, reservation)?;
    let (Some(finalized), Some(committed), Some(issued), Some(expires)) = (
        timestamp(&receipt["finalizedAt"]),
        timestamp(&request["committedAt"]),
        timestamp(&reservation["issuedAt"]),
        timestamp(&reservation["expiresAt"]),
    ) else {
        return Ok(false);
    };
    Ok(keys(receipt, FINALIZATION_KEYS)
        && receipt["version"].as_f64() == Some(1.0)
        && receipt["kind"] == "AutonomousResearchOnlineMutationFinalizationReceipt"
        && receipt["status"] == "autonomous_research_online_mutation_finalized"
        && receipt["requestHash"]
            == hash("AutonomousResearchOnlineMutationFinalizeRequest", request)?
        && matches(
            receipt,
            request,
            &[
                "reservationId",
                "reservationReceiptHash",
                "protocol",
                "scopeId",
                "databaseScopeHash",
                "writerManifestHash",
                "databaseRole",
                "databaseInstanceId",
                "writerId",
                "operationId",
                "globalSequence",
                "globalHash",
                "databaseSequence",
                "databaseHash",
                "schemaHash",
                "postStateHash",
                "changesetHash",
                "localMarkerHash",
                "authorizationReceiptHashes",
                "sideEffectReservationHashes",
            ],
        )
        && sha(&receipt["sideEffectPermitHash"])
        && committed >= issued - 5000
        && committed <= expires
        && finalized >= committed
        && finalized <= now.saturating_add(5000)
        && signed(receipt, trust, verify))
}
fn database_heads_valid(heads: &Value, expected: Option<&Value>) -> bool {
    let Some(heads) = heads.as_array().filter(|a| !a.is_empty()) else {
        return false;
    };
    if !heads.iter().all(|h| {
        keys(
            h,
            &[
                "databaseRole",
                "databaseInstanceId",
                "sequence",
                "hash",
                "schemaHash",
                "stateHash",
            ],
        ) && role(&h["databaseRole"])
            && safe(&h["databaseInstanceId"])
            && integer(&h["sequence"], 0)
            && ["hash", "schemaHash", "stateHash"]
                .iter()
                .all(|k| sha(&h[k]))
    }) || !heads
        .windows(2)
        .all(|p| p[0]["databaseInstanceId"].as_str() < p[1]["databaseInstanceId"].as_str())
    {
        return false;
    }
    let roles = heads
        .iter()
        .filter_map(|h| h["databaseRole"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    if roles != DATABASE_ROLES.iter().copied().collect() {
        return false;
    }
    expected.is_none_or(|expected| {
        expected.as_array().is_some_and(|e| {
            e.len() == heads.len()
                && e.iter().zip(heads).all(|(e, h)| {
                    keys(e, &["databaseRole", "databaseInstanceId", "schemaHash"])
                        && matches(e, h, &["databaseRole", "databaseInstanceId", "schemaHash"])
                })
        })
    })
}
fn live(receipt: &Value, trust: &Value, observed_key: &str, now: i64) -> bool {
    let (Some(observed), Some(expires), Some(max_age), Some(max_lease)) = (
        timestamp(&receipt[observed_key]),
        timestamp(&receipt["expiresAt"]),
        int(trust, "maximumObservationAgeMs").ok(),
        int(trust, "maximumReservationLeaseMs").ok(),
    ) else {
        return false;
    };
    observed <= now.saturating_add(5000)
        && now.saturating_sub(observed) <= max_age
        && expires > now
        && expires > observed
        && expires - observed <= max_lease
}
pub fn verify_current_head_v1(
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
        HEAD_REQUEST_KEYS,
        "AutonomousResearchOnlineMutationCurrentHeadRequest",
    ) || !scoped(request, trust)
        || !safe(&request["nonce"])
        || timestamp(&request["requestedAt"]).is_none()
    {
        return Err(error(
            "autonomous_research_online_mutation_observation_request_invalid",
        ));
    }
    Ok(keys(receipt, HEAD_RECEIPT_KEYS)
        && receipt["version"].as_f64() == Some(1.0)
        && receipt["kind"] == "AutonomousResearchOnlineMutationCurrentHeadReceipt"
        && receipt["status"] == "autonomous_research_online_mutation_current_head_observed"
        && receipt["requestHash"]
            == hash(
                "AutonomousResearchOnlineMutationCurrentHeadRequest",
                request,
            )?
        && receipt["protocol"] == request["protocol"]
        && scoped(receipt, request)
        && integer(&receipt["globalSequence"], 0)
        && sha(&receipt["globalHash"])
        && database_heads_valid(&receipt["databaseHeads"], expected_instances)
        && signed(receipt, trust, verify)
        && live(receipt, trust, "observedAt", now)
        && receipt["unresolvedReservationCount"].as_f64() == Some(0.0))
}
pub fn build_abort_request_v1(
    reservation: &Value,
    reason: &str,
    requested_at: &Value,
) -> Result<Value> {
    let mut value = copied(
        reservation,
        &[
            "protocol",
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
            "reservationId",
            "databaseRole",
            "databaseInstanceId",
            "writerId",
            "operationId",
            "mutationAttemptId",
            "globalSequence",
            "globalHash",
            "databaseSequence",
            "databaseHash",
            "changesetHash",
        ],
    );
    value.extend([
        ("version".into(), json!(1)),
        (
            "kind".into(),
            json!("AutonomousResearchOnlineMutationAbortRequest"),
        ),
        ("reason".into(), json!(reason)),
        ("requestedAt".into(), requested_at.clone()),
        (
            "reservationReceiptHash".into(),
            json!(online_mutation_receipt_hash_v1(reservation)?),
        ),
    ]);
    Ok(Value::Object(value))
}
pub fn assert_abort_request_v1(request: &Value, reservation: &Value) -> Result<()> {
    if !common(
        request,
        ABORT_REQUEST_KEYS,
        "AutonomousResearchOnlineMutationAbortRequest",
    ) || !matches(
        request,
        reservation,
        &[
            "protocol",
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
            "reservationId",
            "databaseRole",
            "databaseInstanceId",
            "writerId",
            "operationId",
            "mutationAttemptId",
            "globalSequence",
            "globalHash",
            "databaseSequence",
            "databaseHash",
            "changesetHash",
        ],
    ) || ![
        "reservationId",
        "databaseInstanceId",
        "writerId",
        "operationId",
        "mutationAttemptId",
    ]
    .iter()
    .all(|k| safe(&request[k]))
        || ![
            "globalHash",
            "databaseHash",
            "changesetHash",
            "reservationReceiptHash",
        ]
        .iter()
        .all(|k| sha(&request[k]))
        || !integer(&request["globalSequence"], 1)
        || !integer(&request["databaseSequence"], 1)
        || request["reservationReceiptHash"] != online_mutation_receipt_hash_v1(reservation)?
        || !request["reason"].as_str().is_some_and(|s| {
            [
                "local-apply-failed",
                "local-marker-failed",
                "local-commit-failed",
            ]
            .contains(&s)
        })
        || timestamp(&request["requestedAt"]).is_none()
    {
        return Err(error(
            "autonomous_research_online_mutation_abort_request_invalid",
        ));
    }
    Ok(())
}
pub fn verify_abort_v1(
    receipt: &Value,
    request: &Value,
    reservation: &Value,
    trust: &Value,
    now: i64,
    verify: &impl Fn(&Value) -> bool,
) -> Result<bool> {
    assert_abort_request_v1(request, reservation)?;
    Ok(keys(receipt, ABORT_RECEIPT_KEYS)
        && receipt["version"].as_f64() == Some(1.0)
        && receipt["kind"] == "AutonomousResearchOnlineMutationAbortReceipt"
        && receipt["status"] == "autonomous_research_online_mutation_aborted"
        && receipt["requestHash"] == hash("AutonomousResearchOnlineMutationAbortRequest", request)?
        && matches(receipt, request, &ABORT_REQUEST_KEYS[2..])
        && timestamp(&receipt["abortedAt"]).is_some_and(|t| t <= now.saturating_add(5000))
        && signed(receipt, trust, verify))
}
pub fn build_resolution_request_v1(reserve_request: &Value, requested_at: &Value) -> Result<Value> {
    let mut value = copied(
        reserve_request,
        &[
            "protocol",
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
            "mutationAttemptId",
        ],
    );
    value.extend([
        ("version".into(), json!(1)),
        (
            "kind".into(),
            json!("AutonomousResearchOnlineMutationResolutionRequest"),
        ),
        (
            "reserveRequestHash".into(),
            json!(hash(
                "AutonomousResearchOnlineMutationReserveRequest",
                reserve_request
            )?),
        ),
        ("requestedAt".into(), requested_at.clone()),
    ]);
    Ok(Value::Object(value))
}
pub fn assert_resolution_request_v1(request: &Value, reserve: &Value) -> Result<()> {
    if !common(
        request,
        RESOLUTION_REQUEST_KEYS,
        "AutonomousResearchOnlineMutationResolutionRequest",
    ) || !matches(
        request,
        reserve,
        &[
            "protocol",
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
            "mutationAttemptId",
        ],
    ) || !safe(&request["mutationAttemptId"])
        || request["reserveRequestHash"]
            != hash("AutonomousResearchOnlineMutationReserveRequest", reserve)?
        || timestamp(&request["requestedAt"]).is_none()
    {
        return Err(error(
            "autonomous_research_online_mutation_resolution_request_invalid",
        ));
    }
    Ok(())
}
pub fn verify_resolution_v1(
    receipt: &Value,
    request: &Value,
    reserve: &Value,
    trust: &Value,
    now: i64,
    verify: &impl Fn(&Value) -> bool,
) -> Result<bool> {
    assert_resolution_request_v1(request, reserve)?;
    let valid = match receipt["resolution"].as_str() {
        Some("not-found") => receipt["reservation"].is_null(),
        Some("reserved") => {
            verify_reservation_v1(&receipt["reservation"], reserve, trust, now, verify)?
        }
        _ => false,
    };
    Ok(keys(receipt, RESOLUTION_RECEIPT_KEYS)
        && receipt["version"].as_f64() == Some(1.0)
        && receipt["kind"] == "AutonomousResearchOnlineMutationResolutionReceipt"
        && receipt["status"] == "autonomous_research_online_mutation_resolution_observed"
        && receipt["requestHash"]
            == hash("AutonomousResearchOnlineMutationResolutionRequest", request)?
        && matches(receipt, request, &RESOLUTION_REQUEST_KEYS[2..])
        && valid
        && timestamp(&receipt["observedAt"]).is_some_and(|t| {
            t <= now.saturating_add(5000)
                && now.saturating_sub(t) <= int(trust, "maximumObservationAgeMs").ok().unwrap_or(0)
        })
        && signed(receipt, trust, verify))
}

//! Schema-transition contracts for quiesced migration and pristine rebind.
use super::*;
use std::collections::BTreeSet;
pub(crate) fn normalize_schema_numbers_v1(value: &Value) -> Result<Value> {
    let bytes = hepta_legacy_compatibility::production_stable_json_v1(value)
        .map_err(|e| error(e.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|e| error(e.to_string()))
}

pub const SCHEMA_TRANSITION_PROTOCOL_V1: &str =
    "external-authority-quiesced-offline-schema-transition-v1";
pub const PRISTINE_SCHEMA_REBIND_PROTOCOL_V2: &str =
    "external-authority-pristine-finalized-schema-rebind-v2";
const INSTANCE_KEYS: &[&str] = &[
    "databaseRole",
    "databaseInstanceId",
    "sourceRelativePath",
    "preSchemaContractId",
    "schemaContractId",
    "preSchemaHash",
    "expectedPostSchemaHash",
    "sourceSha256",
    "sourceFileIdentityHash",
    "journalPreimageHash",
    "expectedNormalizedSourceSha256",
    "prePristineStateHash",
];
const GENESIS_KEYS: &[&str] = &[
    "databaseRole",
    "databaseInstanceId",
    "schemaContractId",
    "schemaHash",
    "globalSequence",
    "globalHash",
    "databaseSequence",
    "databaseHash",
    "stateHash",
];
const PREVIOUS_HEAD_KEYS: &[&str] = &[
    "databaseRole",
    "databaseInstanceId",
    "sequence",
    "hash",
    "schemaHash",
    "stateHash",
];
const INSTALLATION_KEYS: &[&str] = &[
    "databaseRole",
    "databaseInstanceId",
    "schemaContractId",
    "preSchemaHash",
    "postSchemaHash",
    "prePristineStateHash",
    "postPristineStateHash",
    "installationHash",
];
const RESERVE_REQUEST_KEYS: &[&str] = &[
    "version",
    "kind",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "stateDatabaseManifestHash",
    "transitionInventoryHash",
    "schemaBundleHash",
    "authorityJournalSchemaContractId",
    "authorityJournalSchemaHash",
    "markerSchemaHash",
    "transitionId",
    "instances",
    "requestedAt",
    "requestedLeaseMs",
    "requiredExecutionWindowMs",
];
const REBIND_RESERVE_REQUEST_KEYS: &[&str] = &[
    "version",
    "kind",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "stateDatabaseManifestHash",
    "transitionInventoryHash",
    "schemaBundleHash",
    "authorityJournalSchemaContractId",
    "authorityJournalSchemaHash",
    "markerSchemaHash",
    "transitionId",
    "instances",
    "requestedAt",
    "requestedLeaseMs",
    "requiredExecutionWindowMs",
    "transitionMode",
    "sourceWriterManifestHash",
    "prePristineRuntimeStateHash",
];
const RESERVATION_KEYS: &[&str] = &[
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
    "stateDatabaseManifestHash",
    "transitionInventoryHash",
    "schemaBundleHash",
    "authorityJournalSchemaContractId",
    "authorityJournalSchemaHash",
    "markerSchemaHash",
    "transitionId",
    "instances",
    "databaseGenesis",
    "issuedAt",
    "expiresAt",
    "allRegisteredMutationsFenced",
    "quiescenceMode",
    "signature",
];
const REBIND_RESERVATION_KEYS: &[&str] = &[
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
    "stateDatabaseManifestHash",
    "transitionInventoryHash",
    "schemaBundleHash",
    "authorityJournalSchemaContractId",
    "authorityJournalSchemaHash",
    "markerSchemaHash",
    "transitionId",
    "instances",
    "databaseGenesis",
    "issuedAt",
    "expiresAt",
    "allRegisteredMutationsFenced",
    "quiescenceMode",
    "signature",
    "transitionMode",
    "sourceWriterManifestHash",
    "previousGlobalSequence",
    "previousGlobalHash",
    "previousDatabaseHeads",
    "targetAuthorityConfigurationHash",
    "authorityRestartRequired",
    "prePristineRuntimeStateHash",
];
const FINALIZE_REQUEST_KEYS: &[&str] = &[
    "version",
    "kind",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "transitionId",
    "transitionInventoryHash",
    "schemaBundleHash",
    "reservationId",
    "reservationReceiptHash",
    "postInventoryHash",
    "postPristineRuntimeStateHash",
    "installations",
    "completedAt",
];
const FINALIZATION_KEYS: &[&str] = &[
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
    "transitionId",
    "transitionInventoryHash",
    "schemaBundleHash",
    "reservationId",
    "reservationReceiptHash",
    "postInventoryHash",
    "postPristineRuntimeStateHash",
    "installations",
    "globalSequence",
    "globalHash",
    "finalizedAt",
    "allRegisteredMutationsFencedThroughFinalize",
    "signature",
];
const REBIND_FINALIZATION_KEYS: &[&str] = &[
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
    "transitionId",
    "transitionInventoryHash",
    "schemaBundleHash",
    "reservationId",
    "reservationReceiptHash",
    "postInventoryHash",
    "postPristineRuntimeStateHash",
    "installations",
    "globalSequence",
    "globalHash",
    "finalizedAt",
    "allRegisteredMutationsFencedThroughFinalize",
    "signature",
    "transitionMode",
    "sourceWriterManifestHash",
    "targetAuthorityConfigurationHash",
    "authorityRestartRequired",
];
const OBSERVE_REQUEST_KEYS: &[&str] = &[
    "version",
    "kind",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "transitionId",
    "transitionInventoryHash",
    "schemaBundleHash",
    "finalizationReceiptHash",
    "postInventoryHash",
    "postPristineRuntimeStateHash",
    "nonce",
    "requestedAt",
];
const REBIND_OBSERVE_REQUEST_KEYS: &[&str] = &[
    "version",
    "kind",
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "transitionId",
    "transitionInventoryHash",
    "schemaBundleHash",
    "finalizationReceiptHash",
    "postInventoryHash",
    "postPristineRuntimeStateHash",
    "nonce",
    "requestedAt",
    "transitionMode",
    "sourceWriterManifestHash",
];
const OBSERVATION_KEYS: &[&str] = &[
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
    "transitionId",
    "transitionInventoryHash",
    "schemaBundleHash",
    "finalizationReceiptHash",
    "postInventoryHash",
    "postPristineRuntimeStateHash",
    "transitionState",
    "globalSequence",
    "globalHash",
    "observedAt",
    "expiresAt",
    "signature",
];
const REBIND_OBSERVATION_KEYS: &[&str] = &[
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
    "transitionId",
    "transitionInventoryHash",
    "schemaBundleHash",
    "finalizationReceiptHash",
    "postInventoryHash",
    "postPristineRuntimeStateHash",
    "transitionState",
    "globalSequence",
    "globalHash",
    "observedAt",
    "expiresAt",
    "signature",
    "transitionMode",
    "sourceWriterManifestHash",
    "authorityConfigurationActivated",
];
fn rebind(value: &Value) -> bool {
    value["version"] == 2 && value["transitionMode"] == "pristine-finalized-writer-manifest-rebind"
}
fn protocol(value: &Value) -> bool {
    value["version"] == if rebind(value) { 2 } else { 1 }
        && value["protocol"]
            == if rebind(value) {
                PRISTINE_SCHEMA_REBIND_PROTOCOL_V2
            } else {
                SCHEMA_TRANSITION_PROTOCOL_V1
            }
}
fn trust(value: &Value) -> Result<()> {
    if value["version"] != 1
        || value["kind"] != "AutonomousResearchOnlineMutationAuthorityTrust"
        || !["authorityId", "keyId", "scopeId"]
            .iter()
            .all(|k| safe(&value[k]))
        || !["databaseScopeHash", "writerManifestHash"]
            .iter()
            .all(|k| sha(&value[k]))
        || !["maximumReservationLeaseMs", "maximumObservationAgeMs"]
            .iter()
            .all(|k| integer(&value[k], 1000))
    {
        return Err(error(
            "autonomous_research_online_schema_transition_authority_trust_invalid",
        ));
    }
    Ok(())
}
fn subject(request: &Value, trust: &Value) -> bool {
    matches(request, trust, &["scopeId", "databaseScopeHash"])
        && sha(&request["writerManifestHash"])
        && if rebind(request) {
            sha(&request["sourceWriterManifestHash"])
                && request["sourceWriterManifestHash"] != request["writerManifestHash"]
                && [
                    request["sourceWriterManifestHash"].clone(),
                    request["writerManifestHash"].clone(),
                ]
                .contains(&trust["writerManifestHash"])
        } else {
            request["writerManifestHash"] == trust["writerManifestHash"]
        }
}
fn valid_instances(instances: &Value) -> bool {
    let Some(rows) = instances
        .as_array()
        .filter(|v| v.len() == DATABASE_ROLES.len())
    else {
        return false;
    };
    let mut roles = BTreeSet::new();
    let mut ids = BTreeSet::new();
    rows.iter().all(|row| {
        keys(row, INSTANCE_KEYS)
            && role(&row["databaseRole"])
            && roles.insert(row["databaseRole"].as_str())
            && ids.insert(row["databaseInstanceId"].as_str())
            && [
                "databaseInstanceId",
                "preSchemaContractId",
                "schemaContractId",
            ]
            .iter()
            .all(|k| safe(&row[k]))
            && row["sourceRelativePath"].as_str().is_some_and(|p| {
                !p.is_empty()
                    && !p.contains('\\')
                    && !p.starts_with('/')
                    && !p.contains("//")
                    && !p.split('/').any(|v| v == "." || v == "..")
            })
            && [
                "preSchemaHash",
                "expectedPostSchemaHash",
                "sourceSha256",
                "sourceFileIdentityHash",
                "journalPreimageHash",
                "expectedNormalizedSourceSha256",
                "prePristineStateHash",
            ]
            .iter()
            .all(|k| sha(&row[k]))
    }) && rows
        .windows(2)
        .all(|p| p[0]["databaseInstanceId"].as_str() < p[1]["databaseInstanceId"].as_str())
}
fn project(value: &Value, names: &[&str]) -> Value {
    Value::Object(
        names
            .iter()
            .filter_map(|k| value.get(k).map(|v| ((*k).into(), v.clone())))
            .collect(),
    )
}
pub fn schema_transition_inventory_hash_v1(request: &Value) -> Result<String> {
    hash(
        "AutonomousResearchOnlineSchemaTransitionInventory",
        &project(
            request,
            &[
                "stateDatabaseManifestHash",
                "databaseScopeHash",
                "instances",
            ],
        ),
    )
}
pub fn schema_transition_identity_v1(request: &Value) -> Result<String> {
    let rows = request["instances"].as_array().ok_or_else(|| {
        error("autonomous_research_online_schema_transition_reserve_request_invalid")
    })?;
    let mut identity = project(
        request,
        &[
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
            "stateDatabaseManifestHash",
            "schemaBundleHash",
        ],
    );
    identity["instances"] = json!(
        rows.iter()
            .map(|r| project(
                r,
                &[
                    "databaseRole",
                    "databaseInstanceId",
                    "sourceRelativePath",
                    "preSchemaContractId",
                    "schemaContractId",
                    "prePristineStateHash",
                    "expectedPostSchemaHash"
                ]
            ))
            .collect::<Vec<_>>()
    );
    if request["version"] == 2 {
        for key in [
            "transitionMode",
            "sourceWriterManifestHash",
            "prePristineRuntimeStateHash",
        ] {
            identity[key] = request[key].clone();
        }
    }
    hash(
        "AutonomousResearchOnlineSchemaTransitionIdentity",
        &identity,
    )
}
pub fn schema_transition_receipt_hash_v1(receipt: &Value) -> Result<String> {
    hash(
        receipt["kind"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("InvalidSchemaTransitionReceipt"),
        receipt,
    )
}
pub fn assert_schema_transition_reserve_request_v1(
    request: &Value,
    authority_trust: &Value,
) -> Result<()> {
    let request_normalized = normalize_schema_numbers_v1(request)?;
    let request = &request_normalized;
    let authority_trust_normalized = normalize_schema_numbers_v1(authority_trust)?;
    let authority_trust = &authority_trust_normalized;
    trust(authority_trust)?;
    let fail = || error("autonomous_research_online_schema_transition_reserve_request_invalid");
    if !keys(
        request,
        if rebind(request) {
            REBIND_RESERVE_REQUEST_KEYS
        } else {
            RESERVE_REQUEST_KEYS
        },
    ) || !protocol(request)
        || request["kind"] != "AutonomousResearchOnlineSchemaTransitionReserveRequest"
        || !subject(request, authority_trust)
        || (rebind(request) && !sha(&request["prePristineRuntimeStateHash"]))
        || ![
            "stateDatabaseManifestHash",
            "transitionInventoryHash",
            "schemaBundleHash",
            "authorityJournalSchemaHash",
            "markerSchemaHash",
            "transitionId",
        ]
        .iter()
        .all(|k| sha(&request[k]))
        || !safe(&request["authorityJournalSchemaContractId"])
        || !valid_instances(&request["instances"])
        || timestamp(&request["requestedAt"]).is_none()
        || !integer(&request["requestedLeaseMs"], 1000)
        || !integer(&request["requiredExecutionWindowMs"], 1000)
        || int(request, "requestedLeaseMs")? > int(authority_trust, "maximumReservationLeaseMs")?
        || int(request, "requiredExecutionWindowMs")? > int(request, "requestedLeaseMs")?
    {
        return Err(fail());
    }
    let rows = request["instances"].as_array().ok_or_else(fail)?;
    let scope_rows = json!(rows.iter().map(|v| json!({"instanceId":v["databaseInstanceId"],"role":v["databaseRole"],"sourceRelativePath":v["sourceRelativePath"]})).collect::<Vec<_>>());
    let scope =
        crate::online_runtime_activation::inventory::state_database_scope_hash_v1(&scope_rows)
            .map_err(|e| error(e.code))?;
    if request["databaseScopeHash"] != scope
        || request["transitionInventoryHash"] != schema_transition_inventory_hash_v1(request)?
        || request["transitionId"] != schema_transition_identity_v1(request)?
    {
        return Err(fail());
    }
    Ok(())
}
fn previous_heads(rows: &Value, request: &Value) -> bool {
    let (Some(rows), Some(instances)) = (rows.as_array(), request["instances"].as_array()) else {
        return false;
    };
    rows.len() == instances.len()
        && rows.iter().zip(instances).all(|(r, i)| {
            keys(r, PREVIOUS_HEAD_KEYS)
                && matches(r, i, &["databaseRole", "databaseInstanceId"])
                && r["sequence"] == 0
                && r["schemaHash"] == i["preSchemaHash"]
                && sha(&r["hash"])
                && sha(&r["stateHash"])
        })
}
pub fn build_pristine_schema_rebind_genesis_v2(
    request: &Value,
    previous_global_hash: &Value,
    previous_database_heads: &Value,
) -> Result<Value> {
    let request_normalized = normalize_schema_numbers_v1(request)?;
    let request = &request_normalized;
    let previous_database_heads_normalized = normalize_schema_numbers_v1(previous_database_heads)?;
    let previous_database_heads = &previous_database_heads_normalized;
    let fail = || error("autonomous_research_pristine_schema_rebind_genesis_input_invalid");
    if !rebind(request)
        || !sha(previous_global_hash)
        || !previous_heads(previous_database_heads, request)
    {
        return Err(fail());
    }
    let global = hash(
        "AutonomousResearchPristineSchemaRebindGlobalGenesis",
        &json!({"transitionId":request["transitionId"],"sourceWriterManifestHash":request["sourceWriterManifestHash"],"targetWriterManifestHash":request["writerManifestHash"],"previousGlobalHash":previous_global_hash}),
    )?;
    let instances = request["instances"].as_array().ok_or_else(fail)?;
    let heads = previous_database_heads.as_array().ok_or_else(fail)?;
    let mut rows = Vec::new();
    for (i, p) in instances.iter().zip(heads) {
        rows.push(json!({"databaseRole":i["databaseRole"],"databaseInstanceId":i["databaseInstanceId"],"schemaContractId":i["schemaContractId"],"schemaHash":i["expectedPostSchemaHash"],"globalSequence":0,"globalHash":global,"databaseSequence":0,
            "databaseHash":hash("AutonomousResearchPristineSchemaRebindDatabaseGenesis",&json!({"transitionId":request["transitionId"],"databaseInstanceId":i["databaseInstanceId"],"previousDatabaseHash":p["hash"],"targetSchemaHash":i["expectedPostSchemaHash"]}))?,
            "stateHash":hash("AutonomousResearchPristineSchemaRebindStateGenesis",&json!({"transitionId":request["transitionId"],"databaseInstanceId":i["databaseInstanceId"],"previousStateHash":p["stateHash"],"sourceSha256":i["sourceSha256"],"targetSchemaHash":i["expectedPostSchemaHash"]}))?}));
    }
    Ok(json!(rows))
}
fn valid_genesis(receipt: &Value, request: &Value) -> Result<bool> {
    let (Some(rows), Some(instances)) = (
        receipt["databaseGenesis"].as_array(),
        request["instances"].as_array(),
    ) else {
        return Ok(false);
    };
    if rows.len() != instances.len()
        || !rows.iter().zip(instances).all(|(r, i)| {
            keys(r, GENESIS_KEYS)
                && matches(
                    r,
                    i,
                    &["databaseRole", "databaseInstanceId", "schemaContractId"],
                )
                && r["schemaHash"] == i["expectedPostSchemaHash"]
                && r["globalSequence"] == 0
                && r["databaseSequence"] == 0
                && ["globalHash", "databaseHash", "stateHash"]
                    .iter()
                    .all(|k| sha(&r[k]))
        })
    {
        return Ok(false);
    }
    if rebind(request) {
        return Ok(build_pristine_schema_rebind_genesis_v2(
            request,
            &receipt["previousGlobalHash"],
            &receipt["previousDatabaseHeads"],
        )
        .is_ok_and(|v| v == receipt["databaseGenesis"]));
    }
    Ok(true)
}
fn signed(receipt: &Value, trust: &Value, verify: &dyn Fn(&Value) -> bool) -> bool {
    matches(receipt, trust, &["authorityId", "keyId"]) && verify(receipt)
}
pub fn verify_schema_transition_reservation_v1(
    receipt: &Value,
    request: &Value,
    authority_trust: &Value,
    now: i64,
    verify: &dyn Fn(&Value) -> bool,
) -> Result<bool> {
    let receipt_normalized = normalize_schema_numbers_v1(receipt)?;
    let receipt = &receipt_normalized;
    let request_normalized = normalize_schema_numbers_v1(request)?;
    let request = &request_normalized;
    let authority_trust_normalized = normalize_schema_numbers_v1(authority_trust)?;
    let authority_trust = &authority_trust_normalized;
    assert_schema_transition_reserve_request_v1(request, authority_trust)?;
    let (Some(issued), Some(expires)) = (
        timestamp(&receipt["issuedAt"]),
        timestamp(&receipt["expiresAt"]),
    ) else {
        return Ok(false);
    };
    Ok(keys(
        receipt,
        if rebind(request) {
            REBIND_RESERVATION_KEYS
        } else {
            RESERVATION_KEYS
        },
    ) && receipt["version"] == request["version"]
        && receipt["kind"] == "AutonomousResearchOnlineSchemaTransitionReservationReceipt"
        && receipt["status"] == "autonomous_research_online_schema_transition_reserved"
        && safe(&receipt["reservationId"])
        && receipt["requestHash"]
            == hash(
                "AutonomousResearchOnlineSchemaTransitionReserveRequest",
                request,
            )?
        && matches(
            receipt,
            request,
            &[
                "protocol",
                "scopeId",
                "databaseScopeHash",
                "writerManifestHash",
                "stateDatabaseManifestHash",
                "transitionInventoryHash",
                "schemaBundleHash",
                "authorityJournalSchemaContractId",
                "authorityJournalSchemaHash",
                "markerSchemaHash",
                "transitionId",
                "instances",
            ],
        )
        && valid_genesis(receipt, request)?
        && (!rebind(request)
            || (matches(
                receipt,
                request,
                &[
                    "transitionMode",
                    "sourceWriterManifestHash",
                    "prePristineRuntimeStateHash",
                ],
            ) && receipt["previousGlobalSequence"] == 0
                && sha(&receipt["previousGlobalHash"])
                && previous_heads(&receipt["previousDatabaseHeads"], request)
                && sha(&receipt["targetAuthorityConfigurationHash"])
                && receipt["authorityRestartRequired"] == true))
        && receipt["allRegisteredMutationsFenced"] == true
        && receipt["quiescenceMode"]
            == if rebind(request) {
                "pristine-scope-held-through-target-configuration-restart"
            } else {
                "scope-wide-no-new-reservations-until-finalize-or-expiry"
            }
        && issued <= now.saturating_add(5000)
        && expires > now
        && expires > issued
        && expires.saturating_sub(issued) <= int(request, "requestedLeaseMs")?
        && signed(receipt, authority_trust, verify))
}
fn installations(rows: &Value, reservation: &Value) -> Result<bool> {
    let (Some(rows), Some(instances)) = (rows.as_array(), reservation["instances"].as_array())
    else {
        return Ok(false);
    };
    if rows.len() != instances.len() {
        return Ok(false);
    }
    let reservation_hash = schema_transition_receipt_hash_v1(reservation)?;
    for (row, instance) in rows.iter().zip(instances) {
        let mut payload = project(
            row,
            &[
                "databaseRole",
                "databaseInstanceId",
                "schemaContractId",
                "preSchemaHash",
                "postSchemaHash",
                "prePristineStateHash",
                "postPristineStateHash",
            ],
        );
        payload["transitionId"] = reservation["transitionId"].clone();
        payload["reservationReceiptHash"] = json!(reservation_hash);
        if !keys(row, INSTALLATION_KEYS)
            || !matches(
                row,
                instance,
                &[
                    "databaseRole",
                    "databaseInstanceId",
                    "schemaContractId",
                    "preSchemaHash",
                    "prePristineStateHash",
                ],
            )
            || row["postSchemaHash"] != instance["expectedPostSchemaHash"]
            || !sha(&row["postPristineStateHash"])
            || row["installationHash"]
                != hash(
                    "AutonomousResearchOnlineSchemaTransitionDatabaseInstallation",
                    &payload,
                )?
        {
            return Ok(false);
        }
    }
    Ok(true)
}
pub fn assert_schema_transition_finalize_request_v1(
    request: &Value,
    reservation: &Value,
) -> Result<()> {
    let request_normalized = normalize_schema_numbers_v1(request)?;
    let request = &request_normalized;
    let reservation_normalized = normalize_schema_numbers_v1(reservation)?;
    let reservation = &reservation_normalized;
    if !keys(request, FINALIZE_REQUEST_KEYS)
        || request["version"] != if rebind(reservation) { 2 } else { 1 }
        || request["kind"] != "AutonomousResearchOnlineSchemaTransitionFinalizeRequest"
        || request["protocol"]
            != if rebind(reservation) {
                PRISTINE_SCHEMA_REBIND_PROTOCOL_V2
            } else {
                SCHEMA_TRANSITION_PROTOCOL_V1
            }
        || !matches(
            request,
            reservation,
            &[
                "scopeId",
                "databaseScopeHash",
                "writerManifestHash",
                "transitionId",
                "transitionInventoryHash",
                "schemaBundleHash",
                "reservationId",
            ],
        )
        || request["reservationReceiptHash"] != schema_transition_receipt_hash_v1(reservation)?
        || !sha(&request["postInventoryHash"])
        || !sha(&request["postPristineRuntimeStateHash"])
        || !installations(&request["installations"], reservation)?
        || timestamp(&request["completedAt"]).is_none()
    {
        return Err(error(
            "autonomous_research_online_schema_transition_finalize_request_invalid",
        ));
    }
    Ok(())
}
pub fn verify_schema_transition_finalization_v1(
    receipt: &Value,
    request: &Value,
    reservation: &Value,
    authority_trust: &Value,
    now: i64,
    verify: &dyn Fn(&Value) -> bool,
) -> Result<bool> {
    let receipt_normalized = normalize_schema_numbers_v1(receipt)?;
    let receipt = &receipt_normalized;
    let request_normalized = normalize_schema_numbers_v1(request)?;
    let request = &request_normalized;
    let reservation_normalized = normalize_schema_numbers_v1(reservation)?;
    let reservation = &reservation_normalized;
    let authority_trust_normalized = normalize_schema_numbers_v1(authority_trust)?;
    let authority_trust = &authority_trust_normalized;
    trust(authority_trust)?;
    assert_schema_transition_finalize_request_v1(request, reservation)?;
    let (Some(finalized), Some(completed), Some(expires)) = (
        timestamp(&receipt["finalizedAt"]),
        timestamp(&request["completedAt"]),
        timestamp(&reservation["expiresAt"]),
    ) else {
        return Ok(false);
    };
    Ok(keys(
        receipt,
        if rebind(reservation) {
            REBIND_FINALIZATION_KEYS
        } else {
            FINALIZATION_KEYS
        },
    ) && receipt["version"] == request["version"]
        && receipt["kind"] == "AutonomousResearchOnlineSchemaTransitionFinalizationReceipt"
        && receipt["status"] == "autonomous_research_online_schema_transition_finalized"
        && receipt["requestHash"]
            == hash(
                "AutonomousResearchOnlineSchemaTransitionFinalizeRequest",
                request,
            )?
        && matches(
            receipt,
            request,
            &[
                "protocol",
                "scopeId",
                "databaseScopeHash",
                "writerManifestHash",
                "transitionId",
                "transitionInventoryHash",
                "schemaBundleHash",
                "reservationId",
                "reservationReceiptHash",
                "postInventoryHash",
                "postPristineRuntimeStateHash",
                "installations",
            ],
        )
        && (!rebind(reservation)
            || (matches(
                receipt,
                reservation,
                &[
                    "transitionMode",
                    "sourceWriterManifestHash",
                    "targetAuthorityConfigurationHash",
                ],
            ) && receipt["authorityRestartRequired"] == true))
        && integer(&receipt["globalSequence"], 0)
        && sha(&receipt["globalHash"])
        && receipt["allRegisteredMutationsFencedThroughFinalize"] == true
        && completed <= expires
        && finalized >= completed
        && finalized <= now.saturating_add(5000)
        && finalized <= expires
        && signed(receipt, authority_trust, verify))
}
pub fn assert_schema_transition_observe_request_v1(
    request: &Value,
    authority_trust: &Value,
) -> Result<()> {
    let request_normalized = normalize_schema_numbers_v1(request)?;
    let request = &request_normalized;
    let authority_trust_normalized = normalize_schema_numbers_v1(authority_trust)?;
    let authority_trust = &authority_trust_normalized;
    trust(authority_trust)?;
    if !keys(
        request,
        if rebind(request) {
            REBIND_OBSERVE_REQUEST_KEYS
        } else {
            OBSERVE_REQUEST_KEYS
        },
    ) || !protocol(request)
        || request["kind"] != "AutonomousResearchOnlineSchemaTransitionObserveRequest"
        || !subject(request, authority_trust)
        || ![
            "transitionId",
            "transitionInventoryHash",
            "schemaBundleHash",
            "finalizationReceiptHash",
            "postInventoryHash",
            "postPristineRuntimeStateHash",
        ]
        .iter()
        .all(|k| sha(&request[k]))
        || !safe(&request["nonce"])
        || timestamp(&request["requestedAt"]).is_none()
    {
        return Err(error(
            "autonomous_research_online_schema_transition_observe_request_invalid",
        ));
    }
    Ok(())
}
pub fn verify_schema_transition_observation_v1(
    receipt: &Value,
    request: &Value,
    authority_trust: &Value,
    now: i64,
    verify: &dyn Fn(&Value) -> bool,
) -> Result<bool> {
    let receipt_normalized = normalize_schema_numbers_v1(receipt)?;
    let receipt = &receipt_normalized;
    let request_normalized = normalize_schema_numbers_v1(request)?;
    let request = &request_normalized;
    let authority_trust_normalized = normalize_schema_numbers_v1(authority_trust)?;
    let authority_trust = &authority_trust_normalized;
    assert_schema_transition_observe_request_v1(request, authority_trust)?;
    let (Some(observed), Some(expires)) = (
        timestamp(&receipt["observedAt"]),
        timestamp(&receipt["expiresAt"]),
    ) else {
        return Ok(false);
    };
    Ok(keys(
        receipt,
        if rebind(request) {
            REBIND_OBSERVATION_KEYS
        } else {
            OBSERVATION_KEYS
        },
    ) && receipt["version"] == request["version"]
        && receipt["kind"] == "AutonomousResearchOnlineSchemaTransitionObservationReceipt"
        && receipt["status"] == "autonomous_research_online_schema_transition_observed_finalized"
        && receipt["requestHash"]
            == hash(
                "AutonomousResearchOnlineSchemaTransitionObserveRequest",
                request,
            )?
        && matches(
            receipt,
            request,
            &[
                "protocol",
                "scopeId",
                "databaseScopeHash",
                "writerManifestHash",
                "transitionId",
                "transitionInventoryHash",
                "schemaBundleHash",
                "finalizationReceiptHash",
                "postInventoryHash",
                "postPristineRuntimeStateHash",
            ],
        )
        && (!rebind(request)
            || (matches(
                receipt,
                request,
                &["transitionMode", "sourceWriterManifestHash"],
            ) && receipt["authorityConfigurationActivated"] == true))
        && receipt["transitionState"] == "finalized"
        && integer(&receipt["globalSequence"], 0)
        && sha(&receipt["globalHash"])
        && observed <= now.saturating_add(5000)
        && now.saturating_sub(observed) <= int(authority_trust, "maximumObservationAgeMs")?
        && expires > now
        && expires > observed
        && expires.saturating_sub(observed) <= int(authority_trust, "maximumReservationLeaseMs")?
        && signed(receipt, authority_trust, verify))
}

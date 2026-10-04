//! Historical v0.21 Node wire profile. Its eight-field source instances and
//! six-field installation records predate pristine rebind. Validate original
//! signed bytes; never upgrade these records into the current mutation protocol.
use super::*;
use crate::sqlite_mutation_coordinator::{
    contracts::schema_transition::SCHEMA_TRANSITION_PROTOCOL_V1, keys, safe, sha, timestamp,
};
const INSTANCE: &[&str] = &[
    "databaseRole",
    "databaseInstanceId",
    "sourceRelativePath",
    "schemaContractId",
    "preSchemaHash",
    "expectedPostSchemaHash",
    "sourceSha256",
    "sourceFileIdentityHash",
];
const GENESIS: &[&str] = &[
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
const INSTALLATION: &[&str] = &[
    "databaseRole",
    "databaseInstanceId",
    "schemaContractId",
    "preSchemaHash",
    "postSchemaHash",
    "installationHash",
];
const RESERVE_REQUEST: &[&str] = &[
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
const RESERVATION: &[&str] = &[
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
const FINALIZE_REQUEST: &[&str] = &[
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
    "installations",
    "completedAt",
];
const FINALIZATION: &[&str] = &[
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
    "installations",
    "globalSequence",
    "globalHash",
    "finalizedAt",
    "allRegisteredMutationsFencedThroughFinalize",
    "signature",
];
const OBSERVE_REQUEST: &[&str] = &[
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
    "nonce",
    "requestedAt",
];
const OBSERVATION: &[&str] = &[
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
    "transitionState",
    "globalSequence",
    "globalHash",
    "observedAt",
    "expiresAt",
    "signature",
];
const AUDIT: &[&str] = &[
    "version",
    "kind",
    "status",
    "protocol",
    "transitionId",
    "planHash",
    "databaseScopeHash",
    "writerManifestHash",
    "transitionInventoryHash",
    "schemaBundleHash",
    "postInventoryHash",
    "reserveRequest",
    "reservation",
    "finalizeRequest",
    "finalization",
    "observeRequest",
    "observation",
    "installations",
    "completedAt",
    "externalAuthorityVerified",
    "crossDatabaseAtomicityClaimed",
    "recoveryProtocol",
    "schemaTransitionReceiptHash",
];
const SUBJECT: &[&str] = &[
    "protocol",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "transitionId",
    "transitionInventoryHash",
    "schemaBundleHash",
];
fn require(value: bool) -> Result<(), String> {
    if value { Ok(()) } else { Err(invalid()) }
}
fn record_hash(value: &Value) -> Result<String, String> {
    hash(text(value, "kind").map_err(|e| e.code)?, value).map_err(|e| e.code)
}
fn project(value: &Value, fields: &[&str]) -> Value {
    Value::Object(
        fields
            .iter()
            .filter_map(|key| value.get(key).map(|v| ((*key).to_owned(), v.clone())))
            .collect(),
    )
}
fn time(value: &Value, field: &str) -> Result<i64, String> {
    timestamp(&value[field]).ok_or_else(invalid)
}
fn integer(value: &Value, minimum: i64) -> bool {
    value
        .as_i64()
        .is_some_and(|v| (minimum..=9_007_199_254_740_991).contains(&v))
}
pub(super) fn is_legacy(value: &Value) -> bool {
    value["version"] == 1
        && value.get("postPristineRuntimeStateHash").is_none()
        && is_legacy_schema_reserve_v021(&value["reserveRequest"])
}
/// Select only the historical parser. This predicate verifies no signature and
/// never accepts a request, source journal or activation capability.
pub(crate) fn is_legacy_schema_reserve_v021(reserve: &Value) -> bool {
    reserve["version"] == 1
        && reserve["kind"] == "AutonomousResearchOnlineSchemaTransitionReserveRequest"
        && reserve["instances"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty() && rows.iter().all(|row| keys(row, INSTANCE)))
}
fn verify_signature<T: MutationAuthorityTransportV1>(
    receipt: &Value,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<(), String> {
    require(
        same_fields(receipt, authority.trust(), &["authorityId", "keyId"])
            && authority
                .verify_historical_public_signature_v1(receipt)
                .map_err(|e| e.code)?,
    )
}
pub(super) fn verify<T: MutationAuthorityTransportV1>(
    active: &Value,
    audit: &Value,
    bytes: &[u8],
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<(), String> {
    require(
        is_legacy(audit)
            && keys(audit, AUDIT)
            && audit["kind"] == "AutonomousResearchOnlineSchemaTransitionAuditReceipt"
            && audit["status"] == "autonomous_research_online_schema_transition_ready"
            && audit["protocol"] == SCHEMA_TRANSITION_PROTOCOL_V1
            && audit["externalAuthorityVerified"] == true
            && audit["crossDatabaseAtomicityClaimed"] == false
            && audit["recoveryProtocol"] == "external-authority-state-machine-idempotent-phases-v1",
    )?;
    require(
        keys(
            active,
            &[
                "version",
                "kind",
                "phase",
                "plan",
                "reserveRequest",
                "reservation",
                "installations",
                "finalReceiptHash",
            ],
        ) && active["version"] == 1
            && active["kind"] == "AutonomousResearchOnlineSchemaTransitionState"
            && active["phase"] == "finalized"
            && active["finalReceiptHash"] == audit["schemaTransitionReceiptHash"]
            && active["reserveRequest"] == audit["reserveRequest"]
            && active["reservation"] == audit["reservation"]
            && active["installations"] == audit["installations"],
    )?;
    let reserve = &audit["reserveRequest"];
    let reservation = &audit["reservation"];
    let finalize = &audit["finalizeRequest"];
    let finalization = &audit["finalization"];
    let observe = &audit["observeRequest"];
    let observation = &audit["observation"];
    let finalized = verify_records(
        reserve,
        reservation,
        finalize,
        finalization,
        authority.trust(),
        &mut |receipt| verify_signature(receipt, authority),
    )?;
    let plan = &active["plan"];
    let mut expected_plan = reserve.clone();
    let object = expected_plan.as_object_mut().ok_or_else(invalid)?;
    object.remove("requestedAt");
    object.insert(
        "kind".into(),
        json!("AutonomousResearchOnlineSchemaTransitionPlan"),
    );
    object.insert("plannedAt".into(), plan["plannedAt"].clone());
    object.remove("transitionId");
    let plan_hash = hash(
        "AutonomousResearchOnlineSchemaTransitionPlan",
        &expected_plan,
    )
    .map_err(|e| e.code)?;
    expected_plan["transitionId"] = reserve["transitionId"].clone();
    expected_plan["planHash"] = json!(plan_hash);
    require(
        *plan == expected_plan
            && audit["planHash"] == plan["planHash"]
            && same_fields(
                audit,
                reserve,
                &[
                    "version",
                    "protocol",
                    "transitionId",
                    "databaseScopeHash",
                    "writerManifestHash",
                    "transitionInventoryHash",
                    "schemaBundleHash",
                ],
            ),
    )?;
    require(time(plan, "plannedAt")? <= time(reserve, "requestedAt")?)?;
    require(
        audit["completedAt"] == finalization["finalizedAt"]
            && same_fields(audit, finalize, &["postInventoryHash", "installations"]),
    )?;
    require(
        keys(observe, OBSERVE_REQUEST)
            && observe["version"] == 1
            && observe["kind"] == "AutonomousResearchOnlineSchemaTransitionObserveRequest"
            && same_fields(observe, finalize, SUBJECT)
            && observe["postInventoryHash"] == finalize["postInventoryHash"]
            && observe["finalizationReceiptHash"] == record_hash(finalization)?
            && safe(&observe["nonce"]),
    )?;
    let observe_requested = time(observe, "requestedAt")?;
    require(observe_requested >= finalized)?;
    require(
        keys(observation, OBSERVATION)
            && observation["version"] == 1
            && observation["kind"] == "AutonomousResearchOnlineSchemaTransitionObservationReceipt"
            && observation["status"]
                == "autonomous_research_online_schema_transition_observed_finalized"
            && observation["requestHash"] == record_hash(observe)?
            && same_fields(observation, observe, SUBJECT)
            && same_fields(
                observation,
                observe,
                &["finalizationReceiptHash", "postInventoryHash"],
            )
            && observation["transitionState"] == "finalized"
            && same_fields(observation, finalization, &["globalSequence", "globalHash"]),
    )?;
    verify_signature(observation, authority)?;
    let observed = time(observation, "observedAt")?;
    let observation_expires = time(observation, "expiresAt")?;
    require(
        observed >= finalized
            && observed >= observe_requested.checked_sub(5000).ok_or_else(invalid)?
            && observation_expires > observed
            && observation_expires.checked_sub(observed).is_some_and(|v| {
                Some(v) <= authority.trust()["maximumReservationLeaseMs"].as_i64()
            }),
    )?;
    let mut body = audit.clone();
    body.as_object_mut()
        .ok_or_else(invalid)?
        .remove("schemaTransitionReceiptHash");
    require(
        audit["schemaTransitionReceiptHash"]
            == hash(
                "AutonomousResearchOnlineSchemaTransitionAuditReceipt",
                &body,
            )
            .map_err(|e| e.code)?,
    )?;
    // Keep Node's order-sensitive cross-record checks as well as value equality.
    let ordered: crate::online_runtime_activation::ordered_json::Json =
        serde_json::from_slice(bytes).map_err(|_| invalid())?;
    for (request, receipt, field) in [
        ("reserveRequest", "reservation", "instances"),
        ("finalizeRequest", "finalization", "installations"),
    ] {
        let get = |first: &str| {
            ordered
                .get(first)
                .and_then(|v| v.get(field))
                .ok_or_else(invalid)?
                .stringify()
                .map_err(|e| e.code)
        };
        require(get(request)? == get(receipt)?)?;
    }
    Ok(())
}

fn verify_records(
    reserve: &Value,
    reservation: &Value,
    finalize: &Value,
    finalization: &Value,
    trust: &Value,
    signature: &mut dyn FnMut(&Value) -> Result<(), String>,
) -> Result<i64, String> {
    require(
        keys(reserve, RESERVE_REQUEST)
            && reserve["version"] == 1
            && reserve["kind"] == "AutonomousResearchOnlineSchemaTransitionReserveRequest"
            && reserve["protocol"] == SCHEMA_TRANSITION_PROTOCOL_V1
            && same_fields(reserve, trust, &["scopeId", "databaseScopeHash"])
            && integer(&reserve["requestedLeaseMs"], 1000)
            && reserve["requestedLeaseMs"].as_i64() <= trust["maximumReservationLeaseMs"].as_i64()
            && integer(&reserve["requiredExecutionWindowMs"], 1000)
            && reserve["requiredExecutionWindowMs"].as_i64()
                <= reserve["requestedLeaseMs"].as_i64(),
    )?;
    for field in [
        "databaseScopeHash",
        "writerManifestHash",
        "stateDatabaseManifestHash",
        "transitionInventoryHash",
        "schemaBundleHash",
        "authorityJournalSchemaHash",
        "markerSchemaHash",
        "transitionId",
    ] {
        require(sha(&reserve[field]))?;
    }
    require(safe(&reserve["scopeId"]) && safe(&reserve["authorityJournalSchemaContractId"]))?;
    let instances = reserve["instances"]
        .as_array()
        .filter(|v| v.len() == crate::sqlite_mutation_coordinator::DATABASE_ROLES.len())
        .ok_or_else(invalid)?;
    let mut roles = BTreeSet::new();
    let mut ids = BTreeSet::new();
    let mut scope = Vec::new();
    for instance in instances {
        let role = text(instance, "databaseRole").map_err(|e| e.code)?;
        let id = text(instance, "databaseInstanceId").map_err(|e| e.code)?;
        let relative = text(instance, "sourceRelativePath").map_err(|e| e.code)?;
        require(
            keys(instance, INSTANCE)
                && crate::sqlite_mutation_coordinator::DATABASE_ROLES.contains(&role)
                && roles.insert(role)
                && ids.insert(id)
                && safe(&instance["databaseInstanceId"])
                && safe(&instance["schemaContractId"])
                && !relative.is_empty()
                && !relative.contains('\\')
                && !relative.starts_with('/')
                && !relative
                    .split('/')
                    .any(|v| v.is_empty() || v == "." || v == ".."),
        )?;
        for field in [
            "preSchemaHash",
            "expectedPostSchemaHash",
            "sourceSha256",
            "sourceFileIdentityHash",
        ] {
            require(sha(&instance[field]))?;
        }
        scope.push(json!({"instanceId":id,"role":role,"sourceRelativePath":relative}));
    }
    require(
        instances.windows(2).all(|pair| {
            pair[0]["databaseInstanceId"].as_str() < pair[1]["databaseInstanceId"].as_str()
        }) && reserve["databaseScopeHash"]
            == crate::online_runtime_activation::inventory::state_database_scope_hash_v1(&json!(
                scope
            ))
            .map_err(|e| e.code)?
            && reserve["transitionInventoryHash"]
                == hash(
                    "AutonomousResearchOnlineSchemaTransitionInventory",
                    &project(
                        reserve,
                        &[
                            "stateDatabaseManifestHash",
                            "databaseScopeHash",
                            "instances",
                        ],
                    ),
                )
                .map_err(|e| e.code)?,
    )?;
    let mut identity = project(
        reserve,
        &[
            "scopeId",
            "databaseScopeHash",
            "writerManifestHash",
            "stateDatabaseManifestHash",
            "schemaBundleHash",
        ],
    );
    identity["instances"] = json!(
        instances
            .iter()
            .map(|row| project(
                row,
                &[
                    "databaseRole",
                    "databaseInstanceId",
                    "sourceRelativePath",
                    "schemaContractId",
                    "expectedPostSchemaHash"
                ]
            ))
            .collect::<Vec<_>>()
    );
    require(
        reserve["transitionId"]
            == hash(
                "AutonomousResearchOnlineSchemaTransitionIdentity",
                &identity,
            )
            .map_err(|e| e.code)?,
    )?;
    let requested = time(reserve, "requestedAt")?;
    require(
        keys(reservation, RESERVATION)
            && reservation["version"] == 1
            && reservation["kind"] == "AutonomousResearchOnlineSchemaTransitionReservationReceipt"
            && reservation["status"] == "autonomous_research_online_schema_transition_reserved"
            && reservation["requestHash"] == record_hash(reserve)?
            && safe(&reservation["reservationId"])
            && same_fields(
                reservation,
                reserve,
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
            && reservation["allRegisteredMutationsFenced"] == true
            && reservation["quiescenceMode"]
                == "scope-wide-no-new-reservations-until-finalize-or-expiry",
    )?;
    signature(reservation)?;
    let issued = time(reservation, "issuedAt")?;
    let expires = time(reservation, "expiresAt")?;
    require(
        issued >= requested.checked_sub(5000).ok_or_else(invalid)?
            && expires > issued
            && expires
                .checked_sub(issued)
                .is_some_and(|v| Some(v) <= reserve["requestedLeaseMs"].as_i64()),
    )?;
    let genesis = reservation["databaseGenesis"]
        .as_array()
        .filter(|v| v.len() == instances.len())
        .ok_or_else(invalid)?;
    for (row, instance) in genesis.iter().zip(instances) {
        require(
            keys(row, GENESIS)
                && same_fields(
                    row,
                    instance,
                    &["databaseRole", "databaseInstanceId", "schemaContractId"],
                )
                && row["schemaHash"] == instance["expectedPostSchemaHash"]
                && row["globalSequence"] == 0
                && row["databaseSequence"] == 0
                && ["schemaHash", "globalHash", "databaseHash", "stateHash"]
                    .iter()
                    .all(|key| sha(&row[key])),
        )?;
    }
    require(
        keys(finalize, FINALIZE_REQUEST)
            && finalize["version"] == 1
            && finalize["kind"] == "AutonomousResearchOnlineSchemaTransitionFinalizeRequest"
            && same_fields(finalize, reservation, SUBJECT)
            && finalize["reservationId"] == reservation["reservationId"]
            && finalize["reservationReceiptHash"] == record_hash(reservation)?
            && sha(&finalize["postInventoryHash"]),
    )?;
    let installations = finalize["installations"]
        .as_array()
        .filter(|v| v.len() == instances.len())
        .ok_or_else(invalid)?;
    for (row, instance) in installations.iter().zip(instances) {
        let mut body = project(
            row,
            &[
                "databaseRole",
                "databaseInstanceId",
                "schemaContractId",
                "preSchemaHash",
                "postSchemaHash",
            ],
        );
        body["transitionId"] = reserve["transitionId"].clone();
        body["reservationReceiptHash"] = finalize["reservationReceiptHash"].clone();
        require(
            keys(row, INSTALLATION)
                && same_fields(
                    row,
                    instance,
                    &[
                        "databaseRole",
                        "databaseInstanceId",
                        "schemaContractId",
                        "preSchemaHash",
                    ],
                )
                && row["postSchemaHash"] == instance["expectedPostSchemaHash"]
                && row["installationHash"]
                    == hash(
                        "AutonomousResearchOnlineSchemaTransitionDatabaseInstallation",
                        &body,
                    )
                    .map_err(|e| e.code)?,
        )?;
    }
    require(
        keys(finalization, FINALIZATION)
            && finalization["version"] == 1
            && finalization["kind"]
                == "AutonomousResearchOnlineSchemaTransitionFinalizationReceipt"
            && finalization["status"] == "autonomous_research_online_schema_transition_finalized"
            && finalization["requestHash"] == record_hash(finalize)?
            && same_fields(finalization, finalize, SUBJECT)
            && same_fields(
                finalization,
                finalize,
                &[
                    "reservationId",
                    "reservationReceiptHash",
                    "postInventoryHash",
                    "installations",
                ],
            )
            && integer(&finalization["globalSequence"], 0)
            && sha(&finalization["globalHash"])
            && finalization["allRegisteredMutationsFencedThroughFinalize"] == true,
    )?;
    signature(finalization)?;
    let completed = time(finalize, "completedAt")?;
    let finalized = time(finalization, "finalizedAt")?;
    require(
        completed >= issued
            && completed <= expires
            && finalized >= completed
            && finalized <= expires,
    )?;
    Ok(finalized)
}

/// Historical-only initial Node v0.21 schema chain. It returns signed genesis
/// observations, never a migration, writer or activation capability. Current
/// requests must continue through the current protocol validator.
pub(crate) fn verify_legacy_schema_records_v021(
    trust: &Value,
    public_key: &ed25519_dalek::VerifyingKey,
    reserve: &Value,
    reservation: &Value,
    finalize: &Value,
    finalization: &Value,
) -> crate::sqlite_mutation_coordinator::Result<Value> {
    crate::sqlite_mutation_coordinator::contracts::assert_authority_trust_v1(trust)?;
    verify_records(reserve,reservation,finalize,finalization,trust,&mut |receipt| {
        require(same_fields(receipt,trust,&["authorityId","keyId"]) && crate::sqlite_mutation_coordinator::authority::verify_public_payload_signature_v1(receipt,public_key))
    }).map_err(crate::sqlite_mutation_coordinator::error)?;
    Ok(reservation["databaseGenesis"].clone())
}

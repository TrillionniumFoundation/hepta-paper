//! Diagnostic state-safety projection. JSON assertions remain descriptive:
//! this module does not verify signatures or construct runtime capabilities.
use crate::{
    online_authority_inspection::{blocker_code_compatibility_v1, expand_blocker_compatibility_v1},
    sqlite_mutation_coordinator::{DATABASE_ROLES, Result, error, hash, keys, sha, timestamp},
};
use serde_json::{Value, json};
const PROTOCOL: &str = "external-linearizable-reserve-apply-finalize-v1";
const MANIFEST: &str = "hepta-paper-autonomous-research-state-databases-v1";
const WRITER_KIND: &str = "AutonomousResearchOnlineWriterCoverageManifest";
const DEPLOYMENT: &str =
    "autonomous_research_online_anti_rollback_coordinator_deployment_not_ready";
const MAXIMUM_AGE: i64 = 86_400_000;
fn canonical(value: Value) -> Result<Value> {
    serde_json::from_slice(
        &hepta_legacy_compatibility::production_stable_json_v1(&value)
            .map_err(|e| error(e.to_string()))?,
    )
    .map_err(|e| error(e.to_string()))
}
fn truth(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|v| v != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn otherwise(v: &Value, other: Value) -> Value {
    if truth(v) { v.clone() } else { other }
}
fn or_null(v: &Value) -> Value {
    otherwise(v, Value::Null)
}
fn strings(v: &Value) -> Option<Vec<String>> {
    v.as_array()?
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect()
}
fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    v
}
fn unique(v: Vec<String>) -> Vec<String> {
    let mut v = sorted(v);
    v.dedup();
    v
}
fn roles(v: Vec<String>) -> Vec<String> {
    unique(
        v.into_iter()
            .filter(|v| DATABASE_ROLES.contains(&v.as_str()))
            .collect(),
    )
}
fn required() -> Vec<String> {
    sorted(DATABASE_ROLES.iter().map(|s| s.to_string()).collect())
}
fn integer(v: &Value) -> bool {
    v.as_f64().is_some_and(|v| {
        v.is_finite() && v.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&v)
    })
}
fn one(v: &Value) -> bool {
    v.as_f64() == Some(1.0)
}
fn nonempty(v: &Value) -> bool {
    v.as_str().is_some_and(|v| !v.is_empty())
}
fn empty(v: &Value) -> bool {
    v.as_array().is_some_and(Vec::is_empty)
}
fn blockers(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn same(a: &Value, b: &Value) -> bool {
    a == b || (a.is_number() && b.is_number() && a.as_f64() == b.as_f64())
}
pub fn writer_coverage_manifest_hash_v1(manifest: &Value) -> Result<String> {
    let fail = || error("autonomous_research_online_writer_coverage_manifest_invalid");
    if !one(&manifest["version"])
        || manifest["kind"] != WRITER_KIND
        || strings(&manifest["requiredDatabaseRoles"]).map(sorted) != Some(required())
        || !manifest["writers"].is_array()
    {
        return Err(fail());
    }
    let mut ids = Vec::new();
    for w in manifest["writers"].as_array().into_iter().flatten() {
        let rs = strings(&w["databaseRoles"]).unwrap_or_default();
        if !nonempty(&w["writerId"])
            || !sha(&w["implementationHash"])
            || w["protocol"] != PROTOCOL
            || rs.is_empty()
            || unique(rs.clone()).len() != rs.len()
            || rs.iter().any(|r| !DATABASE_ROLES.contains(&r.as_str()))
        {
            return Err(error(
                "autonomous_research_online_writer_coverage_writer_invalid",
            ));
        }
        ids.push(w["writerId"].as_str().unwrap_or_default().to_string());
    }
    if unique(ids.clone()).len() != ids.len() {
        return Err(error(
            "autonomous_research_online_writer_coverage_writer_duplicate",
        ));
    }
    hash(WRITER_KIND, manifest)
}
fn current(v: &Value, field: &str, now: i64) -> bool {
    nonempty(&v["authorityId"])
        && nonempty(&v["keyId"])
        && integer(&v["sequence"])
        && sha(&v["hash"])
        && sha(&v["receiptHash"])
        && v["signatureVerified"] == true
        && v["verificationSource"] == "pinned-external-authority-public-key-v1"
        && timestamp(&v[field]).is_some_and(|t| t <= now)
        && timestamp(&v["expiresAt"]).is_some_and(|t| t > now)
}
pub fn inspect_online_writer_coverage_v1(
    candidate: &Value,
    head: &Value,
    now: i64,
) -> Result<Value> {
    crate::sqlite_mutation_coordinator::clock::iso(now)
        .map_err(|_| error("autonomous_research_state_safety_now_required"))?;
    let hash_result = writer_coverage_manifest_hash_v1(&candidate["manifest"]);
    let manifest_valid = hash_result
        .as_ref()
        .is_ok_and(|h| candidate["manifestHash"] == *h);
    let manifest_hash = hash_result.ok();
    let covered = if manifest_hash.is_some() {
        unique(
            candidate["manifest"]["writers"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|w| strings(&w["databaseRoles"]).unwrap_or_default())
                .collect(),
        )
    } else {
        Vec::new()
    };
    let s = &candidate["staticInspection"];
    let broker = &candidate["brokerScopeReceipt"];
    let static_ok = manifest_valid
        && one(&s["version"])
        && s["kind"] == "AutonomousResearchOnlineWriterStaticCoverageInspection"
        && s["status"] == "autonomous_research_online_writer_static_coverage_complete"
        && s["inspectionSource"] == "repository-ast-import-gate-v1"
        && s["manifestHash"] == json!(manifest_hash)
        && strings(&s["coveredDatabaseRoles"]).map(sorted) == Some(covered.clone())
        && sha(&s["astGateReceiptHash"])
        && sha(&s["codeProvenanceHash"]);
    let broker_ok = manifest_valid
        && one(&broker["version"])
        && broker["kind"] == "AutonomousResearchOnlineWriterBrokerScopeReceipt"
        && broker["status"] == "autonomous_research_online_writer_broker_scope_complete"
        && broker["manifestHash"] == json!(manifest_hash)
        && strings(&broker["coveredDatabaseRoles"]).map(sorted) == Some(covered.clone())
        && same(&broker["sequence"], &head["sequence"])
        && broker["hash"] == head["hash"]
        && current(broker, "observedAt", now);
    let complete = one(&candidate["version"])
        && candidate["kind"] == "AutonomousResearchOnlineWriterCoverageInspection"
        && candidate["status"] == "autonomous_research_online_writer_coverage_complete"
        && manifest_valid
        && covered.len() == DATABASE_ROLES.len()
        && static_ok
        && broker_ok;
    canonical(
        json!({"manifestValid":manifest_valid,"manifestHash":if manifest_valid{json!(manifest_hash)}else{Value::Null},"requiredDatabaseRoleCount":DATABASE_ROLES.len(),"coveredDatabaseRoleCount":covered.len(),"coveredDatabaseRoles":covered,"coveragePercent":covered.len()*100/DATABASE_ROLES.len(),"staticCoverageVerified":static_ok,"brokerScopeVerified":broker_ok,"coverageComplete":complete}),
    )
}
pub fn unavailable_online_anti_rollback_inspection_v1(manifest: Option<&Value>) -> Result<Value> {
    let fallback =
        json!({"version":1,"kind":WRITER_KIND,"requiredDatabaseRoles":required(),"writers":[]});
    let manifest = manifest.filter(|v| truth(v)).unwrap_or(&fallback);
    let manifest_hash = writer_coverage_manifest_hash_v1(manifest)?;
    canonical(
        json!({"version":1,"kind":"AutonomousResearchOnlineAntiRollbackInspectionUnavailable","status":"autonomous_research_online_anti_rollback_blocked","inspectionSource":null,"inspectionMode":"passive-signed-receipt-validation","protocol":PROTOCOL,"externalActionPerformed":false,"currentHeadReceipt":null,"activeChallengeReceipt":null,"writerCoverage":{"version":1,"kind":"AutonomousResearchOnlineWriterCoverageInspection","status":"autonomous_research_online_writer_coverage_blocked","manifest":manifest,"manifestHash":manifest_hash,"staticInspection":null,"brokerScopeReceipt":null,"blockers":["autonomous_research_online_writer_manifest_100_percent_required"]},"blockerCodeCompatibility":blocker_code_compatibility_v1(),"blockers":expand_blocker_compatibility_v1(&json!([DEPLOYMENT,"autonomous_research_online_authority_head_current_required","autonomous_research_online_authority_recent_active_challenge_required","autonomous_research_online_writer_manifest_100_percent_required"]))?}),
    )
}
struct Inventory {
    ready: bool,
    roles: Vec<String>,
    ids: Vec<String>,
    bindings: Value,
    scope: bool,
    hash: bool,
}
fn inspect_inventory(v: &Value) -> Result<Inventory> {
    use crate::online_runtime_activation::inventory::{
        state_database_inventory_hash_v1, state_database_scope_hash_v1,
    };
    let rows = v["instances"].as_array().cloned().unwrap_or_default();
    let rs = roles(
        rows.iter()
            .filter_map(|r| r["role"].as_str().map(str::to_owned))
            .collect(),
    );
    let ids = sorted(
        rows.iter()
            .filter_map(|r| {
                r["instanceId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            })
            .collect(),
    );
    let mut bindings=rows.iter().map(|r|json!({"databaseRole":or_null(&r["role"]),"databaseInstanceId":or_null(&r["instanceId"]),"schemaHash":or_null(&r["schemaHash"])})).collect::<Vec<_>>();
    let collation = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    bindings.sort_by(|a, b| {
        collation.compare(
            a["databaseInstanceId"].as_str().unwrap_or("null"),
            b["databaseInstanceId"].as_str().unwrap_or("null"),
        )
    });
    let scope =
        state_database_scope_hash_v1(&v["instances"]).is_ok_and(|h| v["databaseScopeHash"] == h);
    // JSON Number is a JavaScript number even when written as 1.0.
    let mut hash_input = v.clone();
    if one(&hash_input["version"]) {
        hash_input["version"] = json!(1);
    }
    let hashed =
        state_database_inventory_hash_v1(&hash_input).is_ok_and(|h| v["inventoryHash"] == h);
    let ready = keys(
        v,
        &[
            "version",
            "kind",
            "status",
            "manifestId",
            "manifestHash",
            "databaseScopeHash",
            "instances",
            "blockers",
            "inventoryHash",
        ],
    ) && one(&v["version"])
        && v["kind"] == "AutonomousResearchStateDatabaseInventory"
        && v["status"] == "autonomous_research_state_database_inventory_ready"
        && v["manifestId"] == MANIFEST
        && ["manifestHash", "databaseScopeHash", "inventoryHash"]
            .iter()
            .all(|k| sha(&v[k]))
        && empty(&v["blockers"])
        && rs.len() == DATABASE_ROLES.len()
        && ids.len() == rows.len()
        && unique(ids.clone()).len() == ids.len()
        && scope
        && hashed;
    Ok(Inventory {
        ready,
        roles: rs,
        ids,
        bindings: json!(bindings),
        scope,
        hash: hashed,
    })
}
struct Restore {
    ready: bool,
    metadata: bool,
    fresh: bool,
    binding: bool,
    roles: Vec<String>,
    ids: Vec<String>,
    performed: Option<i64>,
}
fn inspect_restore(v: &Value, inventory: &Value, i: &Inventory, now: i64) -> Restore {
    let ids = sorted(
        v["sources"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| {
                r["role"]
                    .as_str()?
                    .strip_prefix("autonomous_state_database:")
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            })
            .collect(),
    );
    let rs = roles(
        ids.iter()
            .map(|s| s.split(':').next().unwrap_or_default().to_string())
            .collect(),
    );
    let performed = timestamp(&v["restoreDrillPerformedAt"]);
    let fresh = performed.is_some_and(|t| t <= now && now.saturating_sub(t) <= MAXIMUM_AGE);
    let base = [
        "version",
        "kind",
        "status",
        "bundlePath",
        "manifestId",
        "manifestHash",
        "bundleManifestHash",
        "snapshotContentHash",
        "inventoryHash",
        "databaseScopeHash",
        "databaseInstanceIds",
        "restoreDrillReceiptHash",
        "restoreDrillPerformedAt",
        "authorityId",
        "keyId",
        "headSequence",
        "headHash",
        "sources",
        "skippedCandidates",
        "blockers",
    ];
    let legacy = keys(v, &base);
    let mut snapshot = base.to_vec();
    snapshot.push("snapshotCreatedAt");
    let snapshot_exact = keys(v, &snapshot);
    let mut journal = snapshot;
    journal.extend([
        "recoverabilityProtocol",
        "recoverabilityBindingHash",
        "completeFinalizedMutationJournal",
        "journalReplayMutationCount",
        "journalRangeReceiptHash",
        "recoveredDatabaseHeads",
    ]);
    let journal_exact = keys(v, &journal);
    let recovered=v["recoveredDatabaseHeads"].as_array().map(|a|json!(a.iter().map(|h|json!({"databaseRole":or_null(&h["databaseRole"]),"databaseInstanceId":or_null(&h["databaseInstanceId"]),"schemaHash":or_null(&h["schemaHash"])})).collect::<Vec<_>>()));
    let journal_recovery = v["recoverabilityProtocol"]
        == "external-linearizable-finalized-mutation-journal-v1"
        && v["completeFinalizedMutationJournal"] == true
        && integer(&v["journalReplayMutationCount"])
        && v["journalReplayMutationCount"]
            .as_f64()
            .is_some_and(|n| n > 0.0)
        && sha(&v["journalRangeReceiptHash"])
        && sha(&v["recoverabilityBindingHash"])
        && recovered.as_ref() == Some(&i.bindings);
    let metadata = (legacy || snapshot_exact || journal_exact)
        && one(&v["version"])
        && v["kind"] == "AutonomousResearchStateBackupSourcesInspection"
        && v["status"] == "autonomous_research_state_backup_sources_ready"
        && v["manifestId"] == MANIFEST
        && [
            "manifestHash",
            "bundleManifestHash",
            "snapshotContentHash",
            "inventoryHash",
            "databaseScopeHash",
            "restoreDrillReceiptHash",
            "headHash",
        ]
        .iter()
        .all(|k| sha(&v[k]))
        && (legacy || timestamp(&v["snapshotCreatedAt"]).is_some())
        && (journal_recovery || legacy || snapshot_exact)
        && nonempty(&v["authorityId"])
        && nonempty(&v["keyId"])
        && integer(&v["headSequence"])
        && v["skippedCandidates"].is_array()
        && empty(&v["blockers"])
        && rs.len() == DATABASE_ROLES.len()
        && strings(&v["databaseInstanceIds"]).map(sorted) == Some(ids.clone());
    let binding = i.ready
        && metadata
        && ["manifestId", "manifestHash", "databaseScopeHash"]
            .iter()
            .all(|k| v[k] == inventory[k])
        && ids == i.ids
        && (v["inventoryHash"] == inventory["inventoryHash"] || journal_recovery);
    Restore {
        ready: metadata && fresh && binding,
        metadata,
        fresh,
        binding,
        roles: rs,
        ids,
        performed,
    }
}
/// Matches the incumbent diagnostic projection; it does not authenticate input
/// booleans, signatures, coordinator claims, or the existence of these files.
pub fn evaluate_state_safety_readiness_v1(
    inventory: &Value,
    restore: &Value,
    online: Option<&Value>,
    now: i64,
) -> Result<Value> {
    crate::sqlite_mutation_coordinator::clock::iso(now)
        .map_err(|_| error("autonomous_research_state_safety_now_required"))?;
    let i = inspect_inventory(inventory)?;
    let r = inspect_restore(restore, inventory, &i, now);
    let fallback = unavailable_online_anti_rollback_inspection_v1(None)?;
    let online = online.filter(|v| truth(v)).unwrap_or(&fallback);
    let head = &online["currentHeadReceipt"];
    let challenge = &online["activeChallengeReceipt"];
    let active = online["inspectionMode"] == "active-external-authority-challenge";
    let implemented = one(&online["version"])
        && online["kind"] == "AutonomousResearchOnlineAntiRollbackInspection"
        && online["inspectionSource"] == "pinned-external-authority-receipt-verifier-v1"
        && (active || online["inspectionMode"] == "passive-signed-receipt-validation")
        && online["externalActionPerformed"] == json!(active);
    let head_ok = head["status"] == "autonomous_research_online_authority_head_current"
        && current(head, "observedAt", now);
    let challenge_ok = challenge["status"]
        == "autonomous_research_online_authority_active_challenge_verified"
        && current(challenge, "challengedAt", now);
    let same_head = head_ok
        && challenge_ok
        && ["authorityId", "keyId", "sequence", "hash"]
            .iter()
            .all(|k| same(&head[k], &challenge[k]));
    let live = implemented
        && online["status"] == "autonomous_research_online_anti_rollback_ready"
        && online["protocol"] == PROTOCOL
        && same_head;
    let writer = inspect_online_writer_coverage_v1(&online["writerCoverage"], head, now)?;
    let complete = live && writer["coverageComplete"] == true;
    let mut b = Vec::new();
    for (valid, code) in [
        (
            i.ready,
            "autonomous_research_state_database_inventory_10_of_10_required",
        ),
        (
            i.scope,
            "autonomous_research_state_database_inventory_scope_hash_invalid",
        ),
        (
            i.hash,
            "autonomous_research_state_database_inventory_hash_invalid",
        ),
        (
            r.ready,
            "autonomous_research_state_latest_valid_restore_drill_required",
        ),
        (
            r.metadata,
            "autonomous_research_state_restore_canonical_metadata_required",
        ),
        (
            r.fresh,
            "autonomous_research_state_restore_drill_freshness_required",
        ),
        (
            r.binding,
            "autonomous_research_state_restore_current_inventory_binding_required",
        ),
        (implemented, DEPLOYMENT),
        (
            head_ok,
            "autonomous_research_online_authority_head_current_required",
        ),
        (
            challenge_ok,
            "autonomous_research_online_authority_recent_active_challenge_required",
        ),
        (
            same_head,
            "autonomous_research_online_authority_receipts_same_head_required",
        ),
        (
            writer["staticCoverageVerified"] == true,
            "autonomous_research_online_writer_static_coverage_required",
        ),
        (
            writer["brokerScopeVerified"] == true,
            "autonomous_research_online_writer_broker_scope_required",
        ),
        (
            complete,
            "autonomous_research_online_writer_manifest_100_percent_required",
        ),
    ] {
        if !valid {
            b.push(json!(code));
        }
    }
    b.extend(blockers(&inventory["blockers"]));
    b.extend(blockers(&restore["blockers"]));
    b.extend(blockers(&online["blockers"]));
    let b = expand_blocker_compatibility_v1(&json!(b))?;
    let ready = i.ready && r.ready && live && complete && empty(&b);
    let mut restore_projection = json!({"version":or_null(&restore["version"]),"kind":or_null(&restore["kind"]),"status":otherwise(&restore["status"],json!("autonomous_research_state_backup_sources_blocked")),"databaseInstanceIds":r.ids,"restoreDrillPerformedAt":r.performed.map(crate::sqlite_mutation_coordinator::clock::iso).transpose()?,"headSequence":restore["headSequence"],"coveredDatabaseRoles":r.roles,"skippedCandidateCount":restore["skippedCandidates"].as_array().map_or(0,Vec::len),"blockers":blockers(&restore["blockers"])});
    for k in [
        "manifestId",
        "manifestHash",
        "bundleManifestHash",
        "snapshotContentHash",
        "snapshotCreatedAt",
        "inventoryHash",
        "databaseScopeHash",
        "restoreDrillReceiptHash",
        "authorityId",
        "keyId",
        "headHash",
    ] {
        restore_projection[k] = or_null(&restore[k]);
    }
    canonical(
        json!({"version":1,"kind":"AutonomousResearchStateSafetyInspection","status":if ready{"autonomous_research_state_safety_ready"}else{"autonomous_research_state_safety_blocked"},"ready":ready,"requiredDatabaseRoleCount":DATABASE_ROLES.len(),"inventoryCoveredRoleCount":i.roles.len(),"inventoryCoveredRoles":i.roles,"inventoryRoleCoverageComplete":i.ready,"latestRestoreDrillCoveredRoleCount":r.roles.len(),"latestRestoreDrillCoveredRoles":r.roles,"latestValidRestoreDrillReady":r.ready,"onlineAntiRollbackCoordinatorImplemented":implemented,"liveExternalAuthorityVerified":live,"currentHeadReceiptVerified":head_ok,"recentActiveChallengeVerified":challenge_ok,"onlineAuthorityHeadCurrent":live,"writerManifestHash":writer["manifestHash"],"requiredWriterCount":writer["requiredDatabaseRoleCount"],"coveredWriterCount":writer["coveredDatabaseRoleCount"],"coveredWriterRoles":writer["coveredDatabaseRoles"],"writerManifestCoveragePercent":writer["coveragePercent"],"writerStaticCoverageVerified":writer["staticCoverageVerified"],"writerBrokerScopeVerified":writer["brokerScopeVerified"],"writerManifestComplete":complete,"statusReadOnly":online["externalActionPerformed"]!=true,"externalActionPerformed":online["externalActionPerformed"]==true,"inventory":{"version":or_null(&inventory["version"]),"kind":or_null(&inventory["kind"]),"status":otherwise(&inventory["status"],json!("autonomous_research_state_database_inventory_blocked")),"manifestId":or_null(&inventory["manifestId"]),"manifestHash":or_null(&inventory["manifestHash"]),"inventoryHash":or_null(&inventory["inventoryHash"]),"databaseScopeHash":or_null(&inventory["databaseScopeHash"]),"databaseInstanceIds":i.ids,"coveredDatabaseRoles":i.roles,"blockers":blockers(&inventory["blockers"])},"latestRestoreDrill":restore_projection,"onlineAntiRollback":online,"blockerCodeCompatibility":blocker_code_compatibility_v1(),"blockers":b}),
    )
}

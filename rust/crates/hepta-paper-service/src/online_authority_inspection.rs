//! Current signature evidence for status inspection. No report or retained
//! inspection constructs a mutation coordinator, epoch, or activation permit.
use crate::{
    online_authority_evidence_cache::read_passive_authority_evidence_cache_v1,
    online_runtime_activation::active_refresh::VerifiedActiveAuthorityEvidenceV1,
    online_writer_static::{RetainedWriterStaticInputsV1, VerifiedWriterStaticCoverageV1},
    sqlite_mutation_coordinator::{
        Result,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock::MutationClockV1,
        contracts::online_mutation_receipt_hash_v1,
        error,
        manifest::writer_manifest_hash_v1,
        text, timestamp,
    },
    state_database_inventory::{
        NativeStoreTransactionInventoryGuardV1, ObservedStateDatabaseInventoryV1,
    },
};
use serde_json::{Value, json};
const PASSIVE: &str = "passive-signed-receipt-validation";
const ACTIVE: &str = "active-external-authority-challenge";
const SOURCE: &str = "pinned-external-authority-public-key-v1";
const DEPLOYMENT: &str =
    "autonomous_research_online_anti_rollback_coordinator_deployment_not_ready";
const LEGACY: &str = "autonomous_research_online_anti_rollback_coordinator_not_implemented";

pub fn blocker_code_compatibility_v1() -> Value {
    json!({"version":1,"kind":"AutonomousResearchStateSafetyBlockerCodeCompatibility","aliases":[{"canonicalCode":DEPLOYMENT,"legacyAliasCode":LEGACY,"appliesToReportVersions":[1],"disposition":"deprecated_read_compatibility_alias"}]})
}
pub fn expand_blocker_compatibility_v1(value: &Value) -> Result<Value> {
    let values = value
        .as_array()
        .ok_or_else(|| error("autonomous_research_state_safety_blocker_codes_invalid"))?;
    let mut codes = Vec::new();
    for value in values {
        codes.push(
            value
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| error("autonomous_research_state_safety_blocker_codes_invalid"))?
                .to_owned(),
        );
    }
    if codes.iter().any(|s| s == DEPLOYMENT || s == LEGACY) {
        codes.push(DEPLOYMENT.into());
        codes.push(LEGACY.into());
    }
    codes.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    codes.dedup();
    Ok(json!(codes))
}
fn expected_instances(inventory: &Value) -> Result<Value> {
    let instances = inventory["instances"]
        .as_array()
        .ok_or_else(|| error("autonomous_research_online_mutation_closed_inventory_required"))?;
    let mut rows=instances.iter().map(|i|json!({"databaseRole":i["role"],"databaseInstanceId":i["instanceId"],"schemaHash":i["schemaHash"]})).collect::<Vec<_>>();
    let collation = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    rows.sort_by(|a, b| {
        collation.compare(
            a["databaseInstanceId"].as_str().unwrap_or_default(),
            b["databaseInstanceId"].as_str().unwrap_or_default(),
        )
    });
    Ok(json!(rows))
}
fn equal_head(a: &Value, b: &Value) -> bool {
    a["authorityId"] == b["authorityId"]
        && a["keyId"] == b["keyId"]
        && a["globalSequence"].as_f64() == b["globalSequence"].as_f64()
        && a["globalHash"] == b["globalHash"]
}
fn earliest_expiry(evidence: &Value) -> Result<i64> {
    ["currentHead", "activeChallenge", "brokerScope"]
        .iter()
        .map(|k| {
            timestamp(&evidence[k]["receipt"]["expiresAt"])
                .ok_or_else(|| error("autonomous_research_online_mutation_evidence_expiry_invalid"))
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .min()
        .ok_or_else(|| error("autonomous_research_online_mutation_evidence_expiry_invalid"))
}
fn normalize_head(v: &Value, challenge: bool) -> Result<Value> {
    let mut out = json!({"version":1,"kind":if challenge{"AutonomousResearchOnlineAuthorityActiveChallengeReceipt"}else{"AutonomousResearchOnlineAuthorityHeadReceipt"},"status":if challenge{"autonomous_research_online_authority_active_challenge_verified"}else{"autonomous_research_online_authority_head_current"},"authorityId":v["authorityId"],"keyId":v["keyId"],"sequence":v["globalSequence"],"hash":v["globalHash"],"expiresAt":v["expiresAt"],"receiptHash":online_mutation_receipt_hash_v1(v)?,"signatureVerified":true,"verificationSource":SOURCE});
    let field = if challenge {
        "challengedAt"
    } else {
        "observedAt"
    };
    out[field] = v[field].clone();
    Ok(out)
}
fn verify<T: MutationAuthorityTransportV1>(
    authority: &PinnedMutationAuthorityV1<T>,
    evidence: &Value,
    inventory: &ObservedStateDatabaseInventoryV1,
    source: &VerifiedWriterStaticCoverageV1,
    manifest: &Value,
    now: i64,
) -> Result<()> {
    inventory.assert_current()?;
    source.assert_current()?;
    verify_retained_receipts(authority, evidence, inventory, source, manifest, now)?;
    inventory.assert_current()?;
    source.assert_current()
}
/// Only immutable documents and held authority snapshots are read here. Both
/// callers separately require their concrete full or retained local proofs.
fn verify_retained_receipts<T: MutationAuthorityTransportV1>(
    authority: &PinnedMutationAuthorityV1<T>,
    evidence: &Value,
    inventory: &ObservedStateDatabaseInventoryV1,
    source: &VerifiedWriterStaticCoverageV1,
    manifest: &Value,
    now: i64,
) -> Result<()> {
    crate::online_runtime_activation::inventory::assert_closed_activation_inventory_v1(
        inventory.value(),
        manifest,
    )
    .map_err(|e| error(e.code))?;
    let manifest_hash = writer_manifest_hash_v1(manifest)?;
    if authority.trust()["writerManifestHash"] != manifest_hash
        || authority.trust()["databaseScopeHash"] != inventory.value()["databaseScopeHash"]
        || source.value()["manifestHash"] != manifest_hash
    {
        return Err(error(
            "autonomous_research_online_mutation_authority_scope_mismatch",
        ));
    }
    let expected = expected_instances(inventory.value())?;
    let current = &evidence["currentHead"];
    let challenge = &evidence["activeChallenge"];
    let scope = &evidence["brokerScope"];
    authority.verify_current_head_receipt(
        &current["receipt"],
        &current["request"],
        Some(&expected),
        now,
    )?;
    authority.verify_active_challenge_receipt(
        &challenge["receipt"],
        &challenge["request"],
        Some(&expected),
        now,
    )?;
    authority.verify_scope_receipt(&scope["receipt"], &scope["request"], now)?;
    let c = &current["receipt"];
    let a = &challenge["receipt"];
    let s = &scope["receipt"];
    let local = source.value();
    let mut operation_ids = manifest["operations"]
        .as_array()
        .ok_or_else(|| {
            error("autonomous_research_online_mutation_passive_evidence_binding_invalid")
        })?
        .iter()
        .map(|v| text(v, "operationId").map(str::to_owned))
        .collect::<Result<Vec<_>>>()?;
    operation_ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    if !equal_head(c, a)
        || !equal_head(c, s)
        || hepta_legacy_compatibility::production_stable_json_v1(&c["databaseHeads"])
            .map_err(|e| error(e.to_string()))?
            != hepta_legacy_compatibility::production_stable_json_v1(&a["databaseHeads"])
                .map_err(|e| error(e.to_string()))?
        || s["staticInspectionReceiptHash"] != local["astGateReceiptHash"]
        || s["astGateReceiptHash"] != local["astGateReceiptHash"]
        || s["codeProvenanceHash"] != local["codeProvenanceHash"]
        || s["operationCount"].as_f64() != Some(operation_ids.len() as f64)
        || s["operationIds"] != json!(operation_ids)
        || s["requiredDatabaseRoles"] != manifest["requiredDatabaseRoles"]
        || s["coveredDatabaseRoles"] != manifest["coverage"]["coveredDatabaseRoles"]
    {
        return Err(error(
            "autonomous_research_online_mutation_passive_evidence_binding_invalid",
        ));
    }
    Ok(())
}

/// This type retains signature/currentness evidence only. Its report may include
/// a caller's coordinator status for diagnostic parity. That status is not an
/// authenticated capability, and this type cannot authorize any mutation.
pub struct VerifiedOnlineAuthorityInspectionV1 {
    value: Value,
    evidence: Value,
    manifest: Value,
    authority_hash: String,
    inventory_hash: String,
    source_hash: String,
    observed_at: i64,
    cache_hash: Option<String>,
}
impl VerifiedOnlineAuthorityInspectionV1 {
    pub fn value(&self) -> &Value {
        &self.value
    }
    pub fn assert_current<T: MutationAuthorityTransportV1>(
        &self,
        authority: &PinnedMutationAuthorityV1<T>,
        inventory: &ObservedStateDatabaseInventoryV1,
        source: &VerifiedWriterStaticCoverageV1,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        let before = clock.now_millis()?;
        self.assert_subject(authority, inventory, source, before)?;
        if let Some(expected) = &self.cache_hash {
            let cache = read_passive_authority_evidence_cache_v1(
                inventory.runtime_root(),
                Some(text(inventory.value(), "databaseScopeHash")?),
                Some(text(authority.trust(), "writerManifestHash")?),
                Some(before),
            )?;
            if cache["cacheHash"] != *expected {
                return Err(error(
                    "autonomous_research_online_mutation_inspection_cache_changed",
                ));
            }
        }
        verify(
            authority,
            &self.evidence,
            inventory,
            source,
            &self.manifest,
            before,
        )?;
        self.assert_time(authority, before, clock.now_millis()?)
    }
    /// Native-store transaction checks are restricted to this type's genuine
    /// active producer. Passive cache inspection has no retained file scope and
    /// is refused before any path access. The owning runtime retains its
    /// separate verified cache proof for the whole connection lifetime.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn assert_retained_for_native_store_transaction<T: MutationAuthorityTransportV1>(
        &self,
        authority: &PinnedMutationAuthorityV1<T>,
        inventory: &ObservedStateDatabaseInventoryV1,
        source: &VerifiedWriterStaticCoverageV1,
        active: &VerifiedActiveAuthorityEvidenceV1,
        retained_source: &RetainedWriterStaticInputsV1<'_>,
        guard: &NativeStoreTransactionInventoryGuardV1<'_>,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        let before = clock.now_millis()?;
        self.assert_subject(authority, inventory, source, before)?;
        if self.cache_hash.is_some() || self.evidence != active.value()["authorityEvidence"] {
            return Err(error(
                "autonomous_research_online_mutation_inspection_active_origin_required",
            ));
        }
        active.assert_retained_for_native_store_transaction(
            authority,
            inventory,
            source,
            retained_source,
            guard,
            before,
        )?;
        verify_retained_receipts(
            authority,
            &self.evidence,
            inventory,
            source,
            &self.manifest,
            before,
        )?;
        retained_source.assert_current(source, inventory, authority, active, guard)?;
        self.assert_time(authority, before, clock.now_millis()?)
    }
    fn assert_subject<T: MutationAuthorityTransportV1>(
        &self,
        authority: &PinnedMutationAuthorityV1<T>,
        inventory: &ObservedStateDatabaseInventoryV1,
        source: &VerifiedWriterStaticCoverageV1,
        before: i64,
    ) -> Result<()> {
        if before < self.observed_at
            || authority.configuration_hash() != self.authority_hash
            || inventory.value()["inventoryHash"] != self.inventory_hash
            || source.value()["astGateReceiptHash"] != self.source_hash
        {
            return Err(error(
                "autonomous_research_online_mutation_inspection_subject_changed",
            ));
        }
        Ok(())
    }
    fn assert_time<T: MutationAuthorityTransportV1>(
        &self,
        authority: &PinnedMutationAuthorityV1<T>,
        before: i64,
        after: i64,
    ) -> Result<()> {
        let maximum_age =
            crate::sqlite_mutation_coordinator::int(authority.trust(), "maximumObservationAgeMs")?;
        let age_exceeded = [
            ("currentHead", "observedAt"),
            ("activeChallenge", "challengedAt"),
            ("brokerScope", "observedAt"),
        ]
        .iter()
        .any(|(kind, field)| {
            timestamp(&self.evidence[kind]["receipt"][field])
                .is_none_or(|observed| after.saturating_sub(observed) > maximum_age)
        });
        if after < before || after >= earliest_expiry(&self.evidence)? || age_exceeded {
            return Err(error(
                "autonomous_research_online_mutation_inspection_expired",
            ));
        }
        Ok(())
    }
}
fn project(
    authority_hash: &str,
    evidence: &Value,
    source: &Value,
    manifest: &Value,
    coordinator: &Value,
    mode: &str,
    cache_contract: Value,
) -> Result<Value> {
    let manifest_hash = writer_manifest_hash_v1(manifest)?;
    let roles = &manifest["coverage"]["coveredDatabaseRoles"];
    let coverage = manifest["coverage"]["coveredRoleCount"].as_f64()
        == manifest["coverage"]["requiredRoleCount"].as_f64()
        && manifest["coverage"]["percent"].as_f64() == Some(100.0);
    let coordinator_ready = coordinator["implemented"] == true
        && coordinator["status"] == "externally_fenced_sqlite_mutation_coordinator_ready"
        && coordinator["coveredDatabaseRoles"] == *roles
        && coordinator["blockers"]
            .as_array()
            .is_some_and(Vec::is_empty);
    let ready = coverage && coordinator_ready;
    let scope = &evidence["brokerScope"]["receipt"];
    let normalized_scope = json!({"version":1,"kind":"AutonomousResearchOnlineWriterBrokerScopeReceipt","status":"autonomous_research_online_writer_broker_scope_complete","manifestHash":scope["writerManifestHash"],"coveredDatabaseRoles":scope["coveredDatabaseRoles"],"operationCount":scope["operationCount"],"operationIds":scope["operationIds"],"astGateReceiptHash":scope["astGateReceiptHash"],"codeProvenanceHash":scope["codeProvenanceHash"],"authorityId":scope["authorityId"],"keyId":scope["keyId"],"sequence":scope["globalSequence"],"hash":scope["globalHash"],"observedAt":scope["observedAt"],"expiresAt":scope["expiresAt"],"receiptHash":online_mutation_receipt_hash_v1(scope)?,"signatureVerified":true,"verificationSource":SOURCE,"localStaticInspectionMatched":scope["astGateReceiptHash"]==source["astGateReceiptHash"]});
    let normalized_static = json!({"version":1,"kind":"AutonomousResearchOnlineWriterStaticCoverageInspection","status":"autonomous_research_online_writer_static_coverage_complete","inspectionSource":"repository-ast-import-gate-v1","manifestHash":manifest_hash,"coveredDatabaseRoles":roles,"operationCount":source["operationCount"],"operationIds":source["operationIds"],"astGateReceiptHash":source["astGateReceiptHash"],"codeProvenanceHash":source["codeProvenanceHash"]});
    let coverage_blockers = if coverage {
        json!([])
    } else {
        json!(["autonomous_research_online_writer_manifest_100_percent_required"])
    };
    let mut blockers = coverage_blockers.as_array().cloned().unwrap_or_default();
    if !coordinator_ready {
        blockers.push(json!(DEPLOYMENT));
    }
    Ok(
        json!({"version":1,"kind":if ready{"AutonomousResearchOnlineAntiRollbackInspection"}else{"AutonomousResearchOnlineAntiRollbackInspectionUnavailable"},"status":if ready{"autonomous_research_online_anti_rollback_ready"}else{"autonomous_research_online_anti_rollback_blocked"},"inspectionSource":"pinned-external-authority-receipt-verifier-v1","inspectionMode":mode,"protocol":"external-linearizable-reserve-apply-finalize-v1","coordinatorImplementationStatus":coordinator["status"].as_str().filter(|s|!s.is_empty()).unwrap_or("unavailable-not-integrated"),"externalActionPerformed":mode==ACTIVE,"currentHeadReceipt":normalize_head(&evidence["currentHead"]["receipt"],false)?,"activeChallengeReceipt":normalize_head(&evidence["activeChallenge"]["receipt"],true)?,"writerCoverage":{"version":1,"kind":"AutonomousResearchOnlineWriterCoverageInspection","status":if coverage{"autonomous_research_online_writer_coverage_complete"}else{"autonomous_research_online_writer_coverage_blocked"},"manifest":manifest,"manifestHash":manifest_hash,"staticInspection":normalized_static,"brokerScopeReceipt":normalized_scope,"blockers":coverage_blockers},"authorityConfigurationHash":authority_hash,"journalSchemaContractHash":cache_contract,"blockerCodeCompatibility":blocker_code_compatibility_v1(),"blockers":expand_blocker_compatibility_v1(&json!(blockers))?}),
    )
}
pub struct OnlineAuthorityInspectionInputV1<'a, T> {
    pub authority: &'a PinnedMutationAuthorityV1<T>,
    pub inventory: &'a ObservedStateDatabaseInventoryV1,
    pub source: &'a VerifiedWriterStaticCoverageV1,
    pub manifest: &'a Value,
    pub coordinator: &'a Value,
}
fn inspect<T: MutationAuthorityTransportV1>(
    input: OnlineAuthorityInspectionInputV1<'_, T>,
    evidence: Value,
    cache_hash: Option<String>,
    clock: &mut dyn MutationClockV1,
) -> Result<VerifiedOnlineAuthorityInspectionV1> {
    let now = clock.now_millis()?;
    verify(
        input.authority,
        &evidence,
        input.inventory,
        input.source,
        input.manifest,
        now,
    )?;
    let passive = cache_hash.is_some();
    let contract = if passive {
        json!(crate::online_authority_evidence_cache::contract::cache_contract_hash_v1()?)
    } else {
        Value::Null
    };
    let value = project(
        input.authority.configuration_hash(),
        &evidence,
        input.source.value(),
        input.manifest,
        input.coordinator,
        if passive { PASSIVE } else { ACTIVE },
        contract,
    )?;
    let observed = VerifiedOnlineAuthorityInspectionV1 {
        value,
        evidence,
        manifest: input.manifest.clone(),
        authority_hash: input.authority.configuration_hash().into(),
        inventory_hash: text(input.inventory.value(), "inventoryHash")?.into(),
        source_hash: text(input.source.value(), "astGateReceiptHash")?.into(),
        observed_at: now,
        cache_hash,
    };
    observed.assert_current(input.authority, input.inventory, input.source, clock)?;
    Ok(observed)
}
/// Verifies all three cached signatures with current pinned configuration and
/// actual source/inventory. It performs no authority transport invocation.
pub fn inspect_passive_online_authority_v1<T: MutationAuthorityTransportV1>(
    authority: &PinnedMutationAuthorityV1<T>,
    inventory: &ObservedStateDatabaseInventoryV1,
    source: &VerifiedWriterStaticCoverageV1,
    manifest: &Value,
    coordinator_status: &Value,
    clock: &mut dyn MutationClockV1,
) -> Result<VerifiedOnlineAuthorityInspectionV1> {
    let before = clock.now_millis()?;
    let cache = read_passive_authority_evidence_cache_v1(
        inventory.runtime_root(),
        Some(text(inventory.value(), "databaseScopeHash")?),
        Some(text(authority.trust(), "writerManifestHash")?),
        Some(before),
    )?;
    let cache_hash = text(&cache, "cacheHash")?.to_owned();
    let result = inspect(
        OnlineAuthorityInspectionInputV1 {
            authority,
            inventory,
            source,
            manifest,
            coordinator: coordinator_status,
        },
        cache,
        Some(cache_hash),
        clock,
    )?;
    if result.observed_at < before {
        return Err(error(
            "autonomous_research_online_mutation_inspection_expired",
        ));
    }
    Ok(result)
}
/// Uses a real active refresh proof and repeats signature/currentness checks;
/// the descriptive coordinator status is never upgraded to a capability.
pub fn inspect_active_online_authority_v1<T: MutationAuthorityTransportV1>(
    input: OnlineAuthorityInspectionInputV1<'_, T>,
    active: &VerifiedActiveAuthorityEvidenceV1,
    clock: &mut dyn MutationClockV1,
) -> Result<VerifiedOnlineAuthorityInspectionV1> {
    let before = clock.now_millis()?;
    active.assert_current(
        input.authority,
        input.inventory.value(),
        input.source,
        before,
    )?;
    let result = inspect(
        input,
        active.value()["authorityEvidence"].clone(),
        None,
        clock,
    )?;
    if result.observed_at < before {
        return Err(error(
            "autonomous_research_online_mutation_inspection_expired",
        ));
    }
    Ok(result)
}

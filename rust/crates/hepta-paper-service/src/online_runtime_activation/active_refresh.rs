//! A real active challenge chain; returned evidence is still not runtime activation.
use crate::online_writer_static::VerifiedWriterStaticCoverageV1;
use crate::sqlite_mutation_coordinator::{
    Result,
    authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
    clock::{MutationClockV1, iso},
    contracts::online_mutation_receipt_hash_v1,
    error, hash,
    manifest::writer_manifest_hash_v1,
};
use serde_json::{Value, json};
fn now(clock: &mut dyn MutationClockV1, previous: &mut Option<i64>) -> Result<(i64, String)> {
    let time = clock.now_millis()?;
    if previous.is_some_and(|earlier| time < earlier) {
        return Err(error(
            "autonomous_research_online_mutation_active_refresh_clock_invalid",
        ));
    }
    *previous = Some(time);
    let text = iso(time)
        .map_err(|_| error("autonomous_research_online_mutation_active_refresh_clock_invalid"))?;
    Ok((time, text))
}
fn nonce(prefix: &str) -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| {
        error("autonomous_research_online_mutation_active_refresh_randomness_unavailable")
    })?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let s = hex::encode(bytes);
    Ok(format!(
        "{prefix}:{}-{}-{}-{}-{}",
        &s[..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..]
    ))
}
fn expected_instances(inventory: &Value) -> Result<Value> {
    let instances = inventory["instances"].as_array().ok_or_else(|| {
        error("autonomous_research_online_mutation_active_refresh_inventory_required")
    })?;
    let mut rows=instances.iter().map(|i|json!({"databaseRole":i["role"],"databaseInstanceId":i["instanceId"],"schemaHash":i["schemaHash"]})).collect::<Vec<_>>();
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    rows.sort_by(|a, b| {
        collator.compare(
            a["databaseInstanceId"].as_str().unwrap_or_default(),
            b["databaseInstanceId"].as_str().unwrap_or_default(),
        )
    });
    Ok(json!(rows))
}
fn same_head(current: &Value, challenge: &Value, scope: &Value) -> bool {
    current["globalSequence"].as_f64() == challenge["globalSequence"].as_f64()
        && current["globalSequence"].as_f64() == scope["globalSequence"].as_f64()
        && current["globalHash"] == challenge["globalHash"]
        && current["globalHash"] == scope["globalHash"]
        && hepta_legacy_compatibility::production_stable_json_v1(&current["databaseHeads"])
            .is_ok_and(|a| {
                hepta_legacy_compatibility::production_stable_json_v1(&challenge["databaseHeads"])
                    .is_ok_and(|b| a == b)
            })
}
/// Private construction requires an actual source scan and three pinned real
/// authority observations. No Deserialize or raw-JSON constructor is provided.
pub struct VerifiedActiveAuthorityEvidenceV1 {
    receipt: Value,
    authority_configuration_hash: String,
    inventory_hash: String,
    static_inspection_hash: String,
    expected_instances: Value,
}
impl VerifiedActiveAuthorityEvidenceV1 {
    pub fn value(&self) -> &Value {
        &self.receipt
    }
    pub fn authority_configuration_hash(&self) -> &str {
        &self.authority_configuration_hash
    }
    pub fn inventory_hash(&self) -> &str {
        &self.inventory_hash
    }
    pub fn assert_current<T: MutationAuthorityTransportV1>(
        &self,
        authority: &PinnedMutationAuthorityV1<T>,
        inventory: &Value,
        static_evidence: &VerifiedWriterStaticCoverageV1,
        now: i64,
    ) -> Result<()> {
        static_evidence.assert_current()?;
        if authority.configuration_hash() != self.authority_configuration_hash
            || inventory["inventoryHash"] != self.inventory_hash
            || static_evidence.value()["astGateReceiptHash"] != self.static_inspection_hash
            || expected_instances(inventory)? != self.expected_instances
        {
            return Err(error(
                "autonomous_research_online_mutation_active_refresh_authority_mismatch",
            ));
        }
        let evidence = &self.receipt["authorityEvidence"];
        let current = &evidence["currentHead"];
        let challenge = &evidence["activeChallenge"];
        let scope = &evidence["brokerScope"];
        authority.verify_current_head_receipt(
            &current["receipt"],
            &current["request"],
            Some(&self.expected_instances),
            now,
        )?;
        authority.verify_active_challenge_receipt(
            &challenge["receipt"],
            &challenge["request"],
            Some(&self.expected_instances),
            now,
        )?;
        authority.verify_scope_receipt(&scope["receipt"], &scope["request"], now)?;
        if !same_head(
            &current["receipt"],
            &challenge["receipt"],
            &scope["receipt"],
        ) {
            return Err(error(
                "autonomous_research_online_mutation_active_refresh_head_unstable",
            ));
        }
        Ok(())
    }
    pub fn receipt_hash(&self) -> Result<String> {
        hash(
            "AutonomousResearchOnlineMutationActiveRefreshReceipt",
            &self.receipt,
        )
    }
}
pub fn refresh_online_authority_evidence_v1<T: MutationAuthorityTransportV1>(
    inventory: &Value,
    manifest: &Value,
    authority: &mut PinnedMutationAuthorityV1<T>,
    static_evidence: &VerifiedWriterStaticCoverageV1,
    clock: &mut dyn MutationClockV1,
    maximum_attempts: u8,
) -> Result<VerifiedActiveAuthorityEvidenceV1> {
    if !(1..=5).contains(&maximum_attempts) {
        return Err(error(
            "autonomous_research_online_mutation_active_refresh_configuration_invalid",
        ));
    }
    super::inventory::assert_closed_activation_inventory_v1(inventory, manifest)
        .map_err(|e| error(e.code))?;
    static_evidence.assert_current()?;
    let manifest_hash = writer_manifest_hash_v1(manifest)?;
    let static_inspection = static_evidence.value();
    if authority.trust()["writerManifestHash"] != manifest_hash
        || authority.trust()["databaseScopeHash"] != inventory["databaseScopeHash"]
        || static_inspection["manifestHash"] != manifest_hash
    {
        return Err(error(
            "autonomous_research_online_mutation_active_refresh_authority_mismatch",
        ));
    }
    let expected = expected_instances(inventory)?;
    let mut previous = None;
    for attempt in 1..=maximum_attempts {
        let requested = now(clock, &mut previous)?.1;
        let trust = authority.trust();
        let base = json!({"version":1,"protocol":"external-linearizable-reserve-apply-finalize-v1","scopeId":trust["scopeId"],"databaseScopeHash":trust["databaseScopeHash"],"writerManifestHash":trust["writerManifestHash"],"requestedAt":requested});
        let mut current_request = base.clone();
        current_request["kind"] = json!("AutonomousResearchOnlineMutationCurrentHeadRequest");
        current_request["nonce"] = json!(nonce("head")?);
        let mut challenge_request = base.clone();
        challenge_request["kind"] = json!("AutonomousResearchOnlineMutationActiveChallengeRequest");
        challenge_request["challengeNonce"] = json!(nonce("challenge")?);
        let mut scope_request = base;
        scope_request["kind"] = json!("AutonomousResearchOnlineMutationScopeRequest");
        scope_request["nonce"] = json!(nonce("scope")?);
        for key in [
            "astGateReceiptHash",
            "codeProvenanceHash",
            "operationCount",
            "operationIds",
        ] {
            scope_request[key] = static_inspection[key].clone();
        }
        scope_request["staticInspectionReceiptHash"] =
            static_inspection["astGateReceiptHash"].clone();
        scope_request["requiredDatabaseRoles"] = manifest["requiredDatabaseRoles"].clone();
        scope_request["coveredDatabaseRoles"] =
            manifest["coverage"]["coveredDatabaseRoles"].clone();
        let current = authority.observe_current_head(
            &current_request,
            Some(&expected),
            now(clock, &mut previous)?.0,
        )?;
        let scope = authority.observe_scope(&scope_request, now(clock, &mut previous)?.0)?;
        let challenge = authority.challenge_active_authority(
            &challenge_request,
            Some(&expected),
            now(clock, &mut previous)?.0,
        )?;
        if !same_head(current.value(), challenge.value(), scope.value()) {
            continue;
        }
        let (observed, recorded) = now(clock, &mut previous)?;
        // Reject a receipt which expired while the process call was running.
        authority.verify_current_head_receipt(
            current.value(),
            &current_request,
            Some(&expected),
            observed,
        )?;
        authority.verify_scope_receipt(scope.value(), &scope_request, observed)?;
        authority.verify_active_challenge_receipt(
            challenge.value(),
            &challenge_request,
            Some(&expected),
            observed,
        )?;
        static_evidence.assert_current()?;
        let receipt = json!({"version":1,"kind":"AutonomousResearchOnlineMutationActiveRefreshReceipt","status":"autonomous_research_online_mutation_active_refresh_complete","externalActionPerformed":true,"linearizationAttemptCount":attempt,"globalSequence":current.value()["globalSequence"],"globalHash":current.value()["globalHash"],"currentHeadReceiptHash":online_mutation_receipt_hash_v1(current.value())?,"activeChallengeReceiptHash":online_mutation_receipt_hash_v1(challenge.value())?,"brokerScopeReceiptHash":online_mutation_receipt_hash_v1(scope.value())?,"authorityEvidence":{"currentHead":{"role":"current-head","request":current_request,"receipt":current.value()},"activeChallenge":{"role":"active-challenge","request":challenge_request,"receipt":challenge.value()},"brokerScope":{"role":"broker-scope","request":scope_request,"receipt":scope.value()}},"journalRecorded":false,"journalReceipt":null,"recordedAt":recorded});
        let receipt = serde_json::from_slice(
            &hepta_legacy_compatibility::production_stable_json_v1(&receipt)
                .map_err(|e| error(e.to_string()))?,
        )
        .map_err(|e| error(e.to_string()))?;
        // Pins and source currentness perform I/O after the earlier observation.
        // Sample once more, then check only already-authenticated memory values.
        let completed = now(clock, &mut previous)?.0;
        for (value, observed_key) in [
            (current.value(), "observedAt"),
            (scope.value(), "observedAt"),
            (challenge.value(), "challengedAt"),
        ] {
            if !crate::sqlite_mutation_coordinator::contracts::live(
                value,
                authority.trust(),
                observed_key,
                completed,
            ) {
                return Err(error(
                    "autonomous_research_online_mutation_active_refresh_evidence_expired",
                ));
            }
        }
        return Ok(VerifiedActiveAuthorityEvidenceV1{receipt,authority_configuration_hash:authority.configuration_hash().into(),inventory_hash:inventory["inventoryHash"].as_str().ok_or_else(||error("autonomous_research_online_mutation_active_refresh_inventory_required"))?.into(),static_inspection_hash:static_inspection["astGateReceiptHash"].as_str().ok_or_else(||error("autonomous_research_online_mutation_active_refresh_static_coverage_required"))?.into(),expected_instances:expected});
    }
    Err(error(
        "autonomous_research_online_mutation_active_refresh_head_unstable",
    ))
}

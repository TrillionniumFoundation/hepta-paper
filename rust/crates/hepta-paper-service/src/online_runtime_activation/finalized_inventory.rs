//! All-ten-database finalized-chain observations bound to the same signed active
//! head. Source databases are never opened by SQLite; each read uses an actual
//! inventory's private snapshot. This evidence grants no activation or writes.
use crate::{
    online_finalized_head_inspection::{
        VerifiedFinalizedHeadInspectionV1, inspect_online_finalized_database_head_v1,
    },
    online_runtime_activation::{
        active_refresh::VerifiedActiveAuthorityEvidenceV1,
        inventory::assert_closed_activation_inventory_v1,
    },
    online_writer_static::VerifiedWriterStaticCoverageV1,
    sqlite_mutation_coordinator::{
        Result,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock::{MutationClockV1, iso},
        contracts, error, hash,
        manifest::writer_manifest_hash_v1,
        text,
    },
    state_database_inventory::ObservedStateDatabaseInventoryV1,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{cell::Cell, path::PathBuf};

fn fail(suffix: &str) -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error(format!(
        "autonomous_research_online_finalized_inventory_{suffix}"
    ))
}
struct Clock<'a> {
    inner: &'a mut dyn MutationClockV1,
    last: &'a Cell<i64>,
}
impl MutationClockV1 for Clock<'_> {
    fn now_millis(&mut self) -> Result<i64> {
        let now = self.inner.now_millis()?;
        if now < self.last.get() {
            return Err(fail("clock_invalid"));
        }
        iso(now)?;
        self.last.set(now);
        Ok(now)
    }
}
/// An immutable collection of ten real local-chain inspections. JSON reports
/// cannot reconstruct it. Its currentness is an observation, not a filesystem
/// lock, a future authority-head lease, or runtime activation.
///
/// ```compile_fail
/// use hepta_paper_service::online_runtime_activation::finalized_inventory::VerifiedFinalizedInventoryV1;
/// let proof: VerifiedFinalizedInventoryV1 = serde_json::from_str("{}").unwrap();
/// ```
pub struct VerifiedFinalizedInventoryV1 {
    report: Value,
    heads: Vec<VerifiedFinalizedHeadInspectionV1>,
    runtime_root: PathBuf,
    inventory_hash: String,
    evidence_hash: String,
    source_hash: String,
    authority_hash: String,
    checked_at: Cell<i64>,
}
impl VerifiedFinalizedInventoryV1 {
    pub fn value(&self) -> &Value {
        &self.report
    }
    pub fn database_inspections(&self) -> &[VerifiedFinalizedHeadInspectionV1] {
        &self.heads
    }
    /// Recheck original opaque dependencies and all signed time windows without
    /// external calls. A changed runtime, source, trust, or evidence is refused.
    pub fn assert_current<T: MutationAuthorityTransportV1>(
        &self,
        inventory: &ObservedStateDatabaseInventoryV1,
        authority: &PinnedMutationAuthorityV1<T>,
        source: &VerifiedWriterStaticCoverageV1,
        evidence: &VerifiedActiveAuthorityEvidenceV1,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        let mut clock = Clock {
            inner: clock,
            last: &self.checked_at,
        };
        let before = clock.now_millis()?;
        if self.runtime_root != inventory.runtime_root()
            || inventory.value()["inventoryHash"] != self.inventory_hash
            || authority.configuration_hash() != self.authority_hash
            || source.value()["astGateReceiptHash"] != self.source_hash
            || evidence.receipt_hash()? != self.evidence_hash
        {
            return Err(fail("subject_changed"));
        }
        inventory.assert_current()?;
        evidence.assert_current(authority, inventory.value(), source, before)?;
        // No I/O after this sample. Immutable receipts were verified against the
        // same pinned trust; every head's age and exclusive expiry remain live.
        self.assert_time(authority.trust(), evidence, clock.now_millis()?)
    }
    pub(crate) fn assert_time(
        &self,
        trust: &Value,
        evidence: &VerifiedActiveAuthorityEvidenceV1,
        now: i64,
    ) -> Result<()> {
        let active = &evidence.value()["authorityEvidence"];
        if self
            .heads
            .iter()
            .any(|head| !contracts::live(head.current_head(), trust, "observedAt", now))
            || [
                ("currentHead", "observedAt"),
                ("activeChallenge", "challengedAt"),
                ("brokerScope", "observedAt"),
            ]
            .iter()
            .any(|(kind, field)| !contracts::live(&active[kind]["receipt"], trust, field, now))
        {
            return Err(fail("evidence_expired"));
        }
        Ok(())
    }
}
/// Performs ten fresh signed head requests and actual complete finalized-chain
/// scans, all bound to the caller's opaque active observation. It never opens a
/// live SQLite connection, repairs a marker, writes a cache, or constructs Active.
pub fn inspect_online_finalized_inventory_v1<T: MutationAuthorityTransportV1>(
    inventory: &ObservedStateDatabaseInventoryV1,
    writer_manifest: &Value,
    authority: &mut PinnedMutationAuthorityV1<T>,
    source: &VerifiedWriterStaticCoverageV1,
    evidence: &VerifiedActiveAuthorityEvidenceV1,
    clock: &mut dyn MutationClockV1,
) -> Result<VerifiedFinalizedInventoryV1> {
    let high_water = Cell::new(i64::MIN);
    let mut clock = Clock {
        inner: clock,
        last: &high_water,
    };
    let started = clock.now_millis()?;
    inventory.assert_current()?;
    assert_closed_activation_inventory_v1(inventory.value(), writer_manifest)
        .map_err(|e| error(e.code))?;
    let manifest_hash = writer_manifest_hash_v1(writer_manifest)?;
    if source.value()["manifestHash"] != manifest_hash
        || authority.trust()["writerManifestHash"] != manifest_hash
    {
        return Err(fail("manifest_mismatch"));
    }
    evidence.assert_current(authority, inventory.value(), source, started)?;
    let active = &evidence.value()["authorityEvidence"]["currentHead"]["receipt"];
    let expected_heads =
        hepta_legacy_compatibility::production_stable_json_v1(&active["databaseHeads"])
            .map_err(|e| error(e.to_string()))?;
    let mut heads = Vec::with_capacity(10);
    let instances = inventory.value()["instances"]
        .as_array()
        .ok_or_else(|| fail("inventory_invalid"))?;
    for instance in instances {
        let id = text(instance, "instanceId")?;
        let head = inventory.with_database_snapshot(id, |path| {
            let mut database = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            database.busy_timeout(std::time::Duration::ZERO)?;
            database.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")?;
            inspect_online_finalized_database_head_v1(
                &mut database,
                id,
                inventory.value(),
                authority,
                writer_manifest,
                &mut clock,
            )
        })?;
        if head.authority_configuration_hash() != authority.configuration_hash()
            || head.current_head()["globalSequence"].as_f64() != active["globalSequence"].as_f64()
            || head.current_head()["globalHash"] != active["globalHash"]
            || hepta_legacy_compatibility::production_stable_json_v1(
                &head.current_head()["databaseHeads"],
            )
            .map_err(|e| error(e.to_string()))?
                != expected_heads
        {
            return Err(fail("head_unstable"));
        }
        heads.push(head);
    }
    let mut report = json!({
        "version":1,"kind":"AutonomousResearchOnlineFinalizedInventoryInspection",
        "status":"autonomous_research_online_finalized_inventory_verified",
        "inventoryHash":inventory.value()["inventoryHash"],"databaseScopeHash":inventory.value()["databaseScopeHash"],
        "writerManifestHash":manifest_hash,"activeRefreshReceiptHash":evidence.receipt_hash()?,
        "authorityGlobalSequence":active["globalSequence"],"authorityGlobalHash":active["globalHash"],
        "databaseInspections":heads.iter().map(|v|v.value()).collect::<Vec<_>>(),"runtimeReady":false
    });
    report["inspectionHash"] = hash(
        "AutonomousResearchOnlineFinalizedInventoryInspection",
        &report,
    )?
    .into();
    let proof = VerifiedFinalizedInventoryV1 {
        report,
        heads,
        runtime_root: inventory.runtime_root().into(),
        inventory_hash: text(inventory.value(), "inventoryHash")?.into(),
        evidence_hash: evidence.receipt_hash()?,
        source_hash: text(source.value(), "astGateReceiptHash")?.into(),
        authority_hash: authority.configuration_hash().into(),
        checked_at: Cell::new(started),
    };
    proof.assert_current(inventory, authority, source, evidence, &mut clock)?;
    proof.checked_at.set(clock.now_millis()?);
    proof.assert_time(authority.trust(), evidence, proof.checked_at.get())?;
    Ok(proof)
}

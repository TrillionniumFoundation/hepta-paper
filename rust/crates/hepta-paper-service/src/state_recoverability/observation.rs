//! Fresh backup-head observations bound to one already verified source bundle.
use super::*;
use crate::sqlite_mutation_coordinator::authority::files::parse;
use crate::state_backup_authority::restore_source::VerifiedStoredRestoreSourceV1;
use crate::state_backup_authority::{
    PinnedStateBackupAuthorityV1, StateBackupAuthorityTransportV1,
    state_backup_authority_receipt_hash_v1,
};
use std::path::Path;
/// A real signed head observation. It is not a current epoch permit; the actual
/// runtime inventory, resident lease and reconciliation state must also agree.
pub struct LiveBackupHeadObservationV1 {
    value: Value,
    source_binding: String,
    authority_configuration_hash: String,
    observed_at: i64,
    expires_at: i64,
    latest_observation_at: i64,
}
impl LiveBackupHeadObservationV1 {
    pub fn value(&self) -> &Value {
        &self.value
    }
    pub fn authority_configuration_hash(&self) -> &str {
        &self.authority_configuration_hash
    }
    pub(super) fn assert_valid_at(&self, now: i64, required_validity_ms: i64) -> Result<()> {
        ensure(
            required_validity_ms >= 0
                && now >= self.observed_at
                && now < self.expires_at
                && now <= self.latest_observation_at
                && self
                    .expires_at
                    .checked_sub(now)
                    .is_some_and(|v| v >= required_validity_ms),
            "autonomous_research_state_recoverability_observation_validity_insufficient",
        )
    }
    pub fn assert_current(
        &self,
        source: &VerifiedStoredRestoreSourceV1,
        inventory: &Value,
        now: i64,
        required_validity_ms: i64,
    ) -> Result<()> {
        self.assert_valid_at(now, required_validity_ms)?;
        ensure(
            hash(
                "AutonomousResearchStateBackupSourcesInspection",
                source.inspection(),
            )? == self.source_binding,
            "autonomous_research_state_recoverability_observation_source_changed",
        )?;
        source.assert_current(inventory, now)
    }
}
pub fn observe_stored_backup_head_v1<T: StateBackupAuthorityTransportV1>(
    authority: &mut PinnedStateBackupAuthorityV1<T>,
    source: &VerifiedStoredRestoreSourceV1,
    inventory: &Value,
    clock: &mut dyn MutationClockV1,
) -> Result<LiveBackupHeadObservationV1> {
    let before = clock_now(clock)?;
    source.assert_current(inventory, before.0)?;
    let root = Path::new(text(source.inspection(), "bundlePath")?);
    let snapshot = super::files::ObservedFile::open(
        &root.join("AUTONOMOUS_RESEARCH_STATE_BACKUP.json"),
        64 * 1024 * 1024,
    )?;
    let bundle = parse(
        &snapshot.bytes(64 * 1024 * 1024)?,
        "autonomous_research_state_backup_bundle_manifest_hash_invalid",
    )?;
    ensure(
        bundle["bundleManifestHash"] == source.inspection()["bundleManifestHash"]
            && bundle["snapshotContentHash"] == source.inspection()["snapshotContentHash"]
            && bundle["content"]["databaseScopeHash"] == source.inspection()["databaseScopeHash"],
        "autonomous_research_state_recoverability_observation_source_changed",
    )?;
    let reservation = authority.verify_reservation(
        &bundle["authorityReservation"],
        &bundle["authorityReserveRequest"],
        timestamp(&bundle["authorityReservation"]["issuedAt"]).ok_or_else(|| {
            error("autonomous_research_state_restore_authority_reservation_invalid")
        })?,
    )?;
    authority.verify_finalization(
        &bundle["authorityFinalization"],
        &bundle["authorityFinalizeRequest"],
        &reservation,
        timestamp(&bundle["authorityFinalization"]["finalizedAt"]).ok_or_else(|| {
            error("autonomous_research_state_restore_authority_finalization_invalid")
        })?,
    )?;
    let request = json!({"version":1,"kind":"AutonomousResearchStateBackupAuthorityCurrentHeadRequest","reservationId":bundle["authorityReservation"]["reservationId"],"databaseScopeHash":bundle["content"]["databaseScopeHash"],"snapshotContentHash":bundle["snapshotContentHash"],"requestedAt":before.1,"maximumLeaseMs":authority.trust()["maximumReservationLeaseMs"]});
    let initial = authority.observe_current_head(&request, before.0)?;
    let after = clock_now(clock)?;
    ensure(
        after.0 >= before.0,
        "autonomous_research_state_recoverability_clock_invalid",
    )?;
    // The process may consume all of a signed observation's lease. Validate
    // again with the actually observed return time, not the request time.
    let current = authority.verify_current_head(initial.value(), &request, after.0)?;
    snapshot.assert_current()?;
    source.assert_current(inventory, after.0)?;
    let completed = clock_now(clock)?;
    ensure(
        completed.0 >= after.0,
        "autonomous_research_state_recoverability_clock_invalid",
    )?;
    let value = json!({"version":1,"kind":"AutonomousResearchStateBackupCurrentHeadInspection","status":"autonomous_research_state_backup_current_head_observed","bundlePath":root,"bundleManifestHash":bundle["bundleManifestHash"],"snapshotContentHash":bundle["snapshotContentHash"],"snapshotHeadSequence":bundle["authorityFinalization"]["headSequence"],"snapshotHeadHash":bundle["authorityFinalization"]["headHash"],"authorityCurrentHeadRequest":request,"authorityCurrentHeadReceipt":current.value(),"authorityCurrentHeadReceiptHash":state_backup_authority_receipt_hash_v1(current.value())?,"observedAt":completed.1,"externalActionPerformed":true,"productionStateMutated":false,"blockers":[]});
    let observation = LiveBackupHeadObservationV1 {
        expires_at: timestamp(&current.value()["expiresAt"]).ok_or_else(|| {
            error("autonomous_research_state_recoverability_observation_validity_insufficient")
        })?,
        value,
        source_binding: hash(
            "AutonomousResearchStateBackupSourcesInspection",
            source.inspection(),
        )?,
        authority_configuration_hash: authority.configuration_hash().into(),
        observed_at: completed.0,
        latest_observation_at: timestamp(&current.value()["observedAt"])
            .and_then(|at| {
                at.checked_add(int(authority.trust(), "maximumHeadObservationAgeMs").ok()?)
            })
            .ok_or_else(|| {
                error("autonomous_research_state_recoverability_observation_validity_insufficient")
            })?,
    };
    observation.assert_valid_at(completed.0, 0)?;
    Ok(observation)
}

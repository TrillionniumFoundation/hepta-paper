//! Real signed all-scope maintenance reservation. This token is not runtime
//! activation and currently exposes no live database write operation.
use super::plan::ObservedSchemaTransitionPlanV1;
use crate::sqlite_mutation_coordinator::{
    Result,
    authority::{
        MutationAuthorityTransportV1, PinnedMutationAuthorityV1, VerifiedMutationReceiptV1,
    },
    clock::{MutationClockV1, iso},
    error, int, timestamp,
};
use serde_json::Value;

/// No public constructor/Deserialize/Clone: minted only after a real pinned
/// signature, actual complete source rechecks and a fresh post-I/O lease sample.
pub struct QuiescedSchemaMaintenanceV1 {
    plan: ObservedSchemaTransitionPlanV1,
    request: Value,
    reservation: VerifiedMutationReceiptV1,
    checked_at: i64,
}
impl QuiescedSchemaMaintenanceV1 {
    pub fn plan(&self) -> &Value {
        self.plan.value()
    }
    pub fn request(&self) -> &Value {
        &self.request
    }
    pub fn reservation(&self) -> &Value {
        self.reservation.value()
    }
    fn advance_clock(&mut self, now: i64) -> Result<()> {
        if now < self.checked_at {
            return Err(error(
                "autonomous_research_online_schema_transition_clock_regressed",
            ));
        }
        // Keep the high-water mark even when the later validation fails: an
        // already observed expiry cannot be undone by retrying an older clock.
        self.checked_at = now;
        Ok(())
    }
    pub fn assert_current<T: MutationAuthorityTransportV1>(
        &mut self,
        authority: &PinnedMutationAuthorityV1<T>,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        let before = clock.now_millis()?;
        self.advance_clock(before)?;
        if self.plan.authority_configuration_hash() != authority.configuration_hash() {
            return Err(error(
                "autonomous_research_online_schema_transition_authority_configuration_mismatch",
            ));
        }
        self.plan.assert_current()?;
        let verify_at = clock.now_millis()?;
        self.advance_clock(verify_at)?;
        let reservation = authority.verify_schema_transition_reservation(
            self.reservation.value(),
            &self.request,
            verify_at,
        )?;
        // The pinned verifier above performs file I/O. This final operation is
        // memory-only, so a long inventory/key read cannot hide lease expiry.
        let after = clock.now_millis()?;
        self.advance_clock(after)?;
        assert_lease(reservation.value(), self.plan.value(), verify_at, after)?;
        self.reservation = reservation;
        self.checked_at = after;
        Ok(())
    }
}
fn assert_lease(reservation: &Value, plan: &Value, before: i64, after: i64) -> Result<()> {
    if after < before {
        return Err(error(
            "autonomous_research_online_schema_transition_clock_regressed",
        ));
    }
    let expires = timestamp(&reservation["expiresAt"]).ok_or_else(|| {
        error("autonomous_research_online_schema_transition_quiescence_lease_insufficient")
    })?;
    let required = int(plan, "requiredExecutionWindowMs")?;
    if after >= expires
        || expires
            .checked_sub(after)
            .is_none_or(|remaining| remaining < required)
    {
        return Err(error(
            "autonomous_research_online_schema_transition_quiescence_lease_insufficient",
        ));
    }
    Ok(())
}
/// Invokes the pinned authority only after actual source checks. JSON flags or
/// unsigned receipts cannot mint this token. External linearizability still
/// depends on the qualified authority service behind that pinned transport.
pub fn reserve_schema_maintenance_v1<T: MutationAuthorityTransportV1>(
    plan: ObservedSchemaTransitionPlanV1,
    authority: &mut PinnedMutationAuthorityV1<T>,
    clock: &mut dyn MutationClockV1,
) -> Result<QuiescedSchemaMaintenanceV1> {
    let before = clock.now_millis()?;
    let planned_at = timestamp(&plan.value()["plannedAt"])
        .ok_or_else(|| error("autonomous_research_online_schema_transition_clock_invalid"))?;
    if before < planned_at {
        return Err(error(
            "autonomous_research_online_schema_transition_clock_regressed",
        ));
    }
    let request = plan.reserve_request(authority, &iso(before)?)?;
    plan.assert_current()?;
    let invoke_at = clock.now_millis()?;
    if invoke_at < before {
        return Err(error(
            "autonomous_research_online_schema_transition_clock_regressed",
        ));
    }
    let reservation = authority.reserve_schema_transition(&request, invoke_at)?;
    let mut result = QuiescedSchemaMaintenanceV1 {
        plan,
        request,
        reservation,
        checked_at: invoke_at,
    };
    result.assert_current(authority, clock)?;
    Ok(result)
}

pub mod normalization;

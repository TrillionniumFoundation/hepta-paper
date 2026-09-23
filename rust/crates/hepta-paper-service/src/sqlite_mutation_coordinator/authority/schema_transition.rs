//! Real pinned schema authority verification with opaque historical reservations.
use super::*;
use crate::sqlite_mutation_coordinator::contracts::schema_transition::*;
impl<T: MutationAuthorityTransportV1> PinnedMutationAuthorityV1<T> {
    pub fn verify_schema_transition_reservation(
        &self,
        receipt: &Value,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        let valid =
            verify_schema_transition_reservation_v1(receipt, request, &self.trust, now, &|v| {
                self.signature(v)
            })?;
        self.checked(
            normalize_schema_numbers_v1(receipt)?,
            valid,
            "autonomous_research_online_schema_transition_reservation_invalid",
        )
    }
    pub fn verify_historical_schema_transition_reservation(
        &self,
        receipt: &Value,
        request: &Value,
    ) -> Result<VerifiedMutationReceiptV1> {
        let now = timestamp(&receipt["issuedAt"]).ok_or_else(|| {
            error("autonomous_research_online_schema_transition_reservation_invalid")
        })?;
        self.verify_schema_transition_reservation(receipt, request, now)
    }
    pub fn reserve_schema_transition(
        &mut self,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        assert_schema_transition_reserve_request_v1(request, &self.trust)?;
        let receipt = self.transport.invoke(request)?;
        self.verify_schema_transition_reservation(&receipt, request, now)
    }
    fn same_schema_reservation(&self, reservation: &VerifiedMutationReceiptV1) -> Result<()> {
        self.current()?;
        if reservation.verifier_identity != self.configuration_hash
            || reservation.value["kind"]
                != "AutonomousResearchOnlineSchemaTransitionReservationReceipt"
        {
            return Err(error(
                "autonomous_research_online_schema_transition_reservation_invalid",
            ));
        }
        Ok(())
    }
    pub fn verify_schema_transition_finalization(
        &self,
        receipt: &Value,
        request: &Value,
        reservation: &VerifiedMutationReceiptV1,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.same_schema_reservation(reservation)?;
        let valid = verify_schema_transition_finalization_v1(
            receipt,
            request,
            reservation.value(),
            &self.trust,
            now,
            &|v| self.signature(v),
        )?;
        self.checked(
            normalize_schema_numbers_v1(receipt)?,
            valid,
            "autonomous_research_online_schema_transition_finalization_invalid",
        )
    }
    pub fn verify_historical_schema_transition_finalization(
        &self,
        receipt: &Value,
        request: &Value,
        reservation: &VerifiedMutationReceiptV1,
    ) -> Result<VerifiedMutationReceiptV1> {
        let now = timestamp(&receipt["finalizedAt"]).ok_or_else(|| {
            error("autonomous_research_online_schema_transition_finalization_invalid")
        })?;
        self.verify_schema_transition_finalization(receipt, request, reservation, now)
    }
    pub fn finalize_schema_transition(
        &mut self,
        request: &Value,
        reservation: &VerifiedMutationReceiptV1,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.same_schema_reservation(reservation)?;
        assert_schema_transition_finalize_request_v1(request, reservation.value())?;
        let receipt = self.transport.invoke(request)?;
        self.verify_schema_transition_finalization(&receipt, request, reservation, now)
    }
    pub fn verify_schema_transition_observation(
        &self,
        receipt: &Value,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        let valid =
            verify_schema_transition_observation_v1(receipt, request, &self.trust, now, &|v| {
                self.signature(v)
            })?;
        self.checked(
            normalize_schema_numbers_v1(receipt)?,
            valid,
            "autonomous_research_online_schema_transition_observation_invalid",
        )
    }
    pub fn verify_historical_schema_transition_observation(
        &self,
        receipt: &Value,
        request: &Value,
    ) -> Result<VerifiedMutationReceiptV1> {
        let now = timestamp(&receipt["observedAt"]).ok_or_else(|| {
            error("autonomous_research_online_schema_transition_observation_invalid")
        })?;
        self.verify_schema_transition_observation(receipt, request, now)
    }
    pub fn observe_schema_transition(
        &mut self,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        assert_schema_transition_observe_request_v1(request, &self.trust)?;
        let receipt = self.transport.invoke(request)?;
        self.verify_schema_transition_observation(&receipt, request, now)
    }
}

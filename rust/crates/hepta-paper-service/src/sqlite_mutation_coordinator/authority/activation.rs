use super::*;
use crate::sqlite_mutation_coordinator::contracts::activation::*;
impl<T: MutationAuthorityTransportV1> PinnedMutationAuthorityV1<T> {
    pub fn verify_current_head_receipt(
        &self,
        receipt: &Value,
        request: &Value,
        expected_instances: Option<&Value>,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        let valid = verify_current_head_v1(
            receipt,
            request,
            &self.trust,
            now,
            expected_instances,
            &|v| self.signature(v),
        )?;
        self.checked(
            receipt.clone(),
            valid,
            "autonomous_research_online_mutation_current_head_receipt_invalid",
        )
    }
    pub fn verify_active_challenge_receipt(
        &self,
        receipt: &Value,
        request: &Value,
        expected_instances: Option<&Value>,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        let valid = verify_active_challenge_v1(
            receipt,
            request,
            &self.trust,
            now,
            expected_instances,
            &|v| self.signature(v),
        )?;
        self.checked(
            receipt.clone(),
            valid,
            "autonomous_research_online_mutation_active_challenge_receipt_invalid",
        )
    }
    pub fn challenge_active_authority(
        &mut self,
        request: &Value,
        expected_instances: Option<&Value>,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        verify_active_challenge_v1(
            &Value::Null,
            request,
            &self.trust,
            now,
            expected_instances,
            &|_| false,
        )?;
        let receipt = self.transport.invoke(request)?;
        self.verify_active_challenge_receipt(&receipt, request, expected_instances, now)
    }
    pub fn verify_scope_receipt(
        &self,
        receipt: &Value,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        let valid =
            verify_scope_receipt_v1(receipt, request, &self.trust, now, &|v| self.signature(v))?;
        self.checked(
            receipt.clone(),
            valid,
            "autonomous_research_online_mutation_scope_receipt_invalid",
        )
    }
    pub fn observe_scope(
        &mut self,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        assert_scope_request_v1(request, &self.trust)?;
        let receipt = self.transport.invoke(request)?;
        self.verify_scope_receipt(&receipt, request, now)
    }
    pub fn verify_unresolved_list_receipt(
        &self,
        receipt: &Value,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        let valid =
            verify_unresolved_list_v1(receipt, request, &self.trust, now, &|v| self.signature(v))?;
        self.checked(
            receipt.clone(),
            valid,
            "autonomous_research_online_unresolved_reservation_list_receipt_invalid",
        )
    }
    pub fn list_unresolved_mutations(
        &mut self,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        assert_unresolved_list_request_v1(request, &self.trust)?;
        let receipt = self.transport.invoke(request)?;
        self.verify_unresolved_list_receipt(&receipt, request, now)
    }
}

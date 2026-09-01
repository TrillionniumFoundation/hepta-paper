use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::{ActionCandidateV1, PreparedResultStatusV1, PreparedResultV1};
use serde::{Deserialize, Serialize};

use crate::{ControlPlaneError, PlanCertificateV1, ResourceReservationV1};

/// Request supplied to a module executor after plan and resource admission.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionRequestV1 {
    /// Contract version.
    pub version: u16,
    /// Stable execution attempt ID.
    pub attempt_id: String,
    /// Exact immutable snapshot hash.
    pub snapshot_hash: Sha256Digest,
    /// Exact selected plan hash.
    pub plan_hash: Sha256Digest,
    /// Selected candidate.
    pub candidate: ActionCandidateV1,
    /// Exact resource reservation.
    pub reservation: ResourceReservationV1,
}

/// Batch executor boundary. Implementations may execute expensive requests in parallel.
pub trait ModuleExecutorV1 {
    /// Executes a complete admitted batch and returns one prepared result per request.
    fn execute_batch(
        &mut self,
        requests: &[ExecutionRequestV1],
    ) -> Result<Vec<PreparedResultV1>, ControlPlaneError>;
}

/// Independently verified prepared result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifiedPreparedResultV1 {
    /// Exact prepared result.
    pub result: PreparedResultV1,
    /// Canonical prepared-result hash.
    pub result_hash: Sha256Digest,
    /// Verifier identity/configuration hash.
    pub verifier_hash: Sha256Digest,
    /// Verification decision.
    pub accepted: bool,
}

/// Verification boundary between execution and authoritative integration.
pub trait PreparedResultVerifierV1 {
    /// Verifies one prepared result against its selected candidate and plan.
    fn verify(
        &self,
        result: PreparedResultV1,
        candidate: &ActionCandidateV1,
        plan: &PlanCertificateV1,
    ) -> Result<VerifiedPreparedResultV1, ControlPlaneError>;
}

/// Deterministic contract verifier for source and fake-provider replays.
#[derive(Clone, Debug)]
pub struct DeterministicPreparedResultVerifierV1 {
    verifier_hash: Sha256Digest,
}

impl DeterministicPreparedResultVerifierV1 {
    /// Creates a verifier bound to an exact implementation/configuration hash.
    #[must_use]
    pub fn new(verifier_hash: Sha256Digest) -> Self {
        Self { verifier_hash }
    }
}

impl PreparedResultVerifierV1 for DeterministicPreparedResultVerifierV1 {
    fn verify(
        &self,
        result: PreparedResultV1,
        candidate: &ActionCandidateV1,
        plan: &PlanCertificateV1,
    ) -> Result<VerifiedPreparedResultV1, ControlPlaneError> {
        result
            .validate(candidate, &plan.plan_hash)
            .map_err(|_| ControlPlaneError::VerificationInvalid)?;
        if result.status != PreparedResultStatusV1::Prepared
            || result.external_action_may_have_started
        {
            return Err(ControlPlaneError::VerificationInvalid);
        }
        let result_hash = result
            .result_hash()
            .map_err(|_| ControlPlaneError::VerificationInvalid)?;
        Ok(VerifiedPreparedResultV1 {
            result,
            result_hash,
            verifier_hash: self.verifier_hash.clone(),
            accepted: true,
        })
    }
}

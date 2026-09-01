use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::{ActionCandidateV1, PreparedResultStatusV1, PreparedResultV1};
use serde::{Deserialize, Serialize};

use crate::{ControlPlaneError, PlanCertificateV1, ResourceReservationV1, canonical_hash_v1};

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

mod sealed {
    pub trait Sealed {}
}

/// Independently verified prepared result.
///
/// This capability does not implement `Deserialize`, and its fields are not
/// public outside this crate. Only a sealed trusted verifier can construct it.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedPreparedResultV1 {
    pub(crate) result: PreparedResultV1,
    pub(crate) result_hash: Sha256Digest,
    pub(crate) verifier_hash: Sha256Digest,
    pub(crate) verification_receipt_hash: Sha256Digest,
}

impl VerifiedPreparedResultV1 {
    /// Returns the exact prepared result.
    #[must_use]
    pub fn result(&self) -> &PreparedResultV1 {
        &self.result
    }

    /// Returns the independently recomputed result hash.
    #[must_use]
    pub fn result_hash(&self) -> &Sha256Digest {
        &self.result_hash
    }

    /// Returns the trusted verifier identity/configuration hash.
    #[must_use]
    pub fn verifier_hash(&self) -> &Sha256Digest {
        &self.verifier_hash
    }

    /// Returns the receipt hash binding result and verifier identities.
    #[must_use]
    pub fn verification_receipt_hash(&self) -> &Sha256Digest {
        &self.verification_receipt_hash
    }
}

/// Verification boundary between execution and authoritative integration.
///
/// The trait is sealed so an untrusted downstream crate cannot mint an accepted
/// verification capability merely by implementing this interface.
pub trait PreparedResultVerifierV1: sealed::Sealed {
    /// Verifies one prepared result against its selected candidate and plan.
    fn verify(
        &self,
        result: PreparedResultV1,
        candidate: &ActionCandidateV1,
        plan: &PlanCertificateV1,
    ) -> Result<VerifiedPreparedResultV1, ControlPlaneError>;

    /// Returns the exact identity/configuration hash authorized by the sequencer.
    fn verifier_hash(&self) -> &Sha256Digest;
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

impl sealed::Sealed for DeterministicPreparedResultVerifierV1 {}

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
        let verification_receipt_hash = verification_receipt_hash_v1(
            &result_hash,
            &self.verifier_hash,
        )?;
        Ok(VerifiedPreparedResultV1 {
            result,
            result_hash,
            verifier_hash: self.verifier_hash.clone(),
            verification_receipt_hash,
        })
    }

    fn verifier_hash(&self) -> &Sha256Digest {
        &self.verifier_hash
    }
}

pub(crate) fn verification_receipt_hash_v1(
    result_hash: &Sha256Digest,
    verifier_hash: &Sha256Digest,
) -> Result<Sha256Digest, ControlPlaneError> {
    canonical_hash_v1(&VerificationReceiptBodyV1 {
        version: 1,
        result_hash,
        verifier_hash,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerificationReceiptBodyV1<'a> {
    version: u16,
    result_hash: &'a Sha256Digest,
    verifier_hash: &'a Sha256Digest,
}

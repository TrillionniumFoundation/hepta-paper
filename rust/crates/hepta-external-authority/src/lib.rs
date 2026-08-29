//! Narrow external-authority ports. This crate intentionally ships no production signer.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// External authority class.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalAuthorityKindV1 {
    /// KMS/HSM release signing.
    ReleaseSigner,
    /// Immutable storage and custody.
    WormCustody,
    /// Backup and independent restore attestation.
    BackupRestore,
    /// Portal/API provider action.
    SubmissionDispatcher,
}

/// Request sent to one separately controlled authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalAuthorityRequestV1 {
    /// Contract version.
    pub version: u16,
    /// External authority class.
    pub authority_kind: ExternalAuthorityKindV1,
    /// Globally unique operation identity.
    pub operation_id: String,
    /// Exact request body hash.
    pub request_hash: String,
    /// Exact campaign or release subject hash.
    pub subject_hash: String,
    /// Single-use nonce.
    pub nonce: String,
    /// Absolute deadline.
    pub deadline_unix_ms: u64,
}

/// Independently verifiable external response.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalAuthorityReceiptV1 {
    /// Contract version.
    pub version: u16,
    /// Authority class.
    pub authority_kind: ExternalAuthorityKindV1,
    /// Exact request operation.
    pub operation_id: String,
    /// Exact request hash.
    pub request_hash: String,
    /// External result hash.
    pub result_hash: String,
    /// Separately administered authority domain.
    pub authority_domain_id: String,
    /// Public verification key identifier.
    pub signer_key_id: String,
    /// External signature encoding.
    pub signature_base64: String,
    /// Receipt issue time.
    pub issued_at_unix_ms: u64,
    /// Receipt expiry time.
    pub expires_at_unix_ms: u64,
    /// Whether the external action may have happened despite an ambiguous response.
    pub external_action_may_have_started: bool,
}

/// Verification boundary supplied by an independently provisioned implementation.
pub trait ExternalReceiptVerifierV1: Send + Sync {
    /// Verifies signature, trust generation, revocation, freshness, and exact request binding.
    fn verify(
        &self,
        request: &ExternalAuthorityRequestV1,
        receipt: &ExternalAuthorityReceiptV1,
        now_unix_ms: u64,
    ) -> Result<(), ExternalAuthorityError>;
}

/// KMS/HSM signing authority. Production implementations remain out of repository scope.
pub trait ReleaseSignerPortV1: Send + Sync {
    /// Requests one exact release signature.
    fn sign_release(
        &self,
        request: &ExternalAuthorityRequestV1,
    ) -> Result<ExternalAuthorityReceiptV1, ExternalAuthorityError>;
}

/// Immutable storage/custody authority.
pub trait WormCustodyPortV1: Send + Sync {
    /// Stores one exact object under active retention and returns external evidence.
    fn retain_object(
        &self,
        request: &ExternalAuthorityRequestV1,
    ) -> Result<ExternalAuthorityReceiptV1, ExternalAuthorityError>;
}

/// Backup/restore authority.
pub trait BackupRestorePortV1: Send + Sync {
    /// Executes an independently controlled restore proof.
    fn prove_restore(
        &self,
        request: &ExternalAuthorityRequestV1,
    ) -> Result<ExternalAuthorityReceiptV1, ExternalAuthorityError>;
}

/// Single-use portal/API dispatcher.
pub trait SubmissionDispatcherPortV1: Send + Sync {
    /// Executes or reconciles one exact external submission operation.
    fn dispatch(
        &self,
        request: &ExternalAuthorityRequestV1,
    ) -> Result<ExternalAuthorityReceiptV1, ExternalAuthorityError>;
}

/// Validates contract shape before any external call or receipt verification.
pub fn validate_external_request_v1(
    request: &ExternalAuthorityRequestV1,
    now_unix_ms: u64,
) -> Result<(), ExternalAuthorityError> {
    if request.version != 1
        || !valid_identifier(&request.operation_id)
        || !valid_identifier(&request.nonce)
        || request.deadline_unix_ms <= now_unix_ms
    {
        return Err(ExternalAuthorityError::RequestInvalid);
    }
    validate_hash(&request.request_hash)?;
    validate_hash(&request.subject_hash)
}

/// Validates shape and exact subject binding before delegating cryptographic verification.
pub fn verify_external_receipt_v1(
    request: &ExternalAuthorityRequestV1,
    receipt: &ExternalAuthorityReceiptV1,
    now_unix_ms: u64,
    verifier: &dyn ExternalReceiptVerifierV1,
) -> Result<(), ExternalAuthorityError> {
    validate_external_request_v1(request, now_unix_ms)?;
    if receipt.version != 1
        || receipt.authority_kind != request.authority_kind
        || receipt.operation_id != request.operation_id
        || receipt.request_hash != request.request_hash
        || !valid_identifier(&receipt.authority_domain_id)
        || !valid_identifier(&receipt.signer_key_id)
        || receipt.signature_base64.is_empty()
        || receipt.issued_at_unix_ms == 0
        || receipt.issued_at_unix_ms > now_unix_ms
        || receipt.expires_at_unix_ms <= now_unix_ms
    {
        return Err(ExternalAuthorityError::ReceiptInvalid);
    }
    validate_hash(&receipt.result_hash)?;
    verifier.verify(request, receipt, now_unix_ms)
}

/// Requires distinct external domains for release signing, custody, restore, and dispatch.
pub fn validate_distinct_authority_domains_v1(
    receipts: &[ExternalAuthorityReceiptV1],
) -> Result<(), ExternalAuthorityError> {
    let required = [
        ExternalAuthorityKindV1::ReleaseSigner,
        ExternalAuthorityKindV1::WormCustody,
        ExternalAuthorityKindV1::BackupRestore,
        ExternalAuthorityKindV1::SubmissionDispatcher,
    ];
    for kind in required {
        if receipts
            .iter()
            .filter(|receipt| receipt.authority_kind == kind)
            .count()
            != 1
        {
            return Err(ExternalAuthorityError::AuthoritySetIncomplete);
        }
    }
    let mut domains = receipts
        .iter()
        .map(|receipt| receipt.authority_domain_id.as_str())
        .collect::<Vec<_>>();
    domains.sort_unstable();
    domains.dedup();
    if domains.len() != required.len() {
        return Err(ExternalAuthorityError::AuthorityDomainsAliased);
    }
    Ok(())
}

fn validate_hash(value: &str) -> Result<(), ExternalAuthorityError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(ExternalAuthorityError::HashInvalid);
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ExternalAuthorityError::HashInvalid);
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

/// External authority request, receipt, or verification failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ExternalAuthorityError {
    /// Request shape, identity, or deadline is invalid.
    #[error("external authority request is invalid")]
    RequestInvalid,
    /// Receipt shape, time, or binding is invalid.
    #[error("external authority receipt is invalid")]
    ReceiptInvalid,
    /// Digest is noncanonical.
    #[error("external authority hash is invalid")]
    HashInvalid,
    /// Required authority receipt is absent or duplicated.
    #[error("external authority set is incomplete")]
    AuthoritySetIncomplete,
    /// Nominally independent authorities share one domain.
    #[error("external authority domains are aliased")]
    AuthorityDomainsAliased,
    /// External signature or trust verification rejected the receipt.
    #[error("external authority verification rejected the receipt")]
    VerificationRejected,
    /// External operation result is ambiguous and requires reconciliation.
    #[error("external authority result is ambiguous")]
    ResultAmbiguous,
    /// External provider is unavailable.
    #[error("external authority is unavailable")]
    Unavailable,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(byte: char) -> String {
        format!("sha256:{}", byte.to_string().repeat(64))
    }

    fn receipt(kind: ExternalAuthorityKindV1, domain: &str) -> ExternalAuthorityReceiptV1 {
        ExternalAuthorityReceiptV1 {
            version: 1,
            authority_kind: kind,
            operation_id: "operation-1".into(),
            request_hash: hash('1'),
            result_hash: hash('2'),
            authority_domain_id: domain.into(),
            signer_key_id: "key-1".into(),
            signature_base64: "external-signature".into(),
            issued_at_unix_ms: 10,
            expires_at_unix_ms: 100,
            external_action_may_have_started: false,
        }
    }

    #[test]
    fn external_authorities_must_be_complete_and_domain_distinct() {
        let receipts = vec![
            receipt(ExternalAuthorityKindV1::ReleaseSigner, "domain-release"),
            receipt(ExternalAuthorityKindV1::WormCustody, "domain-worm"),
            receipt(ExternalAuthorityKindV1::BackupRestore, "domain-restore"),
            receipt(
                ExternalAuthorityKindV1::SubmissionDispatcher,
                "domain-dispatch",
            ),
        ];
        validate_distinct_authority_domains_v1(&receipts).expect("distinct authorities");
        let mut aliased = receipts;
        aliased[3].authority_domain_id = "domain-release".into();
        assert_eq!(
            validate_distinct_authority_domains_v1(&aliased),
            Err(ExternalAuthorityError::AuthorityDomainsAliased)
        );
    }

    #[test]
    fn repository_contract_cannot_self_verify_a_receipt() {
        struct RejectingVerifier;
        impl ExternalReceiptVerifierV1 for RejectingVerifier {
            fn verify(
                &self,
                _request: &ExternalAuthorityRequestV1,
                _receipt: &ExternalAuthorityReceiptV1,
                _now_unix_ms: u64,
            ) -> Result<(), ExternalAuthorityError> {
                Err(ExternalAuthorityError::VerificationRejected)
            }
        }
        let request = ExternalAuthorityRequestV1 {
            version: 1,
            authority_kind: ExternalAuthorityKindV1::ReleaseSigner,
            operation_id: "operation-1".into(),
            request_hash: hash('1'),
            subject_hash: hash('3'),
            nonce: "nonce-1".into(),
            deadline_unix_ms: 100,
        };
        assert_eq!(
            verify_external_receipt_v1(
                &request,
                &receipt(ExternalAuthorityKindV1::ReleaseSigner, "domain-release"),
                20,
                &RejectingVerifier,
            ),
            Err(ExternalAuthorityError::VerificationRejected)
        );
    }
}

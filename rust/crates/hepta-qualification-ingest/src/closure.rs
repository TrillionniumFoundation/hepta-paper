//! Complete external-qualification closure for one immutable production subject.
//!
//! Individual signed packages intentionally grant no activation authority. This
//! module verifies the complete seven-package set, validates every payload, checks
//! cross-package host/database identities, preserves authority-domain separation,
//! and returns an opaque closure value suitable for a later independently signed
//! writer-cutover decision.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    ExternalQualificationEnvelopeV1, QualificationIngestError, QualificationPackageIdV1,
    QualificationPayloadError, QualificationSubjectV1, QualificationTrustStoreV1,
    VerifiedExternalQualificationV1, validate_external_package_payload_v1,
    verify_external_qualification_v1,
};

const MAXIMUM_PACKAGE_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;
const MAXIMUM_CLOSURE_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
const REQUIRED_REPOSITORY: &str = "TrillionniumFoundation/hepta-paper";

/// One signed envelope and its exact canonical package payload bytes.
#[derive(Clone, Debug)]
pub struct ExternalQualificationCandidateV1 {
    /// Signed package envelope.
    pub envelope: ExternalQualificationEnvelopeV1,
    /// Canonical compact JSON bytes whose hash is signed by the envelope.
    pub payload: Vec<u8>,
}

/// Immutable repository subject shared by every package in a closure.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalQualificationClosureSubjectV1 {
    /// Canonical repository full name.
    pub repository: String,
    /// Exact forty-character Git commit.
    pub commit: String,
    /// Exact forty-character Git tree.
    pub tree: String,
}

/// Cross-package production identities established by the complete closure.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalQualificationRuntimeFactsV1 {
    /// Target host identity agreed by cgroup and destructive-storage reviews.
    pub host_identity_hash: String,
    /// Production database identity agreed by storage and cutover/soak reviews.
    pub database_identity_hash: String,
    /// Reviewed service-unit identity from the destructive-storage package.
    pub service_identity_hash: String,
    /// Authenticated Codex runtime identity from the separate-role canary package.
    pub codex_runtime_identity_hash: String,
    /// Durable writer-transfer receipt from the cutover/soak package.
    pub writer_transfer_receipt_hash: String,
}

/// Opaque, complete and cross-bound external qualification set.
///
/// This value cannot be deserialized or directly constructed outside this crate.
/// It is evidence input for a separate activation decision; it is not itself a
/// writer lease, release permit, provider credential or submission authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedExternalQualificationClosureV1 {
    subject: ExternalQualificationClosureSubjectV1,
    receipt_hash: String,
    trust_store_generation: u64,
    packages: BTreeMap<QualificationPackageIdV1, VerifiedExternalQualificationV1>,
    authority_groups: BTreeMap<String, Vec<String>>,
    runtime_facts: ExternalQualificationRuntimeFactsV1,
}

impl VerifiedExternalQualificationClosureV1 {
    /// Exact repository/commit/tree shared by every accepted package.
    #[must_use]
    pub fn subject(&self) -> &ExternalQualificationClosureSubjectV1 {
        &self.subject
    }

    /// Deterministic hash of the complete ordered closure body.
    #[must_use]
    pub fn receipt_hash(&self) -> &str {
        &self.receipt_hash
    }

    /// Monotonic external trust-store generation used for payload verification.
    #[must_use]
    pub const fn trust_store_generation(&self) -> u64 {
        self.trust_store_generation
    }

    /// Cross-package host, database, service and runtime facts.
    #[must_use]
    pub fn runtime_facts(&self) -> &ExternalQualificationRuntimeFactsV1 {
        &self.runtime_facts
    }

    /// Returns the verified package record for a closed package identifier.
    #[must_use]
    pub fn package(
        &self,
        package_id: QualificationPackageIdV1,
    ) -> Option<&VerifiedExternalQualificationV1> {
        self.packages.get(&package_id)
    }

    /// Authority domains grouped by the independent control plane they represent.
    #[must_use]
    pub fn authority_groups(&self) -> &BTreeMap<String, Vec<String>> {
        &self.authority_groups
    }
}

/// Verify all external packages and derive one opaque exact-subject closure.
pub fn verify_external_qualification_closure_v1(
    candidates: &[ExternalQualificationCandidateV1],
    subject: &ExternalQualificationClosureSubjectV1,
    now_unix_ms: u64,
    trust_store_generation: u64,
    trust_store: &QualificationTrustStoreV1,
) -> Result<VerifiedExternalQualificationClosureV1, QualificationClosureError> {
    validate_subject(subject)?;
    if trust_store_generation == 0 || candidates.len() != QualificationPackageIdV1::ALL.len() {
        return Err(QualificationClosureError::PackageSetIncomplete);
    }
    let mut total_payload_bytes = 0usize;
    let mut records = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if candidate.payload.is_empty() || candidate.payload.len() > MAXIMUM_PACKAGE_PAYLOAD_BYTES {
            return Err(QualificationClosureError::PayloadSizeInvalid);
        }
        total_payload_bytes = total_payload_bytes
            .checked_add(candidate.payload.len())
            .ok_or(QualificationClosureError::PayloadSizeInvalid)?;
        if total_payload_bytes > MAXIMUM_CLOSURE_PAYLOAD_BYTES {
            return Err(QualificationClosureError::PayloadSizeInvalid);
        }
        let package_subject = QualificationSubjectV1 {
            repository: subject.repository.clone(),
            commit: subject.commit.clone(),
            tree: subject.tree.clone(),
            package_id: candidate.envelope.package_id,
        };
        let verified = verify_external_qualification_v1(
            &candidate.envelope,
            &package_subject,
            now_unix_ms,
            trust_store,
        )?;
        if hash_bytes(&candidate.payload) != verified.payload_hash {
            return Err(QualificationClosureError::PayloadHashMismatch);
        }
        validate_external_package_payload_v1(
            &candidate.payload,
            &package_subject,
            &verified.authority_domain_id,
            &verified.signer_key_id,
            now_unix_ms,
            trust_store_generation,
            trust_store,
        )?;
        let payload: Value = serde_json::from_slice(&candidate.payload)
            .map_err(|_| QualificationClosureError::PayloadFactsInvalid)?;
        records.push((verified, payload));
    }
    assemble_verified_closure(subject, trust_store_generation, records)
}

fn assemble_verified_closure(
    subject: &ExternalQualificationClosureSubjectV1,
    trust_store_generation: u64,
    records: Vec<(VerifiedExternalQualificationV1, Value)>,
) -> Result<VerifiedExternalQualificationClosureV1, QualificationClosureError> {
    let mut by_package = BTreeMap::new();
    let mut payload_by_package = BTreeMap::new();
    let mut nonces = BTreeSet::new();
    let mut payload_hashes = BTreeSet::new();
    for (record, payload) in records {
        if !nonces.insert(record.nonce.clone()) {
            return Err(QualificationClosureError::DuplicateNonce);
        }
        if !payload_hashes.insert(record.payload_hash.clone()) {
            return Err(QualificationClosureError::DuplicatePayload);
        }
        let package = record.package_id;
        if by_package.insert(package, record).is_some()
            || payload_by_package.insert(package, payload).is_some()
        {
            return Err(QualificationClosureError::DuplicatePackage);
        }
    }
    let expected = QualificationPackageIdV1::ALL
        .into_iter()
        .collect::<BTreeSet<_>>();
    if by_package.keys().copied().collect::<BTreeSet<_>>() != expected {
        return Err(QualificationClosureError::PackageSetIncomplete);
    }

    let mut authority_groups = BTreeMap::<String, BTreeSet<String>>::new();
    let mut domain_group = BTreeMap::<String, String>::new();
    for (package, record) in &by_package {
        let group = authority_group(*package).to_owned();
        if let Some(previous) =
            domain_group.insert(record.authority_domain_id.clone(), group.clone())
            && previous != group
        {
            return Err(QualificationClosureError::AuthoritySeparationViolation);
        }
        authority_groups
            .entry(group)
            .or_default()
            .insert(record.authority_domain_id.clone());
    }
    if authority_groups.len() != 5 {
        return Err(QualificationClosureError::AuthoritySeparationViolation);
    }
    let authority_groups = authority_groups
        .into_iter()
        .map(|(group, domains)| (group, domains.into_iter().collect::<Vec<_>>()))
        .collect::<BTreeMap<_, _>>();

    let host_cgroup = payload_object(
        &payload_by_package,
        QualificationPackageIdV1::ExtHostCgroup001,
    )?;
    let host_storage = payload_object(
        &payload_by_package,
        QualificationPackageIdV1::ExtHostStorage001,
    )?;
    let codex = payload_object(
        &payload_by_package,
        QualificationPackageIdV1::ExtCodexRole001,
    )?;
    let cutover = payload_object(
        &payload_by_package,
        QualificationPackageIdV1::ExtCutoverSoak001,
    )?;
    let cgroup_host = fact(host_cgroup, "hostIdentityHash")?;
    let storage_host = fact(host_storage, "hostIdentityHash")?;
    let storage_database = fact(host_storage, "databaseIdentityHash")?;
    let cutover_database = fact(cutover, "databaseIdentityHash")?;
    if cgroup_host != storage_host || storage_database != cutover_database {
        return Err(QualificationClosureError::CrossPackageIdentityMismatch);
    }
    let runtime_facts = ExternalQualificationRuntimeFactsV1 {
        host_identity_hash: cgroup_host.to_owned(),
        database_identity_hash: storage_database.to_owned(),
        service_identity_hash: fact(host_storage, "serviceUnitHash")?.to_owned(),
        codex_runtime_identity_hash: fact(codex, "runtimeIdentityHash")?.to_owned(),
        writer_transfer_receipt_hash: fact(cutover, "writerTransferReceiptHash")?.to_owned(),
    };

    let ordered_packages = QualificationPackageIdV1::ALL
        .into_iter()
        .map(|package| {
            let record = by_package
                .get(&package)
                .ok_or(QualificationClosureError::PackageSetIncomplete)?;
            Ok(ClosurePackageBodyV1 {
                package_id: package.as_str(),
                payload_hash: &record.payload_hash,
                authority_domain_id: &record.authority_domain_id,
                signer_key_id: &record.signer_key_id,
                nonce: &record.nonce,
                signing_message_hash: &record.signing_message_hash,
            })
        })
        .collect::<Result<Vec<_>, QualificationClosureError>>()?;
    let body = ClosureBodyV1 {
        version: 1,
        kind: "VerifiedExternalQualificationClosureV1",
        subject,
        trust_store_generation,
        packages: ordered_packages,
        authority_groups: &authority_groups,
        runtime_facts: &runtime_facts,
        automatic_activation: false,
        production_activation: false,
    };
    let receipt_hash = hash_bytes(
        &serde_json::to_vec(&body).map_err(|_| QualificationClosureError::EncodingInvalid)?,
    );
    Ok(VerifiedExternalQualificationClosureV1 {
        subject: subject.clone(),
        receipt_hash,
        trust_store_generation,
        packages: by_package,
        authority_groups,
        runtime_facts,
    })
}

fn validate_subject(
    subject: &ExternalQualificationClosureSubjectV1,
) -> Result<(), QualificationClosureError> {
    if subject.repository != REQUIRED_REPOSITORY
        || !valid_git_hash(&subject.commit)
        || !valid_git_hash(&subject.tree)
    {
        return Err(QualificationClosureError::SubjectInvalid);
    }
    Ok(())
}

fn payload_object(
    values: &BTreeMap<QualificationPackageIdV1, Value>,
    package: QualificationPackageIdV1,
) -> Result<&serde_json::Map<String, Value>, QualificationClosureError> {
    values
        .get(&package)
        .and_then(Value::as_object)
        .ok_or(QualificationClosureError::PayloadFactsInvalid)
}

fn fact<'a>(
    value: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, QualificationClosureError> {
    let value = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(QualificationClosureError::PayloadFactsInvalid)?;
    if !valid_sha256(value) {
        return Err(QualificationClosureError::PayloadFactsInvalid);
    }
    Ok(value)
}

const fn authority_group(package: QualificationPackageIdV1) -> &'static str {
    match package {
        QualificationPackageIdV1::ExtGovMain001 => "governance",
        QualificationPackageIdV1::ExtHostCgroup001
        | QualificationPackageIdV1::ExtHostStorage001 => "target_host",
        QualificationPackageIdV1::ExtKeyOwner001 => "key_owner",
        QualificationPackageIdV1::ExtCodexRole001 => "codex_account",
        QualificationPackageIdV1::ExtCutoverSoak001
        | QualificationPackageIdV1::ExtAuthoritySet001 => "release_and_cutover",
    }
}

fn valid_git_hash(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn hash_bytes(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosureBodyV1<'a> {
    version: u16,
    kind: &'static str,
    subject: &'a ExternalQualificationClosureSubjectV1,
    trust_store_generation: u64,
    packages: Vec<ClosurePackageBodyV1<'a>>,
    authority_groups: &'a BTreeMap<String, Vec<String>>,
    runtime_facts: &'a ExternalQualificationRuntimeFactsV1,
    automatic_activation: bool,
    production_activation: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosurePackageBodyV1<'a> {
    package_id: &'static str,
    payload_hash: &'a str,
    authority_domain_id: &'a str,
    signer_key_id: &'a str,
    nonce: &'a str,
    signing_message_hash: &'a str,
}

/// Complete-set, payload, authority-separation or cross-identity rejection.
#[derive(Debug, Error)]
pub enum QualificationClosureError {
    /// Repository, commit or tree is malformed or not the supported repository.
    #[error("external qualification closure subject is invalid")]
    SubjectInvalid,
    /// The set does not contain every required package exactly once.
    #[error("external qualification package set is incomplete")]
    PackageSetIncomplete,
    /// One package appears more than once.
    #[error("external qualification package appears more than once")]
    DuplicatePackage,
    /// A replay nonce appears more than once.
    #[error("external qualification nonce appears more than once")]
    DuplicateNonce,
    /// A payload digest appears more than once.
    #[error("external qualification payload appears more than once")]
    DuplicatePayload,
    /// Package bytes violate per-package or aggregate bounds.
    #[error("external qualification payload size is invalid")]
    PayloadSizeInvalid,
    /// Payload bytes do not match the envelope's signed digest.
    #[error("external qualification payload hash mismatch")]
    PayloadHashMismatch,
    /// Required facts could not be extracted from a validated payload.
    #[error("external qualification payload facts are invalid")]
    PayloadFactsInvalid,
    /// Host/database identities disagree across independent packages.
    #[error("external qualification cross-package identity mismatch")]
    CrossPackageIdentityMismatch,
    /// One authority domain was reused across independent control groups.
    #[error("external qualification authority separation violated")]
    AuthoritySeparationViolation,
    /// Deterministic closure receipt encoding failed.
    #[error("external qualification closure encoding failed")]
    EncodingInvalid,
    /// Envelope, trust, subject, time or signature verification failed.
    #[error(transparent)]
    Ingest(#[from] QualificationIngestError),
    /// Package-specific canonical semantics or nested signatures failed.
    #[error(transparent)]
    Payload(#[from] QualificationPayloadError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(
        package_id: QualificationPackageIdV1,
        domain: &str,
        index: usize,
    ) -> VerifiedExternalQualificationV1 {
        VerifiedExternalQualificationV1 {
            package_id,
            payload_hash: format!("sha256:{:064x}", index + 1),
            authority_domain_id: domain.to_owned(),
            signer_key_id: format!("key-{index}"),
            nonce: format!("nonce-{index}"),
            signing_message_hash: format!("sha256:{:064x}", index + 100),
        }
    }

    fn facts_payload(package: QualificationPackageIdV1) -> Value {
        match package {
            QualificationPackageIdV1::ExtHostCgroup001 => json!({
                "hostIdentityHash": format!("sha256:{}", "1".repeat(64))
            }),
            QualificationPackageIdV1::ExtHostStorage001 => json!({
                "hostIdentityHash": format!("sha256:{}", "1".repeat(64)),
                "databaseIdentityHash": format!("sha256:{}", "2".repeat(64)),
                "serviceUnitHash": format!("sha256:{}", "3".repeat(64))
            }),
            QualificationPackageIdV1::ExtCodexRole001 => json!({
                "runtimeIdentityHash": format!("sha256:{}", "4".repeat(64))
            }),
            QualificationPackageIdV1::ExtCutoverSoak001 => json!({
                "databaseIdentityHash": format!("sha256:{}", "2".repeat(64)),
                "writerTransferReceiptHash": format!("sha256:{}", "5".repeat(64))
            }),
            _ => json!({}),
        }
    }

    fn complete_records() -> Vec<(VerifiedExternalQualificationV1, Value)> {
        let domains = [
            "governance-review",
            "host-review",
            "host-review",
            "key-review",
            "codex-review",
            "release-review",
            "release-review",
        ];
        QualificationPackageIdV1::ALL
            .into_iter()
            .enumerate()
            .map(|(index, package)| {
                (
                    record(package, domains[index], index),
                    facts_payload(package),
                )
            })
            .collect()
    }

    fn subject() -> ExternalQualificationClosureSubjectV1 {
        ExternalQualificationClosureSubjectV1 {
            repository: REQUIRED_REPOSITORY.into(),
            commit: "a".repeat(40),
            tree: "b".repeat(40),
        }
    }

    #[test]
    fn complete_set_derives_cross_bound_opaque_receipt() {
        let verified = assemble_verified_closure(&subject(), 7, complete_records())
            .expect("complete closure");
        assert_eq!(verified.packages.len(), 7);
        assert_eq!(verified.authority_groups.len(), 5);
        assert_eq!(verified.trust_store_generation(), 7);
        assert_eq!(
            verified.runtime_facts().host_identity_hash,
            format!("sha256:{}", "1".repeat(64))
        );
        assert!(valid_sha256(verified.receipt_hash()));
        let repeated = assemble_verified_closure(&subject(), 7, complete_records())
            .expect("repeat closure");
        assert_eq!(verified.receipt_hash(), repeated.receipt_hash());
    }

    #[test]
    fn closure_rejects_incomplete_duplicate_and_collapsed_authority_sets() {
        let mut incomplete = complete_records();
        incomplete.pop();
        assert!(matches!(
            assemble_verified_closure(&subject(), 1, incomplete),
            Err(QualificationClosureError::PackageSetIncomplete)
        ));

        let mut duplicate = complete_records();
        duplicate[1].0.nonce = duplicate[0].0.nonce.clone();
        assert!(matches!(
            assemble_verified_closure(&subject(), 1, duplicate),
            Err(QualificationClosureError::DuplicateNonce)
        ));

        let mut collapsed = complete_records();
        collapsed[3].0.authority_domain_id = "governance-review".into();
        assert!(matches!(
            assemble_verified_closure(&subject(), 1, collapsed),
            Err(QualificationClosureError::AuthoritySeparationViolation)
        ));
    }

    #[test]
    fn closure_rejects_cross_package_host_or_database_drift() {
        let mut records = complete_records();
        records[2].1["hostIdentityHash"] =
            Value::String(format!("sha256:{}", "9".repeat(64)));
        assert!(matches!(
            assemble_verified_closure(&subject(), 1, records),
            Err(QualificationClosureError::CrossPackageIdentityMismatch)
        ));
    }
}

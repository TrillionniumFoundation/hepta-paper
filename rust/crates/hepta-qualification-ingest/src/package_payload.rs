use std::{cmp::Ordering, collections::BTreeSet};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::Signature;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    QualificationPackageIdV1, QualificationSubjectV1, QualificationTrustStoreV1, valid_git_hash,
};

const REQUIRED_REPOSITORY_ID: u64 = 1_349_108_143;
const REQUIRED_GOVERNANCE_DENIALS: [&str; 7] = [
    "direct_push",
    "stale_approval",
    "missing_check",
    "failed_check",
    "force_push",
    "branch_deletion",
    "administrator_bypass",
];
const REQUIRED_HOST_CGROUP_DRILLS: [&str; 9] = [
    "listenerLifecycle",
    "schemaSubstitution",
    "durablePreExec",
    "setsidEscape",
    "doubleForkEscape",
    "cgroupKill",
    "serviceCrashRecovery",
    "hostRebootRecovery",
    "providerStartBeforeReleaseDenied",
];
const REQUIRED_STORAGE_FAULTS: [&str; 14] = [
    "sigkillBoundaries",
    "serviceRestart",
    "hostReboot",
    "diskFull",
    "quotaExhaustion",
    "writeFsyncFailure",
    "readOnlyRemount",
    "walTruncation",
    "shmTruncation",
    "mainPageCorruption",
    "staleSidecar",
    "backupRestore",
    "foreignBackupRejection",
    "clockRegression",
];
const REQUIRED_KEY_DRILLS: [&str; 8] = [
    "overlapRotation",
    "activeKeyRevocation",
    "signedRollbackRejection",
    "interruptedPublication",
    "requestSignerCompromise",
    "bundleSignerCompromise",
    "allActiveKeysRemoved",
    "emergencyAdmissionStop",
];
const REQUIRED_AUTHORITY_KINDS: [&str; 4] = [
    "release_signer",
    "worm_custody",
    "backup_restore",
    "submission_dispatcher",
];

/// External payload syntax, exact-subject, decision, authority or semantic rejection.
#[derive(Debug, Error)]
pub enum QualificationPayloadError {
    /// JSON is malformed or not in canonical compact form.
    #[error("external qualification payload encoding is invalid")]
    EncodingInvalid,
    /// The payload field vocabulary or field type is invalid.
    #[error("external qualification payload schema is invalid")]
    SchemaInvalid,
    /// The payload does not bind the exact repository, commit, tree and package.
    #[error("external qualification payload subject binding is invalid")]
    SubjectMismatch,
    /// The package-specific decision is not approved.
    #[error("external qualification payload was not approved")]
    DecisionNotApproved,
    /// The package reviewer does not match the signed envelope or is not independent.
    #[error("external qualification payload authority separation is invalid")]
    AuthorityMismatch,
    /// A nested external authority signature is malformed, unknown, or invalid.
    #[error("external qualification payload authority signature is invalid")]
    SignatureInvalid,
    /// A mandatory package-specific success invariant is absent.
    #[error("external qualification payload semantic invariant is invalid")]
    SemanticInvalid,
}

/// Validates canonical package payload bytes before aggregate acceptance.
///
/// This is intentionally stricter than merely hashing a caller-described payload:
/// each package must bind the exact subject, carry an approved independent decision,
/// and satisfy the closed success vocabulary for its governance or runtime domain.
pub fn validate_external_package_payload_v1(
    bytes: &[u8],
    subject: &QualificationSubjectV1,
    envelope_authority_domain: &str,
    envelope_signer_key_id: &str,
    verifier_now_unix_ms: u64,
    trust_generation: u64,
    trust_store: &QualificationTrustStoreV1,
) -> Result<(), QualificationPayloadError> {
    validate_external_package_payload_shape_v1(
        bytes,
        subject,
        envelope_authority_domain,
        envelope_signer_key_id,
    )?;
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| QualificationPayloadError::EncodingInvalid)?;
    let root = object(&value)?;
    current_time_window(root, verifier_now_unix_ms)?;
    if subject.package_id == QualificationPackageIdV1::ExtAuthoritySet001 {
        validate_authority_set_crypto_v1(
            root,
            subject,
            envelope_authority_domain,
            envelope_signer_key_id,
            verifier_now_unix_ms,
            trust_generation,
            trust_store,
        )?;
    }
    Ok(())
}

fn validate_external_package_payload_shape_v1(
    bytes: &[u8],
    subject: &QualificationSubjectV1,
    envelope_authority_domain: &str,
    envelope_signer_key_id: &str,
) -> Result<(), QualificationPayloadError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| QualificationPayloadError::EncodingInvalid)?;
    let canonical =
        serde_json::to_vec(&value).map_err(|_| QualificationPayloadError::EncodingInvalid)?;
    if canonical != bytes {
        return Err(QualificationPayloadError::EncodingInvalid);
    }
    let root = object(&value)?;
    match subject.package_id {
        QualificationPackageIdV1::ExtGovMain001 => validate_governance(
            root,
            subject,
            envelope_authority_domain,
            envelope_signer_key_id,
        ),
        QualificationPackageIdV1::ExtHostCgroup001 => validate_host_cgroup(
            root,
            subject,
            envelope_authority_domain,
            envelope_signer_key_id,
        ),
        QualificationPackageIdV1::ExtHostStorage001 => validate_host_storage(
            root,
            subject,
            envelope_authority_domain,
            envelope_signer_key_id,
        ),
        QualificationPackageIdV1::ExtKeyOwner001 => validate_key_owner(
            root,
            subject,
            envelope_authority_domain,
            envelope_signer_key_id,
        ),
        QualificationPackageIdV1::ExtCodexRole001 => validate_codex_role(
            root,
            subject,
            envelope_authority_domain,
            envelope_signer_key_id,
        ),
        QualificationPackageIdV1::ExtCutoverSoak001 => validate_cutover(
            root,
            subject,
            envelope_authority_domain,
            envelope_signer_key_id,
        ),
        QualificationPackageIdV1::ExtAuthoritySet001 => validate_authority_set(
            root,
            subject,
            envelope_authority_domain,
            envelope_signer_key_id,
        ),
    }
}

fn validate_governance(
    root: &Map<String, Value>,
    subject: &QualificationSubjectV1,
    envelope_domain: &str,
    envelope_key: &str,
) -> Result<(), QualificationPayloadError> {
    exact_keys(
        root,
        &[
            "schemaVersion",
            "packageId",
            "repository",
            "repositoryId",
            "targetRef",
            "sourceCommit",
            "sourceTree",
            "ruleset",
            "rulesetExportSha256",
            "requiredChecks",
            "pullRequestPolicy",
            "referencePolicy",
            "denialTests",
            "administratorAuthorityDomain",
            "reviewerAuthorityDomain",
            "authoritySeparationSha256",
            "reviewerKeyId",
            "issuedAt",
            "expiresAt",
            "decision",
            "signatureBase64",
        ],
    )?;
    common_subject(root, subject, "sourceCommit", "sourceTree")?;
    if unsigned(root, "repositoryId")? != REQUIRED_REPOSITORY_ID
        || string(root, "targetRef")? != "refs/heads/main"
    {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    sha256(root, "rulesetExportSha256")?;
    sha256(root, "authoritySeparationSha256")?;
    approved(root)?;
    time_window(root)?;
    signature_field(root, "signatureBase64")?;

    let ruleset = object(field(root, "ruleset")?)?;
    exact_keys(ruleset, &["id", "name", "enforcement", "bypassActors"])?;
    if unsigned(ruleset, "id")? == 0
        || !valid_name(string(ruleset, "name")?)
        || string(ruleset, "enforcement")? != "active"
        || !array(ruleset, "bypassActors")?.is_empty()
    {
        return Err(QualificationPayloadError::SemanticInvalid);
    }

    let checks = array(root, "requiredChecks")?;
    if checks.len() < 10 {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    unique_strings(checks, valid_check_name)?;

    let policy = object(field(root, "pullRequestPolicy")?)?;
    exact_keys(
        policy,
        &[
            "requiredApprovingReviewCount",
            "requireCodeOwnerReview",
            "dismissStaleReviews",
            "requireLastPushApproval",
            "requireConversationResolution",
        ],
    )?;
    if unsigned(policy, "requiredApprovingReviewCount")? == 0
        || !boolean(policy, "requireCodeOwnerReview")?
        || !boolean(policy, "dismissStaleReviews")?
        || !boolean(policy, "requireLastPushApproval")?
        || !boolean(policy, "requireConversationResolution")?
    {
        return Err(QualificationPayloadError::SemanticInvalid);
    }

    let reference = object(field(root, "referencePolicy")?)?;
    exact_keys(
        reference,
        &[
            "blockForcePush",
            "blockDeletion",
            "requirePullRequest",
            "signedCommitMode",
            "historyMode",
        ],
    )?;
    if !boolean(reference, "blockForcePush")?
        || !boolean(reference, "blockDeletion")?
        || !boolean(reference, "requirePullRequest")?
        || !matches!(
            string(reference, "signedCommitMode")?,
            "required" | "verified-github-merge"
        )
        || !matches!(
            string(reference, "historyMode")?,
            "linear" | "documented-merge-only"
        )
    {
        return Err(QualificationPayloadError::SemanticInvalid);
    }

    let mut denial_kinds = BTreeSet::new();
    let denials = array(root, "denialTests")?;
    if denials.len() != REQUIRED_GOVERNANCE_DENIALS.len() {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    for denial in denials {
        let denial = object(denial)?;
        exact_keys(denial, &["kind", "result", "evidenceSha256", "observedAt"])?;
        let kind = string(denial, "kind")?;
        if !REQUIRED_GOVERNANCE_DENIALS.contains(&kind)
            || !denial_kinds.insert(kind)
            || string(denial, "result")? != "denied"
        {
            return Err(QualificationPayloadError::SemanticInvalid);
        }
        sha256(denial, "evidenceSha256")?;
        timestamp(denial, "observedAt")?;
    }

    let administrator = identifier(root, "administratorAuthorityDomain")?;
    let reviewer = identifier(root, "reviewerAuthorityDomain")?;
    let reviewer_key = identifier(root, "reviewerKeyId")?;
    reviewer_matches(
        administrator,
        reviewer,
        reviewer_key,
        envelope_domain,
        envelope_key,
    )
}

fn validate_host_cgroup(
    root: &Map<String, Value>,
    subject: &QualificationSubjectV1,
    envelope_domain: &str,
    envelope_key: &str,
) -> Result<(), QualificationPayloadError> {
    exact_keys(
        root,
        &[
            "schemaVersion",
            "packageId",
            "repository",
            "commit",
            "tree",
            "hostIdentityHash",
            "bootIdentityHash",
            "kernelIdentityHash",
            "systemdIdentityHash",
            "cgroupIdentityHash",
            "listenerIdentityHash",
            "schemaIdentityHash",
            "gateIdentityHash",
            "journalIdentityHash",
            "drills",
            "operatorAuthorityDomain",
            "reviewerAuthorityDomain",
            "reviewerKeyId",
            "reviewedObjects",
            "kernelAssumptions",
            "findings",
            "decision",
            "issuedAt",
            "expiresAt",
            "signatureBase64",
        ],
    )?;
    common_subject(root, subject, "commit", "tree")?;
    for key in [
        "hostIdentityHash",
        "bootIdentityHash",
        "kernelIdentityHash",
        "systemdIdentityHash",
        "cgroupIdentityHash",
        "listenerIdentityHash",
        "schemaIdentityHash",
        "gateIdentityHash",
        "journalIdentityHash",
    ] {
        sha256(root, key)?;
    }
    exact_pass_map(root, "drills", &REQUIRED_HOST_CGROUP_DRILLS)?;
    reviewed_objects(root)?;
    nonempty_unique_strings(root, "kernelAssumptions")?;
    closed_findings(root)?;
    approved(root)?;
    time_window(root)?;
    signature_field(root, "signatureBase64")?;
    reviewer_matches(
        identifier(root, "operatorAuthorityDomain")?,
        identifier(root, "reviewerAuthorityDomain")?,
        identifier(root, "reviewerKeyId")?,
        envelope_domain,
        envelope_key,
    )
}

fn validate_host_storage(
    root: &Map<String, Value>,
    subject: &QualificationSubjectV1,
    envelope_domain: &str,
    envelope_key: &str,
) -> Result<(), QualificationPayloadError> {
    exact_keys(
        root,
        &[
            "schemaVersion",
            "packageId",
            "repository",
            "commit",
            "tree",
            "hostIdentityHash",
            "bootSequenceHash",
            "filesystemIdentityHash",
            "mountIdentityHash",
            "blockDeviceIdentityHash",
            "databaseIdentityHash",
            "walIdentityHash",
            "shmIdentityHash",
            "artifactManifestHash",
            "serviceUnitHash",
            "rawEvidenceManifestHash",
            "faultMatrix",
            "operationCount",
            "continuousSoakSeconds",
            "staleCommitCount",
            "duplicateProviderCallCount",
            "duplicateIntegrationCount",
            "unclassifiedRecoveryCount",
            "operatorAuthorityDomain",
            "reviewerAuthorityDomain",
            "reviewerKeyId",
            "findings",
            "decision",
            "issuedAt",
            "expiresAt",
            "signatureBase64",
        ],
    )?;
    common_subject(root, subject, "commit", "tree")?;
    for key in [
        "hostIdentityHash",
        "bootSequenceHash",
        "filesystemIdentityHash",
        "mountIdentityHash",
        "blockDeviceIdentityHash",
        "databaseIdentityHash",
        "walIdentityHash",
        "shmIdentityHash",
        "artifactManifestHash",
        "serviceUnitHash",
        "rawEvidenceManifestHash",
    ] {
        sha256(root, key)?;
    }
    exact_pass_map(root, "faultMatrix", &REQUIRED_STORAGE_FAULTS)?;
    if unsigned(root, "operationCount")? < 10_000
        || unsigned(root, "continuousSoakSeconds")? < 259_200
    {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    zero_fields(
        root,
        &[
            "staleCommitCount",
            "duplicateProviderCallCount",
            "duplicateIntegrationCount",
            "unclassifiedRecoveryCount",
        ],
    )?;
    closed_findings(root)?;
    approved(root)?;
    time_window(root)?;
    signature_field(root, "signatureBase64")?;
    reviewer_matches(
        identifier(root, "operatorAuthorityDomain")?,
        identifier(root, "reviewerAuthorityDomain")?,
        identifier(root, "reviewerKeyId")?,
        envelope_domain,
        envelope_key,
    )
}

fn validate_key_owner(
    root: &Map<String, Value>,
    subject: &QualificationSubjectV1,
    envelope_domain: &str,
    envelope_key: &str,
) -> Result<(), QualificationPayloadError> {
    exact_keys(
        root,
        &[
            "schemaVersion",
            "packageId",
            "repository",
            "commit",
            "tree",
            "authorityDomainId",
            "authorityKeyId",
            "reviewerAuthorityDomain",
            "reviewerKeyId",
            "initialGeneration",
            "finalGeneration",
            "initialBundleHash",
            "finalBundleHash",
            "drills",
            "privateKeyAbsentFromBroker",
            "brokerAdmissionDisabledOnAmbiguity",
            "decision",
            "issuedAt",
            "expiresAt",
            "signatureBase64",
        ],
    )?;
    common_subject(root, subject, "commit", "tree")?;
    identifier(root, "authorityKeyId")?;
    sha256(root, "initialBundleHash")?;
    sha256(root, "finalBundleHash")?;
    let initial = unsigned(root, "initialGeneration")?;
    let final_generation = unsigned(root, "finalGeneration")?;
    if initial == 0
        || final_generation <= initial
        || string(root, "initialBundleHash")? == string(root, "finalBundleHash")?
        || !boolean(root, "privateKeyAbsentFromBroker")?
        || !boolean(root, "brokerAdmissionDisabledOnAmbiguity")?
    {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    let drills = object(field(root, "drills")?)?;
    exact_keys(drills, &REQUIRED_KEY_DRILLS)?;
    for name in REQUIRED_KEY_DRILLS {
        let drill = object(field(drills, name)?)?;
        exact_keys(drill, &["result", "evidenceHash", "notesHash"])?;
        if string(drill, "result")? != "passed" {
            return Err(QualificationPayloadError::SemanticInvalid);
        }
        sha256(drill, "evidenceHash")?;
        sha256(drill, "notesHash")?;
    }
    approved(root)?;
    time_window(root)?;
    signature_field(root, "signatureBase64")?;
    reviewer_matches(
        identifier(root, "authorityDomainId")?,
        identifier(root, "reviewerAuthorityDomain")?,
        identifier(root, "reviewerKeyId")?,
        envelope_domain,
        envelope_key,
    )
}

fn validate_codex_role(
    root: &Map<String, Value>,
    subject: &QualificationSubjectV1,
    envelope_domain: &str,
    envelope_key: &str,
) -> Result<(), QualificationPayloadError> {
    exact_keys(
        root,
        &[
            "schemaVersion",
            "packageId",
            "repository",
            "commit",
            "tree",
            "runtimeIdentityHash",
            "providerAccountAuthorityDomain",
            "providerAccountKeyId",
            "roles",
            "crossRoleAccessDenied",
            "campaignDatabaseAccessDenied",
            "externalAuthorityCredentialAccessDenied",
            "providerInitializationBeforeReleaseCount",
            "unauthorizedNetworkAttemptCount",
            "preparedResultRecoveryWithoutSecondProviderCall",
            "promptOrManuscriptContentRetained",
            "reviewerAuthorityDomain",
            "reviewerKeyId",
            "decision",
            "issuedAt",
            "expiresAt",
            "signatureBase64",
        ],
    )?;
    common_subject(root, subject, "commit", "tree")?;
    sha256(root, "runtimeIdentityHash")?;
    identifier(root, "providerAccountKeyId")?;
    if !boolean(root, "crossRoleAccessDenied")?
        || !boolean(root, "campaignDatabaseAccessDenied")?
        || !boolean(root, "externalAuthorityCredentialAccessDenied")?
        || unsigned(root, "providerInitializationBeforeReleaseCount")? != 0
        || unsigned(root, "unauthorizedNetworkAttemptCount")? != 0
        || !boolean(root, "preparedResultRecoveryWithoutSecondProviderCall")?
        || boolean(root, "promptOrManuscriptContentRetained")?
    {
        return Err(QualificationPayloadError::SemanticInvalid);
    }

    let roles = array(root, "roles")?;
    if !(2..=4).contains(&roles.len()) {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    let mut names = BTreeSet::new();
    let mut uids = BTreeSet::new();
    let mut gids = BTreeSet::new();
    let mut homes = BTreeSet::new();
    let mut sockets = BTreeSet::new();
    let mut journals = BTreeSet::new();
    let mut schemas = BTreeSet::new();
    let mut audiences = BTreeSet::new();
    for role in roles {
        let role = object(role)?;
        exact_keys(
            role,
            &[
                "role",
                "uid",
                "gid",
                "homeIdentityHash",
                "socketIdentityHash",
                "journalIdentityHash",
                "schemaIdentityHash",
                "capabilityAudienceHash",
                "authenticated",
                "boundedCompletion",
                "environmentDisclosureDenied",
                "unexpectedFdDisclosureDenied",
                "receiptHash",
            ],
        )?;
        let name = string(role, "role")?;
        if !matches!(name, "author" | "reviewer" | "formal_reviewer" | "repairer")
            || !names.insert(name)
            || !uids.insert(unsigned(role, "uid")?)
            || !gids.insert(unsigned(role, "gid")?)
        {
            return Err(QualificationPayloadError::SemanticInvalid);
        }
        let home = sha256(role, "homeIdentityHash")?;
        let socket = sha256(role, "socketIdentityHash")?;
        let journal = sha256(role, "journalIdentityHash")?;
        let schema = sha256(role, "schemaIdentityHash")?;
        let audience = sha256(role, "capabilityAudienceHash")?;
        sha256(role, "receiptHash")?;
        if !homes.insert(home)
            || !sockets.insert(socket)
            || !journals.insert(journal)
            || !schemas.insert(schema)
            || !audiences.insert(audience)
            || !boolean(role, "authenticated")?
            || !boolean(role, "boundedCompletion")?
            || !boolean(role, "environmentDisclosureDenied")?
            || !boolean(role, "unexpectedFdDisclosureDenied")?
        {
            return Err(QualificationPayloadError::SemanticInvalid);
        }
    }
    if !names.contains("author") || !names.contains("reviewer") {
        return Err(QualificationPayloadError::SemanticInvalid);
    }

    approved(root)?;
    time_window(root)?;
    signature_field(root, "signatureBase64")?;
    reviewer_matches(
        identifier(root, "providerAccountAuthorityDomain")?,
        identifier(root, "reviewerAuthorityDomain")?,
        identifier(root, "reviewerKeyId")?,
        envelope_domain,
        envelope_key,
    )
}

fn validate_cutover(
    root: &Map<String, Value>,
    subject: &QualificationSubjectV1,
    envelope_domain: &str,
    envelope_key: &str,
) -> Result<(), QualificationPayloadError> {
    exact_keys(
        root,
        &[
            "schemaVersion",
            "packageId",
            "repository",
            "commit",
            "tree",
            "databaseIdentityHash",
            "schemaVersionObserved",
            "oldWriterIdentity",
            "newWriterIdentity",
            "backupReceiptHash",
            "restoreReceiptHash",
            "logicalParityReceiptHash",
            "writerTransferReceiptHash",
            "oldWorkersStopped",
            "oldLeasesCleared",
            "dualWriterObserved",
            "rollbackDrillPassed",
            "terminalResumeDrillPassed",
            "operationCount",
            "continuousSoakSeconds",
            "staleCommitCount",
            "duplicateIntegrationCount",
            "unexplainedSettlementCount",
            "unclassifiedRecoveryCount",
            "operatorAuthorityDomain",
            "observerAuthorityDomain",
            "observerKeyId",
            "decision",
            "issuedAt",
            "expiresAt",
            "signatureBase64",
        ],
    )?;
    common_subject(root, subject, "commit", "tree")?;
    for key in [
        "databaseIdentityHash",
        "backupReceiptHash",
        "restoreReceiptHash",
        "logicalParityReceiptHash",
        "writerTransferReceiptHash",
    ] {
        sha256(root, key)?;
    }
    let old_writer = identifier(root, "oldWriterIdentity")?;
    let new_writer = identifier(root, "newWriterIdentity")?;
    if unsigned(root, "schemaVersionObserved")? != 25
        || old_writer == new_writer
        || !boolean(root, "oldWorkersStopped")?
        || !boolean(root, "oldLeasesCleared")?
        || boolean(root, "dualWriterObserved")?
        || !boolean(root, "rollbackDrillPassed")?
        || !boolean(root, "terminalResumeDrillPassed")?
        || unsigned(root, "operationCount")? < 10_000
        || unsigned(root, "continuousSoakSeconds")? < 259_200
    {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    zero_fields(
        root,
        &[
            "staleCommitCount",
            "duplicateIntegrationCount",
            "unexplainedSettlementCount",
            "unclassifiedRecoveryCount",
        ],
    )?;
    approved(root)?;
    time_window(root)?;
    signature_field(root, "signatureBase64")?;
    reviewer_matches(
        identifier(root, "operatorAuthorityDomain")?,
        identifier(root, "observerAuthorityDomain")?,
        identifier(root, "observerKeyId")?,
        envelope_domain,
        envelope_key,
    )
}

fn validate_authority_set(
    root: &Map<String, Value>,
    subject: &QualificationSubjectV1,
    envelope_domain: &str,
    envelope_key: &str,
) -> Result<(), QualificationPayloadError> {
    exact_keys(
        root,
        &[
            "schemaVersion",
            "packageId",
            "repository",
            "commit",
            "tree",
            "subjectHash",
            "receipts",
            "authorityDomainsDistinct",
            "repositoryOrLocalFixtureAuthorityCount",
            "reviewerAuthorityDomain",
            "reviewerKeyId",
            "decision",
            "issuedAt",
            "expiresAt",
            "setSignatureBase64",
        ],
    )?;
    common_subject(root, subject, "commit", "tree")?;
    sha256(root, "subjectHash")?;
    if !boolean(root, "authorityDomainsDistinct")?
        || unsigned(root, "repositoryOrLocalFixtureAuthorityCount")? != 0
    {
        return Err(QualificationPayloadError::SemanticInvalid);
    }

    let receipts = array(root, "receipts")?;
    if receipts.len() != REQUIRED_AUTHORITY_KINDS.len() {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    let mut kinds = BTreeSet::new();
    let mut domains = BTreeSet::new();
    let mut operations = BTreeSet::new();
    let mut nonces = BTreeSet::new();
    for receipt in receipts {
        let receipt = object(receipt)?;
        exact_keys(
            receipt,
            &[
                "authorityKind",
                "authorityDomainId",
                "operationId",
                "requestHash",
                "resultHash",
                "outcome",
                "nonce",
                "issuedAt",
                "expiresAt",
                "signerKeyId",
                "trustGeneration",
                "externalActionMayHaveStarted",
                "signatureBase64",
            ],
        )?;
        let kind = string(receipt, "authorityKind")?;
        let domain = identifier(receipt, "authorityDomainId")?;
        let operation = identifier(receipt, "operationId")?;
        let nonce = identifier(receipt, "nonce")?;
        if !REQUIRED_AUTHORITY_KINDS.contains(&kind)
            || !kinds.insert(kind)
            || !domains.insert(domain)
            || !operations.insert(operation)
            || !nonces.insert(nonce)
            || string(receipt, "outcome")? != "succeeded"
            || unsigned(receipt, "trustGeneration")? == 0
        {
            return Err(QualificationPayloadError::SemanticInvalid);
        }
        sha256(receipt, "requestHash")?;
        sha256(receipt, "resultHash")?;
        identifier(receipt, "signerKeyId")?;
        boolean(receipt, "externalActionMayHaveStarted")?;
        time_window(receipt)?;
        signature_field(receipt, "signatureBase64")?;
    }
    let expected_kinds = REQUIRED_AUTHORITY_KINDS
        .into_iter()
        .collect::<BTreeSet<_>>();
    if kinds != expected_kinds {
        return Err(QualificationPayloadError::SemanticInvalid);
    }

    approved(root)?;
    time_window(root)?;
    signature_field(root, "setSignatureBase64")?;
    let reviewer = identifier(root, "reviewerAuthorityDomain")?;
    let reviewer_key = identifier(root, "reviewerKeyId")?;
    if domains.contains(reviewer) || reviewer != envelope_domain || reviewer_key != envelope_key {
        return Err(QualificationPayloadError::AuthorityMismatch);
    }
    Ok(())
}

fn validate_authority_set_crypto_v1(
    root: &Map<String, Value>,
    subject: &QualificationSubjectV1,
    envelope_domain: &str,
    envelope_key: &str,
    verifier_now_unix_ms: u64,
    trust_generation: u64,
    trust_store: &QualificationTrustStoreV1,
) -> Result<(), QualificationPayloadError> {
    if trust_generation == 0 {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    let expected_subject_hash = authority_set_subject_hash_v1(subject)?;
    let subject_hash = sha256(root, "subjectHash")?;
    if subject_hash != expected_subject_hash {
        return Err(QualificationPayloadError::SubjectMismatch);
    }
    let (set_issued, _) = current_time_window(root, verifier_now_unix_ms)?;

    for receipt_value in array(root, "receipts")? {
        let receipt = object(receipt_value)?;
        if unsigned(receipt, "trustGeneration")? != trust_generation {
            return Err(QualificationPayloadError::SemanticInvalid);
        }
        let (receipt_issued, receipt_expires) = current_time_window(receipt, verifier_now_unix_ms)?;
        if compare_timestamps(&receipt_issued, &set_issued) == Ordering::Greater
            || compare_timestamps(&set_issued, &receipt_expires) != Ordering::Less
        {
            return Err(QualificationPayloadError::SemanticInvalid);
        }
        let authority_domain = identifier(receipt, "authorityDomainId")?;
        let signer_key = identifier(receipt, "signerKeyId")?;
        let message = authority_receipt_signing_bytes_v1(subject_hash, receipt_value)?;
        verify_authority_signature_v1(
            trust_store,
            authority_domain,
            signer_key,
            &message,
            signature_field(receipt, "signatureBase64")?,
        )?;
    }

    let payload = Value::Object(root.clone());
    let message = authority_set_signing_bytes_v1(subject_hash, &payload)?;
    verify_authority_signature_v1(
        trust_store,
        envelope_domain,
        envelope_key,
        &message,
        signature_field(root, "setSignatureBase64")?,
    )
}

/// Computes the exact candidate hash bound into `EXT-AUTHORITY-SET-001`.
pub fn authority_set_subject_hash_v1(
    subject: &QualificationSubjectV1,
) -> Result<String, QualificationPayloadError> {
    if subject.package_id != QualificationPackageIdV1::ExtAuthoritySet001
        || subject.repository != "TrillionniumFoundation/hepta-paper"
        || !valid_git_hash(&subject.commit)
        || !valid_git_hash(&subject.tree)
    {
        return Err(QualificationPayloadError::SubjectMismatch);
    }
    let message = domain_separated_message_v1(
        "HeptaExternalAuthoritySetSubjectV1",
        &[
            subject.repository.as_bytes(),
            subject.commit.as_bytes(),
            subject.tree.as_bytes(),
            subject.package_id.as_str().as_bytes(),
        ],
    )?;
    Ok(hash_bytes_v1(&message))
}

/// Returns the deterministic Ed25519 message for one inner authority receipt.
pub fn authority_receipt_signing_bytes_v1(
    subject_hash: &str,
    receipt: &Value,
) -> Result<Vec<u8>, QualificationPayloadError> {
    if !valid_sha256(subject_hash) {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    let canonical = canonical_without_signature_v1(receipt, "signatureBase64")?;
    domain_separated_message_v1(
        "HeptaExternalAuthorityReceiptV1",
        &[subject_hash.as_bytes(), &canonical],
    )
}

/// Returns the deterministic reviewer message for the complete authority set.
pub fn authority_set_signing_bytes_v1(
    subject_hash: &str,
    payload: &Value,
) -> Result<Vec<u8>, QualificationPayloadError> {
    if !valid_sha256(subject_hash) {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    let canonical = canonical_without_signature_v1(payload, "setSignatureBase64")?;
    domain_separated_message_v1(
        "HeptaExternalAuthoritySetReviewV1",
        &[subject_hash.as_bytes(), &canonical],
    )
}

fn canonical_without_signature_v1(
    value: &Value,
    signature_name: &str,
) -> Result<Vec<u8>, QualificationPayloadError> {
    let mut unsigned = object(value)?.clone();
    if !unsigned
        .remove(signature_name)
        .is_some_and(|signature| signature.is_string())
    {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    serde_json::to_vec(&Value::Object(unsigned))
        .map_err(|_| QualificationPayloadError::EncodingInvalid)
}

fn domain_separated_message_v1(
    domain: &str,
    fields: &[&[u8]],
) -> Result<Vec<u8>, QualificationPayloadError> {
    let mut output = Vec::new();
    append_length_prefixed_v1(&mut output, domain.as_bytes())?;
    for field in fields {
        append_length_prefixed_v1(&mut output, field)?;
    }
    Ok(output)
}

fn append_length_prefixed_v1(
    output: &mut Vec<u8>,
    value: &[u8],
) -> Result<(), QualificationPayloadError> {
    let length =
        u64::try_from(value.len()).map_err(|_| QualificationPayloadError::EncodingInvalid)?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn verify_authority_signature_v1(
    trust_store: &QualificationTrustStoreV1,
    authority_domain: &str,
    signer_key_id: &str,
    message: &[u8],
    signature_base64: &str,
) -> Result<(), QualificationPayloadError> {
    let key = trust_store
        .key(authority_domain, signer_key_id)
        .map_err(|_| QualificationPayloadError::AuthorityMismatch)?;
    let signature_bytes = Base64UrlUnpadded::decode_vec(signature_base64)
        .map_err(|_| QualificationPayloadError::SignatureInvalid)?;
    if Base64UrlUnpadded::encode_string(&signature_bytes) != signature_base64 {
        return Err(QualificationPayloadError::SignatureInvalid);
    }
    let signature = Signature::try_from(signature_bytes.as_slice())
        .map_err(|_| QualificationPayloadError::SignatureInvalid)?;
    key.verify_strict(message, &signature)
        .map_err(|_| QualificationPayloadError::SignatureInvalid)
}

#[derive(Clone, Debug)]
struct ParsedUtcTimestamp {
    epoch_seconds: i64,
    fraction: Vec<u8>,
}

fn parsed_time_window(
    root: &Map<String, Value>,
) -> Result<(ParsedUtcTimestamp, ParsedUtcTimestamp), QualificationPayloadError> {
    let issued = parse_utc_timestamp(string(root, "issuedAt")?)?;
    let expires = parse_utc_timestamp(string(root, "expiresAt")?)?;
    if compare_timestamps(&issued, &expires) != Ordering::Less {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    Ok((issued, expires))
}

fn current_time_window(
    root: &Map<String, Value>,
    verifier_now_unix_ms: u64,
) -> Result<(ParsedUtcTimestamp, ParsedUtcTimestamp), QualificationPayloadError> {
    if verifier_now_unix_ms == 0 {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    let (issued, expires) = parsed_time_window(root)?;
    let now_seconds = i64::try_from(verifier_now_unix_ms / 1_000)
        .map_err(|_| QualificationPayloadError::SemanticInvalid)?;
    let now_fraction = format!("{:03}", verifier_now_unix_ms % 1_000).into_bytes();
    let now = ParsedUtcTimestamp {
        epoch_seconds: now_seconds,
        fraction: now_fraction,
    };
    if compare_timestamps(&issued, &now) == Ordering::Greater
        || compare_timestamps(&now, &expires) != Ordering::Less
    {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    Ok((issued, expires))
}

fn compare_timestamps(left: &ParsedUtcTimestamp, right: &ParsedUtcTimestamp) -> Ordering {
    left.epoch_seconds
        .cmp(&right.epoch_seconds)
        .then_with(|| compare_decimal_fractions(&left.fraction, &right.fraction))
}

fn compare_decimal_fractions(left: &[u8], right: &[u8]) -> Ordering {
    let length = left.len().max(right.len());
    for index in 0..length {
        let left_digit = left.get(index).copied().unwrap_or(b'0');
        let right_digit = right.get(index).copied().unwrap_or(b'0');
        match left_digit.cmp(&right_digit) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
    }
    Ordering::Equal
}

fn parse_utc_timestamp(value: &str) -> Result<ParsedUtcTimestamp, QualificationPayloadError> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    let fraction = if bytes.len() == 20 {
        if bytes.get(19) != Some(&b'Z') {
            return Err(QualificationPayloadError::SchemaInvalid);
        }
        Vec::new()
    } else {
        if bytes.get(19) != Some(&b'.') || bytes.last() != Some(&b'Z') {
            return Err(QualificationPayloadError::SchemaInvalid);
        }
        let digits = bytes
            .get(20..bytes.len().saturating_sub(1))
            .ok_or(QualificationPayloadError::SchemaInvalid)?;
        if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
            return Err(QualificationPayloadError::SchemaInvalid);
        }
        digits.to_vec()
    };

    let year = parse_decimal_v1(bytes, 0, 4)?;
    let month = parse_decimal_v1(bytes, 5, 2)?;
    let day = parse_decimal_v1(bytes, 8, 2)?;
    let hour = parse_decimal_v1(bytes, 11, 2)?;
    let minute = parse_decimal_v1(bytes, 14, 2)?;
    let second = parse_decimal_v1(bytes, 17, 2)?;
    if year == 0
        || year > 9_999
        || !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month_v1(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    let days = days_from_civil_v1(i64::from(year), month, day);
    let epoch_seconds = days
        .saturating_mul(86_400)
        .saturating_add(i64::from(hour) * 3_600)
        .saturating_add(i64::from(minute) * 60)
        .saturating_add(i64::from(second));
    Ok(ParsedUtcTimestamp {
        epoch_seconds,
        fraction,
    })
}

fn parse_decimal_v1(
    bytes: &[u8],
    start: usize,
    length: usize,
) -> Result<u32, QualificationPayloadError> {
    let end = start
        .checked_add(length)
        .ok_or(QualificationPayloadError::SchemaInvalid)?;
    let digits = bytes
        .get(start..end)
        .ok_or(QualificationPayloadError::SchemaInvalid)?;
    let mut value = 0_u32;
    for digit in digits {
        if !digit.is_ascii_digit() {
            return Err(QualificationPayloadError::SchemaInvalid);
        }
        value = value * 10 + u32::from(*digit - b'0');
    }
    Ok(value)
}

fn days_in_month_v1(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year_v1(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year_v1(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

fn days_from_civil_v1(year: i64, month: u32, day: u32) -> i64 {
    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let month_prime = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn hash_bytes_v1(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn common_subject(
    root: &Map<String, Value>,
    subject: &QualificationSubjectV1,
    commit_key: &str,
    tree_key: &str,
) -> Result<(), QualificationPayloadError> {
    if unsigned(root, "schemaVersion")? != 1
        || string(root, "packageId")? != subject.package_id.as_str()
        || string(root, "repository")? != subject.repository.as_str()
        || string(root, commit_key)? != subject.commit.as_str()
        || string(root, tree_key)? != subject.tree.as_str()
    {
        return Err(QualificationPayloadError::SubjectMismatch);
    }
    Ok(())
}

fn approved(root: &Map<String, Value>) -> Result<(), QualificationPayloadError> {
    if string(root, "decision")? != "approved" {
        return Err(QualificationPayloadError::DecisionNotApproved);
    }
    Ok(())
}

fn reviewer_matches(
    operator_domain: &str,
    reviewer_domain: &str,
    reviewer_key: &str,
    envelope_domain: &str,
    envelope_key: &str,
) -> Result<(), QualificationPayloadError> {
    if operator_domain == reviewer_domain
        || reviewer_domain != envelope_domain
        || reviewer_key != envelope_key
    {
        return Err(QualificationPayloadError::AuthorityMismatch);
    }
    Ok(())
}

fn exact_pass_map(
    root: &Map<String, Value>,
    field_name: &str,
    expected: &[&str],
) -> Result<(), QualificationPayloadError> {
    let values = object(field(root, field_name)?)?;
    exact_keys(values, expected)?;
    if expected
        .iter()
        .any(|name| string(values, name).ok() != Some("passed"))
    {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    Ok(())
}

fn reviewed_objects(root: &Map<String, Value>) -> Result<(), QualificationPayloadError> {
    let values = array(root, "reviewedObjects")?;
    if values.is_empty() {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    let mut paths = BTreeSet::new();
    for value in values {
        let value = object(value)?;
        exact_keys(value, &["path", "sha256"])?;
        let path = string(value, "path")?;
        if path.is_empty() || path.len() > 512 || !paths.insert(path) {
            return Err(QualificationPayloadError::SemanticInvalid);
        }
        sha256(value, "sha256")?;
    }
    Ok(())
}

fn closed_findings(root: &Map<String, Value>) -> Result<(), QualificationPayloadError> {
    let values = array(root, "findings")?;
    let mut ids = BTreeSet::new();
    for value in values {
        let value = object(value)?;
        exact_keys(value, &["id", "severity", "disposition", "evidenceHash"])?;
        let id = identifier(value, "id")?;
        if !ids.insert(id)
            || !matches!(
                string(value, "severity")?,
                "critical" | "high" | "medium" | "low" | "informational"
            )
            || !matches!(
                string(value, "disposition")?,
                "fixed_and_reverified" | "accepted_by_external_authority"
            )
        {
            return Err(QualificationPayloadError::SemanticInvalid);
        }
        sha256(value, "evidenceHash")?;
    }
    Ok(())
}

fn nonempty_unique_strings(
    root: &Map<String, Value>,
    name: &str,
) -> Result<(), QualificationPayloadError> {
    let values = array(root, name)?;
    if values.is_empty() {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    unique_strings(values, |value| !value.is_empty() && value.len() <= 512)
}

fn unique_strings(
    values: &[Value],
    validator: impl Fn(&str) -> bool,
) -> Result<(), QualificationPayloadError> {
    let mut unique = BTreeSet::new();
    for value in values {
        let value = value
            .as_str()
            .ok_or(QualificationPayloadError::SchemaInvalid)?;
        if !validator(value) || !unique.insert(value) {
            return Err(QualificationPayloadError::SemanticInvalid);
        }
    }
    Ok(())
}

fn zero_fields(root: &Map<String, Value>, names: &[&str]) -> Result<(), QualificationPayloadError> {
    if names
        .iter()
        .any(|name| unsigned(root, name).ok() != Some(0))
    {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    Ok(())
}

fn time_window(root: &Map<String, Value>) -> Result<(), QualificationPayloadError> {
    parsed_time_window(root).map(|_| ())
}

fn signature_field<'a>(
    root: &'a Map<String, Value>,
    name: &str,
) -> Result<&'a str, QualificationPayloadError> {
    let value = string(root, name)?;
    if !(40..=512).contains(&value.len()) {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    Ok(value)
}

fn sha256<'a>(
    root: &'a Map<String, Value>,
    name: &str,
) -> Result<&'a str, QualificationPayloadError> {
    let value = string(root, name)?;
    if !valid_sha256(value) {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    Ok(value)
}

fn identifier<'a>(
    root: &'a Map<String, Value>,
    name: &str,
) -> Result<&'a str, QualificationPayloadError> {
    let value = string(root, name)?;
    if !valid_identifier(value) {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    Ok(value)
}

fn timestamp<'a>(
    root: &'a Map<String, Value>,
    name: &str,
) -> Result<&'a str, QualificationPayloadError> {
    let value = string(root, name)?;
    if !valid_utc_timestamp(value) {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    Ok(value)
}

fn object(value: &Value) -> Result<&Map<String, Value>, QualificationPayloadError> {
    value
        .as_object()
        .ok_or(QualificationPayloadError::SchemaInvalid)
}

fn field<'a>(
    root: &'a Map<String, Value>,
    name: &str,
) -> Result<&'a Value, QualificationPayloadError> {
    root.get(name)
        .ok_or(QualificationPayloadError::SchemaInvalid)
}

fn string<'a>(
    root: &'a Map<String, Value>,
    name: &str,
) -> Result<&'a str, QualificationPayloadError> {
    field(root, name)?
        .as_str()
        .ok_or(QualificationPayloadError::SchemaInvalid)
}

fn unsigned(root: &Map<String, Value>, name: &str) -> Result<u64, QualificationPayloadError> {
    field(root, name)?
        .as_u64()
        .ok_or(QualificationPayloadError::SchemaInvalid)
}

fn boolean(root: &Map<String, Value>, name: &str) -> Result<bool, QualificationPayloadError> {
    field(root, name)?
        .as_bool()
        .ok_or(QualificationPayloadError::SchemaInvalid)
}

fn array<'a>(
    root: &'a Map<String, Value>,
    name: &str,
) -> Result<&'a [Value], QualificationPayloadError> {
    field(root, name)?
        .as_array()
        .map(Vec::as_slice)
        .ok_or(QualificationPayloadError::SchemaInvalid)
}

fn exact_keys(
    root: &Map<String, Value>,
    expected: &[&str],
) -> Result<(), QualificationPayloadError> {
    let actual = root.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn valid_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(first) if first.is_ascii_alphanumeric())
        && value.len() <= 128
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn valid_name(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

fn valid_check_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b" ._()/-".contains(&byte))
}

fn valid_utc_timestamp(value: &str) -> bool {
    parse_utc_timestamp(value).is_ok()
}

#[cfg(test)]
mod tests {
    use base64ct::{Base64UrlUnpadded, Encoding};
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    use super::*;

    const SHA: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const COMMIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TREE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const REVIEWER: &str = "independent-reviewer";
    const REVIEWER_KEY: &str = "reviewer-key";
    const NOW_UNIX_MS: u64 = 1_788_091_200_000;

    fn reviewer_signing_key() -> SigningKey {
        SigningKey::from_bytes(&[91_u8; 32])
    }

    fn reviewer_trust_store() -> QualificationTrustStoreV1 {
        let signing = reviewer_signing_key();
        QualificationTrustStoreV1::new(
            [(
                REVIEWER.to_owned(),
                REVIEWER_KEY.to_owned(),
                signing.verifying_key(),
            )],
            [
                "implementation-author".to_owned(),
                "repository-admin".to_owned(),
                "github-hosted-ci".to_owned(),
            ],
        )
        .expect("reviewer trust store")
    }

    fn validate_payload(
        bytes: &[u8],
        subject: &QualificationSubjectV1,
        envelope_domain: &str,
        envelope_key: &str,
    ) -> Result<(), QualificationPayloadError> {
        let trust = reviewer_trust_store();
        validate_external_package_payload_v1(
            bytes,
            subject,
            envelope_domain,
            envelope_key,
            NOW_UNIX_MS,
            1,
            &trust,
        )
    }

    fn subject(package_id: QualificationPackageIdV1) -> QualificationSubjectV1 {
        QualificationSubjectV1 {
            repository: "TrillionniumFoundation/hepta-paper".to_owned(),
            commit: COMMIT.to_owned(),
            tree: TREE.to_owned(),
            package_id,
        }
    }

    fn encoded(value: Value) -> Vec<u8> {
        serde_json::to_vec(&value).expect("canonical JSON")
    }

    fn hash(marker: u8) -> String {
        format!("sha256:{marker:064x}")
    }

    fn governance() -> Value {
        json!({
            "schemaVersion": 1,
            "packageId": "EXT-GOV-MAIN-001",
            "repository": "TrillionniumFoundation/hepta-paper",
            "repositoryId": 1349108143u64,
            "targetRef": "refs/heads/main",
            "sourceCommit": COMMIT,
            "sourceTree": TREE,
            "ruleset": {
                "id": 1,
                "name": "protected-main",
                "enforcement": "active",
                "bypassActors": []
            },
            "rulesetExportSha256": SHA,
            "requiredChecks": [
                "check-1", "check-2", "check-3", "check-4", "check-5",
                "check-6", "check-7", "check-8", "check-9", "check-10"
            ],
            "pullRequestPolicy": {
                "requiredApprovingReviewCount": 1,
                "requireCodeOwnerReview": true,
                "dismissStaleReviews": true,
                "requireLastPushApproval": true,
                "requireConversationResolution": true
            },
            "referencePolicy": {
                "blockForcePush": true,
                "blockDeletion": true,
                "requirePullRequest": true,
                "signedCommitMode": "verified-github-merge",
                "historyMode": "linear"
            },
            "denialTests": REQUIRED_GOVERNANCE_DENIALS.map(|kind| json!({
                "kind": kind,
                "result": "denied",
                "evidenceSha256": SHA,
                "observedAt": "2026-08-30T00:00:00Z"
            })),
            "administratorAuthorityDomain": "repository-administrator",
            "reviewerAuthorityDomain": REVIEWER,
            "authoritySeparationSha256": SHA,
            "reviewerKeyId": REVIEWER_KEY,
            "issuedAt": "2026-08-30T00:00:00Z",
            "expiresAt": "2026-09-30T00:00:00Z",
            "decision": "approved",
            "signatureBase64": "A".repeat(64)
        })
    }

    fn host_cgroup() -> Value {
        json!({
            "schemaVersion": 1,
            "packageId": "EXT-HOST-CGROUP-001",
            "repository": "TrillionniumFoundation/hepta-paper",
            "commit": COMMIT,
            "tree": TREE,
            "hostIdentityHash": hash(1),
            "bootIdentityHash": hash(2),
            "kernelIdentityHash": hash(3),
            "systemdIdentityHash": hash(4),
            "cgroupIdentityHash": hash(5),
            "listenerIdentityHash": hash(6),
            "schemaIdentityHash": hash(7),
            "gateIdentityHash": hash(8),
            "journalIdentityHash": hash(9),
            "drills": REQUIRED_HOST_CGROUP_DRILLS
                .into_iter()
                .map(|name| (name.to_owned(), json!("passed")))
                .collect::<serde_json::Map<_, _>>(),
            "operatorAuthorityDomain": "target-host-operator",
            "reviewerAuthorityDomain": REVIEWER,
            "reviewerKeyId": REVIEWER_KEY,
            "reviewedObjects": [{"path": "/usr/libexec/hepta/gate", "sha256": hash(10)}],
            "kernelAssumptions": ["unified cgroup v2"],
            "findings": [],
            "decision": "approved",
            "issuedAt": "2026-08-30T00:00:00Z",
            "expiresAt": "2026-09-30T00:00:00Z",
            "signatureBase64": "D".repeat(64)
        })
    }

    fn host_storage() -> Value {
        json!({
            "schemaVersion": 1,
            "packageId": "EXT-HOST-STORAGE-001",
            "repository": "TrillionniumFoundation/hepta-paper",
            "commit": COMMIT,
            "tree": TREE,
            "hostIdentityHash": hash(11),
            "bootSequenceHash": hash(12),
            "filesystemIdentityHash": hash(13),
            "mountIdentityHash": hash(14),
            "blockDeviceIdentityHash": hash(15),
            "databaseIdentityHash": hash(16),
            "walIdentityHash": hash(17),
            "shmIdentityHash": hash(18),
            "artifactManifestHash": hash(19),
            "serviceUnitHash": hash(20),
            "rawEvidenceManifestHash": hash(21),
            "faultMatrix": REQUIRED_STORAGE_FAULTS
                .into_iter()
                .map(|name| (name.to_owned(), json!("passed")))
                .collect::<serde_json::Map<_, _>>(),
            "operationCount": 10_000,
            "continuousSoakSeconds": 259_200,
            "staleCommitCount": 0,
            "duplicateProviderCallCount": 0,
            "duplicateIntegrationCount": 0,
            "unclassifiedRecoveryCount": 0,
            "operatorAuthorityDomain": "storage-operator",
            "reviewerAuthorityDomain": REVIEWER,
            "reviewerKeyId": REVIEWER_KEY,
            "findings": [],
            "decision": "approved",
            "issuedAt": "2026-08-30T00:00:00Z",
            "expiresAt": "2026-09-30T00:00:00Z",
            "signatureBase64": "E".repeat(64)
        })
    }

    fn key_owner() -> Value {
        let drills = REQUIRED_KEY_DRILLS
            .into_iter()
            .enumerate()
            .map(|(index, name)| {
                (
                    name.to_owned(),
                    json!({
                        "result": "passed",
                        "evidenceHash": hash(30 + index as u8),
                        "notesHash": hash(40 + index as u8)
                    }),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        json!({
            "schemaVersion": 1,
            "packageId": "EXT-KEY-OWNER-001",
            "repository": "TrillionniumFoundation/hepta-paper",
            "commit": COMMIT,
            "tree": TREE,
            "authorityDomainId": "capability-key-owner",
            "authorityKeyId": "capability-key-1",
            "reviewerAuthorityDomain": REVIEWER,
            "reviewerKeyId": REVIEWER_KEY,
            "initialGeneration": 1,
            "finalGeneration": 2,
            "initialBundleHash": hash(50),
            "finalBundleHash": hash(51),
            "drills": drills,
            "privateKeyAbsentFromBroker": true,
            "brokerAdmissionDisabledOnAmbiguity": true,
            "decision": "approved",
            "issuedAt": "2026-08-30T00:00:00Z",
            "expiresAt": "2026-09-30T00:00:00Z",
            "signatureBase64": "F".repeat(64)
        })
    }

    fn codex_role() -> Value {
        let role = |name: &str, uid: u64, marker: u8| {
            json!({
                "role": name,
                "uid": uid,
                "gid": uid,
                "homeIdentityHash": hash(marker),
                "socketIdentityHash": hash(marker + 1),
                "journalIdentityHash": hash(marker + 2),
                "schemaIdentityHash": hash(marker + 3),
                "capabilityAudienceHash": hash(marker + 4),
                "authenticated": true,
                "boundedCompletion": true,
                "environmentDisclosureDenied": true,
                "unexpectedFdDisclosureDenied": true,
                "receiptHash": hash(marker + 5)
            })
        };
        json!({
            "schemaVersion": 1,
            "packageId": "EXT-CODEX-ROLE-001",
            "repository": "TrillionniumFoundation/hepta-paper",
            "commit": COMMIT,
            "tree": TREE,
            "runtimeIdentityHash": hash(60),
            "providerAccountAuthorityDomain": "codex-account-owner",
            "providerAccountKeyId": "codex-account-key",
            "roles": [role("author", 1001, 61), role("reviewer", 1002, 71)],
            "crossRoleAccessDenied": true,
            "campaignDatabaseAccessDenied": true,
            "externalAuthorityCredentialAccessDenied": true,
            "providerInitializationBeforeReleaseCount": 0,
            "unauthorizedNetworkAttemptCount": 0,
            "preparedResultRecoveryWithoutSecondProviderCall": true,
            "promptOrManuscriptContentRetained": false,
            "reviewerAuthorityDomain": REVIEWER,
            "reviewerKeyId": REVIEWER_KEY,
            "decision": "approved",
            "issuedAt": "2026-08-30T00:00:00Z",
            "expiresAt": "2026-09-30T00:00:00Z",
            "signatureBase64": "G".repeat(64)
        })
    }

    fn cutover() -> Value {
        json!({
            "schemaVersion": 1,
            "packageId": "EXT-CUTOVER-SOAK-001",
            "repository": "TrillionniumFoundation/hepta-paper",
            "commit": COMMIT,
            "tree": TREE,
            "databaseIdentityHash": hash(81),
            "schemaVersionObserved": 25,
            "oldWriterIdentity": "node-writer",
            "newWriterIdentity": "rust-writer",
            "backupReceiptHash": hash(82),
            "restoreReceiptHash": hash(83),
            "logicalParityReceiptHash": hash(84),
            "writerTransferReceiptHash": hash(85),
            "oldWorkersStopped": true,
            "oldLeasesCleared": true,
            "dualWriterObserved": false,
            "rollbackDrillPassed": true,
            "terminalResumeDrillPassed": true,
            "operationCount": 10_000,
            "continuousSoakSeconds": 259_200,
            "staleCommitCount": 0,
            "duplicateIntegrationCount": 0,
            "unexplainedSettlementCount": 0,
            "unclassifiedRecoveryCount": 0,
            "operatorAuthorityDomain": "campaign-database-operator",
            "observerAuthorityDomain": REVIEWER,
            "observerKeyId": REVIEWER_KEY,
            "decision": "approved",
            "issuedAt": "2026-08-30T00:00:00Z",
            "expiresAt": "2026-09-30T00:00:00Z",
            "signatureBase64": "H".repeat(64)
        })
    }

    #[test]
    fn every_package_success_vocabulary_is_accepted() {
        for (package, payload) in [
            (QualificationPackageIdV1::ExtGovMain001, governance()),
            (QualificationPackageIdV1::ExtHostCgroup001, host_cgroup()),
            (QualificationPackageIdV1::ExtHostStorage001, host_storage()),
            (QualificationPackageIdV1::ExtKeyOwner001, key_owner()),
            (QualificationPackageIdV1::ExtCodexRole001, codex_role()),
            (QualificationPackageIdV1::ExtCutoverSoak001, cutover()),
        ] {
            validate_payload(&encoded(payload), &subject(package), REVIEWER, REVIEWER_KEY)
                .unwrap_or_else(|error| {
                    panic!("valid payload rejected for {}: {error}", package.as_str())
                });
        }
    }

    #[test]
    fn approved_governance_payload_is_accepted() {
        validate_payload(
            &encoded(governance()),
            &subject(QualificationPackageIdV1::ExtGovMain001),
            REVIEWER,
            REVIEWER_KEY,
        )
        .expect("approved governance payload");
    }

    #[test]
    fn nonapproved_payload_is_rejected() {
        let mut value = governance();
        value["decision"] = json!("rejected");
        assert!(matches!(
            validate_payload(
                &encoded(value),
                &subject(QualificationPackageIdV1::ExtGovMain001),
                REVIEWER,
                REVIEWER_KEY,
            ),
            Err(QualificationPayloadError::DecisionNotApproved)
        ));
    }

    #[test]
    fn envelope_reviewer_must_match_payload_reviewer() {
        assert!(matches!(
            validate_payload(
                &encoded(governance()),
                &subject(QualificationPackageIdV1::ExtGovMain001),
                "different-reviewer",
                REVIEWER_KEY,
            ),
            Err(QualificationPayloadError::AuthorityMismatch)
        ));
    }

    fn signed_authority_set() -> (Value, QualificationTrustStoreV1) {
        let authority_subject = subject(QualificationPackageIdV1::ExtAuthoritySet001);
        let subject_hash =
            authority_set_subject_hash_v1(&authority_subject).expect("authority subject hash");
        let authorities = [
            ("release_signer", "release-domain", "release-key", 31_u8),
            ("worm_custody", "worm-domain", "worm-key", 32_u8),
            ("backup_restore", "backup-domain", "backup-key", 33_u8),
            (
                "submission_dispatcher",
                "submission-domain",
                "submission-key",
                34_u8,
            ),
        ];
        let mut trust_entries = Vec::new();
        let mut receipts = Vec::new();
        for (index, (kind, domain, key_id, marker)) in authorities.into_iter().enumerate() {
            let signing = SigningKey::from_bytes(&[marker; 32]);
            let mut receipt = json!({
                "authorityKind": kind,
                "authorityDomainId": domain,
                "operationId": format!("operation-{}", index + 1),
                "requestHash": hash(100 + index as u8),
                "resultHash": hash(110 + index as u8),
                "outcome": "succeeded",
                "nonce": format!("nonce-{}", index + 1),
                "issuedAt": "2026-08-30T00:00:00Z",
                "expiresAt": "2026-09-30T00:00:00Z",
                "signerKeyId": key_id,
                "trustGeneration": 1,
                "externalActionMayHaveStarted": true,
                "signatureBase64": ""
            });
            let message = authority_receipt_signing_bytes_v1(&subject_hash, &receipt)
                .expect("receipt signing bytes");
            receipt["signatureBase64"] = json!(Base64UrlUnpadded::encode_string(
                &signing.sign(&message).to_bytes()
            ));
            trust_entries.push((
                domain.to_owned(),
                key_id.to_owned(),
                signing.verifying_key(),
            ));
            receipts.push(receipt);
        }

        let reviewer = reviewer_signing_key();
        trust_entries.push((
            REVIEWER.to_owned(),
            REVIEWER_KEY.to_owned(),
            reviewer.verifying_key(),
        ));
        let mut value = json!({
            "schemaVersion": 1,
            "packageId": "EXT-AUTHORITY-SET-001",
            "repository": "TrillionniumFoundation/hepta-paper",
            "commit": COMMIT,
            "tree": TREE,
            "subjectHash": subject_hash,
            "receipts": receipts,
            "authorityDomainsDistinct": true,
            "repositoryOrLocalFixtureAuthorityCount": 0,
            "reviewerAuthorityDomain": REVIEWER,
            "reviewerKeyId": REVIEWER_KEY,
            "decision": "approved",
            "issuedAt": "2026-08-30T01:00:00Z",
            "expiresAt": "2026-09-15T00:00:00Z",
            "setSignatureBase64": ""
        });
        let message = authority_set_signing_bytes_v1(
            value["subjectHash"].as_str().expect("subject hash"),
            &value,
        )
        .expect("set signing bytes");
        value["setSignatureBase64"] = json!(Base64UrlUnpadded::encode_string(
            &reviewer.sign(&message).to_bytes()
        ));
        let trust_store = QualificationTrustStoreV1::new(
            trust_entries,
            [
                "implementation-author".to_owned(),
                "repository-admin".to_owned(),
                "github-hosted-ci".to_owned(),
            ],
        )
        .expect("authority trust store");
        (value, trust_store)
    }

    #[test]
    fn authority_set_requires_four_valid_independent_signatures() {
        let (value, trust) = signed_authority_set();
        validate_external_package_payload_v1(
            &encoded(value),
            &subject(QualificationPackageIdV1::ExtAuthoritySet001),
            REVIEWER,
            REVIEWER_KEY,
            NOW_UNIX_MS,
            1,
            &trust,
        )
        .expect("cryptographically valid authority set");
    }

    #[test]
    fn authority_set_rejects_nested_or_set_signature_tampering() {
        let (mut nested, trust) = signed_authority_set();
        nested["receipts"][0]["resultHash"] = json!(hash(120));
        assert!(matches!(
            validate_external_package_payload_v1(
                &encoded(nested),
                &subject(QualificationPackageIdV1::ExtAuthoritySet001),
                REVIEWER,
                REVIEWER_KEY,
                NOW_UNIX_MS,
                1,
                &trust,
            ),
            Err(QualificationPayloadError::SignatureInvalid)
        ));

        let (mut set, trust) = signed_authority_set();
        set["setSignatureBase64"] = json!("A".repeat(86));
        assert!(matches!(
            validate_external_package_payload_v1(
                &encoded(set),
                &subject(QualificationPackageIdV1::ExtAuthoritySet001),
                REVIEWER,
                REVIEWER_KEY,
                NOW_UNIX_MS,
                1,
                &trust,
            ),
            Err(QualificationPayloadError::SignatureInvalid)
        ));
    }

    #[test]
    fn authority_set_rejects_subject_or_trust_generation_substitution() {
        let (mut subject_substitution, trust) = signed_authority_set();
        subject_substitution["subjectHash"] = json!(SHA);
        assert!(matches!(
            validate_external_package_payload_v1(
                &encoded(subject_substitution),
                &subject(QualificationPackageIdV1::ExtAuthoritySet001),
                REVIEWER,
                REVIEWER_KEY,
                NOW_UNIX_MS,
                1,
                &trust,
            ),
            Err(QualificationPayloadError::SubjectMismatch)
        ));

        let (generation_substitution, trust) = signed_authority_set();
        assert!(matches!(
            validate_external_package_payload_v1(
                &encoded(generation_substitution),
                &subject(QualificationPackageIdV1::ExtAuthoritySet001),
                REVIEWER,
                REVIEWER_KEY,
                NOW_UNIX_MS,
                2,
                &trust,
            ),
            Err(QualificationPayloadError::SemanticInvalid)
        ));
    }

    #[test]
    fn identifiers_and_utc_windows_match_the_schema_semantics() {
        for valid in ["a", "A0", "review:key-1", "authority_domain.v1"] {
            assert!(valid_identifier(valid), "{valid}");
        }
        for invalid in ["", "-leading", "_leading", ".leading", ":leading", "é"] {
            assert!(!valid_identifier(invalid), "{invalid}");
        }
        for invalid in [
            "2026-08-30T00:00:00abcZ",
            "2026-08-30T00:00:00.Z",
            "2026-13-30T00:00:00Z",
            "2026-02-30T00:00:00Z",
            "2026-08-30T24:00:00Z",
        ] {
            assert!(!valid_utc_timestamp(invalid), "{invalid}");
        }
        let valid_fraction = json!({
            "issuedAt": "2026-08-30T00:00:00Z",
            "expiresAt": "2026-08-30T00:00:00.1Z"
        });
        assert!(time_window(valid_fraction.as_object().expect("window")).is_ok());
        let reversed_fraction = json!({
            "issuedAt": "2026-08-30T00:00:00.10Z",
            "expiresAt": "2026-08-30T00:00:00.099Z"
        });
        assert!(matches!(
            time_window(reversed_fraction.as_object().expect("window")),
            Err(QualificationPayloadError::SemanticInvalid)
        ));
    }

    #[test]
    fn canonical_compact_json_is_required() {
        let pretty = serde_json::to_vec_pretty(&governance()).expect("pretty JSON");
        assert!(matches!(
            validate_payload(
                &pretty,
                &subject(QualificationPackageIdV1::ExtGovMain001),
                REVIEWER,
                REVIEWER_KEY,
            ),
            Err(QualificationPayloadError::EncodingInvalid)
        ));
    }
}

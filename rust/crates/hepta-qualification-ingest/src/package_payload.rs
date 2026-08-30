use std::collections::BTreeSet;

use serde_json::{Map, Value};
use thiserror::Error;

use crate::{QualificationPackageIdV1, QualificationSubjectV1};

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
    let issued = timestamp(root, "issuedAt")?;
    let expires = timestamp(root, "expiresAt")?;
    if issued >= expires {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    Ok(())
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
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
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
    let bytes = value.as_bytes();
    (20..=40).contains(&bytes.len())
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
        && bytes.last() == Some(&b'Z')
        && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18]
            .into_iter()
            .all(|index| bytes.get(index).is_some_and(u8::is_ascii_digit))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SHA: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const COMMIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TREE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const REVIEWER: &str = "independent-reviewer";
    const REVIEWER_KEY: &str = "reviewer-key";

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
            validate_external_package_payload_v1(
                &encoded(payload),
                &subject(package),
                REVIEWER,
                REVIEWER_KEY,
            )
            .unwrap_or_else(|error| {
                panic!("valid payload rejected for {}: {error}", package.as_str())
            });
        }
    }

    #[test]
    fn approved_governance_payload_is_accepted() {
        validate_external_package_payload_v1(
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
            validate_external_package_payload_v1(
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
            validate_external_package_payload_v1(
                &encoded(governance()),
                &subject(QualificationPackageIdV1::ExtGovMain001),
                "different-reviewer",
                REVIEWER_KEY,
            ),
            Err(QualificationPayloadError::AuthorityMismatch)
        ));
    }

    #[test]
    fn authority_set_requires_four_distinct_kinds_and_domains() {
        let receipt = |kind: &str, domain: &str, marker: &str| {
            json!({
                "authorityKind": kind,
                "authorityDomainId": domain,
                "operationId": format!("operation-{marker}"),
                "requestHash": SHA,
                "resultHash": SHA,
                "outcome": "succeeded",
                "nonce": format!("nonce-{marker}"),
                "issuedAt": "2026-08-30T00:00:00Z",
                "expiresAt": "2026-09-30T00:00:00Z",
                "signerKeyId": format!("key-{marker}"),
                "trustGeneration": 1,
                "externalActionMayHaveStarted": true,
                "signatureBase64": "B".repeat(64)
            })
        };
        let value = json!({
            "schemaVersion": 1,
            "packageId": "EXT-AUTHORITY-SET-001",
            "repository": "TrillionniumFoundation/hepta-paper",
            "commit": COMMIT,
            "tree": TREE,
            "subjectHash": SHA,
            "receipts": [
                receipt("release_signer", "release-domain", "1"),
                receipt("worm_custody", "worm-domain", "2"),
                receipt("backup_restore", "backup-domain", "3"),
                receipt("submission_dispatcher", "submission-domain", "4")
            ],
            "authorityDomainsDistinct": true,
            "repositoryOrLocalFixtureAuthorityCount": 0,
            "reviewerAuthorityDomain": REVIEWER,
            "reviewerKeyId": REVIEWER_KEY,
            "decision": "approved",
            "issuedAt": "2026-08-30T00:00:00Z",
            "expiresAt": "2026-09-30T00:00:00Z",
            "setSignatureBase64": "C".repeat(64)
        });
        validate_external_package_payload_v1(
            &encoded(value),
            &subject(QualificationPackageIdV1::ExtAuthoritySet001),
            REVIEWER,
            REVIEWER_KEY,
        )
        .expect("distinct authority set");
    }

    #[test]
    fn canonical_compact_json_is_required() {
        let pretty = serde_json::to_vec_pretty(&governance()).expect("pretty JSON");
        assert!(matches!(
            validate_external_package_payload_v1(
                &pretty,
                &subject(QualificationPackageIdV1::ExtGovMain001),
                REVIEWER,
                REVIEWER_KEY,
            ),
            Err(QualificationPayloadError::EncodingInvalid)
        ));
    }
}

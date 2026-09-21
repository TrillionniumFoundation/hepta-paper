//! Real seven-package signatures exercise the post-file-boundary production path.
//!
//! These fixture keys and signed success claims are test data, never external host
//! qualification. Tests deliberately make no positive claim about authority-owned
//! filesystem intake: the production caller must pass its existing file/UID gates.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use hepta_qualification_ingest::{
    ExternalQualificationCandidateV1, ExternalQualificationEnvelopeV1, QualificationClosureError,
    authority_receipt_signing_bytes_v1, authority_set_signing_bytes_v1,
    authority_set_subject_hash_v1, qualification_signing_bytes_v1,
};
use rusqlite::types::Value as SqlValue;
use serde_json::{Value, json};

const COMMIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TREE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW: u64 = 1_788_091_200_000;
const REVIEWER: &str = "replaced-before-signing";
const REVIEWER_KEY: &str = "replaced-before-signing";
const REVIEWERS: [(&str, &str); 7] = [
    ("governance-review", "governance-key"),
    ("linux-review", "linux-key"),
    ("storage-review", "storage-key"),
    ("key-owner-review", "key-owner-key"),
    ("codex-account-review", "codex-account-key"),
    ("cutover-review", "cutover-key"),
    ("authority-set-review", "authority-set-key"),
];
const INNER_AUTHORITIES: [(&str, &str, &str, u8); 4] = [
    ("release_signer", "release-domain", "release-key", 31),
    ("worm_custody", "worm-domain", "worm-key", 32),
    ("backup_restore", "backup-domain", "backup-key", 33),
    (
        "submission_dispatcher",
        "submission-domain",
        "submission-key",
        34,
    ),
];

fn hash(marker: u8) -> String {
    format!("sha256:{marker:064x}")
}

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

fn reviewer_key(index: usize) -> SigningKey {
    SigningKey::from_bytes(&[u8::try_from(index).expect("seven reviewers") + 11; 32])
}

fn package_subject(package_id: QualificationPackageIdV1) -> QualificationSubjectV1 {
    QualificationSubjectV1 {
        repository: REQUIRED_REPOSITORY.into(),
        commit: COMMIT.into(),
        tree: TREE.into(),
        package_id,
    }
}

fn authority_set() -> Value {
    let subject_hash = authority_set_subject_hash_v1(&package_subject(
        QualificationPackageIdV1::ExtAuthoritySet001,
    ))
    .expect("authority-set subject");
    let receipts = INNER_AUTHORITIES
        .into_iter()
        .enumerate()
        .map(|(index, (kind, domain, key_id, seed))| {
            let mut receipt = json!({
                "authorityKind": kind, "authorityDomainId": domain,
                "operationId": format!("inner-operation-{index}"),
                "requestHash": hash(100 + u8::try_from(index).expect("four authorities")),
                "resultHash": hash(110 + u8::try_from(index).expect("four authorities")),
                "outcome": "succeeded", "nonce": format!("inner-nonce-{index}"),
                "issuedAt": "2026-08-30T00:00:00Z",
                "expiresAt": "2026-09-30T00:00:00Z",
                "signerKeyId": key_id, "trustGeneration": 1,
                "externalActionMayHaveStarted": true, "signatureBase64": ""
            });
            let message = authority_receipt_signing_bytes_v1(&subject_hash, &receipt)
                .expect("inner signing message");
            receipt["signatureBase64"] = json!(Base64UrlUnpadded::encode_string(
                &SigningKey::from_bytes(&[seed; 32])
                    .sign(&message)
                    .to_bytes()
            ));
            receipt
        })
        .collect::<Vec<_>>();
    let mut payload = json!({
        "schemaVersion": 1, "packageId": "EXT-AUTHORITY-SET-001",
        "repository": REQUIRED_REPOSITORY, "commit": COMMIT, "tree": TREE,
        "subjectHash": subject_hash, "receipts": receipts,
        "authorityDomainsDistinct": true, "repositoryOrLocalFixtureAuthorityCount": 0,
        "reviewerAuthorityDomain": REVIEWERS[6].0, "reviewerKeyId": REVIEWERS[6].1,
        "decision": "approved", "issuedAt": "2026-08-30T01:00:00Z",
        "expiresAt": "2026-09-15T00:00:00Z", "setSignatureBase64": ""
    });
    sign_authority_set(&mut payload);
    payload
}

fn sign_authority_set(payload: &mut Value) {
    let subject_hash = payload["subjectHash"].as_str().expect("set subject");
    let message =
        authority_set_signing_bytes_v1(subject_hash, payload).expect("set signing message");
    payload["setSignatureBase64"] = json!(Base64UrlUnpadded::encode_string(
        &reviewer_key(6).sign(&message).to_bytes()
    ));
}

struct SignedPackages {
    candidates: Vec<ExternalQualificationCandidateV1>,
    trust: QualificationTrustStoreV1,
    trust_hash: String,
}

impl SignedPackages {
    fn new() -> Self {
        let mut entries = REVIEWERS
            .iter()
            .enumerate()
            .map(|(index, (domain, key_id))| {
                (
                    (*domain).to_owned(),
                    (*key_id).to_owned(),
                    reviewer_key(index).verifying_key(),
                )
            })
            .collect::<Vec<_>>();
        entries.extend(INNER_AUTHORITIES.map(|(_, domain, key_id, seed)| {
            (
                domain.to_owned(),
                key_id.to_owned(),
                SigningKey::from_bytes(&[seed; 32]).verifying_key(),
            )
        }));
        let document = QualificationTrustStoreDocumentV1 {
            version: 1,
            generation: 1,
            issued_at_unix_ms: NOW - 60_000,
            expires_at_unix_ms: NOW + 86_400_000,
            previous_trust_store_hash: None,
            keys: entries
                .iter()
                .map(|(domain, key_id, key)| QualificationTrustKeyV1 {
                    authority_domain_id: domain.clone(),
                    signer_key_id: key_id.clone(),
                    public_key_base64: Base64UrlUnpadded::encode_string(key.as_bytes()),
                })
                .collect(),
            forbidden_authority_domains: REQUIRED_FORBIDDEN_DOMAINS.map(str::to_owned).to_vec(),
        };
        validate_trust_document(&document, NOW).expect("valid fixture trust document");
        let trust_hash =
            hash_bytes(&serde_json::to_vec(&document).expect("canonical trust document"));
        let trust = QualificationTrustStoreV1::new(entries, document.forbidden_authority_domains)
            .expect("unique actual signing keys and separated authority domains");

        let payloads = [
            governance(),
            host_cgroup(),
            host_storage(),
            key_owner(),
            codex_role(),
            cutover(),
            authority_set(),
        ];
        let candidates = QualificationPackageIdV1::ALL
            .into_iter()
            .zip(payloads)
            .enumerate()
            .map(|(index, (package, mut payload))| {
                if package != QualificationPackageIdV1::ExtAuthoritySet001 {
                    let (domain_field, key_field) =
                        if package == QualificationPackageIdV1::ExtCutoverSoak001 {
                            ("observerAuthorityDomain", "observerKeyId")
                        } else {
                            ("reviewerAuthorityDomain", "reviewerKeyId")
                        };
                    payload[domain_field] = json!(REVIEWERS[index].0);
                    payload[key_field] = json!(REVIEWERS[index].1);
                }
                if package == QualificationPackageIdV1::ExtHostStorage001 {
                    payload["hostIdentityHash"] = json!(hash(1));
                }
                if package == QualificationPackageIdV1::ExtCutoverSoak001 {
                    payload["databaseIdentityHash"] = json!(hash(16));
                }
                let payload = serde_json::to_vec(&payload).expect("canonical payload");
                let envelope = ExternalQualificationEnvelopeV1 {
                    version: 1,
                    package_id: package,
                    repository: REQUIRED_REPOSITORY.into(),
                    commit: COMMIT.into(),
                    tree: TREE.into(),
                    payload_hash: hash_bytes(&payload),
                    authority_domain_id: REVIEWERS[index].0.into(),
                    signer_key_id: REVIEWERS[index].1.into(),
                    nonce: format!("joint-package-nonce-{index}"),
                    issued_at_unix_ms: NOW - 60_000,
                    expires_at_unix_ms: NOW + 86_400_000,
                    // The signing encoder requires a populated signature slot,
                    // while omitting its bytes from the signed message. Replace
                    // this placeholder with the actual signature immediately.
                    signature_base64: Base64UrlUnpadded::encode_string(&[0u8; 64]),
                };
                let mut candidate = ExternalQualificationCandidateV1 { envelope, payload };
                resign_envelope(&mut candidate, index);
                candidate
            })
            .collect();
        Self {
            candidates,
            trust,
            trust_hash,
        }
    }

    fn update_payload(&mut self, index: usize, change: impl FnOnce(&mut Value)) {
        let candidate = &mut self.candidates[index];
        let mut payload: Value =
            serde_json::from_slice(&candidate.payload).expect("fixture payload JSON");
        change(&mut payload);
        candidate.payload = serde_json::to_vec(&payload).expect("canonical changed payload");
        candidate.envelope.payload_hash = hash_bytes(&candidate.payload);
        resign_envelope(candidate, index);
    }

    fn update_nonce(&mut self, index: usize, nonce: String) {
        self.candidates[index].envelope.nonce = nonce;
        resign_envelope(&mut self.candidates[index], index);
    }

    fn assert_individually_valid(&self) {
        for candidate in &self.candidates {
            let subject = package_subject(candidate.envelope.package_id);
            let verified =
                verify_external_qualification_v1(&candidate.envelope, &subject, NOW, &self.trust)
                    .expect("real envelope signature is valid");
            assert_eq!(verified.payload_hash, hash_bytes(&candidate.payload));
            validate_external_package_payload_v1(
                &candidate.payload,
                &subject,
                &verified.authority_domain_id,
                &verified.signer_key_id,
                NOW,
                1,
                &self.trust,
            )
            .expect("strict individual payload and nested authority signatures are valid");
        }
    }
}

fn resign_envelope(candidate: &mut ExternalQualificationCandidateV1, index: usize) {
    let message =
        qualification_signing_bytes_v1(&candidate.envelope).expect("envelope signing bytes");
    candidate.envelope.signature_base64 =
        Base64UrlUnpadded::encode_string(&reviewer_key(index).sign(&message).to_bytes());
}

struct AcceptanceFixture {
    directory: PathBuf,
    request: ClosureRequestV1,
    signed: SignedPackages,
}

impl AcceptanceFixture {
    fn new(label: &str) -> Self {
        let (directory, ledger) = test_ledger(label);
        let consumer_uid = ledger.owner_uid;
        // Only the private production worker is invoked here, after the real run()
        // file boundary. These paths are never opened and are not ownership proof.
        let authority_uid = if consumer_uid == 0 { 1 } else { 0 };
        let request = ClosureRequestV1 {
            version: 1,
            repository: REQUIRED_REPOSITORY.into(),
            commit: COMMIT.into(),
            tree: TREE.into(),
            consumer_uid,
            trust_store: AuthorityFileV1 {
                path: directory.join("authority-trust.json"),
                owner_uid: authority_uid,
            },
            replay_ledger: ledger,
            envelopes: QualificationPackageIdV1::ALL
                .into_iter()
                .enumerate()
                .map(|(index, package_id)| EnvelopeFileV1 {
                    package_id,
                    path: directory.join(format!("authority-envelope-{index}.json")),
                    owner_uid: authority_uid,
                    payload_path: directory.join(format!("authority-payload-{index}.json")),
                    payload_owner_uid: authority_uid,
                })
                .collect(),
        };
        validate_request(&request).expect("well-shaped request for post-file worker");
        Self {
            directory,
            request,
            signed: SignedPackages::new(),
        }
    }

    fn accept(&self, now: u64) -> Result<ExternalQualificationClosureReceiptV1, ClosureError> {
        let trust = VerifiedClosureTrustContextV1 {
            generation: 1,
            hash: &self.signed.trust_hash,
            previous_hash: None,
            store: &self.signed.trust,
        };
        verify_and_commit_closure(&self.request, &self.signed.candidates, &trust, now)
    }

    fn snapshot(&self) -> Vec<(String, Vec<Vec<SqlValue>>)> {
        let connection = Connection::open_with_flags(
            &self.request.replay_ledger.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .expect("open closed acceptance ledger for logical inspection");
        [
            ("trust_store_state_v1", "singleton"),
            ("verifier_clock_state_v1", "singleton"),
            ("closure_receipt_v1", "receipt_hash"),
            ("replay_nonce_v1", "nonce"),
        ]
        .into_iter()
        .map(|(table, order)| {
            let mut statement = connection
                .prepare(&format!("SELECT * FROM {table} ORDER BY {order}"))
                .expect("inspect complete logical table");
            let columns = statement.column_count();
            let rows = statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|index| row.get::<_, SqlValue>(index))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .expect("logical rows")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("read logical rows");
            (table.to_owned(), rows)
        })
        .collect()
    }

    fn assert_no_ledger(&self) {
        assert!(!self.request.replay_ledger.path.exists());
        assert_eq!(
            fs::read_dir(&self.directory)
                .expect("fixture directory")
                .count(),
            0,
            "rejection must precede ledger creation or sidecar publication"
        );
    }
}

impl Drop for AcceptanceFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

// Independently pin the existing serialized receipt field order and bytes.
// This does not call either assembler or construct Verified* records.
fn legacy_receipt_bytes(signed: &SignedPackages) -> Vec<u8> {
    let quote = |text: &str| serde_json::to_string(text).expect("JSON string");
    let packages = QualificationPackageIdV1::ALL
        .into_iter()
        .map(|package| {
            let candidate = signed
                .candidates
                .iter()
                .find(|candidate| candidate.envelope.package_id == package)
                .expect("all seven fixture candidates");
            let envelope = &candidate.envelope;
            let message_hash =
                hash_bytes(&qualification_signing_bytes_v1(envelope).expect("signing message"));
            format!(
                concat!(
                    "{{\"packageId\":{},\"payloadHash\":{},\"authorityDomainId\":{},",
                    "\"signerKeyId\":{},\"nonce\":{},\"signingMessageHash\":{}}}"
                ),
                quote(package.as_str()),
                quote(&envelope.payload_hash),
                quote(&envelope.authority_domain_id),
                quote(&envelope.signer_key_id),
                quote(&envelope.nonce),
                quote(&message_hash),
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let groups = concat!(
        "{\"codex_account\":[\"codex-account-review\"],",
        "\"governance\":[\"governance-review\"],",
        "\"key_owner\":[\"key-owner-review\"],",
        "\"release_and_cutover\":[\"authority-set-review\",\"cutover-review\"],",
        "\"target_host\":[\"linux-review\",\"storage-review\"]}"
    );
    let body = format!(
        concat!(
            "{{\"version\":1,\"kind\":\"ExternalQualificationClosureReceiptV1\",",
            "\"status\":\"external_qualification_set_verified\",",
            "\"repository\":{},\"commit\":{},\"tree\":{},",
            "\"packages\":[{}],\"authorityGroups\":{},\"allPackagesVerified\":true,",
            "\"automaticActivation\":false,\"productionActivation\":false,",
            "\"sourceStatusUnchanged\":true,\"payloadSemantics\":\"strict_package_v1\",",
            "\"clockRollbackProtection\":true,\"replayLedgerSchemaVersion\":2,",
            "\"trustStoreGeneration\":1,\"trustStoreHash\":{},",
            "\"replayProtection\":\"durable_sqlite_v2\",\"replayLedgerCommitted\":true}}"
        ),
        quote(REQUIRED_REPOSITORY),
        quote(COMMIT),
        quote(TREE),
        packages,
        groups,
        quote(&signed.trust_hash),
    );
    let receipt_hash = hash_bytes(body.as_bytes());
    format!(
        "{},\"receiptHash\":{}}}",
        body.strip_suffix('}').expect("body object"),
        quote(&receipt_hash)
    )
    .into_bytes()
}

#[test]
fn genuine_seven_package_closure_preserves_receipt_bytes_and_exact_replay() {
    let mut fixture = AcceptanceFixture::new("joint-success");
    fixture.signed.assert_individually_valid();
    let expected = legacy_receipt_bytes(&fixture.signed);
    let receipt = fixture.accept(NOW).expect("genuine joint acceptance");
    assert_eq!(
        serde_json::to_vec(&receipt).expect("receipt bytes"),
        expected
    );
    let snapshot = fixture.snapshot();
    assert_eq!(snapshot[0].1.len(), 1);
    assert_eq!(snapshot[1].1.len(), 1);
    assert_eq!(snapshot[2].1.len(), 1);
    assert_eq!(snapshot[3].1.len(), 7);
    assert_eq!(snapshot[2].1[0][4], SqlValue::Blob(expected.clone()));

    fixture.signed.candidates.reverse();
    let replay = fixture.accept(NOW + 1).expect("exact replay is idempotent");
    assert_eq!(
        serde_json::to_vec(&replay).expect("replayed receipt"),
        expected
    );
    let after = fixture.snapshot();
    assert_eq!(after[2], snapshot[2]);
    assert_eq!(after[3], snapshot[3]);
    assert_eq!(after[1].1[0][1], SqlValue::Integer((NOW + 1) as i64));
}

#[test]
fn valid_individual_signatures_with_cross_package_drift_never_create_a_ledger() {
    for (label, index, field) in [
        ("joint-host-drift", 2, "hostIdentityHash"),
        ("joint-database-drift", 5, "databaseIdentityHash"),
    ] {
        let mut fixture = AcceptanceFixture::new(label);
        fixture.signed.update_payload(index, |payload| {
            payload[field] = json!(hash(240));
        });
        fixture.signed.assert_individually_valid();
        assert!(matches!(
            fixture.accept(NOW),
            Err(ClosureError::Closure(
                QualificationClosureError::CrossPackageIdentityMismatch
            ))
        ));
        fixture.assert_no_ledger();
    }
}

#[test]
fn cross_package_drift_does_not_advance_existing_nonce_trust_or_clock_state() {
    for (label, index, field) in [
        ("joint-existing-host-drift", 2, "hostIdentityHash"),
        ("joint-existing-database-drift", 5, "databaseIdentityHash"),
    ] {
        let mut fixture = AcceptanceFixture::new(label);
        fixture.accept(NOW).expect("initial genuine acceptance");
        let before = fixture.snapshot();
        for candidate_index in 0..7 {
            fixture.signed.update_nonce(
                candidate_index,
                format!("new-complete-set-nonce-{candidate_index}"),
            );
        }
        fixture.signed.update_payload(index, |payload| {
            payload[field] = json!(hash(241));
        });
        fixture.signed.assert_individually_valid();
        assert!(matches!(
            fixture.accept(NOW + 10),
            Err(ClosureError::Closure(
                QualificationClosureError::CrossPackageIdentityMismatch
            ))
        ));
        assert_eq!(fixture.snapshot(), before);
    }
}

#[test]
fn invalid_real_envelope_signature_fails_before_replay_creation() {
    let mut fixture = AcceptanceFixture::new("joint-bad-envelope");
    fixture.signed.assert_individually_valid();
    let envelope = &mut fixture.signed.candidates[2].envelope;
    let mut signature =
        Base64UrlUnpadded::decode_vec(&envelope.signature_base64).expect("real signature");
    signature[0] ^= 1;
    envelope.signature_base64 = Base64UrlUnpadded::encode_string(&signature);
    assert!(matches!(
        fixture.accept(NOW),
        Err(ClosureError::Ingest(
            QualificationIngestError::SignatureRejected
        ))
    ));
    fixture.assert_no_ledger();
}

#[test]
fn genuine_outer_signature_cannot_hide_invalid_nested_authority_signature() {
    let mut fixture = AcceptanceFixture::new("joint-bad-inner-signature");
    fixture.signed.assert_individually_valid();
    fixture.signed.update_payload(6, |payload| {
        payload["receipts"][0]["resultHash"] = json!(hash(242));
        // Re-sign the actual reviewer set and the outer envelope. Only the
        // changed inner receipt's genuine authority signature remains invalid.
        sign_authority_set(payload);
    });
    let candidate = &fixture.signed.candidates[6];
    verify_external_qualification_v1(
        &candidate.envelope,
        &package_subject(candidate.envelope.package_id),
        NOW,
        &fixture.signed.trust,
    )
    .expect("changed envelope has a genuine valid signature");
    assert!(matches!(
        fixture.accept(NOW),
        Err(ClosureError::Payload(
            QualificationPayloadError::SignatureInvalid
        ))
    ));
    fixture.assert_no_ledger();
}

#[test]
fn genuine_changed_and_partial_replays_keep_existing_conflict_semantics() {
    let mut fixture = AcceptanceFixture::new("joint-conflicting-replay");
    fixture.accept(NOW).expect("initial genuine acceptance");
    let before = fixture.snapshot();
    fixture.signed.update_payload(2, |payload| {
        payload["bootSequenceHash"] = json!(hash(243));
    });
    fixture.signed.assert_individually_valid();
    assert!(matches!(
        fixture.accept(NOW + 1),
        Err(ClosureError::ReplayConflict)
    ));
    assert_eq!(fixture.snapshot(), before);

    fixture.signed = SignedPackages::new();
    fixture
        .signed
        .update_nonce(0, "one-new-nonce-in-old-set".into());
    fixture.signed.assert_individually_valid();
    assert!(matches!(
        fixture.accept(NOW + 2),
        Err(ClosureError::PartialReplay)
    ));
    assert_eq!(fixture.snapshot(), before);
}

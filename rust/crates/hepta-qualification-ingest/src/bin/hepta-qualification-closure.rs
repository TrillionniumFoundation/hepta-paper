//! Aggregate exact-subject external qualification packages without activating production.
//!
//! This executable verifies every independently signed package envelope for one
//! repository commit/tree, rejects incomplete or authority-collapsed sets, and emits a
//! deterministic non-activating receipt. Package payloads remain content-addressed by
//! their signed hashes and must be schema-validated by the package-specific external
//! executor before publication.

#[cfg(not(unix))]
compile_error!("hepta-qualification-closure requires Unix file identity semantics");

use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::ExitCode,
    time::{SystemTime, UNIX_EPOCH},
};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::VerifyingKey;
use hepta_qualification_ingest::{
    QualificationIngestError, QualificationPackageIdV1, QualificationSubjectV1,
    QualificationTrustStoreV1, VerifiedExternalQualificationV1,
    load_external_qualification_file_v1, verify_external_qualification_v1,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_REQUEST_BYTES: u64 = 1024 * 1024;
const MAXIMUM_TRUST_STORE_BYTES: u64 = 1024 * 1024;
const MAXIMUM_CLOCK_SKEW_MS: u64 = 5 * 60 * 1000;
const REQUIRED_REPOSITORY: &str = "TrillionniumFoundation/hepta-paper";
const REQUIRED_FORBIDDEN_DOMAINS: [&str; 2] = ["implementation-author", "repository-admin"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClosureRequestV1 {
    version: u16,
    repository: String,
    commit: String,
    tree: String,
    now_unix_ms: u64,
    consumer_uid: u32,
    trust_store: AuthorityFileV1,
    envelopes: Vec<EnvelopeFileV1>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorityFileV1 {
    path: PathBuf,
    owner_uid: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnvelopeFileV1 {
    package_id: QualificationPackageIdV1,
    path: PathBuf,
    owner_uid: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QualificationTrustStoreDocumentV1 {
    version: u16,
    keys: Vec<QualificationTrustKeyV1>,
    forbidden_authority_domains: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QualificationTrustKeyV1 {
    authority_domain_id: String,
    signer_key_id: String,
    public_key_base64: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosurePackageReceiptV1 {
    package_id: String,
    payload_hash: String,
    authority_domain_id: String,
    signer_key_id: String,
    nonce: String,
    signing_message_hash: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalQualificationClosureBodyV1 {
    version: u16,
    kind: &'static str,
    status: &'static str,
    repository: String,
    commit: String,
    tree: String,
    packages: Vec<ClosurePackageReceiptV1>,
    authority_groups: BTreeMap<String, Vec<String>>,
    all_packages_verified: bool,
    automatic_activation: bool,
    production_activation: bool,
    source_status_unchanged: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalQualificationClosureReceiptV1 {
    #[serde(flatten)]
    body: ExternalQualificationClosureBodyV1,
    receipt_hash: String,
}

#[derive(Debug, Error)]
enum ClosureError {
    #[error("usage: hepta-qualification-closure <closure-request.json>")]
    Usage,
    #[error("closure request is too large, empty, or invalid")]
    RequestInvalid,
    #[error("closure request consumer UID does not match the effective process UID")]
    ConsumerIdentityMismatch,
    #[error("closure request time differs from the verifier clock beyond the allowed skew")]
    ClockMismatch,
    #[error("verifier system clock is invalid")]
    SystemClockInvalid,
    #[error("authority-owned file boundary is invalid")]
    FileAuthorityInvalid,
    #[error("authority-owned file changed while it was read")]
    FileChanged,
    #[error("trust store is invalid")]
    TrustStoreInvalid,
    #[error("the external qualification package set is incomplete")]
    PackageSetIncomplete,
    #[error("an external qualification package appears more than once")]
    DuplicatePackage,
    #[error("an external qualification nonce appears more than once")]
    DuplicateNonce,
    #[error("an external qualification payload hash appears more than once")]
    DuplicatePayload,
    #[error("an authority domain is reused across independent qualification groups")]
    AuthoritySeparationViolation,
    #[error("external qualification envelope path does not match its declared package")]
    PackageBindingMismatch,
    #[error(transparent)]
    Ingest(#[from] QualificationIngestError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
}

fn main() -> ExitCode {
    match run(env::args_os().collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("external qualification closure rejected: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: Vec<OsString>) -> Result<(), ClosureError> {
    if arguments.len() == 2 && arguments[1] == "--help" {
        println!("usage: hepta-qualification-closure <closure-request.json>");
        println!(
            "verifies all seven signed external qualification packages and emits a non-activating receipt"
        );
        return Ok(());
    }
    if arguments.len() != 2 {
        return Err(ClosureError::Usage);
    }

    let request_path = PathBuf::from(&arguments[1]);
    let request_metadata = fs::metadata(&request_path)?;
    if !request_metadata.is_file()
        || request_metadata.len() == 0
        || request_metadata.len() > MAXIMUM_REQUEST_BYTES
    {
        return Err(ClosureError::RequestInvalid);
    }
    let request_bytes = fs::read(&request_path)?;
    let request: ClosureRequestV1 = serde_json::from_slice(&request_bytes)?;
    validate_request(&request)?;

    let effective_uid = effective_uid()?;
    if request.consumer_uid != effective_uid {
        return Err(ClosureError::ConsumerIdentityMismatch);
    }
    validate_wall_clock(request.now_unix_ms)?;

    let trust_bytes = read_authority_file(
        &request.trust_store.path,
        request.trust_store.owner_uid,
        request.consumer_uid,
        MAXIMUM_TRUST_STORE_BYTES,
    )?;
    let trust_document: QualificationTrustStoreDocumentV1 =
        serde_json::from_slice(&trust_bytes).map_err(|_| ClosureError::TrustStoreInvalid)?;
    let canonical_trust =
        serde_json::to_vec(&trust_document).map_err(|_| ClosureError::TrustStoreInvalid)?;
    if canonical_trust != trust_bytes || trust_document.version != 1 {
        return Err(ClosureError::TrustStoreInvalid);
    }
    let forbidden = trust_document
        .forbidden_authority_domains
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if forbidden.len() != trust_document.forbidden_authority_domains.len() {
        return Err(ClosureError::TrustStoreInvalid);
    }
    if REQUIRED_FORBIDDEN_DOMAINS
        .iter()
        .any(|required| !forbidden.contains(required))
    {
        return Err(ClosureError::TrustStoreInvalid);
    }

    let mut trust_entries = Vec::with_capacity(trust_document.keys.len());
    for key in trust_document.keys {
        let decoded = Base64UrlUnpadded::decode_vec(&key.public_key_base64)
            .map_err(|_| ClosureError::TrustStoreInvalid)?;
        let key_bytes: [u8; 32] = decoded
            .as_slice()
            .try_into()
            .map_err(|_| ClosureError::TrustStoreInvalid)?;
        let verifying_key =
            VerifyingKey::from_bytes(&key_bytes).map_err(|_| ClosureError::TrustStoreInvalid)?;
        trust_entries.push((key.authority_domain_id, key.signer_key_id, verifying_key));
    }
    let trust_store =
        QualificationTrustStoreV1::new(trust_entries, trust_document.forbidden_authority_domains)
            .map_err(|_| ClosureError::TrustStoreInvalid)?;

    let mut verified = Vec::with_capacity(request.envelopes.len());
    for source in &request.envelopes {
        let envelope = load_external_qualification_file_v1(
            &source.path,
            source.owner_uid,
            request.consumer_uid,
        )?;
        if envelope.package_id != source.package_id {
            return Err(ClosureError::PackageBindingMismatch);
        }
        let subject = QualificationSubjectV1 {
            repository: request.repository.clone(),
            commit: request.commit.clone(),
            tree: request.tree.clone(),
            package_id: source.package_id,
        };
        verified.push(verify_external_qualification_v1(
            &envelope,
            &subject,
            request.now_unix_ms,
            &trust_store,
        )?);
    }

    let receipt = assemble_receipt(
        &request.repository,
        &request.commit,
        &request.tree,
        verified,
    )?;
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &receipt)?;
    stdout.write_all(b"\n")?;
    Ok(())
}

fn validate_request(request: &ClosureRequestV1) -> Result<(), ClosureError> {
    if request.version != 1
        || request.repository != REQUIRED_REPOSITORY
        || !valid_git_hash(&request.commit)
        || !valid_git_hash(&request.tree)
        || request.now_unix_ms == 0
        || request.envelopes.len() != QualificationPackageIdV1::ALL.len()
        || !request.trust_store.path.is_absolute()
        || request
            .envelopes
            .iter()
            .any(|source| !source.path.is_absolute())
    {
        return Err(ClosureError::RequestInvalid);
    }
    Ok(())
}

fn assemble_receipt(
    repository: &str,
    commit: &str,
    tree: &str,
    records: Vec<VerifiedExternalQualificationV1>,
) -> Result<ExternalQualificationClosureReceiptV1, ClosureError> {
    let mut by_package = BTreeMap::new();
    let mut nonces = BTreeSet::new();
    let mut payloads = BTreeSet::new();

    for record in records {
        if !nonces.insert(record.nonce.clone()) {
            return Err(ClosureError::DuplicateNonce);
        }
        if !payloads.insert(record.payload_hash.clone()) {
            return Err(ClosureError::DuplicatePayload);
        }
        if by_package.insert(record.package_id, record).is_some() {
            return Err(ClosureError::DuplicatePackage);
        }
    }

    let expected = QualificationPackageIdV1::ALL
        .into_iter()
        .collect::<BTreeSet<_>>();
    if by_package.keys().copied().collect::<BTreeSet<_>>() != expected {
        return Err(ClosureError::PackageSetIncomplete);
    }

    let mut authority_groups = BTreeMap::<String, BTreeSet<String>>::new();
    let mut domain_group = BTreeMap::<String, String>::new();
    for (package, record) in &by_package {
        let group = authority_group(*package).to_owned();
        if let Some(previous) =
            domain_group.insert(record.authority_domain_id.clone(), group.clone())
            && previous != group
        {
            return Err(ClosureError::AuthoritySeparationViolation);
        }
        authority_groups
            .entry(group)
            .or_default()
            .insert(record.authority_domain_id.clone());
    }
    if authority_groups.len() != 5 {
        return Err(ClosureError::AuthoritySeparationViolation);
    }

    let packages = QualificationPackageIdV1::ALL
        .into_iter()
        .map(|package| {
            let record = by_package
                .get(&package)
                .expect("complete package set checked above");
            ClosurePackageReceiptV1 {
                package_id: package.as_str().to_owned(),
                payload_hash: record.payload_hash.clone(),
                authority_domain_id: record.authority_domain_id.clone(),
                signer_key_id: record.signer_key_id.clone(),
                nonce: record.nonce.clone(),
                signing_message_hash: record.signing_message_hash.clone(),
            }
        })
        .collect::<Vec<_>>();
    let authority_groups = authority_groups
        .into_iter()
        .map(|(group, domains)| (group, domains.into_iter().collect()))
        .collect::<BTreeMap<_, _>>();

    let body = ExternalQualificationClosureBodyV1 {
        version: 1,
        kind: "ExternalQualificationClosureReceiptV1",
        status: "external_qualification_set_verified",
        repository: repository.to_owned(),
        commit: commit.to_owned(),
        tree: tree.to_owned(),
        packages,
        authority_groups,
        all_packages_verified: true,
        automatic_activation: false,
        production_activation: false,
        source_status_unchanged: true,
    };
    let body_bytes = serde_json::to_vec(&body)?;
    Ok(ExternalQualificationClosureReceiptV1 {
        body,
        receipt_hash: hash_bytes(&body_bytes),
    })
}

fn authority_group(package: QualificationPackageIdV1) -> &'static str {
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

fn read_authority_file(
    path: &Path,
    expected_owner_uid: u32,
    consumer_uid: u32,
    maximum_bytes: u64,
) -> Result<Vec<u8>, ClosureError> {
    if expected_owner_uid == consumer_uid || !path.is_absolute() {
        return Err(ClosureError::FileAuthorityInvalid);
    }
    let canonical = fs::canonicalize(path).map_err(|_| ClosureError::FileAuthorityInvalid)?;
    if canonical != path {
        return Err(ClosureError::FileAuthorityInvalid);
    }
    inspect_ancestors(path, consumer_uid)?;
    let before = fs::symlink_metadata(path)?;
    let mode = before.mode() & 0o7777;
    if before.file_type().is_symlink()
        || !before.is_file()
        || before.uid() != expected_owner_uid
        || before.nlink() != 1
        || !matches!(mode, 0o400 | 0o440)
        || before.size() == 0
        || before.size() > maximum_bytes
    {
        return Err(ClosureError::FileAuthorityInvalid);
    }

    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)?;
    let opened = file.metadata()?;
    if !same_file(&before, &opened) {
        return Err(ClosureError::FileChanged);
    }
    let capacity =
        usize::try_from(opened.size()).map_err(|_| ClosureError::FileAuthorityInvalid)?;
    let mut bytes = Vec::with_capacity(capacity);
    (&mut file)
        .take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len()).map_err(|_| ClosureError::FileAuthorityInvalid)? != opened.size()
    {
        return Err(ClosureError::FileChanged);
    }
    let after_open = file.metadata()?;
    let after_path = fs::symlink_metadata(path)?;
    if !same_file(&opened, &after_open) || !same_file(&after_open, &after_path) {
        return Err(ClosureError::FileChanged);
    }
    Ok(bytes)
}

fn inspect_ancestors(path: &Path, consumer_uid: u32) -> Result<(), ClosureError> {
    let mut current = path.parent().ok_or(ClosureError::FileAuthorityInvalid)?;
    loop {
        let metadata = fs::symlink_metadata(current)?;
        let canonical = fs::canonicalize(current)?;
        let mode = metadata.mode() & 0o7777;
        if canonical != current
            || metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || mode & 0o022 != 0
            || (metadata.uid() == consumer_uid && mode & 0o200 != 0)
        {
            return Err(ClosureError::FileAuthorityInvalid);
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    Ok(())
}

fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.nlink() == right.nlink()
        && left.size() == right.size()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

#[cfg(target_os = "linux")]
fn effective_uid() -> Result<u32, ClosureError> {
    let status = fs::read_to_string("/proc/self/status")?;
    let line = status
        .lines()
        .find(|line| line.starts_with("Uid:"))
        .ok_or(ClosureError::ConsumerIdentityMismatch)?;
    let mut fields = line.split_whitespace();
    if fields.next() != Some("Uid:") {
        return Err(ClosureError::ConsumerIdentityMismatch);
    }
    let _ = fields.next();
    fields
        .next()
        .ok_or(ClosureError::ConsumerIdentityMismatch)?
        .parse()
        .map_err(|_| ClosureError::ConsumerIdentityMismatch)
}

#[cfg(not(target_os = "linux"))]
fn effective_uid() -> Result<u32, ClosureError> {
    Err(ClosureError::ConsumerIdentityMismatch)
}

fn validate_wall_clock(requested_now_unix_ms: u64) -> Result<(), ClosureError> {
    let observed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ClosureError::SystemClockInvalid)?;
    let observed_now_unix_ms =
        u64::try_from(observed.as_millis()).map_err(|_| ClosureError::SystemClockInvalid)?;
    validate_wall_clock_at(requested_now_unix_ms, observed_now_unix_ms)
}

fn validate_wall_clock_at(
    requested_now_unix_ms: u64,
    observed_now_unix_ms: u64,
) -> Result<(), ClosureError> {
    if requested_now_unix_ms == 0
        || observed_now_unix_ms == 0
        || requested_now_unix_ms.abs_diff(observed_now_unix_ms) > MAXIMUM_CLOCK_SKEW_MS
    {
        return Err(ClosureError::ClockMismatch);
    }
    Ok(())
}
fn valid_git_hash(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hash_bytes(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verified(
        package_id: QualificationPackageIdV1,
        authority_domain_id: &str,
        nonce: &str,
        marker: u8,
    ) -> VerifiedExternalQualificationV1 {
        VerifiedExternalQualificationV1 {
            package_id,
            payload_hash: format!("sha256:{marker:064x}"),
            authority_domain_id: authority_domain_id.to_owned(),
            signer_key_id: format!("key-{marker}"),
            nonce: nonce.to_owned(),
            signing_message_hash: {
                let signing_marker = marker.saturating_add(64);
                format!("sha256:{signing_marker:064x}")
            },
        }
    }

    fn complete_set() -> Vec<VerifiedExternalQualificationV1> {
        vec![
            verified(
                QualificationPackageIdV1::ExtGovMain001,
                "governance-review",
                "nonce-1",
                1,
            ),
            verified(
                QualificationPackageIdV1::ExtHostCgroup001,
                "linux-review",
                "nonce-2",
                2,
            ),
            verified(
                QualificationPackageIdV1::ExtHostStorage001,
                "storage-review",
                "nonce-3",
                3,
            ),
            verified(
                QualificationPackageIdV1::ExtKeyOwner001,
                "key-owner-review",
                "nonce-4",
                4,
            ),
            verified(
                QualificationPackageIdV1::ExtCodexRole001,
                "codex-account-review",
                "nonce-5",
                5,
            ),
            verified(
                QualificationPackageIdV1::ExtCutoverSoak001,
                "cutover-review",
                "nonce-6",
                6,
            ),
            verified(
                QualificationPackageIdV1::ExtAuthoritySet001,
                "authority-set-review",
                "nonce-7",
                7,
            ),
        ]
    }

    #[test]
    fn complete_independent_set_emits_non_activating_receipt() {
        let receipt = assemble_receipt(
            REQUIRED_REPOSITORY,
            &"a".repeat(40),
            &"b".repeat(40),
            complete_set(),
        )
        .expect("complete set");
        assert!(receipt.body.all_packages_verified);
        assert!(!receipt.body.automatic_activation);
        assert!(!receipt.body.production_activation);
        assert!(receipt.body.source_status_unchanged);
        assert_eq!(receipt.body.packages.len(), 7);
        assert_eq!(receipt.body.authority_groups.len(), 5);
        assert!(receipt.receipt_hash.starts_with("sha256:"));
    }

    #[test]
    fn missing_package_fails_closed() {
        let mut records = complete_set();
        records.pop();
        assert!(matches!(
            assemble_receipt(
                REQUIRED_REPOSITORY,
                &"a".repeat(40),
                &"b".repeat(40),
                records,
            ),
            Err(ClosureError::PackageSetIncomplete)
        ));
    }

    #[test]
    fn duplicate_nonce_and_payload_fail_closed() {
        let mut duplicate_nonce = complete_set();
        duplicate_nonce[1].nonce = duplicate_nonce[0].nonce.clone();
        assert!(matches!(
            assemble_receipt(
                REQUIRED_REPOSITORY,
                &"a".repeat(40),
                &"b".repeat(40),
                duplicate_nonce,
            ),
            Err(ClosureError::DuplicateNonce)
        ));

        let mut duplicate_payload = complete_set();
        duplicate_payload[1].payload_hash = duplicate_payload[0].payload_hash.clone();
        assert!(matches!(
            assemble_receipt(
                REQUIRED_REPOSITORY,
                &"a".repeat(40),
                &"b".repeat(40),
                duplicate_payload,
            ),
            Err(ClosureError::DuplicatePayload)
        ));
    }

    #[test]
    fn duplicate_package_fails_closed() {
        let mut records = complete_set();
        records[6].package_id = records[0].package_id;
        assert!(matches!(
            assemble_receipt(
                REQUIRED_REPOSITORY,
                &"a".repeat(40),
                &"b".repeat(40),
                records,
            ),
            Err(ClosureError::DuplicatePackage)
        ));
    }

    #[test]
    fn authority_domain_cannot_cross_independent_groups() {
        let mut records = complete_set();
        records[3].authority_domain_id = records[1].authority_domain_id.clone();
        assert!(matches!(
            assemble_receipt(
                REQUIRED_REPOSITORY,
                &"a".repeat(40),
                &"b".repeat(40),
                records,
            ),
            Err(ClosureError::AuthoritySeparationViolation)
        ));
    }

    #[test]
    fn request_time_is_bounded_to_the_verifier_clock() {
        let observed = 1_800_000_000_000_u64;
        assert!(validate_wall_clock_at(observed, observed).is_ok());
        assert!(validate_wall_clock_at(observed - MAXIMUM_CLOCK_SKEW_MS, observed).is_ok());
        assert!(validate_wall_clock_at(observed + MAXIMUM_CLOCK_SKEW_MS, observed).is_ok());
        assert!(matches!(
            validate_wall_clock_at(observed - MAXIMUM_CLOCK_SKEW_MS - 1, observed),
            Err(ClosureError::ClockMismatch)
        ));
        assert!(matches!(
            validate_wall_clock_at(observed + MAXIMUM_CLOCK_SKEW_MS + 1, observed),
            Err(ClosureError::ClockMismatch)
        ));
    }
    #[test]
    fn help_is_read_only_and_succeeds() {
        assert!(
            run(vec![
                OsString::from("hepta-qualification-closure"),
                OsString::from("--help"),
            ])
            .is_ok()
        );
    }
}

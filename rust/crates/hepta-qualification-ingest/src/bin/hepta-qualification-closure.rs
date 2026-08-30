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
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::VerifyingKey;
use hepta_qualification_ingest::{
    QualificationIngestError, QualificationPackageIdV1, QualificationSubjectV1,
    QualificationTrustStoreV1, VerifiedExternalQualificationV1,
    load_external_qualification_file_v1, verify_external_qualification_v1,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_REQUEST_BYTES: u64 = 1024 * 1024;
const MAXIMUM_TRUST_STORE_BYTES: u64 = 1024 * 1024;
const MAXIMUM_PAYLOAD_BYTES: u64 = 32 * 1024 * 1024;
const MAXIMUM_TRUST_VALIDITY_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const REPLAY_LEDGER_APPLICATION_ID: i32 = 0x4851_4c31;
const REPLAY_LEDGER_USER_VERSION: i32 = 1;
const REQUIRED_REPOSITORY: &str = "TrillionniumFoundation/hepta-paper";
const REQUIRED_FORBIDDEN_DOMAINS: [&str; 3] = [
    "implementation-author",
    "repository-admin",
    "github-hosted-ci",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClosureRequestV1 {
    version: u16,
    repository: String,
    commit: String,
    tree: String,
    consumer_uid: u32,
    trust_store: AuthorityFileV1,
    replay_ledger: PrivateLedgerV1,
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
    payload_path: PathBuf,
    payload_owner_uid: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrivateLedgerV1 {
    path: PathBuf,
    owner_uid: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QualificationTrustStoreDocumentV1 {
    version: u16,
    generation: u64,
    issued_at_unix_ms: u64,
    expires_at_unix_ms: u64,
    previous_trust_store_hash: Option<String>,
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
    trust_store_generation: u64,
    trust_store_hash: String,
    replay_protection: &'static str,
    replay_ledger_committed: bool,
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
    #[error("closure request is too large, empty, aliased, or invalid")]
    RequestInvalid,
    #[error("closure request file authority is invalid")]
    RequestFileInvalid,
    #[error("the signed payload bytes do not match the envelope payload hash")]
    PayloadHashMismatch,
    #[error("the private replay ledger boundary is invalid")]
    ReplayLedgerInvalid,
    #[error("an external qualification nonce conflicts with prior durable acceptance")]
    ReplayConflict,
    #[error("the external qualification set partially overlaps prior durable acceptance")]
    PartialReplay,
    #[error("the qualification trust store generation rolled back")]
    TrustStoreRollback,
    #[error("the qualification trust store chain forked or skipped a generation")]
    TrustStoreFork,
    #[error("the verifier system clock is invalid")]
    ClockInvalid,
    #[error("closure request consumer UID does not match the effective process UID")]
    ConsumerIdentityMismatch,
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
    Sqlite(#[from] rusqlite::Error),
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
            "verifies all seven signed external qualification packages, binds their immutable payloads, and durably reserves their replay nonces"
        );
        return Ok(());
    }
    if arguments.len() != 2 {
        return Err(ClosureError::Usage);
    }

    let effective_uid = effective_uid()?;
    let request_path = PathBuf::from(&arguments[1]);
    let request_bytes = read_private_request_file(&request_path, effective_uid)?;
    let request: ClosureRequestV1 = serde_json::from_slice(&request_bytes)?;
    validate_request(&request)?;
    if request.consumer_uid != effective_uid {
        return Err(ClosureError::ConsumerIdentityMismatch);
    }
    let now_unix_ms = system_unix_ms()?;

    let trust_bytes = read_authority_file(
        &request.trust_store.path,
        request.trust_store.owner_uid,
        request.consumer_uid,
        MAXIMUM_TRUST_STORE_BYTES,
    )?;
    let trust_store_hash = hash_bytes(&trust_bytes);
    let trust_document: QualificationTrustStoreDocumentV1 =
        serde_json::from_slice(&trust_bytes).map_err(|_| ClosureError::TrustStoreInvalid)?;
    let canonical_trust =
        serde_json::to_vec(&trust_document).map_err(|_| ClosureError::TrustStoreInvalid)?;
    if canonical_trust != trust_bytes {
        return Err(ClosureError::TrustStoreInvalid);
    }
    validate_trust_document(&trust_document, now_unix_ms)?;

    let trust_generation = trust_document.generation;
    let previous_trust_store_hash = trust_document.previous_trust_store_hash.clone();
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
        let record =
            verify_external_qualification_v1(&envelope, &subject, now_unix_ms, &trust_store)?;
        let payload_bytes = read_authority_file(
            &source.payload_path,
            source.payload_owner_uid,
            request.consumer_uid,
            MAXIMUM_PAYLOAD_BYTES,
        )?;
        if hash_bytes(&payload_bytes) != envelope.payload_hash {
            return Err(ClosureError::PayloadHashMismatch);
        }
        verified.push(record);
    }

    let receipt = assemble_receipt(
        &request.repository,
        &request.commit,
        &request.tree,
        trust_generation,
        &trust_store_hash,
        verified,
    )?;
    commit_replay_receipt(
        &request.replay_ledger,
        request.consumer_uid,
        trust_generation,
        &trust_store_hash,
        previous_trust_store_hash.as_deref(),
        now_unix_ms,
        &receipt,
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
        || request.envelopes.len() != QualificationPackageIdV1::ALL.len()
        || !request.trust_store.path.is_absolute()
        || !request.replay_ledger.path.is_absolute()
        || request.replay_ledger.owner_uid != request.consumer_uid
        || request.envelopes.iter().any(|source| {
            !source.path.is_absolute()
                || !source.payload_path.is_absolute()
                || source.owner_uid == request.consumer_uid
                || source.payload_owner_uid == request.consumer_uid
        })
    {
        return Err(ClosureError::RequestInvalid);
    }
    let mut paths = BTreeSet::new();
    if !paths.insert(request.trust_store.path.clone())
        || !paths.insert(request.replay_ledger.path.clone())
        || request.envelopes.iter().any(|source| {
            !paths.insert(source.path.clone()) || !paths.insert(source.payload_path.clone())
        })
    {
        return Err(ClosureError::RequestInvalid);
    }
    Ok(())
}

fn assemble_receipt(
    repository: &str,
    commit: &str,
    tree: &str,
    trust_store_generation: u64,
    trust_store_hash: &str,
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
        trust_store_generation,
        trust_store_hash: trust_store_hash.to_owned(),
        replay_protection: "durable_sqlite_v1",
        replay_ledger_committed: true,
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

fn system_unix_ms() -> Result<u64, ClosureError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ClosureError::ClockInvalid)?;
    u64::try_from(duration.as_millis()).map_err(|_| ClosureError::ClockInvalid)
}

fn validate_trust_document(
    trust: &QualificationTrustStoreDocumentV1,
    now_unix_ms: u64,
) -> Result<(), ClosureError> {
    let forbidden = trust
        .forbidden_authority_domains
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let previous_is_valid = match (trust.generation, trust.previous_trust_store_hash.as_deref()) {
        (1, None) => true,
        (generation, Some(hash)) if generation > 1 => valid_sha256(hash),
        _ => false,
    };
    if trust.version != 1
        || trust.generation == 0
        || trust.generation > i64::MAX as u64
        || trust.issued_at_unix_ms == 0
        || trust.issued_at_unix_ms > now_unix_ms
        || trust.expires_at_unix_ms <= now_unix_ms
        || trust.expires_at_unix_ms <= trust.issued_at_unix_ms
        || trust.expires_at_unix_ms - trust.issued_at_unix_ms > MAXIMUM_TRUST_VALIDITY_MS
        || !previous_is_valid
        || forbidden.len() != trust.forbidden_authority_domains.len()
        || REQUIRED_FORBIDDEN_DOMAINS
            .iter()
            .any(|required| !forbidden.contains(required))
    {
        return Err(ClosureError::TrustStoreInvalid);
    }
    Ok(())
}

fn read_private_request_file(path: &Path, owner_uid: u32) -> Result<Vec<u8>, ClosureError> {
    if !path.is_absolute() {
        return Err(ClosureError::RequestFileInvalid);
    }
    inspect_private_parent(path, owner_uid)?;
    let canonical = fs::canonicalize(path).map_err(|_| ClosureError::RequestFileInvalid)?;
    if canonical != path {
        return Err(ClosureError::RequestFileInvalid);
    }
    let before = fs::symlink_metadata(path)?;
    let mode = before.mode() & 0o7777;
    if before.file_type().is_symlink()
        || !before.is_file()
        || before.uid() != owner_uid
        || before.nlink() != 1
        || !matches!(mode, 0o400 | 0o600)
        || before.size() == 0
        || before.size() > MAXIMUM_REQUEST_BYTES
    {
        return Err(ClosureError::RequestFileInvalid);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)?;
    let opened = file.metadata()?;
    if !same_file(&before, &opened) {
        return Err(ClosureError::FileChanged);
    }
    let capacity = usize::try_from(opened.size()).map_err(|_| ClosureError::RequestInvalid)?;
    let mut bytes = Vec::with_capacity(capacity);
    (&mut file)
        .take(MAXIMUM_REQUEST_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len()).map_err(|_| ClosureError::RequestInvalid)? != opened.size() {
        return Err(ClosureError::FileChanged);
    }
    let after_open = file.metadata()?;
    let after_path = fs::symlink_metadata(path)?;
    if !same_file(&opened, &after_open) || !same_file(&after_open, &after_path) {
        return Err(ClosureError::FileChanged);
    }
    Ok(bytes)
}

fn inspect_private_parent(path: &Path, owner_uid: u32) -> Result<(), ClosureError> {
    let parent = path.parent().ok_or(ClosureError::ReplayLedgerInvalid)?;
    let metadata = fs::symlink_metadata(parent)?;
    let canonical = fs::canonicalize(parent)?;
    if canonical != parent
        || metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != owner_uid
        || metadata.mode() & 0o7777 != 0o700
    {
        return Err(ClosureError::ReplayLedgerInvalid);
    }
    Ok(())
}

fn open_replay_ledger(
    ledger: &PrivateLedgerV1,
    consumer_uid: u32,
) -> Result<Connection, ClosureError> {
    if ledger.owner_uid != consumer_uid || !ledger.path.is_absolute() {
        return Err(ClosureError::ReplayLedgerInvalid);
    }
    inspect_private_parent(&ledger.path, consumer_uid)?;
    let parent = ledger
        .path
        .parent()
        .ok_or(ClosureError::ReplayLedgerInvalid)?;
    let created = match fs::symlink_metadata(&ledger.path) {
        Ok(_) => false,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW)
                .open(&ledger.path)?;
            file.sync_all()?;
            let parent_file = OpenOptions::new()
                .read(true)
                .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW | nix::libc::O_DIRECTORY)
                .open(parent)?;
            parent_file.sync_all()?;
            true
        }
        Err(error) => return Err(error.into()),
    };
    let canonical =
        fs::canonicalize(&ledger.path).map_err(|_| ClosureError::ReplayLedgerInvalid)?;
    if canonical != ledger.path {
        return Err(ClosureError::ReplayLedgerInvalid);
    }
    let metadata = fs::symlink_metadata(&ledger.path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != consumer_uid
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o600
    {
        return Err(ClosureError::ReplayLedgerInvalid);
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let connection = Connection::open_with_flags(&ledger.path, flags)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    if created || metadata.size() == 0 {
        initialize_replay_ledger(&connection)?;
    } else {
        let application_id: i32 =
            connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
        let user_version: i32 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if application_id != REPLAY_LEDGER_APPLICATION_ID
            || user_version != REPLAY_LEDGER_USER_VERSION
        {
            return Err(ClosureError::ReplayLedgerInvalid);
        }
    }
    connection.execute_batch(
        "PRAGMA journal_mode=DELETE;\n             PRAGMA synchronous=FULL;\n             PRAGMA foreign_keys=ON;\n             PRAGMA trusted_schema=OFF;\n             PRAGMA secure_delete=ON;\n             PRAGMA temp_store=MEMORY;",
    )?;
    verify_replay_ledger_schema(&connection)?;
    Ok(connection)
}

fn initialize_replay_ledger(connection: &Connection) -> Result<(), ClosureError> {
    let schema = format!(
        "PRAGMA journal_mode=DELETE;\n             PRAGMA synchronous=FULL;\n             PRAGMA foreign_keys=ON;\n             PRAGMA trusted_schema=OFF;\n             PRAGMA secure_delete=ON;\n             PRAGMA application_id={REPLAY_LEDGER_APPLICATION_ID};\n             PRAGMA user_version={REPLAY_LEDGER_USER_VERSION};\n             CREATE TABLE trust_store_state_v1 (\n                 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),\n                 generation INTEGER NOT NULL CHECK (generation > 0),\n                 trust_store_hash TEXT NOT NULL,\n                 previous_trust_store_hash TEXT,\n                 accepted_at_unix_ms INTEGER NOT NULL CHECK (accepted_at_unix_ms > 0)\n             ) STRICT;\n             CREATE TABLE closure_receipt_v1 (\n                 receipt_hash TEXT PRIMARY KEY NOT NULL,\n                 repository TEXT NOT NULL,\n                 commit_hash TEXT NOT NULL,\n                 tree_hash TEXT NOT NULL,\n                 canonical_receipt BLOB NOT NULL,\n                 accepted_at_unix_ms INTEGER NOT NULL CHECK (accepted_at_unix_ms > 0)\n             ) STRICT;\n             CREATE TABLE replay_nonce_v1 (\n                 nonce TEXT PRIMARY KEY NOT NULL,\n                 receipt_hash TEXT NOT NULL,\n                 package_id TEXT NOT NULL,\n                 package_record_hash TEXT NOT NULL,\n                 FOREIGN KEY (receipt_hash) REFERENCES closure_receipt_v1(receipt_hash)\n             ) STRICT;"
    );
    connection.execute_batch(&schema)?;
    Ok(())
}

fn verify_replay_ledger_schema(connection: &Connection) -> Result<(), ClosureError> {
    let quick_check: String =
        connection.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
    if quick_check != "ok" {
        return Err(ClosureError::ReplayLedgerInvalid);
    }
    let mut statement = connection.prepare(
        "SELECT type, name FROM sqlite_schema\n             WHERE name NOT LIKE 'sqlite_%'\n             ORDER BY type, name",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let actual = rows.collect::<Result<Vec<_>, _>>()?;
    let expected = vec![
        ("table".to_owned(), "closure_receipt_v1".to_owned()),
        ("table".to_owned(), "replay_nonce_v1".to_owned()),
        ("table".to_owned(), "trust_store_state_v1".to_owned()),
    ];
    if actual != expected {
        return Err(ClosureError::ReplayLedgerInvalid);
    }
    Ok(())
}

fn commit_replay_receipt(
    ledger: &PrivateLedgerV1,
    consumer_uid: u32,
    trust_store_generation: u64,
    trust_store_hash: &str,
    previous_trust_store_hash: Option<&str>,
    now_unix_ms: u64,
    receipt: &ExternalQualificationClosureReceiptV1,
) -> Result<(), ClosureError> {
    let mut connection = open_replay_ledger(ledger, consumer_uid)?;
    let canonical_receipt = serde_json::to_vec(receipt)?;
    let now = i64::try_from(now_unix_ms).map_err(|_| ClosureError::ClockInvalid)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    advance_trust_store_state(
        &transaction,
        trust_store_generation,
        trust_store_hash,
        previous_trust_store_hash,
        now,
    )?;

    let mut existing = Vec::with_capacity(receipt.body.packages.len());
    for package in &receipt.body.packages {
        let row = transaction
            .query_row(
                "SELECT receipt_hash, package_id, package_record_hash\n                     FROM replay_nonce_v1 WHERE nonce = ?1",
                params![&package.nonce],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        existing.push(row);
    }
    let existing_count = existing.iter().filter(|row| row.is_some()).count();
    if existing_count != 0 && existing_count != receipt.body.packages.len() {
        return Err(ClosureError::PartialReplay);
    }

    if existing_count == 0 {
        transaction.execute(
            "INSERT INTO closure_receipt_v1 (\n                     receipt_hash, repository, commit_hash, tree_hash,\n                     canonical_receipt, accepted_at_unix_ms\n                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &receipt.receipt_hash,
                &receipt.body.repository,
                &receipt.body.commit,
                &receipt.body.tree,
                &canonical_receipt,
                now,
            ],
        )?;
        for package in &receipt.body.packages {
            let package_record_hash = hash_bytes(&serde_json::to_vec(package)?);
            transaction.execute(
                "INSERT INTO replay_nonce_v1 (\n                         nonce, receipt_hash, package_id, package_record_hash\n                     ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    &package.nonce,
                    &receipt.receipt_hash,
                    &package.package_id,
                    &package_record_hash,
                ],
            )?;
        }
    } else {
        for (package, stored) in receipt.body.packages.iter().zip(existing) {
            let stored = stored.ok_or(ClosureError::PartialReplay)?;
            let package_record_hash = hash_bytes(&serde_json::to_vec(package)?);
            if stored.0 != receipt.receipt_hash
                || stored.1 != package.package_id
                || stored.2 != package_record_hash
            {
                return Err(ClosureError::ReplayConflict);
            }
        }
        let stored_receipt = transaction
            .query_row(
                "SELECT canonical_receipt FROM closure_receipt_v1 WHERE receipt_hash = ?1",
                params![&receipt.receipt_hash],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()?;
        if stored_receipt.as_deref() != Some(canonical_receipt.as_slice()) {
            return Err(ClosureError::ReplayConflict);
        }
    }
    transaction.commit()?;
    drop(connection);

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW)
        .open(&ledger.path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != consumer_uid
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o600
    {
        return Err(ClosureError::ReplayLedgerInvalid);
    }
    file.sync_all()?;
    Ok(())
}

fn advance_trust_store_state(
    transaction: &rusqlite::Transaction<'_>,
    generation: u64,
    trust_store_hash: &str,
    previous_trust_store_hash: Option<&str>,
    now_unix_ms: i64,
) -> Result<(), ClosureError> {
    let generation = i64::try_from(generation).map_err(|_| ClosureError::TrustStoreInvalid)?;
    let existing = transaction
        .query_row(
            "SELECT generation, trust_store_hash, previous_trust_store_hash\n                 FROM trust_store_state_v1 WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;
    match existing {
        None => {
            if generation != 1 || previous_trust_store_hash.is_some() {
                return Err(ClosureError::TrustStoreFork);
            }
            transaction.execute(
                "INSERT INTO trust_store_state_v1 (\n                         singleton, generation, trust_store_hash,\n                         previous_trust_store_hash, accepted_at_unix_ms\n                     ) VALUES (1, ?1, ?2, NULL, ?3)",
                params![generation, trust_store_hash, now_unix_ms],
            )?;
        }
        Some((stored_generation, stored_hash, stored_previous)) => {
            if generation < stored_generation {
                return Err(ClosureError::TrustStoreRollback);
            }
            if generation == stored_generation {
                if stored_hash != trust_store_hash
                    || stored_previous.as_deref() != previous_trust_store_hash
                {
                    return Err(ClosureError::TrustStoreFork);
                }
            } else {
                if generation != stored_generation + 1
                    || previous_trust_store_hash != Some(stored_hash.as_str())
                {
                    return Err(ClosureError::TrustStoreFork);
                }
                transaction.execute(
                    "UPDATE trust_store_state_v1\n                         SET generation = ?1, trust_store_hash = ?2,\n                             previous_trust_store_hash = ?3, accepted_at_unix_ms = ?4\n                         WHERE singleton = 1",
                    params![
                        generation,
                        trust_store_hash,
                        previous_trust_store_hash,
                        now_unix_ms,
                    ],
                )?;
            }
        }
    }
    Ok(())
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

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
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
    use std::os::unix::fs::PermissionsExt;

    const TEST_TRUST_HASH: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn assemble_test_receipt(
        repository: &str,
        commit: &str,
        tree: &str,
        records: Vec<VerifiedExternalQualificationV1>,
    ) -> Result<ExternalQualificationClosureReceiptV1, ClosureError> {
        assemble_receipt(repository, commit, tree, 1, TEST_TRUST_HASH, records)
    }

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
        let receipt = assemble_test_receipt(
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
        assert_eq!(receipt.body.trust_store_generation, 1);
        assert_eq!(receipt.body.trust_store_hash, TEST_TRUST_HASH);
        assert_eq!(receipt.body.replay_protection, "durable_sqlite_v1");
        assert!(receipt.body.replay_ledger_committed);
        assert_eq!(receipt.body.packages.len(), 7);
        assert_eq!(receipt.body.authority_groups.len(), 5);
        assert!(receipt.receipt_hash.starts_with("sha256:"));
    }

    #[test]
    fn missing_package_fails_closed() {
        let mut records = complete_set();
        records.pop();
        assert!(matches!(
            assemble_test_receipt(
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
            assemble_test_receipt(
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
            assemble_test_receipt(
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
            assemble_test_receipt(
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
            assemble_test_receipt(
                REQUIRED_REPOSITORY,
                &"a".repeat(40),
                &"b".repeat(40),
                records,
            ),
            Err(ClosureError::AuthoritySeparationViolation)
        ));
    }

    fn test_ledger(label: &str) -> (PathBuf, PrivateLedgerV1) {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = env::temp_dir().join(format!(
            "hepta-qualification-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&directory).expect("create private test directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .expect("private permissions");
        let owner_uid = effective_uid().expect("effective uid");
        let ledger = PrivateLedgerV1 {
            path: directory.join("replay.sqlite"),
            owner_uid,
        };
        (directory, ledger)
    }

    #[test]
    fn replay_ledger_is_durable_idempotent_and_conflict_closed() {
        let (directory, ledger) = test_ledger("replay");
        let receipt = assemble_test_receipt(
            REQUIRED_REPOSITORY,
            &"a".repeat(40),
            &"b".repeat(40),
            complete_set(),
        )
        .expect("receipt");
        commit_replay_receipt(
            &ledger,
            ledger.owner_uid,
            1,
            TEST_TRUST_HASH,
            None,
            10_000,
            &receipt,
        )
        .expect("first durable acceptance");
        commit_replay_receipt(
            &ledger,
            ledger.owner_uid,
            1,
            TEST_TRUST_HASH,
            None,
            10_001,
            &receipt,
        )
        .expect("exact idempotent retry");
        assert_eq!(
            fs::symlink_metadata(&ledger.path)
                .expect("ledger metadata")
                .mode()
                & 0o7777,
            0o600
        );

        let mut conflicting = complete_set();
        conflicting[0].payload_hash = format!("sha256:{}", "f".repeat(64));
        let conflicting_receipt = assemble_test_receipt(
            REQUIRED_REPOSITORY,
            &"a".repeat(40),
            &"b".repeat(40),
            conflicting,
        )
        .expect("conflicting receipt");
        assert!(matches!(
            commit_replay_receipt(
                &ledger,
                ledger.owner_uid,
                1,
                TEST_TRUST_HASH,
                None,
                10_002,
                &conflicting_receipt,
            ),
            Err(ClosureError::ReplayConflict)
        ));
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn replay_ledger_rejects_partial_sets_and_trust_rollback() {
        let (directory, ledger) = test_ledger("partial");
        let receipt = assemble_test_receipt(
            REQUIRED_REPOSITORY,
            &"a".repeat(40),
            &"b".repeat(40),
            complete_set(),
        )
        .expect("receipt");
        commit_replay_receipt(
            &ledger,
            ledger.owner_uid,
            1,
            TEST_TRUST_HASH,
            None,
            20_000,
            &receipt,
        )
        .expect("first acceptance");

        let mut partial = complete_set();
        for (index, record) in partial.iter_mut().enumerate().skip(1) {
            record.nonce = format!("fresh-nonce-{index}");
        }
        let partial_receipt = assemble_test_receipt(
            REQUIRED_REPOSITORY,
            &"a".repeat(40),
            &"b".repeat(40),
            partial,
        )
        .expect("partial receipt");
        assert!(matches!(
            commit_replay_receipt(
                &ledger,
                ledger.owner_uid,
                1,
                TEST_TRUST_HASH,
                None,
                20_001,
                &partial_receipt,
            ),
            Err(ClosureError::PartialReplay)
        ));

        let next_trust_hash =
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let mut rotated_records = complete_set();
        for (index, record) in rotated_records.iter_mut().enumerate() {
            record.nonce = format!("rotated-nonce-{index}");
        }
        let rotated = assemble_receipt(
            REQUIRED_REPOSITORY,
            &"a".repeat(40),
            &"b".repeat(40),
            2,
            next_trust_hash,
            rotated_records,
        )
        .expect("rotated receipt");
        commit_replay_receipt(
            &ledger,
            ledger.owner_uid,
            2,
            next_trust_hash,
            Some(TEST_TRUST_HASH),
            20_002,
            &rotated,
        )
        .expect("chained trust rotation");

        let mut rollback_records = complete_set();
        for (index, record) in rollback_records.iter_mut().enumerate() {
            record.nonce = format!("rollback-nonce-{index}");
        }
        let rollback = assemble_test_receipt(
            REQUIRED_REPOSITORY,
            &"a".repeat(40),
            &"b".repeat(40),
            rollback_records,
        )
        .expect("rollback receipt");
        assert!(matches!(
            commit_replay_receipt(
                &ledger,
                ledger.owner_uid,
                1,
                TEST_TRUST_HASH,
                None,
                20_003,
                &rollback,
            ),
            Err(ClosureError::TrustStoreRollback)
        ));
        fs::remove_dir_all(directory).expect("remove test directory");
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

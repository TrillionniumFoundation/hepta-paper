#!/usr/bin/env python3
from __future__ import annotations

import json
import textwrap
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count == 1:
        return text.replace(old, new, 1)
    if new in text:
        return text
    raise SystemExit(f"{label}: expected exactly one old form, found {count}")


def replace_region(text: str, start: str, end: str, replacement: str, label: str) -> str:
    start_index = text.find(start)
    if start_index < 0:
        if replacement in text:
            return text
        raise SystemExit(f"{label}: start marker missing")
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise SystemExit(f"{label}: end marker missing")
    return text[:start_index] + replacement + text[end_index:]


root = Path(__file__).resolve().parents[2]

cargo_path = root / "rust/crates/hepta-qualification-ingest/Cargo.toml"
cargo = cargo_path.read_text(encoding="utf-8")
cargo = replace_once(
    cargo,
    "nix.workspace = true\n",
    "nix.workspace = true\nrusqlite.workspace = true\n",
    "rusqlite dependency",
)
cargo_path.write_text(cargo, encoding="utf-8")

closure_path = root / "rust/crates/hepta-qualification-ingest/src/bin/hepta-qualification-closure.rs"
closure = closure_path.read_text(encoding="utf-8")
closure = replace_once(
    closure,
    "    os::unix::fs::{MetadataExt, OpenOptionsExt},\n",
    "    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},\n",
    "Unix permission import",
)
closure = replace_once(
    closure,
    "    process::ExitCode,\n};\n",
    "    process::ExitCode,\n    time::{Duration, SystemTime, UNIX_EPOCH},\n};\n",
    "time imports",
)
closure = replace_once(
    closure,
    "use serde::{Deserialize, Serialize};\n",
    "use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};\nuse serde::{Deserialize, Serialize};\n",
    "rusqlite imports",
)
closure = replace_once(
    closure,
    "const MAXIMUM_REQUEST_BYTES: u64 = 1024 * 1024;\nconst MAXIMUM_TRUST_STORE_BYTES: u64 = 1024 * 1024;\nconst REQUIRED_REPOSITORY: &str = \"TrillionniumFoundation/hepta-paper\";\nconst REQUIRED_FORBIDDEN_DOMAINS: [&str; 2] = [\"implementation-author\", \"repository-admin\"];\n",
    "const MAXIMUM_REQUEST_BYTES: u64 = 1024 * 1024;\nconst MAXIMUM_TRUST_STORE_BYTES: u64 = 1024 * 1024;\nconst MAXIMUM_PAYLOAD_BYTES: u64 = 32 * 1024 * 1024;\nconst MAXIMUM_TRUST_VALIDITY_MS: u64 = 30 * 24 * 60 * 60 * 1000;\nconst REPLAY_LEDGER_APPLICATION_ID: i32 = 0x4851_4c31;\nconst REPLAY_LEDGER_USER_VERSION: i32 = 1;\nconst REQUIRED_REPOSITORY: &str = \"TrillionniumFoundation/hepta-paper\";\nconst REQUIRED_FORBIDDEN_DOMAINS: [&str; 3] = [\n    \"implementation-author\",\n    \"repository-admin\",\n    \"github-hosted-ci\",\n];\n",
    "qualification constants",
)
closure = replace_once(
    closure,
    textwrap.dedent(
        """
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
        """
    ),
    textwrap.dedent(
        """
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
        """
    ),
    "closure request contract",
)
closure = replace_once(
    closure,
    textwrap.dedent(
        """
        struct EnvelopeFileV1 {
            package_id: QualificationPackageIdV1,
            path: PathBuf,
            owner_uid: u32,
        }
        """
    ),
    textwrap.dedent(
        """
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
        """
    ),
    "envelope payload and ledger contract",
)
closure = replace_once(
    closure,
    textwrap.dedent(
        """
        struct QualificationTrustStoreDocumentV1 {
            version: u16,
            keys: Vec<QualificationTrustKeyV1>,
            forbidden_authority_domains: Vec<String>,
        }
        """
    ),
    textwrap.dedent(
        """
        struct QualificationTrustStoreDocumentV1 {
            version: u16,
            generation: u64,
            issued_at_unix_ms: u64,
            expires_at_unix_ms: u64,
            previous_trust_store_hash: Option<String>,
            keys: Vec<QualificationTrustKeyV1>,
            forbidden_authority_domains: Vec<String>,
        }
        """
    ),
    "trust store generation contract",
)
closure = replace_once(
    closure,
    "    source_status_unchanged: bool,\n",
    "    source_status_unchanged: bool,\n    trust_store_generation: u64,\n    trust_store_hash: String,\n    replay_protection: &'static str,\n    replay_ledger_committed: bool,\n",
    "receipt trust and replay fields",
)
closure = replace_once(
    closure,
    "    #[error(\"closure request is too large, empty, or invalid\")]\n    RequestInvalid,\n",
    "    #[error(\"closure request is too large, empty, aliased, or invalid\")]\n    RequestInvalid,\n    #[error(\"closure request file authority is invalid\")]\n    RequestFileInvalid,\n    #[error(\"the signed payload bytes do not match the envelope payload hash\")]\n    PayloadHashMismatch,\n    #[error(\"the private replay ledger boundary is invalid\")]\n    ReplayLedgerInvalid,\n    #[error(\"an external qualification nonce conflicts with prior durable acceptance\")]\n    ReplayConflict,\n    #[error(\"the external qualification set partially overlaps prior durable acceptance\")]\n    PartialReplay,\n    #[error(\"the qualification trust store generation rolled back\")]\n    TrustStoreRollback,\n    #[error(\"the qualification trust store chain forked or skipped a generation\")]\n    TrustStoreFork,\n    #[error(\"the verifier system clock is invalid\")]\n    ClockInvalid,\n",
    "closure error variants",
)
closure = replace_once(
    closure,
    "    #[error(transparent)]\n    Json(#[from] serde_json::Error),\n",
    "    #[error(transparent)]\n    Json(#[from] serde_json::Error),\n    #[error(transparent)]\n    Sqlite(#[from] rusqlite::Error),\n",
    "SQLite error variant",
)

run_function = textwrap.dedent(
    r'''
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
        let trust_store = QualificationTrustStoreV1::new(
            trust_entries,
            trust_document.forbidden_authority_domains,
        )
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
            let record = verify_external_qualification_v1(
                &envelope,
                &subject,
                now_unix_ms,
                &trust_store,
            )?;
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

    ''')
closure = replace_region(
    closure,
    "fn run(arguments: Vec<OsString>) -> Result<(), ClosureError> {",
    "fn validate_request(request: &ClosureRequestV1) -> Result<(), ClosureError> {",
    run_function,
    "run function",
)

validate_function = textwrap.dedent(
    r'''
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
            || request
                .envelopes
                .iter()
                .any(|source| !paths.insert(source.path.clone()) || !paths.insert(source.payload_path.clone()))
        {
            return Err(ClosureError::RequestInvalid);
        }
        Ok(())
    }

    ''')
closure = replace_region(
    closure,
    "fn validate_request(request: &ClosureRequestV1) -> Result<(), ClosureError> {",
    "fn assemble_receipt(",
    validate_function,
    "request validation",
)
closure = replace_once(
    closure,
    textwrap.dedent(
        """
        fn assemble_receipt(
            repository: &str,
            commit: &str,
            tree: &str,
            records: Vec<VerifiedExternalQualificationV1>,
        ) -> Result<ExternalQualificationClosureReceiptV1, ClosureError> {
        """
    ),
    textwrap.dedent(
        """
        fn assemble_receipt(
            repository: &str,
            commit: &str,
            tree: &str,
            trust_store_generation: u64,
            trust_store_hash: &str,
            records: Vec<VerifiedExternalQualificationV1>,
        ) -> Result<ExternalQualificationClosureReceiptV1, ClosureError> {
        """
    ),
    "receipt assembly signature",
)
closure = replace_once(
    closure,
    "        source_status_unchanged: true,\n",
    "        source_status_unchanged: true,\n        trust_store_generation,\n        trust_store_hash: trust_store_hash.to_owned(),\n        replay_protection: \"durable_sqlite_v1\",\n        replay_ledger_committed: true,\n",
    "receipt assembly replay fields",
)

helpers = textwrap.dedent(
    r'''
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
                    .custom_flags(
                        nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW | nix::libc::O_DIRECTORY,
                    )
                    .open(parent)?;
                parent_file.sync_all()?;
                true
            }
            Err(error) => return Err(error.into()),
        };
        let canonical = fs::canonicalize(&ledger.path).map_err(|_| ClosureError::ReplayLedgerInvalid)?;
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

    ''')
closure = replace_once(
    closure,
    "fn read_authority_file(\n",
    helpers + "fn read_authority_file(\n",
    "durable replay helpers",
)
closure = replace_once(
    closure,
    "fn valid_git_hash(value: &str) -> bool {\n",
    "fn valid_sha256(value: &str) -> bool {\n    value.strip_prefix(\"sha256:\").is_some_and(|hex| {\n        hex.len() == 64\n            && hex\n                .bytes()\n                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))\n    })\n}\n\nfn valid_git_hash(value: &str) -> bool {\n",
    "SHA-256 validator",
)

split_marker = "#[cfg(test)]\nmod tests {"
prefix, separator, tests = closure.partition(split_marker)
if not separator:
    raise SystemExit("test module marker missing")
tests = tests.replace("assemble_receipt(", "assemble_test_receipt(")
tests = replace_once(
    tests,
    "    use super::*;\n\n",
    "    use super::*;\n\n    const TEST_TRUST_HASH: &str = \"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\";\n\n    fn assemble_test_receipt(\n        repository: &str,\n        commit: &str,\n        tree: &str,\n        records: Vec<VerifiedExternalQualificationV1>,\n    ) -> Result<ExternalQualificationClosureReceiptV1, ClosureError> {\n        assemble_receipt(repository, commit, tree, 1, TEST_TRUST_HASH, records)\n    }\n\n",
    "test receipt helper",
)
tests = replace_once(
    tests,
    "        assert!(receipt.body.source_status_unchanged);\n",
    "        assert!(receipt.body.source_status_unchanged);\n        assert_eq!(receipt.body.trust_store_generation, 1);\n        assert_eq!(receipt.body.trust_store_hash, TEST_TRUST_HASH);\n        assert_eq!(receipt.body.replay_protection, \"durable_sqlite_v1\");\n        assert!(receipt.body.replay_ledger_committed);\n",
    "receipt replay assertions",
)
ledger_tests = textwrap.dedent(
    r'''
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

    ''')
tests = replace_once(
    tests,
    "    #[test]\n    fn help_is_read_only_and_succeeds() {\n",
    ledger_tests + "    #[test]\n    fn help_is_read_only_and_succeeds() {\n",
    "replay ledger tests",
)
closure = prefix + separator + tests
closure_path.write_text(closure, encoding="utf-8")

request_schema_path = root / "docs/rust/qualification/external-qualification-closure-request-v1.schema.json"
request_schema = json.loads(request_schema_path.read_text(encoding="utf-8"))
request_schema["required"] = [
    "version",
    "repository",
    "commit",
    "tree",
    "consumerUid",
    "trustStore",
    "replayLedger",
    "envelopes",
]
request_schema["properties"].pop("nowUnixMs", None)
request_schema["properties"]["replayLedger"] = {"$ref": "#/$defs/privateLedger"}
envelope = request_schema["properties"]["envelopes"]["items"]
envelope["required"] = [
    "packageId",
    "path",
    "ownerUid",
    "payloadPath",
    "payloadOwnerUid",
]
envelope["properties"]["payloadPath"] = {"$ref": "#/$defs/absolutePath"}
envelope["properties"]["payloadOwnerUid"] = {"type": "integer", "minimum": 0}
request_schema["$defs"]["privateLedger"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["path", "ownerUid"],
    "properties": {
        "path": {"$ref": "#/$defs/absolutePath"},
        "ownerUid": {"type": "integer", "minimum": 0},
    },
}
request_schema_path.write_text(json.dumps(request_schema, indent=2) + "\n", encoding="utf-8")

receipt_schema_path = root / "docs/rust/qualification/external-qualification-closure-receipt-v1.schema.json"
receipt_schema = json.loads(receipt_schema_path.read_text(encoding="utf-8"))
required = receipt_schema["required"]
for field in [
    "trustStoreGeneration",
    "trustStoreHash",
    "replayProtection",
    "replayLedgerCommitted",
]:
    if field not in required:
        required.insert(required.index("receiptHash"), field)
receipt_schema["properties"]["trustStoreGeneration"] = {"type": "integer", "minimum": 1}
receipt_schema["properties"]["trustStoreHash"] = {"$ref": "#/$defs/sha256"}
receipt_schema["properties"]["replayProtection"] = {"const": "durable_sqlite_v1"}
receipt_schema["properties"]["replayLedgerCommitted"] = {"const": True}
receipt_schema_path.write_text(json.dumps(receipt_schema, indent=2) + "\n", encoding="utf-8")

trust_schema = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trillionnium.example/schemas/qualification-trust-store-v1.schema.json",
    "title": "Qualification Trust Store V1",
    "type": "object",
    "additionalProperties": False,
    "required": [
        "version",
        "generation",
        "issuedAtUnixMs",
        "expiresAtUnixMs",
        "previousTrustStoreHash",
        "keys",
        "forbiddenAuthorityDomains",
    ],
    "properties": {
        "version": {"const": 1},
        "generation": {"type": "integer", "minimum": 1},
        "issuedAtUnixMs": {"type": "integer", "minimum": 1},
        "expiresAtUnixMs": {"type": "integer", "minimum": 1},
        "previousTrustStoreHash": {
            "oneOf": [{"type": "null"}, {"$ref": "#/$defs/sha256"}]
        },
        "keys": {
            "type": "array",
            "minItems": 1,
            "maxItems": 128,
            "uniqueItems": True,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["authorityDomainId", "signerKeyId", "publicKeyBase64"],
                "properties": {
                    "authorityDomainId": {"$ref": "#/$defs/id"},
                    "signerKeyId": {"$ref": "#/$defs/id"},
                    "publicKeyBase64": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9_-]{43}$",
                    },
                },
            },
        },
        "forbiddenAuthorityDomains": {
            "type": "array",
            "minItems": 3,
            "maxItems": 128,
            "uniqueItems": True,
            "items": {"$ref": "#/$defs/id"},
            "allOf": [
                {"contains": {"const": "implementation-author"}},
                {"contains": {"const": "repository-admin"}},
                {"contains": {"const": "github-hosted-ci"}},
            ],
        },
    },
    "$defs": {
        "sha256": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"},
        "id": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$",
        },
    },
}
(root / "docs/rust/qualification/qualification-trust-store-v1.schema.json").write_text(
    json.dumps(trust_schema, indent=2) + "\n",
    encoding="utf-8",
)

closure_document = """# External qualification closure verifier

Status: **repository-local verifier; never an external authority or activation permit**

`hepta-qualification-closure` closes the repository-side aggregation gap between
individually signed qualification envelopes, their immutable payload bytes and one
exact-subject closure receipt. It does not manufacture any target-host, credential,
key-custody, release, storage, portal or submission fact.

## Inputs

The executable accepts a private request matching
`external-qualification-closure-request-v1.schema.json`:

```text
hepta-qualification-closure /absolute/private/closure-request.json
```

The request file must be a canonical, single-link `0400` or `0600` regular file
owned by the verifier UID inside an immediate verifier-owned `0700` directory.
The verifier uses its operating-system clock; request-controlled timestamps cannot
revive expired evidence.

The request binds one exact repository commit/tree, the effective consumer UID,
one separately owned canonical trust store, one private durable replay ledger and
exactly one envelope plus immutable payload file for every package:

```text
EXT-GOV-MAIN-001
EXT-HOST-CGROUP-001
EXT-HOST-STORAGE-001
EXT-KEY-OWNER-001
EXT-CODEX-ROLE-001
EXT-CUTOVER-SOAK-001
EXT-AUTHORITY-SET-001
```

The trust store and external files must be canonical regular files owned outside
the verifier UID, single-linked, read-only (`0400` or `0440`), opened with
`O_NOFOLLOW|O_CLOEXEC`, bounded before and during reads, and unchanged across
full descriptor/path metadata revalidation. Every payload byte sequence is hashed
and must equal the signed envelope `payloadHash`; package-specific schema and
semantic validation remains the responsibility of the named external executor.

The trust store matches `qualification-trust-store-v1.schema.json`, has a bounded
validity interval, and carries a monotonically chained generation. Generation 1
has no predecessor; every later generation names the exact SHA-256 hash of the
previous canonical trust store. It must forbid at least `implementation-author`,
`repository-admin` and `github-hosted-ci`. Identical Ed25519 public-key material
cannot be aliased under multiple authority domains.

## Atomic set and replay rules

The verifier fails closed unless:

1. all seven package IDs occur exactly once;
2. every package signature verifies for the exact repository, commit, tree and package;
3. every immutable payload matches its signed hash;
4. every nonce and signed payload hash is unique within the set;
5. one authority domain or public key is not reused across independent governance,
   target-host, key-owner, Codex-account and release/cutover groups;
6. the request consumer UID equals the running process effective UID;
7. the private replay ledger is a canonical single-link `0600` SQLite file in a
   verifier-owned `0700` directory;
8. trust-store generation/hash chaining and all seven nonce reservations commit
   together under `BEGIN IMMEDIATE`, `journal_mode=DELETE` and `synchronous=FULL`.

An exact retry of the same seven-package receipt is idempotent and returns the
same deterministic receipt. A partial overlap, nonce reuse with different content,
trust rollback, generation skip or same-generation trust fork is rejected and
commits no state.

## Output

Success emits a compact JSON object matching
`external-qualification-closure-receipt-v1.schema.json`. Its deterministic
`receiptHash` binds the ordered package receipts, authority-group partition,
trust-store generation/hash and the durable replay contract. It always states:

```text
allPackagesVerified=true
automaticActivation=false
productionActivation=false
sourceStatusUnchanged=true
replayProtection=durable_sqlite_v1
replayLedgerCommitted=true
```

The receipt proves only that the complete externally produced package set and its
payload bytes were cryptographically verified and durably replay-fenced for one
exact candidate. A separate, independently authorized transition is still required
to change canonical gap status, merge source, provision credentials, cut over a
writer, release an artifact or submit a paper.

## Failure and recovery

Missing, duplicated, expired, mismatched, self-authorized, authority-collapsed,
aliased, writable, replaced, partially replayed or trust-rollback inputs exit
nonzero and emit no receipt. Correct the external publication and run again.
Only an exact already-committed retry is recoverable without fresh nonces.
"""
(root / "docs/rust/qualification/EXTERNAL_QUALIFICATION_CLOSURE.md").write_text(
    closure_document,
    encoding="utf-8",
)

runbook = """# External evidence ingestion runbook

## Preconditions

- candidate Git commit and tree are immutable and independently identified;
- each package payload passes its JSON Schema and package-specific semantic checks;
- every immutable payload file hashes exactly to the signed envelope `payloadHash`;
- the external signer domain/key is present in a canonical trust store matching
  `qualification-trust-store-v1.schema.json`;
- trust generation is current and chained to the previously accepted trust-store hash;
- implementation-author, repository-admin and GitHub-hosted CI domains are forbidden;
- envelope, payload and trust files are canonical, single-link, authority-owned and
  read-only below ancestors the verifier principal cannot modify;
- the request and replay ledger reside in a verifier-owned private `0700` directory.

## Verification sequence

1. Read the private request with no-follow, close-on-exec and bounded exact-length checks.
2. Obtain current time from the verifier operating system, never from request input.
3. Open trust, envelope and payload files with no-follow and close-on-exec semantics.
4. Recheck path/descriptor device, inode, owner, mode, link count, size and timestamps.
5. Require canonical JSON and the closed V1 field vocabulary.
6. Bind repository, package, exact commit, exact tree and exact payload bytes/hash.
7. Check evidence and trust issue/expiry times and bounded validity windows.
8. Reject forbidden/unknown domains, duplicate public-key aliases and bad signatures.
9. Under one private SQLite `BEGIN IMMEDIATE` transaction, reject partial/conflicting
   nonce replay, enforce trust generation/hash chaining, and persist all seven nonce
   reservations plus the canonical aggregate receipt.
10. Emit the receipt only after durable commit; exact retries are idempotent.
11. Require an independent governance decision before changing an external gap to
    `externally_accepted`.

## Failure handling

A path change, noncanonical encoding, stale record, subject/payload mismatch,
signature failure, partial/conflicting replay, forbidden domain, trust rollback,
trust fork or ambiguous database state rejects the entire operation. Partial
validation grants no retained authority and the SQLite transaction rolls back.

Evidence acceptance never performs any of the following automatically:

```text
merge a pull request
change main
load Codex credentials
start a live provider call
transfer campaign-writer ownership
sign or publish a release
write WORM custody state
mutate a portal
submit a paper
```
"""
(root / "docs/rust/qualification/EXTERNAL_EVIDENCE_INGESTION_RUNBOOK.md").write_text(
    runbook,
    encoding="utf-8",
)

readme_path = root / "docs/rust/qualification/README.md"
readme = readme_path.read_text(encoding="utf-8")
if "qualification-trust-store-v1.schema.json" not in readme:
    readme += "\n## Aggregate trust and replay boundary\n\nThe aggregate verifier uses `qualification-trust-store-v1.schema.json`, immutable\npayload hash binding and a private durable SQLite nonce/trust-generation ledger.\nSee `EXTERNAL_QUALIFICATION_CLOSURE.md`.\n"
readme_path.write_text(readme, encoding="utf-8")

external_workflow_path = root / ".github/workflows/rust-plan-v3-external-contracts.yml"
external_workflow = external_workflow_path.read_text(encoding="utf-8")
external_workflow = replace_once(
    external_workflow,
    "              'external-qualification-closure-receipt-v1.schema.json',\n",
    "              'external-qualification-closure-receipt-v1.schema.json',\n              'qualification-trust-store-v1.schema.json',\n",
    "trust schema workflow coverage",
)
external_workflow = replace_once(
    external_workflow,
    "              'AuthoritySeparationViolation',\n",
    "              'AuthoritySeparationViolation',\n              'PayloadHashMismatch',\n              'ReplayConflict',\n              'PartialReplay',\n              'TrustStoreRollback',\n              'TrustStoreFork',\n",
    "closure failure coverage",
)
external_workflow = replace_once(
    external_workflow,
    "              'source_status_unchanged: true',\n",
    "              'source_status_unchanged: true',\n              'replay_ledger_committed: true',\n              'system_unix_ms()',\n",
    "closure replay workflow coverage",
)
external_workflow = replace_once(
    external_workflow,
    "              assert required in closure_source, required\n",
    "              assert required in closure_source, required\n          assert 'request.now_unix_ms' not in closure_source\n          request_schema = json.loads((\n              root / 'external-qualification-closure-request-v1.schema.json'\n          ).read_text(encoding='utf-8'))\n          assert 'nowUnixMs' not in request_schema['properties']\n          assert 'replayLedger' in request_schema['required']\n          envelope_required = set(\n              request_schema['properties']['envelopes']['items']['required']\n          )\n          assert {'payloadPath', 'payloadOwnerUid'} <= envelope_required\n",
    "caller-time and payload workflow assertions",
)
external_workflow_path.write_text(external_workflow, encoding="utf-8")

artifacts_workflow_path = root / ".github/workflows/rust-qualification-artifacts.yml"
artifacts_workflow = artifacts_workflow_path.read_text(encoding="utf-8")
artifacts_workflow = replace_once(
    artifacts_workflow,
    '              "external-qualification-closure-receipt-v1.schema.json",\n',
    '              "external-qualification-closure-receipt-v1.schema.json",\n              "qualification-trust-store-v1.schema.json",\n',
    "artifact trust schema coverage",
)
artifacts_workflow = replace_once(
    artifacts_workflow,
    "          cargo test --manifest-path rust/Cargo.toml \\\n            -p hepta-qualification-ingest \\\n            --bin hepta-qualification-closure \\\n            --locked\n",
    "          cargo test --manifest-path rust/Cargo.toml \\\n            -p hepta-qualification-ingest \\\n            --all-features --locked\n",
    "full qualification crate tests",
)
artifacts_workflow_path.write_text(artifacts_workflow, encoding="utf-8")

for json_path in [
    request_schema_path,
    receipt_schema_path,
    root / "docs/rust/qualification/qualification-trust-store-v1.schema.json",
]:
    json.loads(json_path.read_text(encoding="utf-8"))

print("external qualification persistence hardening staged")

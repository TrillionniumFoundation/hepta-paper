use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use hepta_codex_journal::OperationState;
use hepta_codex_protocol::{
    AgentRole, ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy, RequestCapabilityV1,
    SandboxPolicy, SessionPolicy, Sha256Digest, TaskKind, Transport,
};

use crate::{
    AuthenticatedBrokerRequestV1, PeerIdentityV1, VerifiedCapabilityV1, capability_signing_bytes,
};

use super::{
    codec::sha256_digest,
    path::{INITIALIZATION_MARKER_BYTES, INITIALIZATION_MARKER_SUFFIX},
    store::{
        BrokerJournalError, BrokerJournalPolicyV1, BrokerJournalStoreV1, FaultInjectionPointV1,
        ReservationOutcomeV1,
    },
};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

struct TempJournal {
    root: PathBuf,
    path: PathBuf,
    owner_uid: u32,
}

impl TempJournal {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "hepta-codex-journal-{}-{nonce}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir(&root).expect("create journal root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .expect("private journal root");
        let owner_uid = fs::metadata(&root).expect("root metadata").uid();
        let path = root.join("broker.sqlite");
        Self {
            root,
            path,
            owner_uid,
        }
    }

    fn open(&self) -> BrokerJournalStoreV1 {
        BrokerJournalStoreV1::open(&self.path, BrokerJournalPolicyV1::strict(self.owner_uid))
            .expect("open broker journal")
    }
}

impl Drop for TempJournal {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn sidecar_path(database: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{}", database.display(), suffix))
}

fn wait_for_file(path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.is_file() {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {}", path.display());
}

fn kill_worker_at_fault(fixture: &TempJournal, action: &str, operation_id: &str, fault_name: &str) {
    let ready = fixture
        .root
        .join(format!("sigkill-{action}-{fault_name}.ready"));
    let mut child = Command::new(std::env::current_exe().expect("current test executable"))
        .arg("--exact")
        .arg("journal::tests::sigkill_crash_worker")
        .arg("--ignored")
        .arg("--nocapture")
        .env("HEPTA_TEST_JOURNAL_ROOT", &fixture.root)
        .env("HEPTA_TEST_SIGKILL_ACTION", action)
        .env("HEPTA_TEST_SIGKILL_OPERATION", operation_id)
        .env("HEPTA_TEST_SIGKILL_POINT", fault_name)
        .env("HEPTA_TEST_SIGKILL_READY", &ready)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn SIGKILL crash worker");
    wait_for_file(&ready, Duration::from_secs(10));
    child.kill().expect("SIGKILL crash worker");
    let status = child.wait().expect("reap SIGKILL crash worker");
    assert!(!status.success());
    let _ = fs::remove_file(ready);
}

fn digest(byte: char) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64))).expect("test digest")
}

fn admitted(operation_id: &str, nonce: &str, idempotency: char) -> AuthenticatedBrokerRequestV1 {
    let peer = PeerIdentityV1 {
        pid: 42,
        uid: 1000,
        gid: 1000,
    };
    let request = CodexExecutionRequestV1 {
        version: 1,
        operation_id: operation_id.into(),
        idempotency_key: digest(idempotency),
        campaign_id: "campaign-1".into(),
        node_id: "node-1".into(),
        attempt_id: "attempt-1".into(),
        lease_generation: 1,
        campaign_revision: 0,
        role: AgentRole::Author,
        task_kind: TaskKind::Draft,
        codex_runtime_identity_hash: digest('2'),
        model_selector: "qualified-model".into(),
        transport: Transport::ExecJsonlV1,
        session_policy: SessionPolicy::EphemeralNewThread,
        prompt_envelope_hash: digest('3'),
        input_manifest_hash: digest('4'),
        workspace_identity_hash: digest('5'),
        output_schema_hash: digest('6'),
        mutation_policy_hash: digest('7'),
        sandbox_policy: SandboxPolicy::WorkspaceWrite,
        network_policy: NetworkPolicy::None,
        approval_policy: ApprovalPolicy::Never,
        absolute_deadline_unix_ms: 20_000,
        maximum_output_bytes: 1024,
        maximum_event_count: 100,
        maximum_cost_microusd: 1_000_000,
        remaining_token_hint: Some(10_000),
        request_capability: RequestCapabilityV1 {
            nonce: nonce.into(),
            issued_at_unix_ms: 10_000,
            expires_at_unix_ms: 15_000,
            signer_key_id: "key-1".into(),
            peer_uid: peer.uid,
            peer_gid: peer.gid,
            signature_base64: "A".repeat(86),
        },
    };
    let signing_message = capability_signing_bytes(&request).expect("capability message");
    let signing_message_hash = sha256_digest(&signing_message).expect("capability hash");
    let request_payload = serde_json::to_vec(&request).expect("request payload");
    let request_hash = sha256_digest(&request_payload).expect("request hash");
    AuthenticatedBrokerRequestV1 {
        request,
        request_payload,
        request_hash,
        peer,
        capability: VerifiedCapabilityV1 {
            signer_key_id: "key-1".into(),
            nonce: nonce.into(),
            peer_uid: peer.uid,
            peer_gid: peer.gid,
            signing_message_hash,
        },
    }
}

#[test]
fn exact_duplicate_returns_existing_without_second_nonce_or_time_drift() {
    let fixture = TempJournal::new();
    let mut store = fixture.open();
    let request = admitted("operation-1", "nonce-1", '1');
    let reserved = store
        .reserve_operation(&request, 12_000, FaultInjectionPointV1::None)
        .expect("first reservation");
    assert!(matches!(reserved, ReservationOutcomeV1::Reserved(_)));

    // Arrival time is a broker observation, not immutable caller identity. Exercise
    // both a near retry and the latest still-authenticated retry.
    for retry_time in [12_001, 14_999] {
        let existing = store
            .reserve_operation(&request, retry_time, FaultInjectionPointV1::None)
            .expect("idempotent reservation");
        let ReservationOutcomeV1::Existing(journal) = existing else {
            panic!("duplicate must return the existing journal");
        };
        assert_eq!(journal.current_state, OperationState::Reserved);
        assert!(journal.transitions.is_empty());
    }

    assert_eq!(store.operation_count().expect("operation count"), 1);
    let connection = rusqlite::Connection::open_with_flags(
        &fixture.path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
            | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .expect("read-only duplicate audit");
    let (created_at, nonce_count, transition_count): (i64, i64, i64) = connection
        .query_row(
            "SELECT operation.created_at_unix_ms,
                    (SELECT count(*) FROM capability_nonces WHERE operation_id = operation.operation_id),
                    (SELECT count(*) FROM operation_transitions WHERE operation_id = operation.operation_id)
             FROM operations AS operation WHERE operation.operation_id = ?1",
            [&request.request.operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("duplicate audit row");
    assert_eq!(created_at, 12_000);
    assert_eq!(nonce_count, 1);
    assert_eq!(transition_count, 0);
}

#[test]
fn exact_duplicate_survives_restart_without_reopening_the_journal() {
    let fixture = TempJournal::new();
    let request = admitted(
        "operation-restart-duplicate",
        "nonce-restart-duplicate",
        'a',
    );
    {
        let mut store = fixture.open();
        assert!(matches!(
            store
                .reserve_operation(&request, 12_000, FaultInjectionPointV1::None)
                .expect("first reservation"),
            ReservationOutcomeV1::Reserved(_),
        ));
    }

    let mut reopened = fixture.open();
    let existing = reopened
        .reserve_operation(&request, 14_999, FaultInjectionPointV1::None)
        .expect("duplicate after restart");
    let ReservationOutcomeV1::Existing(journal) = existing else {
        panic!("restart duplicate must return existing");
    };
    assert_eq!(journal.current_state, OperationState::Reserved);
    assert!(journal.transitions.is_empty());
    assert_eq!(reopened.operation_count().expect("operation count"), 1);
}

#[test]
fn rejects_nonce_replay_and_idempotency_conflict() {
    let fixture = TempJournal::new();
    let mut store = fixture.open();
    let first = admitted("operation-1", "nonce-shared", '1');
    store
        .reserve_operation(&first, 12_000, FaultInjectionPointV1::None)
        .expect("first reservation");
    let replay = admitted("operation-2", "nonce-shared", '2');
    assert!(matches!(
        store.reserve_operation(&replay, 12_001, FaultInjectionPointV1::None),
        Err(BrokerJournalError::CapabilityNonceReplay),
    ));
    let conflict = admitted("operation-3", "nonce-3", '1');
    assert!(matches!(
        store.reserve_operation(&conflict, 12_002, FaultInjectionPointV1::None),
        Err(BrokerJournalError::IdempotencyConflict),
    ));
}

#[test]
fn expired_authenticated_request_cannot_consume_nonce_or_operation_id() {
    let fixture = TempJournal::new();
    let mut store = fixture.open();
    let request = admitted("operation-expired", "nonce-expired", '8');
    assert!(matches!(
        store.reserve_operation(&request, 15_000, FaultInjectionPointV1::None),
        Err(BrokerJournalError::AuthenticatedRequestExpired),
    ));
    assert_eq!(store.operation_count().expect("operation count"), 0);
}

#[test]
fn sigkill_during_reservation_and_transition_leaves_only_atomic_state() {
    let fixture = TempJournal::new();
    fixture
        .open()
        .validate_integrity()
        .expect("initial journal");

    for (index, fault_name) in ["after_operation_insert", "after_nonce_insert"]
        .into_iter()
        .enumerate()
    {
        let operation_id = format!("operation-sigkill-reservation-{index}");
        kill_worker_at_fault(&fixture, "reserve", &operation_id, fault_name);
        let reopened = fixture.open();
        assert_eq!(reopened.operation_count().expect("operation count"), 0);
        reopened
            .validate_integrity()
            .expect("reservation SIGKILL integrity");
    }

    for (index, fault_name) in ["after_transition_insert", "after_projection_update"]
        .into_iter()
        .enumerate()
    {
        let operation_id = format!("operation-sigkill-transition-{index}");
        {
            let mut store = fixture.open();
            let request = admitted(
                &operation_id,
                &format!("nonce-sigkill-transition-{index}"),
                char::from(b'b' + u8::try_from(index).expect("small index")),
            );
            store
                .reserve_operation(&request, 12_000, FaultInjectionPointV1::None)
                .expect("reserve transition SIGKILL operation");
        }
        kill_worker_at_fault(&fixture, "transition", &operation_id, fault_name);
        let reopened = fixture.open();
        let journal = reopened
            .load_journal(&operation_id)
            .expect("journal after transition SIGKILL");
        assert_eq!(journal.current_state, OperationState::Reserved);
        assert!(journal.transitions.is_empty());
        reopened
            .validate_integrity()
            .expect("transition SIGKILL integrity");
    }
}

#[test]
fn corrupt_database_and_sidecar_or_permission_drift_fail_closed() {
    let fixture = TempJournal::new();
    fixture
        .open()
        .validate_integrity()
        .expect("initial journal");

    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o400))
        .expect("make journal read-only");
    assert!(matches!(
        BrokerJournalStoreV1::open(
            &fixture.path,
            BrokerJournalPolicyV1::strict(fixture.owner_uid),
        ),
        Err(BrokerJournalError::DatabaseFilePermissionsInvalid(0o400)),
    ));
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o600))
        .expect("restore journal mode");

    let wal = sidecar_path(&fixture.path, "-wal");
    fs::write(&wal, b"foreign-wal").expect("write invalid WAL sidecar");
    fs::set_permissions(&wal, fs::Permissions::from_mode(0o666))
        .expect("weaken invalid WAL sidecar");
    assert!(matches!(
        BrokerJournalStoreV1::open(
            &fixture.path,
            BrokerJournalPolicyV1::strict(fixture.owner_uid),
        ),
        Err(BrokerJournalError::DatabaseSidecarPermissionsInvalid { .. }),
    ));
    fs::remove_file(&wal).expect("remove invalid WAL sidecar");

    let mut bytes = fs::read(&fixture.path).expect("read journal before corruption");
    assert!(!bytes.is_empty());
    bytes[0] ^= 0xff;
    fs::write(&fixture.path, bytes).expect("corrupt main database");
    assert!(
        BrokerJournalStoreV1::open(
            &fixture.path,
            BrokerJournalPolicyV1::strict(fixture.owner_uid),
        )
        .is_err()
    );
}

#[test]
#[ignore = "subprocess worker for SIGKILL crash qualification"]
fn sigkill_crash_worker() {
    let root = PathBuf::from(
        std::env::var_os("HEPTA_TEST_JOURNAL_ROOT").expect("journal root environment"),
    );
    let path = root.join("broker.sqlite");
    let owner_uid = fs::metadata(&root).expect("journal root metadata").uid();
    let operation_id =
        std::env::var("HEPTA_TEST_SIGKILL_OPERATION").expect("SIGKILL operation environment");
    let fault_name = std::env::var("HEPTA_TEST_SIGKILL_POINT").expect("SIGKILL point environment");
    let fault = match fault_name.as_str() {
        "after_operation_insert" => FaultInjectionPointV1::AfterOperationInsert,
        "after_nonce_insert" => FaultInjectionPointV1::AfterNonceInsert,
        "after_transition_insert" => FaultInjectionPointV1::AfterTransitionInsert,
        "after_projection_update" => FaultInjectionPointV1::AfterProjectionUpdate,
        _ => panic!("unknown SIGKILL point: {fault_name}"),
    };
    let mut store = BrokerJournalStoreV1::open(&path, BrokerJournalPolicyV1::strict(owner_uid))
        .expect("open crash worker journal");
    match std::env::var("HEPTA_TEST_SIGKILL_ACTION")
        .expect("SIGKILL action environment")
        .as_str()
    {
        "reserve" => {
            let request = admitted(&operation_id, "nonce-sigkill-worker", 'f');
            let _ = store.reserve_operation(&request, 12_000, fault);
        }
        "transition" => {
            let _ = store.append_transition(
                &operation_id,
                OperationState::Reserved,
                OperationState::RequestBound,
                12_001,
                None,
                None,
                fault,
            );
        }
        action => panic!("unknown SIGKILL action: {action}"),
    }
    panic!("SIGKILL worker passed its fault point without being killed");
}

#[test]
fn reservation_faults_roll_back_operation_and_nonce() {
    for fault in [
        FaultInjectionPointV1::AfterOperationInsert,
        FaultInjectionPointV1::AfterNonceInsert,
    ] {
        let fixture = TempJournal::new();
        let mut store = fixture.open();
        let request = admitted("operation-1", "nonce-1", '1');
        assert!(matches!(
            store.reserve_operation(&request, 12_000, fault),
            Err(BrokerJournalError::InjectedFault(observed)) if observed == fault,
        ));
        assert_eq!(store.operation_count().expect("operation count"), 0);
        drop(store);
        let mut reopened = fixture.open();
        assert_eq!(reopened.operation_count().expect("reopened count"), 0);
        assert!(matches!(
            reopened
                .reserve_operation(&request, 12_001, FaultInjectionPointV1::None)
                .expect("reservation after rollback and reopen"),
            ReservationOutcomeV1::Reserved(_),
        ));
    }
}

#[test]
fn transition_faults_roll_back_projection_and_append() {
    for fault in [
        FaultInjectionPointV1::AfterTransitionInsert,
        FaultInjectionPointV1::AfterProjectionUpdate,
    ] {
        let fixture = TempJournal::new();
        let mut store = fixture.open();
        let request = admitted("operation-1", "nonce-1", '1');
        store
            .reserve_operation(&request, 12_000, FaultInjectionPointV1::None)
            .expect("reservation");
        assert!(matches!(
            store.append_transition(
                "operation-1",
                OperationState::Reserved,
                OperationState::RequestBound,
                12_001,
                None,
                None,
                fault,
            ),
            Err(BrokerJournalError::InjectedFault(observed)) if observed == fault,
        ));
        let journal = store
            .load_journal("operation-1")
            .expect("journal after rollback");
        assert_eq!(journal.current_state, OperationState::Reserved);
        assert!(journal.transitions.is_empty());
        drop(store);
        let reopened = fixture.open();
        let journal = reopened
            .load_journal("operation-1")
            .expect("journal after rollback and reopen");
        assert_eq!(journal.current_state, OperationState::Reserved);
        assert!(journal.transitions.is_empty());
    }
}

#[test]
fn append_only_state_survives_reopen_and_validates_projection() {
    let fixture = TempJournal::new();
    {
        let mut store = fixture.open();
        let request = admitted("operation-1", "nonce-1", '1');
        store
            .reserve_operation(&request, 12_000, FaultInjectionPointV1::None)
            .expect("reservation");
        store
            .append_transition(
                "operation-1",
                OperationState::Reserved,
                OperationState::RequestBound,
                12_001,
                None,
                None,
                FaultInjectionPointV1::None,
            )
            .expect("request bound");
        store
            .append_transition(
                "operation-1",
                OperationState::RequestBound,
                OperationState::FailedBeforeSpawn,
                12_002,
                None,
                Some("pre_spawn_failure".to_owned()),
                FaultInjectionPointV1::None,
            )
            .expect("terminal pre-spawn failure");
        store.validate_integrity().expect("integrity");
    }
    let reopened = fixture.open();
    let journal = reopened
        .load_journal("operation-1")
        .expect("reopened journal");
    assert_eq!(journal.current_state, OperationState::FailedBeforeSpawn);
    reopened.validate_integrity().expect("reopened integrity");
}

#[test]
fn schema_manifest_rejects_unqualified_extra_objects() {
    let fixture = TempJournal::new();
    let store = fixture.open();
    let connection = rusqlite::Connection::open(&fixture.path).expect("second connection");
    connection
        .execute_batch("CREATE TABLE unexpected(value TEXT) STRICT;")
        .expect("inject extra schema object");
    drop(connection);
    assert!(matches!(
        store.validate_integrity(),
        Err(BrokerJournalError::SchemaObjectMismatch { .. }),
    ));
}

#[test]
fn empty_private_database_file_is_recovered_after_creation_crash() {
    let fixture = TempJournal::new();
    let marker = PathBuf::from(format!(
        "{}{}",
        fixture.path.display(),
        INITIALIZATION_MARKER_SUFFIX,
    ));
    fs::write(&marker, INITIALIZATION_MARKER_BYTES).expect("write initialization marker");
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600))
        .expect("private initialization marker");
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&fixture.path)
        .expect("create empty interrupted database");
    file.sync_all().expect("sync empty database");
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o600))
        .expect("private empty database");
    drop(file);
    let store = fixture.open();
    assert_eq!(store.operation_count().expect("operation count"), 0);
    store
        .validate_integrity()
        .expect("recovered database integrity");
    assert!(!marker.exists());
}

#[test]
fn malformed_initialization_marker_is_rejected_without_stamping_database() {
    let fixture = TempJournal::new();
    let marker = PathBuf::from(format!(
        "{}{}",
        fixture.path.display(),
        INITIALIZATION_MARKER_SUFFIX,
    ));
    fs::write(&marker, b"not-a-qualified-marker\n").expect("write bad marker");
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).expect("private bad marker");
    assert!(matches!(
        BrokerJournalStoreV1::open(
            &fixture.path,
            BrokerJournalPolicyV1::strict(fixture.owner_uid),
        ),
        Err(BrokerJournalError::InitializationMarkerInvalid),
    ));
    assert!(!fixture.path.exists());
}

#[test]
fn initialization_marker_cannot_authorize_an_unstamped_foreign_schema() {
    let fixture = TempJournal::new();
    let marker = PathBuf::from(format!(
        "{}{}",
        fixture.path.display(),
        INITIALIZATION_MARKER_SUFFIX,
    ));
    fs::write(&marker, INITIALIZATION_MARKER_BYTES).expect("write marker");
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).expect("private marker");
    let foreign = rusqlite::Connection::open(&fixture.path).expect("foreign SQLite");
    foreign
        .execute_batch("CREATE TABLE foreign_state(value TEXT) STRICT;")
        .expect("foreign schema");
    drop(foreign);
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o600))
        .expect("private foreign database");
    assert!(matches!(
        BrokerJournalStoreV1::open(
            &fixture.path,
            BrokerJournalPolicyV1::strict(fixture.owner_uid),
        ),
        Err(BrokerJournalError::InitializationCandidateForeignSchema),
    ));
}

#[test]
fn foreign_empty_database_is_rejected_without_any_persistent_mutation() {
    let fixture = TempJournal::new();
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&fixture.path)
        .expect("create foreign empty database");
    file.sync_all().expect("sync foreign empty database");
    drop(file);
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o600))
        .expect("private foreign empty database");
    let before = fs::read(&fixture.path).expect("read foreign empty database before");

    assert!(matches!(
        BrokerJournalStoreV1::open(
            &fixture.path,
            BrokerJournalPolicyV1::strict(fixture.owner_uid),
        ),
        Err(BrokerJournalError::DatabaseIdentityMismatch { .. }),
    ));
    assert_eq!(
        fs::read(&fixture.path).expect("read foreign empty database after"),
        before,
    );
    assert!(!PathBuf::from(format!("{}-wal", fixture.path.display())).exists());
    assert!(!PathBuf::from(format!("{}-shm", fixture.path.display())).exists());
}

#[test]
fn foreign_populated_database_is_rejected_without_any_persistent_mutation() {
    let fixture = TempJournal::new();
    let foreign = rusqlite::Connection::open(&fixture.path).expect("create foreign SQLite");
    foreign
        .execute_batch(
            "CREATE TABLE foreign_state(value TEXT) STRICT;
             INSERT INTO foreign_state VALUES ('kept');",
        )
        .expect("foreign schema and content");
    drop(foreign);
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o600))
        .expect("private foreign database");
    let before = fs::read(&fixture.path).expect("read foreign database before");

    assert!(matches!(
        BrokerJournalStoreV1::open(
            &fixture.path,
            BrokerJournalPolicyV1::strict(fixture.owner_uid),
        ),
        Err(BrokerJournalError::DatabaseIdentityMismatch { .. }),
    ));
    assert_eq!(
        fs::read(&fixture.path).expect("read foreign database after"),
        before,
    );
    assert!(!PathBuf::from(format!("{}-wal", fixture.path.display())).exists());
    assert!(!PathBuf::from(format!("{}-shm", fixture.path.display())).exists());
}

#[test]
fn foreign_or_unstamped_sqlite_database_is_rejected() {
    let fixture = TempJournal::new();
    let foreign = rusqlite::Connection::open(&fixture.path).expect("create foreign SQLite");
    foreign
        .execute_batch("CREATE TABLE foreign_state(value TEXT) STRICT;")
        .expect("foreign schema");
    drop(foreign);
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o600))
        .expect("private foreign database");
    assert!(matches!(
        BrokerJournalStoreV1::open(
            &fixture.path,
            BrokerJournalPolicyV1::strict(fixture.owner_uid),
        ),
        Err(BrokerJournalError::DatabaseIdentityMismatch { .. }),
    ));
}

#[test]
fn metadata_manifest_is_closed_after_initialization() {
    let fixture = TempJournal::new();
    let store = fixture.open();
    let connection = rusqlite::Connection::open(&fixture.path).expect("second connection");
    assert!(
        connection
            .execute(
                "INSERT INTO broker_metadata(key, value) VALUES ('extra', 'value')",
                []
            )
            .is_err()
    );
    drop(connection);
    store.validate_integrity().expect("metadata remains exact");
}

#[test]
fn database_requires_private_parent_and_file() {
    let fixture = TempJournal::new();
    fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o750))
        .expect("weaken journal parent");
    assert!(matches!(
        BrokerJournalStoreV1::open(
            &fixture.path,
            BrokerJournalPolicyV1::strict(fixture.owner_uid),
        ),
        Err(BrokerJournalError::DatabaseParentPermissionsInvalid(0o750)),
    ));
}

#[test]
fn stale_valid_initialization_marker_on_complete_database_is_reconciled() {
    let fixture = TempJournal::new();
    {
        let mut store = fixture.open();
        let request = admitted("operation-before-recovery", "nonce-before-recovery", '9');
        store
            .reserve_operation(&request, 12_000, FaultInjectionPointV1::None)
            .expect("reservation before stale marker");
    }
    let marker = PathBuf::from(format!(
        "{}{}",
        fixture.path.display(),
        INITIALIZATION_MARKER_SUFFIX,
    ));
    fs::write(&marker, INITIALIZATION_MARKER_BYTES).expect("write stale marker");
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).expect("private stale marker");

    let reopened = fixture.open();
    assert_eq!(reopened.operation_count().expect("preserved operation"), 1);
    reopened.validate_integrity().expect("reconciled database");
    assert!(!marker.exists());
}

#[test]
fn unmarked_empty_database_is_not_adopted() {
    let fixture = TempJournal::new();
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&fixture.path)
        .expect("create unmarked empty database");
    file.sync_all().expect("sync empty database");
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o600))
        .expect("private empty database");
    drop(file);

    assert!(matches!(
        BrokerJournalStoreV1::open(
            &fixture.path,
            BrokerJournalPolicyV1::strict(fixture.owner_uid),
        ),
        Err(BrokerJournalError::DatabaseIdentityMismatch { .. }),
    ));
}

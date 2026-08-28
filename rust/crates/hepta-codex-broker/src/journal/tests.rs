use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use hepta_codex_journal::OperationState;
use hepta_codex_protocol::{
    AgentRole, ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy,
    RequestCapabilityV1, SandboxPolicy, SessionPolicy, Sha256Digest, TaskKind, Transport,
};

use crate::{
    AuthenticatedBrokerRequestV1, PeerIdentityV1, VerifiedCapabilityV1,
    capability_signing_bytes,
};

use super::{
    codec::sha256_digest,
    path::{INITIALIZATION_MARKER_BYTES, INITIALIZATION_MARKER_SUFFIX},
    store::{
        BrokerJournalError, BrokerJournalPolicyV1, BrokerJournalStoreV1,
        FaultInjectionPointV1, ReservationOutcomeV1,
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
        BrokerJournalStoreV1::open(
            &self.path,
            BrokerJournalPolicyV1::strict(self.owner_uid),
        )
        .expect("open broker journal")
    }
}

impl Drop for TempJournal {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn digest(byte: char) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
        .expect("test digest")
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
fn exact_duplicate_returns_existing_without_second_nonce() {
    let fixture = TempJournal::new();
    let mut store = fixture.open();
    let request = admitted("operation-1", "nonce-1", '1');
    assert!(matches!(
        store
            .reserve_operation(&request, 12_000, FaultInjectionPointV1::None)
            .expect("first reservation"),
        ReservationOutcomeV1::Reserved(_),
    ));
    assert!(matches!(
        store
            .reserve_operation(&request, 12_001, FaultInjectionPointV1::None)
            .expect("idempotent reservation"),
        ReservationOutcomeV1::Existing(_),
    ));
    assert_eq!(store.operation_count().expect("operation count"), 1);
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
        let journal = store.load_journal("operation-1").expect("journal after rollback");
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
                OperationState::ProcessSpawned,
                12_002,
                Some(digest('9')),
                None,
                FaultInjectionPointV1::None,
            )
            .expect("process spawned");
        store.validate_integrity().expect("integrity");
    }
    let reopened = fixture.open();
    let journal = reopened.load_journal("operation-1").expect("reopened journal");
    assert_eq!(journal.current_state, OperationState::ProcessSpawned);
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
    store.validate_integrity().expect("recovered database integrity");
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
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600))
        .expect("private bad marker");
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
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600))
        .expect("private marker");
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
    assert!(connection
        .execute("INSERT INTO broker_metadata(key, value) VALUES ('extra', 'value')", [])
        .is_err());
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
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600))
        .expect("private stale marker");

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

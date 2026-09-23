use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, File},
    io::Write,
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    str::FromStr,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};

use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_codex_broker::{
    AdmissionPolicyV1, BrokerJournalError, BrokerJournalPolicyV1, BrokerJournalStoreV1,
    BrokerRolePolicyV1, CapabilityTrustStoreV1, FaultInjectionPointV1, PeerPolicyV1,
    PeerPrincipalV1, ProcessReconciliationDispositionV1, ProcessReleaseStateV1,
    ReservationOutcomeV1, admit_unix_stream, capability_signing_bytes, inspect_peer_identity,
    write_request_frame,
};
use hepta_codex_journal::{OperationState, RecoveryDisposition};
use hepta_codex_protocol::{
    AgentRole, ApprovalPolicy, CodexExecutionRequestV1, NetworkPolicy, RequestCapabilityV1,
    SandboxPolicy, SessionPolicy, Sha256Digest, TaskKind, Transport,
};
use hepta_codex_runtime::{
    BoundedProcessRequestV1, DurableGatePolicyV1, EnvironmentPolicyV1, GateProcessObservationV1,
    ProcessLimitsV1, observe_preexec_gate_process, spawn_blocked_preexec_gate,
};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

struct TempTree {
    root: PathBuf,
    journal: PathBuf,
    owner_uid: u32,
}

impl TempTree {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "hepta-broker-durable-process-{}-{nonce}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir(&root).expect("create temp root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("private temp root");
        let owner_uid = fs::metadata(&root).expect("temp root metadata").uid();
        let journal = root.join("broker.sqlite");
        Self {
            root,
            journal,
            owner_uid,
        }
    }

    fn script(&self, name: &str, source: &str) -> PathBuf {
        let path = self.root.join(name);
        let mut file = File::create(&path).expect("create script");
        file.write_all(source.as_bytes()).expect("write script");
        file.sync_all().expect("sync script");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("script mode");
        path
    }

    fn copied_gate(&self) -> PathBuf {
        let target_dir = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target"));
        let built = if target_dir.is_absolute() {
            target_dir.join("debug/hepta-codex-preexec-gate")
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(target_dir)
                .join("debug/hepta-codex-preexec-gate")
        };
        let built = fs::canonicalize(&built).unwrap_or_else(|error| {
            panic!(
                "durable gate binary must be built by the workspace all-targets gate: {}: {error}",
                built.display(),
            )
        });
        let copy = self.root.join("hepta-codex-preexec-gate");
        fs::copy(&built, &copy).expect("copy durable gate into private single-link root");
        fs::set_permissions(&copy, fs::Permissions::from_mode(0o700)).expect("gate mode");
        File::open(&copy)
            .expect("open copied gate")
            .sync_all()
            .expect("sync copied gate");
        assert_eq!(fs::metadata(&copy).expect("gate metadata").nlink(), 1);
        copy
    }

    fn store(&self) -> BrokerJournalStoreV1 {
        BrokerJournalStoreV1::open(&self.journal, BrokerJournalPolicyV1::strict(self.owner_uid))
            .expect("open journal")
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn digest(byte: char) -> Sha256Digest {
    Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64))).expect("digest")
}

fn environment(root: &Path) -> hepta_codex_runtime::RestrictedEnvironmentV1 {
    EnvironmentPolicyV1::new(
        "broker-gate-test-v1",
        ["PATH", "HOME", "TMPDIR"],
        ["PATH", "HOME", "TMPDIR"],
    )
    .expect("environment policy")
    .build(
        [
            (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
            (OsString::from("HOME"), root.as_os_str().to_owned()),
            (OsString::from("TMPDIR"), root.as_os_str().to_owned()),
        ],
        &BTreeMap::new(),
    )
    .expect("restricted environment")
}

fn limits() -> ProcessLimitsV1 {
    ProcessLimitsV1 {
        timeout_ms: 2_000,
        termination_grace_ms: 100,
        cleanup_timeout_ms: 2_000,
        poll_interval_ms: 5,
        maximum_stdin_bytes: 1024 * 1024,
        maximum_stdout_bytes: 1024 * 1024,
        maximum_stderr_bytes: 1024 * 1024,
        maximum_tail_bytes: 64 * 1024,
    }
}

fn gate_policy(tree: &TempTree) -> DurableGatePolicyV1 {
    DurableGatePolicyV1::strict(tree.copied_gate(), tree.root.clone(), tree.owner_uid)
}

fn process_request(tree: &TempTree, target: PathBuf) -> BoundedProcessRequestV1 {
    BoundedProcessRequestV1 {
        executable: target,
        arguments: Vec::new(),
        working_directory: tree.root.clone(),
        environment: environment(&tree.root),
        stdin: None,
    }
}

fn admitted(
    operation_id: &str,
    nonce: &str,
    idempotency: char,
) -> hepta_codex_broker::AuthenticatedBrokerRequestV1 {
    let (mut client, server) = UnixStream::pair().expect("Unix stream pair");
    let peer = inspect_peer_identity(&server).expect("peer identity");
    let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
    let runtime_hash = digest('2');
    let mut request = CodexExecutionRequestV1 {
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
        codex_runtime_identity_hash: runtime_hash.clone(),
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
    let signing_bytes = capability_signing_bytes(&request).expect("capability signing bytes");
    request.request_capability.signature_base64 =
        Base64UrlUnpadded::encode_string(&signing_key.sign(&signing_bytes).to_bytes());
    write_request_frame(&mut client, &request, Default::default()).expect("write request frame");
    let peer_policy = PeerPolicyV1::new([PeerPrincipalV1 {
        uid: peer.uid,
        gid: peer.gid,
    }])
    .expect("peer policy");
    let trust_store =
        CapabilityTrustStoreV1::new([("key-1".to_owned(), signing_key.verifying_key())])
            .expect("trust store");
    admit_unix_stream(
        &server,
        &peer_policy,
        &trust_store,
        12_000,
        AdmissionPolicyV1::for_role(BrokerRolePolicyV1::author(runtime_hash)),
    )
    .expect("admitted request")
}

fn reserve_and_bind_request(
    store: &mut BrokerJournalStoreV1,
    request: &hepta_codex_broker::AuthenticatedBrokerRequestV1,
) {
    assert!(matches!(
        store
            .reserve_operation(request, 12_000, FaultInjectionPointV1::None)
            .expect("reserve operation"),
        ReservationOutcomeV1::Reserved(_),
    ));
    store
        .append_transition(
            &request.request().operation_id,
            OperationState::Reserved,
            OperationState::RequestBound,
            12_001,
            None,
            None,
            FaultInjectionPointV1::None,
        )
        .expect("bind request");
}

#[test]
fn durable_process_identity_commit_precedes_target_release() {
    let tree = TempTree::new();
    let marker = tree.root.join("target-started");
    let target = tree.script(
        "target.sh",
        &format!(
            "#!/bin/sh\nset -eu\nprintf started > '{}'\nprintf event\nexit 7\n",
            marker.display(),
        ),
    );
    let request = admitted("operation-1", "nonce-1", '1');
    let mut store = tree.store();
    reserve_and_bind_request(&mut store, &request);
    let blocked = spawn_blocked_preexec_gate(
        &process_request(&tree, target),
        limits(),
        &gate_policy(&tree),
    )
    .expect("blocked gate");
    assert!(!marker.exists());

    let journal = store
        .link_blocked_process(
            "operation-1",
            12_002,
            blocked.identity(),
            FaultInjectionPointV1::None,
        )
        .expect("durably link stopped gate");
    assert_eq!(journal.current_state, OperationState::ProcessSpawned);
    let launch = store
        .load_process_launch("operation-1")
        .expect("load process launch");
    assert_eq!(launch.release_state, ProcessReleaseStateV1::Blocked);
    assert_eq!(
        launch.identity.identity_hash,
        blocked.identity().identity_hash
    );
    assert!(!marker.exists());

    store
        .authorize_process_release(
            "operation-1",
            &launch.identity.identity_hash,
            12_003,
            FaultInjectionPointV1::None,
        )
        .expect("durably authorize release");
    let (identity, result) = blocked.release_and_supervise().expect("release gate");
    assert_eq!(
        result.exit_code,
        Some(7),
        "gate stderr: {}",
        String::from_utf8_lossy(&result.stderr_tail),
    );
    assert_eq!(
        fs::read_to_string(&marker).expect("target marker"),
        "started"
    );
    store
        .finish_process_and_transition(
            "operation-1",
            &identity.identity_hash,
            OperationState::ProcessSpawned,
            OperationState::FailedAfterSpawn,
            12_004,
            None,
            Some("test_target_exit".to_owned()),
            "test_target_exit",
            FaultInjectionPointV1::None,
        )
        .expect("atomically finish process and journal");
    store.validate_integrity().expect("journal integrity");
}

#[test]
fn identity_insert_fault_rolls_back_and_target_never_executes() {
    let tree = TempTree::new();
    let marker = tree.root.join("must-not-exist");
    let target = tree.script(
        "target.sh",
        &format!("#!/bin/sh\nprintf started > '{}'\n", marker.display()),
    );
    let request = admitted("operation-2", "nonce-2", '2');
    let mut store = tree.store();
    reserve_and_bind_request(&mut store, &request);
    let blocked = spawn_blocked_preexec_gate(
        &process_request(&tree, target),
        limits(),
        &gate_policy(&tree),
    )
    .expect("blocked gate");
    assert!(matches!(
        store.link_blocked_process(
            "operation-2",
            12_002,
            blocked.identity(),
            FaultInjectionPointV1::AfterProcessIdentityInsert,
        ),
        Err(BrokerJournalError::InjectedFault(
            FaultInjectionPointV1::AfterProcessIdentityInsert
        )),
    ));
    assert_eq!(
        store
            .load_journal("operation-2")
            .expect("rolled-back journal")
            .current_state,
        OperationState::RequestBound,
    );
    assert!(matches!(
        store.load_process_launch("operation-2"),
        Err(BrokerJournalError::ProcessIdentityNotFound(_)),
    ));
    blocked
        .terminate_blocked()
        .expect("terminate unlinked gate");
    assert!(!marker.exists());
    store.validate_integrity().expect("journal integrity");
}

#[test]
fn every_link_transaction_fault_rolls_back_process_identity_and_transition() {
    for (index, fault) in [
        FaultInjectionPointV1::AfterProcessIdentityInsert,
        FaultInjectionPointV1::AfterTransitionInsert,
        FaultInjectionPointV1::AfterProjectionUpdate,
    ]
    .into_iter()
    .enumerate()
    {
        let tree = TempTree::new();
        let marker = tree.root.join("must-not-exist");
        let target = tree.script(
            "target.sh",
            &format!("#!/bin/sh\nprintf started > '{}'\n", marker.display()),
        );
        let operation_id = format!("operation-link-fault-{index}");
        let nonce = format!("nonce-link-fault-{index}");
        let idempotency = char::from_digit(u32::try_from(index + 1).expect("small digit"), 10)
            .expect("decimal idempotency");
        let request = admitted(&operation_id, &nonce, idempotency);
        let mut store = tree.store();
        reserve_and_bind_request(&mut store, &request);
        let blocked = spawn_blocked_preexec_gate(
            &process_request(&tree, target),
            limits(),
            &gate_policy(&tree),
        )
        .expect("blocked gate");
        assert!(matches!(
            store.link_blocked_process(&operation_id, 12_002, blocked.identity(), fault),
            Err(BrokerJournalError::InjectedFault(observed)) if observed == fault,
        ));
        assert_eq!(
            store
                .load_journal(&operation_id)
                .expect("journal after rollback")
                .current_state,
            OperationState::RequestBound,
        );
        assert!(matches!(
            store.load_process_launch(&operation_id),
            Err(BrokerJournalError::ProcessIdentityNotFound(_)),
        ));
        blocked.terminate_blocked().expect("terminate blocked gate");
        assert!(!marker.exists());
        store.validate_integrity().expect("journal integrity");
    }
}

#[test]
fn release_authorization_fault_remains_blocked_and_reconciles_without_execution() {
    let tree = TempTree::new();
    let marker = tree.root.join("must-not-exist");
    let target = tree.script(
        "target.sh",
        &format!("#!/bin/sh\nprintf started > '{}'\n", marker.display()),
    );
    let request = admitted("operation-3", "nonce-3", '3');
    let mut store = tree.store();
    reserve_and_bind_request(&mut store, &request);
    let blocked = spawn_blocked_preexec_gate(
        &process_request(&tree, target),
        limits(),
        &gate_policy(&tree),
    )
    .expect("blocked gate");
    let identity = blocked.identity().clone();
    store
        .link_blocked_process(
            "operation-3",
            12_002,
            &identity,
            FaultInjectionPointV1::None,
        )
        .expect("link process");
    assert!(matches!(
        store.authorize_process_release(
            "operation-3",
            &identity.identity_hash,
            12_003,
            FaultInjectionPointV1::AfterReleaseAuthorization,
        ),
        Err(BrokerJournalError::InjectedFault(
            FaultInjectionPointV1::AfterReleaseAuthorization
        )),
    ));
    assert_eq!(
        store
            .load_process_launch("operation-3")
            .expect("load blocked process")
            .release_state,
        ProcessReleaseStateV1::Blocked,
    );
    let reconciled = store
        .reconcile_pending_processes(12_004, limits())
        .expect("startup reconciliation");
    assert_eq!(reconciled.len(), 1);
    assert_eq!(
        reconciled[0].disposition,
        ProcessReconciliationDispositionV1::BlockedGateTerminated,
    );
    drop(blocked);
    assert!(!marker.exists());
    assert_eq!(
        store
            .load_journal("operation-3")
            .expect("reconciled journal")
            .current_state,
        OperationState::FailedAfterSpawn,
    );
    store.validate_integrity().expect("journal integrity");
}

#[test]
fn absent_blocked_gate_is_classified_without_provider_execution() {
    let tree = TempTree::new();
    let marker = tree.root.join("must-not-exist");
    let target = tree.script(
        "target.sh",
        &format!("#!/bin/sh\nprintf started > '{}'\n", marker.display()),
    );
    let request = admitted("operation-4", "nonce-4", '4');
    let mut store = tree.store();
    reserve_and_bind_request(&mut store, &request);
    let blocked = spawn_blocked_preexec_gate(
        &process_request(&tree, target),
        limits(),
        &gate_policy(&tree),
    )
    .expect("blocked gate");
    store
        .link_blocked_process(
            "operation-4",
            12_002,
            blocked.identity(),
            FaultInjectionPointV1::None,
        )
        .expect("link process");
    blocked.terminate_blocked().expect("simulate crash cleanup");
    let reconciled = store
        .reconcile_pending_processes(12_003, limits())
        .expect("reconcile absent gate");
    assert_eq!(
        reconciled[0].disposition,
        ProcessReconciliationDispositionV1::BlockedGateAlreadyAbsent,
    );
    assert!(!marker.exists());
    assert_eq!(
        store
            .load_journal("operation-4")
            .expect("reconciled journal")
            .current_state,
        OperationState::FailedAfterSpawn,
    );
}

#[test]
fn generic_transition_api_cannot_forge_process_spawned() {
    let tree = TempTree::new();
    let request = admitted("operation-5", "nonce-5", '5');
    let mut store = tree.store();
    reserve_and_bind_request(&mut store, &request);
    assert!(matches!(
        store.append_transition(
            "operation-5",
            OperationState::RequestBound,
            OperationState::ProcessSpawned,
            12_002,
            Some(digest('8')),
            None,
            FaultInjectionPointV1::None,
        ),
        Err(BrokerJournalError::ProcessSpawnedRequiresGateIdentity),
    ));
}

#[test]
fn process_finish_faults_roll_back_termination_and_journal_together() {
    for (index, fault) in [
        FaultInjectionPointV1::AfterProcessTermination,
        FaultInjectionPointV1::AfterTransitionInsert,
        FaultInjectionPointV1::AfterProjectionUpdate,
    ]
    .into_iter()
    .enumerate()
    {
        let tree = TempTree::new();
        let operation_id = format!("operation-finish-fault-{index}");
        let nonce = format!("nonce-finish-fault-{index}");
        let idempotency = char::from_digit(u32::try_from(index + 6).expect("small digit"), 10)
            .expect("decimal idempotency");
        let target = tree.script("target.sh", "#!/bin/sh\nexit 0\n");
        let request = admitted(&operation_id, &nonce, idempotency);
        let mut store = tree.store();
        reserve_and_bind_request(&mut store, &request);
        let blocked = spawn_blocked_preexec_gate(
            &process_request(&tree, target),
            limits(),
            &gate_policy(&tree),
        )
        .expect("blocked gate");
        let identity = blocked.identity().clone();
        store
            .link_blocked_process(
                &operation_id,
                12_002,
                &identity,
                FaultInjectionPointV1::None,
            )
            .expect("link process");
        store
            .authorize_process_release(
                &operation_id,
                &identity.identity_hash,
                12_003,
                FaultInjectionPointV1::None,
            )
            .expect("authorize process release");
        blocked.terminate_blocked().expect("terminate stopped gate");

        assert!(matches!(
            store.finish_process_and_transition(
                &operation_id,
                &identity.identity_hash,
                OperationState::ProcessSpawned,
                OperationState::ResultAmbiguous,
                12_004,
                None,
                Some("injected_finish_fault".to_owned()),
                "injected_finish_fault",
                fault,
            ),
            Err(BrokerJournalError::InjectedFault(observed)) if observed == fault,
        ));
        assert_eq!(
            store
                .load_journal(&operation_id)
                .expect("journal after rollback")
                .current_state,
            OperationState::ProcessSpawned,
        );
        assert_eq!(
            store
                .load_process_launch(&operation_id)
                .expect("launch after rollback")
                .release_state,
            ProcessReleaseStateV1::Authorized,
        );
        drop(store);
        let reopened = tree.store();
        assert_eq!(
            reopened
                .load_journal(&operation_id)
                .expect("reopened journal")
                .current_state,
            OperationState::ProcessSpawned,
        );
        assert_eq!(
            reopened
                .load_process_launch(&operation_id)
                .expect("reopened launch")
                .release_state,
            ProcessReleaseStateV1::Authorized,
        );
        reopened.validate_integrity().expect("reopened integrity");
    }
}

#[test]
fn authorized_but_unreleased_gate_restarts_as_ambiguous_without_target_execution() {
    let tree = TempTree::new();
    let marker = tree.root.join("must-not-exist");
    let target = tree.script(
        "target.sh",
        &format!("#!/bin/sh\nprintf started > '{}'\n", marker.display()),
    );
    let request = admitted(
        "operation-authorized-blocked",
        "nonce-authorized-blocked",
        '9',
    );
    let mut store = tree.store();
    reserve_and_bind_request(&mut store, &request);
    let blocked = spawn_blocked_preexec_gate(
        &process_request(&tree, target),
        limits(),
        &gate_policy(&tree),
    )
    .expect("blocked gate");
    let identity = blocked.identity().clone();
    store
        .link_blocked_process(
            &request.request().operation_id,
            12_002,
            &identity,
            FaultInjectionPointV1::None,
        )
        .expect("link blocked process");
    store
        .authorize_process_release(
            &request.request().operation_id,
            &identity.identity_hash,
            12_003,
            FaultInjectionPointV1::None,
        )
        .expect("durably authorize release");
    assert_eq!(
        observe_preexec_gate_process(&identity).expect("observe stopped gate"),
        GateProcessObservationV1::Blocked,
    );

    let reconciled = store
        .reconcile_pending_processes(12_004, limits())
        .expect("reconcile authorized stopped gate");
    assert_eq!(
        reconciled[0].disposition,
        ProcessReconciliationDispositionV1::ReleasedProcessOutcomeAmbiguous,
    );
    drop(blocked);
    assert!(!marker.exists());
    let reconciled_journal = store
        .load_journal(&request.request().operation_id)
        .expect("reconciled journal");
    assert_eq!(
        reconciled_journal.current_state,
        OperationState::ResultAmbiguous
    );
    assert_eq!(
        reconciled_journal.recovery_disposition(),
        RecoveryDisposition::StartNewAttempt,
    );
    store.validate_integrity().expect("journal integrity");
}

#[test]
fn released_running_gate_is_detected_and_reconciled_as_ambiguous() {
    let tree = TempTree::new();
    let marker = tree.root.join("target-started");
    let target = tree.script(
        "target.sh",
        &format!(
            "#!/bin/sh\nset -eu\nprintf started > '{}'\nsleep 30\n",
            marker.display(),
        ),
    );
    let request = admitted("operation-released-running", "nonce-released-running", 'a');
    let mut store = tree.store();
    reserve_and_bind_request(&mut store, &request);
    let blocked = spawn_blocked_preexec_gate(
        &process_request(&tree, target),
        limits(),
        &gate_policy(&tree),
    )
    .expect("blocked gate");
    let identity = blocked.identity().clone();
    store
        .link_blocked_process(
            &request.request().operation_id,
            12_002,
            &identity,
            FaultInjectionPointV1::None,
        )
        .expect("link process");
    store
        .authorize_process_release(
            &request.request().operation_id,
            &identity.identity_hash,
            12_003,
            FaultInjectionPointV1::None,
        )
        .expect("authorize release");
    let released = blocked
        .release()
        .expect("release without starting supervision");
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !marker.exists() && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        marker.exists(),
        "target must have started after durable release"
    );
    assert_eq!(
        observe_preexec_gate_process(&identity).expect("observe released gate"),
        GateProcessObservationV1::ReleasedOrRunning,
    );
    let reconciled = store
        .reconcile_pending_processes(12_004, limits())
        .expect("reconcile released process");
    assert_eq!(
        reconciled[0].disposition,
        ProcessReconciliationDispositionV1::ReleasedProcessTerminated,
    );
    released
        .reap_after_external_termination()
        .expect("reap reconciled gate");
    let reconciled_journal = store
        .load_journal(&request.request().operation_id)
        .expect("reconciled journal");
    assert_eq!(
        reconciled_journal.current_state,
        OperationState::ResultAmbiguous
    );
    assert_eq!(
        reconciled_journal.recovery_disposition(),
        RecoveryDisposition::StartNewAttempt,
    );
    store.validate_integrity().expect("journal integrity");
}

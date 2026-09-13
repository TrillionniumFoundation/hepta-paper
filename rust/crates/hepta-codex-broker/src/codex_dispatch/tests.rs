use super::*;
use crate::{
    AdmissionPolicyV1, BrokerJournalPolicyV1, BrokerRolePolicyV1, CapabilityTrustStoreV1,
    PeerPolicyV1, PeerPrincipalV1, admit_unix_stream, capability_signing_bytes,
    inspect_peer_identity, write_request_frame,
};
use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_codex_protocol::{
    ApprovalPolicy, NetworkPolicy, RequestCapabilityV1, SandboxPolicy, SessionPolicy, TaskKind,
    Transport,
};
use hepta_codex_runtime::{
    CgroupV2PolicyV1, codex_parent_environment_policy_v1, model_child_environment_policy_v1,
};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::File,
    io::Write,
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::Path,
    sync::{Arc, atomic::AtomicU64},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Clock;
impl BrokerClockV1 for Clock {
    fn now_unix_ms(&self) -> Result<u64, crate::BrokerServerError> {
        Ok(12_000)
    }
}
struct TestAuthority;
impl CodexDispatchAuthorityV1 for TestAuthority {
    fn authorize(
        &self,
        _: &CodexExecutionRequestV1,
        _: &CodexRuntimeIdentityV1,
        _: &CodexInvocationV1,
        _: u64,
    ) -> Result<(), CodexDispatchError> {
        Ok(())
    }
}

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    schema: PathBuf,
    output: PathBuf,
    gate: PathBuf,
    uid: u32,
    runtime: CodexRuntimeIdentityV1,
    identity_policy: RuntimeIdentityPolicyV1,
    parent: RestrictedEnvironmentV1,
    child: RestrictedEnvironmentV1,
    prompt: Vec<u8>,
}
impl Fixture {
    fn new(output: &str, extra: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "hepta-dispatch-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let uid = fs::metadata(&root).unwrap().uid();
        let executable = root.join("codex-local-test");
        let script = format!(
            r#"#!/bin/sh
set -eu
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--output-last-message' ]; then shift; output="$1"; fi
  shift
done
cat >/dev/null
printf started > started
{extra}
printf '%s' '{output}' > "$output"
printf '%s\n' '{{"type":"thread.started","thread_id":"thread-1"}}' '{{"type":"turn.started"}}' '{{"type":"turn.completed","usage":{{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}}}'
"#
        );
        create(&executable, script.as_bytes(), 0o700);
        let home = root.join("home");
        fs::create_dir(&home).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        create(
            &home.join("config.toml"),
            b"model = 'qualified-model'\n",
            0o600,
        );
        let workspace = root.join("workspace");
        fs::create_dir(&workspace).unwrap();
        let schema = root.join("schema.json");
        create(&schema, br#"{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}"#, 0o400);
        let output = root.join("output.json");
        create(&output, b"", 0o600);
        let parent = codex_parent_environment_policy_v1()
            .build(
                [
                    (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
                    (OsString::from("HOME"), home.clone().into_os_string()),
                    (OsString::from("CODEX_HOME"), home.clone().into_os_string()),
                    (OsString::from("TMPDIR"), root.clone().into_os_string()),
                ],
                &BTreeMap::new(),
            )
            .unwrap();
        let child = model_child_environment_policy_v1()
            .build(
                [
                    (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
                    (OsString::from("HOME"), workspace.clone().into_os_string()),
                    (OsString::from("TMPDIR"), workspace.clone().into_os_string()),
                ],
                &BTreeMap::new(),
            )
            .unwrap();
        let identity_policy = RuntimeIdentityPolicyV1::strict(uid, uid);
        let runtime = inspect_codex_runtime_identity(
            executable.as_os_str(),
            &home,
            "qualified-model",
            parent.policy_hash.clone(),
            hash_bytes(b"transport").unwrap(),
            parent.as_map(),
            &identity_policy,
        )
        .unwrap();
        let built = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target"))
            .join("debug/hepta-codex-preexec-gate");
        let gate = root.join("preexec-gate");
        fs::copy(&built, &gate).unwrap_or_else(|error| {
            panic!(
                "build hepta-codex-preexec-gate first: {}: {error}",
                built.display()
            )
        });
        fs::set_permissions(&gate, fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            root,
            workspace,
            schema,
            output,
            gate,
            uid,
            runtime,
            identity_policy,
            parent,
            child,
            prompt: b"Return a JSON answer.".to_vec(),
        }
    }
    fn plan<'a>(&'a self, cancelled: &'a AtomicBool) -> CodexDispatchPlanV1<'a> {
        CodexDispatchPlanV1 {
            operation_id: "dispatch-1".into(),
            role: AgentRole::Author,
            runtime: &self.runtime,
            runtime_identity_policy: &self.identity_policy,
            workspace: self.workspace.clone(),
            output_schema_path: self.schema.clone(),
            output_last_message_path: self.output.clone(),
            parent_environment: self.parent.clone(),
            model_child_environment: &self.child,
            prompt: self.prompt.clone(),
            invocation_policy: CodexInvocationPolicyV1::local_fixture(self.uid),
            process_limits: ProcessLimitsV1 {
                timeout_ms: 2_000,
                termination_grace_ms: 50,
                cleanup_timeout_ms: 2_000,
                poll_interval_ms: 5,
                maximum_stdin_bytes: 1024,
                maximum_stdout_bytes: 65536,
                maximum_stderr_bytes: 65536,
                maximum_tail_bytes: 65536,
            },
            gate_policy: DurableGatePolicyV1::strict(
                self.gate.clone(),
                self.root.clone(),
                self.uid,
            ),
            containment: ProcessContainmentModeV1::ProcessGroupOnly,
            authority: &TestAuthority,
            clock: &Clock,
            cancelled,
        }
    }
    fn reserved(&self) -> BrokerJournalStoreV1 {
        let invocation = build_codex_invocation(CodexInvocationRequestV1 {
            runtime: &self.runtime,
            workspace: &self.workspace,
            sandbox_policy: SandboxPolicy::WorkspaceWrite,
            output_schema_path: &self.schema,
            expected_output_schema_hash: &hash_bytes(&fs::read(&self.schema).unwrap()).unwrap(),
            output_last_message_path: &self.output,
            parent_environment: self.parent.clone(),
            model_child_environment: &self.child,
            prompt: self.prompt.clone(),
            policy: CodexInvocationPolicyV1::local_fixture(self.uid),
        })
        .unwrap();
        let (mut client, server) = UnixStream::pair().unwrap();
        let peer = inspect_peer_identity(&server).unwrap();
        let key = SigningKey::from_bytes(&[31; 32]);
        let mut request = CodexExecutionRequestV1 {
            version: 1,
            operation_id: "dispatch-1".into(),
            idempotency_key: hash_bytes(b"idempotency").unwrap(),
            campaign_id: "campaign-1".into(),
            node_id: "node-1".into(),
            attempt_id: "attempt-1".into(),
            lease_generation: 1,
            campaign_revision: 0,
            role: AgentRole::Author,
            task_kind: TaskKind::Draft,
            codex_runtime_identity_hash: self.runtime.identity_hash.clone(),
            model_selector: self.runtime.model_selector.clone(),
            transport: Transport::ExecJsonlV1,
            session_policy: SessionPolicy::EphemeralNewThread,
            prompt_envelope_hash: invocation.prompt_hash,
            input_manifest_hash: hash_bytes(b"input").unwrap(),
            workspace_identity_hash: hash_bytes(b"workspace").unwrap(),
            output_schema_hash: invocation.output_schema_hash,
            mutation_policy_hash: hash_bytes(b"mutations").unwrap(),
            sandbox_policy: SandboxPolicy::WorkspaceWrite,
            network_policy: NetworkPolicy::None,
            approval_policy: ApprovalPolicy::Never,
            absolute_deadline_unix_ms: 20_000,
            maximum_output_bytes: 65536,
            maximum_event_count: 100,
            maximum_cost_microusd: 1_000_000,
            remaining_token_hint: None,
            request_capability: RequestCapabilityV1 {
                nonce: "nonce-dispatch-1".into(),
                issued_at_unix_ms: 10_000,
                expires_at_unix_ms: 15_000,
                signer_key_id: "test-key".into(),
                peer_uid: peer.uid,
                peer_gid: peer.gid,
                signature_base64: "A".repeat(86),
            },
        };
        request.request_capability.signature_base64 = Base64UrlUnpadded::encode_string(
            &key.sign(&capability_signing_bytes(&request).unwrap())
                .to_bytes(),
        );
        write_request_frame(&mut client, &request, Default::default()).unwrap();
        let admitted = admit_unix_stream(
            &server,
            &PeerPolicyV1::new([PeerPrincipalV1 {
                uid: peer.uid,
                gid: peer.gid,
            }])
            .unwrap(),
            &CapabilityTrustStoreV1::new([("test-key".into(), key.verifying_key())]).unwrap(),
            12_000,
            AdmissionPolicyV1::for_role(BrokerRolePolicyV1::author(
                self.runtime.identity_hash.clone(),
            )),
        )
        .unwrap();
        let mut store = BrokerJournalStoreV1::open(
            self.root.join("broker.sqlite"),
            BrokerJournalPolicyV1::strict(self.uid),
        )
        .unwrap();
        store
            .reserve_operation(&admitted, 12_000, FaultInjectionPointV1::None)
            .unwrap();
        store
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn create(path: &Path, bytes: &[u8], mode: u32) {
    let mut file = File::create(path).unwrap();
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

#[test]
fn actual_cli_output_is_durable_schema_validated_and_never_replayed() {
    let fixture = Fixture::new(r#"{"answer":"local success"}"#, "");
    let mut store = fixture.reserved();
    let cancelled = AtomicBool::new(false);
    let result =
        run_reserved_codex_operation_inner(&mut store, fixture.plan(&cancelled), false).unwrap();
    assert_eq!(result.output, json!({"answer":"local success"}));
    assert_eq!(
        result.journal.current_state,
        OperationState::SchemaValidated
    );
    assert!(result.durable_result_path.exists());
    assert!(fixture.workspace.join("started").exists());
    assert!(result.process.process_group_cleanup_verified);
    assert!(
        crate::create_broker_backup(
            &store,
            &fixture.root.join("journal-only.sqlite"),
            BrokerJournalPolicyV1::strict(fixture.uid),
            crate::BrokerBackupPolicyV1::strict(fixture.uid),
            12_001
        )
        .is_err()
    );
    let bundle = crate::create_quiesced_codex_dispatch_backup(
        &store,
        &fixture.root,
        &fixture.root.join("complete-bundle"),
        BrokerJournalPolicyV1::strict(fixture.uid),
        crate::BrokerBackupPolicyV1::strict(fixture.uid),
        12_001,
    )
    .unwrap();
    assert_eq!(bundle.sidecar_count, 1);
    fs::remove_file(&result.durable_result_path).unwrap();
    assert!(matches!(
        crate::create_quiesced_codex_dispatch_backup(
            &store,
            &fixture.root,
            &fixture.root.join("missing-evidence-bundle"),
            BrokerJournalPolicyV1::strict(fixture.uid),
            crate::BrokerBackupPolicyV1::strict(fixture.uid),
            12_001
        ),
        Err(CodexDispatchError::InvalidBinding(
            "backup_missing_execution_evidence"
        ))
    ));
    assert!(matches!(
        run_reserved_codex_operation_inner(&mut store, fixture.plan(&cancelled), false),
        Err(CodexDispatchError::OperationNotReserved)
    ));
    store.validate_integrity().unwrap();
}
#[test]
fn fixture_never_enters_production_even_with_allowing_test_authority() {
    let fixture = Fixture::new(r#"{"answer":"no"}"#, "");
    let mut store = fixture.reserved();
    let cancelled = AtomicBool::new(false);
    assert!(matches!(
        run_reserved_codex_operation(&mut store, fixture.plan(&cancelled)),
        Err(CodexDispatchError::ProductionAuthorityRequired)
    ));
    assert!(!fixture.workspace.join("started").exists());
    assert_eq!(
        store.load_journal("dispatch-1").unwrap().current_state,
        OperationState::RejectedPreflight
    );
}
#[test]
fn output_schema_mismatch_is_a_durable_failure() {
    let fixture = Fixture::new(r#"{"answer":42}"#, "");
    let mut store = fixture.reserved();
    let cancelled = AtomicBool::new(false);
    assert!(matches!(
        run_reserved_codex_operation_inner(&mut store, fixture.plan(&cancelled), false),
        Err(CodexDispatchError::Schema(_))
    ));
    assert_eq!(
        store.load_journal("dispatch-1").unwrap().current_state,
        OperationState::OutputSchemaInvalid
    );
    store.validate_integrity().unwrap();
}
#[test]
fn role_and_prompt_drift_are_rejected_before_the_target_starts() {
    for wrong_role in [true, false] {
        let fixture = Fixture::new(r#"{"answer":"no"}"#, "");
        let mut store = fixture.reserved();
        let cancelled = AtomicBool::new(false);
        let mut plan = fixture.plan(&cancelled);
        if wrong_role {
            plan.role = AgentRole::Reviewer;
        } else {
            plan.prompt = b"tampered prompt".to_vec();
        }
        assert!(matches!(
            run_reserved_codex_operation_inner(&mut store, plan, false),
            Err(CodexDispatchError::InvalidBinding(_))
        ));
        assert!(!fixture.workspace.join("started").exists());
    }
}
#[test]
fn runtime_config_drift_is_ambiguous_and_not_integrated() {
    let fixture = Fixture::new(
        r#"{"answer":"unsafe"}"#,
        "printf changed > \"$CODEX_HOME/config.toml\"",
    );
    let mut store = fixture.reserved();
    let cancelled = AtomicBool::new(false);
    assert!(matches!(
        run_reserved_codex_operation_inner(&mut store, fixture.plan(&cancelled), false),
        Err(CodexDispatchError::RuntimeDrift(_))
    ));
    assert_eq!(
        store.load_journal("dispatch-1").unwrap().current_state,
        OperationState::ResultAmbiguous
    );
}
#[test]
fn cancellation_after_release_cleans_up_and_prevents_retry() {
    let fixture = Fixture::new(r#"{"answer":"too late"}"#, "sleep 10");
    let mut store = fixture.reserved();
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel = cancelled.clone();
    let marker = fixture.workspace.join("started");
    let handle = thread::spawn(move || {
        for _ in 0..400 {
            if marker.exists() {
                cancel.store(true, Ordering::Release);
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("target never started");
    });
    let result = run_reserved_codex_operation_inner(&mut store, fixture.plan(&cancelled), false);
    handle.join().unwrap();
    let Err(CodexDispatchError::ProcessFailed(process)) = result else {
        panic!("unexpected result: {result:?}");
    };
    assert_eq!(
        process.termination_reason,
        ProcessTerminationReason::Cancelled
    );
    assert!(process.process_group_cleanup_verified);
    assert_eq!(
        store.load_journal("dispatch-1").unwrap().current_state,
        OperationState::ResultAmbiguous
    );
    store.validate_integrity().unwrap();
}
#[test]
fn cgroup_cleanup_recovery_uses_durable_directory_identity() {
    let fixture = Fixture::new(r#"{"answer":"yes"}"#, "");
    let store = fixture.reserved();
    let cgroup_root = fixture.root.join("cgroups");
    fs::create_dir(&cgroup_root).unwrap();
    let policy = CgroupV2PolicyV1::local_fixture(cgroup_root.clone(), fixture.uid);
    let operation = CgroupV2OperationV1::create(policy.clone(), "dispatch-1").unwrap();
    bind_containment(&store, "dispatch-1", &fixture.root, &policy, &operation).unwrap();
    // Mimic owner-process loss: the recovery record must survive until cleanup has been proved.
    std::mem::forget(operation);
    assert_eq!(
        crate::recover_codex_dispatch_containment(&store, &fixture.root, &policy).unwrap(),
        1
    );
    assert!(!cgroup_root.join("dispatch-1").exists());
    assert_eq!(
        crate::recover_codex_dispatch_containment(&store, &fixture.root, &policy).unwrap(),
        0
    );
}

#[test]
fn replacement_cgroup_is_not_adopted_or_killed_during_recovery() {
    let fixture = Fixture::new(r#"{"answer":"yes"}"#, "");
    let store = fixture.reserved();
    let root = fixture.root.join("cgroups");
    fs::create_dir(&root).unwrap();
    let policy = CgroupV2PolicyV1::local_fixture(root.clone(), fixture.uid);
    let operation = CgroupV2OperationV1::create(policy.clone(), "dispatch-1").unwrap();
    bind_containment(&store, "dispatch-1", &fixture.root, &policy, &operation).unwrap();
    std::mem::forget(operation);
    fs::rename(root.join("dispatch-1"), root.join("old-operation")).unwrap();
    let replacement = CgroupV2OperationV1::create(policy.clone(), "dispatch-1").unwrap();
    assert!(matches!(
        crate::recover_codex_dispatch_containment(&store, &fixture.root, &policy),
        Err(CodexDispatchError::Containment(
            hepta_codex_runtime::CgroupV2Error::RecoveryIdentityMismatch
        ))
    ));
    assert_eq!(
        fs::read_to_string(replacement.path().join("cgroup.kill")).unwrap(),
        "0"
    );
    replacement.kill_and_cleanup().unwrap();
}

#[test]
fn cancellation_before_spawn_never_creates_a_target() {
    let fixture = Fixture::new(r#"{"answer":"no"}"#, "");
    let mut store = fixture.reserved();
    let cancelled = AtomicBool::new(true);
    assert!(matches!(
        run_reserved_codex_operation_inner(&mut store, fixture.plan(&cancelled), false),
        Err(CodexDispatchError::Cancelled)
    ));
    assert_eq!(
        store.load_journal("dispatch-1").unwrap().current_state,
        OperationState::CancelledBeforeSpawn
    );
    assert!(!fixture.workspace.join("started").exists());
}

#[test]
fn quiesced_backup_roundtrip_preserves_journal_and_hash_pinned_sidecars() {
    let fixture = Fixture::new(r#"{"answer":"yes"}"#, "");
    let store = fixture.reserved();
    let request_hash = store.load_journal("dispatch-1").unwrap().request_hash;
    // A storage fixture, deliberately not represented as provider execution or prepared state.
    let bytes = serde_json::to_vec(&json!({"version":1,"operationId":"dispatch-1","requestHash":request_hash,"storageFixture":"exact bytes"})).unwrap();
    let name = "codex-result-dispatch-1.json";
    durable_create(&fixture.root.join(name), &bytes).unwrap();
    let bundle = fixture.root.join("backup");
    let receipt = crate::create_quiesced_codex_dispatch_backup(
        &store,
        &fixture.root,
        &bundle,
        BrokerJournalPolicyV1::strict(fixture.uid),
        crate::BrokerBackupPolicyV1::strict(fixture.uid),
        12_001,
    )
    .unwrap();
    assert_eq!(receipt.sidecar_count, 1);
    assert!(receipt.requires_requalification);
    let destination = fixture.root.join("restored");
    let restored_receipt = crate::restore_quiesced_codex_dispatch_backup(
        &bundle,
        &receipt.manifest_hash,
        &destination,
        BrokerJournalPolicyV1::strict(fixture.uid),
        crate::BrokerBackupPolicyV1::strict(fixture.uid),
        12_002,
    )
    .unwrap();
    assert_eq!(restored_receipt.manifest_hash, receipt.manifest_hash);
    assert!(restored_receipt.requires_requalification);
    assert_eq!(
        fs::read(destination.join("state").join(name)).unwrap(),
        bytes
    );
    let restored = BrokerJournalStoreV1::open(
        destination.join("journal.sqlite"),
        BrokerJournalPolicyV1::strict(fixture.uid),
    )
    .unwrap();
    assert_eq!(
        restored.load_journal("dispatch-1").unwrap(),
        store.load_journal("dispatch-1").unwrap()
    );
    assert!(
        crate::restore_quiesced_codex_dispatch_backup(
            &bundle,
            &receipt.manifest_hash,
            &destination,
            BrokerJournalPolicyV1::strict(fixture.uid),
            crate::BrokerBackupPolicyV1::strict(fixture.uid),
            12_003
        )
        .is_err()
    );
}

#[test]
fn quiesced_backup_rejects_live_dispatch_lock_and_unreconciled_containment() {
    let fixture = Fixture::new(r#"{"answer":"yes"}"#, "");
    let store = fixture.reserved();
    let held =
        crate::dispatch_backup::acquire_dispatch_lock(&fixture.root, fixture.uid, false).unwrap();
    let backup = || {
        crate::create_quiesced_codex_dispatch_backup(
            &store,
            &fixture.root,
            &fixture.root.join("backup"),
            BrokerJournalPolicyV1::strict(fixture.uid),
            crate::BrokerBackupPolicyV1::strict(fixture.uid),
            12_001,
        )
    };
    assert!(matches!(
        backup(),
        Err(CodexDispatchError::InvalidBinding("dispatch_not_quiescent"))
    ));
    drop(held);
    durable_create(
        &fixture.root.join("codex-containment-dispatch-1.json"),
        b"unreconciled",
    )
    .unwrap();
    assert!(matches!(
        backup(),
        Err(CodexDispatchError::InvalidBinding(
            "backup_unreconciled_execution"
        ))
    ));
    assert!(!fixture.root.join("backup").exists());
}

#[test]
fn quiesced_backup_restore_rejects_manifest_and_sidecar_tampering() {
    let fixture = Fixture::new(r#"{"answer":"yes"}"#, "");
    let store = fixture.reserved();
    let request_hash = store.load_journal("dispatch-1").unwrap().request_hash;
    let bytes = serde_json::to_vec(
        &json!({"version":1,"operationId":"dispatch-1","requestHash":request_hash}),
    )
    .unwrap();
    let name = "codex-result-dispatch-1.json";
    durable_create(&fixture.root.join(name), &bytes).unwrap();
    let bundle = fixture.root.join("backup");
    let receipt = crate::create_quiesced_codex_dispatch_backup(
        &store,
        &fixture.root,
        &bundle,
        BrokerJournalPolicyV1::strict(fixture.uid),
        crate::BrokerBackupPolicyV1::strict(fixture.uid),
        12_001,
    )
    .unwrap();
    let target = fixture.root.join("restored");
    let restore = |hash: &Sha256Digest| {
        crate::restore_quiesced_codex_dispatch_backup(
            &bundle,
            hash,
            &target,
            BrokerJournalPolicyV1::strict(fixture.uid),
            crate::BrokerBackupPolicyV1::strict(fixture.uid),
            12_002,
        )
    };
    assert!(matches!(
        restore(&hash_bytes(b"wrong manifest").unwrap()),
        Err(CodexDispatchError::InvalidBinding("backup_manifest_hash"))
    ));
    assert!(!target.exists());
    fs::write(bundle.join("state").join(name), b"{}").unwrap();
    assert!(matches!(
        restore(&receipt.manifest_hash),
        Err(CodexDispatchError::InvalidBinding("backup_sidecar_hash"))
    ));
    assert!(!target.exists());
}

#[test]
fn journal_only_backup_rejects_dispatch_inflight_state() {
    let fixture = Fixture::new(r#"{"answer":"yes"}"#, "");
    let mut store = fixture.reserved();
    store
        .append_transition(
            "dispatch-1",
            OperationState::Reserved,
            OperationState::RequestBound,
            12_001,
            None,
            None,
            FaultInjectionPointV1::None,
        )
        .unwrap();
    let target = fixture.root.join("journal-only.sqlite");
    assert!(
        crate::create_broker_backup(
            &store,
            &target,
            BrokerJournalPolicyV1::strict(fixture.uid),
            crate::BrokerBackupPolicyV1::strict(fixture.uid),
            12_002
        )
        .is_err()
    );
    assert!(!target.exists());
}

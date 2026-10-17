//! Wiring tests use a synthetic trusted dispatcher and real signed capability,
//! Unix socketpair, bounded writer and SQLite. They do not attest an installation.
use super::*;
use crate::{
    BrokerJournalPolicyV1, BrokerServerError, CapabilityBundleAuthorityV1, CapabilityTrustBundleV1,
    CapabilityTrustKeyV1, CodexDispatchError, FaultInjectionPointV1, ProductCodexError,
    SignedCapabilityTrustBundleV1, capability_signing_bytes, inspect_peer_identity,
    trust_bundle_signing_bytes, verify_capability_trust_bundle,
};
use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_codex_protocol::{AgentRole, CodexExecutionRequestV1};
use std::{
    fs,
    io::Read,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-query-currentness-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn journal(&self) -> BrokerJournalStoreV1 {
        BrokerJournalStoreV1::open(
            self.0.join("journal.sqlite"),
            BrokerJournalPolicyV1::strict(nix::unistd::geteuid().as_raw()),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
struct Clock;
impl BrokerClockV1 for Clock {
    fn now_unix_ms(&self) -> Result<u64, BrokerServerError> {
        Ok(12_000)
    }
}

struct RevocableDispatcher {
    revoked: AtomicBool,
    checks: AtomicU64,
    recoveries: AtomicU64,
    revoke_after_recovery: bool,
}
impl RevocableDispatcher {
    fn new(revoke_after_recovery: bool) -> Self {
        Self {
            revoked: AtomicBool::new(false),
            checks: AtomicU64::new(0),
            recoveries: AtomicU64::new(0),
            revoke_after_recovery,
        }
    }
}
impl BrokerOperationDispatcherV1 for RevocableDispatcher {
    fn recover_before_ready(&self, _: &mut BrokerJournalStoreV1) -> Result<(), CodexDispatchError> {
        self.recoveries.fetch_add(1, Ordering::SeqCst);
        if self.revoke_after_recovery {
            self.revoked.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
    fn dispatch(
        &self,
        _: &mut BrokerJournalStoreV1,
        _: &str,
        _: &AtomicBool,
    ) -> Result<(), CodexDispatchError> {
        panic!("read-only currentness must never dispatch");
    }
    fn assert_current_authority(&self) -> Result<(), CodexDispatchError> {
        self.checks.fetch_add(1, Ordering::SeqCst);
        if self.revoked.load(Ordering::SeqCst) {
            Err(CodexDispatchError::Product(
                ProductCodexError::ConfigurationChanged,
            ))
        } else {
            Ok(())
        }
    }
}

fn manager(key: &SigningKey) -> CapabilityTrustBundleManagerV1 {
    let root = SigningKey::from_bytes(&[41; 32]);
    let bundle = CapabilityTrustBundleV1 {
        version: 1,
        generation: 1,
        issuer_id: "root".into(),
        valid_from_unix_ms: 10_000,
        valid_until_unix_ms: 20_000,
        minimum_accepted_generation: 1,
        previous_bundle_hash: None,
        keys: vec![CapabilityTrustKeyV1 {
            key_id: "key-1".into(),
            public_key_base64: Base64UrlUnpadded::encode_string(key.verifying_key().as_bytes()),
            valid_from_unix_ms: 10_000,
            valid_until_unix_ms: 20_000,
            allowed_roles: vec![AgentRole::Author],
        }],
        revocations: vec![],
    };
    let signature = root.sign(&trust_bundle_signing_bytes(&bundle).unwrap());
    let signed = SignedCapabilityTrustBundleV1 {
        bundle,
        authority_key_id: "root".into(),
        signature_base64: Base64UrlUnpadded::encode_string(&signature.to_bytes()),
    };
    let authority =
        CapabilityBundleAuthorityV1::new([("root".into(), root.verifying_key())]).unwrap();
    CapabilityTrustBundleManagerV1::new(
        verify_capability_trust_bundle(&signed, AgentRole::Author, 12_000, &authority, None)
            .unwrap(),
    )
}

fn admitted(
    stream: &UnixStream,
    key: &SigningKey,
    manager: &CapabilityTrustBundleManagerV1,
) -> AuthenticatedBrokerRequestV1 {
    let peer = inspect_peer_identity(stream).unwrap();
    let digest = format!("sha256:{}", "a".repeat(64));
    let mut request: CodexExecutionRequestV1 = serde_json::from_value(serde_json::json!({
        "version":1,"operationId":"query-operation","idempotencyKey":digest,
        "campaignId":"campaign","nodeId":"author","attemptId":"attempt","leaseGeneration":1,
        "campaignRevision":1,"role":"author","taskKind":"draft","codexRuntimeIdentityHash":digest,
        "modelSelector":"model","transport":"exec-jsonl-v1","sessionPolicy":"ephemeral-new-thread",
        "promptEnvelopeHash":digest,"inputManifestHash":digest,"workspaceIdentityHash":digest,
        "outputSchemaHash":digest,"mutationPolicyHash":digest,"sandboxPolicy":"workspace-write",
        "networkPolicy":"none","approvalPolicy":"never","absoluteDeadlineUnixMs":20000,
        "maximumOutputBytes":1048576,"maximumEventCount":100,"maximumCostMicrousd":100,
        "remainingTokenHint":null,"requestCapability":{"nonce":"nonce","issuedAtUnixMs":10000,
            "expiresAtUnixMs":15000,"signerKeyId":"key-1","peerUid":peer.uid,"peerGid":peer.gid,
            "signatureBase64":"A".repeat(86)}
    }))
    .unwrap();
    request.request_capability.signature_base64 = Base64UrlUnpadded::encode_string(
        &key.sign(&capability_signing_bytes(&request).unwrap())
            .to_bytes(),
    );
    let capability = verify_request_capability(
        &request,
        peer,
        12_000,
        CapabilityPolicyV1::default(),
        &manager.snapshot(12_000).unwrap().0,
    )
    .unwrap();
    let request_payload = serde_json::to_vec(&request).unwrap();
    let request_hash = crate::codex_dispatch::hash_bytes(&request_payload).unwrap();
    AuthenticatedBrokerRequestV1 {
        request,
        request_payload,
        request_hash,
        peer,
        capability,
    }
}

#[test]
fn revocation_stops_later_chunks_and_flush_without_mutating_the_journal() {
    let fixture = Fixture::new();
    let mut journal = fixture.journal();
    let (mut peer, mut stream) = UnixStream::pair().unwrap();
    let key = SigningKey::from_bytes(&[31; 32]);
    let manager = manager(&key);
    let admitted = admitted(&stream, &key, &manager);
    journal
        .reserve_operation(&admitted, 12_000, FaultInjectionPointV1::None)
        .unwrap();
    let original = journal.load_journal("query-operation").unwrap();
    let dispatcher = RevocableDispatcher::new(false);
    let hash = manager.snapshot(12_000).unwrap().2;
    let context = ResultQueryContext {
        journal: &journal,
        dispatcher: Some(&dispatcher),
        trust_manager: &manager,
        startup_bundle_hash: &hash,
        clock: &Clock,
        capability_policy: CapabilityPolicyV1::default(),
        response_policy: BrokerResponseFramePolicyV1::default(),
        write_timeout_ms: 2_000,
        admitted_at_unix_ms: 12_000,
    };
    let mut last_now = 12_000;
    assert!(context.check_current(&admitted, &mut last_now).is_ok());
    let mut writer = AuthorizedWriter {
        stream: &mut stream,
        context: &context,
        admitted: &admitted,
        last_now,
        started: Instant::now(),
        timeout: Duration::from_secs(2),
    };
    let payload = vec![b'x'; 3 * 64 * 1024];
    let first = writer.write(&payload).unwrap();
    assert!(first > 0 && first <= 64 * 1024);
    let mut received = vec![0; first];
    peer.read_exact(&mut received).unwrap();
    assert_eq!(received, payload[..first]);
    dispatcher.revoked.store(true, Ordering::SeqCst);
    assert_eq!(
        writer.write_all(&payload[first..]).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        writer.flush().unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    assert!(matches!(
        context.check_current(&admitted, &mut last_now),
        Err(ResultQueryError::DeliveryInterrupted)
    ));
    drop(stream);
    let mut remainder = Vec::new();
    peer.read_to_end(&mut remainder).unwrap();
    assert!(
        remainder.is_empty(),
        "already sent bytes remain; no later bytes may pass"
    );
    assert_eq!(dispatcher.checks.load(Ordering::SeqCst), 5);
    assert_eq!(journal.load_journal("query-operation").unwrap(), original);
    assert_eq!(journal.operation_count().unwrap(), 1);
}

#[test]
fn revoked_authority_refuses_the_first_frame() {
    let fixture = Fixture::new();
    let journal = fixture.journal();
    let (mut peer, mut stream) = UnixStream::pair().unwrap();
    let key = SigningKey::from_bytes(&[31; 32]);
    let manager = manager(&key);
    let admitted = admitted(&stream, &key, &manager);
    let dispatcher = RevocableDispatcher::new(false);
    dispatcher.revoked.store(true, Ordering::SeqCst);
    let hash = manager.snapshot(12_000).unwrap().2;
    let context = ResultQueryContext {
        journal: &journal,
        dispatcher: Some(&dispatcher),
        trust_manager: &manager,
        startup_bundle_hash: &hash,
        clock: &Clock,
        capability_policy: CapabilityPolicyV1::default(),
        response_policy: BrokerResponseFramePolicyV1::default(),
        write_timeout_ms: 2_000,
        admitted_at_unix_ms: 12_000,
    };
    let mut last_now = 12_000;
    assert!(matches!(
        context.check_current(&admitted, &mut last_now),
        Err(ResultQueryError::DeliveryInterrupted)
    ));
    let mut writer = AuthorizedWriter {
        stream: &mut stream,
        context: &context,
        admitted: &admitted,
        last_now,
        started: Instant::now(),
        timeout: Duration::from_secs(2),
    };
    assert!(
        write_response_frame(
            &mut writer,
            &crate::BrokerResponseV1::busy(50),
            context.response_policy
        )
        .is_err()
    );
    drop(stream);
    let mut bytes = Vec::new();
    peer.read_to_end(&mut bytes).unwrap();
    assert!(bytes.is_empty());
    assert_eq!(journal.operation_count().unwrap(), 0);
}

#[test]
fn revocation_after_dispatcher_recovery_blocks_final_readiness_check() {
    let fixture = Fixture::new();
    let ordinary = RevocableDispatcher::new(false);
    assert_eq!(
        super::super::recover_and_check_before_listener_ready(
            fixture.journal(),
            Some(&ordinary),
            12_000,
            hepta_codex_runtime::ProcessLimitsV1::default()
        )
        .unwrap(),
        0
    );
    let dispatcher = RevocableDispatcher::new(true);
    assert!(dispatcher.assert_current_authority().is_ok());
    let result = super::super::recover_and_check_before_listener_ready(
        fixture.journal(),
        Some(&dispatcher),
        12_000,
        hepta_codex_runtime::ProcessLimitsV1::default(),
    );
    assert!(matches!(
        result,
        Err(BrokerServerError::Dispatch(CodexDispatchError::Product(
            ProductCodexError::ConfigurationChanged
        )))
    ));
    assert_eq!(dispatcher.recoveries.load(Ordering::SeqCst), 1);
    assert_eq!(dispatcher.checks.load(Ordering::SeqCst), 2);
    fixture.journal().validate_integrity().unwrap();
}

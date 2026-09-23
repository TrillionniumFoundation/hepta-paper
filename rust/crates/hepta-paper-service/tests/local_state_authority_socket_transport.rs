//! Real-process tests for the connected-peer transport. A pinned signature and
//! a live peer observation do not certify installation or Rust build provenance.
use base64ct::{Base64, Encoding};
use ed25519_dalek::{
    SigningKey,
    pkcs8::{EncodePrivateKey, EncodePublicKey},
};
use hepta_paper_service::{
    local_state_authority::LocalStateAuthorityRuntimeV1,
    local_state_authority_client::{
        LocalStateAuthorityClientOptionsV1, LocalStateAuthoritySocketTransportV1,
    },
    online_runtime_activation::inventory::state_database_scope_hash_v1,
    sqlite_mutation_coordinator::{
        DATABASE_ROLES, ONLINE_MUTATION_PROTOCOL, SqliteMutationCoordinatorError,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock::{MutationClockV1, SystemMutationClockV1, iso},
        contracts::{
            build_finalize_request_v1, online_mutation_state_hash_v1, schema_transition::*,
        },
    },
};
use nix::{
    sys::signal::{Signal, kill, killpg},
    unistd::Pid,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    os::{
        fd::{AsFd, OwnedFd},
        unix::{
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

const DAEMON: &str = env!("CARGO_BIN_EXE_hepta-paper-state-authority-daemon");
const HELPER: &str = "socket_peer_fixture_process";
static NEXT: AtomicU64 = AtomicU64::new(0);

fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes.as_ref())))
}
fn record_hash(kind: &str, value: &Value) -> String {
    hepta_legacy_compatibility::production_hash_record_v1(kind, value)
        .unwrap()
        .as_str()
        .to_owned()
}
fn now() -> i64 {
    SystemMutationClockV1.now_millis().unwrap()
}
fn selected(value: &Value, fields: &[&str]) -> Value {
    Value::Object(
        fields
            .iter()
            .map(|field| ((*field).into(), value[*field].clone()))
            .collect(),
    )
}
fn write_private(path: &Path, bytes: impl AsRef<[u8]>) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-socket-peer-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn options(&self) -> LocalStateAuthorityClientOptionsV1 {
        LocalStateAuthorityClientOptionsV1 {
            socket_path: self.0.join("authority.sock"),
            timeout_ms: 5000,
            ..Default::default()
        }
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct ProcessOwner(Child, bool);
impl Drop for ProcessOwner {
    fn drop(&mut self) {
        // Only origin helpers can transfer ownership to listener descendants.
        // Other children may already have been reaped, so do not signal their
        // former numeric process group after an explicit successful wait.
        if self.1 {
            let _ = killpg(Pid::from_raw(self.0.id() as i32), Signal::SIGKILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn wait_for(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "fixture marker timeout: {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(5));
    }
}
fn wait_exit(child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "fixture process failed: {status}");
            return;
        }
        assert!(Instant::now() < deadline, "fixture child did not exit");
        thread::sleep(Duration::from_millis(5));
    }
}
fn start_daemon(directory: &Directory, configuration: &Path) -> ProcessOwner {
    let mut child = ProcessOwner(
        Command::new(DAEMON)
            .arg("--configuration")
            .arg(configuration)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .process_group(0)
            .spawn()
            .unwrap(),
        false,
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !directory.options().socket_path.exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "daemon failed before publishing"
        );
        assert!(Instant::now() < deadline, "daemon startup timeout");
        thread::sleep(Duration::from_millis(5));
    }
    child
}

struct SignedFixture {
    directory: Directory,
    daemon_configuration: PathBuf,
    online_configuration: PathBuf,
    online_hash: String,
    schema: Value,
}
impl SignedFixture {
    fn new() -> Self {
        let directory = Directory::new();
        let key = SigningKey::from_bytes(&[126; 32]);
        let private_path = directory.0.join("provided-key.pem");
        write_private(
            &private_path,
            key.to_pkcs8_pem(Default::default()).unwrap().as_bytes(),
        );
        let mut instances = DATABASE_ROLES.iter().map(|role| json!({
            "databaseRole":role,"databaseInstanceId":format!("instance:{role}"),"sourceRelativePath":format!("state/{role}.sqlite"),
            "preSchemaContractId":"schema:before","schemaContractId":"schema:after","preSchemaHash":digest(format!("before:{role}")),
            "expectedPostSchemaHash":digest(format!("after:{role}")),"sourceSha256":digest(format!("source:{role}")),
            "sourceFileIdentityHash":digest(format!("identity:{role}")),"journalPreimageHash":digest(format!("journal:{role}")),
            "expectedNormalizedSourceSha256":digest(format!("normalized:{role}")),"prePristineStateHash":digest(format!("pristine:{role}"))
        })).collect::<Vec<_>>();
        instances.sort_by(|a, b| {
            a["databaseInstanceId"]
                .as_str()
                .cmp(&b["databaseInstanceId"].as_str())
        });
        let scope = state_database_scope_hash_v1(&json!(instances.iter().map(|row| json!({"instanceId":row["databaseInstanceId"],"role":row["databaseRole"],"sourceRelativePath":row["sourceRelativePath"]})).collect::<Vec<_>>())).unwrap();
        let configuration = json!({"version":1,"kind":"HeptaLocalAutonomousResearchStateAuthorityConfiguration",
            "authorityId":"authority:socket-fixture","keyId":"key:socket-fixture","scopeId":"scope:socket-fixture",
            "databaseScopeHash":scope,"writerManifestHash":digest("fixture writers"),"privateKeyPath":private_path,
            "stateDatabasePath":directory.0.join("authority.sqlite"),"socketPath":directory.options().socket_path,
            "maximumReservationLeaseMs":60000,"maximumObservationAgeMs":60000});
        let daemon_configuration = directory.0.join("daemon.json");
        write_private(
            &daemon_configuration,
            serde_json::to_vec(&configuration).unwrap(),
        );
        let public_path = directory.0.join("public.json");
        let public_bytes = serde_json::to_vec(&json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityPublicKey",
            "authorityId":configuration["authorityId"],"keyId":configuration["keyId"],"algorithm":"ed25519",
            "publicKeyPem":key.verifying_key().to_public_key_pem(Default::default()).unwrap()})).unwrap();
        write_private(&public_path, &public_bytes);
        let mut online = configuration.as_object().unwrap().clone();
        for field in ["privateKeyPath", "stateDatabasePath", "socketPath"] {
            online.remove(field);
        }
        online.insert(
            "kind".into(),
            json!("AutonomousResearchOnlineMutationAuthorityConfiguration"),
        );
        online.insert("publicKeyPath".into(), json!(public_path));
        online.insert("publicKeySha256".into(), json!(digest(&public_bytes)));
        let online_bytes = serde_json::to_vec(&online).unwrap();
        let online_hash = digest(&online_bytes);
        let online_configuration = directory.0.join("online.json");
        write_private(&online_configuration, online_bytes);
        let mut schema = json!({"version":1,"kind":"AutonomousResearchOnlineSchemaTransitionReserveRequest","protocol":SCHEMA_TRANSITION_PROTOCOL_V1,
            "scopeId":configuration["scopeId"],"databaseScopeHash":scope,"writerManifestHash":configuration["writerManifestHash"],
            "stateDatabaseManifestHash":digest("manifest"),"transitionInventoryHash":digest("pending"),"schemaBundleHash":digest("bundle"),
            "authorityJournalSchemaContractId":"schema:journal","authorityJournalSchemaHash":digest("journal"),"markerSchemaHash":digest("marker"),
            "transitionId":digest("pending"),"instances":instances,"requestedAt":iso(now()).unwrap(),"requestedLeaseMs":60000,"requiredExecutionWindowMs":1000});
        schema["transitionInventoryHash"] =
            json!(schema_transition_inventory_hash_v1(&schema).unwrap());
        schema["transitionId"] = json!(schema_transition_identity_v1(&schema).unwrap());
        Self {
            directory,
            daemon_configuration,
            online_configuration,
            online_hash,
            schema,
        }
    }
    fn schema_finalize(&self, receipt: &Value) -> Value {
        let receipt_hash = schema_transition_receipt_hash_v1(receipt).unwrap();
        let installations = self.schema["instances"]
            .as_array()
            .unwrap()
            .iter()
            .map(|instance| {
                let mut row = selected(
                    instance,
                    &[
                        "databaseRole",
                        "databaseInstanceId",
                        "schemaContractId",
                        "preSchemaHash",
                    ],
                );
                row["postSchemaHash"] = instance["expectedPostSchemaHash"].clone();
                row["prePristineStateHash"] = instance["prePristineStateHash"].clone();
                row["postPristineStateHash"] =
                    json!(digest(format!("post:{}", instance["databaseRole"])));
                let mut body = row.clone();
                body["transitionId"] = self.schema["transitionId"].clone();
                body["reservationReceiptHash"] = json!(receipt_hash);
                row["installationHash"] = json!(record_hash(
                    "AutonomousResearchOnlineSchemaTransitionDatabaseInstallation",
                    &body
                ));
                row
            })
            .collect::<Vec<_>>();
        let mut request = selected(
            &self.schema,
            &[
                "version",
                "protocol",
                "scopeId",
                "databaseScopeHash",
                "writerManifestHash",
                "transitionId",
                "transitionInventoryHash",
                "schemaBundleHash",
            ],
        );
        request.as_object_mut().unwrap().extend(json!({"kind":"AutonomousResearchOnlineSchemaTransitionFinalizeRequest",
            "reservationId":receipt["reservationId"],"reservationReceiptHash":receipt_hash,"postInventoryHash":digest("post-inventory"),
            "postPristineRuntimeStateHash":digest("post-pristine"),"installations":installations,"completedAt":iso(now()).unwrap()}).as_object().unwrap().clone());
        request
    }
    fn initialize(
        &self,
        authority: &mut PinnedMutationAuthorityV1<LocalStateAuthoritySocketTransportV1>,
    ) {
        let schema_reservation = authority
            .reserve_schema_transition(&self.schema, now())
            .unwrap();
        let schema_finalize = self.schema_finalize(schema_reservation.value());
        let schema_finalized = authority
            .finalize_schema_transition(&schema_finalize, &schema_reservation, now())
            .unwrap();
        let mut observation = selected(
            &schema_finalize,
            &[
                "version",
                "protocol",
                "scopeId",
                "databaseScopeHash",
                "writerManifestHash",
                "transitionId",
                "transitionInventoryHash",
                "schemaBundleHash",
                "postInventoryHash",
                "postPristineRuntimeStateHash",
            ],
        );
        observation["kind"] = json!("AutonomousResearchOnlineSchemaTransitionObserveRequest");
        observation["finalizationReceiptHash"] =
            json!(schema_transition_receipt_hash_v1(schema_finalized.value()).unwrap());
        observation["nonce"] = json!("nonce:peer-schema");
        observation["requestedAt"] = json!(iso(now()).unwrap());
        authority
            .observe_schema_transition(&observation, now())
            .unwrap();
    }
    fn reserve(&self, before: &Value, attempt: &str) -> Value {
        let head = &before["databaseHeads"][0];
        let changes = b"isolated authority protocol changes";
        let post = online_mutation_state_hash_v1(&json!({"databaseRole":head["databaseRole"],"databaseInstanceId":head["databaseInstanceId"],
        "writerId":"writer:fixture","operationId":"operation:fixture","schemaHash":head["schemaHash"],"previousStateHash":head["stateHash"],
        "changesetHash":digest(changes),"databaseSequence":1,"authorizationReceiptHashes":[],"sideEffectReservationHashes":[]})).unwrap();
        json!({"version":1,"kind":"AutonomousResearchOnlineMutationReserveRequest","protocol":ONLINE_MUTATION_PROTOCOL,
        "scopeId":self.schema["scopeId"],"databaseScopeHash":self.schema["databaseScopeHash"],"writerManifestHash":self.schema["writerManifestHash"],
        "databaseRole":head["databaseRole"],"databaseInstanceId":head["databaseInstanceId"],"writerId":"writer:fixture","operationId":"operation:fixture",
        "codeProvenanceHash":digest("fixture code"),"mutationAttemptId":attempt,"globalPreviousSequence":0,"globalPreviousHash":before["globalHash"],
        "databasePreviousSequence":head["sequence"],"databasePreviousHash":head["hash"],"schemaContractId":"schema:after","schemaHash":head["schemaHash"],
        "preStateHash":head["stateHash"],"postStateHash":post,"changesetEncoding":"base64","changesetBase64":Base64::encode_string(changes),
        "changesetByteLength":changes.len(),"changesetHash":digest(changes),"authorizationReceiptHashes":[],"sideEffectReservationHashes":[],
        "requestedAt":iso(now()).unwrap(),"requestedLeaseMs":60000})
    }
    fn head_request(&self, nonce: &str) -> Value {
        json!({"version":1,"kind":"AutonomousResearchOnlineMutationCurrentHeadRequest","protocol":ONLINE_MUTATION_PROTOCOL,
            "scopeId":self.schema["scopeId"],"databaseScopeHash":self.schema["databaseScopeHash"],"writerManifestHash":self.schema["writerManifestHash"],
            "nonce":nonce,"requestedAt":iso(now()).unwrap()})
    }
}

#[test]
fn actual_daemon_peer_composes_with_pinned_schema_and_mutation_signatures() {
    let fixture = SignedFixture::new();
    let mut daemon = start_daemon(&fixture.directory, &fixture.daemon_configuration);
    let transport =
        LocalStateAuthoritySocketTransportV1::connect(&fixture.directory.options()).unwrap();
    let mut authority = PinnedMutationAuthorityV1::load(
        &fixture.online_configuration,
        &fixture.online_hash,
        transport,
    )
    .unwrap();
    fixture.initialize(&mut authority);
    let before = authority
        .observe_current_head(&fixture.head_request("nonce:before"), None, now())
        .unwrap();
    assert_eq!(before.value()["globalSequence"], 0);
    let reserve = fixture.reserve(before.value(), "attempt:socket-peer");
    let reservation = authority.reserve_mutation(&reserve, now()).unwrap();
    assert_eq!(reservation.value()["globalSequence"], 1);
    let finalize =
        build_finalize_request_v1(reservation.value(), &json!(iso(now()).unwrap())).unwrap();
    let finalized = authority
        .finalize_mutation(&finalize, &reservation, now())
        .unwrap();
    assert_eq!(finalized.value()["globalSequence"], 1);
    let after = authority
        .observe_current_head(&fixture.head_request("nonce:after"), None, now())
        .unwrap();
    assert_eq!(after.value()["globalSequence"], 1);
    assert_eq!(after.value()["globalHash"], finalized.value()["globalHash"]);
    assert!(
        after.value()["databaseHeads"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["stateHash"] == reserve["postStateHash"])
    );
    drop(authority);
    kill(Pid::from_raw(daemon.0.id() as i32), Signal::SIGTERM).unwrap();
    wait_exit(&mut daemon.0);
    assert!(!fixture.directory.options().socket_path.exists());
}

fn helper_command(root: &Path, mode: &str) -> Command {
    let mut command = Command::new("/proc/self/exe");
    command
        .args(["--exact", HELPER, "--nocapture"])
        .env("HEPTA_SOCKET_PEER_FIXTURE_ROOT", root)
        .env("HEPTA_SOCKET_PEER_FIXTURE_MODE", mode)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    command
}
fn start_helper(directory: &Directory) -> ProcessOwner {
    start_helper_mode(directory, "origin")
}
fn start_helper_mode(directory: &Directory, mode: &str) -> ProcessOwner {
    let process = ProcessOwner(
        helper_command(&directory.0, mode)
            .stdin(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap(),
        mode == "origin",
    );
    wait_for(&directory.0.join(format!("{mode}.ready")));
    process
}

fn assert_unknown(error: SqliteMutationCoordinatorError) {
    assert_eq!(
        error.details["transport"],
        "local-state-authority-socket-v1"
    );
    assert!(error.details["requestBytesSent"].as_u64().unwrap() > 0);
    assert_eq!(error.details["requestDelivery"], "sent");
    assert_eq!(error.details["authorityOutcome"], "unknown");
    assert_eq!(error.details["inspectionRequired"], true);
    assert!(!error.retryable);
    assert!(error.details.get("publicationCommitted").is_none());
    assert!(error.details.get("committed").is_none());
}

fn pinned(
    fixture: &SignedFixture,
) -> PinnedMutationAuthorityV1<LocalStateAuthoritySocketTransportV1> {
    let transport =
        LocalStateAuthoritySocketTransportV1::connect(&fixture.directory.options()).unwrap();
    PinnedMutationAuthorityV1::load(
        &fixture.online_configuration,
        &fixture.online_hash,
        transport,
    )
    .unwrap()
}

#[test]
fn same_live_peer_with_a_false_signature_is_rejected_by_the_real_pinned_verifier() {
    let fixture = SignedFixture::new();
    let mut daemon = start_daemon(&fixture.directory, &fixture.daemon_configuration);
    let mut authority = pinned(&fixture);
    fixture.initialize(&mut authority);
    let request = fixture.head_request("nonce:signature-boundary");
    let actual = authority
        .observe_current_head(&request, None, now())
        .unwrap();
    let mut forged = actual.value().clone();
    let mut signature = Base64::decode_vec(forged["signature"].as_str().unwrap()).unwrap();
    signature[0] ^= 1;
    forged["signature"] = json!(Base64::encode_string(&signature));
    // Every contract field and request binding comes from an accepted real
    // signed daemon response; only its Ed25519 signature bytes are corrupted.
    assert!(
        authority
            .verify_current_head_receipt(&forged, &request, None, now())
            .is_err()
    );
    drop(authority);
    kill(Pid::from_raw(daemon.0.id() as i32), Signal::SIGTERM).unwrap();
    wait_exit(&mut daemon.0);
    write_private(
        &fixture.directory.0.join("forged-request.json"),
        serde_json::to_vec(&request).unwrap(),
    );
    write_private(
        &fixture.directory.0.join("forged-receipt.json"),
        serde_json::to_vec(&forged).unwrap(),
    );
    let mut server = start_helper_mode(&fixture.directory, "forged");
    let mut authority = pinned(&fixture);
    let error = authority
        .observe_current_head(&request, None, now())
        .err()
        .unwrap();
    assert_eq!(
        error.code,
        "autonomous_research_online_mutation_current_head_receipt_invalid"
    );
    assert_eq!(
        fs::read_to_string(fixture.directory.0.join("forged.requests")).unwrap(),
        "1"
    );
    drop(authority);
    write_private(&fixture.directory.0.join("forged.stop"), b"stop");
    wait_exit(&mut server.0);
}

#[test]
fn dropped_reply_after_real_authority_journal_commit_remains_unknown() {
    let fixture = SignedFixture::new();
    let mut daemon = start_daemon(&fixture.directory, &fixture.daemon_configuration);
    let mut authority = pinned(&fixture);
    fixture.initialize(&mut authority);
    let head = authority
        .observe_current_head(&fixture.head_request("nonce:prepare-loss"), None, now())
        .unwrap();
    let request = fixture.reserve(head.value(), "attempt:committed-response-lost");
    drop(authority);
    kill(Pid::from_raw(daemon.0.id() as i32), Signal::SIGTERM).unwrap();
    wait_exit(&mut daemon.0);

    let mut server = start_helper_mode(&fixture.directory, "commit-drop");
    let mut transport =
        LocalStateAuthoritySocketTransportV1::connect(&fixture.directory.options()).unwrap();
    assert_unknown(transport.invoke(&request).unwrap_err());
    wait_for(&fixture.directory.0.join("commit-drop.committed"));
    assert_eq!(
        fs::read_to_string(fixture.directory.0.join("commit-drop.requests")).unwrap(),
        "1"
    );
    drop(transport);
    write_private(
        &fixture.directory.0.join("commit-drop.stop"),
        b"close real runtime",
    );
    wait_exit(&mut server.0);

    // The runtime's SQLite connection is now closed. This is an authority
    // journal commit test; no business database SQL transaction is claimed.
    let db = rusqlite::Connection::open_with_flags(
        fixture.directory.0.join("authority.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let (status, saved, receipt): (String, String, String) = db.query_row(
        "SELECT status,reserve_request_json,reservation_receipt_json FROM authority_mutation WHERE mutation_attempt_id=?1",
        ["attempt:committed-response-lost"], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    let count: i64 = db
        .query_row("SELECT count(*) FROM authority_mutation", [], |row| {
            row.get(0)
        })
        .unwrap();
    let sequence: i64 = db
        .query_row(
            "SELECT global_sequence FROM authority_metadata",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.close().unwrap();
    assert_eq!(status, "reserved");
    assert_eq!(count, 1);
    assert_eq!(
        sequence, 0,
        "reservation committed without finalizing the head"
    );
    assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), request);
    struct NoRpc;
    impl MutationAuthorityTransportV1 for NoRpc {
        fn invoke(
            &mut self,
            _: &Value,
        ) -> hepta_paper_service::sqlite_mutation_coordinator::Result<Value> {
            panic!("stored receipt verification must perform no RPC");
        }
    }
    let verifier =
        PinnedMutationAuthorityV1::load(&fixture.online_configuration, &fixture.online_hash, NoRpc)
            .unwrap();
    let verified = verifier
        .verify_stored_reservation(&serde_json::from_str::<Value>(&receipt).unwrap(), &request)
        .unwrap();
    assert_eq!(verified.value()["globalSequence"], 1);
}

fn complete_request_helper(root: &Path, mode: &str) {
    let mut runtime = (mode == "commit-drop")
        .then(|| LocalStateAuthorityRuntimeV1::open(&root.join("daemon.json")).unwrap());
    let expected = (mode == "forged").then(|| {
        serde_json::from_slice::<Value>(&fs::read(root.join("forged-request.json")).unwrap())
            .unwrap()
    });
    let forged = (mode == "forged").then(|| {
        serde_json::from_slice::<Value>(&fs::read(root.join("forged-receipt.json")).unwrap())
            .unwrap()
    });
    let listener = UnixListener::bind(root.join("authority.sock")).unwrap();
    listener.set_nonblocking(true).unwrap();
    write_private(&root.join(format!("{mode}.requests")), b"0");
    write_private(&root.join(format!("{mode}.ready")), b"ready");
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut requests = 0;
    let mut peers: Vec<(UnixStream, Vec<u8>)> = Vec::new();
    loop {
        assert!(
            Instant::now() < deadline,
            "complete request helper timed out"
        );
        if root.join(format!("{mode}.stop")).exists() {
            return;
        }
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(true).unwrap();
                    peers.push((stream, Vec::new()));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("complete request accept failed: {error}"),
            }
        }
        peers.retain_mut(|(stream, input)| {
            let mut bytes = [0u8; 4096];
            match stream.read(&mut bytes) {
                Ok(0) if input.is_empty() => false,
                Ok(0) => {
                    let request: Value = serde_json::from_slice(input).unwrap();
                    requests += 1;
                    write_private(&root.join(format!("{mode}.requests")), requests.to_string());
                    if let Some(runtime) = &mut runtime {
                        let receipt = runtime.handle(&request).unwrap();
                        assert_eq!(
                            receipt["kind"],
                            "AutonomousResearchOnlineMutationReservationReceipt"
                        );
                        // handle returns only after its actual SQLite commit.
                        // Drop this socket without sending any response byte.
                        write_private(
                            &root.join("commit-drop.committed"),
                            b"authority journal committed",
                        );
                    } else {
                        assert_eq!(&request, expected.as_ref().unwrap());
                        stream
                            .write_all(
                                serde_json::to_string(
                                    &json!({"ok":true,"receipt":forged.as_ref().unwrap()}),
                                )
                                .unwrap()
                                .as_bytes(),
                            )
                            .unwrap();
                    }
                    false
                }
                Ok(count) => {
                    input.extend_from_slice(&bytes[..count]);
                    assert!(input.len() < 1024 * 1024);
                    true
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => true,
                Err(error) => panic!("complete request read failed: {error}"),
            }
        });
        thread::sleep(Duration::from_millis(2));
    }
}
fn assert_not_sent(error: SqliteMutationCoordinatorError) {
    assert!(
        error.code.starts_with("local_state_authority_socket_peer_"),
        "{error:?}"
    );
    assert_eq!(
        error.details["transport"],
        "local-state-authority-socket-v1"
    );
    assert_eq!(error.details["requestBytesSent"], 0);
    assert_eq!(error.details["requestDelivery"], "not_sent");
    assert_eq!(error.details["authorityOutcome"], "not_invoked");
    assert_eq!(error.details["inspectionRequired"], false);
    assert!(!error.retryable);
    assert!(error.details.get("publicationCommitted").is_none());
}
fn assert_no_requests(root: &Path, name: &str) {
    write_private(&root.join(format!("{name}.snapshot")), b"snapshot");
    wait_for(&root.join(format!("{name}.snapshot-done")));
    assert_eq!(
        fs::read_to_string(root.join(format!("{name}.requests"))).unwrap(),
        "0"
    );
}

#[test]
fn exited_listener_creator_is_refused_even_while_descendant_keeps_its_listener() {
    let directory = Directory::new();
    let mut origin = start_helper(&directory);
    let mut transport =
        LocalStateAuthoritySocketTransportV1::connect(&directory.options()).unwrap();
    write_private(
        &directory.0.join("inherit"),
        b"inherit actual listening descriptor",
    );
    wait_for(&directory.0.join("inherited.ready"));
    wait_exit(&mut origin.0);
    // Linux retains the original creator credentials on an inherited listener.
    // A live successor process and connectable inode do not revive that peer.
    assert_not_sent(transport.invoke(&json!({"kind":"never-send"})).unwrap_err());
    assert_no_requests(&directory.0, "inherited");
    assert_eq!(
        fs::read_to_string(directory.0.join("origin.requests")).unwrap(),
        "0"
    );
}

#[test]
fn new_listener_at_same_path_cannot_replace_the_original_live_peer() {
    let directory = Directory::new();
    let mut origin = start_helper(&directory);
    let mut transport =
        LocalStateAuthoritySocketTransportV1::connect(&directory.options()).unwrap();
    write_private(
        &directory.0.join("rebind"),
        b"retain origin but replace named listener",
    );
    wait_for(&directory.0.join("replacement.ready"));
    assert!(origin.0.try_wait().unwrap().is_none());
    assert_not_sent(transport.invoke(&json!({"kind":"never-send"})).unwrap_err());
    assert_no_requests(&directory.0, "origin");
    assert_no_requests(&directory.0, "replacement");
    // A second attempt must keep the original baseline rather than accepting
    // the new same-UID process after the first rejection.
    assert_not_sent(
        transport
            .invoke(&json!({"kind":"still-never-send"}))
            .unwrap_err(),
    );
}

#[test]
fn response_loss_after_request_bytes_preserves_unknown_outcome_without_retry() {
    let directory = Directory::new();
    let _origin = start_helper(&directory);
    let mut transport =
        LocalStateAuthoritySocketTransportV1::connect(&directory.options()).unwrap();
    write_private(
        &directory.0.join("drop-response"),
        b"read once then close without response",
    );
    let error = transport
        .invoke(&json!({"kind":"fixture-request"}))
        .unwrap_err();
    assert_eq!(
        error.details["transport"],
        "local-state-authority-socket-v1"
    );
    assert!(error.details["requestBytesSent"].as_u64().unwrap() > 0);
    assert_eq!(error.details["requestDelivery"], "sent");
    assert_eq!(error.details["authorityOutcome"], "unknown");
    assert_eq!(error.details["inspectionRequired"], true);
    assert!(!error.retryable);
    assert!(error.details.get("publicationCommitted").is_none());
    write_private(&directory.0.join("origin.snapshot"), b"snapshot");
    wait_for(&directory.0.join("origin.snapshot-done"));
    assert_eq!(
        fs::read_to_string(directory.0.join("origin.requests")).unwrap(),
        "1"
    );
}

/// Child-only protocol instrument. Endpoint identity fixtures return untrusted
/// JSON; the forged-receipt mode tests real verifier refusal, and commit-drop
/// alone invokes the actual runtime using the explicitly supplied fixture key.
#[test]
fn socket_peer_fixture_process() {
    let Some(root) = std::env::var_os("HEPTA_SOCKET_PEER_FIXTURE_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let mode = std::env::var("HEPTA_SOCKET_PEER_FIXTURE_MODE").unwrap();
    if matches!(mode.as_str(), "forged" | "commit-drop") {
        complete_request_helper(&root, &mode);
        return;
    }
    let socket = root.join("authority.sock");
    let listener = if mode == "inherited" {
        // stdin is an actual listener descriptor installed by the original
        // process. Safe std conversions suffice; no raw-FD construction/fork.
        UnixListener::from(std::io::stdin().as_fd().try_clone_to_owned().unwrap())
    } else {
        UnixListener::bind(&socket).unwrap()
    };
    listener.set_nonblocking(true).unwrap();
    write_private(&root.join(format!("{mode}.requests")), b"0");
    write_private(
        &root.join(format!("{mode}.ready")),
        std::process::id().to_string(),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut clients: Vec<(UnixStream, bool)> = Vec::new();
    let mut requests = 0u64;
    let mut rebound = false;
    let mut replacement = None;
    loop {
        assert!(Instant::now() < deadline, "peer helper timed out");
        if mode == "origin" && root.join("inherit").exists() {
            let descriptor = OwnedFd::from(listener.try_clone().unwrap());
            // This creator must exit while the descendant retains its socket.
            // Ownership transfers to the outer dedicated ProcessOwner group;
            // cleanup signals that group and the OS reaper owns the orphan.
            // Waiting here would erase the creator-exit condition under test.
            #[allow(clippy::zombie_processes)]
            let _descendant = helper_command(&root, "inherited")
                .stdin(Stdio::from(descriptor))
                .spawn()
                .unwrap();
            wait_for(&root.join("inherited.ready"));
            return;
        }
        if mode == "origin" && !rebound && root.join("rebind").exists() {
            fs::remove_file(&socket).unwrap();
            replacement = Some(
                helper_command(&root, "replacement")
                    .stdin(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            rebound = true;
        }
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(true).unwrap();
                    clients.push((stream, false));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("fixture accept failed: {error}"),
            }
        }
        clients.retain_mut(|(stream, counted)| {
            let mut bytes = [0u8; 4096];
            match stream.read(&mut bytes) {
                Ok(0) => false,
                Ok(_) => {
                    if !*counted {
                        requests += 1;
                        write_private(&root.join(format!("{mode}.requests")), requests.to_string());
                        *counted = true;
                    }
                    if !root.join("drop-response").exists() {
                        let _ = stream.write_all(b"{\"ok\":true,\"receipt\":{\"fixture\":true}}\n");
                    }
                    false
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => true,
                Err(error) => panic!("fixture read failed: {error}"),
            }
        });
        if root.join(format!("{mode}.snapshot")).exists() {
            write_private(
                &root.join(format!("{mode}.snapshot-done")),
                b"snapshot completed",
            );
        }
        if let Some(child) = &mut replacement {
            assert!(
                child.try_wait().unwrap().is_none(),
                "replacement helper unexpectedly exited"
            );
        }
        thread::sleep(Duration::from_millis(2));
    }
}

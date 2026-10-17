//! Real Rust daemon and pinned backup socket adapter integration. These tests
//! exercise authority journal state, not business-database backup, restore,
//! installed principal isolation, or production qualification.
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
        authority::PinnedMutationAuthorityV1,
        clock::{MutationClockV1, SystemMutationClockV1, iso},
        contracts::{
            build_finalize_request_v1, online_mutation_state_hash_v1, schema_transition::*,
        },
    },
    state_backup_authority::{
        PinnedStateBackupAuthorityV1, StateBackupAuthorityTransportV1,
        VerifiedBackupAuthorityReceiptV1,
    },
};
use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

const DAEMON: &str = env!("CARGO_BIN_EXE_hepta-paper-state-authority-daemon");
const HELPER: &str = "backup_socket_fixture_process";
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
            "hepta-backup-socket-{}-{}",
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
struct ProcessOwner(Child);
impl Drop for ProcessOwner {
    fn drop(&mut self) {
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
    backup_configuration: PathBuf,
    backup_hash: String,
    schema: Value,
}
impl SignedFixture {
    fn new() -> Self {
        Self::with_instance_prefix("instance")
    }
    fn with_instance_prefix(prefix: &str) -> Self {
        let directory = Directory::new();
        let key = SigningKey::from_bytes(&[126; 32]);
        let private_path = directory.0.join("provided-key.pem");
        write_private(
            &private_path,
            key.to_pkcs8_pem(Default::default()).unwrap().as_bytes(),
        );
        let mut instances = DATABASE_ROLES.iter().map(|role| json!({
            "databaseRole":role,"databaseInstanceId":format!("{prefix}:{role}"),"sourceRelativePath":format!("state/{role}.sqlite"),
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
        let backup_public_path = directory.0.join("backup-public.json");
        let backup_public_bytes = serde_json::to_vec(&json!({
            "version":1,"kind":"AutonomousResearchStateBackupAuthorityPublicKey",
            "authorityId":configuration["authorityId"],"keyId":configuration["keyId"],"algorithm":"ed25519",
            "publicKeyPem":key.verifying_key().to_public_key_pem(Default::default()).unwrap()
        })).unwrap();
        write_private(&backup_public_path, &backup_public_bytes);
        let backup = json!({
            "version":1,"kind":"AutonomousResearchStateBackupAuthoritySocketConfiguration",
            "authorityId":configuration["authorityId"],"keyId":configuration["keyId"],
            "socketPath":directory.options().socket_path,"timeoutMs":5000,"maximumMessageBytes":1048576,
            "publicKeyPath":backup_public_path,"publicKeySha256":digest(&backup_public_bytes),
            "maximumReservationLeaseMs":60000,"maximumHeadObservationAgeMs":60000,
            "onlineMutationAuthorityConfigurationPath":online_configuration,
            "onlineMutationAuthorityConfigurationSha256":online_hash
        });
        let backup_bytes = serde_json::to_vec(&backup).unwrap();
        let backup_configuration = directory.0.join("backup.json");
        let backup_hash = digest(&backup_bytes);
        write_private(&backup_configuration, backup_bytes);
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
            backup_configuration,
            backup_hash,
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

type Backup = PinnedStateBackupAuthorityV1<LocalStateAuthoritySocketTransportV1>;
fn backup(fixture: &SignedFixture) -> Backup {
    Backup::load_socket_v1(&fixture.backup_configuration, &fixture.backup_hash).unwrap()
}
fn online(
    fixture: &SignedFixture,
) -> PinnedMutationAuthorityV1<LocalStateAuthoritySocketTransportV1> {
    PinnedMutationAuthorityV1::load(
        &fixture.online_configuration,
        &fixture.online_hash,
        LocalStateAuthoritySocketTransportV1::connect(&fixture.directory.options()).unwrap(),
    )
    .unwrap()
}
fn stop_daemon(daemon: &mut ProcessOwner) {
    kill(Pid::from_raw(daemon.0.id() as i32), Signal::SIGTERM).unwrap();
    wait_exit(&mut daemon.0);
}
fn backup_request(fixture: &SignedFixture) -> Value {
    let ids = fixture.schema["instances"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["databaseInstanceId"].clone())
        .collect::<Vec<_>>();
    json!({"version":1,"kind":"AutonomousResearchStateBackupAuthorityReserveRequest",
        "inventoryHash":digest("isolated fixture inventory"),"databaseScopeHash":fixture.schema["databaseScopeHash"],
        "databaseInstanceIds":ids,"requestedAt":iso(now()).unwrap(),"maximumLeaseMs":60000})
}
fn backup_finalize(reservation: &VerifiedBackupAuthorityReceiptV1) -> Value {
    json!({"version":1,"kind":"AutonomousResearchStateBackupAuthorityFinalizeRequest",
        "reservationId":reservation.value()["reservationId"],"inventoryHash":reservation.value()["inventoryHash"],
        "databaseScopeHash":reservation.value()["databaseScopeHash"],"snapshotContentHash":digest("fixture snapshot content"),
        "requestedAt":iso(now()).unwrap()})
}
fn backup_head(finalize: &Value) -> Value {
    json!({"version":1,"kind":"AutonomousResearchStateBackupAuthorityCurrentHeadRequest",
        "reservationId":finalize["reservationId"],"databaseScopeHash":finalize["databaseScopeHash"],
        "snapshotContentHash":finalize["snapshotContentHash"],"requestedAt":iso(now()).unwrap(),"maximumLeaseMs":60000})
}
fn backup_journal(
    fixture: &SignedFixture,
    reservation: &VerifiedBackupAuthorityReceiptV1,
    finalize: &Value,
    head: &Value,
) -> Value {
    let trust = read_json(&fixture.online_configuration);
    json!({"version":1,"kind":"AutonomousResearchStateBackupAuthorityJournalRangeRequest",
        "reservationId":finalize["reservationId"],"databaseScopeHash":finalize["databaseScopeHash"],
        "snapshotContentHash":finalize["snapshotContentHash"],"onlineAuthorityId":trust["authorityId"],
        "onlineKeyId":trust["keyId"],"scopeId":trust["scopeId"],"writerManifestHash":trust["writerManifestHash"],
        "fromGlobalSequence":reservation.value()["headSequence"],"fromGlobalHash":reservation.value()["headHash"],
        "toGlobalSequence":head["globalSequence"],"toGlobalHash":head["globalHash"],
        "requestedAt":iso(now()).unwrap(),"maximumLeaseMs":60000,"maximumEntries":4096})
}
fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn write_json(path: &Path, value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap();
    let pin = digest(&bytes);
    write_private(path, bytes);
    pin
}
fn rejected<T>(
    result: hepta_paper_service::sqlite_mutation_coordinator::Result<T>,
) -> SqliteMutationCoordinatorError {
    match result {
        Ok(_) => panic!("authority input unexpectedly accepted"),
        Err(error) => error,
    }
}

#[test]
fn actual_daemon_backup_and_nonempty_journal_verify_through_fixed_socket_adapter() {
    let fixture = SignedFixture::new();
    let mut daemon = start_daemon(&fixture.directory, &fixture.daemon_configuration);
    let mut online = online(&fixture);
    fixture.initialize(&mut online);
    let before = online
        .observe_current_head(&fixture.head_request("nonce:backup-before"), None, now())
        .unwrap();
    assert_eq!(before.value()["globalSequence"], 0);
    let mut backup = backup(&fixture);
    assert_eq!(backup.online_mutation_trust(), Some(online.trust()));
    let request = backup_request(&fixture);
    let reservation = backup.reserve_snapshot(&request, now()).unwrap();
    assert_eq!(reservation.value()["headSequence"], 0);
    let finalize = backup_finalize(&reservation);
    let finalized = backup
        .finalize_snapshot(&finalize, &reservation, now())
        .unwrap();
    assert_eq!(finalized.value()["headHash"], before.value()["globalHash"]);
    assert_eq!(
        finalized.value()["allRegisteredMutationsFencedThroughFinalize"],
        true
    );
    let mutation_request = fixture.reserve(before.value(), "attempt:backup-journal");
    let mutation_reservation = online.reserve_mutation(&mutation_request, now()).unwrap();
    let mutation_finalize =
        build_finalize_request_v1(mutation_reservation.value(), &json!(iso(now()).unwrap()))
            .unwrap();
    let mutation_finalized = online
        .finalize_mutation(&mutation_finalize, &mutation_reservation, now())
        .unwrap();
    let after = online
        .observe_current_head(&fixture.head_request("nonce:backup-after"), None, now())
        .unwrap();
    let head = backup
        .observe_current_head(&backup_head(&finalize), now())
        .unwrap();
    assert_eq!(head.value()["headSequence"], 1);
    assert_eq!(head.value()["headHash"], after.value()["globalHash"]);
    let journal_request = backup_journal(&fixture, &reservation, &finalize, after.value());
    let range = backup
        .read_finalized_mutation_journal(&journal_request, now())
        .unwrap();
    assert_eq!(range.value()["entries"].as_array().unwrap().len(), 1);
    assert_eq!(
        range.value()["entries"][0]["reserveRequest"],
        mutation_request
    );
    assert_eq!(
        range.value()["entries"][0]["finalizationReceipt"],
        *mutation_finalized.value()
    );
    for field in [
        "onlineAuthorityId",
        "onlineKeyId",
        "scopeId",
        "databaseScopeHash",
        "writerManifestHash",
    ] {
        assert_eq!(range.value()[field], journal_request[field], "{field}");
    }
    let chain = backup.verify_finalized_journal_chain(&range).unwrap();
    assert_eq!(chain.value(), range.value());
    assert_eq!(chain.value()["fromGlobalSequence"], 0);
    assert_eq!(chain.value()["toGlobalSequence"], 1);
    // An altered real signed envelope cannot create verified journal evidence.
    let mut forged = range.value().clone();
    forged["entries"][0]["reservationReceipt"]["globalHash"] = json!(digest("wrong nested head"));
    assert!(
        backup
            .verify_journal_range(&forged, &journal_request, now())
            .is_err()
    );
    drop(backup);
    drop(online);
    stop_daemon(&mut daemon);
}

fn helper(fixture: &SignedFixture, mode: &str) -> ProcessOwner {
    let child = ProcessOwner(
        Command::new("/proc/self/exe")
            .args(["--exact", HELPER, "--nocapture"])
            .env("HEPTA_BACKUP_SOCKET_FIXTURE_ROOT", &fixture.directory.0)
            .env("HEPTA_BACKUP_SOCKET_FIXTURE_MODE", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    wait_for(&fixture.directory.0.join("helper.ready"));
    child
}
fn helper_snapshot(fixture: &SignedFixture) -> Value {
    let path = fixture.directory.0.join("snapshot.json");
    if path.exists() {
        fs::remove_file(&path).unwrap();
    }
    write_private(&fixture.directory.0.join("snapshot.request"), b"snapshot");
    wait_for(&path);
    read_json(&path)
}
fn assert_no_rpc_bytes(fixture: &SignedFixture) {
    let snapshot = helper_snapshot(fixture);
    assert_eq!(snapshot["receivedBytes"], 0, "{snapshot}");
    assert_eq!(snapshot["completeRequests"], 0, "{snapshot}");
}
fn stop_helper(fixture: &SignedFixture, child: &mut ProcessOwner) {
    write_private(&fixture.directory.0.join("helper.stop"), b"stop");
    wait_exit(&mut child.0);
}
fn assert_before_send(error: SqliteMutationCoordinatorError, expected: &str) {
    assert_eq!(error.code, expected, "{error:?}");
    assert_eq!(error.details["requestBytesSent"], 0);
    assert_eq!(error.details["requestDelivery"], "not_sent");
    assert_eq!(error.details["authorityOutcome"], "not_invoked");
    assert_eq!(error.details["inspectionRequired"], false);
    assert!(!error.retryable);
    assert!(error.details.get("committed").is_none());
}

struct NeverTransport;
impl StateBackupAuthorityTransportV1 for NeverTransport {
    fn invoke(
        &mut self,
        _: &Value,
    ) -> hepta_paper_service::sqlite_mutation_coordinator::Result<Value> {
        panic!("configuration validation must not invoke arbitrary transport")
    }
}

#[test]
fn socket_and_legacy_process_configuration_kinds_are_mutually_exclusive() {
    let fixture = SignedFixture::new();
    let mut server = helper(&fixture, "counter");
    let socket = read_json(&fixture.backup_configuration);
    let command = fixture.directory.0.join("legacy-command");
    write_private(&command, b"#!/bin/sh\nexit 93\n");
    fs::set_permissions(&command, fs::Permissions::from_mode(0o700)).unwrap();
    for version in [1, 2] {
        let mut process = socket.clone();
        let fields = process.as_object_mut().unwrap();
        fields.remove("socketPath");
        fields.remove("maximumMessageBytes");
        if version == 1 {
            fields.remove("onlineMutationAuthorityConfigurationPath");
            fields.remove("onlineMutationAuthorityConfigurationSha256");
        }
        fields.insert(
            "kind".into(),
            json!("AutonomousResearchStateBackupAuthorityProcessConfiguration"),
        );
        fields.insert("version".into(), json!(version));
        fields.insert("commandPath".into(), json!(command));
        fields.insert(
            "commandSha256".into(),
            json!(digest(fs::read(&command).unwrap())),
        );
        fields.insert("fixedArguments".into(), json!([]));
        let path = fixture.directory.0.join(format!("process-v{version}.json"));
        let pin = write_json(&path, &process);
        assert!(PinnedStateBackupAuthorityV1::load_process(&path, &pin).is_ok());
        assert_eq!(
            rejected(Backup::load_socket_v1(&path, &pin)).code,
            "autonomous_research_state_backup_authority_socket_configuration_invalid"
        );
    }
    assert_eq!(
        rejected(PinnedStateBackupAuthorityV1::load_process(
            &fixture.backup_configuration,
            &fixture.backup_hash
        ))
        .code,
        "autonomous_research_state_backup_authority_process_configuration_invalid"
    );
    assert_eq!(
        rejected(PinnedStateBackupAuthorityV1::load(
            &fixture.backup_configuration,
            &fixture.backup_hash,
            NeverTransport
        ))
        .code,
        "autonomous_research_state_backup_authority_process_configuration_invalid"
    );
    // A valid strict socket configuration creates its own fixed transport.
    assert!(Backup::load_socket_v1(&fixture.backup_configuration, &fixture.backup_hash).is_ok());
    assert_no_rpc_bytes(&fixture);
    stop_helper(&fixture, &mut server);
}

#[test]
fn strict_configuration_and_online_identity_mismatches_send_no_request_bytes() {
    let fixture = SignedFixture::new();
    let mut server = helper(&fixture, "counter");
    let original = read_json(&fixture.backup_configuration);
    let public = read_json(Path::new(original["publicKeyPath"].as_str().unwrap()));
    for mode in [
        "version",
        "extra",
        "missing",
        "process-fields",
        "duplicate",
        "pin",
        "authority-id",
        "key-id",
        "key-material",
        "lease",
        "age",
    ] {
        let mut configuration = original.clone();
        let mut document = public.clone();
        match mode {
            "version" => configuration["version"] = json!(2),
            "extra" => configuration["unknown"] = json!(true),
            "missing" => {
                configuration
                    .as_object_mut()
                    .unwrap()
                    .remove("maximumMessageBytes");
            }
            "process-fields" => {
                configuration["commandPath"] = json!("/unreachable/command");
            }
            "authority-id" | "key-id" => {
                let field = if mode == "authority-id" {
                    "authorityId"
                } else {
                    "keyId"
                };
                configuration[field] = json!("identity:different");
                document[field] = configuration[field].clone();
            }
            "key-material" => {
                document["publicKeyPem"] = json!(
                    SigningKey::from_bytes(&[127; 32])
                        .verifying_key()
                        .to_public_key_pem(Default::default())
                        .unwrap()
                );
            }
            "lease" => configuration["maximumReservationLeaseMs"] = json!(30000),
            "age" => configuration["maximumHeadObservationAgeMs"] = json!(30000),
            "duplicate" | "pin" => {}
            _ => unreachable!(),
        }
        if matches!(mode, "authority-id" | "key-id" | "key-material") {
            let public_path = fixture.directory.0.join(format!("{mode}.public.json"));
            configuration["publicKeySha256"] = json!(write_json(&public_path, &document));
            configuration["publicKeyPath"] = json!(public_path);
        }
        let path = fixture
            .directory
            .0
            .join(format!("{mode}.configuration.json"));
        let mut pin = write_json(&path, &configuration);
        if mode == "duplicate" {
            let text = fs::read_to_string(&path)
                .unwrap()
                .replacen('{', "{\"version\":1,", 1);
            write_private(&path, text.as_bytes());
            pin = digest(text.as_bytes());
        } else if mode == "pin" {
            pin = digest("not the configuration");
        }
        let error = rejected(Backup::load_socket_v1(&path, &pin));
        if matches!(
            mode,
            "authority-id" | "key-id" | "key-material" | "lease" | "age"
        ) {
            assert_eq!(
                error.code, "autonomous_research_state_backup_online_authority_binding_mismatch",
                "{mode}: {error:?}"
            );
        } else if !matches!(mode, "duplicate" | "pin") {
            assert_eq!(
                error.code,
                "autonomous_research_state_backup_authority_socket_configuration_invalid",
                "{mode}: {error:?}"
            );
        }
        let snapshot = helper_snapshot(&fixture);
        assert_eq!(snapshot["acceptedConnections"], 0, "{mode}: {snapshot}");
        assert_eq!(snapshot["receivedBytes"], 0, "{mode}: {snapshot}");
        assert_eq!(snapshot["completeRequests"], 0, "{mode}: {snapshot}");
    }
    stop_helper(&fixture, &mut server);
}

#[test]
fn request_scope_lease_and_opaque_configuration_binding_are_checked_before_sending() {
    let fixture = SignedFixture::new();
    let mut daemon = start_daemon(&fixture.directory, &fixture.daemon_configuration);
    let mut online = online(&fixture);
    fixture.initialize(&mut online);
    let before = online
        .observe_current_head(&fixture.head_request("nonce:scope-before"), None, now())
        .unwrap();
    let mut authority = backup(&fixture);
    let request = backup_request(&fixture);
    let reservation = authority.reserve_snapshot(&request, now()).unwrap();
    let finalize = backup_finalize(&reservation);
    drop(authority);
    drop(online);
    stop_daemon(&mut daemon);
    let mut server = helper(&fixture, "counter");
    let mut authority = backup(&fixture);
    let scope_code = "autonomous_research_state_backup_authority_socket_request_scope_mismatch";
    let lease_code = "autonomous_research_state_backup_authority_socket_request_lease_invalid";
    let request_code = "autonomous_research_state_backup_authority_socket_request_invalid";
    let mut wrong = request.clone();
    wrong["databaseScopeHash"] = json!(digest("wrong scope"));
    assert_before_send(
        rejected(authority.reserve_snapshot(&wrong, now())),
        scope_code,
    );
    wrong = finalize.clone();
    wrong["databaseScopeHash"] = json!(digest("wrong scope"));
    assert_before_send(
        rejected(authority.finalize_snapshot(&wrong, &reservation, now())),
        scope_code,
    );
    wrong = backup_head(&finalize);
    wrong["databaseScopeHash"] = json!(digest("wrong scope"));
    assert_before_send(
        rejected(authority.observe_current_head(&wrong, now())),
        scope_code,
    );
    // Only local validation is exercised here; toGlobalSequence is a proposed
    // range bound, not a claim that this helper contains a finalized mutation.
    let mut proposed_head = before.value().clone();
    proposed_head["globalSequence"] = json!(1);
    proposed_head["globalHash"] = json!(digest("proposed next global head"));
    let journal = backup_journal(&fixture, &reservation, &finalize, &proposed_head);
    for field in [
        "databaseScopeHash",
        "onlineAuthorityId",
        "onlineKeyId",
        "scopeId",
        "writerManifestHash",
    ] {
        wrong = journal.clone();
        wrong[field] = if field.ends_with("Hash") {
            json!(digest("wrong binding"))
        } else {
            json!("identity:wrong")
        };
        assert_before_send(
            rejected(authority.read_finalized_mutation_journal(&wrong, now())),
            scope_code,
        );
    }
    for lease in [999, 60001] {
        wrong = request.clone();
        wrong["maximumLeaseMs"] = json!(lease);
        assert_before_send(
            rejected(authority.reserve_snapshot(&wrong, now())),
            lease_code,
        );
        wrong = backup_head(&finalize);
        wrong["maximumLeaseMs"] = json!(lease);
        assert_before_send(
            rejected(authority.observe_current_head(&wrong, now())),
            lease_code,
        );
        wrong = journal.clone();
        wrong["maximumLeaseMs"] = json!(lease);
        assert_before_send(
            rejected(authority.read_finalized_mutation_journal(&wrong, now())),
            lease_code,
        );
    }
    wrong = request.clone();
    wrong["kind"] = json!("AutonomousResearchStateBackupAuthorityCurrentHeadRequest");
    assert_before_send(
        rejected(authority.reserve_snapshot(&wrong, now())),
        request_code,
    );
    wrong = request.clone();
    wrong["unexpected"] = json!(true);
    assert_before_send(
        rejected(authority.reserve_snapshot(&wrong, now())),
        request_code,
    );
    let mut different = read_json(&fixture.backup_configuration);
    different["timeoutMs"] = json!(6000);
    let path = fixture.directory.0.join("different-configuration.json");
    let pin = write_json(&path, &different);
    let mut other = Backup::load_socket_v1(&path, &pin).unwrap();
    assert_ne!(other.configuration_hash(), authority.configuration_hash());
    assert_eq!(
        rejected(other.finalize_snapshot(&finalize, &reservation, now())).code,
        "autonomous_research_state_backup_authority_reservation_invalid"
    );
    assert_no_rpc_bytes(&fixture);
    drop(other);
    drop(authority);
    stop_helper(&fixture, &mut server);
}

#[test]
fn committed_backup_reservation_with_lost_response_remains_unknown_without_retry() {
    let fixture = SignedFixture::new();
    let mut daemon = start_daemon(&fixture.directory, &fixture.daemon_configuration);
    let mut online = online(&fixture);
    fixture.initialize(&mut online);
    drop(online);
    stop_daemon(&mut daemon);
    let mut server = helper(&fixture, "commit-drop");
    let mut authority = backup(&fixture);
    let request = backup_request(&fixture);
    let error = rejected(authority.reserve_snapshot(&request, now()));
    assert_eq!(
        error.details["transport"],
        "local-state-authority-socket-v1"
    );
    assert!(error.details["requestBytesSent"].as_u64().unwrap() > 0);
    assert_eq!(error.details["requestDelivery"], "sent");
    assert_eq!(error.details["authorityOutcome"], "unknown");
    assert_eq!(error.details["inspectionRequired"], true);
    assert!(!error.retryable);
    assert!(error.details.get("committed").is_none());
    assert!(error.details.get("publicationCommitted").is_none());
    wait_for(&fixture.directory.0.join("committed"));
    let snapshot = helper_snapshot(&fixture);
    assert_eq!(snapshot["completeRequests"], 1);
    stop_helper(&fixture, &mut server);
    // All SQLite owners are closed before opening the authority journal here.
    // This proves a backup reservation committed, not a business SQL mutation.
    let connection = rusqlite::Connection::open_with_flags(
        fixture.directory.0.join("authority.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let count: i64 = connection
        .query_row(
            "SELECT count(*) FROM authority_backup_reservation",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    let (stored_request, stored_receipt, finalize): (String, String, Option<String>) = connection.query_row(
        "SELECT reserve_request_json,reservation_receipt_json,finalization_receipt_json FROM authority_backup_reservation",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    let sequence: i64 = connection
        .query_row(
            "SELECT global_sequence FROM authority_metadata WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(sequence, 0);
    assert!(finalize.is_none());
    drop(connection);
    assert_eq!(
        serde_json::from_str::<Value>(&stored_request).unwrap(),
        request
    );
    let verified = authority
        .verify_reservation(
            &serde_json::from_str(&stored_receipt).unwrap(),
            &request,
            now(),
        )
        .unwrap();
    assert_eq!(verified.value()["headSequence"], 0);
}

/// Child-only instrument: counter observes actual received bytes; commit-drop
/// runs the real runtime and closes the stream after handle commits its journal.
#[test]
fn backup_socket_fixture_process() {
    let Some(root) = std::env::var_os("HEPTA_BACKUP_SOCKET_FIXTURE_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let mode = std::env::var("HEPTA_BACKUP_SOCKET_FIXTURE_MODE").unwrap();
    assert!(matches!(mode.as_str(), "counter" | "commit-drop"));
    let mut runtime = (mode == "commit-drop")
        .then(|| LocalStateAuthorityRuntimeV1::open(&root.join("daemon.json")).unwrap());
    let listener = UnixListener::bind(root.join("authority.sock")).unwrap();
    listener.set_nonblocking(true).unwrap();
    write_private(&root.join("helper.ready"), b"ready");
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut peers: Vec<(UnixStream, Vec<u8>)> = Vec::new();
    let mut accepted_connections = 0u64;
    let mut received_bytes = 0u64;
    let mut complete_requests = 0u64;
    loop {
        assert!(Instant::now() < deadline, "backup helper timeout");
        if root.join("helper.stop").exists() {
            return;
        }
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    accepted_connections += 1;
                    stream.set_nonblocking(true).unwrap();
                    peers.push((stream, Vec::new()));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("backup helper accept: {error}"),
            }
        }
        peers.retain_mut(|(stream, input)| {
            loop {
                let mut bytes = [0u8; 4096];
                match stream.read(&mut bytes) {
                    Ok(0) if input.is_empty() => return false,
                    Ok(0) => {
                        complete_requests += 1;
                        if let Some(runtime) = &mut runtime {
                            let request: Value = serde_json::from_slice(input).unwrap();
                            let receipt = runtime.handle(&request).unwrap();
                            assert_eq!(
                                receipt["kind"],
                                "AutonomousResearchStateBackupAuthorityReservation"
                            );
                            write_private(
                                &root.join("committed"),
                                b"actual authority journal commit completed",
                            );
                        }
                        // No response is fabricated; any request to the counter
                        // or the committed runtime deliberately receives EOF.
                        return false;
                    }
                    Ok(count) => {
                        received_bytes += count as u64;
                        input.extend_from_slice(&bytes[..count]);
                        assert!(input.len() <= 1024 * 1024);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return true,
                    Err(error) => panic!("backup helper read: {error}"),
                }
            }
        });
        let snapshot = root.join("snapshot.request");
        if snapshot.exists() {
            fs::remove_file(snapshot).unwrap();
            let complete = root.join("snapshot.complete.json");
            write_json(
                &complete,
                &json!({"acceptedConnections":accepted_connections,"receivedBytes":received_bytes,"completeRequests":complete_requests}),
            );
            fs::rename(complete, root.join("snapshot.json")).unwrap();
        }
        thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn pure_verifiers_reject_genuine_signed_receipts_from_a_different_database_scope() {
    let fixture = SignedFixture::new();
    let mut daemon = start_daemon(&fixture.directory, &fixture.daemon_configuration);
    let mut online_authority = online(&fixture);
    fixture.initialize(&mut online_authority);
    let mut authority = backup(&fixture);
    let own_reservation = authority
        .reserve_snapshot(&backup_request(&fixture), now())
        .unwrap();
    drop(authority);
    drop(online_authority);
    stop_daemon(&mut daemon);
    let mut counter = helper(&fixture, "counter");
    let authority = backup(&fixture);

    // This second daemon has the same actual Ed25519 key and authority/key IDs,
    // but initializes different real instance identities and database scope.
    let outside = SignedFixture::with_instance_prefix("outside");
    assert_ne!(
        fixture.schema["databaseScopeHash"],
        outside.schema["databaseScopeHash"]
    );
    let mut outside_daemon = start_daemon(&outside.directory, &outside.daemon_configuration);
    let mut outside_online = online(&outside);
    outside.initialize(&mut outside_online);
    let before = outside_online
        .observe_current_head(&outside.head_request("nonce:outside-before"), None, now())
        .unwrap();
    let mut outside_backup = backup(&outside);
    assert_eq!(authority.trust(), outside_backup.trust());
    let reserve_request = backup_request(&outside);
    let reservation = outside_backup
        .reserve_snapshot(&reserve_request, now())
        .unwrap();
    let finalize_request = backup_finalize(&reservation);
    let finalized = outside_backup
        .finalize_snapshot(&finalize_request, &reservation, now())
        .unwrap();
    let mutation_request = outside.reserve(before.value(), "attempt:outside-scope");
    let mutation = outside_online
        .reserve_mutation(&mutation_request, now())
        .unwrap();
    let mutation_finalize =
        build_finalize_request_v1(mutation.value(), &json!(iso(now()).unwrap())).unwrap();
    outside_online
        .finalize_mutation(&mutation_finalize, &mutation, now())
        .unwrap();
    let after = outside_online
        .observe_current_head(&outside.head_request("nonce:outside-after"), None, now())
        .unwrap();
    let head_request = backup_head(&finalize_request);
    let head = outside_backup
        .observe_current_head(&head_request, now())
        .unwrap();
    let journal_request = backup_journal(&outside, &reservation, &finalize_request, after.value());
    let journal = outside_backup
        .read_finalized_mutation_journal(&journal_request, now())
        .unwrap();
    outside_backup
        .verify_finalized_journal_chain(&journal)
        .unwrap();

    // Use this verifier's own opaque reservation so configuration binding does
    // not short-circuit the pure finalization request-scope check.
    for error in [
        rejected(authority.verify_reservation(reservation.value(), &reserve_request, now())),
        rejected(authority.verify_finalization(
            finalized.value(),
            &finalize_request,
            &own_reservation,
            now(),
        )),
        rejected(authority.verify_current_head(head.value(), &head_request, now())),
        rejected(authority.verify_journal_range(journal.value(), &journal_request, now())),
    ] {
        assert_eq!(
            error.code,
            "autonomous_research_state_backup_authority_socket_request_scope_mismatch"
        );
        assert!(error.details.get("requestDelivery").is_none());
        assert!(error.details.get("authorityOutcome").is_none());
    }
    assert_no_rpc_bytes(&fixture);
    drop(outside_backup);
    drop(outside_online);
    stop_daemon(&mut outside_daemon);
    drop(authority);
    stop_helper(&fixture, &mut counter);
}

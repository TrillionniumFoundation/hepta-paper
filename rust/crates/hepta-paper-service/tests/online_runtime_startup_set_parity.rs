//! Real ten-database startup reconciliation composition.
//! The Node process is used only as a receipt/hash oracle; no production key
//! or authority process is used.
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_paper_service::{
    online_runtime_activation::startup_inventory::reconcile_online_mutation_startup_set_v1,
    sqlite_mutation_coordinator::{
        Result,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        clock::iso,
        contracts::activation::unresolved_reservation_set_hash_v1,
        contracts::online_mutation_receipt_hash_v1,
        manifest::writer_manifest_hash_v1,
    },
    state_database_inventory::observe_state_database_inventory_v1,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

const NOW: i64 = 1_789_560_000_000;
static NEXT: AtomicU64 = AtomicU64::new(0);

fn oracle(name: &str, input: &Value) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle").join(name))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

struct Fixture {
    root: PathBuf,
    value: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-backup-cli-e2e-startup-set-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let value = oracle(
            "state-safety-composition-v1.mjs",
            &json!({"mode":"fixture","root":root}),
        );
        assert_eq!(value["ok"], true, "{}", value["error"]);
        Self {
            root,
            value: value["value"].clone(),
        }
    }
    fn path(&self, key: &str) -> PathBuf {
        self.value[key].as_str().unwrap().into()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn hash(kind: &str, value: &Value) -> String {
    hepta_legacy_compatibility::production_hash_record_v1(kind, value)
        .unwrap()
        .as_str()
        .into()
}
fn pin(path: &Path) -> String {
    format!(
        "sha256:{}",
        hex::encode(Sha256::digest(fs::read(path).unwrap()))
    )
}

struct Broker {
    calls: Arc<Mutex<Vec<Value>>>,
    invalid_signature: bool,
}
fn failure(
    code: &str,
) -> hepta_paper_service::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    hepta_paper_service::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
        code: code.into(),
        details: json!({}),
        state_recoverability_fatal: false,
        state_recoverability_deferred: false,
        retryable: false,
    }
}
impl MutationAuthorityTransportV1 for Broker {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        self.calls.lock().unwrap().push(request.clone());
        if request["kind"] != "AutonomousResearchOnlineUnresolvedReservationListRequest" {
            return Err(failure("unexpected_startup_set_rpc"));
        }
        let mut receipt = request.clone();
        receipt["authorityId"] = json!("authority:cli");
        receipt["keyId"] = json!("key:cli");
        receipt["requestHash"] = json!(hash(
            "AutonomousResearchOnlineUnresolvedReservationListRequest",
            request
        ));
        receipt["kind"] = json!("AutonomousResearchOnlineUnresolvedReservationListReceipt");
        receipt["status"] = json!("autonomous_research_online_unresolved_reservations_observed");
        receipt["unresolvedReservationCount"] = json!(0);
        receipt["unresolvedReservationSetHash"] =
            json!(unresolved_reservation_set_hash_v1(&json!([]))?);
        receipt["unresolvedReservations"] = json!([]);
        receipt["observedAt"] = request["requestedAt"].clone();
        receipt["expiresAt"] = json!(iso(NOW + 60_000)?);
        let key = SigningKey::from_bytes(&[92; 32]);
        receipt["signature"] = json!(Base64::encode_string(&key.sign(
            hepta_paper_service::sqlite_mutation_coordinator::contracts::online_mutation_signed_payload_v1(&receipt)?.as_bytes()
        ).to_bytes()));
        if self.invalid_signature {
            receipt["signature"] = json!(Base64::encode_string(&[0; 64]));
        }
        Ok(receipt)
    }
}

#[test]
fn all_ten_startup_reconciliations_are_real_opaque_and_node_hash_compatible() {
    let fixture = Fixture::new();
    let inventory =
        observe_state_database_inventory_v1(&fixture.path("runtime"), &fixture.value["manifest"])
            .unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mut authority = PinnedMutationAuthorityV1::load(
        &fixture.path("onlineConfiguration"),
        &pin(&fixture.path("onlineConfiguration")),
        Broker {
            calls: calls.clone(),
            invalid_signature: false,
        },
    )
    .unwrap();
    assert_eq!(
        authority.trust()["writerManifestHash"],
        writer_manifest_hash_v1(&fixture.value["writerManifest"]).unwrap()
    );
    let proof = reconcile_online_mutation_startup_set_v1(
        &inventory,
        &fixture.value["writerManifest"],
        &mut authority,
        &mut || Ok(NOW),
    )
    .unwrap();
    assert_eq!(proof.value()["databaseCount"], 10);
    assert_eq!(proof.value()["runtimeReady"], false);
    assert_eq!(proof.database_reconciliations().len(), 10);
    assert_eq!(calls.lock().unwrap().len(), 20);
    let node = oracle(
        "online-runtime-startup-set-v1.mjs",
        &json!({"report":proof.value()}),
    );
    assert_eq!(node["ok"], true, "{node}");
    for (native, expected) in proof
        .database_reconciliations()
        .iter()
        .zip(node["hashes"].as_array().unwrap())
    {
        assert_eq!(native.0, expected["databaseRole"]);
        assert_eq!(native.1, expected["databaseInstanceId"]);
        assert_eq!(
            online_mutation_receipt_hash_v1(native.2.value()).unwrap(),
            expected["reconciliationReceiptHash"]
        );
    }
    proof
        .assert_current(&inventory, &authority, &mut || Ok(NOW))
        .unwrap();
    assert!(
        proof
            .assert_current(&inventory, &authority, &mut || Ok(NOW + 60_001))
            .is_err()
    );
    assert!(
        proof
            .assert_current(&inventory, &authority, &mut || Ok(NOW - 1))
            .is_err()
    );
}

#[test]
fn startup_set_rejects_invalid_signature_and_post_reconciliation_identity_drift() {
    let fixture = Fixture::new();
    let inventory =
        observe_state_database_inventory_v1(&fixture.path("runtime"), &fixture.value["manifest"])
            .unwrap();
    let config = fixture.path("onlineConfiguration");
    let mut authority = PinnedMutationAuthorityV1::load(
        &config,
        &pin(&config),
        Broker {
            calls: Arc::new(Mutex::new(Vec::new())),
            invalid_signature: true,
        },
    )
    .unwrap();
    let error = match reconcile_online_mutation_startup_set_v1(
        &inventory,
        &fixture.value["writerManifest"],
        &mut authority,
        &mut || Ok(NOW),
    ) {
        Ok(_) => panic!("invalid signature unexpectedly accepted"),
        Err(error) => error,
    };
    assert!(
        error
            .code
            .contains("unresolved_reservation_list_receipt_invalid")
            || error.code.contains("signature"),
        "{}",
        error.code
    );
    let mut authority = PinnedMutationAuthorityV1::load(
        &config,
        &pin(&config),
        Broker {
            calls: Arc::new(Mutex::new(Vec::new())),
            invalid_signature: false,
        },
    )
    .unwrap();
    let proof = reconcile_online_mutation_startup_set_v1(
        &inventory,
        &fixture.value["writerManifest"],
        &mut authority,
        &mut || Ok(NOW),
    )
    .unwrap();
    let first = inventory.value()["instances"][0]["sourceRelativePath"]
        .as_str()
        .unwrap();
    fs::OpenOptions::new()
        .append(true)
        .open(fixture.path("runtime").join(first))
        .unwrap()
        .write_all(b"drift")
        .unwrap();
    assert!(
        proof
            .assert_current(&inventory, &authority, &mut || Ok(NOW))
            .is_err()
    );
}

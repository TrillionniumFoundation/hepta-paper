use hepta_paper_service::{
    online_mutation_composition::{
        BuiltinOnlineMutationPlansV1, compose_configured_online_mutation_coordinator_v1,
    },
    sqlite_mutation_coordinator::{
        Result,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
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
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-native-schema-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Server {
    child: std::process::Child,
    input: std::process::ChildStdin,
    output: std::io::BufReader<std::process::ChildStdout>,
}
impl Server {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child = Command::new("node")
            .arg(root.join("rust/oracle/online-schema-transition-v1.mjs"))
            .arg("--serve")
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = std::io::BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
        }
    }
    fn ask(&mut self, value: &Value) -> Value {
        use std::io::BufRead;
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
        let mut output = String::new();
        self.output.read_line(&mut output).unwrap();
        serde_json::from_str(&output).unwrap()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn actual_runtime(root: &Temp) -> (Value, Arc<std::sync::Mutex<Server>>) {
    let mut server = Server::new();
    let out = server.ask(&json!({"operation":"runtime-fixture","root":root.0}));
    assert_eq!(out["ok"], true, "{out}");
    (
        out["value"].clone(),
        Arc::new(std::sync::Mutex::new(server)),
    )
}

#[test]
fn all_134_original_operations_and_486_statements_are_native_source_and_hash_bound() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let output = Command::new("node")
        .arg(root.join("rust/oracle/online-mutation-composition-v1.mjs"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&expected["profile"]).unwrap();
    let native = BuiltinOnlineMutationPlansV1::load().unwrap();
    assert_eq!(native.writer_manifest(), &expected["manifest"]);
    assert_eq!(native.operation_plans(), &expected["plans"]);
    assert_eq!(
        native.checked_plans().manifest_hash(),
        expected["checked"]["manifestHash"]
    );
    let plans = native.operation_plans().as_object().unwrap();
    assert_eq!(plans.len(), 134);
    assert_eq!(
        plans
            .values()
            .map(|p| p["statements"].as_array().unwrap().len())
            .sum::<usize>(),
        486
    );
    for id in plans.keys() {
        assert_eq!(
            native.checked_plans().get(id).unwrap().projection(),
            expected["checked"]["byOperationId"][id],
            "{id}"
        );
    }
}
struct NoRpc(Arc<AtomicUsize>);
impl MutationAuthorityTransportV1 for NoRpc {
    fn invoke(&mut self, _: &Value) -> Result<Value> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(
            hepta_paper_service::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
                code: "test_transport_must_not_run".into(),
                details: json!({}),
                state_recoverability_fatal: false,
                state_recoverability_deferred: false,
                retryable: false,
            },
        )
    }
}
#[test]
fn configured_stage_uses_real_inventory_and_pinned_scope_without_external_calls_or_ready_status() {
    let root = Temp::new();
    let (fixture, _server) = actual_runtime(&root);
    let runtime = Path::new(fixture["runtimeRoot"].as_str().unwrap());
    let inventory =
        observe_state_database_inventory_v1(runtime, &fixture["stateDatabaseManifest"]).unwrap();
    let config_path = Path::new(fixture["configurationPath"].as_str().unwrap());
    let original = fs::read(config_path).unwrap();
    let now =
        hepta_paper_service::journal_connector_coverage::qualification::canonical_instant_millis(
            fixture["now"].as_str().unwrap(),
        )
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let load = || {
        PinnedMutationAuthorityV1::load(
            config_path,
            &format!(
                "sha256:{}",
                hex::encode(Sha256::digest(fs::read(config_path).unwrap()))
            ),
            NoRpc(calls.clone()),
        )
        .unwrap()
    };
    let coordinator = compose_configured_online_mutation_coordinator_v1(
        &inventory,
        load(),
        Box::new(move || Ok(now)),
    )
    .unwrap();
    let status = coordinator.inspect_status();
    assert_eq!(
        status["status"],
        "externally_fenced_sqlite_mutation_coordinator_configured"
    );
    assert_eq!(
        status["blockers"],
        json!(["autonomous_research_online_mutation_runtime_activation_required"])
    );
    assert_eq!(status["coveredDatabaseRoles"].as_array().unwrap().len(), 10);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    for field in ["writerManifestHash", "databaseScopeHash"] {
        let mut configuration: Value = serde_json::from_slice(&original).unwrap();
        configuration[field] = json!(format!("sha256:{}", "a".repeat(64)));
        fs::write(config_path, serde_json::to_vec(&configuration).unwrap()).unwrap();
        let error = compose_configured_online_mutation_coordinator_v1(
            &inventory,
            load(),
            Box::new(move || Ok(now)),
        )
        .err()
        .expect("mismatched trust must fail");
        assert_eq!(
            error.code,
            "autonomous_research_online_mutation_composition_authority_scope_mismatch"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    fs::write(config_path, &original).unwrap();
    let stale = load();
    fs::OpenOptions::new()
        .append(true)
        .open(config_path)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    assert!(
        compose_configured_online_mutation_coordinator_v1(
            &inventory,
            stale,
            Box::new(move || Ok(now))
        )
        .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    fs::write(config_path, &original).unwrap();
    let selected = runtime.join(
        inventory.value()["instances"][0]["sourceRelativePath"]
            .as_str()
            .unwrap(),
    );
    fs::OpenOptions::new()
        .append(true)
        .open(selected)
        .unwrap()
        .write_all(b"changed")
        .unwrap();
    assert!(
        compose_configured_online_mutation_coordinator_v1(
            &inventory,
            load(),
            Box::new(move || Ok(now))
        )
        .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

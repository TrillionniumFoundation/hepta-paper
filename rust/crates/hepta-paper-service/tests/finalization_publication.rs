//! Signed ten-database fixture coverage for the durable FINAL receipt boundary.
use hepta_legacy_compatibility::production_hash_record_v1;
use hepta_paper_service::{
    online_schema_execution::maintenance::normalization::finalization::publication::{
        NoSchemaFinalReceiptCheckpointV1, PreparedSchemaTransitionAuditV1,
        SchemaFinalReceiptCheckpointV1, SchemaTransitionAuditInputV1,
        prepare_schema_transition_audit_v1, publish_schema_transition_final_receipt_v1,
    },
    sqlite_mutation_coordinator::{
        Result,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
        contracts::schema_transition::{
            schema_transition_identity_v1, schema_transition_receipt_hash_v1,
        },
    },
    state_database_inventory::observe_state_database_inventory_v1,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn file_digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}
fn plan_from_audit(audit: &Value) -> Value {
    let mut plan = audit["reserveRequest"].clone();
    let planned_at = plan["requestedAt"].clone();
    plan.as_object_mut().unwrap().remove("requestedAt");
    plan["kind"] = json!("AutonomousResearchOnlineSchemaTransitionPlan");
    plan["plannedAt"] = planned_at;
    let mut base = plan.clone();
    base.as_object_mut().unwrap().remove("transitionId");
    plan["planHash"] = json!(
        production_hash_record_v1("AutonomousResearchOnlineSchemaTransitionPlan", &base)
            .unwrap()
            .as_str()
    );
    plan["transitionId"] = json!(schema_transition_identity_v1(&plan).unwrap());
    plan
}

struct Fixture {
    root: PathBuf,
    runtime: PathBuf,
    value: Value,
    process: std::process::Child,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-native-schema-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut process = Command::new("node")
            .arg(repo.join("rust/oracle/online-schema-transition-v1.mjs"))
            .arg("--serve")
            .current_dir(&repo)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut input = process.stdin.take().unwrap();
        writeln!(
            input,
            "{}",
            json!({"operation":"runtime-fixture","root":root})
        )
        .unwrap();
        drop(input);
        let mut output = BufReader::new(process.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["ok"], true, "{value}");
        let runtime = PathBuf::from(value["value"]["runtimeRoot"].as_str().unwrap());
        // Keep the stdout reader alive by draining no further messages; the fixture
        // has completed all writes before its one-line response.
        Self {
            root,
            runtime,
            value: value["value"].clone(),
            process,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct NoRpc;
impl MutationAuthorityTransportV1 for NoRpc {
    fn invoke(&mut self, _: &Value) -> Result<Value> {
        panic!("publication preparation must not invoke authority RPC")
    }
}

struct ExitAfterPublication;
impl SchemaFinalReceiptCheckpointV1 for ExitAfterPublication {
    fn checkpoint(&mut self, point: &str) -> Result<()> {
        if point == "after_final_receipt_publication" {
            // This is an actual process exit, rather than a returned error. The
            // parent process then re-opens FINAL.json and exercises idempotent
            // recovery after the publication exchange and directory fsync.
            std::process::exit(91)
        }
        Ok(())
    }
}

fn prepare_from_fixture(
    fixture: &Fixture,
) -> (
    hepta_paper_service::state_database_inventory::ObservedStateDatabaseInventoryV1,
    PinnedMutationAuthorityV1<NoRpc>,
    PreparedSchemaTransitionAuditV1,
    Value,
    Value,
    Value,
) {
    let manifest = fixture.value["stateDatabaseManifest"].clone();
    let writer = fixture.value["writerManifest"].clone();
    let configuration = Path::new(fixture.value["configurationPath"].as_str().unwrap());
    let configuration_hash = fixture.value["configurationFileHash"].as_str().unwrap();
    let authority =
        PinnedMutationAuthorityV1::load(configuration, configuration_hash, NoRpc).unwrap();
    let inventory = observe_state_database_inventory_v1(&fixture.runtime, &manifest).unwrap();
    let receipt_path = fixture
        .runtime
        .join("autonomous-research/online-schema-transition/FINAL.json");
    let audit: Value = serde_json::from_slice(&fs::read(receipt_path).unwrap()).unwrap();
    let reserve_request = audit["reserveRequest"].clone();
    let mut plan = reserve_request.clone();
    let planned_at = plan["requestedAt"].clone();
    plan.as_object_mut().unwrap().remove("requestedAt");
    plan["kind"] = json!("AutonomousResearchOnlineSchemaTransitionPlan");
    plan["plannedAt"] = planned_at;
    let mut plan_base = plan.clone();
    plan_base.as_object_mut().unwrap().remove("transitionId");
    let plan_hash =
        production_hash_record_v1("AutonomousResearchOnlineSchemaTransitionPlan", &plan_base)
            .unwrap()
            .as_str()
            .to_owned();
    plan["planHash"] = json!(plan_hash);
    plan["transitionId"] = json!(schema_transition_identity_v1(&plan).unwrap());
    let proof = prepare_schema_transition_audit_v1(
        SchemaTransitionAuditInputV1 {
            plan: &plan,
            expected_plan_hash: audit["planHash"].as_str().unwrap(),
            state_database_manifest: &manifest,
            writer_manifest: &writer,
            reserve_request: &audit["reserveRequest"],
            reservation: &audit["reservation"],
            finalize_request: &audit["finalizeRequest"],
            finalization: &audit["finalization"],
            observe_request: &audit["observeRequest"],
            observation: &audit["observation"],
            installations: &audit["installations"],
        },
        &inventory,
        &authority,
    )
    .unwrap();
    (inventory, authority, proof, manifest, writer, audit)
}

#[test]
fn prepares_real_signed_ten_database_final_receipt_and_rejects_splice() {
    let fixture = Fixture::new();
    let manifest = fixture.value["stateDatabaseManifest"].clone();
    let writer = fixture.value["writerManifest"].clone();
    let configuration = Path::new(fixture.value["configurationPath"].as_str().unwrap());
    let configuration_hash = fixture.value["configurationFileHash"].as_str().unwrap();
    let authority =
        PinnedMutationAuthorityV1::load(configuration, configuration_hash, NoRpc).unwrap();
    let inventory = observe_state_database_inventory_v1(&fixture.runtime, &manifest).unwrap();
    assert_eq!(inventory.value()["instances"].as_array().unwrap().len(), 10);
    let receipt_path = fixture
        .runtime
        .join("autonomous-research/online-schema-transition/FINAL.json");
    let audit: Value = serde_json::from_slice(&fs::read(receipt_path).unwrap()).unwrap();
    let reserve_request = audit["reserveRequest"].clone();
    let mut plan = reserve_request.clone();
    let planned_at = plan["requestedAt"].clone();
    plan.as_object_mut().unwrap().remove("requestedAt");
    plan["kind"] = json!("AutonomousResearchOnlineSchemaTransitionPlan");
    plan["plannedAt"] = planned_at;
    let mut plan_base = plan.clone();
    plan_base.as_object_mut().unwrap().remove("transitionId");
    let plan_hash =
        production_hash_record_v1("AutonomousResearchOnlineSchemaTransitionPlan", &plan_base)
            .unwrap()
            .as_str()
            .to_owned();
    plan["planHash"] = json!(plan_hash);
    plan["transitionId"] = json!(schema_transition_identity_v1(&plan).unwrap());
    assert_eq!(plan["planHash"], audit["planHash"]);
    assert_eq!(plan["transitionId"], audit["transitionId"]);
    let proof = prepare_schema_transition_audit_v1(
        SchemaTransitionAuditInputV1 {
            plan: &plan,
            expected_plan_hash: audit["planHash"].as_str().unwrap(),
            state_database_manifest: &manifest,
            writer_manifest: &writer,
            reserve_request: &audit["reserveRequest"],
            reservation: &audit["reservation"],
            finalize_request: &audit["finalizeRequest"],
            finalization: &audit["finalization"],
            observe_request: &audit["observeRequest"],
            observation: &audit["observation"],
            installations: &audit["installations"],
        },
        &inventory,
        &authority,
    )
    .unwrap();
    assert_eq!(
        proof.value()["schemaTransitionReceiptHash"],
        audit["schemaTransitionReceiptHash"]
    );
    assert!(proof.value()["authorityConfigurationActivated"].is_null());
    let mut tampered = audit["observeRequest"].clone();
    tampered["nonce"] = json!("splice");
    assert!(
        prepare_schema_transition_audit_v1(
            SchemaTransitionAuditInputV1 {
                plan: &plan,
                expected_plan_hash: audit["planHash"].as_str().unwrap(),
                state_database_manifest: &manifest,
                writer_manifest: &writer,
                reserve_request: &audit["reserveRequest"],
                reservation: &audit["reservation"],
                finalize_request: &audit["finalizeRequest"],
                finalization: &audit["finalization"],
                observe_request: &tampered,
                observation: &audit["observation"],
                installations: &audit["installations"],
            },
            &inventory,
            &authority,
        )
        .is_err()
    );
    assert_eq!(
        schema_transition_receipt_hash_v1(&audit["finalization"]).unwrap(),
        audit["observeRequest"]["finalizationReceiptHash"]
    );

    // Every historical signature is pinned independently. Replacing any one
    // record cannot be repaired by the audit hash or by the other two receipts.
    for key in ["reservation", "finalization", "observation"] {
        let mut tampered = audit.clone();
        tampered[key]["signature"] = json!("invalid-signature");
        let result = prepare_schema_transition_audit_v1(
            SchemaTransitionAuditInputV1 {
                plan: &plan,
                expected_plan_hash: audit["planHash"].as_str().unwrap(),
                state_database_manifest: &manifest,
                writer_manifest: &writer,
                reserve_request: &tampered["reserveRequest"],
                reservation: &tampered["reservation"],
                finalize_request: &tampered["finalizeRequest"],
                finalization: &tampered["finalization"],
                observe_request: &tampered["observeRequest"],
                observation: &tampered["observation"],
                installations: &tampered["installations"],
            },
            &inventory,
            &authority,
        );
        assert!(result.is_err(), "tampered historical signature: {key}");
    }
    let wrong_plan_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    assert!(
        prepare_schema_transition_audit_v1(
            SchemaTransitionAuditInputV1 {
                plan: &plan,
                expected_plan_hash: wrong_plan_hash,
                state_database_manifest: &manifest,
                writer_manifest: &writer,
                reserve_request: &audit["reserveRequest"],
                reservation: &audit["reservation"],
                finalize_request: &audit["finalizeRequest"],
                finalization: &audit["finalization"],
                observe_request: &audit["observeRequest"],
                observation: &audit["observation"],
                installations: &audit["installations"],
            },
            &inventory,
            &authority,
        )
        .is_err()
    );
    let mut v2_plan = plan.clone();
    v2_plan["version"] = json!(2);
    let v2_result = prepare_schema_transition_audit_v1(
        SchemaTransitionAuditInputV1 {
            plan: &v2_plan,
            expected_plan_hash: audit["planHash"].as_str().unwrap(),
            state_database_manifest: &manifest,
            writer_manifest: &writer,
            reserve_request: &audit["reserveRequest"],
            reservation: &audit["reservation"],
            finalize_request: &audit["finalizeRequest"],
            finalization: &audit["finalization"],
            observe_request: &audit["observeRequest"],
            observation: &audit["observation"],
            installations: &audit["installations"],
        },
        &inventory,
        &authority,
    );
    // A caller cannot promote a v1 audit by changing only its version. The
    // altered plan no longer recomputes to its retained plan hash, so refusal is
    // exact and precedes any target-configuration or publication observation.
    assert_eq!(
        v2_result.err().map(|error| error.code),
        Some("autonomous_research_online_schema_transition_inventory_invalid".into())
    );
}

#[test]
fn final_receipt_publication_is_node_readable_cas_idempotent_and_crash_recoverable() {
    let fixture = Fixture::new();
    let final_path = fixture
        .runtime
        .join("autonomous-research/online-schema-transition/FINAL.json");
    let node_audit = fs::read(&final_path).unwrap();
    let (inventory, authority, proof, manifest, writer, audit) = prepare_from_fixture(&fixture);
    fs::remove_file(&final_path).unwrap();

    // Persist only the independent inputs needed by the crash child. It has no
    // access to the parent's Rust objects or Node process.
    fs::write(
        fixture.root.join("publication-manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    fs::write(
        fixture.root.join("publication-writer.json"),
        serde_json::to_vec(&writer).unwrap(),
    )
    .unwrap();
    fs::write(
        fixture.root.join("publication-audit.json"),
        serde_json::to_vec(&audit).unwrap(),
    )
    .unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "publication_crash_child", "--nocapture"])
        .env("HEPTA_FINAL_PUBLICATION_ROOT", &fixture.root)
        .env("HEPTA_FINAL_PUBLICATION_RUNTIME", &fixture.runtime)
        .env(
            "HEPTA_FINAL_PUBLICATION_CONFIGURATION",
            fixture.value["configurationPath"].as_str().unwrap(),
        )
        .env(
            "HEPTA_FINAL_PUBLICATION_CONFIGURATION_HASH",
            fixture.value["configurationFileHash"].as_str().unwrap(),
        )
        .output()
        .unwrap();
    assert_eq!(child.status.code(), Some(91), "child={child:?}");

    // A process death after publication leaves a complete, independently
    // readable FINAL.json. Re-running the exact prepared proof is idempotent.
    let mut no_checkpoint = NoSchemaFinalReceiptCheckpointV1;
    let recovered = publish_schema_transition_final_receipt_v1(
        &proof,
        &inventory,
        &authority,
        None,
        &mut no_checkpoint,
    )
    .unwrap();
    assert!(recovered.already_published);
    assert!(!recovered.replaced_existing_receipt);
    assert_eq!(
        fs::read(&final_path).unwrap(),
        proof.value().to_string().as_bytes()
    );
    assert_ne!(node_audit, fs::read(&final_path).unwrap());

    // The Node pinned reader and the Node historical verifier accept the same
    // durable bytes. It independently rebuilds the ten-database inventory and
    // verifies all three signatures before exposing the exact receipt hash.
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let node_reader = fixture.root.join("node-final-reader.mjs");
    fs::write(
        &node_reader,
        r#"import fs from 'node:fs';
const root = process.cwd();
const { readAutonomousResearchOnlineSchemaTransitionJson: read } = await import(`file://${root}/paper-adapters/automation/autonomous-research-online-schema-transition-state-repository.mjs`);
const { resolveAutonomousResearchStateDatabaseInventory } = await import(`file://${root}/paper-adapters/automation/autonomous-research-state-database-inventory.mjs`);
const { validateAutonomousResearchOnlineSchemaTransitionAuditReceipt } = await import(`file://${root}/paper-adapters/automation/autonomous-research-online-schema-transition-completion.mjs`);
const { createAutonomousResearchOnlineMutationReceiptVerifier } = await import(`file://${root}/paper-adapters/automation/autonomous-research-online-mutation-authority.mjs`);
const { verifyAutonomousResearchOnlineSchemaTransitionReservation, verifyAutonomousResearchOnlineSchemaTransitionFinalization, verifyAutonomousResearchOnlineSchemaTransitionObservation } = await import(`file://${root}/paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs`);
const receipt = read(process.env.HEPTA_FINAL_PUBLICATION_FILE);
const manifest = JSON.parse(fs.readFileSync(process.env.HEPTA_FINAL_PUBLICATION_MANIFEST, 'utf8'));
const writerManifest = JSON.parse(fs.readFileSync(process.env.HEPTA_FINAL_PUBLICATION_WRITER, 'utf8'));
const inventory = resolveAutonomousResearchStateDatabaseInventory({ runtimeRoot: process.env.HEPTA_FINAL_PUBLICATION_RUNTIME, manifest });
const verifier = createAutonomousResearchOnlineMutationReceiptVerifier({ configurationPath: process.env.HEPTA_FINAL_PUBLICATION_CONFIGURATION });
const verify = (fn, args) => fn({ ...args, trust: verifier.trust, now: new Date(args.receipt.issuedAt || args.receipt.finalizedAt || args.receipt.observedAt), verifySignature: verifier.verifySignedReceipt });
const authorityClient = { verifyHistoricalReservation: args => verify(verifyAutonomousResearchOnlineSchemaTransitionReservation, args), verifyHistoricalFinalization: args => verify(verifyAutonomousResearchOnlineSchemaTransitionFinalization, args), verifyHistoricalObservation: args => verify(verifyAutonomousResearchOnlineSchemaTransitionObservation, args) };
const checked = validateAutonomousResearchOnlineSchemaTransitionAuditReceipt({ receipt, inventory, writerManifest, authorityClient });
process.stdout.write(checked.schemaTransitionReceiptHash);
"#,
    )
    .unwrap();
    let output = std::process::Command::new("node")
        .current_dir(&repo)
        .arg(&node_reader)
        .env("HEPTA_FINAL_PUBLICATION_FILE", &final_path)
        .env(
            "HEPTA_FINAL_PUBLICATION_MANIFEST",
            fixture.root.join("publication-manifest.json"),
        )
        .env(
            "HEPTA_FINAL_PUBLICATION_WRITER",
            fixture.root.join("publication-writer.json"),
        )
        .env("HEPTA_FINAL_PUBLICATION_RUNTIME", &fixture.runtime)
        .env(
            "HEPTA_FINAL_PUBLICATION_CONFIGURATION",
            fixture.value["configurationPath"].as_str().unwrap(),
        )
        .output()
        .unwrap();
    assert!(output.status.success(), "node={output:?}");
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        proof.value()["schemaTransitionReceiptHash"]
    );
}

#[test]
fn publication_crash_child() {
    let Ok(root) = std::env::var("HEPTA_FINAL_PUBLICATION_ROOT") else {
        return;
    };
    let runtime = PathBuf::from(std::env::var("HEPTA_FINAL_PUBLICATION_RUNTIME").unwrap());
    let configuration =
        PathBuf::from(std::env::var("HEPTA_FINAL_PUBLICATION_CONFIGURATION").unwrap());
    let configuration_hash = std::env::var("HEPTA_FINAL_PUBLICATION_CONFIGURATION_HASH").unwrap();
    let manifest: Value = serde_json::from_slice(
        &fs::read(Path::new(&root).join("publication-manifest.json")).unwrap(),
    )
    .unwrap();
    let writer: Value = serde_json::from_slice(
        &fs::read(Path::new(&root).join("publication-writer.json")).unwrap(),
    )
    .unwrap();
    let audit: Value =
        serde_json::from_slice(&fs::read(Path::new(&root).join("publication-audit.json")).unwrap())
            .unwrap();
    let authority =
        PinnedMutationAuthorityV1::load(&configuration, &configuration_hash, NoRpc).unwrap();
    let inventory = observe_state_database_inventory_v1(&runtime, &manifest).unwrap();
    let reserve_request = audit["reserveRequest"].clone();
    let mut plan = reserve_request.clone();
    let planned_at = plan["requestedAt"].clone();
    plan.as_object_mut().unwrap().remove("requestedAt");
    plan["kind"] = json!("AutonomousResearchOnlineSchemaTransitionPlan");
    plan["plannedAt"] = planned_at;
    let mut plan_base = plan.clone();
    plan_base.as_object_mut().unwrap().remove("transitionId");
    let plan_hash =
        production_hash_record_v1("AutonomousResearchOnlineSchemaTransitionPlan", &plan_base)
            .unwrap()
            .as_str()
            .to_owned();
    plan["planHash"] = json!(plan_hash);
    plan["transitionId"] = json!(schema_transition_identity_v1(&plan).unwrap());
    let proof = prepare_schema_transition_audit_v1(
        SchemaTransitionAuditInputV1 {
            plan: &plan,
            expected_plan_hash: audit["planHash"].as_str().unwrap(),
            state_database_manifest: &manifest,
            writer_manifest: &writer,
            reserve_request: &audit["reserveRequest"],
            reservation: &audit["reservation"],
            finalize_request: &audit["finalizeRequest"],
            finalization: &audit["finalization"],
            observe_request: &audit["observeRequest"],
            observation: &audit["observation"],
            installations: &audit["installations"],
        },
        &inventory,
        &authority,
    )
    .unwrap();
    let mut checkpoint = ExitAfterPublication;
    let _ = publish_schema_transition_final_receipt_v1(
        &proof,
        &inventory,
        &authority,
        None,
        &mut checkpoint,
    );
    panic!("crash checkpoint was not reached");
}

fn predecessor_process_configuration(fixture: &Fixture) -> (PathBuf, String) {
    let command = fixture.root.join("predecessor-no-rpc");
    fs::copy("/usr/bin/false", &command).unwrap();
    fs::set_permissions(&command, fs::Permissions::from_mode(0o700)).unwrap();
    let path = fixture.root.join("predecessor-process.json");
    let value = json!({
        "version": 1,
        "kind": "AutonomousResearchOnlineMutationAuthorityProcessConfiguration",
        "authorityConfigurationPath": fixture.value["configurationPath"],
        "authorityConfigurationSha256": fixture.value["configurationFileHash"],
        "commandPath": command,
        "commandSha256": file_digest(&fs::read(&command).unwrap()),
        "fixedArguments": [],
        "timeoutMs": 1000
    });
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(&path, &bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    (path, file_digest(&bytes))
}
fn runtime_snapshot(root: &Path) -> Vec<(PathBuf, String)> {
    fn visit(root: &Path, path: &Path, rows: &mut Vec<(PathBuf, String)>) {
        let mut children = fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        children.sort();

        for child in children {
            let metadata = fs::symlink_metadata(&child).unwrap();
            if metadata.is_dir() {
                visit(root, &child, rows);
            } else if metadata.is_file() {
                rows.push((
                    child.strip_prefix(root).unwrap().to_owned(),
                    file_digest(&fs::read(&child).unwrap()),
                ));
            } else {
                panic!("unexpected runtime entry: {}", child.display());
            }
        }
    }
    let mut rows = Vec::new();
    visit(root, root, &mut rows);
    rows
}
fn predecessor_command(
    fixture: &Fixture,
    process: &Path,
    process_hash: &str,
    final_pin: Option<&str>,
) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"));
    command.args([
        "autonomous-online-schema-transition",
        "--action",
        "plan",
        "--runtime-root",
        fixture.runtime.to_str().unwrap(),
        "--authority-process-config",
        process.to_str().unwrap(),
        "--authority-process-config-sha256",
        process_hash,
    ]);
    if let Some(pin) = final_pin {
        command.args(["--expected-previous-final-receipt-sha256", pin]);
    }
    command
}

#[test]
fn ordinary_plan_accepts_only_an_exact_signed_finalized_predecessor() {
    let fixture = Fixture::new();
    let final_path = fixture
        .runtime
        .join("autonomous-research/online-schema-transition/FINAL.json");
    let final_bytes = fs::read(&final_path).unwrap();
    let final_pin = file_digest(&final_bytes);
    let audit: Value = serde_json::from_slice(&final_bytes).unwrap();
    let plan = plan_from_audit(&audit);

    let control = final_path.parent().unwrap();
    let active_path = control.join("ACTIVE.json");
    let active = json!({
        "version": 1,
        "kind": "AutonomousResearchOnlineSchemaTransitionState",
        "phase": "finalized",
        "plan": plan,
        "reserveRequest": audit["reserveRequest"],
        "reservation": audit["reservation"],
        "installations": audit["installations"],
        "finalReceiptHash": audit["schemaTransitionReceiptHash"]
    });
    fs::write(&active_path, serde_json::to_vec(&active).unwrap()).unwrap();
    fs::set_permissions(&active_path, fs::Permissions::from_mode(0o600)).unwrap();
    let names = fs::read_dir(control)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(names, ["ACTIVE.json".into(), "FINAL.json".into()].into());
    let (process, process_hash) = predecessor_process_configuration(&fixture);
    let before = runtime_snapshot(&fixture.runtime);

    let unpinned = predecessor_command(&fixture, &process, &process_hash, None)
        .output()
        .unwrap();
    assert_eq!(unpinned.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&unpinned.stderr).contains("existing_control_requires_recovery")
    );
    assert_eq!(runtime_snapshot(&fixture.runtime), before);

    let wrong = format!("sha256:{}", "0".repeat(64));
    let rejected = predecessor_command(&fixture, &process, &process_hash, Some(&wrong))
        .output()
        .unwrap();
    assert_eq!(rejected.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("previous_final_receipt_invalid"));
    assert_eq!(runtime_snapshot(&fixture.runtime), before);

    let accepted = predecessor_command(&fixture, &process, &process_hash, Some(&final_pin))
        .output()
        .unwrap();
    assert_eq!(
        accepted.status.code(),
        Some(0),
        "{} {}",
        String::from_utf8_lossy(&accepted.stdout),
        String::from_utf8_lossy(&accepted.stderr)
    );
    let report: Value = serde_json::from_slice(&accepted.stdout).unwrap();
    assert_eq!(report["controlPredecessorVerified"], true);
    assert_eq!(report["previousFinalReceiptFileSha256"], final_pin);
    assert_eq!(
        report["readinessScope"],
        "finalized_predecessor_native_source_plan_only"
    );
    assert_eq!(
        report["plan"]["databaseScopeHash"],
        audit["databaseScopeHash"]
    );
    assert_eq!(runtime_snapshot(&fixture.runtime), before);

    let original_active = fs::read(&active_path).unwrap();
    let mut changed: Value = serde_json::from_slice(&original_active).unwrap();
    changed["phase"] = json!("pending");
    fs::write(&active_path, serde_json::to_vec(&changed).unwrap()).unwrap();
    let substituted = predecessor_command(&fixture, &process, &process_hash, Some(&final_pin))
        .output()
        .unwrap();
    assert_eq!(substituted.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&substituted.stderr).contains("previous_finalized_control_invalid")
    );
    fs::write(&active_path, original_active).unwrap();
    assert_eq!(runtime_snapshot(&fixture.runtime), before);
}

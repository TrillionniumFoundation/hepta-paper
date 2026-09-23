use super::*;
use crate::{
    online_mutation_composition::BuiltinOnlineMutationPlansV1,
    online_runtime_activation::{
        active_refresh::refresh_online_authority_evidence_v1,
        finalized_inventory::inspect_online_finalized_inventory_v1,
    },
    online_schema_transition::history::checkpoint::load_schema_transition_checkpoint_v1,
    online_writer_static::verify_online_writer_static_coverage_v1,
    sqlite_mutation_coordinator::{
        authority::ProcessMutationAuthorityTransportV1, clock::SystemMutationClockV1,
    },
    state_database_inventory::observe_state_database_inventory_v1,
};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    value: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-online-initial-composition-history-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let value = oracle(&json!({"mode":"fixture","root":root}));
        assert_eq!(
            Path::new(value["checkpointRoot"].as_str().unwrap()),
            root.join("checkpoint")
        );
        Self { root, value }
    }
    fn path(&self, key: &str) -> PathBuf {
        self.value[key].as_str().unwrap().into()
    }
    fn calls(&self) -> Vec<u8> {
        fs::read(self.root.join("calls.jsonl")).unwrap_or_default()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn oracle(input: &Value) -> Value {
    let mut child = Command::new("node")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../oracle/online-initial-composition-v1.mjs"),
        )
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
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&result["profile"]).unwrap();
    assert_eq!(result["ok"], true, "{result}");
    result["value"].clone()
}
type Online = PinnedMutationAuthorityV1<ProcessMutationAuthorityTransportV1>;
struct Producers {
    checkpoint: VerifiedSchemaTransitionCheckpointV1,
    current: ObservedStateDatabaseInventoryV1,
    source: VerifiedWriterStaticCoverageV1,
    active: VerifiedActiveAuthorityEvidenceV1,
    finalized: VerifiedFinalizedInventoryV1,
}
impl Producers {
    fn new(f: &Fixture, authority: &mut Online) -> Self {
        let builtin = BuiltinOnlineMutationPlansV1::load().unwrap();
        let current =
            observe_state_database_inventory_v1(&f.path("runtime"), &f.value["manifest"]).unwrap();
        let checkpoint = load_schema_transition_checkpoint_v1(
            &f.root.join("checkpoint"),
            &current,
            builtin.writer_manifest(),
            authority,
        )
        .unwrap();
        let source = verify_online_writer_static_coverage_v1(
            &f.path("workspace"),
            builtin.writer_manifest(),
        )
        .unwrap();
        let mut clock = SystemMutationClockV1;
        let active = refresh_online_authority_evidence_v1(
            current.value(),
            builtin.writer_manifest(),
            authority,
            &source,
            &mut clock,
            3,
        )
        .unwrap();
        let finalized = inspect_online_finalized_inventory_v1(
            &current,
            builtin.writer_manifest(),
            authority,
            &source,
            &active,
            &mut clock,
        )
        .unwrap();
        Self {
            checkpoint,
            current,
            source,
            active,
            finalized,
        }
    }
    fn input(&self) -> SchemaHistoryInputsV1<'_> {
        SchemaHistoryInputsV1 {
            checkpoint: &self.checkpoint,
            current: &self.current,
            source: &self.source,
            active: &self.active,
            finalized: &self.finalized,
        }
    }
}
fn authority(f: &Fixture) -> Online {
    Online::load_process(
        &f.path("onlineProcess"),
        f.value["onlineProcessHash"].as_str().unwrap(),
    )
    .unwrap()
}
#[test]
fn genuine_empty_history_proves_all_tables_and_refuses_unrecorded_rowid_changes() {
    let f = Fixture::new();
    let mut authority = authority(&f);
    let producers = Producers::new(&f, &mut authority);
    let proof = verify_schema_transition_history_v1(
        &producers.input(),
        &mut authority,
        &mut SystemMutationClockV1,
    )
    .unwrap();
    assert!(
        proof.chain.value()["entries"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        proof.value()["replay"]["databases"]
            .as_array()
            .unwrap()
            .len(),
        10
    );
    assert_eq!(proof.value()["runtimeReady"], false);
    assert_eq!(
        proof.request["postInventoryHash"],
        f.value["audit"]["finalization"]["postInventoryHash"]
    );
    let calls = f.calls();
    proof
        .assert_current(&producers.input(), &authority, &mut SystemMutationClockV1)
        .unwrap();
    assert_eq!(calls, f.calls());
    // The signed local head remains genesis. Only the complete effective-state
    // comparison can detect this otherwise invisible unjournaled rowid change.
    let db = rusqlite::Connection::open(f.path("runtime").join("hepta-paper.sqlite")).unwrap();
    db.execute("UPDATE fixture_anchor SET rowid=rowid+100", [])
        .unwrap();
    drop(db);
    assert!(
        proof
            .assert_current(&producers.input(), &authority, &mut SystemMutationClockV1)
            .is_err()
    );
    let current = Producers::new(&f, &mut authority);
    let before = f.calls();
    let error = verify_schema_transition_history_v1(
        &current.input(),
        &mut authority,
        &mut SystemMutationClockV1,
    )
    .err()
    .unwrap();
    assert_eq!(
        error.code,
        "autonomous_research_schema_checkpoint_effective_state_mismatch"
    );
    assert_eq!(
        f.calls(),
        before,
        "mismatching replay cannot request a current schema observation"
    );
}

#[test]
fn genuine_registered_heartbeat_replays_from_original_schema_checkpoint() {
    let f = Fixture::new();
    // Authentic Node JSON numeric spellings retain the same signed Number
    // meaning; the chain's normalized zero must bind raw FINAL 0.0 as well.
    let audit_path = f
        .path("runtime")
        .join("autonomous-research/online-schema-transition/FINAL.json");
    let original = fs::read_to_string(&audit_path).unwrap();
    let decimal = original
        .replace("\"globalSequence\":0", "\"globalSequence\":0.0")
        .replace("\"globalSequence\": 0", "\"globalSequence\": 0.0");
    assert!(original != decimal, "fixture number spelling must change");
    fs::write(audit_path, decimal).unwrap();
    let heartbeat = oracle(&json!({"mode":"heartbeat","root":f.root}));
    assert_eq!(
        heartbeat["journal"]["entries"][0]["reservationReceipt"]["globalSequence"],
        1
    );
    let mut authority = authority(&f);
    let producers = Producers::new(&f, &mut authority);
    assert_ne!(
        producers.current.value()["inventoryHash"],
        producers.checkpoint.historical_inventory()["inventoryHash"]
    );
    let proof = verify_schema_transition_history_v1(
        &producers.input(),
        &mut authority,
        &mut SystemMutationClockV1,
    )
    .unwrap();
    assert_eq!(proof.chain.value()["entries"].as_array().unwrap().len(), 1);
    assert_eq!(proof.value()["globalSequence"], 1);
    assert_eq!(
        proof.value()["replay"]["databases"]
            .as_array()
            .unwrap()
            .len(),
        10
    );
    assert_eq!(
        proof.request["postInventoryHash"],
        f.value["audit"]["finalization"]["postInventoryHash"]
    );
    assert_ne!(
        proof.request["postInventoryHash"],
        producers.current.value()["inventoryHash"]
    );
    assert_eq!(proof.value()["runtimeReady"], false);
    assert_eq!(proof.value()["productionActivation"], false);
}

use super::*;
use crate::{
    online_finalized_head_inspection::inspect_online_finalized_database_head_v1,
    online_schema_transition::history::checkpoint::load_schema_transition_checkpoint_v1,
    sqlite_mutation_coordinator::{
        authority::ProcessMutationAuthorityTransportV1, clock::SystemMutationClockV1,
    },
    state_database_inventory::{
        ObservedStateDatabaseInventoryV1, observe_state_database_inventory_v1,
    },
};
use rusqlite::Connection;
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
// Preserve the actual broker's valid JSON numeric spellings. The production
// process adapter intentionally normalizes integral tokens; the generic pinned
// transport contract also admits Values from ordinary JSON decoders.
struct RawBroker(PathBuf);
impl MutationAuthorityTransportV1 for RawBroker {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        let mut child = Command::new(&self.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(request.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(serde_json::from_slice(&output.stdout).unwrap())
    }
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-online-initial-composition-chain-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let mut f = Self {
            root,
            value: Value::Null,
        };
        f.value = f.oracle("fixture");
        f
    }
    fn oracle(&self, mode: &str) -> Value {
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
            .write_all(json!({"mode":mode,"root":self.root}).to_string().as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let response: Value = serde_json::from_slice(&out.stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&response["profile"])
            .unwrap();
        assert_eq!(response["ok"], true, "{response}");
        response["value"].clone()
    }
    fn authority(&self) -> PinnedMutationAuthorityV1<ProcessMutationAuthorityTransportV1> {
        PinnedMutationAuthorityV1::load_process(
            Path::new(self.value["onlineProcess"].as_str().unwrap()),
            self.value["onlineProcessHash"].as_str().unwrap(),
        )
        .unwrap()
    }
    fn inventory(&self) -> ObservedStateDatabaseInventoryV1 {
        observe_state_database_inventory_v1(
            Path::new(self.value["runtime"].as_str().unwrap()),
            &self.value["manifest"],
        )
        .unwrap()
    }
    fn checkpoint(
        &self,
        inventory: &ObservedStateDatabaseInventoryV1,
    ) -> VerifiedSchemaTransitionCheckpointV1 {
        load_schema_transition_checkpoint_v1(
            Path::new(self.value["checkpointRoot"].as_str().unwrap()),
            inventory,
            &self.value["writerManifest"],
            &self.authority(),
        )
        .unwrap()
    }
    fn inspections(
        &self,
        inventory: &ObservedStateDatabaseInventoryV1,
    ) -> Vec<VerifiedFinalizedHeadInspectionV1> {
        if self.value["alternateIntegralHeadSpellings"] == true {
            let configuration = Path::new(self.value["onlineConfiguration"].as_str().unwrap());
            let mut authority = PinnedMutationAuthorityV1::load(
                configuration,
                &super::super::hash_bytes(&fs::read(configuration).unwrap()),
                RawBroker(self.root.join("authority.mjs")),
            )
            .unwrap();
            return self.inspections_with_authority(inventory, &mut authority);
        }
        self.inspections_with_authority(inventory, &mut self.authority())
    }
    fn inspections_with_authority<T: MutationAuthorityTransportV1>(
        &self,
        inventory: &ObservedStateDatabaseInventoryV1,
        authority: &mut PinnedMutationAuthorityV1<T>,
    ) -> Vec<VerifiedFinalizedHeadInspectionV1> {
        inventory.value()["instances"]
            .as_array()
            .unwrap()
            .iter()
            .map(|instance| {
                let id = instance["instanceId"].as_str().unwrap();
                inventory
                    .with_database_snapshot(id, |path| {
                        let mut db = Connection::open(path)?;
                        inspect_online_finalized_database_head_v1(
                            &mut db,
                            id,
                            inventory.value(),
                            authority,
                            &self.value["writerManifest"],
                            &mut SystemMutationClockV1,
                        )
                    })
                    .unwrap()
            })
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn signed_schema_checkpoint_accepts_genuine_empty_chain_and_exact_two_heartbeat_history() {
    let mut f = Fixture::new();
    let inventory = f.inventory();
    let checkpoint = f.checkpoint(&inventory);
    let authority = f.authority();
    f.value["alternateIntegralHeadSpellings"] = json!(true);
    fs::write(
        f.root.join("fixture.json"),
        serde_json::to_vec(&f.value).unwrap(),
    )
    .unwrap();
    let mut inspections = f.inspections(&inventory);
    assert!(
        inspections
            .iter()
            .any(|p| p.current_head()["globalSequence"].is_f64())
    );
    assert!(
        inspections
            .iter()
            .any(|p| p.current_head()["globalSequence"].is_i64())
    );
    let empty =
        authenticate_schema_checkpoint_chain_v1(&checkpoint, &inspections, &authority).unwrap();
    assert_eq!(empty.value()["entries"], json!([]));
    assert_eq!(empty.value()["fromGlobalSequence"], 0);
    assert_eq!(number(&empty.value()["toGlobalSequence"]), Some(0));
    assert_eq!(
        empty.value()["fromGlobalHash"],
        f.value["audit"]["finalization"]["globalHash"]
    );
    assert_eq!(empty.value()["databaseHeads"].as_array().unwrap().len(), 10);
    inspections.reverse();
    let reordered =
        authenticate_schema_checkpoint_chain_v1(&checkpoint, &inspections, &authority).unwrap();
    assert_eq!(
        hepta_legacy_compatibility::production_stable_json_v1(reordered.value()).unwrap(),
        hepta_legacy_compatibility::production_stable_json_v1(empty.value()).unwrap()
    );
    assert!(
        authenticate_schema_checkpoint_chain_v1(&checkpoint, &inspections[..9], &authority)
            .is_err()
    );
    drop(inventory);
    f.value["alternateIntegralHeadSpellings"] = json!(false);
    fs::write(
        f.root.join("fixture.json"),
        serde_json::to_vec(&f.value).unwrap(),
    )
    .unwrap();
    f.oracle("heartbeat");
    let result = f.oracle("heartbeat");
    let current = f.inventory();
    checkpoint.assert_current(&current, &authority).unwrap();
    let inspections = f.inspections(&current);
    let history =
        authenticate_schema_checkpoint_chain_v1(&checkpoint, &inspections, &authority).unwrap();
    assert_eq!(history.value()["entries"], result["journal"]["entries"]);
    assert_eq!(
        history.value()["databaseHeads"],
        result["journal"]["databaseHeads"]
    );
    assert_eq!(history.value()["toGlobalSequence"], 2);
    assert_eq!(
        history.value()["toGlobalHash"],
        result["journal"]["globalHash"]
    );
    assert_eq!(
        history.authority_configuration_hash(),
        authority.configuration_hash()
    );
    let rows = current.value()["instances"].as_array().unwrap();
    for instance in rows {
        current
            .with_database_snapshot(instance["instanceId"].as_str().unwrap(), |path| {
                let db = Connection::open(path)?;
                let count: i64 = db.query_row(
                    "SELECT count(*) FROM autonomous_research_online_mutation_authority_marker",
                    [],
                    |r| r.get(0),
                )?;
                assert_eq!(
                    count,
                    if instance["role"] == "resident-instance" {
                        2
                    } else {
                        0
                    }
                );
                Ok(())
            })
            .unwrap();
    }
}
#[test]
fn signed_current_genesis_cannot_replace_original_schema_genesis() {
    let mut f = Fixture::new();
    let initial = f.inventory();
    let checkpoint = f.checkpoint(&initial);
    drop(initial);
    let authority = f.authority();
    let instance = f.value["inventory"]["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["role"] == "resident-instance")
        .unwrap()
        .clone();
    let id = instance["instanceId"].as_str().unwrap();
    let path = Path::new(f.value["runtime"].as_str().unwrap())
        .join(instance["sourceRelativePath"].as_str().unwrap());
    let original = f.value["genesis"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["databaseInstanceId"] == id)
        .unwrap()
        .clone();
    for (field, column) in [
        ("stateHash", "genesis_state_hash"),
        ("databaseHash", "genesis_database_hash"),
    ] {
        let changed = super::super::hash(
            "AuthenticatedGenesisMismatchFixture",
            &json!({"field":field}),
        )
        .unwrap();
        let db = Connection::open(&path).unwrap();
        let trigger:String=db.query_row("SELECT sql FROM sqlite_schema WHERE name='autonomous_research_online_mutation_metadata_no_update'",[],|r|r.get(0)).unwrap();
        db.execute_batch("DROP TRIGGER autonomous_research_online_mutation_metadata_no_update")
            .unwrap();
        db.execute(
            &format!(
                "UPDATE autonomous_research_online_mutation_authority_metadata SET {column}=?"
            ),
            [&changed],
        )
        .unwrap();
        db.execute_batch(&trigger).unwrap();
        drop(db);
        let genesis = f.value["genesis"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|g| g["databaseInstanceId"] == id)
            .unwrap();
        genesis[field] = json!(changed);
        fs::write(
            f.root.join("fixture.json"),
            serde_json::to_vec(&f.value).unwrap(),
        )
        .unwrap();
        let current = f.inventory();
        checkpoint.assert_current(&current, &authority).unwrap();
        // Every database independently accepts a genuine signed, consistent
        // current head. Only the retained original schema anchor rejects it.
        let inspections = f.inspections(&current);
        assert_eq!(
            authenticate_schema_checkpoint_chain_v1(&checkpoint, &inspections, &authority)
                .err()
                .unwrap()
                .code,
            anchored_invalid().code
        );
        drop(current);
        let db = Connection::open(&path).unwrap();
        db.execute_batch("DROP TRIGGER autonomous_research_online_mutation_metadata_no_update")
            .unwrap();
        db.execute(
            &format!(
                "UPDATE autonomous_research_online_mutation_authority_metadata SET {column}=?"
            ),
            [original[field].as_str().unwrap()],
        )
        .unwrap();
        db.execute_batch(&trigger).unwrap();
        drop(db);
        *f.value["genesis"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|g| g["databaseInstanceId"] == id)
            .unwrap() = original.clone();
        fs::write(
            f.root.join("fixture.json"),
            serde_json::to_vec(&f.value).unwrap(),
        )
        .unwrap();
    }
}

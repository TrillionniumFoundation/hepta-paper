use hepta_paper_service::{
    online_schema_execution::{
        maintenance::normalization::finalization::observe_schema_transition_post_state_v1,
        maintenance::{
            normalization::{installation::*, *},
            *,
        },
        plan::*,
    },
    sqlite_mutation_coordinator::{
        Result,
        authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
    },
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};
const BASE: i64 = 1_789_560_000_000;
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Oracle {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Oracle {
    fn new() -> Self {
        let mut child = Command::new("node")
            .arg(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../oracle/schema-installation-v1.mjs"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
        }
    }
    fn call(&mut self, value: Value) -> Value {
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        assert!(self.output.read_line(&mut line).unwrap() > 0);
        let result: Value = serde_json::from_str(&line).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&result["profile"]).unwrap();
        result
    }
}
impl Drop for Oracle {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Fixture {
    root: PathBuf,
    setup: Value,
    oracle: Rc<RefCell<Oracle>>,
}
impl Fixture {
    fn new(wal: bool) -> Self {
        Self::new_version(wal, 1)
    }
    fn new_version(wal: bool, version: i64) -> Self {
        let root = PathBuf::from(format!(
            "/tmp/hepta-schema-source-rust-{}-installation-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let oracle = Rc::new(RefCell::new(Oracle::new()));
        let response = oracle
            .borrow_mut()
            .call(json!({"operation":"full-fixture","root":root,"version":version}));
        assert_eq!(response["ok"], true, "{response}");
        if wal {
            let v = oracle
                .borrow_mut()
                .call(json!({"operation":"make-wal","root":root}));
            assert_eq!(v["ok"], true, "{v}");
        }
        Self {
            root,
            setup: response["value"].clone(),
            oracle,
        }
    }
    fn authority(&self) -> PinnedMutationAuthorityV1<Signing> {
        PinnedMutationAuthorityV1::load(
            Path::new(self.setup["configurationPath"].as_str().unwrap()),
            self.setup["configurationFileHash"].as_str().unwrap(),
            Signing {
                root: self.root.clone(),
                oracle: self.oracle.clone(),
            },
        )
        .unwrap()
    }
    fn options(&self) -> SchemaTransitionPlanOptionsV1<'_> {
        options(&self.setup)
    }
    fn journal(&self) -> PathBuf {
        Path::new(self.setup["runtimeRoot"].as_str().unwrap())
            .join("autonomous-research/online-schema-transition/NORMALIZATION.native.v1.json")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn options(setup: &Value) -> SchemaTransitionPlanOptionsV1<'_> {
    SchemaTransitionPlanOptionsV1 {
        runtime_root: Path::new(setup["runtimeRoot"].as_str().unwrap()),
        state_database_manifest: &setup["stateDatabaseManifest"],
        writer_manifest: &setup["writerManifest"],
        requested_lease_ms: 60000,
        // The Node execute defaults use a 1000ms margin with a 30000ms
        // execution window. Keep this direct primitive fixture's plan valid
        // under the same strict margin < window rule.
        required_execution_window_ms: 2000,
        expected_pre_rebind_pristine_runtime_state_hash:
            setup["expectedPreRebindPristineRuntimeStateHash"].as_str(),
        machine_genesis: None,
    }
}
struct Signing {
    root: PathBuf,
    oracle: Rc<RefCell<Oracle>>,
}
impl MutationAuthorityTransportV1 for Signing {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        let v=self.oracle.borrow_mut().call(json!({"operation":"reserve-maintenance","root":self.root,"request":request,"mode":"valid"}));
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["value"]["accepted"], true);
        fn float_spelling(value: &mut Value) {
            match value {
                Value::Number(n) if n.is_i64() || n.is_u64() => {
                    *n = serde_json::Number::from_f64(n.as_f64().unwrap()).unwrap();
                }
                Value::Object(map) => map.values_mut().for_each(float_spelling),
                Value::Array(rows) => rows.iter_mut().for_each(float_spelling),
                _ => {}
            }
        }
        let mut receipt = v["value"]["receipt"].clone();
        float_spelling(&mut receipt);
        Ok(receipt)
    }
}
struct Reply(Value);
impl MutationAuthorityTransportV1 for Reply {
    fn invoke(&mut self, _: &Value) -> Result<Value> {
        Ok(self.0.clone())
    }
}
fn fail<T>(result: Result<T>) -> String {
    match result {
        Ok(_) => panic!("unexpected acceptance"),
        Err(e) => e.code,
    }
}

fn normalized(
    fixture: &Fixture,
    authority: &mut PinnedMutationAuthorityV1<Signing>,
) -> NormalizedSchemaMaintenanceV1 {
    let plan =
        build_schema_transition_plan_v1(fixture.options(), authority, &mut || Ok(BASE)).unwrap();
    let maintenance = reserve_schema_maintenance_v1(plan, authority, &mut || Ok(BASE)).unwrap();
    normalize_schema_maintenance_v1(
        maintenance,
        authority,
        &mut || Ok(BASE),
        &mut NoSchemaNormalizationCheckpointV1,
    )
    .unwrap()
}
fn resume_installation<'a>(
    fixture: &'a Fixture,
    plan: &'a Value,
) -> ResumeSchemaInstallationOptionsV1<'a> {
    ResumeSchemaInstallationOptionsV1 {
        runtime_root: Path::new(fixture.setup["runtimeRoot"].as_str().unwrap()),
        state_database_manifest: &fixture.setup["stateDatabaseManifest"],
        writer_manifest: &fixture.setup["writerManifest"],
        expected_transition_id: plan["transitionId"].as_str().unwrap(),
        expected_plan_hash: plan["planHash"].as_str().unwrap(),
        installation: SchemaInstallationOptionsV1::default(),
    }
}
fn plan_bytes(fixture: &Fixture, plan: &Value) -> Vec<Vec<u8>> {
    plan["instances"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            fs::read(
                Path::new(fixture.setup["runtimeRoot"].as_str().unwrap())
                    .join(row["sourceRelativePath"].as_str().unwrap()),
            )
            .unwrap()
        })
        .collect()
}
#[test]
fn actual_ten_database_genesis_installation_matches_full_node_records() {
    for version in [1, 2] {
        let fixture = Fixture::new_version(false, version);
        let mut authority = fixture.authority();
        let token = normalized(&fixture, &mut authority);
        let journal: Value = serde_json::from_slice(&fs::read(fixture.journal()).unwrap()).unwrap();
        let expected=fixture.oracle.borrow_mut().call(json!({"operation":"installation-preview","root":fixture.root,"plan":token.plan(),"reservation":journal["reservation"]}));
        assert_eq!(expected["ok"], true, "{expected}");
        let mut installed = install_schema_maintenance_v1(
            token,
            &authority,
            &mut || Ok(BASE),
            SchemaInstallationOptionsV1::default(),
            &mut ProbeAllLocks {
                paths: journal["plan"]["instances"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|row| {
                        Path::new(fixture.setup["runtimeRoot"].as_str().unwrap())
                            .join(row["sourceRelativePath"].as_str().unwrap())
                    })
                    .collect(),
                done: false,
            },
        )
        .unwrap();
        assert_eq!(installed.records(), &expected["value"], "version {version}");
        installed
            .assert_current(&authority, &mut || Ok(BASE))
            .unwrap();
        assert_eq!(
            fail(resume_schema_installation_v1(
                resume_installation(&fixture, &journal["plan"]),
                &authority,
                &mut || Ok(BASE),
                &mut NoSchemaInstallationCheckpointV1
            )),
            "autonomous_research_online_schema_transition_maintenance_busy"
        );
        drop(installed);
        let before: Vec<_> = plan_bytes(&fixture, &journal["plan"]);
        let resumed = resume_schema_installation_v1(
            resume_installation(&fixture, &journal["plan"]),
            &authority,
            &mut || Ok(BASE),
            &mut NoSchemaInstallationCheckpointV1,
        )
        .unwrap();
        assert_eq!(resumed.records(), &expected["value"]);
        if version == 1 {
            let post_state = observe_schema_transition_post_state_v1(
                Path::new(fixture.setup["runtimeRoot"].as_str().unwrap()),
                &fixture.setup["stateDatabaseManifest"],
                &journal["plan"],
                resumed.records(),
                None,
            )
            .unwrap();
            assert_eq!(
                post_state.inventory()["instances"]
                    .as_array()
                    .unwrap()
                    .len(),
                10
            );
            assert_eq!(post_state.inspections().len(), 0);
        }
        drop(resumed);
        assert_eq!(plan_bytes(&fixture, &journal["plan"]), before);
    }
}

struct ExitAt {
    id: String,
}
impl SchemaInstallationCheckpointV1 for ExitAt {
    fn checkpoint(&mut self, point: &str, id: &str) -> Result<()> {
        if point == "after_instance_commit_before_publication" && id == self.id {
            std::process::exit(91);
        }
        Ok(())
    }
}
#[test]
fn installation_crash_child() {
    let Some(path) = std::env::var_os("HEPTA_SCHEMA_INSTALLATION_CHILD") else {
        return;
    };
    let input: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let setup = &input["setup"];
    let authority = PinnedMutationAuthorityV1::load(
        Path::new(setup["configurationPath"].as_str().unwrap()),
        setup["configurationFileHash"].as_str().unwrap(),
        Reply(Value::Null),
    )
    .unwrap();
    let id = input["transitionId"].as_str().unwrap();
    if input["mode"] == "recover" {
        let installed = resume_schema_installation_v1(
            ResumeSchemaInstallationOptionsV1 {
                runtime_root: Path::new(setup["runtimeRoot"].as_str().unwrap()),
                state_database_manifest: &setup["stateDatabaseManifest"],
                writer_manifest: &setup["writerManifest"],
                expected_transition_id: id,
                expected_plan_hash: input["planHash"].as_str().unwrap(),
                installation: SchemaInstallationOptionsV1::default(),
            },
            &authority,
            &mut || Ok(BASE),
            &mut NoSchemaInstallationCheckpointV1,
        )
        .unwrap();
        fs::write(
            input["resultPath"].as_str().unwrap(),
            serde_json::to_vec(installed.records()).unwrap(),
        )
        .unwrap();
        return;
    }
    let normalized = resume_schema_normalization_v1(
        ResumeSchemaNormalizationOptionsV1 {
            runtime_root: Path::new(setup["runtimeRoot"].as_str().unwrap()),
            state_database_manifest: &setup["stateDatabaseManifest"],
            writer_manifest: &setup["writerManifest"],
            expected_transition_id: id,
            machine_genesis: None,
        },
        &authority,
        &mut || Ok(BASE),
        &mut NoSchemaNormalizationCheckpointV1,
    )
    .unwrap();
    let _ = install_schema_maintenance_v1(
        normalized,
        &authority,
        &mut || Ok(BASE),
        SchemaInstallationOptionsV1::default(),
        &mut ExitAt {
            id: input["id"].as_str().unwrap().into(),
        },
    )
    .unwrap();
    panic!("real exit checkpoint was not reached");
}
fn run_child(path: &Path) -> std::process::Output {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "installation_crash_child", "--nocapture"])
        .env("HEPTA_SCHEMA_INSTALLATION_CHILD", path)
        .output()
        .unwrap()
}
#[test]
fn real_exit_after_commit_before_progress_is_recovered_by_new_process() {
    for version in [1, 2] {
        let fixture = Fixture::new_version(false, version);
        let mut authority = fixture.authority();
        let token = normalized(&fixture, &mut authority);
        let plan = token.plan().clone();
        let id = plan["transitionId"].as_str().unwrap();
        let journal: Value = serde_json::from_slice(&fs::read(fixture.journal()).unwrap()).unwrap();
        let expected=fixture.oracle.borrow_mut().call(json!({"operation":"installation-preview","root":fixture.root,"plan":plan,"reservation":journal["reservation"]}));
        assert_eq!(expected["ok"], true, "{expected}");
        let exit_id = plan["instances"][3]["databaseInstanceId"].clone();
        drop(token);
        let input_path = fixture.root.join("child-public.json");
        let result_path = fixture.root.join("recovered-records.json");
        let mut input = json!({"setup":fixture.setup,"transitionId":id,"planHash":plan["planHash"],"id":exit_id,"mode":"install","resultPath":result_path});
        fs::write(&input_path, serde_json::to_vec(&input).unwrap()).unwrap();
        let output = run_child(&input_path);
        assert_eq!(
            output.status.code(),
            Some(91),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let pending: Value = serde_json::from_slice(&fs::read(fixture.journal()).unwrap()).unwrap();
        assert_eq!(pending["installations"].as_array().unwrap().len(), 3);
        let committed = &plan["instances"][3];
        let db = rusqlite::Connection::open(
            Path::new(fixture.setup["runtimeRoot"].as_str().unwrap())
                .join(committed["sourceRelativePath"].as_str().unwrap()),
        )
        .unwrap();
        let installed_id:String=db.query_row("SELECT database_instance_id FROM autonomous_research_online_mutation_authority_metadata",[],|r|r.get(0)).unwrap();
        assert_eq!(installed_id, exit_id.as_str().unwrap());
        drop(db);
        input["mode"] = json!("recover");
        fs::write(&input_path, serde_json::to_vec(&input).unwrap()).unwrap();
        let output = run_child(&input_path);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let records: Value = serde_json::from_slice(&fs::read(&result_path).unwrap()).unwrap();
        assert_eq!(records, expected["value"]);
    }
}
#[test]
fn recovery_rejects_business_tamper_cross_role_receipt_and_expiry() {
    let fixture = Fixture::new(false);
    let mut authority = fixture.authority();
    let token = normalized(&fixture, &mut authority);
    let plan = token.plan().clone();
    let installed = install_schema_maintenance_v1(
        token,
        &authority,
        &mut || Ok(BASE),
        SchemaInstallationOptionsV1::default(),
        &mut NoSchemaInstallationCheckpointV1,
    )
    .unwrap();
    drop(installed);
    let original_journal = fs::read(fixture.journal()).unwrap();
    let mut journal: Value = serde_json::from_slice(&original_journal).unwrap();
    journal["plan"]["plannedAt"] = json!("2026-09-16T11:59:59.000Z");
    let mut forged_base = journal["plan"].clone();
    let map = forged_base.as_object_mut().unwrap();
    map.remove("planHash");
    map.remove("transitionId");
    let forged_hash = hepta_legacy_compatibility::production_hash_record_v1(
        "AutonomousResearchOnlineSchemaTransitionPlan",
        &forged_base,
    )
    .unwrap();
    journal["plan"]["planHash"] = json!(forged_hash.as_str());
    let before = plan_bytes(&fixture, &plan);
    fs::write(fixture.journal(), serde_json::to_vec(&journal).unwrap()).unwrap();
    assert_eq!(
        fail(resume_schema_installation_v1(
            resume_installation(&fixture, &plan),
            &authority,
            &mut || Ok(BASE),
            &mut NoSchemaInstallationCheckpointV1
        )),
        "autonomous_research_online_schema_transition_installation_journal_invalid"
    );
    assert_eq!(plan_bytes(&fixture, &plan), before);
    journal = serde_json::from_slice(&original_journal).unwrap();

    journal["reservation"]["databaseGenesis"][0]["databaseRole"] =
        journal["reservation"]["databaseGenesis"][1]["databaseRole"].clone();
    fs::write(fixture.journal(), serde_json::to_vec(&journal).unwrap()).unwrap();
    assert!(
        !fail(resume_schema_installation_v1(
            resume_installation(&fixture, &plan),
            &authority,
            &mut || Ok(BASE),
            &mut NoSchemaInstallationCheckpointV1
        ))
        .is_empty()
    );
    fs::write(fixture.journal(), &original_journal).unwrap();
    let before: Vec<_> = plan["instances"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            fs::read(
                Path::new(fixture.setup["runtimeRoot"].as_str().unwrap())
                    .join(row["sourceRelativePath"].as_str().unwrap()),
            )
            .unwrap()
        })
        .collect();
    assert!(
        !fail(resume_schema_installation_v1(
            resume_installation(&fixture, &plan),
            &authority,
            &mut || Ok(BASE + 60000),
            &mut NoSchemaInstallationCheckpointV1
        ))
        .is_empty()
    );
    for (row, bytes) in plan["instances"].as_array().unwrap().iter().zip(before) {
        assert_eq!(
            fs::read(
                Path::new(fixture.setup["runtimeRoot"].as_str().unwrap())
                    .join(row["sourceRelativePath"].as_str().unwrap())
            )
            .unwrap(),
            bytes
        );
    }
    let preimages = Path::new(fixture.setup["runtimeRoot"].as_str().unwrap())
        .join("autonomous-research/online-schema-transition")
        .join(format!(
            "preimages-{}",
            plan["planHash"]
                .as_str()
                .unwrap()
                .trim_start_matches("sha256:")
        ));
    let artifact = fs::read_dir(preimages)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|s| s == "preimage"))
        .unwrap();
    let original = fs::read(&artifact).unwrap();
    let mut changed = original.clone();
    changed[0] ^= 1;
    fs::write(&artifact, &changed).unwrap();
    let expected_bytes = plan_bytes(&fixture, &plan);
    assert!(
        !fail(resume_schema_installation_v1(
            resume_installation(&fixture, &plan),
            &authority,
            &mut || Ok(BASE),
            &mut NoSchemaInstallationCheckpointV1
        ))
        .is_empty()
    );
    assert_eq!(plan_bytes(&fixture, &plan), expected_bytes);
    fs::write(&artifact, &original).unwrap();
    let row = plan["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["databaseRole"] == "native-store")
        .unwrap();
    let path = Path::new(fixture.setup["runtimeRoot"].as_str().unwrap())
        .join(row["sourceRelativePath"].as_str().unwrap());
    let db = rusqlite::Connection::open(&path).unwrap();
    assert!(
        db.execute(
            "UPDATE fixture_anchor SET value='tampered' WHERE id='fixture'",
            []
        )
        .unwrap()
            > 0
    );
    drop(db);
    assert_eq!(
        fail(resume_schema_installation_v1(
            resume_installation(&fixture, &plan),
            &authority,
            &mut || Ok(BASE),
            &mut NoSchemaInstallationCheckpointV1
        )),
        "schema_transition_installation_state_mismatch"
    );
}
#[test]
fn checkpoint_expiry_before_commit_rolls_back_and_preserves_source_bytes() {
    use std::cell::Cell;
    struct Expire<'a>(&'a Cell<i64>);
    impl SchemaInstallationCheckpointV1 for Expire<'_> {
        fn checkpoint(&mut self, point: &str, _: &str) -> Result<()> {
            if point == "before_instance_commit" {
                self.0.set(BASE + 60000);
            }
            Ok(())
        }
    }
    let fixture = Fixture::new(false);
    let mut authority = fixture.authority();
    let token = normalized(&fixture, &mut authority);
    let plan = token.plan().clone();
    let before: Vec<_> = plan["instances"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            fs::read(
                Path::new(fixture.setup["runtimeRoot"].as_str().unwrap())
                    .join(r["sourceRelativePath"].as_str().unwrap()),
            )
            .unwrap()
        })
        .collect();
    let now = Cell::new(BASE);
    assert!(
        !fail(install_schema_maintenance_v1(
            token,
            &authority,
            &mut || Ok(now.get()),
            SchemaInstallationOptionsV1::default(),
            &mut Expire(&now)
        ))
        .is_empty()
    );
    for (row, bytes) in plan["instances"].as_array().unwrap().iter().zip(before) {
        assert_eq!(
            fs::read(
                Path::new(fixture.setup["runtimeRoot"].as_str().unwrap())
                    .join(row["sourceRelativePath"].as_str().unwrap())
            )
            .unwrap(),
            bytes
        );
    }
}

#[test]
fn actual_wall_clock_lease_installs_all_ten_databases() {
    use hepta_paper_service::sqlite_mutation_coordinator::clock::SystemMutationClockV1;
    let fixture = Fixture::new(false);
    let mut authority = fixture.authority();
    let mut clock = SystemMutationClockV1;
    let plan = build_schema_transition_plan_v1(fixture.options(), &authority, &mut clock).unwrap();
    let maintenance = reserve_schema_maintenance_v1(plan, &mut authority, &mut clock).unwrap();
    let token = normalize_schema_maintenance_v1(
        maintenance,
        &authority,
        &mut clock,
        &mut NoSchemaNormalizationCheckpointV1,
    )
    .unwrap();
    let installed = install_schema_maintenance_v1(
        token,
        &authority,
        &mut clock,
        SchemaInstallationOptionsV1::default(),
        &mut NoSchemaInstallationCheckpointV1,
    )
    .unwrap();
    assert_eq!(installed.records().as_array().unwrap().len(), 10);
}

struct ProbeAllLocks {
    paths: Vec<PathBuf>,
    done: bool,
}
impl SchemaInstallationCheckpointV1 for ProbeAllLocks {
    fn checkpoint(&mut self, point: &str, _: &str) -> Result<()> {
        if point == "after_instance_commit_before_publication" && !self.done {
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "installation_lock_probe_child", "--nocapture"])
                .env(
                    "HEPTA_INSTALLATION_LOCK_PATHS",
                    serde_json::to_string(&self.paths).unwrap(),
                )
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            self.done = true;
        }
        Ok(())
    }
}
#[test]
fn installation_lock_probe_child() {
    let Ok(paths) = std::env::var("HEPTA_INSTALLATION_LOCK_PATHS") else {
        return;
    };
    let paths: Vec<PathBuf> = serde_json::from_str(&paths).unwrap();
    assert_eq!(paths.len(), 10);
    for path in paths {
        let database = rusqlite::Connection::open(path).unwrap();
        database.busy_timeout(std::time::Duration::ZERO).unwrap();
        let failure = database.execute_batch("BEGIN IMMEDIATE").unwrap_err();
        assert_eq!(
            failure.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
        assert!(database.is_autocommit());
    }
}

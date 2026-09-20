use hepta_paper_service::{
    online_schema_execution::{
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
const NOW: &str = "2026-09-16T12:00:00.000Z";
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
                    .join("../../oracle/schema-normalization-v1.mjs"),
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
            "/tmp/hepta-schema-source-rust-{}-normalization-{}",
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
    fn resume<'a>(&'a self, id: &'a str) -> ResumeSchemaNormalizationOptionsV1<'a> {
        ResumeSchemaNormalizationOptionsV1 {
            runtime_root: Path::new(self.setup["runtimeRoot"].as_str().unwrap()),
            state_database_manifest: &self.setup["stateDatabaseManifest"],
            writer_manifest: &self.setup["writerManifest"],
            expected_transition_id: id,
            machine_genesis: None,
        }
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
        // The installation default uses a 1000ms commit margin; keep the
        // direct Rust fixture's signed execution window strictly larger.
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
#[test]
fn actual_ten_database_normalization_records_match_node_and_keep_exclusive_lock() {
    let fixture = Fixture::new(false);
    let mut authority = fixture.authority();
    let plan =
        build_schema_transition_plan_v1(fixture.options(), &authority, &mut || Ok(BASE)).unwrap();
    let mut token = reserve_schema_maintenance_v1(plan, &mut authority, &mut || Ok(BASE)).unwrap();
    let expected=fixture.oracle.borrow_mut().call(json!({"operation":"normalize-scope","root":fixture.root,"plan":token.plan(),"request":token.request(),"reservation":token.reservation()}));
    assert_eq!(expected["ok"], true, "{expected}");
    token.assert_current(&authority, &mut || Ok(BASE)).unwrap();
    let mut normalized = normalize_schema_maintenance_v1(
        token,
        &authority,
        &mut || Ok(BASE),
        &mut NoSchemaNormalizationCheckpointV1,
    )
    .unwrap();
    assert_eq!(normalized.records(), &expected["value"]);
    assert_eq!(normalized.records().as_array().unwrap().len(), 10);
    normalized
        .assert_current(&authority, &mut || Ok(BASE))
        .unwrap();
    let id = normalized.plan()["transitionId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        fail(resume_schema_normalization_v1(
            fixture.resume(&id),
            &authority,
            &mut || Ok(BASE),
            &mut NoSchemaNormalizationCheckpointV1
        )),
        "autonomous_research_online_schema_transition_maintenance_busy"
    );
    drop(normalized);
    let mut restored = resume_schema_normalization_v1(
        fixture.resume(&id),
        &authority,
        &mut || Ok(BASE),
        &mut NoSchemaNormalizationCheckpointV1,
    )
    .unwrap();
    restored
        .assert_current(&authority, &mut || Ok(BASE))
        .unwrap();
    assert_eq!(restored.records(), &expected["value"]);
    drop(restored);
    let original = fs::read(fixture.journal()).unwrap();
    for mode in ["signature", "request", "plan", "root"] {
        let mut record: Value = serde_json::from_slice(&original).unwrap();
        match mode {
            "signature" => record["reservation"]["signature"] = json!("invalid"),
            "request" => {
                record["request"]["instances"][0]["sourceSha256"] =
                    json!(format!("sha256:{}", "0".repeat(64)))
            }
            "plan" => {
                record["plan"]["instances"][0]["expectedNormalizedSourceSha256"] =
                    json!(format!("sha256:{}", "0".repeat(64)))
            }
            "root" => record["runtimeRootIdentity"]["inode"] = json!("0"),
            _ => unreachable!(),
        }
        fs::write(fixture.journal(), serde_json::to_vec(&record).unwrap()).unwrap();
        let code = fail(resume_schema_normalization_v1(
            fixture.resume(&id),
            &authority,
            &mut || Ok(BASE),
            &mut NoSchemaNormalizationCheckpointV1,
        ));
        assert!(
            code.contains("invalid") || code.contains("mismatch"),
            "{mode}: {code}"
        );
    }
    fs::write(fixture.journal(), original).unwrap();
    let first = &expected["value"][0];
    let inventory =
        hepta_paper_service::state_database_inventory::inspect_state_database_inventory_v1(
            Path::new(fixture.setup["runtimeRoot"].as_str().unwrap()),
            &fixture.setup["stateDatabaseManifest"],
        )
        .unwrap();
    let row = inventory["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["instanceId"] == first["databaseInstanceId"])
        .unwrap();
    let path = Path::new(fixture.setup["runtimeRoot"].as_str().unwrap())
        .join(row["sourceRelativePath"].as_str().unwrap());
    let database = rusqlite::Connection::open(&path).unwrap();
    database.execute_batch("CREATE TABLE unauthorized_after_progress(id INTEGER PRIMARY KEY); INSERT INTO unauthorized_after_progress VALUES(1);").unwrap();
    drop(database);
    let changed_bytes = fs::read(&path).unwrap();
    let code = fail(resume_schema_normalization_v1(
        fixture.resume(&id),
        &authority,
        &mut || Ok(BASE),
        &mut NoSchemaNormalizationCheckpointV1,
    ));
    assert_eq!(
        code,
        "autonomous_research_online_schema_transition_reserved_normalized_projection_mismatch"
    );
    assert_eq!(
        fs::read(path).unwrap(),
        changed_bytes,
        "completed progress cannot authorize overwrite of changed source"
    );
}

#[test]
fn already_installed_normalization_recovery_matches_node() {
    let fixture = Fixture::new(false);
    let mut authority = fixture.authority();
    let plan =
        build_schema_transition_plan_v1(fixture.options(), &authority, &mut || Ok(BASE)).unwrap();
    let token = reserve_schema_maintenance_v1(plan, &mut authority, &mut || Ok(BASE)).unwrap();
    let plan_value = token.plan().clone();
    let request = token.request().clone();
    let reservation = token.reservation().clone();
    let _installed = install_schema_maintenance_v1(
        normalize_schema_maintenance_v1(
            token,
            &authority,
            &mut || Ok(BASE),
            &mut NoSchemaNormalizationCheckpointV1,
        )
        .unwrap(),
        &authority,
        &mut || Ok(BASE),
        SchemaInstallationOptionsV1::default(),
        &mut NoSchemaInstallationCheckpointV1,
    )
    .unwrap();
    drop(_installed);
    let expected = fixture.oracle.borrow_mut().call(json!({
        "operation":"normalize-scope",
        "root":fixture.root,
        "plan":plan_value,
        "request":request,
        "reservation":reservation,
    }));
    assert_eq!(expected["ok"], true, "{expected}");
    let id = plan_value["transitionId"].as_str().unwrap();
    let recovered = resume_schema_normalization_v1(
        fixture.resume(id),
        &authority,
        &mut || Ok(BASE),
        &mut NoSchemaNormalizationCheckpointV1,
    )
    .unwrap();
    assert_eq!(recovered.records(), &expected["value"]);
    assert!(
        recovered
            .records()
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["alreadyInstalled"] == true)
    );
}
struct ExitAt {
    point: String,
    id: String,
}
impl SchemaNormalizationCheckpointV1 for ExitAt {
    fn checkpoint(&mut self, point: &str, id: &str) -> Result<()> {
        if self.point == point && self.id == id {
            std::process::exit(91)
        }
        Ok(())
    }
}
#[test]
fn normalization_crash_child() {
    let Ok(path) = std::env::var("HEPTA_NORMALIZATION_CHILD_FIXTURE") else {
        return;
    };
    let input: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let setup = &input["setup"];
    let mut authority = PinnedMutationAuthorityV1::load(
        Path::new(setup["configurationPath"].as_str().unwrap()),
        setup["configurationFileHash"].as_str().unwrap(),
        Reply(input["receipt"].clone()),
    )
    .unwrap();
    let plan =
        build_schema_transition_plan_v1(options(setup), &authority, &mut || Ok(BASE)).unwrap();
    let token = reserve_schema_maintenance_v1(plan, &mut authority, &mut || Ok(BASE)).unwrap();
    let _ = normalize_schema_maintenance_v1(
        token,
        &authority,
        &mut || Ok(BASE),
        &mut ExitAt {
            point: input["point"].as_str().unwrap().into(),
            id: input["id"].as_str().unwrap().into(),
        },
    )
    .unwrap();
    panic!("fault checkpoint not reached");
}
#[test]
fn actual_process_crash_after_checkpoint_and_before_publication_resumes_signed_bytes() {
    for point in [
        "after_journal_checkpoint",
        "before_normalization_progress_publication",
    ] {
        let fixture = Fixture::new(true);
        let authority = fixture.authority();
        let plan = build_schema_transition_plan_v1(fixture.options(), &authority, &mut || Ok(BASE))
            .unwrap();
        let request = plan.reserve_request(&authority, NOW).unwrap();
        let receipt=fixture.oracle.borrow_mut().call(json!({"operation":"reserve-maintenance","root":fixture.root,"request":request,"mode":"valid"}));
        assert_eq!(receipt["ok"], true, "{receipt}");
        let native = plan.value()["instances"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["databaseRole"] == "native-store")
            .unwrap();
        let data = json!({"setup":fixture.setup,"receipt":receipt["value"]["receipt"],"point":point,"id":native["databaseInstanceId"]});
        let input = fixture.root.join("child-public.json");
        fs::write(&input, serde_json::to_vec(&data).unwrap()).unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "normalization_crash_child", "--nocapture"])
            .env("HEPTA_NORMALIZATION_CHILD_FIXTURE", &input)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(91),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(fixture.journal().exists());
        let id = plan.value()["transitionId"].as_str().unwrap();
        assert!(
            fail(resume_schema_normalization_v1(
                fixture.resume(id),
                &authority,
                &mut || Ok(BASE + 60000),
                &mut NoSchemaNormalizationCheckpointV1
            ))
            .contains("reservation_invalid")
        );
        let mut recovered = resume_schema_normalization_v1(
            fixture.resume(id),
            &authority,
            &mut || Ok(BASE),
            &mut NoSchemaNormalizationCheckpointV1,
        )
        .unwrap_or_else(|e| panic!("{point}: {e}"));
        recovered
            .assert_current(&authority, &mut || Ok(BASE))
            .unwrap();
        assert_eq!(recovered.records().as_array().unwrap().len(), 10);
        let path = Path::new(fixture.setup["runtimeRoot"].as_str().unwrap())
            .join(native["sourceRelativePath"].as_str().unwrap());
        use sha2::Digest;
        let digest = format!(
            "sha256:{}",
            hex::encode(sha2::Sha256::digest(fs::read(&path).unwrap()))
        );
        assert_eq!(digest, native["expectedNormalizedSourceSha256"]);
        assert!(!PathBuf::from(format!("{}-wal", path.display())).exists());
        assert!(!PathBuf::from(format!("{}-shm", path.display())).exists());
        let db =
            rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let value: String = db
            .query_row(
                "SELECT value FROM normalization_probe WHERE id=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(value, "effective WAL");
    }
}

#[test]
fn pristine_rebind_normalization_preserves_verified_genesis_and_matches_node() {
    let fixture = Fixture::new_version(false, 2);
    let mut authority = fixture.authority();
    let plan =
        build_schema_transition_plan_v1(fixture.options(), &authority, &mut || Ok(BASE)).unwrap();
    assert_eq!(plan.value()["version"], 2);
    let token = reserve_schema_maintenance_v1(plan, &mut authority, &mut || Ok(BASE)).unwrap();
    let expected=fixture.oracle.borrow_mut().call(json!({"operation":"normalize-scope","root":fixture.root,"plan":token.plan(),"request":token.request(),"reservation":token.reservation()}));
    assert_eq!(expected["ok"], true, "{expected}");
    let mut normalized = normalize_schema_maintenance_v1(
        token,
        &authority,
        &mut || Ok(BASE),
        &mut NoSchemaNormalizationCheckpointV1,
    )
    .unwrap();
    assert_eq!(normalized.records(), &expected["value"]);
    assert_eq!(normalized.records().as_array().unwrap().len(), 10);
    normalized
        .assert_current(&authority, &mut || Ok(BASE))
        .unwrap();
    let id = normalized.plan()["transitionId"]
        .as_str()
        .unwrap()
        .to_owned();
    drop(normalized);
    let mut recovered = resume_schema_normalization_v1(
        fixture.resume(&id),
        &authority,
        &mut || Ok(BASE),
        &mut NoSchemaNormalizationCheckpointV1,
    )
    .unwrap();
    recovered
        .assert_current(&authority, &mut || Ok(BASE))
        .unwrap();
    assert_eq!(recovered.records(), &expected["value"]);
}

struct Disturbance {
    path: PathBuf,
    runtime: PathBuf,
    mode: String,
    fired: bool,
    now: Rc<std::cell::Cell<i64>>,
}
impl SchemaNormalizationCheckpointV1 for Disturbance {
    fn checkpoint(&mut self, point: &str, _: &str) -> Result<()> {
        if self.fired || point != "before_normalization_progress_publication" {
            return Ok(());
        }
        self.fired = true;
        use std::os::unix::fs::PermissionsExt;
        match self.mode.as_str() {
            "unregistered" => {
                let db =
                    rusqlite::Connection::open(self.runtime.join("unregistered.sqlite")).unwrap();
                db.execute_batch("CREATE TABLE forbidden(id INTEGER PRIMARY KEY)")
                    .unwrap();
            }
            "replacement" => {
                let bytes = fs::read(&self.path).unwrap();
                let mode = fs::metadata(&self.path).unwrap().permissions().mode();
                fs::rename(&self.path, self.path.with_extension("saved-original")).unwrap();
                fs::write(&self.path, bytes).unwrap();
                fs::set_permissions(&self.path, fs::Permissions::from_mode(mode)).unwrap();
            }
            "shm" => {
                let path = PathBuf::from(format!("{}-shm", self.path.display()));
                fs::write(&path, b"ephemeral state added after normalization").unwrap();
                fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
            }
            "clock" => self.now.set(BASE + 59001),
            _ => unreachable!(),
        }
        Ok(())
    }
}
#[test]
fn cached_scope_rechecks_namespace_inode_sidecars_and_final_lease() {
    for mode in ["unregistered", "replacement", "shm", "clock"] {
        let fixture = Fixture::new(false);
        let mut authority = fixture.authority();
        let plan = build_schema_transition_plan_v1(fixture.options(), &authority, &mut || Ok(BASE))
            .unwrap();
        let first = plan.value()["instances"][0].clone();
        let token = reserve_schema_maintenance_v1(plan, &mut authority, &mut || Ok(BASE)).unwrap();
        let runtime = PathBuf::from(fixture.setup["runtimeRoot"].as_str().unwrap());
        let now = Rc::new(std::cell::Cell::new(BASE));
        let mut callback = Disturbance {
            path: runtime.join(first["sourceRelativePath"].as_str().unwrap()),
            runtime,
            mode: mode.into(),
            fired: false,
            now: now.clone(),
        };
        let code = fail(normalize_schema_maintenance_v1(
            token,
            &authority,
            &mut || Ok(now.get()),
            &mut callback,
        ));
        assert!(callback.fired, "{mode}: {code}");
        match mode {
            "replacement" => assert_eq!(
                code,
                "autonomous_research_online_schema_transition_reserved_normalized_projection_mismatch"
            ),
            "shm" => assert_eq!(
                code,
                "autonomous_research_online_schema_transition_normalized_source_mismatch"
            ),
            "clock" => assert_eq!(
                code,
                "autonomous_research_online_schema_transition_quiescence_lease_insufficient"
            ),
            "unregistered" => assert_eq!(
                code,
                "autonomous_research_online_schema_transition_inventory_invalid"
            ),
            _ => unreachable!(),
        }
    }
}

#[test]
fn signed_node_engine_wal_reservation_is_rejected_before_native_source_writes() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let fixture = Fixture::new(true);
    let authority = fixture.authority();
    let node = fixture
        .oracle
        .borrow_mut()
        .call(json!({"operation":"full-plan","root":fixture.root,"setup":fixture.setup}));
    assert_eq!(node["ok"], true, "{node}");
    let plan = &node["value"];
    let mut request = plan.clone();
    let object = request.as_object_mut().unwrap();
    object.remove("planHash");
    object.remove("plannedAt");
    object.remove("prePristineRuntimeStateHash");
    object.insert(
        "kind".into(),
        json!("AutonomousResearchOnlineSchemaTransitionReserveRequest"),
    );
    object.insert("requestedAt".into(), json!(NOW));
    let signed = fixture.oracle.borrow_mut().call(json!({"operation":"reserve-maintenance","root":fixture.root,"request":request,"mode":"valid"}));
    assert_eq!(signed["ok"], true, "{signed}");
    assert_eq!(signed["value"]["accepted"], true);
    authority
        .verify_schema_transition_reservation(&signed["value"]["receipt"], &request, BASE)
        .unwrap();
    let root = Path::new(fixture.setup["runtimeRoot"].as_str().unwrap());
    let m = fs::metadata(root).unwrap();
    let identity = json!({"resolved":root,"device":m.dev().to_string(),"inode":m.ino().to_string(),"mode":m.mode().to_string(),"uid":m.uid().to_string(),"gid":m.gid().to_string()});
    let journal = json!({"version":1,"kind":"NativeSchemaJournalNormalizationProgress","runtimeRootIdentity":identity,"authorityConfigurationHash":authority.configuration_hash(),"plan":plan,"request":request,"reservation":signed["value"]["receipt"],"checkedAtMillis":BASE,"normalizationRecords":[]});
    let path = fixture.journal();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(&path, serde_json::to_vec(&journal).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let before = plan["instances"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|v| {
            ["", "-wal", "-shm"].into_iter().filter_map(|suffix| {
                let path = PathBuf::from(format!(
                    "{}{suffix}",
                    root.join(v["sourceRelativePath"].as_str().unwrap())
                        .display()
                ));
                fs::read(&path).ok().map(|bytes| (path, bytes))
            })
        })
        .collect::<Vec<_>>();
    let code = fail(resume_schema_normalization_v1(
        fixture.resume(plan["transitionId"].as_str().unwrap()),
        &authority,
        &mut || Ok(BASE),
        &mut NoSchemaNormalizationCheckpointV1,
    ));
    assert_eq!(
        code,
        "autonomous_research_online_schema_transition_reserved_normalized_projection_mismatch"
    );
    for (path, bytes) in before {
        assert_eq!(
            fs::read(path).unwrap(),
            bytes,
            "cross-engine signed projection must not be repaired by altering source bytes"
        );
    }
}

#[test]
fn actual_wall_clock_signed_lease_completes_ten_database_wal_normalization() {
    let fixture = Fixture::new(true);
    let mut authority = fixture.authority();
    let mut clock = hepta_paper_service::sqlite_mutation_coordinator::clock::SystemMutationClockV1;
    let plan = build_schema_transition_plan_v1(fixture.options(), &authority, &mut clock).unwrap();
    let token = reserve_schema_maintenance_v1(plan, &mut authority, &mut clock).unwrap();
    let started = std::time::Instant::now();
    let mut normalized = normalize_schema_maintenance_v1(
        token,
        &authority,
        &mut clock,
        &mut NoSchemaNormalizationCheckpointV1,
    )
    .unwrap();
    normalized.assert_current(&authority, &mut clock).unwrap();
    assert_eq!(normalized.records().as_array().unwrap().len(), 10);
    assert!(started.elapsed() < std::time::Duration::from_secs(59));
}

use hepta_paper_service::online_schema_execution::observe_schema_transition_source_v1;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
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
                    .join("../../oracle/schema-source-projection-v1.mjs"),
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
    role: String,
}
impl Fixture {
    fn new(oracle: &mut Oracle, scenario: &str) -> Self {
        let root = PathBuf::from(format!(
            "/tmp/hepta-schema-source-rust-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let result = oracle.call(json!({"operation":"fixture","root":root,"scenario":scenario}));
        assert_eq!(result["ok"], true, "{result}");
        Self {
            root,
            role: result["value"]["role"].as_str().unwrap().into(),
        }
    }
    fn project(
        &self,
    ) -> hepta_paper_service::sqlite_mutation_coordinator::Result<
        hepta_paper_service::online_schema_execution::ObservedSchemaTransitionSourceV1,
    > {
        observe_schema_transition_source_v1(
            &self.root,
            Path::new("candidate.sqlite"),
            &self.role,
            Some(NOW),
        )
    }
    fn node(&self, oracle: &mut Oracle) -> Value {
        oracle.call(json!({"operation":"project","root":self.root,"role":self.role,"relativePath":"candidate.sqlite"}))
    }
    fn files(&self) -> Vec<(String, Vec<u8>, Value)> {
        let mut out = fs::read_dir(&self.root)
            .unwrap()
            .map(|entry| {
                let e = entry.unwrap();
                let m = e.metadata().unwrap();
                (
                    e.file_name().to_string_lossy().into_owned(),
                    fs::read(e.path()).unwrap(),
                    json!([
                        m.dev(),
                        m.ino(),
                        m.mode(),
                        m.nlink(),
                        m.mtime(),
                        m.mtime_nsec(),
                        m.ctime(),
                        m.ctime_nsec()
                    ]),
                )
            })
            .collect::<Vec<_>>();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn actual_file_identity_schema_and_journal_projection_match_original_without_source_writes() {
    let mut oracle = Oracle::new();
    for scenario in ["delete", "wal", "wal-no-shm", "stale-shm", "handoff"] {
        let fixture = Fixture::new(&mut oracle, scenario);
        let before = fixture.files();
        let expected = fixture.node(&mut oracle);
        assert_eq!(expected["ok"], true, "{scenario}: {expected}");
        let actual = fixture
            .project()
            .unwrap_or_else(|e| panic!("{scenario}: {e}"));
        let mut observed = actual.value().clone();
        let mut expected = expected["value"].clone();
        if ["wal", "wal-no-shm", "stale-shm"].contains(&scenario) {
            assert_ne!(
                observed["expectedNormalizedSourceSha256"],
                expected["expectedNormalizedSourceSha256"],
                "the pinned SQLite engines have different writer-version headers"
            );
            observed
                .as_object_mut()
                .unwrap()
                .remove("expectedNormalizedSourceSha256");
            expected
                .as_object_mut()
                .unwrap()
                .remove("expectedNormalizedSourceSha256");
        }
        assert_eq!(observed, expected, "{scenario}");
        actual.assert_current().unwrap();
        assert_eq!(fixture.files(), before, "{scenario}: source changed");
    }
}
#[test]
fn actual_target_conflicts_foreign_keys_and_hidden_user_surface_fail_closed() {
    let mut oracle = Oracle::new();
    for scenario in ["target-conflict", "foreign-key", "hidden"] {
        let fixture = Fixture::new(&mut oracle, scenario);
        let before = fixture.files();
        let expected = fixture.node(&mut oracle);
        let Err(actual) = fixture.project() else {
            panic!("accepted {scenario}")
        };
        if scenario == "hidden" {
            assert_eq!(expected["ok"], true);
            assert_eq!(
                actual.code,
                "autonomous_research_online_schema_transition_hidden_user_schema_object"
            );
        } else {
            assert_eq!(expected["ok"], false, "{expected}");
            assert_eq!(actual.code, expected["error"].as_str().unwrap());
        }
        assert_eq!(fixture.files(), before);
    }
}
#[test]
fn retained_source_proof_rejects_byte_mode_and_sidecar_drift() {
    let mut oracle = Oracle::new();
    for scenario in ["bytes", "mode", "wal", "shm", "journal"] {
        let fixture = Fixture::new(&mut oracle, "delete");
        let actual = fixture.project().unwrap();
        let path = fixture.root.join("candidate.sqlite");
        match scenario {
            "bytes" => {
                let mut data = fs::read(&path).unwrap();
                data[100] ^= 1;
                fs::write(path, data).unwrap();
            }
            "mode" => fs::set_permissions(path, fs::Permissions::from_mode(0o644)).unwrap(),
            suffix => fs::write(
                fixture.root.join(format!("candidate.sqlite-{suffix}")),
                b"new source state",
            )
            .unwrap(),
        }
        assert!(actual.assert_current().is_err(), "{scenario}");
    }
}
#[test]
fn physical_sources_refuse_aliases_hot_journals_and_path_escapes() {
    let mut oracle = Oracle::new();
    for scenario in [
        "symlink",
        "hardlink",
        "fifo",
        "writable",
        "hot-journal",
        "path-alias",
    ] {
        let fixture = Fixture::new(&mut oracle, "delete");
        let path = fixture.root.join("candidate.sqlite");
        match scenario {
            "symlink" => {
                fs::rename(&path, fixture.root.join("other.sqlite")).unwrap();
                symlink("other.sqlite", &path).unwrap();
            }
            "hardlink" => fs::hard_link(&path, fixture.root.join("alias.sqlite")).unwrap(),
            "fifo" => {
                fs::remove_file(&path).unwrap();
                nix::unistd::mkfifo(&path, nix::sys::stat::Mode::from_bits_truncate(0o600))
                    .unwrap();
            }
            "writable" => fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap(),
            "hot-journal" => {
                fs::write(fixture.root.join("candidate.sqlite-journal"), [1u8; 8]).unwrap()
            }
            "path-alias" => {}
            _ => unreachable!(),
        }
        let result = observe_schema_transition_source_v1(
            &fixture.root,
            Path::new(if scenario == "path-alias" {
                "./candidate.sqlite"
            } else {
                "candidate.sqlite"
            }),
            &fixture.role,
            Some(NOW),
        );
        assert!(result.is_err(), "{scenario}");
    }
}

#[test]
fn wal_normalization_hashes_bind_actual_writer_engine_bytes() {
    let mut oracle = Oracle::new();
    let fixture = Fixture::new(&mut oracle, "wal");
    let source = fixture.project().unwrap();
    for name in ["node.sqlite", "rust.sqlite"] {
        fs::copy(
            fixture.root.join("candidate.sqlite"),
            fixture.root.join(name),
        )
        .unwrap();
        fs::copy(
            fixture.root.join("candidate.sqlite-wal"),
            fixture.root.join(format!("{name}-wal")),
        )
        .unwrap();
    }
    let node = oracle.call(
        json!({"operation":"normalize-copy","root":fixture.root,"relativePath":"node.sqlite"}),
    );
    assert_eq!(node["ok"], true, "{node}");
    let db = rusqlite::Connection::open(fixture.root.join("rust.sqlite")).unwrap();
    let _: String = db
        .query_row("PRAGMA journal_mode;", [], |r| r.get(0))
        .unwrap();
    let busy: i64 = db
        .query_row("PRAGMA wal_checkpoint(TRUNCATE);", [], |r| r.get(0))
        .unwrap();
    assert_eq!(busy, 0);
    let mode: String = db
        .query_row("PRAGMA journal_mode=DELETE;", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "delete");
    db.execute_batch("PRAGMA synchronous=FULL;").unwrap();
    let effective: String = db
        .query_row("SELECT value FROM business WHERE id=1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(effective, "effective WAL");
    drop(db);
    let native = fs::read(fixture.root.join("rust.sqlite")).unwrap();
    let original = fs::read(fixture.root.join("node.sqlite")).unwrap();
    assert_eq!(native.len(), original.len());
    let differences = native
        .iter()
        .zip(&original)
        .enumerate()
        .filter_map(|(index, (a, b))| (a != b).then_some(index))
        .collect::<Vec<_>>();
    assert!(
        differences.iter().all(|i| (96..100).contains(i)),
        "unexpected byte differences {differences:?}"
    );
    assert!(!differences.is_empty());
    assert_eq!(
        u32::from_be_bytes(original[96..100].try_into().unwrap()),
        3_051_003
    );
    assert_eq!(
        u32::from_be_bytes(native[96..100].try_into().unwrap()),
        3_053_002
    );
    use sha2::Digest;
    let native_hash = format!("sha256:{}", hex::encode(sha2::Sha256::digest(&native)));
    assert_eq!(
        source.value()["expectedNormalizedSourceSha256"],
        native_hash
    );
    assert_ne!(node["value"]["sha256"], native_hash);
    source.assert_current().unwrap();
}

struct NoAuthorityCalls;
impl hepta_paper_service::sqlite_mutation_coordinator::authority::MutationAuthorityTransportV1
    for NoAuthorityCalls
{
    fn invoke(
        &mut self,
        _: &Value,
    ) -> hepta_paper_service::sqlite_mutation_coordinator::Result<Value> {
        panic!("local planning must not call authority transport")
    }
}
#[test]
fn actual_ten_database_initial_and_pristine_rebind_plans_match_node() {
    use hepta_paper_service::{
        online_schema_execution::plan::*,
        sqlite_mutation_coordinator::authority::PinnedMutationAuthorityV1,
    };
    let mut oracle = Oracle::new();
    for version in [1, 2] {
        let fixture = Fixture {
            root: PathBuf::from(format!(
                "/tmp/hepta-schema-source-rust-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            )),
            role: String::new(),
        };
        let result =
            oracle.call(json!({"operation":"full-fixture","root":fixture.root,"version":version}));
        assert_eq!(result["ok"], true, "{result}");
        let setup = &result["value"];
        let authority = PinnedMutationAuthorityV1::load(
            Path::new(setup["configurationPath"].as_str().unwrap()),
            setup["configurationFileHash"].as_str().unwrap(),
            NoAuthorityCalls,
        )
        .unwrap();
        let mut clock = || Ok(1_789_560_000_000i64);
        let options = || SchemaTransitionPlanOptionsV1 {
            runtime_root: Path::new(setup["runtimeRoot"].as_str().unwrap()),
            state_database_manifest: &setup["stateDatabaseManifest"],
            writer_manifest: &setup["writerManifest"],
            requested_lease_ms: 60000,
            required_execution_window_ms: 1000,
            expected_pre_rebind_pristine_runtime_state_hash:
                setup["expectedPreRebindPristineRuntimeStateHash"].as_str(),
            machine_genesis: None,
        };
        let expected =
            oracle.call(json!({"operation":"full-plan","root":fixture.root,"setup":setup}));
        assert_eq!(expected["ok"], true, "{expected}");
        let actual = build_schema_transition_plan_v1(options(), &authority, &mut clock)
            .unwrap_or_else(|e| panic!("v{version}: {e}"));
        assert_eq!(actual.value(), &expected["value"], "v{version}");
        actual.assert_current().unwrap();
        let request = actual.reserve_request(&authority, NOW).unwrap();
        if version == 2 {
            let signed=oracle.call(json!({"operation":"reserve-maintenance","root":fixture.root,"request":request,"mode":"valid"}));
            assert_eq!(signed["ok"], true, "{signed}");
            assert_eq!(signed["value"]["accepted"], true);
            struct Reply(Value);
            impl hepta_paper_service::sqlite_mutation_coordinator::authority::MutationAuthorityTransportV1 for Reply {
                fn invoke(&mut self,_:&Value)->hepta_paper_service::sqlite_mutation_coordinator::Result<Value>{Ok(self.0.clone())}
            }
            let mut signed_authority = PinnedMutationAuthorityV1::load(
                Path::new(setup["configurationPath"].as_str().unwrap()),
                setup["configurationFileHash"].as_str().unwrap(),
                Reply(signed["value"]["receipt"].clone()),
            )
            .unwrap();
            // A fresh actual plan is consumed by the opaque maintenance token.
            let signed_plan =
                build_schema_transition_plan_v1(options(), &signed_authority, &mut clock).unwrap();
            let token=hepta_paper_service::online_schema_execution::maintenance::reserve_schema_maintenance_v1(signed_plan,&mut signed_authority,&mut clock).unwrap();
            assert_eq!(token.reservation()["version"], 2);
            assert_eq!(
                token.reservation()["previousDatabaseHeads"]
                    .as_array()
                    .unwrap()
                    .len(),
                10
            );

            let mut wrong = options();
            wrong.expected_pre_rebind_pristine_runtime_state_hash =
                Some("sha256:0000000000000000000000000000000000000000000000000000000000000000");
            let Err(error) = build_schema_transition_plan_v1(wrong, &authority, &mut clock) else {
                panic!("accepted wrong pristine pin")
            };
            assert_eq!(
                error.code,
                "autonomous_research_pristine_schema_rebind_expected_state_mismatch"
            );
        }
        let first = &actual.value()["instances"][0];
        let path = Path::new(setup["runtimeRoot"].as_str().unwrap())
            .join(first["sourceRelativePath"].as_str().unwrap());
        let database = rusqlite::Connection::open(path).unwrap();
        database
            .execute_batch("CREATE TABLE unexpected_business(id TEXT);")
            .unwrap();
        drop(database);
        assert!(actual.assert_current().is_err());
    }
}

struct SigningTransport {
    oracle: std::rc::Rc<std::cell::RefCell<Oracle>>,
    root: PathBuf,
    mode: std::rc::Rc<std::cell::RefCell<String>>,
    calls: std::rc::Rc<std::cell::Cell<usize>>,
}
impl hepta_paper_service::sqlite_mutation_coordinator::authority::MutationAuthorityTransportV1
    for SigningTransport
{
    fn invoke(
        &mut self,
        request: &Value,
    ) -> hepta_paper_service::sqlite_mutation_coordinator::Result<Value> {
        self.calls.set(self.calls.get() + 1);
        let value=self.oracle.borrow_mut().call(json!({"operation":"reserve-maintenance","root":self.root,"request":request,"mode":self.mode.borrow().as_str()}));
        assert_eq!(value["ok"], true, "{value}");
        assert_eq!(
            value["value"]["accepted"],
            !["bad-signature", "unfenced", "splice"].contains(&self.mode.borrow().as_str())
        );
        Ok(value["value"]["receipt"].clone())
    }
}
#[test]
fn signed_maintenance_requires_exact_scope_fencing_fresh_final_clock_and_source_pins() {
    use hepta_paper_service::{
        online_schema_execution::{maintenance::*, plan::*},
        sqlite_mutation_coordinator::authority::PinnedMutationAuthorityV1,
    };
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };
    const BASE: i64 = 1_789_560_000_000;
    let oracle = Rc::new(RefCell::new(Oracle::new()));
    let fixture = Fixture {
        root: PathBuf::from(format!(
            "/tmp/hepta-schema-source-rust-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )),
        role: String::new(),
    };
    let result = oracle
        .borrow_mut()
        .call(json!({"operation":"full-fixture","root":fixture.root,"version":1}));
    assert_eq!(result["ok"], true, "{result}");
    let setup = &result["value"];
    let mode = Rc::new(RefCell::new(String::new()));
    let calls = Rc::new(Cell::new(0));
    let mut authority = PinnedMutationAuthorityV1::load(
        Path::new(setup["configurationPath"].as_str().unwrap()),
        setup["configurationFileHash"].as_str().unwrap(),
        SigningTransport {
            oracle: oracle.clone(),
            root: fixture.root.clone(),
            mode: mode.clone(),
            calls: calls.clone(),
        },
    )
    .unwrap();
    let options = || SchemaTransitionPlanOptionsV1 {
        runtime_root: Path::new(setup["runtimeRoot"].as_str().unwrap()),
        state_database_manifest: &setup["stateDatabaseManifest"],
        writer_manifest: &setup["writerManifest"],
        requested_lease_ms: 60000,
        required_execution_window_ms: 1000,
        expected_pre_rebind_pristine_runtime_state_hash: None,
        machine_genesis: None,
    };
    let future_plan =
        build_schema_transition_plan_v1(options(), &authority, &mut || Ok(BASE)).unwrap();
    let Err(error) =
        reserve_schema_maintenance_v1(future_plan, &mut authority, &mut || Ok(BASE - 1))
    else {
        panic!("clock preceding plan accepted")
    };
    assert_eq!(
        error.code,
        "autonomous_research_online_schema_transition_clock_regressed"
    );
    assert_eq!(calls.get(), 0);
    for (scenario, final_offset, expected) in [
        (
            "bad-signature",
            0,
            "autonomous_research_online_schema_transition_reservation_invalid",
        ),
        (
            "unfenced",
            0,
            "autonomous_research_online_schema_transition_reservation_invalid",
        ),
        (
            "splice",
            0,
            "autonomous_research_online_schema_transition_reservation_invalid",
        ),
        (
            "valid",
            59001,
            "autonomous_research_online_schema_transition_quiescence_lease_insufficient",
        ),
        (
            "valid",
            60000,
            "autonomous_research_online_schema_transition_quiescence_lease_insufficient",
        ),
        (
            "valid",
            -1,
            "autonomous_research_online_schema_transition_clock_regressed",
        ),
    ] {
        *mode.borrow_mut() = scenario.into();
        let plan =
            build_schema_transition_plan_v1(options(), &authority, &mut || Ok(BASE)).unwrap();
        let mut samples = vec![BASE, BASE, BASE, BASE, BASE + final_offset].into_iter();
        let Err(error) = reserve_schema_maintenance_v1(plan, &mut authority, &mut || {
            Ok(samples.next().unwrap())
        }) else {
            panic!("accepted {scenario}/{final_offset}")
        };
        assert_eq!(error.code, expected, "{scenario}/{final_offset}");
    }
    *mode.borrow_mut() = "valid".into();
    let plan = build_schema_transition_plan_v1(options(), &authority, &mut || Ok(BASE)).unwrap();
    let mut samples = vec![BASE, BASE, BASE, BASE, BASE + 59000].into_iter();
    let mut maintenance =
        reserve_schema_maintenance_v1(plan, &mut authority, &mut || Ok(samples.next().unwrap()))
            .unwrap();
    assert_eq!(
        maintenance.reservation()["allRegisteredMutationsFenced"],
        true
    );
    let error = maintenance
        .assert_current(&authority, &mut || Ok(BASE + 60000))
        .unwrap_err();
    assert_eq!(
        error.code,
        "autonomous_research_online_schema_transition_reservation_invalid"
    );
    let error = maintenance
        .assert_current(&authority, &mut || Ok(BASE + 59000))
        .unwrap_err();
    assert_eq!(
        error.code, "autonomous_research_online_schema_transition_clock_regressed",
        "expiry must not be revived by an older sample"
    );
    *mode.borrow_mut() = "source-drift".into();
    let plan = build_schema_transition_plan_v1(options(), &authority, &mut || Ok(BASE)).unwrap();
    let Err(error) = reserve_schema_maintenance_v1(plan, &mut authority, &mut || Ok(BASE)) else {
        panic!("source drift accepted")
    };
    assert!(error.code.contains("changed"), "{}", error.code);
    let plan = build_schema_transition_plan_v1(options(), &authority, &mut || Ok(BASE)).unwrap();
    let first = &plan.value()["instances"][0];
    let database = rusqlite::Connection::open(
        Path::new(setup["runtimeRoot"].as_str().unwrap())
            .join(first["sourceRelativePath"].as_str().unwrap()),
    )
    .unwrap();
    database
        .execute_batch("CREATE TABLE changed_before_reservation(id TEXT);")
        .unwrap();
    drop(database);
    let before = calls.get();
    assert!(reserve_schema_maintenance_v1(plan, &mut authority, &mut || Ok(BASE)).is_err());
    assert_eq!(
        calls.get(),
        before,
        "drift before reservation must invoke zero RPCs"
    );
}

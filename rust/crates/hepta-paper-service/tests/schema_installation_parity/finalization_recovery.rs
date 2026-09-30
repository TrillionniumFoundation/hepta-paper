//! Actual planner/reservation/normalization/installation owner chain followed by
//! durable finalization. Peers are explicit Node protocol/signature fixtures,
//! not accepted installed principals or a production cutover.
use super::*;
use hepta_paper_service::online_schema_execution::maintenance::normalization::finalization::recovery::*;

fn prepared(
    f: &Fixture,
    authority: &mut PinnedMutationAuthorityV1<Signing>,
) -> PreparedSchemaFinalizationV1 {
    let normalized = normalized(f, authority);
    let installed = install_schema_maintenance_v1(
        normalized,
        authority,
        &mut || Ok(BASE),
        SchemaInstallationOptionsV1::default(),
        &mut NoSchemaInstallationCheckpointV1,
    )
    .unwrap();
    prepare_schema_transition_finalization_v1(installed, authority, &mut || Ok(BASE)).unwrap()
}
fn selection<'a>(
    f: &'a Fixture,
    plan: &'a Value,
    pin: &'a str,
) -> ResumeSchemaFinalizationOptionsV1<'a> {
    ResumeSchemaFinalizationOptionsV1 {
        runtime_root: Path::new(f.setup["runtimeRoot"].as_str().unwrap()),
        state_database_manifest: &f.setup["stateDatabaseManifest"],
        writer_manifest: &f.setup["writerManifest"],
        expected_transition_id: plan["transitionId"].as_str().unwrap(),
        expected_plan_hash: plan["planHash"].as_str().unwrap(),
        expected_request_hash: pin,
    }
}
struct InterruptAt(&'static str);
impl SchemaFinalizationCheckpointV1 for InterruptAt {
    fn checkpoint(&mut self, point: &str) -> Result<()> {
        if point == self.0 {
            return Err(
                hepta_paper_service::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
                    code: "test_interruption".into(),
                    details: json!({}),
                    state_recoverability_fatal: false,
                    state_recoverability_deferred: false,
                    retryable: false,
                },
            );
        }
        Ok(())
    }
}
fn requests(f: &Fixture) -> Value {
    f.oracle
        .borrow_mut()
        .call(json!({"operation":"finalization-requests","root":f.root}))["value"]
        .clone()
}
fn journal(f: &Fixture) -> Value {
    serde_json::from_slice(&fs::read(f.journal()).unwrap()).unwrap()
}

#[test]
fn lost_finalization_response_reopens_exact_intent_without_reinstalling() {
    let f = Fixture::new(false);
    let mut authority = f.authority();
    let mut pending = prepared(&f, &mut authority);
    let request = pending.request().clone();
    let pin = pending.request_hash().to_owned();
    let plan = journal(&f)["plan"].clone();
    let before = plan_bytes(&f, &plan);
    assert_eq!(journal(&f)["finalizationProgress"]["request"], request);
    assert!(journal(&f)["finalizationProgress"]["receipt"].is_null());
    assert!(requests(&f).as_array().unwrap().is_empty());
    assert!(
        finalize_prepared_schema_transition_v1(
            &mut pending,
            &mut authority,
            &mut || Ok(BASE),
            &mut InterruptAt("after_finalization_rpc_before_publication")
        )
        .is_err()
    );
    assert_eq!(requests(&f), json!([request.clone()]));
    assert!(journal(&f)["finalizationProgress"]["receipt"].is_null());
    drop(pending);
    // Even after the original lease expires, recovery can only ask for the
    // exact old completion; the returned signature must prove timely finalize.
    let mut resumed =
        resume_schema_transition_finalization_v1(selection(&f, &plan, &pin), &authority).unwrap();
    let result = finalize_prepared_schema_transition_v1(
        &mut resumed,
        &mut authority,
        &mut || Ok(BASE + 60_001),
        &mut NoSchemaFinalizationCheckpointV1,
    )
    .unwrap();
    assert_eq!(result.finalize_request, request);
    assert_eq!(requests(&f), json!([request.clone(), request.clone()]));
    assert_eq!(plan_bytes(&f, &plan), before);
    drop(resumed);
    let mut replay =
        resume_schema_transition_finalization_v1(selection(&f, &plan, &pin), &authority).unwrap();
    let again = finalize_prepared_schema_transition_v1(
        &mut replay,
        &mut authority,
        &mut || panic!("recorded completion must not sample a new clock"),
        &mut NoSchemaFinalizationCheckpointV1,
    )
    .unwrap();
    assert_eq!(again.finalization.value(), result.finalization.value());
    assert_eq!(requests(&f).as_array().unwrap().len(), 2);
    assert_eq!(plan_bytes(&f, &plan), before);
    assert!(
        !selection(&f, &plan, &pin)
            .runtime_root
            .join("autonomous-research/online-schema-transition/FINAL.json")
            .exists()
    );
}

#[test]
fn published_finalization_error_preserves_receipt_and_fences_installation_reentry() {
    let f = Fixture::new(false);
    let mut authority = f.authority();
    let mut pending = prepared(&f, &mut authority);
    let pin = pending.request_hash().to_owned();
    let plan = journal(&f)["plan"].clone();
    assert!(
        finalize_prepared_schema_transition_v1(
            &mut pending,
            &mut authority,
            &mut || Ok(BASE),
            &mut InterruptAt("after_finalization_receipt_publication")
        )
        .is_err()
    );
    let recorded = fs::read(f.journal()).unwrap();
    assert!(!journal(&f)["finalizationProgress"]["receipt"].is_null());
    drop(pending);
    assert_eq!(
        fail(resume_schema_installation_v1(
            resume_installation(&f, &plan),
            &authority,
            &mut || Ok(BASE),
            &mut NoSchemaInstallationCheckpointV1
        )),
        "autonomous_research_online_schema_transition_finalization_recovery_required"
    );
    assert_eq!(fs::read(f.journal()).unwrap(), recorded);
    let mut resumed =
        resume_schema_transition_finalization_v1(selection(&f, &plan, &pin), &authority).unwrap();
    finalize_prepared_schema_transition_v1(
        &mut resumed,
        &mut authority,
        &mut || panic!("historical completion"),
        &mut NoSchemaFinalizationCheckpointV1,
    )
    .unwrap();
    assert_eq!(requests(&f).as_array().unwrap().len(), 1);
    assert_eq!(fs::read(f.journal()).unwrap(), recorded);
}

#[test]
fn finalization_recovery_rejects_unselected_or_changed_journal_without_rpc() {
    let f = Fixture::new(false);
    let mut authority = f.authority();
    let pending = prepared(&f, &mut authority);
    let pin = pending.request_hash().to_owned();
    let plan = journal(&f)["plan"].clone();
    let original = fs::read(f.journal()).unwrap();
    let original_databases = plan_bytes(&f, &plan);
    let absent = f.root.join("absent-finalization-runtime");
    for malformed in ["", "sha256:short", "not-a-pin"] {
        let mut options = selection(&f, &plan, malformed);
        options.runtime_root = &absent;
        assert_eq!(
            fail(resume_schema_transition_finalization_v1(
                options, &authority
            )),
            "autonomous_research_online_schema_transition_finalization_pin_invalid"
        );
    }
    assert!(!absent.exists());
    drop(pending);
    for mutation in 0..6 {
        let mut value: Value = serde_json::from_slice(&original).unwrap();
        match mutation {
            0 => {
                value
                    .as_object_mut()
                    .unwrap()
                    .remove("finalizationProgress");
            }
            1 => {
                value["finalizationProgress"]["unknown"] = true.into();
            }
            2 => {
                value["finalizationProgress"]["request"]["completedAt"] =
                    "2026-09-16T12:00:00.001Z".into();
            }
            3 => {
                value["finalizationProgress"]["receipt"] = json!({"signature":"forged"});
            }
            4 => {
                value["finalizationProgress"]
                    .as_object_mut()
                    .unwrap()
                    .remove("receipt");
            }
            _ => {
                value["installations"].as_array_mut().unwrap().pop();
            }
        }
        fs::write(f.journal(), serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(
            resume_schema_transition_finalization_v1(selection(&f, &plan, &pin), &authority)
                .is_err(),
            "case {mutation}"
        );
        assert!(requests(&f).as_array().unwrap().is_empty());
    }
    fs::write(f.journal(), &original).unwrap();
    let resumed =
        resume_schema_transition_finalization_v1(selection(&f, &plan, &pin), &authority).unwrap();
    drop(resumed);
    assert_eq!(fs::read(f.journal()).unwrap(), original);
    assert_eq!(plan_bytes(&f, &plan), original_databases);
}

#[test]
fn finalization_intent_survives_real_process_exit_before_rpc() {
    let f = Fixture::new(false);
    let mut authority = f.authority();
    let pending = prepared(&f, &mut authority);
    let pin = pending.request_hash().to_owned();
    let plan = journal(&f)["plan"].clone();
    let input = f.root.join("finalization-child.json");
    fs::write(
        &input,
        serde_json::to_vec(&json!({"setup":f.setup,"plan":plan,"pin":pin})).unwrap(),
    )
    .unwrap();
    drop(pending);
    let before = fs::read(f.journal()).unwrap();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "finalization_recovery::finalization_crash_child",
            "--nocapture",
        ])
        .env("HEPTA_FINALIZATION_CRASH_INPUT", &input)
        .output()
        .unwrap();
    assert_eq!(
        child.status.code(),
        Some(93),
        "{}",
        String::from_utf8_lossy(&child.stderr)
    );
    assert_eq!(fs::read(f.journal()).unwrap(), before);
    assert!(requests(&f).as_array().unwrap().is_empty());
    let mut resumed =
        resume_schema_transition_finalization_v1(selection(&f, &plan, &pin), &authority).unwrap();
    finalize_prepared_schema_transition_v1(
        &mut resumed,
        &mut authority,
        &mut || Ok(BASE),
        &mut NoSchemaFinalizationCheckpointV1,
    )
    .unwrap();
    assert_eq!(requests(&f).as_array().unwrap().len(), 1);
}

#[test]
fn finalization_crash_child() {
    let Ok(path) = std::env::var("HEPTA_FINALIZATION_CRASH_INPUT") else {
        return;
    };
    struct NoRpc;
    impl MutationAuthorityTransportV1 for NoRpc {
        fn invoke(&mut self, _: &Value) -> Result<Value> {
            panic!("exit must precede RPC")
        }
    }
    struct Exit;
    impl SchemaFinalizationCheckpointV1 for Exit {
        fn checkpoint(&mut self, point: &str) -> Result<()> {
            assert_eq!(point, "before_finalization_rpc");
            std::process::exit(93)
        }
    }
    let value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let setup = &value["setup"];
    let plan = &value["plan"];
    let mut authority = PinnedMutationAuthorityV1::load(
        Path::new(setup["configurationPath"].as_str().unwrap()),
        setup["configurationFileHash"].as_str().unwrap(),
        NoRpc,
    )
    .unwrap();
    let mut prepared = resume_schema_transition_finalization_v1(
        ResumeSchemaFinalizationOptionsV1 {
            runtime_root: Path::new(setup["runtimeRoot"].as_str().unwrap()),
            state_database_manifest: &setup["stateDatabaseManifest"],
            writer_manifest: &setup["writerManifest"],
            expected_transition_id: plan["transitionId"].as_str().unwrap(),
            expected_plan_hash: plan["planHash"].as_str().unwrap(),
            expected_request_hash: value["pin"].as_str().unwrap(),
        },
        &authority,
    )
    .unwrap();
    finalize_prepared_schema_transition_v1(
        &mut prepared,
        &mut authority,
        &mut || Ok(BASE),
        &mut Exit,
    )
    .unwrap();
    panic!("must exit before dispatch")
}

#[test]
fn finalization_recovery_rejects_business_row_changes_and_retains_tampered_bytes() {
    let f = Fixture::new(false);
    let mut authority = f.authority();
    let pending = prepared(&f, &mut authority);
    let pin = pending.request_hash().to_owned();
    let plan = journal(&f)["plan"].clone();
    drop(pending);
    let row = plan["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["databaseRole"] == "native-store")
        .unwrap();
    let database_path = Path::new(f.setup["runtimeRoot"].as_str().unwrap())
        .join(row["sourceRelativePath"].as_str().unwrap());
    let database = rusqlite::Connection::open(&database_path).unwrap();
    database
        .execute(
            "UPDATE fixture_anchor SET value='changed-after-installation' WHERE id='fixture'",
            [],
        )
        .unwrap();
    drop(database);
    let changed = fs::read(&database_path).unwrap();
    let old_journal = fs::read(f.journal()).unwrap();
    assert!(
        resume_schema_transition_finalization_v1(selection(&f, &plan, &pin), &authority).is_err()
    );
    assert_eq!(fs::read(&database_path).unwrap(), changed);
    assert_eq!(fs::read(f.journal()).unwrap(), old_journal);
    assert!(requests(&f).as_array().unwrap().is_empty());
}

fn finalized(
    f: &Fixture,
    authority: &mut PinnedMutationAuthorityV1<Signing>,
) -> (PreparedSchemaFinalizationV1, Value, String) {
    let mut pending = prepared(f, authority);
    let finalization_pin = pending.request_hash().to_owned();
    let plan = journal(f)["plan"].clone();
    finalize_prepared_schema_transition_v1(
        &mut pending,
        authority,
        &mut || Ok(BASE),
        &mut NoSchemaFinalizationCheckpointV1,
    )
    .unwrap();
    (pending, plan, finalization_pin)
}
fn prepared_observation(
    f: &Fixture,
    authority: &mut PinnedMutationAuthorityV1<Signing>,
) -> (PreparedSchemaObservationV1, Value, String, String) {
    let (finalized, plan, finalization_pin) = finalized(f, authority);
    let pending =
        prepare_schema_transition_observation_v1(finalized, authority, &mut || Ok(BASE)).unwrap();
    let observation_pin = pending.request_hash().to_owned();
    (pending, plan, finalization_pin, observation_pin)
}
fn observation_selection<'a>(
    f: &'a Fixture,
    plan: &'a Value,
    finalization_pin: &'a str,
    observation_pin: &'a str,
) -> ResumeSchemaObservationOptionsV1<'a> {
    ResumeSchemaObservationOptionsV1 {
        runtime_root: Path::new(f.setup["runtimeRoot"].as_str().unwrap()),
        state_database_manifest: &f.setup["stateDatabaseManifest"],
        writer_manifest: &f.setup["writerManifest"],
        expected_transition_id: plan["transitionId"].as_str().unwrap(),
        expected_plan_hash: plan["planHash"].as_str().unwrap(),
        expected_finalization_request_hash: finalization_pin,
        expected_observation_request_hash: observation_pin,
    }
}
struct ObservationInterruptAt(&'static str);
impl SchemaObservationCheckpointV1 for ObservationInterruptAt {
    fn checkpoint(&mut self, point: &str) -> Result<()> {
        if point == self.0 {
            return Err(
                hepta_paper_service::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
                    code: "test_observation_interruption".into(),
                    details: json!({}),
                    state_recoverability_fatal: false,
                    state_recoverability_deferred: false,
                    retryable: false,
                },
            );
        }
        Ok(())
    }
}
fn observation_requests(f: &Fixture) -> Value {
    f.oracle
        .borrow_mut()
        .call(json!({"operation":"observation-requests","root":f.root}))["value"]
        .clone()
}

#[test]
fn lost_observation_response_reopens_exact_intent_without_reinstalling() {
    let f = Fixture::new(false);
    let mut authority = f.authority();
    let (mut pending, plan, finalization_pin, observation_pin) =
        prepared_observation(&f, &mut authority);
    let request = pending.request().clone();
    let before = plan_bytes(&f, &plan);
    assert_eq!(journal(&f)["observationProgress"]["request"], request);
    assert!(journal(&f)["observationProgress"]["receipt"].is_null());
    assert!(observation_requests(&f).as_array().unwrap().is_empty());
    assert!(
        observe_prepared_schema_transition_v1(
            &mut pending,
            &mut authority,
            &mut || Ok(BASE),
            &mut ObservationInterruptAt("after_observation_rpc_before_publication"),
        )
        .is_err()
    );
    assert_eq!(observation_requests(&f), json!([request.clone()]));
    assert!(journal(&f)["observationProgress"]["receipt"].is_null());
    drop(pending);
    let mut resumed = resume_schema_transition_observation_v1(
        observation_selection(&f, &plan, &finalization_pin, &observation_pin),
        &authority,
    )
    .unwrap();
    let result = observe_prepared_schema_transition_v1(
        &mut resumed,
        &mut authority,
        &mut || Ok(BASE + 1),
        &mut NoSchemaObservationCheckpointV1,
    )
    .unwrap();
    assert_eq!(result.observe_request, request);
    assert_eq!(observation_requests(&f), json!([request.clone(), request]));
    assert_eq!(plan_bytes(&f, &plan), before);
    drop(resumed);
    let mut replay = resume_schema_transition_observation_v1(
        observation_selection(&f, &plan, &finalization_pin, &observation_pin),
        &authority,
    )
    .unwrap();
    let again = observe_prepared_schema_transition_v1(
        &mut replay,
        &mut authority,
        &mut || panic!("recorded observation must not sample a new clock"),
        &mut NoSchemaObservationCheckpointV1,
    )
    .unwrap();
    assert_eq!(again.observation.value(), result.observation.value());
    assert_eq!(observation_requests(&f).as_array().unwrap().len(), 2);
    assert_eq!(plan_bytes(&f, &plan), before);
}

#[test]
fn published_observation_error_preserves_receipt_and_fences_new_intent() {
    let f = Fixture::new(false);
    let mut authority = f.authority();
    let (mut pending, plan, finalization_pin, observation_pin) =
        prepared_observation(&f, &mut authority);
    assert!(
        observe_prepared_schema_transition_v1(
            &mut pending,
            &mut authority,
            &mut || Ok(BASE),
            &mut ObservationInterruptAt("after_observation_receipt_publication"),
        )
        .is_err()
    );
    let recorded = fs::read(f.journal()).unwrap();
    assert!(!journal(&f)["observationProgress"]["receipt"].is_null());
    drop(pending);
    let finalized = resume_schema_transition_finalization_v1(
        selection(&f, &plan, &finalization_pin),
        &authority,
    )
    .unwrap();
    assert_eq!(
        fail(prepare_schema_transition_observation_v1(
            finalized,
            &authority,
            &mut || Ok(BASE),
        )),
        "autonomous_research_online_schema_transition_observation_recovery_required"
    );
    assert_eq!(fs::read(f.journal()).unwrap(), recorded);
    let mut resumed = resume_schema_transition_observation_v1(
        observation_selection(&f, &plan, &finalization_pin, &observation_pin),
        &authority,
    )
    .unwrap();
    observe_prepared_schema_transition_v1(
        &mut resumed,
        &mut authority,
        &mut || panic!("historical observation"),
        &mut NoSchemaObservationCheckpointV1,
    )
    .unwrap();
    assert_eq!(observation_requests(&f).as_array().unwrap().len(), 1);
    assert_eq!(fs::read(f.journal()).unwrap(), recorded);
}

#[test]
fn observation_recovery_rejects_unselected_or_changed_journal_without_rpc() {
    let f = Fixture::new(false);
    let mut authority = f.authority();
    let (pending, plan, finalization_pin, observation_pin) =
        prepared_observation(&f, &mut authority);
    let original = fs::read(f.journal()).unwrap();
    let original_databases = plan_bytes(&f, &plan);
    let absent = f.root.join("absent-observation-runtime");
    for malformed in ["", "sha256:short", "not-a-pin"] {
        let mut options = observation_selection(&f, &plan, &finalization_pin, malformed);
        options.runtime_root = &absent;
        assert_eq!(
            fail(resume_schema_transition_observation_v1(options, &authority)),
            "autonomous_research_online_schema_transition_observation_pin_invalid"
        );
    }
    assert!(!absent.exists());
    drop(pending);
    for mutation in 0..7 {
        let mut value: Value = serde_json::from_slice(&original).unwrap();
        match mutation {
            0 => {
                value.as_object_mut().unwrap().remove("observationProgress");
            }
            1 => value["observationProgress"]["unknown"] = true.into(),
            2 => {
                value["observationProgress"]["request"]["nonce"] =
                    "schema-transition-observation:substituted".into();
            }
            3 => value["observationProgress"]["receipt"] = json!({"signature":"forged"}),
            4 => {
                value["observationProgress"]
                    .as_object_mut()
                    .unwrap()
                    .remove("receipt");
            }
            5 => value["finalizationProgress"]["receipt"] = json!({"signature":"forged"}),
            _ => {
                value["installations"].as_array_mut().unwrap().pop();
            }
        }
        fs::write(f.journal(), serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(
            resume_schema_transition_observation_v1(
                observation_selection(&f, &plan, &finalization_pin, &observation_pin),
                &authority,
            )
            .is_err(),
            "case {mutation}"
        );
        assert!(observation_requests(&f).as_array().unwrap().is_empty());
    }
    fs::write(f.journal(), &original).unwrap();
    let resumed = resume_schema_transition_observation_v1(
        observation_selection(&f, &plan, &finalization_pin, &observation_pin),
        &authority,
    )
    .unwrap();
    drop(resumed);
    assert_eq!(fs::read(f.journal()).unwrap(), original);
    assert_eq!(plan_bytes(&f, &plan), original_databases);
}

#[test]
fn observation_intent_survives_real_process_exit_before_rpc() {
    let f = Fixture::new(false);
    let mut authority = f.authority();
    let (pending, plan, finalization_pin, observation_pin) =
        prepared_observation(&f, &mut authority);
    let input = f.root.join("observation-child.json");
    fs::write(
        &input,
        serde_json::to_vec(&json!({"setup":f.setup,"plan":plan,
            "finalizationPin":finalization_pin,"observationPin":observation_pin}))
        .unwrap(),
    )
    .unwrap();
    drop(pending);
    let before = fs::read(f.journal()).unwrap();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "finalization_recovery::observation_crash_child",
            "--nocapture",
        ])
        .env("HEPTA_OBSERVATION_CRASH_INPUT", &input)
        .output()
        .unwrap();
    assert_eq!(
        child.status.code(),
        Some(94),
        "{}",
        String::from_utf8_lossy(&child.stderr)
    );
    assert_eq!(fs::read(f.journal()).unwrap(), before);
    assert!(observation_requests(&f).as_array().unwrap().is_empty());
    let mut resumed = resume_schema_transition_observation_v1(
        observation_selection(&f, &plan, &finalization_pin, &observation_pin),
        &authority,
    )
    .unwrap();
    observe_prepared_schema_transition_v1(
        &mut resumed,
        &mut authority,
        &mut || Ok(BASE),
        &mut NoSchemaObservationCheckpointV1,
    )
    .unwrap();
    assert_eq!(observation_requests(&f).as_array().unwrap().len(), 1);
}

#[test]
fn observation_crash_child() {
    let Ok(path) = std::env::var("HEPTA_OBSERVATION_CRASH_INPUT") else {
        return;
    };
    struct NoRpc;
    impl MutationAuthorityTransportV1 for NoRpc {
        fn invoke(&mut self, _: &Value) -> Result<Value> {
            panic!("exit must precede RPC")
        }
    }
    struct Exit;
    impl SchemaObservationCheckpointV1 for Exit {
        fn checkpoint(&mut self, point: &str) -> Result<()> {
            assert_eq!(point, "before_observation_rpc");
            std::process::exit(94)
        }
    }
    let value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let setup = &value["setup"];
    let plan = &value["plan"];
    let mut authority = PinnedMutationAuthorityV1::load(
        Path::new(setup["configurationPath"].as_str().unwrap()),
        setup["configurationFileHash"].as_str().unwrap(),
        NoRpc,
    )
    .unwrap();
    let mut prepared = resume_schema_transition_observation_v1(
        ResumeSchemaObservationOptionsV1 {
            runtime_root: Path::new(setup["runtimeRoot"].as_str().unwrap()),
            state_database_manifest: &setup["stateDatabaseManifest"],
            writer_manifest: &setup["writerManifest"],
            expected_transition_id: plan["transitionId"].as_str().unwrap(),
            expected_plan_hash: plan["planHash"].as_str().unwrap(),
            expected_finalization_request_hash: value["finalizationPin"].as_str().unwrap(),
            expected_observation_request_hash: value["observationPin"].as_str().unwrap(),
        },
        &authority,
    )
    .unwrap();
    observe_prepared_schema_transition_v1(
        &mut prepared,
        &mut authority,
        &mut || Ok(BASE),
        &mut Exit,
    )
    .unwrap();
    panic!("must exit before dispatch")
}

#[test]
fn observation_recovery_rejects_business_row_changes_and_retains_tampered_bytes() {
    let f = Fixture::new(false);
    let mut authority = f.authority();
    let (pending, plan, finalization_pin, observation_pin) =
        prepared_observation(&f, &mut authority);
    drop(pending);
    let row = plan["instances"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["databaseRole"] == "native-store")
        .unwrap();
    let database_path = Path::new(f.setup["runtimeRoot"].as_str().unwrap())
        .join(row["sourceRelativePath"].as_str().unwrap());
    let database = rusqlite::Connection::open(&database_path).unwrap();
    database
        .execute(
            "UPDATE fixture_anchor SET value='changed-before-observation' WHERE id='fixture'",
            [],
        )
        .unwrap();
    drop(database);
    let changed = fs::read(&database_path).unwrap();
    let old_journal = fs::read(f.journal()).unwrap();
    assert!(
        resume_schema_transition_observation_v1(
            observation_selection(&f, &plan, &finalization_pin, &observation_pin),
            &authority,
        )
        .is_err()
    );
    assert_eq!(fs::read(&database_path).unwrap(), changed);
    assert_eq!(fs::read(f.journal()).unwrap(), old_journal);
    assert!(observation_requests(&f).as_array().unwrap().is_empty());
}

#[test]
fn observation_intent_requires_a_recorded_finalization_receipt() {
    let f = Fixture::new(false);
    let mut authority = f.authority();
    let pending = prepared(&f, &mut authority);
    assert_eq!(
        fail(prepare_schema_transition_observation_v1(
            pending,
            &authority,
            &mut || Ok(BASE),
        )),
        "autonomous_research_online_schema_transition_finalization_recovery_required"
    );
    assert!(journal(&f).get("observationProgress").is_none());
    assert!(observation_requests(&f).as_array().unwrap().is_empty());
}

#[test]
fn durable_observation_publishes_final_without_manual_record_assembly() {
    use hepta_paper_service::online_schema_execution::maintenance::normalization::finalization::publication::NoSchemaFinalReceiptCheckpointV1;
    let f = Fixture::new(false);
    let mut authority = f.authority();
    let (mut pending, plan, finalization_pin, observation_pin) =
        prepared_observation(&f, &mut authority);
    observe_prepared_schema_transition_v1(
        &mut pending,
        &mut authority,
        &mut || Ok(BASE),
        &mut NoSchemaObservationCheckpointV1,
    )
    .unwrap();
    let published = publish_prepared_schema_transition_observation_v1(
        pending,
        &authority,
        PublishPreparedSchemaObservationOptionsV1 {
            state_database_manifest: &f.setup["stateDatabaseManifest"],
            writer_manifest: &f.setup["writerManifest"],
            expected_plan_hash: plan["planHash"].as_str().unwrap(),
            expected_previous_final_receipt_sha256: None,
        },
        &mut NoSchemaFinalReceiptCheckpointV1,
    )
    .unwrap();
    assert!(!published.already_published);
    assert!(!published.replaced_existing_receipt);
    let value: Value = serde_json::from_slice(&fs::read(&published.receipt_path).unwrap()).unwrap();
    let durable = journal(&f);
    assert_eq!(
        value["status"],
        "autonomous_research_online_schema_transition_ready"
    );
    assert_eq!(value["planHash"], plan["planHash"]);
    assert_eq!(
        value["finalizeRequest"],
        durable["finalizationProgress"]["request"]
    );
    assert_eq!(
        value["finalization"],
        durable["finalizationProgress"]["receipt"]
    );
    assert_eq!(
        value["observeRequest"],
        durable["observationProgress"]["request"]
    );
    assert_eq!(
        value["observation"],
        durable["observationProgress"]["receipt"]
    );
    assert_eq!(observation_requests(&f).as_array().unwrap().len(), 1);

    let resumed = resume_schema_transition_observation_v1(
        observation_selection(&f, &plan, &finalization_pin, &observation_pin),
        &authority,
    )
    .unwrap();
    let replay = publish_prepared_schema_transition_observation_v1(
        resumed,
        &authority,
        PublishPreparedSchemaObservationOptionsV1 {
            state_database_manifest: &f.setup["stateDatabaseManifest"],
            writer_manifest: &f.setup["writerManifest"],
            expected_plan_hash: plan["planHash"].as_str().unwrap(),
            expected_previous_final_receipt_sha256: None,
        },
        &mut NoSchemaFinalReceiptCheckpointV1,
    )
    .unwrap();
    assert!(replay.already_published);
    assert_eq!(replay.file_sha256, published.file_sha256);
    assert_eq!(observation_requests(&f).as_array().unwrap().len(), 1);
}

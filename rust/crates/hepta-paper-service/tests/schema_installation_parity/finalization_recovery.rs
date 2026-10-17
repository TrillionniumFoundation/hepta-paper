//! Actual planner/reservation/normalization/installation owner chain followed by
//! durable finalization. Peers are explicit Node protocol/signature fixtures,
//! not accepted installed principals or a production cutover.
use super::*;
use hepta_paper_service::online_schema_execution::maintenance::normalization::finalization::{
    publication::NoSchemaFinalReceiptCheckpointV1,
    recovery::{restart::*, *},
};

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

fn native_predecessor_process(f: &Fixture) -> (PathBuf, String) {
    native_predecessor_process_for(
        f,
        &f.setup["configurationPath"],
        &f.setup["configurationFileHash"],
    )
}
fn native_predecessor_process_for(
    f: &Fixture,
    configuration_path: &Value,
    configuration_hash: &Value,
) -> (PathBuf, String) {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;
    let digest = |bytes: &[u8]| format!("sha256:{}", hex::encode(Sha256::digest(bytes)));
    let command = f.root.join("native-predecessor-no-rpc");
    fs::copy("/usr/bin/false", &command).unwrap();
    fs::set_permissions(&command, fs::Permissions::from_mode(0o700)).unwrap();
    let path = f.root.join(format!(
        "native-predecessor-process-{}.json",
        configuration_hash
            .as_str()
            .unwrap()
            .strip_prefix("sha256:")
            .unwrap()
    ));
    let value = json!({
        "version": 1,
        "kind": "AutonomousResearchOnlineMutationAuthorityProcessConfiguration",
        "authorityConfigurationPath": configuration_path,
        "authorityConfigurationSha256": configuration_hash,
        "commandPath": command,
        "commandSha256": digest(&fs::read(&command).unwrap()),
        "fixedArguments": [],
        "timeoutMs": 1000
    });
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(&path, &bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    (path, digest(&bytes))
}
fn native_predecessor_command(
    f: &Fixture,
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
        f.setup["runtimeRoot"].as_str().unwrap(),
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
fn native_finalized_journal_is_an_exact_successor_predecessor() {
    let f = Fixture::new(false);
    let mut authority = f.authority();
    let (mut pending, plan, _, _) = prepared_observation(&f, &mut authority);
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
    let control = published.receipt_path.parent().unwrap();
    let names = fs::read_dir(control)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    for required in [
        "FINAL.json",
        "NORMALIZATION.native.v1.json",
        ".publication-lock-FINAL.json",
        ".publication-lock-NORMALIZATION.native.v1.json",
    ] {
        assert!(names.contains(required));
    }
    assert!(names.iter().any(|name| name.starts_with("preimages-")));
    assert!(names.iter().any(|name| name.starts_with(".pending-")));
    let (process, process_hash) = native_predecessor_process(&f);
    let database_before = plan_bytes(&f, &plan);
    let journal_before = fs::read(f.journal()).unwrap();
    let final_before = fs::read(&published.receipt_path).unwrap();

    let unpinned = native_predecessor_command(&f, &process, &process_hash, None)
        .output()
        .unwrap();
    assert_eq!(unpinned.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&unpinned.stderr).contains("existing_control_requires_recovery")
    );

    let accepted =
        native_predecessor_command(&f, &process, &process_hash, Some(&published.file_sha256))
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
    assert_eq!(
        report["previousFinalReceiptFileSha256"],
        published.file_sha256
    );
    assert_eq!(plan_bytes(&f, &plan), database_before);
    assert_eq!(fs::read(f.journal()).unwrap(), journal_before);
    assert_eq!(fs::read(&published.receipt_path).unwrap(), final_before);

    let unknown = control.join("unowned-control-entry");
    fs::write(&unknown, b"not-owned-by-publication").unwrap();
    let rejected =
        native_predecessor_command(&f, &process, &process_hash, Some(&published.file_sha256))
            .output()
            .unwrap();
    assert_eq!(rejected.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&rejected.stderr)
            .contains("previous_finalized_control_shape_invalid")
    );
    fs::remove_file(unknown).unwrap();

    let mut changed: Value = serde_json::from_slice(&journal_before).unwrap();
    changed["request"]["requestedAt"] = json!("2026-09-16T12:00:00.001Z");
    fs::write(f.journal(), serde_json::to_vec(&changed).unwrap()).unwrap();
    let rejected =
        native_predecessor_command(&f, &process, &process_hash, Some(&published.file_sha256))
            .output()
            .unwrap();
    assert_eq!(rejected.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("previous_native_journal_invalid"));
    fs::write(f.journal(), journal_before).unwrap();
    assert_eq!(plan_bytes(&f, &plan), database_before);
    assert_eq!(fs::read(&published.receipt_path).unwrap(), final_before);
}

fn restart_selection<'a>(
    f: &'a Fixture,
    plan: &'a Value,
    finalization_pin: &'a str,
    observation_pin: &'a str,
) -> ResumeSchemaTargetRestartOptionsV2<'a> {
    ResumeSchemaTargetRestartOptionsV2 {
        runtime_root: Path::new(f.setup["runtimeRoot"].as_str().unwrap()),
        state_database_manifest: &f.setup["stateDatabaseManifest"],
        writer_manifest: &f.setup["writerManifest"],
        expected_transition_id: plan["transitionId"].as_str().unwrap(),
        expected_plan_hash: plan["planHash"].as_str().unwrap(),
        expected_finalization_request_hash: finalization_pin,
        expected_target_observation_request_hash: observation_pin,
    }
}

struct RestartInterruptAt(&'static str);
impl SchemaTargetRestartCheckpointV2 for RestartInterruptAt {
    fn checkpoint(&mut self, point: &str) -> Result<()> {
        if point == self.0 {
            return Err(
                hepta_paper_service::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
                    code: "test_restart_observation_interruption".into(),
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

#[test]
fn v2_restart_observation_retries_exact_intent_and_publishes_final_receipt() {
    let f = Fixture::new_version(false, 2);
    let mut source = f.authority();
    let (finalized, plan, finalization_pin) = finalized(&f, &mut source);
    assert_eq!(plan["version"], 2);
    let mut pending =
        prepare_schema_target_configuration_restart_v2(finalized, &source, &mut || Ok(BASE))
            .unwrap();
    let request = pending.request().clone();
    let observation_pin = pending.request_hash().to_owned();
    let target_hash = pending.target_authority_configuration_hash().to_owned();
    assert_eq!(
        target_hash,
        f.setup["targetAuthorityConfigurationHash"]
            .as_str()
            .unwrap()
    );
    assert_eq!(
        journal(&f)["targetRestartObservationProgress"]["request"],
        request
    );
    assert!(journal(&f)["targetRestartObservationProgress"]["receipt"].is_null());
    assert!(observation_requests(&f).as_array().unwrap().is_empty());
    let before = plan_bytes(&f, &plan);
    let mut target = f.target_authority();
    assert!(
        observe_restarted_schema_transition_v2(
            &mut pending,
            &source,
            &mut target,
            &mut || Ok(BASE + 1),
            &mut RestartInterruptAt("after_target_observation_before_publication"),
        )
        .is_err()
    );
    assert_eq!(observation_requests(&f), json!([request.clone()]));
    assert!(journal(&f)["targetRestartObservationProgress"]["receipt"].is_null());
    drop(pending);

    let mut resumed = resume_schema_target_configuration_restart_v2(
        restart_selection(&f, &plan, &finalization_pin, &observation_pin),
        &source,
    )
    .unwrap();
    let result = observe_restarted_schema_transition_v2(
        &mut resumed,
        &source,
        &mut target,
        &mut || Ok(BASE + 2),
        &mut NoSchemaTargetRestartCheckpointV2,
    )
    .unwrap();
    assert_eq!(result.observe_request, request);
    assert_eq!(
        result.observation.value()["authorityConfigurationActivated"],
        true
    );
    assert_eq!(
        observation_requests(&f),
        json!([request.clone(), request.clone()])
    );
    assert_eq!(plan_bytes(&f, &plan), before);
    drop(resumed);

    let mut replay = resume_schema_target_configuration_restart_v2(
        restart_selection(&f, &plan, &finalization_pin, &observation_pin),
        &source,
    )
    .unwrap();
    let again = observe_restarted_schema_transition_v2(
        &mut replay,
        &source,
        &mut target,
        &mut || panic!("recorded target observation cannot sample a clock"),
        &mut NoSchemaTargetRestartCheckpointV2,
    )
    .unwrap();
    assert_eq!(again.observation.value(), result.observation.value());
    assert_eq!(observation_requests(&f).as_array().unwrap().len(), 2);

    let published = publish_restarted_schema_transition_observation_v2(
        replay,
        &source,
        &target,
        PublishPreparedSchemaTargetRestartOptionsV2 {
            state_database_manifest: &f.setup["stateDatabaseManifest"],
            writer_manifest: &f.setup["writerManifest"],
            expected_plan_hash: plan["planHash"].as_str().unwrap(),
            expected_previous_final_receipt_sha256: None,
        },
        &mut NoSchemaFinalReceiptCheckpointV1,
    )
    .unwrap();
    let value: Value = serde_json::from_slice(&fs::read(&published.receipt_path).unwrap()).unwrap();
    assert_eq!(value["version"], 2);
    assert_eq!(
        value["transitionMode"],
        "pristine-finalized-writer-manifest-rebind"
    );
    assert_eq!(
        value["sourceWriterManifestHash"],
        plan["sourceWriterManifestHash"]
    );
    assert_eq!(value["authorityConfigurationActivated"], true);
    assert_eq!(&value["observation"], result.observation.value());
    assert_eq!(
        value["postPristineRuntimeStateHash"],
        request["postPristineRuntimeStateHash"]
    );
    assert_eq!(plan_bytes(&f, &plan), before);

    // The finalized journal retains the historical source public configuration,
    // while an ordinary successor must use the current target public verifier.
    // Neither is the private daemon-configuration hash signed by finalization.
    let (process, process_hash) = native_predecessor_process_for(
        &f,
        &f.setup["targetConfigurationPath"],
        &f.setup["targetConfigurationFileHash"],
    );
    let (historical_process, historical_process_hash) = native_predecessor_process(&f);
    let missing =
        native_predecessor_command(&f, &process, &process_hash, Some(&published.file_sha256))
            .output()
            .unwrap();
    assert_eq!(missing.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&missing.stderr)
            .contains("historical_source_authority_process_pin_required")
    );
    let mut inspect =
        native_predecessor_command(&f, &process, &process_hash, Some(&published.file_sha256));
    inspect.args([
        "--historical-source-authority-process-config",
        historical_process.to_str().unwrap(),
        "--historical-source-authority-process-config-sha256",
        &historical_process_hash,
    ]);
    let mut args = inspect
        .get_args()
        .map(|arg| arg.to_owned())
        .collect::<Vec<_>>();
    let action = args.iter().position(|arg| arg == "--action").unwrap();
    args[action + 1] = "inspect-pristine".into();
    inspect = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"));
    inspect.args(&args);
    let inspected = inspect.output().unwrap();
    assert_eq!(
        inspected.status.code(),
        Some(1),
        "{} {}",
        String::from_utf8_lossy(&inspected.stdout),
        String::from_utf8_lossy(&inspected.stderr)
    );
    assert!(
        String::from_utf8_lossy(&inspected.stderr).contains("pristine_schema_rebind_not_required")
    );
    assert_eq!(plan_bytes(&f, &plan), before);
    // The target already uses the current writer manifest. Its ordinary next
    // plan needs no new rebind or pristine hash, but must verify the v2 history.
    let mut successor =
        native_predecessor_command(&f, &process, &process_hash, Some(&published.file_sha256));
    successor.args([
        "--historical-source-authority-process-config",
        historical_process.to_str().unwrap(),
        "--historical-source-authority-process-config-sha256",
        &historical_process_hash,
    ]);
    let accepted = successor.output().unwrap();
    assert_eq!(
        accepted.status.code(),
        Some(0),
        "{} {}",
        String::from_utf8_lossy(&accepted.stdout),
        String::from_utf8_lossy(&accepted.stderr)
    );
    let report: Value = serde_json::from_slice(&accepted.stdout).unwrap();
    assert_eq!(report["controlPredecessorVerified"], true);
    assert_eq!(report["executionAuthority"], false);
    assert_eq!(plan_bytes(&f, &plan), before);
    let journal_before = fs::read(f.journal()).unwrap();
    let final_before = fs::read(&published.receipt_path).unwrap();
    for (path, pin, expected) in [
        (
            &process,
            process_hash.as_str(),
            "previous_native_journal_invalid",
        ),
        (
            &historical_process,
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "configuration",
        ),
    ] {
        let mut rejected =
            native_predecessor_command(&f, &process, &process_hash, Some(&published.file_sha256));
        rejected.args([
            "--historical-source-authority-process-config",
            path.to_str().unwrap(),
            "--historical-source-authority-process-config-sha256",
            pin,
        ]);
        let rejected = rejected.output().unwrap();
        assert_eq!(rejected.status.code(), Some(1));
        assert!(
            String::from_utf8_lossy(&rejected.stderr).contains(expected),
            "{}",
            String::from_utf8_lossy(&rejected.stderr)
        );
    }
    // Independently pinning a substituted historical process still cannot bind
    // different source configuration bytes to the finalized journal.
    let source_path = Path::new(f.setup["configurationPath"].as_str().unwrap());
    let original_source = fs::read(source_path).unwrap();
    let mut changed: Value = serde_json::from_slice(&original_source).unwrap();
    changed["scopeId"] = json!("substituted-scope");
    let bytes = serde_json::to_vec(&changed).unwrap();
    fs::write(source_path, &bytes).unwrap();
    use sha2::{Digest, Sha256};
    let digest = |bytes: &[u8]| format!("sha256:{}", hex::encode(Sha256::digest(bytes)));
    let (substituted_process, substituted_pin) =
        native_predecessor_process_for(&f, &f.setup["configurationPath"], &json!(digest(&bytes)));
    let mut rejected =
        native_predecessor_command(&f, &process, &process_hash, Some(&published.file_sha256));
    rejected.args([
        "--historical-source-authority-process-config",
        substituted_process.to_str().unwrap(),
        "--historical-source-authority-process-config-sha256",
        &substituted_pin,
    ]);
    let rejected = rejected.output().unwrap();
    assert_eq!(rejected.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("previous_native_journal_invalid"));
    fs::write(source_path, original_source).unwrap();

    let target_path = Path::new(f.setup["targetConfigurationPath"].as_str().unwrap());
    let original_target = fs::read(target_path).unwrap();
    for field in ["writerManifestHash", "scopeId", "keyId"] {
        let mut changed: Value = serde_json::from_slice(&original_target).unwrap();
        changed[field] = if field == "writerManifestHash" {
            json!("sha256:0000000000000000000000000000000000000000000000000000000000000000")
        } else {
            json!("substituted-identity")
        };
        let bytes = serde_json::to_vec(&changed).unwrap();
        fs::write(target_path, &bytes).unwrap();
        let (wrong_process, wrong_pin) = native_predecessor_process_for(
            &f,
            &f.setup["targetConfigurationPath"],
            &json!(digest(&bytes)),
        );
        let mut rejected = native_predecessor_command(
            &f,
            &wrong_process,
            &wrong_pin,
            Some(&published.file_sha256),
        );
        rejected.args([
            "--historical-source-authority-process-config",
            historical_process.to_str().unwrap(),
            "--historical-source-authority-process-config-sha256",
            &historical_process_hash,
        ]);
        let rejected = rejected.output().unwrap();
        assert_eq!(rejected.status.code(), Some(1), "field {field}");
        fs::write(target_path, &original_target).unwrap();
    }
    let mut changed: Value = serde_json::from_slice(&journal_before).unwrap();
    changed["authorityConfigurationHash"] =
        json!("sha256:0000000000000000000000000000000000000000000000000000000000000000");
    fs::write(f.journal(), serde_json::to_vec(&changed).unwrap()).unwrap();
    let mut rejected =
        native_predecessor_command(&f, &process, &process_hash, Some(&published.file_sha256));
    rejected.args([
        "--historical-source-authority-process-config",
        historical_process.to_str().unwrap(),
        "--historical-source-authority-process-config-sha256",
        &historical_process_hash,
    ]);
    let rejected = rejected.output().unwrap();
    assert_eq!(rejected.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("previous_native_journal_invalid"));
    fs::write(f.journal(), &journal_before).unwrap();
    assert_eq!(plan_bytes(&f, &plan), before);
    assert_eq!(fs::read(f.journal()).unwrap(), journal_before);
    assert_eq!(fs::read(&published.receipt_path).unwrap(), final_before);
}

#[test]
fn v2_restart_refuses_source_or_substituted_target_before_observation_rpc() {
    let f = Fixture::new_version(false, 2);
    let mut source = f.authority();
    let (finalized, plan, finalization_pin) = finalized(&f, &mut source);
    let mut pending =
        prepare_schema_target_configuration_restart_v2(finalized, &source, &mut || Ok(BASE))
            .unwrap();
    let observation_pin = pending.request_hash().to_owned();
    let before = fs::read(f.journal()).unwrap();
    let mut wrong_target = f.authority();
    assert_eq!(
        fail(observe_restarted_schema_transition_v2(
            &mut pending,
            &source,
            &mut wrong_target,
            &mut || Ok(BASE + 1),
            &mut NoSchemaTargetRestartCheckpointV2,
        )),
        "autonomous_research_pristine_schema_rebind_target_configuration_mismatch"
    );
    assert!(observation_requests(&f).as_array().unwrap().is_empty());
    assert_eq!(fs::read(f.journal()).unwrap(), before);
    drop(pending);

    let wrong_pin = format!("sha256:{}", "0".repeat(64));
    assert_eq!(
        fail(resume_schema_target_configuration_restart_v2(
            restart_selection(&f, &plan, &finalization_pin, &wrong_pin),
            &source,
        )),
        "autonomous_research_pristine_schema_rebind_restart_request_changed"
    );
    assert!(observation_requests(&f).as_array().unwrap().is_empty());

    let resumed = resume_schema_target_configuration_restart_v2(
        restart_selection(&f, &plan, &finalization_pin, &observation_pin),
        &source,
    )
    .unwrap();
    assert_eq!(resumed.request_hash(), observation_pin);
    assert_eq!(fs::read(f.journal()).unwrap(), before);
}

#[test]
fn v2_restart_intent_survives_real_process_exit_before_target_rpc() {
    let f = Fixture::new_version(false, 2);
    let mut source = f.authority();
    let (finalized, plan, finalization_pin) = finalized(&f, &mut source);
    let pending =
        prepare_schema_target_configuration_restart_v2(finalized, &source, &mut || Ok(BASE))
            .unwrap();
    let observation_pin = pending.request_hash().to_owned();
    let input = f.root.join("restart-observation-child.json");
    fs::write(
        &input,
        serde_json::to_vec(&json!({
            "setup": f.setup,
            "plan": plan,
            "finalizationPin": finalization_pin,
            "observationPin": observation_pin,
        }))
        .unwrap(),
    )
    .unwrap();
    drop(pending);
    let before = fs::read(f.journal()).unwrap();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "finalization_recovery::v2_restart_crash_child",
            "--nocapture",
        ])
        .env("HEPTA_RESTART_CRASH_INPUT", &input)
        .output()
        .unwrap();
    assert_eq!(
        child.status.code(),
        Some(95),
        "{}",
        String::from_utf8_lossy(&child.stderr)
    );
    assert_eq!(fs::read(f.journal()).unwrap(), before);
    assert!(observation_requests(&f).as_array().unwrap().is_empty());

    let mut resumed = resume_schema_target_configuration_restart_v2(
        restart_selection(&f, &plan, &finalization_pin, &observation_pin),
        &source,
    )
    .unwrap();
    let mut target = f.target_authority();
    observe_restarted_schema_transition_v2(
        &mut resumed,
        &source,
        &mut target,
        &mut || Ok(BASE + 1),
        &mut NoSchemaTargetRestartCheckpointV2,
    )
    .unwrap();
    assert_eq!(observation_requests(&f).as_array().unwrap().len(), 1);
}

#[test]
fn v2_restart_crash_child() {
    let Ok(path) = std::env::var("HEPTA_RESTART_CRASH_INPUT") else {
        return;
    };
    struct NoRpc;
    impl MutationAuthorityTransportV1 for NoRpc {
        fn invoke(&mut self, _: &Value) -> Result<Value> {
            panic!("process exit must precede target authority RPC")
        }
    }
    struct Exit;
    impl SchemaTargetRestartCheckpointV2 for Exit {
        fn checkpoint(&mut self, point: &str) -> Result<()> {
            assert_eq!(point, "before_target_configuration_observation");
            std::process::exit(95)
        }
    }
    let value: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let setup = &value["setup"];
    let plan = &value["plan"];
    let source = PinnedMutationAuthorityV1::load(
        Path::new(setup["configurationPath"].as_str().unwrap()),
        setup["configurationFileHash"].as_str().unwrap(),
        NoRpc,
    )
    .unwrap();
    let mut target = PinnedMutationAuthorityV1::load(
        Path::new(setup["targetConfigurationPath"].as_str().unwrap()),
        setup["targetConfigurationFileHash"].as_str().unwrap(),
        NoRpc,
    )
    .unwrap();
    let mut prepared = resume_schema_target_configuration_restart_v2(
        ResumeSchemaTargetRestartOptionsV2 {
            runtime_root: Path::new(setup["runtimeRoot"].as_str().unwrap()),
            state_database_manifest: &setup["stateDatabaseManifest"],
            writer_manifest: &setup["writerManifest"],
            expected_transition_id: plan["transitionId"].as_str().unwrap(),
            expected_plan_hash: plan["planHash"].as_str().unwrap(),
            expected_finalization_request_hash: value["finalizationPin"].as_str().unwrap(),
            expected_target_observation_request_hash: value["observationPin"].as_str().unwrap(),
        },
        &source,
    )
    .unwrap();
    observe_restarted_schema_transition_v2(
        &mut prepared,
        &source,
        &mut target,
        &mut || Ok(BASE),
        &mut Exit,
    )
    .unwrap();
    panic!("must exit before target authority RPC")
}

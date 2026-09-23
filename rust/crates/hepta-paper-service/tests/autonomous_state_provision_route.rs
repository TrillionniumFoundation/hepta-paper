use hepta_paper_service::autonomous_state_provision::{
    execute_autonomous_state_provisioning_v1, inspect_autonomous_state_provisioning_v1,
    parse_autonomous_state_provisioning_arguments,
};
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

fn fixture() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let parent = std::env::temp_dir().join(format!(
        "hepta-state-provision-test-{}-{}",
        std::process::id(),
        NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&parent).unwrap();
    let machine = parent.join("machine.json");
    let topic = parent.join("topic.json");
    let dataset = parent.join("dataset");
    fs::write(&machine, serde_json::to_vec(&json!({"version":2,"machineProducerProfileHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})).unwrap()).unwrap();
    fs::write(&topic, serde_json::to_vec(&json!({"version":1,"providerConfigurationHash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})).unwrap()).unwrap();
    fs::create_dir(&dataset).unwrap();
    (parent, machine, topic, dataset)
}

#[test]
fn parser_rejects_execute_without_confirmation_or_plan() {
    let args = vec![
        "--runtime-root".into(),
        "/tmp/new-runtime".into(),
        "--machine-intake-config".into(),
        "/tmp/machine.json".into(),
        "--topic-producer-profile".into(),
        "/tmp/topic.json".into(),
        "--dataset-root".into(),
        "/tmp/dataset".into(),
        "--action".into(),
        "execute".into(),
    ];
    let error = parse_autonomous_state_provisioning_arguments(&args).unwrap_err();
    assert!(error.to_string().contains("confirmation_or_plan_id"));
}

#[test]
fn plan_is_source_bound_and_execute_is_fail_closed() {
    let (parent, machine, topic, dataset) = fixture();
    let runtime = dataset.parent().unwrap().join("runtime");
    let options = parse_autonomous_state_provisioning_arguments(&[
        "--runtime-root".into(),
        runtime.to_string_lossy().into_owned(),
        "--machine-intake-config".into(),
        machine.to_string_lossy().into_owned(),
        "--topic-producer-profile".into(),
        topic.to_string_lossy().into_owned(),
        "--dataset-root".into(),
        dataset.to_string_lossy().into_owned(),
    ])
    .unwrap()
    .unwrap();
    let plan = inspect_autonomous_state_provisioning_v1(&options).unwrap();
    assert_eq!(plan["databaseRoles"].as_array().unwrap().len(), 10);
    assert_eq!(plan["ready"], true);
    let mut execute = options.clone();
    execute.action = "execute".into();
    execute.execute = true;
    execute.expected_plan_id = Some(plan["provisioningPlanId"].as_str().unwrap().into());
    let receipt = execute_autonomous_state_provisioning_v1(&execute).unwrap();
    assert_eq!(receipt["ready"], false);
    assert_eq!(receipt["externalAuthorityInvoked"], false);
    assert!(!runtime.exists());
    fs::remove_dir_all(parent).unwrap();
}

fn options_for(
    parent: &std::path::Path,
    machine: &std::path::Path,
    topic: &std::path::Path,
    dataset: &std::path::Path,
) -> hepta_paper_service::autonomous_state_provision::AutonomousStateProvisioningOptions {
    parse_autonomous_state_provisioning_arguments(&[
        "--runtime-root".into(),
        parent.join("runtime").to_string_lossy().into_owned(),
        "--machine-intake-config".into(),
        machine.to_string_lossy().into_owned(),
        "--topic-producer-profile".into(),
        topic.to_string_lossy().into_owned(),
        "--dataset-root".into(),
        dataset.to_string_lossy().into_owned(),
    ])
    .unwrap()
    .unwrap()
}

#[test]
fn plan_id_binds_the_returned_payload_once_and_matches_the_actual_node_hash() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let (parent, machine, topic, dataset) = fixture();
    let options = options_for(&parent, &machine, &topic, &dataset);
    let plan = inspect_autonomous_state_provisioning_v1(&options).unwrap();
    let mut unsigned = plan.clone();
    let expected = unsigned
        .as_object_mut()
        .unwrap()
        .remove("provisioningPlanId")
        .unwrap();
    let hash = hepta_legacy_compatibility::production_hash_record_v1(
        "AutonomousResearchStateBusinessSchemaProvisioningPlan",
        &unsigned,
    )
    .unwrap();
    assert_eq!(expected.as_str(), Some(hash.as_str()));
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut node = Command::new("node").current_dir(&root)
        .args(["--input-type=module", "-e", "import fs from 'node:fs'; import { hashRecord } from './workflow-kernel/record-hash.mjs'; const p=JSON.parse(fs.readFileSync(0,'utf8')); console.log(hashRecord('AutonomousResearchStateBusinessSchemaProvisioningPlan',p));"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    node.stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&unsigned).unwrap())
        .unwrap();
    let output = node.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        hash.as_str()
    );
    assert!(!parent.join("runtime").exists());
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn equivalent_target_spellings_have_one_plan_identity_and_existing_roots_are_not_adopted() {
    let (parent, machine, topic, dataset) = fixture();
    let mut options = options_for(&parent, &machine, &topic, &dataset);
    let canonical = inspect_autonomous_state_provisioning_v1(&options).unwrap();
    options.runtime_root = parent.join("not-created/../runtime");
    let alternate = inspect_autonomous_state_provisioning_v1(&options).unwrap();
    assert_eq!(canonical, alternate);
    assert!(!parent.join("not-created").exists());
    fs::create_dir(parent.join("runtime")).unwrap();
    fs::write(parent.join("runtime/keep"), b"existing data").unwrap();
    assert!(inspect_autonomous_state_provisioning_v1(&options).is_err());
    assert_eq!(
        fs::read(parent.join("runtime/keep")).unwrap(),
        b"existing data"
    );
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn changed_source_bytes_invalidate_a_plan_without_creating_runtime_state() {
    let (parent, machine, topic, dataset) = fixture();
    let mut options = options_for(&parent, &machine, &topic, &dataset);
    let original = inspect_autonomous_state_provisioning_v1(&options).unwrap();
    let mut changed: serde_json::Value =
        serde_json::from_slice(&fs::read(&machine).unwrap()).unwrap();
    changed["changedInput"] = json!(true);
    fs::write(&machine, serde_json::to_vec(&changed).unwrap()).unwrap();
    let current = inspect_autonomous_state_provisioning_v1(&options).unwrap();
    assert_ne!(
        original["provisioningPlanId"],
        current["provisioningPlanId"]
    );
    options.action = "execute".into();
    options.execute = true;
    options.expected_plan_id = Some(original["provisioningPlanId"].as_str().unwrap().into());
    assert!(
        execute_autonomous_state_provisioning_v1(&options)
            .unwrap_err()
            .to_string()
            .contains("plan_mismatch")
    );
    assert!(!parent.join("runtime").exists());
    fs::remove_dir_all(parent).unwrap();
}

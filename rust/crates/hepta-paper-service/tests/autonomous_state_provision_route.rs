use hepta_paper_service::autonomous_state_provision::{
    execute_autonomous_state_provisioning_v1, inspect_autonomous_state_provisioning_v1,
    parse_autonomous_state_provisioning_arguments,
};
use serde_json::json;
use std::{fs, path::PathBuf};

fn fixture() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let parent =
        std::env::temp_dir().join(format!("hepta-state-provision-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&parent);
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

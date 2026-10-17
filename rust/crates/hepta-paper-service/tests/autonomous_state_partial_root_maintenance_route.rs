use hepta_paper_service::autonomous_state_partial_root_maintenance::{
    inspect_autonomous_state_partial_root_maintenance_v1,
    parse_autonomous_state_partial_root_maintenance_arguments,
};
use serde_json::json;
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

fn fixture() -> (PathBuf, PathBuf, PathBuf, PathBuf, PathBuf, PathBuf) {
    let root =
        std::env::temp_dir().join(format!("hepta-partial-root-native-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let runtime = root.join("runtime");
    let rescue = root.join("rescue");
    fs::create_dir(&runtime).unwrap();
    fs::create_dir(&rescue).unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(&rescue, fs::Permissions::from_mode(0o700)).unwrap();
    let manifest_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join("paper-core/config/autonomous-research-state-databases.v1.json");
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    for row in manifest["databases"].as_array().unwrap() {
        let role = row["role"].as_str().unwrap();
        if matches!(
            role,
            "external-qualification"
                | "native-store"
                | "resident-instance"
                | "submission-handoff"
                | "supervisor-state"
        ) {
            let path = runtime.join(row["relativePath"].as_str().unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
            fs::write(path, b"bounded fixture").unwrap();
        }
    }
    let machine = root.join("machine.json");
    let topic = root.join("topic.json");
    fs::write(&machine, br#"{"version":2,"machineProducerProfileHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#).unwrap();
    fs::write(&topic, br#"{"version":1,"providerConfigurationHash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}"#).unwrap();
    let dataset = root.join("dataset");
    fs::create_dir(&dataset).unwrap();
    fs::set_permissions(&dataset, fs::Permissions::from_mode(0o700)).unwrap();
    let receipt = root.join("quiescence.json");
    fs::write(
        &receipt,
        serde_json::to_vec(&json!({
            "version":1,
            "kind":"AutonomousResearchStatePartialRootWriterQuiescenceReceipt",
            "status":"autonomous_research_state_partial_root_writers_quiesced",
            "runtimeRoot":runtime,
            "databaseScopeHash":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "writerManifestHash":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "quiescedWriterServices":[
                "autonomous-research-state-backup-renew.service",
                "autonomous-research-supervisor.service",
                "autonomous-submission-dispatcher.service",
                "strict-full-auto-acceptance.service"
            ],
            "activeWriterProcessIds":[],
            "serviceInspectionComplete":true,
            "processInspectionComplete":true,
            "observedAt":"2026-01-01T00:00:00.000Z",
            "expiresAt":"2999-01-01T00:00:00.000Z",
            "receiptHash":"sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        }))
        .unwrap(),
    )
    .unwrap();
    (root, runtime, rescue, machine, topic, dataset)
}

#[test]
fn parser_requires_double_gated_execute() {
    let args = vec![
        "--rescue-root".into(),
        "/tmp/rescue".into(),
        "--writer-quiescence-receipt".into(),
        "/tmp/quiescence.json".into(),
        "--machine-intake-config".into(),
        "/tmp/machine.json".into(),
        "--topic-producer-profile".into(),
        "/tmp/topic.json".into(),
        "--dataset-root".into(),
        "/tmp/dataset".into(),
        "--runtime-reproducibility-maximum-attempts-per-epoch".into(),
        "2".into(),
        "--runtime-reproducibility-maximum-cost-usd-per-epoch".into(),
        "1".into(),
        "--action".into(),
        "execute".into(),
    ];
    assert!(
        parse_autonomous_state_partial_root_maintenance_arguments(&args)
            .unwrap_err()
            .to_string()
            .contains("confirmation_required")
    );
}

#[test]
fn invalid_or_incomplete_sqlite_observation_fails_closed_without_mutation() {
    let (root, runtime, rescue, machine, topic, dataset) = fixture();
    let receipt = root.join("quiescence.json");
    let args = vec![
        "--runtime-root".into(),
        runtime.to_string_lossy().into_owned(),
        "--rescue-root".into(),
        rescue.to_string_lossy().into_owned(),
        "--writer-quiescence-receipt".into(),
        receipt.to_string_lossy().into_owned(),
        "--machine-intake-config".into(),
        machine.to_string_lossy().into_owned(),
        "--topic-producer-profile".into(),
        topic.to_string_lossy().into_owned(),
        "--dataset-root".into(),
        dataset.to_string_lossy().into_owned(),
        "--runtime-reproducibility-maximum-attempts-per-epoch".into(),
        "2".into(),
        "--runtime-reproducibility-maximum-cost-usd-per-epoch".into(),
        "1".into(),
    ];
    let options = parse_autonomous_state_partial_root_maintenance_arguments(&args)
        .unwrap()
        .unwrap();
    // The fixture deliberately contains non-SQLite bytes. The native boundary
    // must reject the observation before issuing any plan identity or write.
    let error = inspect_autonomous_state_partial_root_maintenance_v1(&options)
        .expect_err("non-SQLite source must not become a ready plan");
    println!("preflight error: {error}");
    assert!(!error.to_string().is_empty());
    assert!(fs::read_dir(&rescue).unwrap().next().is_none());
    fs::remove_dir_all(root).unwrap();
}

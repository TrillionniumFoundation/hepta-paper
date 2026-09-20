use ed25519_dalek::{
    SigningKey,
    pkcs8::{EncodePublicKey, spki::der::pem::LineEnding},
};
use hepta_paper_service::local_golden_dataset::{
    LOCAL_GOLDEN_DATASET_PROVISIONING_BLOCKER, LocalGoldenDatasetProvisioningOptions,
    execute_local_golden_dataset_provisioning_v1, inspect_local_golden_dataset_provisioning_v1,
    local_golden_dataset_provisioning_usage, parse_local_golden_dataset_provisioning_arguments,
};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    process::Command,
};

fn temp_root() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "hepta-local-golden-rust-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&path).unwrap();
    path
}

fn write_json(path: &PathBuf, value: &Value, mode: u32) {
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(value).unwrap()),
    )
    .unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn fixture() -> (PathBuf, LocalGoldenDatasetProvisioningOptions) {
    let root = temp_root();
    let runtime_root = root.join("runtime");
    let control_root = root.join("control");
    let dataset_root = root.join("dataset");
    let secrets = root.join("secrets");
    for path in [&runtime_root, &control_root, &dataset_root, &secrets] {
        fs::create_dir(path).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let train = dataset_root.join("train.csv");
    fs::write(&train, b"feature,label\n1,0\n").unwrap();
    fs::set_permissions(&train, fs::Permissions::from_mode(0o444)).unwrap();
    fs::set_permissions(&dataset_root, fs::Permissions::from_mode(0o555)).unwrap();

    let dataset_name = "local-golden-ml";
    let split = json!({
        "version":1,"kind":"LocalGoldenDatasetSplitAssignments","datasetName":dataset_name,
        "entries":[{"path":"train.csv","split":"train"}]
    });
    write_json(&control_root.join("split.json"), &split, 0o600);
    let seeds: Vec<i64> = (1000..1032).collect();
    let cells: Vec<Value> = seeds
        .iter()
        .map(|seed| {
            json!({
                "seed":seed,"repetition":1,"cases":(0..8).map(|index| json!({
                    "caseId":format!("sha256:{:064x}", seed + index),
                    "input":{"primary":seed + index,"secondary":(index as f64)/10.0},
                    "ablationInput":{"secondary":(index as f64)/10.0},"referenceResponse":0,
                    "oracle":{"label":index%2,"robustLabel":index%2}
                })).collect::<Vec<_>>()
            })
        })
        .collect();
    let harness = json!({
        "version":1,"kind":"OperatorAuthorizedDatasetBenchmarkHarness","benchmarkId":dataset_name,
        "benchmarkFamily":"ml_algorithm_benchmark","seedSchedule":seeds,"minimumRepetitions":1,"cells":cells
    });
    write_json(&control_root.join("harness.json"), &harness, 0o600);
    let analysis = json!({"version":1,"kind":"AcademicAnalysisProtocol","benchmarkId":dataset_name,"benchmarkFamily":"ml_algorithm_benchmark"});
    write_json(&control_root.join("analysis.json"), &analysis, 0o600);
    let semantics = json!({
        "version":1,"kind":"OperatorDatasetResearchSemantics","population":"Rows in the frozen local golden training dataset.",
        "variables":["feature","label"],"intervention":"Apply the bounded candidate classifier.",
        "comparator":"Compare with baseline and ablation classifiers.","estimands":["paired hidden-evaluation metric difference"],
        "datasetConstraints":["local operator fixture; no external dataset-owner qualification"],"eligibleSplits":["train"]
    });
    write_json(&control_root.join("semantics.json"), &semantics, 0o600);
    let trust = json!({
        "version":1,"kind":"AuthorityTrustStore","authorityScope":"local-operator-golden-runtime-only-v1",
        "evidenceClass":"local_operator_dataset_authority","academicPromotionEligible":false,"externalTrustClaimed":false,
        "keyPurpose":"local-golden-dataset-authority-v1","keys":[{"keyId":"local-key","subjectId":"local",
        "algorithm":"ed25519","publicKeyPem":SigningKey::from_bytes(&[7_u8; 32]).verifying_key().to_public_key_pem(LineEnding::LF).unwrap(),"roles":["local_golden_dataset_operator"],
        "keyPurpose":"local-golden-dataset-authority-v1","authorityScope":"local-operator-golden-runtime-only-v1",
        "academicPromotionEligible":false,"externalTrustClaimed":false,"status":"active"}]
    });
    write_json(&control_root.join("trust.json"), &trust, 0o600);
    let private_key = secrets.join("private.pem");
    fs::write(&private_key, b"PRIVATE KEY NEVER READ BY PLAN").unwrap();
    fs::set_permissions(&private_key, fs::Permissions::from_mode(0o600)).unwrap();
    let options = LocalGoldenDatasetProvisioningOptions {
        action: "plan".into(),
        execute: false,
        expected_plan_id: None,
        runtime_root: runtime_root.clone(),
        control_root: control_root.clone(),
        isolation_id: "golden-isolation".into(),
        dataset_name: dataset_name.into(),
        dataset_root,
        dataset_license_id: "LicenseRef-Local-Golden-Test-Terms".into(),
        split_assignments: control_root.join("split.json"),
        harness_definition: control_root.join("harness.json"),
        analysis_protocol: control_root.join("analysis.json"),
        research_semantics: control_root.join("semantics.json"),
        authority_trust_store: control_root.join("trust.json"),
        authority_private_key: private_key,
        authority_key_id: "local-key".into(),
        signed_at: "2026-08-08T07:59:00.000Z".into(),
        expires_at: "2026-08-15T07:59:00.000Z".into(),
        mount_output: control_root.join("mounts.json"),
    };
    (root, options)
}

#[test]
fn parser_help_and_execute_boundaries_match_node_contract() {
    assert_eq!(
        local_golden_dataset_provisioning_usage()
            .lines()
            .next()
            .unwrap(),
        "Usage: local-golden-dataset-provision --action plan|execute [options]"
    );
    let result =
        parse_local_golden_dataset_provisioning_arguments(&["--action".into(), "execute".into()]);
    assert!(result.is_err());
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let node = Command::new("node")
        .current_dir(&root)
        .args([
            "paper-core/bin/local-golden-dataset-provision.mjs",
            "--help",
        ])
        .output()
        .unwrap();
    assert!(node.status.success());
    let rust = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["local-golden-dataset-provision", "--help"])
        .output()
        .unwrap();
    assert!(rust.status.success());
    assert_eq!(rust.stdout, node.stdout);
}

#[test]
fn plan_is_source_bound_and_execute_fails_closed_without_writes() {
    let (root, options) = fixture();
    let plan = inspect_local_golden_dataset_provisioning_v1(&options).unwrap();
    assert_eq!(plan["ready"], true);
    assert_eq!(plan["externalActionPerformed"], false);
    assert!(!options.mount_output.exists());
    let mut execute = options.clone();
    execute.action = "execute".into();
    execute.execute = true;
    execute.expected_plan_id = plan["localGoldenDatasetProvisioningPlanId"]
        .as_str()
        .map(str::to_owned);
    let report = execute_local_golden_dataset_provisioning_v1(&execute).unwrap();
    assert_eq!(report["ready"], false);
    assert_eq!(
        report["blockers"],
        json!([LOCAL_GOLDEN_DATASET_PROVISIONING_BLOCKER])
    );
    assert_eq!(report["privateKeyRead"], false);
    assert!(!options.mount_output.exists());
    fs::set_permissions(&options.dataset_root, fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn production_root_and_symlink_inputs_are_rejected() {
    let (root, mut options) = fixture();
    options.runtime_root = PathBuf::from("/var/lib/hepta-paper/runtime");
    assert!(
        inspect_local_golden_dataset_provisioning_v1(&options)
            .unwrap_err()
            .0
            .contains("protected_root_forbidden")
    );
    let (root2, options2) = fixture();
    let link = root2.join("dataset-link");
    symlink(&options2.dataset_root, &link).unwrap();
    let mut linked = options2;
    linked.dataset_root = link;
    assert!(inspect_local_golden_dataset_provisioning_v1(&linked).is_err());
    fs::set_permissions(root.join("dataset"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_dir_all(root).unwrap();
    fs::set_permissions(root2.join("dataset"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_dir_all(root2).unwrap();
}

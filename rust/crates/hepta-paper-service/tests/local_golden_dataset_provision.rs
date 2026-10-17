use ed25519_dalek::{
    SigningKey,
    pkcs8::{EncodePublicKey, spki::der::pem::LineEnding},
};
use hepta_paper_service::local_golden_dataset::{
    LOCAL_GOLDEN_DATASET_PROVISIONING_BLOCKER, LocalGoldenDatasetProvisioningOptions,
    execute_local_golden_dataset_provisioning_v1, inspect_local_golden_dataset_provisioning_v1,
    local_golden_dataset_provisioning_usage, parse_local_golden_dataset_provisioning_arguments,
};
use hepta_paper_service::sqlite_mutation_coordinator::clock;
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

fn cli_arguments(options: &LocalGoldenDatasetProvisioningOptions) -> Vec<String> {
    vec![
        "--action".into(),
        "plan".into(),
        "--runtime-root".into(),
        options.runtime_root.to_string_lossy().into_owned(),
        "--control-root".into(),
        options.control_root.to_string_lossy().into_owned(),
        "--isolation-id".into(),
        options.isolation_id.clone(),
        "--dataset-name".into(),
        options.dataset_name.clone(),
        "--dataset-root".into(),
        options.dataset_root.to_string_lossy().into_owned(),
        "--dataset-license-id".into(),
        options.dataset_license_id.clone(),
        "--split-assignments".into(),
        options.split_assignments.to_string_lossy().into_owned(),
        "--harness-definition".into(),
        options.harness_definition.to_string_lossy().into_owned(),
        "--analysis-protocol".into(),
        options.analysis_protocol.to_string_lossy().into_owned(),
        "--research-semantics".into(),
        options.research_semantics.to_string_lossy().into_owned(),
        "--authority-trust-store".into(),
        options.authority_trust_store.to_string_lossy().into_owned(),
        "--authority-private-key".into(),
        options.authority_private_key.to_string_lossy().into_owned(),
        "--authority-key-id".into(),
        options.authority_key_id.clone(),
        "--signed-at".into(),
        options.signed_at.clone(),
        "--expires-at".into(),
        options.expires_at.clone(),
        "--mount-output".into(),
        options.mount_output.to_string_lossy().into_owned(),
    ]
}

fn node_plan(options: &LocalGoldenDatasetProvisioningOptions) -> Value {
    let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let output = Command::new("node")
        .current_dir(&repository_root)
        .args(["paper-core/bin/local-golden-dataset-provision.mjs"])
        .args(cli_arguments(options))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Node plan failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
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
    let analysis = json!({
        "version":1,"kind":"AcademicAnalysisProtocol",
        "protocolId":"ml_algorithm_benchmark:paired-cell-bootstrap-holm:v1",
        "benchmarkId":dataset_name,"benchmarkFamily":"ml_algorithm_benchmark",
        "requiredMetrics":["mean_score","standard_error","baseline_gap","robustness_gap"],
        "metricSpecs":{
            "baseline_gap":{"unit":"ratio","direction":"maximize","minimum":-1,"maximum":1},
            "mean_score":{"unit":"ratio","direction":"maximize","minimum":0,"maximum":1},
            "robustness_gap":{"unit":"ratio","direction":"maximize","minimum":-1,"maximum":1},
            "standard_error":{"unit":"ratio","direction":"minimize","minimum":0,"maximum":1}
        },
        "inferenceProfile":{
            "version":1,"kind":"AcademicAnalysisInferenceProfile",
            "profileId":"ml_algorithm_benchmark:seed-repetition-cell:v1",
            "benchmarkFamily":"ml_algorithm_benchmark","independentUnit":"seed-repetition-cell-v1",
            "withinSeedAggregation":"none-each-complete-seed-repetition-cell-v1",
            "bootstrapUnit":"seed-repetition-cell-difference-v1","signFlipUnit":"seed-repetition-cell-difference-v1",
            "powerCountingUnit":"independent-seed-repetition-cell-v1",
            "balanceRequirements":{"completeArms":"treatment-baseline-ablation-per-seed-repetition-v1","repetitionSchedule":"identical-repetition-index-set-across-seeds-v1","clusterSize":"equal-complete-repetition-count-per-seed-v1","failureMode":"fail-closed-v1"},
            "assumptions":{"independentAcross":"predeclared-seed-repetition-cells-v1","dependenceWithinSeed":"no-additional-within-seed-cluster-independence-claim-v1","resamplingExchangeability":"exchangeable-complete-seed-repetition-cells-v1","signSymmetry":"seed-repetition-cell-differences-v1"}
        },
        "inferenceProfileHash":"sha256:7a07d5ef5c38b14249ee0ebc0a29994b060ef99f51f4ea5eec5176936b394a17",
        "estimator":{"method":"paired-arithmetic-mean-difference-v1","treatmentArm":"treatment","controlArms":["baseline","ablation"],"directionNormalization":"positive-is-treatment-improvement-v1"},
        "assumptions":{"distribution":"paired-sign-symmetry-and-bootstrap-exchangeability-v1","exchangeability":"operator-predeclared-fixed-cell-schedule-v1","independenceScope":"paired-schedule-unit-only-no-independent-machine-claim-v1","finiteObservationsRequired":true,"symmetryDiagnostic":"sample-skewness-bound-v1","maximumAbsoluteSkewness":2},
        "pairedUnit":"seed-and-repetition-v1",
        "missingness":{"method":"fail-closed-complete-paired-cells-v1","maximumMissingFraction":0},
        "outlierSensitivity":{"method":"winsorized-and-leave-one-out-sensitivity-v1","lowerQuantile":0.05,"upperQuantile":0.95,"requireWinsorizedDirection":true,"requireLeaveOneOutDirection":true},
        "uncertainty":{"method":"deterministic-paired-percentile-bootstrap-v1","confidenceLevel":0.95,"resamples":4096,"seed":1597463007,"testMethod":"deterministic-paired-sign-flip-v1","testDraws":8192},
        "hypotheses":[
            {"hypothesisId":"primary-treatment-vs-baseline","metric":"mean_score","comparator":"baseline","alternative":"greater","minimumEffect":0,"acceptanceRequired":true},
            {"hypothesisId":"primary-treatment-vs-ablation","metric":"mean_score","comparator":"ablation","alternative":"greater","minimumEffect":0,"acceptanceRequired":true}
        ],
        "multiplicity":{"method":"holm-bonferroni-v1","familyAlpha":0.05,"family":"all-predeclared-hypotheses-v1"},
        "power":{"method":"predeclared-standardized-effect-normal-design-v1","targetPower":0.8,"minimumStandardizedEffect":0.5,"requiredPairedObservations":32},
        "numericValidation":{"residual":{"method":"authority-recomputed-aggregate-residual-v1","maximumAbsoluteResidual":1e-10},"convergence":{"method":"not-observable-no-candidate-convergence-claim-v1","candidateClaimAccepted":false},"condition":{"method":"not-observable-no-candidate-condition-claim-v1","candidateClaimAccepted":false},"tolerances":{"absolute":1e-10,"relative":1e-9},"propertyOracle":{"method":"repository-hidden-oracle-event-recomputation-v1","required":true},"agentAggregatesAccepted":false},
        "assuranceScope":"operator-signed-preregistered-analysis-protocol-v1"
    });
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
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
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
        signed_at: clock::iso(now - 60_000).unwrap(),
        expires_at: clock::iso(now + 7 * 24 * 60 * 60 * 1_000).unwrap(),
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
    let node = node_plan(&options);
    assert_eq!(plan["ready"], true);
    assert_eq!(plan, node);
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

#[test]
fn node_repository_workspace_and_environment_roots_are_protected() {
    let (root, mut options) = fixture();
    let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    options.runtime_root = repository_root.join("runtime");
    assert!(
        inspect_local_golden_dataset_provisioning_v1(&options)
            .unwrap_err()
            .0
            .contains("protected_root_forbidden:runtimeRoot")
    );
    fs::set_permissions(root.join("dataset"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_dir_all(root).unwrap();

    for variable in [
        "HEPTA_PAPER_ASSET_ROOT",
        "HEPTA_PAPER_RUNTIME_ROOT",
        "HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT",
    ] {
        let (root, mut options) = fixture();
        let blocked = root.join("environment-protected");
        options.dataset_root = blocked.join("dataset");
        let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
            .args(["local-golden-dataset-provision"])
            .args(cli_arguments(&options))
            .env(variable, &blocked)
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "{variable} must block dataset root"
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("protected_root_forbidden:datasetRoot"),
            "{variable} stderr: {stderr}"
        );
        let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let node = Command::new("node")
            .current_dir(&repository_root)
            .args(["paper-core/bin/local-golden-dataset-provision.mjs"])
            .args(cli_arguments(&options))
            .env(variable, &blocked)
            .output()
            .unwrap();
        assert!(
            !node.status.success(),
            "Node {variable} must block dataset root"
        );
        let node_stderr = String::from_utf8_lossy(&node.stderr);
        assert!(
            node_stderr.contains("protected_root_forbidden:datasetRoot"),
            "Node {variable} stderr: {node_stderr}"
        );
        fs::set_permissions(root.join("dataset"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn analysis_protocol_must_be_canonical_and_authority_window_must_be_current() {
    let (root, options) = fixture();
    write_json(
        &options.analysis_protocol,
        &json!({
            "version": 1,
            "kind": "AcademicAnalysisProtocol",
            "benchmarkId": options.dataset_name,
            "benchmarkFamily": "ml_algorithm_benchmark"
        }),
        0o600,
    );
    assert!(
        inspect_local_golden_dataset_provisioning_v1(&options)
            .unwrap_err()
            .0
            .contains("analysis_protocol_shape_invalid")
    );

    let (root2, mut stale) = fixture();
    stale.signed_at = "2020-01-01T00:00:00.000Z".into();
    stale.expires_at = "2020-01-08T00:00:00.000Z".into();
    assert!(
        inspect_local_golden_dataset_provisioning_v1(&stale)
            .unwrap_err()
            .0
            .contains("authority_expired")
    );
    fs::set_permissions(root.join("dataset"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_dir_all(root).unwrap();
    fs::set_permissions(root2.join("dataset"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_dir_all(root2).unwrap();
}

#[test]
fn split_assignments_must_be_allowed_by_research_semantics() {
    let (root, options) = fixture();
    write_json(
        &options.research_semantics,
        &json!({
            "version": 1,
            "kind": "OperatorDatasetResearchSemantics",
            "population": "Rows in the frozen local golden training dataset.",
            "variables": ["feature", "label"],
            "intervention": "Apply the bounded candidate classifier.",
            "comparator": "Compare with baseline and ablation classifiers.",
            "estimands": ["paired hidden-evaluation metric difference"],
            "datasetConstraints": ["local operator fixture; no external dataset-owner qualification"],
            "eligibleSplits": ["validation"]
        }),
        0o600,
    );
    let error = inspect_local_golden_dataset_provisioning_v1(&options)
        .unwrap_err()
        .0;
    assert!(
        error.contains("research_semantics_split_mismatch"),
        "{error}"
    );
    fs::set_permissions(root.join("dataset"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_dir_all(root).unwrap();
}

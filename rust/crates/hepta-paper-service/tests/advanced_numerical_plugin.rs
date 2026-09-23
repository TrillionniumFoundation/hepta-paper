use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use std::{
    fs,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(1);

fn request(family: &str, input: Value) -> Value {
    let mut value = json!({
        "version": 1,
        "kind": "AdvancedNumericalPluginRequest",
        "runId": format!("integration-{}", NEXT.fetch_add(1, Ordering::Relaxed)),
        "pluginId": "hepta.reference.native",
        "pluginDescriptorHash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "analysisFamily": family,
        "seed": 41,
        "input": input,
        "assuranceContracts": {
            "oracle": {"kind":"independent-numeric-oracle-v1", "contractHash":"sha256:5555555555555555555555555555555555555555555555555555555555555555"},
            "replay": {"kind":"deterministic-process-replay-v1", "contractHash":"sha256:6666666666666666666666666666666666666666666666666666666666666666"},
            "uncertainty": {"kind":"typed-uncertainty-report-v1", "contractHash":"sha256:7777777777777777777777777777777777777777777777777777777777777777"}
        }
    });
    let hash =
        production_hash_record_v1("AdvancedNumericalPluginRequest", &value).expect("request hash");
    value["advancedNumericalPluginRequestHash"] = Value::String(hash.as_str().to_owned());
    value
}

fn invoke(value: &Value) -> std::process::Output {
    invoke_bytes(&serde_json::to_vec(value).expect("request bytes"))
}

fn invoke_bytes(bytes: &[u8]) -> std::process::Output {
    let root = std::env::temp_dir().join(format!(
        "hepta-advanced-numerical-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).expect("test root");
    let request_path = root.join("request.json");
    fs::write(&request_path, bytes).expect("request");
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args([
            "advanced-numerical-plugin",
            request_path.to_str().expect("utf8 path"),
        ])
        .output()
        .expect("invoke native command");
    let _ = fs::remove_dir_all(root);
    output
}

#[test]
fn cli_status_reports_exact_native_surface_without_claiming_incumbent_runtime() {
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["advanced-numerical-plugin", "status"])
        .output()
        .expect("invoke native status");
    assert!(output.status.success(), "stderr: {:?}", output.stderr);
    let report: Value = serde_json::from_slice(&output.stdout).expect("status JSON");
    assert_eq!(report["kind"], "AdvancedNumericalPluginRuntimeInspection");
    assert_eq!(report["status"], "advanced_numerical_plugin_runner_partial");
    assert_eq!(report["nativeReferenceCandidate"], true);
    assert_eq!(report["signedBundleVerified"], false);
    assert_eq!(report["runtimeIdentityVerified"], false);
    assert_eq!(report["osSandboxVerified"], false);
    assert_eq!(report["productionQualified"], false);
    assert_eq!(
        report["supportedAnalysisFamilies"].as_array().map(Vec::len),
        Some(3)
    );
    assert!(
        report["blockers"]
            .as_array()
            .is_some_and(|values| !values.is_empty())
    );
}

#[test]
fn cli_executes_bounded_candidate_and_reports_unqualified_boundary() {
    let output = invoke(&request(
        "linear-algebra",
        json!({"matrix":[[4,1],[2,3]],"vector":[1,2],"residualTolerance":1e-10}),
    ));
    assert!(output.status.success(), "stderr: {:?}", output.stderr);
    let report: Value = serde_json::from_slice(&output.stdout).expect("result JSON");
    assert_eq!(report["kind"], "AdvancedNumericalPluginResult");
    assert_eq!(report["nativeExecution"], true);
    assert_eq!(report["productionQualified"], false);
    assert_eq!(
        report["qualificationStatus"],
        "reference_candidate_unqualified"
    );
    assert!(
        report["blockers"]
            .as_array()
            .is_some_and(|values| !values.is_empty())
    );
}

#[test]
fn cli_rejects_request_hash_tampering_and_unsupported_families() {
    let mut tampered = request("linear-algebra", json!({"matrix":[[1]],"vector":[1]}));
    tampered["advancedNumericalPluginRequestHash"] = Value::String(
        "sha256:0000000000000000000000000000000000000000000000000000000000000000".into(),
    );
    assert!(!invoke(&tampered).status.success());
    assert!(!invoke(&request("bayesian", json!({}))).status.success());
}

#[test]
fn cli_rejects_raw_requests_over_the_bound_before_json_parse() {
    let mut oversized = vec![b' '; 32 * 1024 + 1];
    oversized.extend_from_slice(b"{}");
    let output = invoke_bytes(&oversized);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("32KiB"));
}

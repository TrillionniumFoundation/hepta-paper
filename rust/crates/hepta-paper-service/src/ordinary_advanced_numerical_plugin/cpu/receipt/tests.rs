use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use serde_json::Value;
use std::{ffi::OsString, path::PathBuf, time::Duration};
fn literal<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().expect("actual original string")
}
fn optional<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v[key].as_str()
}
fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("original array")
        .iter()
        .map(|s| s.as_str().expect("string").to_owned())
        .collect()
}
fn typed<'a>(
    v: &'a Value,
    bom: &'a Json,
    argument_paths: (&'a [String], &'a [String]),
    artifacts: &'a [Artifact<'a>],
    blocked: &'a [String],
    environment: &'a [(String, String)],
    result: &'a Value,
) -> CpuObservations<'a> {
    let (args, paths) = argument_paths;
    let i = &v["executionProcessInvocation"];
    let l = &v["limits"];
    let isolated = &v["isolation"];
    CpuObservations {
        invocation: Invocation {
            process_invocation_id: literal(i, "processInvocationId"),
            executable_target: literal(i, "executableTarget"),
            arguments: args,
            working_directory: literal(i, "workingDirectory"),
            source_merkle_hash: literal(i, "sourceMerkleHash"),
            source_manifest_hash: literal(i, "sourceWorkspaceManifestHash"),
            standard_input: None,
        },
        result: ProcessResult {
            launcher_pid: result["pid"].as_f64(),
            exit_code: result["status"]
                .as_i64()
                .and_then(|i| i32::try_from(i).ok()),
            signal: optional(result, "signal"),
            stdout: result["stdout"].as_str().unwrap_or(""),
            stderr: result["stderr"].as_str().unwrap_or(""),
            error_message: result["error"]["message"].as_str(),
            errored: !result["error"].is_null(),
            aborted: result["aborted"] == true,
            timed_out: result["timedOut"] == true,
        },
        source: SourceSnapshots {
            merkle_before: literal(v, "sourceMerkleHashBefore"),
            merkle_after: optional(v, "sourceMerkleHashAfter"),
            manifest_before: literal(v, "sourceWorkspaceManifestHashBefore"),
            manifest_after: optional(v, "sourceWorkspaceManifestHashAfter"),
            work_merkle: literal(v, "workSourceMerkleHash"),
            work_manifest: literal(v, "workWorkspaceManifestHash"),
            expected_merkle: optional(v, "expectedSourceMerkleHash"),
            expected_manifest: optional(v, "expectedSourceWorkspaceManifestHash"),
            after_blockers: &[],
        },
        runtime: Runtime {
            identity_type: optional(v, "runtimeIdentityType"),
            identity_hash: optional(v, "runtimeIdentityHash"),
            executable_hash: optional(v, "runtimeExecutableSnapshotHash"),
            executable_hash_after: optional(v, "runtimeExecutableSnapshotHashAfter"),
            invocation_name: optional(v, "runtimeExecutableInvocationName"),
            invocation_path: optional(v, "runtimeExecutableInvocationPath"),
            overlay_target: optional(v, "runtimeExecutableOverlayTarget"),
        },
        isolation: Isolation {
            network_namespace: isolated["kernelNetworkIsolationVerified"] == true,
            filesystem_namespace: isolated["filesystemNamespaceVerified"] == true,
            source_readonly_mount: isolated["sourceReadOnlyMount"] == true,
            ephemeral_work_root: isolated["ephemeralWorkRootVerified"] == true,
            immutable_work_root: isolated["immutableWorkRootVerified"] == true,
            workspace_execution_snapshot: isolated["workspaceExecutionSnapshotVerified"] == true,
            readonly_runtime: isolated["readOnlyRuntimeVerified"] == true,
            memory_limit: isolated["memoryLimitVerified"] == true,
            cpu_limit: isolated["cpuLimitVerified"] == true,
            process_limit_available: isolated["processLimitVerified"] == true,
            process_limit_mechanism: literal(isolated, "processLimitMechanism"),
        },
        limits: Limits {
            timeout_ms: l["timeoutMs"].as_u64().unwrap(),
            memory_bytes: l["memoryBytes"].as_u64().unwrap(),
            cpu_seconds: l["cpuSeconds"].as_u64().unwrap(),
            maximum_pids: l["maximumPids"].as_u64().unwrap(),
            maximum_output_bytes: l["maximumOutputBytes"].as_u64().unwrap(),
            maximum_captured_bytes: l["maximumCapturedBytes"].as_u64().unwrap(),
        },
        declared_outputs: paths,
        separate_output_root: v["declaredOutputsRestrictedToSeparateRoot"] == true,
        artifacts,
        artifact_blockers: blocked,
        environment_binding_hash: literal(v, "environmentBindingHash"),
        environment_bom: bom,
        environment_bom_hash: literal(v, "environmentBomHash"),
        permitted_environment: environment,
        dataset_authorization_set_hash: literal(v, "datasetAuthorizationSetHash"),
        production_evidence_eligible: v["productionEvidenceEligible"] == true,
    }
}
fn projected(
    v: &Value,
    raw: &Json,
    result: &Value,
    c: &AtomicBool,
    d: Instant,
) -> Result<Json, String> {
    let bom = super::super::super::field(raw, "environmentBom").clone();
    let args = strings(&v["executionProcessInvocation"]["arguments"]);
    let paths = strings(&v["declaredOutputPaths"]);
    let artifacts: Vec<_> = v["artifacts"]
        .as_array()
        .expect("array")
        .iter()
        .map(|a| Artifact {
            path: literal(a, "path"),
            sha256: literal(a, "sha256"),
            bytes: a["bytes"].as_u64().unwrap(),
        })
        .collect();
    let blockers: Vec<_> = strings(&v["blockers"])
        .into_iter()
        .filter(|s| {
            s.starts_with("worker_output_path_") || s.starts_with("worker_declared_output_")
        })
        .collect();
    let environment: Vec<_> = v["executionBindings"]
        .as_object()
        .expect("object")
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
        .collect();
    cpu_worker_receipt_v1(
        &typed(
            v,
            &bom,
            (&args, &paths),
            &artifacts,
            &blockers,
            &environment,
            result,
        ),
        c,
        d,
    )
}
#[test]
fn original_cpu_worker_receipt_whole_value_and_actual_finalizer_boundaries() {
    let c = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(600);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let node = PathBuf::from(std::env::var("HEPTA_TEST_NODE").expect("qualified Node"));
    let env = EnvironmentPolicyV1::new(
        "cpu-worker-receipt-differential-v1",
        ["PATH", "LANG", "LC_ALL"],
        ["PATH"],
    )
    .unwrap()
    .build(
        std::iter::empty::<(OsString, OsString)>(),
        &BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LANG".into(), "C.UTF-8".into()),
            ("LC_ALL".into(), "C.UTF-8".into()),
        ]),
    )
    .unwrap();
    let actual = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: node,
            arguments: vec![
                "--input-type=module".into(),
                "-e".into(),
                include_str!("receipt-oracle.mjs").into(),
                root.clone().into_os_string(),
            ],
            working_directory: root,
            environment: env,
            stdin: None,
        },
        ProcessLimitsV1 {
            timeout_ms: 30_000,
            maximum_stdout_bytes: 4 * 1024 * 1024,
            maximum_stderr_bytes: 128 * 1024,
            maximum_tail_bytes: 128 * 1024,
            ..Default::default()
        },
        &c,
    )
    .unwrap();
    assert_eq!(
        actual.process.termination_reason,
        ProcessTerminationReason::Exited,
        "{:?}",
        actual.process
    );
    assert_eq!(
        actual.process.exit_code,
        Some(0),
        "{}",
        String::from_utf8_lossy(&actual.process.stderr_tail)
    );
    assert!(actual.process.process_group_cleanup_verified);
    let cases: Vec<Value> = serde_json::from_slice(&actual.stdout).unwrap();
    assert_eq!(cases.len(), 13);
    let Json::Array(raw_cases) =
        hepta_legacy_compatibility::parse_production_json_v1(&actual.stdout).unwrap()
    else {
        panic!("array expected")
    };
    for (case, raw_case) in cases.iter().zip(&raw_cases) {
        let v = &case["report"];
        let wire = super::super::super::field(raw_case, "report");
        let native = projected(v, wire, &case["result"], &c, deadline).unwrap();
        let bytes = hepta_legacy_compatibility::production_json_stringify_with_limits_v1(
            &native,
            ProductionJsonEncodingLimitsV1::default(),
            &c,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            *v,
            "whole {}",
            case["name"]
        );
        // Compare complete insertion order using the original whole oracle payload,
        // not a field projection or caller-provided success counter.
        let expected = hepta_legacy_compatibility::production_json_stringify_with_limits_v1(
            wire,
            ProductionJsonEncodingLimitsV1::default(),
            &c,
        )
        .unwrap();
        assert_eq!(bytes, expected);
    }
    eprintln!("actual_cpu_worker_projection_whole_cases={}", cases.len());
}
#[test]
fn cpu_worker_receipt_preclone_resources_and_controls_refuse_with_fresh_retry() {
    let v: Value = serde_json::from_str(include_str!(
        "../../../../../../oracle/numerical-cpu-worker.original-receipt.v1.json"
    ))
    .unwrap();
    let raw = hepta_legacy_compatibility::parse_production_json_v1(include_bytes!(
        "../../../../../../oracle/numerical-cpu-worker.original-receipt.v1.json"
    ))
    .unwrap();
    let result = serde_json::json!({"status":0,"signal":null,"stdout":"","stderr":"","pid":v["executionProcessIdentity"]["launcherPid"]});
    let c = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(30);
    assert!(projected(&v, &raw, &result, &AtomicBool::new(true), deadline).is_err());
    assert!(
        projected(
            &v,
            &raw,
            &result,
            &c,
            Instant::now() - Duration::from_secs(1)
        )
        .is_err()
    );
    let mut huge = v.clone();
    huge["declaredOutputPaths"] = serde_json::json!(vec!["x".repeat(64 * 1024); 129]);
    assert!(projected(&huge, &raw, &result, &c, deadline).is_err());
    let mut enormous = v.clone();
    enormous["limits"]["timeoutMs"] = serde_json::json!(9_007_199_254_740_992u64);
    assert!(projected(&enormous, &raw, &result, &c, deadline).is_err());
    let native = projected(&v, &raw, &result, &c, deadline).unwrap();
    assert_eq!(super::super::super::value(&native, &c).unwrap(), v);
}

//! Existing bounded FD process owner around a fixed CPU bubblewrap invocation.
use super::{workspace::CpuWorkspace, *};
use base64ct::{Base64, Encoding};
use hepta_codex_runtime::{
    BoundedProcessRequestV1, CapturedBoundedProcessResultV1, EnvironmentPolicyV1, ProcessLimitsV1,
    ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation_and_combined_output_limit_v1,
};
use std::ffi::OsString;

pub(super) struct CpuProcess {
    pub actual: CapturedBoundedProcessResultV1,
    pub invocation: Json,
    pub invocation_id: String,
    pub permitted_environment: Vec<(String, String)>,
    pub environment_binding_hash: String,
    pub timeout_ms: u64,
    pub maximum_captured: u64,
}
/// Preserve the actual native exit signal in the original Node wire spelling.
/// Unknown native signal numbers retain their process facts and refuse.
pub(super) fn receipt_signal_name(signal: Option<i32>) -> Result<Option<String>, String> {
    signal
        .map(|number| {
            nix::sys::signal::Signal::try_from(number)
                .map(|value| value.to_string())
                .map_err(|_| "advanced_numerical_plugin_cpu_signal_domain_v1_unaccepted".to_owned())
        })
        .transpose()
}
pub(super) fn execute(
    workspace: &CpuWorkspace<'_>,
    inputs: &mut StatusInputs<'_>,
    descriptor: &Value,
    request: &Json,
    limits: &limits::CpuExecutionLimits,
) -> Result<CpuProcess, String> {
    let c = workspace.c;
    let d = workspace.d;
    inputs.require_control(c, d)?;
    workspace.assert_current()?;
    let bwrap = sandbox::executable(inputs, "bwrap", c, d)?
        .ok_or("advanced_numerical_plugin_bubblewrap_unavailable")?;
    let prlimit = sandbox::executable(inputs, "prlimit", c, d)?
        .ok_or("advanced_numerical_plugin_prlimit_unavailable")?;
    limits.require_time_budget(c, d)?;
    let timeout_ms = limits.timeout_ms;
    let raw = production_json_stringify_with_limits_v1(
        request,
        ProductionJsonEncodingLimitsV1 {
            maximum_bytes: 64 * 1024,
            ..Default::default()
        },
        c,
    )
    .map_err(|e| e.to_string())?;
    check(c, d)?;
    let encoded = Base64::encode_string(&raw);
    let entry = descriptor["entrypoint"]["relativePath"]
        .as_str()
        .ok_or("advanced_numerical_plugin_entrypoint_invalid")?;
    let worker_args = vec![
        format!("/work/{entry}"),
        "--hepta-request-base64".into(),
        encoded,
        "--hepta-output".into(),
        "/output/result.json".into(),
    ];
    let dataset_hash = hash(
        "DatasetAuthorizationSet",
        &object([
            ("version", Json::Number(1.0)),
            ("kind", text("DatasetAuthorizationSet")),
            ("datasets", Json::Array(vec![])),
        ]),
        c,
    )?;
    let permitted = BTreeMap::from([(
        "HEPTA_DATASET_AUTHORIZATION_SET_HASH".to_owned(),
        dataset_hash,
    )]);
    let mut args = vec![
        format!("--as={}", limits.memory_bytes),
        format!("--cpu={}", limits.cpu_seconds),
        format!("--nproc={0}:{0}", limits.maximum_pids),
        "--".into(),
        bwrap.to_string_lossy().into_owned(),
    ];
    args.extend(
        [
            "--unshare-user-try",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--unshare-cgroup-try",
            "--unshare-net",
            "--die-with-parent",
            "--new-session",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind",
            "/bin",
            "/bin",
            "--ro-bind",
            "/lib",
            "/lib",
            "--ro-bind",
            "/lib64",
            "/lib64",
        ]
        .map(str::to_owned),
    );
    args.extend([
        "--ro-bind".to_owned(),
        workspace.work.path.to_string_lossy().into_owned(),
        "/source".into(),
        "--ro-bind".into(),
        workspace.work.path.to_string_lossy().into_owned(),
        "/work".into(),
        "--bind".into(),
        workspace.output.path.to_string_lossy().into_owned(),
        "/output".into(),
        "--ro-bind".into(),
        workspace.runtime_copy.to_string_lossy().into_owned(),
        workspace.runtime_path.to_string_lossy().into_owned(),
        "--chdir".into(),
        "/work".into(),
        "--setenv".into(),
        "HOME".into(),
        "/tmp".into(),
        "--setenv".into(),
        "PATH".into(),
        "/usr/local/bin:/usr/bin:/bin".into(),
    ]);
    for (k, v) in &permitted {
        args.extend(["--setenv".into(), k.clone(), v.clone()]);
    }
    args.push(workspace.runtime_path.to_string_lossy().into_owned());
    args.extend(worker_args.clone());
    let policy = EnvironmentPolicyV1::new(
        "ordinary-numerical-cpu-execution-v1",
        ["PATH", "LANG", "LC_ALL"],
        ["PATH"],
    )
    .map_err(|e| e.to_string())?;
    let env = policy
        .build(
            std::iter::empty::<(OsString, OsString)>(),
            &BTreeMap::from([
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("LANG".into(), "C.UTF-8".into()),
                ("LC_ALL".into(), "C.UTF-8".into()),
            ]),
        )
        .map_err(|e| e.to_string())?;
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|_| "advanced_numerical_plugin_randomness_unavailable")?;
    let invocation_id = format!("sha256:{}", hex::encode(random));
    let invocation = object([
        ("version", Json::Number(1.0)),
        ("kind", text("OsSandboxWorkerProcessInvocationBinding")),
        ("processInvocationId", text(&invocation_id)),
        ("executionClass", text("host")),
        (
            "executableTarget",
            text(&workspace.runtime_path.to_string_lossy()),
        ),
        (
            "arguments",
            Json::Array(worker_args.iter().map(|s| text(s)).collect()),
        ),
        ("workingDirectory", text("/work")),
        (
            "sourceMerkleHash",
            json_value(&workspace.source_snapshot()["merkleHash"])?,
        ),
        (
            "sourceWorkspaceManifestHash",
            json_value(&workspace.source_snapshot()["manifestHash"])?,
        ),
        (
            "standardInput",
            object([
                ("present", Json::Bool(false)),
                ("sha256", Json::Null),
                ("byteLength", Json::Number(0.0)),
            ]),
        ),
    ]);
    // Bind exactly the finite environment actually passed to the worker.
    // This is independent from the observed environment BOM.
    let permitted_environment: Vec<_> = permitted.into_iter().collect();
    let environment_binding_hash = hash(
        "WorkerEnvironmentBinding",
        &Json::Object(
            permitted_environment
                .iter()
                .map(|(k, v)| (k.encode_utf16().collect(), text(v)))
                .collect(),
        ),
        c,
    )?;
    let maximum_captured = limits.maximum_captured_bytes;
    workspace.assert_current()?;
    inputs.assert_current()?;
    check(c, d)?;
    limits.require_time_budget(c, d)?;
    let actual =
        run_bounded_process_capturing_stdout_with_cancellation_and_combined_output_limit_v1(
            &BoundedProcessRequestV1 {
                executable: prlimit,
                arguments: args.iter().map(OsString::from).collect(),
                working_directory: workspace.work.path.clone(),
                environment: env,
                stdin: None,
            },
            ProcessLimitsV1 {
                timeout_ms,
                maximum_stdout_bytes: maximum_captured,
                maximum_stderr_bytes: maximum_captured,
                maximum_tail_bytes: maximum_captured as usize,
                ..Default::default()
            },
            c,
            Some(maximum_captured),
        )
        .map_err(|e| e.to_string())?;
    let facts = recovery::ExecutionFacts::observed(
        &actual,
        &invocation_id,
        &workspace.output.path.join("result.json"),
        limits,
    );
    let verification: Result<(), String> = (|| {
        workspace.assert_current()?;
        inputs.assert_current()?;
        check(c, d)?;
        if !actual.process.process_group_cleanup_verified
            || actual.process.termination_reason != ProcessTerminationReason::Exited
        {
            return Err(format!(
                "advanced_numerical_plugin_execution_unknown_or_refused:{:?}",
                actual.process.termination_reason
            ));
        }
        Ok(())
    })();
    verification.map_err(|error| facts.context(error))?;
    Ok(CpuProcess {
        actual,
        invocation,
        invocation_id,
        permitted_environment,
        environment_binding_hash,
        timeout_ms,
        maximum_captured,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actual_self_signaled_capture_preserves_numeric_signal_and_wire_name() {
        for (signal_name, expected_number) in [("TERM", 15), ("KILL", 9)] {
            let cancelled = AtomicBool::new(false);
            let environment =
                EnvironmentPolicyV1::new("ordinary-cpu-signal-capture-test-v1", ["PATH"], ["PATH"])
                    .unwrap()
                    .build(
                        std::iter::empty::<(OsString, OsString)>(),
                        &BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                    )
                    .unwrap();
            let actual =
                run_bounded_process_capturing_stdout_with_cancellation_and_combined_output_limit_v1(
                    &BoundedProcessRequestV1 {
                        executable: PathBuf::from("/usr/bin/dash"),
                        arguments: vec!["-c".into(), format!("kill -{signal_name} $$").into()],
                        working_directory: PathBuf::from("/tmp"),
                        environment,
                        stdin: None,
                    },
                    ProcessLimitsV1 {
                        timeout_ms: 2000,
                        maximum_stdout_bytes: 1024,
                        maximum_stderr_bytes: 1024,
                        maximum_tail_bytes: 1024,
                        ..Default::default()
                    },
                    &cancelled,
                    Some(1024),
                )
                .unwrap();
            assert_eq!(
                actual.process.termination_reason,
                ProcessTerminationReason::Exited
            );
            assert_eq!(actual.process.exit_code, None);
            assert_eq!(actual.process.signal, Some(expected_number));
            assert!(actual.process.process_group_cleanup_verified);
            assert_eq!(
                receipt_signal_name(actual.process.signal).unwrap(),
                Some(format!("SIG{signal_name}"))
            );
        }
        assert_eq!(receipt_signal_name(None).unwrap(), None);
        assert!(receipt_signal_name(Some(0)).is_err());
        assert!(receipt_signal_name(Some(i32::MAX)).is_err());
    }
}

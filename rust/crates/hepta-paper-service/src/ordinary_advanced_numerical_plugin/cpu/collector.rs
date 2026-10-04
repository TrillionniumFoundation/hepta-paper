//! Fixed Linux CPU/Python observations through the existing bounded process owner.
use super::{workspace::CpuWorkspace, *};
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::ffi::OsString;
fn digest(kind: &str, v: Json, c: &AtomicBool, d: Instant) -> Result<Json, String> {
    let h = hash(kind, &v, c)?;
    check(c, d)?;
    Ok(text(&h))
}
fn trimmed(value: &str) -> String {
    crate::automation_runtime_reconciliation::sqlite_number::trim(value).to_owned()
}
fn probe(
    tool: &Path,
    args: &[&str],
    inputs: &StatusInputs<'_>,
    c: &AtomicBool,
    d: Instant,
) -> Result<String, String> {
    inputs.require_control(c, d)?;
    let remaining = u64::try_from(
        d.checked_duration_since(Instant::now())
            .ok_or("advanced_numerical_plugin_deadline_exceeded")?
            .as_millis(),
    )
    .map_err(|_| "advanced_numerical_plugin_deadline_exceeded")?;
    if remaining == 0 {
        return Err("advanced_numerical_plugin_deadline_exceeded".into());
    }
    let raw_path = sandbox::environment_text("PATH", "/usr/bin:/bin")?;
    if raw_path.len() > 64 * 1024 {
        return Err("advanced_numerical_plugin_probe_path_domain_v1_unaccepted".into());
    }
    let env = EnvironmentPolicyV1::new("ordinary-numerical-fixed-bom-probe-v1", ["PATH"], ["PATH"])
        .map_err(|e| e.to_string())?
        .build(
            std::iter::empty::<(OsString, OsString)>(),
            &BTreeMap::from([("PATH".into(), raw_path)]),
        )
        .map_err(|e| e.to_string())?;
    let actual = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: tool.to_owned(),
            arguments: args.iter().map(OsString::from).collect(),
            working_directory: PathBuf::from("/"),
            environment: env,
            stdin: None,
        },
        ProcessLimitsV1 {
            timeout_ms: remaining.min(5000),
            maximum_stdout_bytes: 1024 * 1024,
            maximum_stderr_bytes: 1024 * 1024,
            maximum_tail_bytes: 64 * 1024,
            ..Default::default()
        },
        c,
    )
    .map_err(|e| e.to_string())?;
    inputs.assert_current()?;
    check(c, d)?;
    if !actual.process.process_group_cleanup_verified
        || actual.process.termination_reason != ProcessTerminationReason::Exited
    {
        return Err(format!(
            "advanced_numerical_plugin_bom_probe_unknown;bomProbeFacts={}",
            serde_json::json!({
                "version": 1,
                "kind": "FixedNumericalBomProbeFailureV1",
                "executable": tool,
                "arguments": args,
                "timeoutMs": remaining.min(5000),
                "terminationReason": format!("{:?}", actual.process.termination_reason),
                "exitCode": actual.process.exit_code,
                "signal": actual.process.signal,
                "elapsedMs": actual.process.elapsed_ms,
                "stdoutBytes": actual.process.stdout_bytes,
                "stderrBytes": actual.process.stderr_bytes,
                "stderrTail": String::from_utf8_lossy(&actual.process.stderr_tail),
                "processGroupCleanupVerified": actual.process.process_group_cleanup_verified,
                "terminationEscalated": actual.process.termination_escalated,
            })
        ));
    }
    if actual.process.exit_code != Some(0) {
        return Ok(String::new());
    }
    Ok(trimmed(&String::from_utf8(actual.stdout).map_err(
        |_| "advanced_numerical_plugin_bom_probe_utf8_unaccepted",
    )?))
}
fn machine(
    inputs: &mut StatusInputs<'_>,
    c: &AtomicBool,
    d: Instant,
) -> Result<(Json, Json), String> {
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        check(c, d)?;
        let path = Path::new(path);
        if inputs.probe(path)?.is_none() {
            continue;
        }
        let bytes = inputs.document(path, 4096)?;
        let id = trimmed(
            std::str::from_utf8(&bytes)
                .map_err(|_| "advanced_numerical_plugin_bom_machine_id_domain_unaccepted")?,
        );
        if !(16..=128).contains(&id.len())
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            continue;
        }
        return Ok((
            digest(
                "EmpiricalMachineIdentity",
                object([
                    ("source", text(&path.to_string_lossy())),
                    ("value", text(&id)),
                ]),
                c,
                d,
            )?,
            text(if path == Path::new("/etc/machine-id") {
                "linux_etc_machine_id_hash"
            } else {
                "linux_dbus_machine_id_hash"
            }),
        ));
    }
    Ok((Json::Null, text("unobserved")))
}
pub(super) fn collect(
    workspace: &CpuWorkspace<'_>,
    descriptor: &Value,
    runtime_identity_hash: &str,
    request: &Json,
    inputs: &mut StatusInputs<'_>,
    limits: &limits::CpuExecutionLimits,
) -> Result<Json, String> {
    let c = workspace.c;
    let d = workspace.d;
    inputs.require_control(c, d)?;
    workspace.assert_current()?;
    limits.require_time_budget(c, d)?;
    if std::env::consts::OS != "linux" || descriptor["runtime"]["language"] != "python" {
        return Err("advanced_numerical_plugin_bom_cpu_python_domain_unaccepted".into());
    }
    let cat = sandbox::executable(inputs, "cat", c, d)?
        .ok_or("advanced_numerical_plugin_bom_cat_unavailable")?;
    let uname = sandbox::executable(inputs, "uname", c, d)?
        .ok_or("advanced_numerical_plugin_bom_uname_unavailable")?;
    let cpu_info = probe(&cat, &["/proc/cpuinfo"], inputs, c, d)?;
    if cpu_info.is_empty() {
        return Err("advanced_numerical_plugin_bom_cpu_observation_unavailable".into());
    }
    let mut model = None;
    let mut flags = None;
    let mut processors = 0;
    for line in cpu_info.lines() {
        check(c, d)?;
        if let Some((key, val)) = line.split_once(':') {
            let key = key.trim().to_ascii_lowercase();
            let val = val.trim();
            if key == "model name" && model.is_none() {
                model = Some(val.to_owned());
            }
            if key == "flags" && flags.is_none() {
                let mut f = val
                    .split_whitespace()
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                f.sort();
                flags = Some(f);
            }
            if key == "processor" {
                processors += 1;
            }
        }
    }
    if processors == 0 || processors > 4096 {
        return Err("advanced_numerical_plugin_bom_cpu_count_domain_unaccepted".into());
    }
    let cpu = object([
        (
            "modelHash",
            digest(
                "EmpiricalCpuModel",
                text(model.as_deref().unwrap_or("unobserved")),
                c,
                d,
            )?,
        ),
        (
            "flagsHash",
            digest(
                "EmpiricalCpuFlags",
                Json::Array(flags.unwrap_or_default().iter().map(|v| text(v)).collect()),
                c,
                d,
            )?,
        ),
        ("logicalProcessorCount", Json::Number(f64::from(processors))),
        ("observation", text("linux_proc_cpuinfo")),
    ]);
    let kernel = probe(&uname, &["-r"], inputs, c, d)?;
    if kernel.is_empty() {
        return Err("advanced_numerical_plugin_bom_kernel_observation_unavailable".into());
    }
    let (machine_hash, machine_observation) = machine(inputs, c, d)?;
    let version = probe(&workspace.runtime_path, &["--version"], inputs, c, d)?;
    let blas = probe(
        &workspace.runtime_path,
        &["-c", "import numpy as n; n.show_config()"],
        inputs,
        c,
        d,
    )?;
    let behavior = probe(
        &workspace.runtime_path,
        &[
            "-c",
            r#"import json,numpy as n; a=n.array([0.125,-0.25,0.5,1.0],dtype=n.float64); b=n.array([8.0,4.0,2.0,1.0],dtype=n.float64); print(json.dumps({"dot":float(n.dot(a,b)),"norm":float(n.linalg.norm(a)),"solve":float(n.linalg.solve(n.array([[3.0,1.0],[1.0,2.0]]),n.array([9.0,8.0]))[0])},sort_keys=True,separators=(",",":")))"#,
        ],
        inputs,
        c,
        d,
    )?;
    let mut observed = vec![
        text("operating_system_and_architecture"),
        text("hashed_cpu_model_and_flags"),
        text("effective_resource_limits"),
        text("host_executable_content_hash"),
    ];
    let mut unobserved = vec![
        text("bitwise_runtime_image_rebuild"),
        text("numerical_library_behavioral_equivalence"),
    ];
    if matches!(machine_hash, Json::Null) {
        unobserved.push(text("machine_identity"));
    } else {
        observed.push(text("hashed_machine_identity"));
    }
    if blas.is_empty() {
        unobserved.push(text("blas_implementation_identity"));
    } else {
        observed.push(text("blas_implementation_identity"));
    }
    if behavior.is_empty() {
        unobserved.push(text("numerical_library_behavior_identity"));
    } else {
        observed.push(text("numerical_library_behavior_identity"));
    }
    let manifest = object([
        ("version", Json::Number(1.0)),
        (
            "kind",
            text("AdvancedNumericalObservedHostRuntimeContentManifest"),
        ),
        (
            "assurance",
            text("observed_executable_and_plugin_source_not_complete_system_package_closure"),
        ),
        ("executableHash", text(&workspace.executable_hash)),
        (
            "sourceMerkleHash",
            json_value(&workspace.source_snapshot()["merkleHash"])?,
        ),
        (
            "sourceWorkspaceManifestHash",
            json_value(&workspace.source_snapshot()["manifestHash"])?,
        ),
        (
            "signedDescriptorPackageClosureHash",
            json_value(&descriptor["runtime"]["packageClosureHash"])?,
        ),
        ("observedPackageCount", Json::Number(0.0)),
    ]);
    let manifest_hash = hash(
        "AdvancedNumericalObservedHostRuntimeContentManifest",
        &manifest,
        c,
    )?;
    let closure = object([
        ("basis", text("content_manifest")),
        (
            "identityHash",
            digest(
                "RuntimePackageClosureIdentity",
                object([
                    ("manifestHash", text(&manifest_hash)),
                    ("observedPackageCount", Json::Number(0.0)),
                ]),
                c,
                d,
            )?,
        ),
        ("manifestHash", text(&manifest_hash)),
        ("observedPackageCount", Json::Number(0.0)),
    ]);
    let input = object([
        (
            "platform",
            object([
                ("operatingSystem", text("linux")),
                (
                    "architecture",
                    text(match std::env::consts::ARCH {
                        "x86_64" => "x64",
                        "aarch64" => "arm64",
                        v => v,
                    }),
                ),
                (
                    "kernelReleaseHash",
                    digest("EmpiricalKernelRelease", text(&kernel), c, d)?,
                ),
                ("machineIdentityHash", machine_hash),
                ("machineIdentityObservation", machine_observation),
                ("cpu", cpu),
            ]),
        ),
        (
            "runtime",
            object([
                ("type", text("host")),
                ("identityHash", text(runtime_identity_hash)),
                ("language", text("python")),
                (
                    "languageVersionHash",
                    if version.is_empty() {
                        Json::Null
                    } else {
                        digest("EmpiricalLanguageVersion", text(&version), c, d)?
                    },
                ),
                ("containerImageDigest", Json::Null),
                ("hostExecutableHash", text(&workspace.executable_hash)),
                ("packageClosure", closure),
            ]),
        ),
        (
            "gpu",
            object([
                ("required", Json::Bool(false)),
                ("status", text("not_required")),
                ("deviceCount", Json::Number(0.0)),
            ]),
        ),
        (
            "numericRuntime",
            object([
                ("threads", object([])),
                ("dynamicThreadingDisabled", Json::Bool(false)),
                ("explicitSingleThreadPolicy", Json::Bool(false)),
                ("policyObservation", text("worker_environment_allowlist")),
                (
                    "blasImplementationHash",
                    if blas.is_empty() {
                        Json::Null
                    } else {
                        digest("EmpiricalBlasImplementation", text(&blas), c, d)?
                    },
                ),
                (
                    "blasImplementationObservation",
                    text(if blas.is_empty() {
                        "unobserved"
                    } else {
                        "python_runtime_configuration_probe_v1"
                    }),
                ),
                (
                    "numericalLibraryBehaviorHash",
                    if behavior.is_empty() {
                        Json::Null
                    } else {
                        digest("EmpiricalNumericalLibraryBehavior", text(&behavior), c, d)?
                    },
                ),
                (
                    "numericalLibraryBehaviorObservation",
                    text(if behavior.is_empty() {
                        "unobserved"
                    } else {
                        "python_numpy_behavior_probe_v1"
                    }),
                ),
            ]),
        ),
        (
            "limits",
            object([
                ("timeoutMs", Json::Number(limits.timeout_ms as f64)),
                ("memoryBytes", Json::Number(limits.memory_bytes as f64)),
                ("cpuSeconds", Json::Number(limits.cpu_seconds as f64)),
                ("maximumPids", Json::Number(limits.maximum_pids as f64)),
                (
                    "maximumOutputBytes",
                    Json::Number(limits.maximum_output_bytes as f64),
                ),
                (
                    "maximumCapturedBytes",
                    Json::Number(limits.maximum_captured_bytes as f64),
                ),
            ]),
        ),
        (
            "determinism",
            object([
                ("classification", text("unknown")),
                ("explicitlyRequested", Json::Bool(false)),
                ("deterministicSeedRequired", Json::Bool(false)),
                (
                    "deterministicSeedBound",
                    Json::Bool(!matches!(field(request, "seed"), Json::Null)),
                ),
                ("threadPolicyVerified", Json::Bool(false)),
                ("gpuDeterminismVerified", Json::Bool(false)),
            ]),
        ),
        (
            "buildReproducibility",
            object([
                ("status", text("build_reproducibility_unverified")),
                ("runtimeContentIdentityPinned", Json::Bool(false)),
                ("bitwiseRebuildVerified", Json::Bool(false)),
                ("definitionHash", Json::Null),
                (
                    "blockers",
                    Json::Array(vec![
                        text("runtime_content_identity_not_pinned"),
                        text("bitwise_rebuild_not_verified"),
                    ]),
                ),
            ]),
        ),
        ("observedClaims", Json::Array(observed)),
        ("unobservedClaims", Json::Array(unobserved)),
    ]);
    workspace.assert_current()?;
    inputs.assert_current()?;
    check(c, d)?;
    environment_bom::build_v2(&input, c, d)
}

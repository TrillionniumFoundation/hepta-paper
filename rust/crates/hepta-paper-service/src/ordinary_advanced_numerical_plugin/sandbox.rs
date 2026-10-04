//! Actual bounded CPU sandbox probes. No container creation or numerical run.
use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{ffi::OsString, fs, os::unix::fs::MetadataExt};
pub(super) fn environment_text(name: &str, absent: &str) -> Result<String, String> {
    match std::env::var_os(name) {
        None => Ok(absent.to_owned()),
        Some(value) => {
            if value.len() > 64 * 1024 {
                return Err(
                    "advanced_numerical_plugin_probe_environment_domain_v1_unaccepted".into(),
                );
            }
            value.into_string().map_err(|_| {
                "advanced_numerical_plugin_probe_environment_domain_v1_unaccepted".into()
            })
        }
    }
}
pub(super) fn executable(
    source: &mut StatusInputs<'_>,
    name: &str,
    c: &AtomicBool,
    d: Instant,
) -> Result<Option<PathBuf>, String> {
    check(c, d)?;
    let path = environment_text("PATH", "/usr/bin:/bin")?;
    if path.len() > 64 * 1024 || path.split(':').count() > 256 {
        return Err("advanced_numerical_plugin_probe_path_domain_v1_unaccepted".into());
    }
    for folder in path.split(':') {
        check(c, d)?;
        let folder = Path::new(folder);
        if !folder.is_absolute() {
            return Err("advanced_numerical_plugin_probe_path_domain_v1_unaccepted".into());
        }
        let candidate = folder.join(name);
        if let Some(m) = source.probe(&candidate)?
            && !m.directory
            && m.mode & 0o111 != 0
            && nix::unistd::access(&candidate, nix::unistd::AccessFlags::X_OK).is_ok()
        {
            let actual = fs::canonicalize(&candidate)
                .map_err(|_| "advanced_numerical_plugin_probe_tool_invalid")?;
            if actual != candidate {
                return Err(
                    "advanced_numerical_plugin_probe_tool_alias_domain_v1_unaccepted".into(),
                );
            }
            let named = fs::symlink_metadata(&actual)
                .map_err(|_| "advanced_numerical_plugin_probe_tool_invalid")?;
            if named.mode() & 0o022 != 0 || named.uid() != 0 {
                return Err("advanced_numerical_plugin_probe_tool_invalid".into());
            }
            source.archive(&actual, 16 * 1024 * 1024)?;
            return Ok(Some(actual));
        }
    }
    Ok(None)
}
pub(super) fn invoke(
    tool: &Path,
    args: &[&str],
    source: &StatusInputs<'_>,
    c: &AtomicBool,
    d: Instant,
    cap: u64,
) -> Result<(i32, String, String), String> {
    source.require_control(c, d)?;
    check(c, d)?;
    let remaining = d
        .checked_duration_since(Instant::now())
        .ok_or("advanced_numerical_plugin_deadline_exceeded")?;
    let timeout = u64::try_from(remaining.as_millis())
        .map_err(|_| "advanced_numerical_plugin_deadline_exceeded")?
        .min(cap);
    if timeout == 0 {
        return Err("advanced_numerical_plugin_deadline_exceeded".into());
    }
    let environment = EnvironmentPolicyV1::new(
        "ordinary-numerical-cpu-probe-v1",
        ["PATH", "LANG", "LC_ALL"],
        ["PATH"],
    )
    .map_err(|e| e.to_string())?
    .build(
        std::iter::empty::<(OsString, OsString)>(),
        &BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LANG".into(), "C.UTF-8".into()),
            ("LC_ALL".into(), "C.UTF-8".into()),
        ]),
    )
    .map_err(|e| e.to_string())?;
    source.assert_current()?;
    let out = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: tool.to_owned(),
            arguments: args.iter().map(OsString::from).collect(),
            working_directory: PathBuf::from("/"),
            environment,
            stdin: None,
        },
        ProcessLimitsV1 {
            timeout_ms: timeout,
            maximum_stdout_bytes: 64 * 1024,
            maximum_stderr_bytes: 64 * 1024,
            maximum_tail_bytes: 64 * 1024,
            ..ProcessLimitsV1::default()
        },
        c,
    )
    .map_err(|e| e.to_string())?;
    source.assert_current()?;
    check(c, d)?;
    if !out.process.process_group_cleanup_verified
        || out.process.termination_reason != ProcessTerminationReason::Exited
    {
        return Err(format!(
            "advanced_numerical_plugin_probe_unknown_or_refused:{:?}",
            out.process.termination_reason
        ));
    }
    let stdout = String::from_utf8(out.stdout)
        .map_err(|_| "advanced_numerical_plugin_probe_output_domain_v1_unaccepted")?;
    let stderr = String::from_utf8(out.process.stderr_tail)
        .map_err(|_| "advanced_numerical_plugin_probe_output_domain_v1_unaccepted")?;
    Ok((
        out.process
            .exit_code
            .ok_or("advanced_numerical_plugin_probe_unknown_or_refused")?,
        stdout,
        stderr,
    ))
}
pub(super) fn inspect(
    source: &mut StatusInputs<'_>,
    c: &AtomicBool,
    d: Instant,
) -> Result<Json, String> {
    check(c, d)?;
    let context = environment_text("DOCKER_CONTEXT", "")?;
    let host = environment_text("DOCKER_HOST", "")?;
    if !context.is_empty() || (!host.is_empty() && host != "unix:///var/run/docker.sock") {
        return Err("sandbox_remote_docker_endpoint_forbidden".into());
    }
    let bwrap = executable(source, "bwrap", c, d)?;
    let prlimit = executable(source, "prlimit", c, d)?;
    let (exit, _stdout, b_stderr) = match &bwrap {
        Some(bin) => invoke(
            bin,
            &[
                "--unshare-user-try",
                "--unshare-net",
                "--die-with-parent",
                "--ro-bind",
                "/",
                "/",
                "/bin/true",
            ],
            source,
            c,
            d,
            5000,
        )?,
        None => (-1, String::new(), "spawnSync bwrap ENOENT".into()),
    };
    let (available, p_detail) = if nix::unistd::geteuid().as_raw() == 0 {
        (
            false,
            if prlimit.is_some() {
                "rlimit_nproc_not_enforced_for_root".to_owned()
            } else {
                "prlimit_not_found".to_owned()
            },
        )
    } else if let Some(bin) = &prlimit {
        let (code, out, err) = invoke(
            bin,
            &[
                "--nproc=17:17",
                "--",
                bin.to_str()
                    .ok_or("advanced_numerical_plugin_probe_path_domain_v1_unaccepted")?,
                "--nproc",
                "--noheadings",
                "--output",
                "SOFT,HARD",
            ],
            source,
            c,
            d,
            3000,
        )?;
        let words: Vec<_> = out.split_whitespace().collect();
        let good = code == 0 && words == ["17", "17"];
        (
            good,
            if good {
                "kernel_rlimit_nproc_verified".to_owned()
            } else if err.is_empty() {
                "rlimit_nproc_probe_failed".into()
            } else {
                crate::automation_runtime_reconciliation::sqlite_number::trim(&err).into()
            },
        )
    } else {
        (false, "prlimit_not_found".into())
    };
    let good = exit == 0 && available;
    let detail = if exit == 0 {
        p_detail.clone()
    } else {
        crate::automation_runtime_reconciliation::sqlite_number::trim(&b_stderr).into()
    };
    let tracer = Path::new("/usr/bin/strace");
    let tracer_ready = source
        .probe(tracer)?
        .is_some_and(|m| !m.directory && m.mode & 0o111 != 0)
        && nix::unistd::access(Path::new("/usr/bin/strace"), nix::unistd::AccessFlags::X_OK)
            .is_ok();
    if tracer_ready {
        source.archive(tracer, 16 * 1024 * 1024)?;
    }
    let academic = good && tracer_ready;
    let reason = if academic {
        "academic_empirical_dataset_access_ready"
    } else if good {
        "academic_empirical_dataset_access_tracer_unavailable"
    } else {
        "academic_empirical_bubblewrap_backend_unavailable"
    };
    let academic_detail = if academic {
        "bubblewrap_and_host_supervisor_tracer_verified".to_owned()
    } else {
        format!(
            "{};docker_supervisor_unavailable",
            if detail.is_empty() {
                "bubblewrap_unavailable"
            } else {
                &detail
            }
        )
    };
    let mut fields = if good {
        let Json::Object(f) = object([
            ("available", Json::Bool(true)),
            ("backend", text("bubblewrap")),
            ("status", text("os_sandbox_available")),
            ("detail", text(&detail)),
            (
                "processLimit",
                object([
                    ("available", Json::Bool(available)),
                    ("mechanism", text("rlimit-nproc")),
                    (
                        "executable",
                        prlimit
                            .as_ref()
                            .map_or(Json::Null, |p| text(&p.to_string_lossy())),
                    ),
                    ("detail", text(&p_detail)),
                ]),
            ),
        ]) else {
            return Err("advanced_numerical_plugin_probe_output_invalid".into());
        };
        f
    } else {
        let Json::Object(f) = object([
            ("available", Json::Bool(false)),
            ("backend", text("docker")),
            ("status", text("os_sandbox_unavailable")),
            ("detail", text("sandbox_trusted_runtime_image_required")),
            ("image", Json::Null),
            ("imageDigest", Json::Null),
            (
                "fallbackReason",
                text(if detail.is_empty() {
                    "bubblewrap_unavailable"
                } else {
                    &detail
                }),
            ),
        ]) else {
            return Err("advanced_numerical_plugin_probe_output_invalid".into());
        };
        f
    };
    let Json::Object(extra) = object([
        ("academicEmpiricalReady", Json::Bool(academic)),
        ("academicEmpiricalReadinessReason", text(reason)),
        ("academicEmpiricalReadinessDetail", text(&academic_detail)),
        (
            "academicEmpiricalDatasetProofBackend",
            if academic {
                text("bubblewrap-host-supervised-strace-v2")
            } else {
                Json::Null
            },
        ),
        ("datasetAccessTracer", text("/usr/bin/strace")),
        ("datasetAccessTracerReady", Json::Bool(tracer_ready)),
        ("dockerDatasetSupervisorReady", Json::Bool(false)),
        ("dockerDatasetSupervisorProbe", Json::Null),
    ]) else {
        return Err("advanced_numerical_plugin_probe_output_invalid".into());
    };
    fields.extend(extra);
    source.assert_current()?;
    check(c, d)?;
    Ok(Json::Object(fields))
}

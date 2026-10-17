//! Ordinary nested qualification facade. It reads the existing pinned verifier
//! and cannot mint platform, provider or deployment authority.
use crate::{
    canonical_cli::resolve_canonical_cli_arguments_v1,
    native_workspace::current_native_command_workspace_root_v1,
    nested_runtime_cli::{
        NESTED_RUNTIME_ARGUMENTS_V1, NestedRuntimeCliOutputV1, current_nested_runtime_clock_v1,
        nested_runtime_qualification_cli_v1, nested_runtime_qualification_cli_with_control_v1,
    },
    ordinary_readonly_frontend::OrdinaryReadonlyOutputV1,
};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub fn inspect_ordinary_nested_runtime_qualification_v1(
    argv: &[String],
    cancelled: Arc<AtomicBool>,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    let wrapped = [
        "operator".to_owned(),
        "nested-runtime-platform-qualification".to_owned(),
        "--".to_owned(),
    ]
    .into_iter()
    .chain(argv.iter().cloned())
    .collect::<Vec<_>>();
    resolve_canonical_cli_arguments_v1(&wrapped)?;
    // Ordinary validation rejects standalone-only flags. The existing parser
    // still owns its complete help text and option projection.
    let result = if argv.iter().any(|s| s == "--help") {
        nested_runtime_qualification_cli_v1(argv, &BTreeMap::new(), "1970-01-01T00:00:00.000Z")?
    } else {
        let deadline = Instant::now()
            .checked_add(Duration::from_secs(120))
            .ok_or("nested_runtime_platform_verification_deadline_invalid")?;
        if cancelled.load(Ordering::Acquire) {
            return Err("nested_runtime_platform_verification_cancelled".into());
        }
        let worker_root = current_native_command_workspace_root_v1(None)?;
        let mut environment = BTreeMap::new();
        for (_, name, _) in NESTED_RUNTIME_ARGUMENTS_V1 {
            match std::env::var(name) {
                Ok(value) => {
                    environment.insert((*name).to_owned(), value);
                }
                Err(std::env::VarError::NotPresent) => (),
                Err(std::env::VarError::NotUnicode(_)) => {
                    return Err(format!(
                        "nested_runtime_platform_environment_encoding_invalid:{name}"
                    ));
                }
            }
        }
        nested_runtime_qualification_cli_with_control_v1(
            argv,
            &environment,
            &current_nested_runtime_clock_v1()?,
            &worker_root,
            &cancelled,
            deadline,
        )?
    };
    match result {
        NestedRuntimeCliOutputV1::Help(text) => Ok(OrdinaryReadonlyOutputV1 {
            stdout: format!("{text}\n").into_bytes(),
            stderr: Vec::new(),
            exit_code: 0,
        }),
        NestedRuntimeCliOutputV1::Report(report) => {
            let mut stdout = serde_json::to_vec_pretty(&report)
                .map_err(|_| "nested_runtime_platform_output_encoding_invalid")?;
            stdout.push(b'\n');
            Ok(OrdinaryReadonlyOutputV1 {
                stdout,
                stderr: Vec::new(),
                exit_code: if report["ready"] == true { 0 } else { 1 },
            })
        }
    }
}

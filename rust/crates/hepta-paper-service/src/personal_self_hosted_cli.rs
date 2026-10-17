//! Ordinary personal readiness adapter. The imported observer remains local,
//! read-only and cannot grant release, submission or independent actor authority.
use crate::{
    canonical_cli::resolve_canonical_cli_arguments_v1,
    external_authority_intake::unix_millis_to_iso_v1,
    native_workspace::{
        current_native_command_workspace_root_v1, resolve_native_workspace_root_v1,
    },
    ordinary_readonly_frontend::OrdinaryReadonlyOutputV1,
    personal_self_hosted_readiness::{
        PersonalSelfHostedReadinessOptions, inspect_personal_self_hosted_readiness_with_control_v1,
        personal_self_hosted_readiness_help_json_v1,
    },
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Retain the existing ordinary provenance 120s ceiling; caller configuration
/// cannot increase it or manufacture a readiness/authority result.
pub(crate) struct PersonalReadinessControlV1 {
    pub(crate) cancelled: Arc<AtomicBool>,
    pub(crate) deadline: Instant,
    pub(crate) worker_root: PathBuf,
}
impl PersonalReadinessControlV1 {
    pub(crate) fn checkpoint(&self) -> Result<(), String> {
        if self.cancelled.load(std::sync::atomic::Ordering::Acquire) {
            return Err("personal_readiness_cancelled".into());
        }
        if Instant::now() >= self.deadline {
            return Err("personal_readiness_deadline_exceeded".into());
        }
        Ok(())
    }
}

fn environment() -> Result<BTreeMap<String, String>, String> {
    let mut selected = BTreeMap::new();
    for key in [
        "HEPTA_WORKSPACE_ROOT",
        "HEPTA_PAPER_RUNTIME_ROOT",
        "HEPTA_FORMAL_OPERATIONAL_RECEIPT",
        "HEPTA_PERSONAL_CPU_RECEIPT",
        "HEPTA_PERSONAL_GPU_RECEIPT",
        "HEPTA_PERSONAL_GPU_ENABLED",
        "HEPTA_PERSONAL_GPU_DISABLED_REASON",
    ] {
        match std::env::var(key) {
            Ok(value) => {
                selected.insert(key.to_owned(), value);
            }
            Err(std::env::VarError::NotPresent) => (),
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(format!(
                    "personal_readiness_environment_encoding_invalid:{key}"
                ));
            }
        }
    }
    Ok(selected)
}
fn output(report: &serde_json::Value, exit_code: i32) -> Result<OrdinaryReadonlyOutputV1, String> {
    let mut stdout = serde_json::to_vec_pretty(report)
        .map_err(|_| "personal_readiness_output_encoding_invalid")?;
    stdout.push(b'\n');
    Ok(OrdinaryReadonlyOutputV1 {
        stdout,
        stderr: Vec::new(),
        exit_code,
    })
}

/// Validate through the single ordinary parser before workspace selection,
/// including help. The worker's native-only cpu-receipt flag stays separate.
pub fn inspect_ordinary_personal_readiness_v1(
    argv: &[String],
    cancelled: Arc<AtomicBool>,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    let wrapped = [
        "operator".to_owned(),
        "personal-self-hosted-readiness".to_owned(),
        "--".to_owned(),
    ]
    .into_iter()
    .chain(argv.iter().cloned())
    .collect::<Vec<_>>();
    resolve_canonical_cli_arguments_v1(&wrapped)?;
    let mut parsed = BTreeMap::new();
    let mut index = 0;
    while index < argv.len() {
        let raw = argv[index]
            .strip_prefix("--")
            .ok_or("personal_readiness_argument_invalid")?;
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(key, value)| (key, Some(value)));
        let value = if ["gpu-enabled", "help", "json", "require-ready"].contains(&key) {
            String::new()
        } else if let Some(value) = inline {
            value.to_owned()
        } else {
            index += 1;
            argv.get(index)
                .ok_or("personal_readiness_argument_invalid")?
                .clone()
        };
        parsed.insert(key.to_owned(), value);
        index += 1;
    }
    if parsed.contains_key("help") {
        return output(&personal_self_hosted_readiness_help_json_v1(), 0);
    }
    let deadline = Instant::now()
        .checked_add(Duration::from_secs(120))
        .ok_or("personal_readiness_deadline_invalid")?;
    if cancelled.load(std::sync::atomic::Ordering::Acquire) {
        return Err("personal_readiness_cancelled".into());
    }
    // The incumbent worker's cwd comes from the physical frontend. Inspection
    // roots and receipt report strings do not relocate that working directory.
    let worker_root = current_native_command_workspace_root_v1(None)?;
    let control = PersonalReadinessControlV1 {
        cancelled,
        deadline,
        worker_root: worker_root.clone(),
    };
    control.checkpoint()?;
    let mut environment = environment()?;
    let resolve =
        |selected: &str| resolve_native_workspace_root_v1(&worker_root, Path::new(selected), None);
    let root = parsed
        .get("root")
        .filter(|v| !v.is_empty())
        .or_else(|| {
            environment
                .get("HEPTA_WORKSPACE_ROOT")
                .filter(|v| !v.is_empty())
        })
        .map(|p| resolve(p))
        .transpose()?
        .unwrap_or_else(|| worker_root.clone());
    let runtime = parsed
        .get("runtime-root")
        .filter(|v| !v.is_empty())
        .or_else(|| {
            environment
                .get("HEPTA_PAPER_RUNTIME_ROOT")
                .filter(|v| !v.is_empty())
        })
        .map(|p| resolve(p))
        .transpose()?
        .unwrap_or_else(|| {
            worker_root
                .parent()
                .unwrap_or_else(|| Path::new("/"))
                .join("hepta-paper-runtime/native-runtime")
        });
    // Environment receipt paths retain their original report spelling; the
    // controlled observer resolves actual reads against worker_root. Explicit
    // CLI receipt paths follow the incumbent path.resolve override.
    let gpu_receipt = parsed
        .get("gpu-receipt")
        .filter(|v| !v.is_empty())
        .map(|p| resolve(p))
        .transpose()?;
    if let Some(path) = &gpu_receipt {
        environment.insert(
            "HEPTA_PERSONAL_GPU_RECEIPT".into(),
            path.to_string_lossy().into_owned(),
        );
    }
    let gpu_enabled = parsed.contains_key("gpu-enabled")
        || environment
            .get("HEPTA_PERSONAL_GPU_ENABLED")
            .is_some_and(|v| v == "true");
    if parsed.contains_key("gpu-enabled") {
        environment.insert("HEPTA_PERSONAL_GPU_ENABLED".into(), "true".into());
    }
    let observed_at = if let Some(value) = parsed.get("now").filter(|v| !v.is_empty()) {
        crate::store_status::passive_node_date_parse_iso_v1(value)
            .ok_or_else(|| "personal_self_hosted_readiness: clock is invalid".to_owned())?
    } else {
        let millis = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "personal_readiness_clock_invalid")?
                .as_millis(),
        )
        .map_err(|_| "personal_readiness_clock_invalid")?;
        unix_millis_to_iso_v1(millis).map_err(|e| e.to_string())?
    };
    let options = PersonalSelfHostedReadinessOptions {
        workspace_root: root,
        runtime_root: runtime,
        cpu_receipt: None::<PathBuf>,
        gpu_receipt,
        gpu_enabled,
        observed_at,
        environment,
    };
    let report = inspect_personal_self_hosted_readiness_with_control_v1(&options, &control)
        .map_err(|e| e.to_string())?;
    control.checkpoint()?;
    let exit_code = if parsed.contains_key("require-ready")
        && report["personalSelfHostedProductionReady"] != true
    {
        2
    } else {
        0
    };
    output(&report, exit_code)
}

#[cfg(test)]
mod control_tests {
    use super::*;
    #[test]
    fn precancelled_ordinary_personal_refuses_before_workspace_and_receipt_io() {
        let cancelled = Arc::new(AtomicBool::new(true));
        assert!(
            matches!(inspect_ordinary_personal_readiness_v1(&[], cancelled), Err(error) if error == "personal_readiness_cancelled")
        );
    }
}

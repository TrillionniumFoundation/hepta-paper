//! Ordinary GPU receipt check. A receipt reports personal-only evidence; this
//! facade neither observes GPU hardware nor grants release/provider authority.
use crate::{
    canonical_cli::resolve_canonical_cli_arguments_v1,
    native_workspace::{
        current_native_command_workspace_root_v1, resolve_native_workspace_root_v1,
    },
    ordinary_readonly_frontend::OrdinaryReadonlyOutputV1,
    personal_self_hosted_gpu::{
        PersonalGpuPublicationInputV1, blocked_personal_gpu_receipt_v1,
        cli::{PERSONAL_GPU_USAGE, parse_personal_gpu_arguments, safe_personal_gpu_token},
        encode_personal_gpu_operational_receipt_v1, gpu_check_active_v1,
        observe_missing_personal_gpu_receipt_v1, parse_personal_gpu_operational_receipt_v1,
        read_retained_personal_gpu_receipt_v1, write_personal_gpu_receipt_for_observed_input_v1,
    },
};
use hepta_legacy_compatibility::{
    ProductionJsonEncodingLimitsV1, parse_production_json_v1, production_json_pretty_resources_v1,
    production_json_pretty_with_limits_v1,
};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
const MAX_OUTPUT: usize = 4 * 1024 * 1024;
fn invalid_receipt_diagnostic(bytes: &[u8]) -> String {
    // Keep receipt validity in the existing ordered JSON/receipt owner. This
    // formats the qualified Node diagnostic for an unfinished object's first
    // property; other V8 SyntaxError families remain an explicit partial domain.
    let text = String::from_utf8_lossy(bytes);
    let Err(hepta_legacy_compatibility::CompatibilityError::InvalidJson(position)) =
        parse_production_json_v1(text.as_bytes())
    else {
        return "personal_gpu_existing_receipt_invalid".into();
    };
    let prefix = text.get(..position).unwrap_or("");
    let serde_object_end = serde_json::from_str::<serde_json::Value>(&text)
        .err()
        .is_some_and(|error| error.to_string().starts_with("EOF while parsing an object"));
    if serde_object_end && prefix.trim_end().ends_with('{') {
        let utf16_position = prefix.encode_utf16().count();
        let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
        let column = prefix
            .rsplit('\n')
            .next()
            .unwrap_or("")
            .encode_utf16()
            .count()
            + 1;
        return format!(
            "Expected property name or '}}' in JSON at position {utf16_position} (line {line} column {column})"
        );
    }
    "personal_gpu_existing_receipt_invalid".into()
}
fn resolve(root: &Path, value: &Path) -> Result<PathBuf, String> {
    resolve_native_workspace_root_v1(root, value, Some(value))
}
fn encode(bytes: &[u8], cancelled: &AtomicBool, deadline: Instant) -> Result<Vec<u8>, String> {
    gpu_check_active_v1(cancelled, deadline)?;
    // Measurement and writing share the existing Node JSON encoder. No
    // temporary unbounded pretty string is created before the fixed output cap.
    let parsed = parse_production_json_v1(String::from_utf8_lossy(bytes).as_bytes())
        .map_err(|_| "personal_gpu_check_wire_invalid")?;
    let limits = ProductionJsonEncodingLimitsV1 {
        maximum_bytes: MAX_OUTPUT - 1,
        ..ProductionJsonEncodingLimitsV1::default()
    };
    let measured = production_json_pretty_resources_v1(&parsed, limits, cancelled)
        .map_err(|_| "personal_gpu_check_output_limit_exceeded")?;
    gpu_check_active_v1(cancelled, deadline)?;
    let mut output = production_json_pretty_with_limits_v1(&parsed, limits, cancelled)
        .map_err(|_| "personal_gpu_check_output_limit_exceeded")?;
    if output.len() != measured.bytes {
        return Err("personal_gpu_check_wire_invalid".into());
    }
    gpu_check_active_v1(cancelled, deadline)?;
    output.push(b'\n');
    Ok(output)
}
fn commit(
    root: &Path,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<String>, String> {
    gpu_check_active_v1(cancelled, deadline)?;
    let result = crate::operational_status::current_operational_code_provenance_with_deadline_v1(
        root, cancelled, deadline,
    )
    .ok()
    .and_then(|value| {
        value
            .get("commit")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    });
    // Node absorbs a failed provenance lookup for its diagnostic fallback. A
    // cancelled/expired original control is still refused before publication.
    gpu_check_active_v1(cancelled, deadline)?;
    Ok(result)
}
pub fn inspect_normal_personal_gpu_v1(
    argv: &[String],
    cancelled: Arc<AtomicBool>,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    if argv.len() > 64
        || argv
            .iter()
            .try_fold(0usize, |n, v| n.checked_add(v.len()))
            .is_none_or(|n| n > 64 * 1024)
    {
        return Err("personal_gpu_check_arguments_limit_exceeded".into());
    }
    let wrapped = [
        "operator".to_owned(),
        "personal-gpu-operational-gate".to_owned(),
        "--".to_owned(),
    ]
    .into_iter()
    .chain(argv.iter().cloned())
    .collect::<Vec<_>>();
    resolve_canonical_cli_arguments_v1(&wrapped)?;
    let options = parse_personal_gpu_arguments(argv)?;
    let deadline = Instant::now()
        .checked_add(Duration::from_secs(120))
        .ok_or("personal_gpu_check_deadline_invalid")?;
    run(&options, cancelled, deadline)
}
fn run(
    options: &std::collections::BTreeMap<String, String>,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    gpu_check_active_v1(&cancelled, deadline)?;
    if options.contains_key("help") {
        return Ok(OrdinaryReadonlyOutputV1 {
            stdout: format!("{PERSONAL_GPU_USAGE}\n").into_bytes(),
            stderr: Vec::new(),
            exit_code: 0,
        });
    }
    if !options.contains_key("check") {
        return Err("personal-gpu-operational-gate Rust route currently supports only --check; GPU execution is not ported".into());
    }
    // The ordinary Node wrapper starts its worker in its physical workspace;
    // provenance --root does not replace the worker's independent runtime default.
    let worker = current_native_command_workspace_root_v1(None)?;
    let root = options
        .get("root")
        .map(|s| resolve(&worker, Path::new(s)))
        .transpose()?
        .unwrap_or_else(|| worker.clone());
    let runtime = if let Some(selected) = options.get("runtime-root") {
        resolve(&worker, Path::new(selected))?
    } else if let Some(selected) =
        std::env::var_os("HEPTA_PAPER_RUNTIME_ROOT").filter(|s| !s.is_empty())
    {
        resolve(&worker, Path::new(&selected))?
    } else {
        worker
            .parent()
            .unwrap_or(&worker)
            .join("hepta-paper-runtime/native-runtime")
    };
    let receipt = options
        .get("receipt")
        .map(|s| resolve(&worker, Path::new(s)))
        .transpose()?
        .unwrap_or_else(|| runtime.join("gpu-personal/personal-gpu-operational-receipt.json"));
    let input =
        match read_retained_personal_gpu_receipt_v1(&receipt, Arc::clone(&cancelled), deadline) {
            Ok(input) => Some(input),
            Err(error) if error.starts_with("personal_gpu_check_") => return Err(error),
            Err(_) => None,
        };
    let parsed = input
        .as_ref()
        .and_then(|input| parse_personal_gpu_operational_receipt_v1(input.bytes()).ok());
    if let Some(report) = parsed {
        let input = input.as_ref().ok_or("personal_gpu_check_input_changed")?;
        let output = encode(input.bytes(), &cancelled, deadline)?;
        input.assert_current()?;
        return Ok(OrdinaryReadonlyOutputV1 {
            stdout: output,
            stderr: Vec::new(),
            exit_code: if report["personalProductionReady"] == true {
                0
            } else {
                2
            },
        });
    }
    // For genuine absence reuse the existing held first-missing-edge owner.
    // Nonabsence read refusals remain diagnostic, never accepted GPU evidence.
    let missing = if input.is_none() {
        observe_missing_personal_gpu_receipt_v1(&receipt, &cancelled, deadline).ok()
    } else {
        None
    };
    let failure = if let Some(input) = &input {
        invalid_receipt_diagnostic(input.bytes())
    } else {
        format!(
            "personal_gpu_artifact_read_failed:{}",
            receipt
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("receipt.json")
        )
    };
    let observed_commit = commit(&root, &cancelled, deadline)?;
    let created = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "personal_gpu_check_clock_invalid")?
            .as_millis(),
    )
    .map_err(|_| "personal_gpu_check_clock_invalid")?;
    let report = blocked_personal_gpu_receipt_v1(
        created,
        observed_commit.as_deref(),
        &format!(
            "personal_gpu_gate_failed:{}",
            safe_personal_gpu_token(&failure)
        ),
    )
    .map_err(|_| "personal_gpu_check_fallback_invalid")?;
    let rendered = encode_personal_gpu_operational_receipt_v1(&report)
        .map_err(|_| "personal_gpu_check_wire_invalid")?;
    let output = encode(rendered.as_bytes(), &cancelled, deadline)?;
    if let Some(input) = &input {
        input.assert_current()?;
    }
    if let Some(missing) = &missing {
        missing.assert_current()?;
    }
    if commit(&root, &cancelled, deadline)? != observed_commit {
        return Err("personal_gpu_check_source_changed".into());
    }
    if options.contains_key("write") {
        // Keep the original opaque target alive through the writer's rename
        // checks. Existing aliases/special/oversized inputs have no writable
        // missing proof and are retained even when --write was requested.
        let original_input = input
            .as_ref()
            .map(PersonalGpuPublicationInputV1::Existing)
            .or_else(|| missing.as_ref().map(PersonalGpuPublicationInputV1::Missing));
        if original_input.is_some_and(|original_input| {
            write_personal_gpu_receipt_for_observed_input_v1(
                &receipt,
                &rendered,
                &cancelled,
                deadline,
                original_input,
            )
            .is_ok()
        }) {
            let written =
                read_retained_personal_gpu_receipt_v1(&receipt, Arc::clone(&cancelled), deadline)?;
            if written.bytes() != output {
                return Err("personal_gpu_check_publication_changed".into());
            }
            written.assert_current()?;
        }
        // As in Node, a failed private publication still emits the blocked
        // fallback; no successful publication or cleanup fact is manufactured.
    }
    gpu_check_active_v1(&cancelled, deadline)?;
    Ok(OrdinaryReadonlyOutputV1 {
        stdout: output,
        stderr: Vec::new(),
        exit_code: 2,
    })
}
#[cfg(test)]
mod tests;

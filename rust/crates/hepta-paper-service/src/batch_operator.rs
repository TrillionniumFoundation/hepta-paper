//! Normal operator batch frontend over held inventory and the existing complete
//! campaign builder. A preview is neither a queue commit nor role execution.
use crate::{
    batch_campaign::{NativeBatchCampaignCommandInputV1, build_native_batch_campaign_command_v1},
    batch_cli::{
        NativeBatchCliOptionsV1, native_batch_cli_control_v1,
        normalize_native_batch_cli_arguments_v1,
    },
    native_inventory::{NativeInventoryRequestV1, discover_native_immutable_batch_inventory_v1},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
mod budget;
mod report;
mod scope;

#[derive(Debug)]
pub struct NativeBatchOperatorOutputV1 {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}
fn check(cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("native_batch_operator_cancelled".into());
    }
    if Instant::now() >= deadline {
        return Err("native_batch_operator_deadline_v1_exceeded".into());
    }
    Ok(())
}
fn now() -> Result<String, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "native_batch_operator_clock_invalid")?
        .as_millis();
    crate::sqlite_mutation_coordinator::clock::iso(
        i64::try_from(millis).map_err(|_| "native_batch_operator_clock_invalid")?,
    )
    .map_err(|_| "native_batch_operator_clock_invalid".into())
}
fn environment() -> Result<BTreeMap<String, String>, String> {
    let mut selected = BTreeMap::new();
    for key in [
        "HEPTA_PAPER_WORKSPACE_ROOT",
        "HEPTA_PAPER_ASSET_ROOT",
        "HEPTA_PAPER_RUNTIME_ROOT",
    ] {
        match std::env::var(key) {
            Ok(v) => {
                selected.insert(key.into(), v);
            }
            Err(std::env::VarError::NotPresent) => {}
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(format!(
                    "native_batch_operator_environment_utf8_required:{key}"
                ));
            }
        }
    }
    Ok(selected)
}
fn usage() -> Result<Vec<u8>, String> {
    let value: String = serde_json::from_str(include_str!(
        "../../../../paper-core/config/paper-production-usage.v1.json"
    ))
    .map_err(|_| "native_batch_operator_usage_asset_invalid")?;
    if value.len() > 16 * 1024 {
        return Err("native_batch_operator_usage_asset_invalid".into());
    }
    Ok(value.into_bytes())
}
fn error_output(error: String) -> NativeBatchOperatorOutputV1 {
    NativeBatchOperatorOutputV1 {
        stdout: Vec::new(),
        stderr: format!("Error: {error}\n").into_bytes(),
        exit_code: 1,
    }
}
/// `arguments` is the ordinary fixed `batch-run` command's forwarded argv. The
/// original unbounded Node path and native fixed 300s/byte safety refusals remain
/// explicitly distinct. This frontend never acquires submission/release authority.
pub fn run_native_batch_operator_v1(
    arguments: &[String],
    cwd: &Path,
    cancelled: &Arc<AtomicBool>,
) -> Result<NativeBatchOperatorOutputV1, String> {
    let deadline = Instant::now() + Duration::from_secs(300);
    let result = run(arguments, cwd, cancelled, deadline);
    Ok(match result {
        Ok(value) => value,
        Err(error) => error_output(error),
    })
}
fn run(
    arguments: &[String],
    cwd: &Path,
    cancelled: &Arc<AtomicBool>,
    deadline: Instant,
) -> Result<NativeBatchOperatorOutputV1, String> {
    check(cancelled, deadline)?;
    let control = native_batch_cli_control_v1(arguments)?;
    if control.help {
        return Ok(NativeBatchOperatorOutputV1 {
            stdout: usage()?,
            stderr: Vec::new(),
            exit_code: 0,
        });
    }
    let environment = environment()?;
    let workspace =
        crate::native_workspace::resolve_native_command_workspace_root_v1(cwd, &environment, None)?;
    // The incumbent normal registry launches its child in the physical code
    // workspace. Relative argv and runtime/asset environment paths share that
    // working directory; an explicit native workspace selector remains a path
    // relocation extension, never authority.
    let layout = crate::workspace_status::resolve_workspace_layout_v1(
        &workspace,
        &workspace,
        &environment,
        &crate::workspace_status::WorkspaceLayoutOptionsV1::default(),
    )?;
    let cwd = workspace
        .to_str()
        .ok_or("native_batch_operator_cwd_utf8_required")?;
    let options = normalize_native_batch_cli_arguments_v1(
        arguments,
        cwd,
        &layout.roots.asset_root,
        &layout.roots.runtime_root,
    )?;
    let report = preview(&options, &workspace, cancelled, deadline)?;
    check(cancelled, deadline)?;
    let stdout = if control.json {
        let mut bytes = report::bounded_pretty_json(&report)?;
        bytes.push(b'\n');
        bytes
    } else {
        report::console(&report)?.into_bytes()
    };
    check(cancelled, deadline)?;
    Ok(NativeBatchOperatorOutputV1 {
        stdout,
        stderr: Vec::new(),
        exit_code: 0,
    })
}
fn preview(
    options: &NativeBatchCliOptionsV1,
    workspace: &Path,
    cancelled: &Arc<AtomicBool>,
    deadline: Instant,
) -> Result<Value, String> {
    // Domain vocabulary and the unavailable production executors retain their
    // actual admission order before any inventory/authority bootstrap.
    if ![
        "inventory",
        "local-build",
        "local-package",
        "research-verify",
        "empirical-analysis",
        "referee-review",
        "referee-revise",
        "local-review-loop",
        "referee-autopilot",
        "journal-manage",
        "venue-resolve",
        "source-adapt",
        "local-dry-run",
        "reviewed-submit",
    ]
    .contains(&options.mode.as_str())
    {
        return Err(format!("Unknown paper batch mode: {}", options.mode));
    }
    if options.execute && options.mode == "inventory" {
        return Err("batch_inventory_execute_forbidden_use_read_only_preview".into());
    }
    if ["journal-manage", "venue-resolve", "source-adapt"].contains(&options.mode.as_str()) {
        return Err(format!(
            "campaign_mode_executor_not_available:{}",
            options.mode
        ));
    }
    if options.execute {
        return Err("native_batch_operator_execute_requires_bound_mutation_coordinator_v1".into());
    }
    if options.dataset_root.is_some()
        || options.benchmark_id.is_some()
        || options.apply_manuscript
        || options.dataset_harness_envelope.is_some()
    {
        return Err("native_batch_campaign_empirical_input_domain_v1_not_implemented".into());
    }
    check(cancelled, deadline)?;
    let runtime = PathBuf::from(&options.runtime_root);
    let observation = discover_native_immutable_batch_inventory_v1(
        &NativeInventoryRequestV1 {
            version: 1,
            root: PathBuf::from(&options.root),
            database: Some(runtime.join("hepta-paper.sqlite")),
            inventory_source: options.inventory_source.clone(),
            include_loose_drafts: true,
            include_retired: options.include_retired,
            include_quarantined: options.include_quarantined,
            include_proposal_staging: true,
            proposal_staging_root: Some(runtime.join("proposal-staging")),
            paper_ids: options.paper_ids.clone(),
            limit: options.limit.map(|n| n as f64),
            observed_at: Some(now()?),
        },
        cancelled,
        deadline,
    )?;
    let mut scan = observation.scan().clone();
    let rows = scan["rows"]
        .as_array_mut()
        .ok_or("native_batch_operator_inventory_shape_invalid")?;
    if let Some(profile) = &options.quality_profile {
        for row in rows.iter_mut() {
            check(cancelled, deadline)?;
            row["task"] = crate::native_inventory::bind_native_inventory_task_quality_profile_v1(
                &row["task"],
                profile,
            )?;
        }
    }
    let target = scope::build(options, &scan)?;
    let mut result_budget = budget::ResultsBudgetV1::new(&scan, &target, cancelled, deadline)?;
    let mut results = Vec::new();
    for row in scan["rows"]
        .as_array()
        .ok_or("native_batch_operator_inventory_shape_invalid")?
    {
        check(cancelled, deadline)?;
        observation.verify_unchanged()?;
        let source = row["sourceDir"].as_str().filter(|s| !s.is_empty());
        let command = if target["status"] == "target_scope_verified" && source.is_some() {
            Some(build_native_batch_campaign_command_v1(
                &NativeBatchCampaignCommandInputV1 {
                    version: 1,
                    paper_task: row["task"].clone(),
                    paper_state: Some(row["state"].clone()),
                    source_workspace: source.unwrap_or_default().to_owned(),
                    options: options.clone(),
                    target_scope_receipt: target.clone(),
                },
            )?)
        } else {
            None
        };
        result_budget.reserve_before_result_clone(row, command.as_ref(), cancelled, deadline)?;
        let recorded = now()?;
        results.push(report::result(
            row,
            command.as_ref(),
            &options.mode,
            &recorded,
        )?);
        observation.verify_unchanged()?;
    }
    observation.verify_unchanged()?;
    let provenance =
        crate::operational_status::current_operational_code_provenance_with_deadline_v1(
            workspace, cancelled, deadline,
        )
        .map_err(|e| e.to_string())?;
    check(cancelled, deadline)?;
    let result = report::build(options, &scan, &results, target, provenance, &now()?)?;
    observation.verify_unchanged()?;
    let report_wire = report::bounded_pretty_json(&result)?;
    // Release the immutable business input observation only after its final
    // proof. Local report publication legitimately creates runtime entries; it
    // has no business-store, release, submission or provider authority handle.
    drop(observation);
    if options.write_report {
        check(cancelled, deadline)?;
        crate::batch_local_reports::persist_native_local_batch_report_v1(
            &runtime,
            &report_wire,
            cancelled,
            deadline,
        )?;
    }
    Ok(result)
}

#[cfg(test)]
pub(crate) mod tests;

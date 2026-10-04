//! Ordinary historical status over the existing append-only one-shot journal.
//! The report contains recovery diagnostics, never a journal action permit.
mod audit;
mod binding;
mod contract;
pub mod dataset;
pub mod execution;
pub mod execution_inputs;
pub mod full_graph;
mod inputs;
mod journal;
mod json;
mod preflight;
mod recovery;

use crate::{
    automation_runtime_reconciliation::ordinary::ReconciliationReadControlV1,
    canonical_cli::resolve_canonical_cli_arguments_v1,
    native_workspace::current_native_command_workspace_root_v1,
    ordinary_readonly_frontend::OrdinaryReadonlyOutputV1,
    runtime_source_cas::observation::SourceObservation,
};
use hepta_legacy_compatibility::{
    ProductionJsonEncodingLimitsV1, parse_production_json_v1, production_json_pretty_with_limits_v1,
};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::{Duration, Instant},
};

const MAX_OUTPUT: usize = 4 * 1024 * 1024;
const JOURNAL_NAME: &str = "campaign-one-shot-attempt.sqlite";

fn path_from(base: &Path, selected: &str) -> Result<PathBuf, String> {
    let base = base.to_str().ok_or("one_shot_status_utf8_path_required")?;
    Ok(PathBuf::from(crate::workspace_status::resolve(
        base, selected,
    )))
}
fn common_parent(left: &Path, right: &Path) -> Result<PathBuf, String> {
    let mut selected = left.to_owned();
    while !right.starts_with(&selected) {
        if !selected.pop() {
            return Err("campaign_one_shot_attempt_journal_path_invalid".into());
        }
    }
    Ok(selected)
}
fn path_refusal(error: String, code: &str) -> String {
    if error == "r_runtime_source_cas_input_invalid"
        || error.starts_with("r_runtime_source_cas_unavailable:")
    {
        code.to_owned()
    } else {
        error
    }
}
fn wire(
    value: &hepta_legacy_compatibility::ProductionJsonValue,
    control: &ReconciliationReadControlV1,
) -> Result<Vec<u8>, String> {
    control.checkpoint().map_err(|error| error.to_string())?;
    let mut bytes = production_json_pretty_with_limits_v1(
        value,
        ProductionJsonEncodingLimitsV1 {
            maximum_bytes: MAX_OUTPUT - 1,
            maximum_values: MAX_OUTPUT,
            maximum_utf16_units: MAX_OUTPUT,
        },
        &control.cancelled,
    )
    .map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    control.checkpoint().map_err(|error| error.to_string())?;
    Ok(bytes)
}

pub fn inspect_ordinary_one_shot_status_v1(
    argv: &[String],
    cancelled: Arc<AtomicBool>,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    inspect_ordinary_one_shot_with_serializer(argv, cancelled, wire)
}

fn inspect_ordinary_one_shot_with_serializer(
    argv: &[String],
    cancelled: Arc<AtomicBool>,
    serialize: impl FnOnce(
        &hepta_legacy_compatibility::ProductionJsonValue,
        &ReconciliationReadControlV1,
    ) -> Result<Vec<u8>, String>,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    if argv.len() > 32
        || argv
            .iter()
            .try_fold(0usize, |used, arg| used.checked_add(arg.len()))
            .is_none_or(|used| used > 64 * 1024)
    {
        return Err("one_shot_status_argument_limit_exceeded".into());
    }
    let wrapped = [
        "operator".to_owned(),
        "autonomous-research-one-shot-campaign-attempt".to_owned(),
        "--".to_owned(),
    ]
    .into_iter()
    .chain(argv.iter().cloned())
    .collect::<Vec<_>>();
    resolve_canonical_cli_arguments_v1(&wrapped)?;
    let deadline = Instant::now()
        .checked_add(Duration::from_secs(120))
        .ok_or("one_shot_status_deadline_invalid")?;
    run_with_serializer(argv, cancelled, deadline, serialize)
}

#[cfg(test)]
fn run(
    argv: &[String],
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    run_with_serializer(argv, cancelled, deadline, wire)
}

fn run_with_serializer(
    argv: &[String],
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
    serialize: impl FnOnce(
        &hepta_legacy_compatibility::ProductionJsonValue,
        &ReconciliationReadControlV1,
    ) -> Result<Vec<u8>, String>,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    let control = ReconciliationReadControlV1::new(cancelled.clone(), deadline);
    control.checkpoint().map_err(|error| error.to_string())?;
    let mut action = "status";
    let mut attempt = None;
    let mut runtime = None;
    let mut selected_control = None;
    let mut mount_file = None;
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        if token == "--help" {
            contract::contract()?;
            // Keep the original generated property order for raw help wire.
            let facts =
                parse_production_json_v1(include_bytes!("ordinary_one_shot/contract.v1.json"))
                    .map_err(|error| error.to_string())?;
            let usage = json::field(&facts, "usage");
            return Ok(OrdinaryReadonlyOutputV1 {
                stdout: serialize(usage, &control)?,
                stderr: Vec::new(),
                exit_code: 0,
            });
        }
        let (name, value) = token.split_once('=').unwrap_or_else(|| {
            index += 1;
            (token.as_str(), argv.get(index).map_or("", String::as_str))
        });
        match name {
            "--action" => action = value,
            "--attempt-id" => attempt = Some(value),
            "--runtime-root" => runtime = Some(value),
            "--control-root" => selected_control = Some(value),
            "--dataset-mount-file" => mount_file = Some(value),
            _ => {}
        }
        index += 1;
    }
    if !matches!(action, "plan" | "preflight" | "execute" | "status") {
        return Err(format!(
            "autonomous_research_one_shot_action_invalid:{action}"
        ));
    }
    if action == "status" && attempt.filter(|value| !value.is_empty()).is_none() {
        return Err("autonomous_research_one_shot_attempt_id_required".into());
    }
    let base = current_native_command_workspace_root_v1(None)?;
    let runtime = match runtime {
        Some(value) => path_from(&base, value)?,
        None => match std::env::var("HEPTA_PAPER_RUNTIME_ROOT")
            .ok()
            .filter(|value| !value.is_empty())
        {
            Some(value) => path_from(&base, &value)?,
            None => base
                .parent()
                .unwrap_or(&base)
                .join("hepta-paper-runtime/native-runtime"),
        },
    };
    let selected_control = match selected_control {
        Some(value) => path_from(&base, value)?,
        None => runtime
            .parent()
            .unwrap_or(&runtime)
            .join("one-shot-campaign-control"),
    };
    if matches!(action, "plan" | "preflight") {
        return preflight::run(
            &base,
            &runtime,
            &selected_control,
            mount_file,
            action,
            &control,
            serialize,
        );
    }
    if action == "execute" {
        preflight::load_dataset_mounts(&base, mount_file, &control)?;
        return Err("native_one_shot_ordinary_execute_not_implemented".into());
    }
    let attempt = attempt.ok_or("autonomous_research_one_shot_attempt_id_required")?;
    let stdout =
        inspect_with_serializer(&runtime, &selected_control, attempt, &control, serialize)?;
    Ok(OrdinaryReadonlyOutputV1 {
        stdout,
        stderr: Vec::new(),
        exit_code: 0,
    })
}

/// Private diagnostic projection and its original filesystem observation.
/// This contains no action permit and has no serialized or caller constructor.
struct ObservedOneShotJournalReportV1<'a> {
    report: hepta_legacy_compatibility::ProductionJsonValue,
    retained: SourceObservation<'a>,
}
impl ObservedOneShotJournalReportV1<'_> {
    fn assert_current(&self, control: &ReconciliationReadControlV1) -> Result<(), String> {
        self.retained
            .require_control_context_v1(&control.cancelled, control.deadline)?;
        self.retained.assert_current()?;
        control.checkpoint().map_err(|error| error.to_string())
    }
    fn project_recovery<T>(
        &self,
        control: &ReconciliationReadControlV1,
        project: impl FnOnce(recovery::ObservedRecoveryV1<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        self.assert_current(control)?;
        let result = recovery::ObservedRecoveryV1::from_audited(&self.report).and_then(project);
        self.assert_current(control)?;
        result
    }
}
fn inspect_with_serializer(
    runtime: &Path,
    control_root: &Path,
    attempt: &str,
    control: &ReconciliationReadControlV1,
    serialize: impl FnOnce(
        &hepta_legacy_compatibility::ProductionJsonValue,
        &ReconciliationReadControlV1,
    ) -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    let report = inspect_report(runtime, control_root, Some(attempt), control, &mut false)?;
    report.project_recovery(control, |value| serialize(value.report(), control))
}

fn inspect_report<'a>(
    runtime: &Path,
    control_root: &Path,
    attempt: Option<&str>,
    control: &'a ReconciliationReadControlV1,
    inspected: &mut bool,
) -> Result<ObservedOneShotJournalReportV1<'a>, String> {
    control.checkpoint().map_err(|error| error.to_string())?;
    if runtime.starts_with(control_root) || control_root.starts_with(runtime) {
        return Err("campaign_one_shot_attempt_journal_path_invalid".into());
    }
    let root = common_parent(runtime, control_root)?;
    let mut retained =
        SourceObservation::new_with_deadline(&root, &control.cancelled, control.deadline).map_err(
            |error| path_refusal(error, "campaign_one_shot_attempt_runtime_root_invalid"),
        )?;
    if retained.root() != root {
        return Err("campaign_one_shot_attempt_runtime_root_invalid".into());
    }
    let runtime_relative = runtime
        .strip_prefix(&root)
        .map_err(|_| "campaign_one_shot_attempt_journal_path_invalid")?;
    let runtime_metadata = retained
        .inventory_probe(runtime_relative)
        .map_err(|error| path_refusal(error, "campaign_one_shot_attempt_runtime_root_invalid"))?;
    if !runtime_metadata.is_some_and(|metadata| metadata.directory) {
        return Err("campaign_one_shot_attempt_runtime_root_invalid".into());
    }
    let control_relative = control_root
        .strip_prefix(&root)
        .map_err(|_| "campaign_one_shot_attempt_journal_path_invalid")?;
    let present = retained
        .one_shot_private_directory_v1(control_relative)
        .map_err(|error| path_refusal(error, "campaign_one_shot_attempt_control_root_invalid"))?;
    if !present {
        retained.assert_current()?;
        *inspected = true;
        return match attempt {
            Some(_) => Err("autonomous_research_one_shot_attempt_missing".into()),
            None => Ok(ObservedOneShotJournalReportV1 {
                report: hepta_legacy_compatibility::ProductionJsonValue::Null,
                retained,
            }),
        };
    }
    let relative = control_relative.join(JOURNAL_NAME);
    let present = retained
        .one_shot_journal_present_v1(&relative)
        .map_err(|error| path_refusal(error, "campaign_one_shot_attempt_journal_file_invalid"))?;
    if !present {
        retained.assert_current()?;
        *inspected = true;
        return match attempt {
            Some(_) => Err("autonomous_research_one_shot_attempt_missing".into()),
            None => Ok(ObservedOneShotJournalReportV1 {
                report: hepta_legacy_compatibility::ProductionJsonValue::Null,
                retained,
            }),
        };
    }
    for suffix in ["-journal", "-wal", "-shm"] {
        if retained
            .inventory_probe(&control_relative.join(format!("{JOURNAL_NAME}{suffix}")))
            .map_err(|_| "campaign_one_shot_attempt_journal_sidecar_forbidden")?
            .is_some()
        {
            return Err("campaign_one_shot_attempt_journal_sidecar_forbidden".into());
        }
    }
    *inspected = true;
    retained.require_control_context_v1(&control.cancelled, control.deadline)?;
    let bytes = retained
        .one_shot_journal_bytes_v1(&relative)?
        .ok_or("campaign_one_shot_attempt_journal_path_identity_changed")?;
    let report = match attempt {
        Some(attempt) => journal::inspect(&bytes, attempt, control)?,
        None => journal::inspect_target(&bytes, control)?,
    };
    // Move the exact original observation with its audited diagnostic value.
    // The consumer retains it through its bounded serializer and final guards.
    retained.assert_current()?;
    retained.require_control_context_v1(&control.cancelled, control.deadline)?;
    control.checkpoint().map_err(|error| error.to_string())?;
    Ok(ObservedOneShotJournalReportV1 { report, retained })
}

#[cfg(test)]
mod tests;

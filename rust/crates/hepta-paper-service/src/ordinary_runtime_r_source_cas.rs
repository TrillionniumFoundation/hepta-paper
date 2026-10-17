//! Original normal R source CAS status grammar, paths, report and exit behavior.
use crate::{
    canonical_cli::resolve_canonical_cli_arguments_v1,
    native_workspace::{
        current_native_command_workspace_root_v1, resolve_native_workspace_root_v1,
    },
    ordinary_readonly_frontend::OrdinaryReadonlyOutputV1,
    runtime_source_cas::ordinary_status::{RetainedStatusV1, inspect_retained_status_v1},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    io::Write,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const USAGE: &str = "Usage: hepta-paper operator runtime-r-source-cas -- --action status|acquire [options]\n\n  status             Read-only exact-closure and SHA-256 verification (default).\n  acquire            Atomically acquire every renv.lock source archive.\n  --seed PATH        Reuse a read-only directory of previously downloaded tarballs.\n  --concurrency N    Maximum concurrent network downloads for missing archives.\n  --root PATH        Repository root.";
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

// Preserve the incumbent's JSON property order as well as the complete value.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusReport<'a> {
    ready: &'a Value,
    status: &'a Value,
    manifest_hash: &'a Value,
    package_count: &'a Value,
    lockfile_hash: &'a Value,
    definition_paths: &'a Value,
    blockers: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    acquired: Option<bool>,
}
struct BoundedReportWriter<'a> {
    bytes: Vec<u8>,
    observed: &'a RetainedStatusV1<'a>,
    cancelled: &'a AtomicBool,
    deadline: Instant,
}
fn active(cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("r_runtime_source_cas_cancelled".into());
    }
    if Instant::now() >= deadline {
        return Err("native_inventory_deadline_exceeded".into());
    }
    Ok(())
}
impl Write for BoundedReportWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        active(self.cancelled, self.deadline).map_err(std::io::Error::other)?;
        let next = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .filter(|n| *n < MAX_OUTPUT_BYTES)
            .ok_or_else(|| std::io::Error::other("r_runtime_source_cas_output_limit_exceeded"))?;
        self.bytes.reserve(next - self.bytes.len());
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub fn inspect_ordinary_runtime_r_source_cas_v1(
    argv: &[String],
    cancelled: Arc<AtomicBool>,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    if argv.len() > 32
        || argv
            .iter()
            .try_fold(0usize, |sum, value| sum.checked_add(value.len()))
            .is_none_or(|sum| sum > 64 * 1024)
    {
        return Err("r_runtime_source_cas_argument_limit_exceeded".into());
    }
    let wrapped = [
        "operator".to_owned(),
        "runtime-r-source-cas".to_owned(),
        "--".to_owned(),
    ]
    .into_iter()
    .chain(argv.iter().cloned())
    .collect::<Vec<_>>();
    resolve_canonical_cli_arguments_v1(&wrapped)?;
    let deadline = Instant::now()
        .checked_add(Duration::from_secs(120))
        .ok_or("r_runtime_source_cas_deadline_invalid")?;
    run(argv, &cancelled, deadline)
}
fn run(
    argv: &[String],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    active(cancelled, deadline)?;
    let mut selected_root = None;
    let mut action = "status";
    let mut seed = None;
    let mut concurrency = "6";
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        if token == "--help" {
            // Complete grammar was validated before help, without reading ROOT.
            return Ok(OrdinaryReadonlyOutputV1 {
                stdout: format!("{USAGE}\n").into_bytes(),
                stderr: Vec::new(),
                exit_code: 0,
            });
        }
        let (key, value) = token.split_once('=').unwrap_or_else(|| {
            index += 1;
            (token.as_str(), argv.get(index).map_or("", String::as_str))
        });
        if key == "--action" {
            action = value;
        }
        if key == "--seed" {
            seed = Some(value);
        }
        if key == "--concurrency" {
            concurrency = value;
        }
        if key == "--root" {
            selected_root = Some(value);
        }
        // The incumbent status ignores seed and concurrency completely, including
        // nonnumeric values. Do not accidentally run acquisition validation here.
        index += 1;
    }
    if !matches!(action, "status" | "acquire") {
        return Err(format!("r_runtime_source_cas_action_invalid:{action}"));
    }
    active(cancelled, deadline)?;
    let base = current_native_command_workspace_root_v1(None)?;
    let root = match selected_root {
        Some(value) => resolve_native_workspace_root_v1(&base, &base, Some(Path::new(value)))?,
        None => base.clone(),
    };
    let acquisition_context = if action == "acquire" {
        Some(
            crate::runtime_source_cas::ordinary_status::retain_acquisition_context_v1(
                &root, cancelled, deadline,
            )?,
        )
    } else {
        None
    };
    let selected_concurrency = if action == "acquire" {
        let number =
            crate::automation_runtime_reconciliation::sqlite_number::string_number(concurrency)
                .unwrap_or(f64::NAN);
        if !number.is_finite() || number.fract() != 0.0 || !(1.0..=16.0).contains(&number) {
            return Err("r_runtime_source_cas_concurrency_invalid".into());
        }
        Some(number as usize)
    } else {
        None
    };
    let acquired = if let Some(concurrency) = selected_concurrency {
        let seed = seed
            .map(|value| resolve_native_workspace_root_v1(&base, &base, Some(Path::new(value))))
            .transpose()?;
        let result = crate::runtime_source_cas::acquire_runtime_source_cas_mixed_with_control_v1(
            &root,
            seed.as_deref(),
            concurrency,
            cancelled,
            deadline,
        )?;
        Some(result["acquired"] == Value::Bool(true))
    } else {
        None
    };
    let observed = inspect_retained_status_v1(&root, cancelled, deadline)?;
    let report = &observed.report;
    let ordered = StatusReport {
        ready: &report["ready"],
        status: &report["status"],
        manifest_hash: &report["manifestHash"],
        package_count: &report["packageCount"],
        lockfile_hash: &report["lockfileHash"],
        definition_paths: &report["definitionPaths"],
        blockers: &report["blockers"],
        acquired,
    };
    let mut writer = BoundedReportWriter {
        bytes: Vec::new(),
        observed: &observed,
        cancelled,
        deadline,
    };
    serde_json::to_writer_pretty(&mut writer, &ordered).map_err(|error| error.to_string())?;
    writer.observed.assert_current()?;
    if let Some(context) = &acquisition_context {
        context.assert_current()?;
    }
    active(cancelled, deadline)?;
    writer.bytes.push(b'\n');
    Ok(OrdinaryReadonlyOutputV1 {
        stdout: writer.bytes,
        stderr: Vec::new(),
        exit_code: if report["ready"] == Value::Bool(true) {
            0
        } else {
            1
        },
    })
}

#[cfg(test)]
mod tests;

//! Ordinary passive reconciliation. Grammar and filesystem selection stay
//! separate from writer/apply admission; the original planner owns all results.
use crate::{
    automation_runtime_reconciliation::{
        LocalReconciliationOperationV1,
        ordinary::{
            MAX_OUTPUT_BYTES, ReconciliationReadControlV1, inspect_current_with_control_v1,
        },
    },
    canonical_cli::resolve_canonical_cli_arguments_v1,
    native_workspace::{
        current_native_command_workspace_root_v1, resolve_native_workspace_root_v1,
    },
    ordinary_readonly_frontend::OrdinaryReadonlyOutputV1,
};
use std::{
    io::Write,
    path::Path,
    sync::{Arc, atomic::AtomicBool},
    time::{Duration, Instant},
};

struct ReportWriter<'a> {
    bytes: Vec<u8>,
    control: &'a ReconciliationReadControlV1,
}
impl Write for ReportWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.control.checkpoint().map_err(std::io::Error::other)?;
        let next = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .filter(|n| *n < MAX_OUTPUT_BYTES)
            .ok_or_else(|| {
                std::io::Error::other("automation_reconciliation_output_limit_exceeded")
            })?;
        self.bytes.reserve(next - self.bytes.len());
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub fn inspect_ordinary_reconcile_v1(
    argv: &[String],
    cancelled: Arc<AtomicBool>,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    let wrapped = [
        "operator".to_owned(),
        "reconcile".to_owned(),
        "--".to_owned(),
    ]
    .into_iter()
    .chain(argv.iter().cloned())
    .collect::<Vec<_>>();
    resolve_canonical_cli_arguments_v1(&wrapped)?;
    let deadline = Instant::now()
        .checked_add(Duration::from_secs(120))
        .ok_or("automation_reconciliation_deadline_invalid")?;
    let control = ReconciliationReadControlV1::new(cancelled, deadline);
    control.checkpoint().map_err(|error| error.to_string())?;
    let mut campaign = None;
    let mut legacy = false;
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        if token == "--legacy-terminal-active-residue" {
            legacy = true;
        } else if let Some(value) = token.strip_prefix("--campaign-id=") {
            campaign = Some(value);
        } else if token == "--campaign-id" {
            index += 1;
            campaign = argv.get(index).map(String::as_str);
        }
        index += 1;
    }
    let root = current_native_command_workspace_root_v1(None)?;
    let runtime = match std::env::var("HEPTA_PAPER_RUNTIME_ROOT") {
        Ok(value) if !value.is_empty() => {
            resolve_native_workspace_root_v1(&root, Path::new(&value), None)?
        }
        Ok(_) | Err(std::env::VarError::NotPresent) => root
            .parent()
            .unwrap_or(&root)
            .join("hepta-paper-runtime/native-runtime"),
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err("automation_reconciliation_runtime_encoding_invalid".into());
        }
    };
    let database = runtime.join("hepta-paper.sqlite");
    // The incumbent refuses a missing store before planning, without creating
    // a runtime directory. Keep its observable message in the ordinary facade.
    if !database.try_exists().map_err(|error| error.to_string())? {
        return Err(format!(
            "Read-only paper store missing: {}",
            database.display()
        ));
    }
    let operation = if legacy {
        LocalReconciliationOperationV1::LegacyTerminalActiveResidue
    } else {
        LocalReconciliationOperationV1::Standard
    };
    let (report, retained) =
        inspect_current_with_control_v1(&database, campaign, operation, &control)
            .map_err(|error| error.to_string())?;
    let mut output = ReportWriter {
        bytes: Vec::new(),
        control: &control,
    };
    serde_json::to_writer_pretty(&mut output, &report).map_err(|error| {
        control
            .checkpoint()
            .err()
            .map_or_else(|| error.to_string(), |error| error.to_string())
    })?;
    control.checkpoint().map_err(|error| error.to_string())?;
    retained
        .verify_unchanged()
        .map_err(|error| error.to_string())?;
    control.checkpoint().map_err(|error| error.to_string())?;
    output.bytes.push(b'\n');
    Ok(OrdinaryReadonlyOutputV1 {
        stdout: output.bytes,
        stderr: Vec::new(),
        exit_code: 0,
    })
}

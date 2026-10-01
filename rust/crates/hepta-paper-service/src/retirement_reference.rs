//! Bounded read-only verification of the immutable legacy source snapshot.
mod files;
use files::{ReferenceRoot, RetainedFile};
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use thiserror::Error;
#[derive(Debug, Error)]
pub enum RetirementReferenceError {
    #[error("retirement reference filesystem operation failed")]
    Io(#[from] std::io::Error),
    #[error("retirement reference JSON is invalid")]
    Json(#[from] serde_json::Error),
    #[error("retirement_reference_{0}")]
    Refused(&'static str),
}
type Result<T> = std::result::Result<T, RetirementReferenceError>;
const MAX_JSON_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 4 * MAX_ARCHIVE_BYTES;
const MAX_ARCHIVES: usize = 128;
const MAX_IMMUTABLE_FILES: usize = 256;
pub(super) struct Budget<'a> {
    cancelled: &'a AtomicBool,
    deadline: Instant,
    remaining: u64,
}
impl Budget<'_> {
    fn current(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(RetirementReferenceError::Refused("cancelled"));
        }
        if Instant::now() >= self.deadline {
            return Err(RetirementReferenceError::Refused("deadline_exceeded"));
        }
        Ok(())
    }
    fn consume(&mut self, bytes: u64) -> Result<()> {
        self.current()?;
        self.remaining =
            self.remaining
                .checked_sub(bytes)
                .ok_or(RetirementReferenceError::Refused(
                    "total_read_limit_exceeded",
                ))?;
        Ok(())
    }
}
fn read_json(
    root: &ReferenceRoot,
    name: &str,
    blockers: &mut Vec<String>,
    missing: &str,
    budget: &mut Budget<'_>,
    retained: &mut Vec<RetainedFile>,
) -> Result<Option<Value>> {
    let Some(mut file) = root.open(name)? else {
        blockers.push(missing.into());
        return Ok(None);
    };
    let bytes = file.read_bytes(MAX_JSON_BYTES, budget)?;
    // Reuse the existing duplicate-free parser without authority construction.
    let value = crate::sqlite_mutation_coordinator::authority::files::parse(&bytes, missing).ok();
    if value.is_none() {
        blockers.push(missing.into());
    }
    retained.push(file);
    Ok(value)
}
fn items<'a>(
    value: Option<&'a Value>,
    field: &str,
    maximum: usize,
    missing: &str,
    blockers: &mut Vec<String>,
) -> Option<&'a [Value]> {
    let value = value?;
    let Some(items) = value.get(field).and_then(Value::as_array) else {
        blockers.push(missing.into());
        return None;
    };
    if items.len() > maximum {
        blockers.push(missing.into());
        return None;
    }
    Some(items)
}
fn name(item: &Value, seen: &mut BTreeSet<String>) -> Result<String> {
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .ok_or(RetirementReferenceError::Refused("receipt_name_invalid"))?;
    ReferenceRoot::validate_name(name)?;
    if !seen.insert(name.into()) {
        return Err(RetirementReferenceError::Refused("receipt_name_duplicated"));
    }
    Ok(name.into())
}
fn immutable_attribute(
    root: &ReferenceRoot,
    selected: &RetainedFile,
    budget: &mut Budget<'_>,
) -> Result<Option<bool>> {
    budget.current()?;
    let mut tool = RetainedFile::absolute(Path::new("/usr/bin/lsattr"))?;
    tool.assert_system_executable()?;
    tool.hash(16 * 1024 * 1024, budget)?;
    let environment = EnvironmentPolicyV1::new(
        "retirement-reference-attributes-v1",
        ["PATH", "LC_ALL"],
        ["PATH", "LC_ALL"],
    )
    .map_err(|_| RetirementReferenceError::Refused("environment_invalid"))?
    .build(
        std::iter::empty::<(OsString, OsString)>(),
        &BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LC_ALL".into(), "C".into()),
        ]),
    )
    .map_err(|_| RetirementReferenceError::Refused("environment_invalid"))?;
    selected.assert_current()?;
    root.assert_current()?;
    let result = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: "/usr/bin/lsattr".into(),
            arguments: vec!["-d".into(), "--".into(), selected.path().as_os_str().into()],
            working_directory: root.path().into(),
            environment,
            stdin: None,
        },
        ProcessLimitsV1 {
            timeout_ms: u64::try_from(
                budget
                    .deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis(),
            )
            .unwrap_or(30_000)
            .clamp(1, 30_000),
            termination_grace_ms: 250,
            cleanup_timeout_ms: 5_000,
            maximum_stdin_bytes: 1,
            maximum_stdout_bytes: 65_536,
            maximum_stderr_bytes: 65_536,
            maximum_tail_bytes: 4096,
            ..ProcessLimitsV1::default()
        },
        budget.cancelled,
    )
    .map_err(|_| RetirementReferenceError::Refused("attributes_process_failed"))?;
    budget.current()?;
    tool.assert_current()?;
    selected.assert_current()?;
    root.assert_current()?;
    let process = result.process;
    if !process.process_group_cleanup_verified
        || process.termination_reason != ProcessTerminationReason::Exited
    {
        return Err(RetirementReferenceError::Refused(
            "attributes_outcome_unknown",
        ));
    }
    if process.exit_code != Some(0) || process.signal.is_some() {
        return Ok(None);
    }
    Ok(std::str::from_utf8(&result.stdout)
        .ok()
        .and_then(|value| value.split_whitespace().next())
        .map(|attributes| attributes.contains('i')))
}
/// Valid V1 reports remain compatible with Node. Unsafe names, changed inputs,
/// unbounded reads and unknown process outcomes refuse. No capability is minted.
pub fn verify_retirement_reference_v1(root: &Path) -> Result<Value> {
    verify_retirement_reference_with_cancellation_v1(root, &AtomicBool::new(false))
}
pub fn verify_retirement_reference_with_cancellation_v1(
    root: &Path,
    cancelled: &AtomicBool,
) -> Result<Value> {
    let mut budget = Budget {
        cancelled,
        deadline: Instant::now() + Duration::from_secs(120),
        remaining: MAX_TOTAL_BYTES,
    };
    budget.current()?;
    let observation = ReferenceRoot::load(root)?;
    let mut retained = Vec::new();
    let mut blockers = Vec::new();
    let receipt = read_json(
        &observation,
        "RETIREMENT_SOURCE_SNAPSHOT_RECEIPT.json",
        &mut blockers,
        "retirement_snapshot_receipt_missing_or_invalid",
        &mut budget,
        &mut retained,
    )?;
    let immutable = read_json(
        &observation,
        "IMMUTABILITY_RECEIPT.json",
        &mut blockers,
        "immutability_receipt_missing_or_invalid",
        &mut budget,
        &mut retained,
    )?;
    let mut seen = BTreeSet::new();
    if let Some(archives) = items(
        receipt.as_ref(),
        "archives",
        MAX_ARCHIVES,
        "retirement_snapshot_receipt_missing_or_invalid",
        &mut blockers,
    ) {
        for archive in archives {
            budget.current()?;
            let name = name(archive, &mut seen)?;
            let expected = archive
                .get("sha256")
                .and_then(Value::as_str)
                .filter(|s| {
                    s.len() == 71
                        && s.starts_with("sha256:")
                        && s[7..]
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
                .ok_or(RetirementReferenceError::Refused("receipt_hash_invalid"))?;
            let expected_size = archive
                .get("bytes")
                .and_then(Value::as_u64)
                .filter(|n| *n <= MAX_ARCHIVE_BYTES)
                .ok_or(RetirementReferenceError::Refused("receipt_size_invalid"))?;
            let Some(mut file) = observation.open(&name)? else {
                blockers.push(format!("archive_missing:{name}"));
                continue;
            };
            if file.size() != expected_size {
                blockers.push(format!("archive_size_mismatch:{name}"));
            }
            if file.hash(MAX_ARCHIVE_BYTES, &mut budget)? != expected {
                blockers.push(format!("archive_hash_mismatch:{name}"));
            }
            retained.push(file);
        }
    }
    seen.clear();
    if let Some(files) = items(
        immutable.as_ref(),
        "files",
        MAX_IMMUTABLE_FILES,
        "immutability_receipt_missing_or_invalid",
        &mut blockers,
    ) {
        for item in files {
            let name = name(item, &mut seen)?;
            let Some(file) = observation.open(&name)? else {
                continue;
            };
            match immutable_attribute(&observation, &file, &mut budget)? {
                Some(true) => (),
                Some(false) => blockers.push(format!("archive_not_immutable:{name}")),
                None => blockers.push(format!("archive_immutability_unverifiable:{name}")),
            }
            retained.push(file);
        }
    }
    for file in &retained {
        file.assert_current()?;
    }
    observation.assert_current()?;
    budget.current()?;
    Ok(json!({
        "version": 1, "kind": "LegacyRetirementReferenceVerification",
        "status": if blockers.is_empty() { "retirement_reference_verified" } else { "retirement_reference_blocked" },
        "referenceRoot": root, "runtimeDependencyAllowed": false,
        "liveLegacyRootExists": Path::new("/data/home-data/paper_factory").exists(),
        "archiveCount": receipt.as_ref().and_then(|v| v.get("archives")).and_then(Value::as_array).map_or(0, Vec::len),
        "blockers": blockers,
    }))
}

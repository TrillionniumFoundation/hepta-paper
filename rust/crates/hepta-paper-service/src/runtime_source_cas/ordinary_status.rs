//! Retained ordinary status using the original CAS validator and filesystem owner.
use super::{blocked, inspect_observed_status_v1, observation::SourceObservation, require_active};
use serde_json::Value;
use std::{fs, path::Path, sync::atomic::AtomicBool, time::Instant};

pub(crate) struct RetainedStatusV1<'a> {
    pub(crate) report: Value,
    observed: SourceObservation<'a>,
}
impl RetainedStatusV1<'_> {
    pub(crate) fn assert_current(&self) -> Result<(), String> {
        self.observed.assert_current()
    }
}

// The original normal composition constructs its repository before validating
// acquisition concurrency. Retain only that context, without reading the lock.
pub(crate) struct RetainedAcquisitionContextV1<'a> {
    observed: SourceObservation<'a>,
}
impl RetainedAcquisitionContextV1<'_> {
    pub(crate) fn assert_current(&self) -> Result<(), String> {
        self.observed.assert_current()
    }
}
pub(crate) fn retain_acquisition_context_v1<'a>(
    root: &Path,
    cancelled: &'a AtomicBool,
    deadline: Instant,
) -> Result<RetainedAcquisitionContextV1<'a>, String> {
    let (observed, missing) = context_observation(
        &root.join("runtime-images/r-scientific"),
        cancelled,
        deadline,
    )?;
    observed.assert_current()?;
    if let Some(blocker) = missing {
        return Err(blocker
            .strip_prefix("r_runtime_source_cas_unavailable:")
            .unwrap_or(&blocker)
            .to_owned());
    }
    Ok(RetainedAcquisitionContextV1 { observed })
}

fn context_observation<'a>(
    context: &Path,
    cancelled: &'a AtomicBool,
    deadline: Instant,
) -> Result<(SourceObservation<'a>, Option<String>), String> {
    require_active(cancelled)?;
    if Instant::now() >= deadline {
        return Err("native_inventory_deadline_exceeded".into());
    }
    match fs::canonicalize(context) {
        Ok(_) => Ok((
            SourceObservation::new_with_deadline(context, cancelled, deadline)?,
            None,
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Selection only; all actual missing-edge and named/held namespace
            // observation is delegated to the existing bounded inventory owner.
            let mut ancestor = context
                .parent()
                .ok_or("r_runtime_source_cas_input_invalid")?;
            for _ in 0..64 {
                require_active(cancelled)?;
                if Instant::now() >= deadline {
                    return Err("native_inventory_deadline_exceeded".into());
                }
                match fs::canonicalize(ancestor) {
                    Ok(_) => {
                        let relative = context
                            .strip_prefix(ancestor)
                            .map_err(|_| "r_runtime_source_cas_input_invalid")?;
                        let mut observed =
                            SourceObservation::new_with_deadline(ancestor, cancelled, deadline)?;
                        if observed.inventory_probe(relative)?.is_some() {
                            return Err("r_runtime_source_cas_input_changed".into());
                        }
                        observed.assert_current()?;
                        let missing = observed
                            .status_missing_edge_v1()
                            .ok_or("r_runtime_source_cas_input_changed")?;
                        let blocker = format!(
                            "r_runtime_source_cas_unavailable:ENOENT: no such file or directory, lstat '{}'",
                            missing.display()
                        );
                        return Ok((observed, Some(blocker)));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        ancestor = ancestor
                            .parent()
                            .ok_or("r_runtime_source_cas_input_invalid")?;
                    }
                    Err(error) => return Err(format!("r_runtime_source_cas_unavailable:{error}")),
                }
            }
            Err("r_runtime_source_cas_observation_limit_exceeded".into())
        }
        Err(error) => Err(format!("r_runtime_source_cas_unavailable:{error}")),
    }
}

pub(crate) fn inspect_retained_status_v1<'a>(
    repository_root: &Path,
    cancelled: &'a AtomicBool,
    deadline: Instant,
) -> Result<RetainedStatusV1<'a>, String> {
    let context = repository_root.join("runtime-images/r-scientific");
    let (mut observed, missing) = context_observation(&context, cancelled, deadline)?;
    let report = match missing {
        Some(blocker) => blocked(blocker),
        None => inspect_observed_status_v1(&mut observed, &mut || {}, true).unwrap_or_else(blocked),
    };
    // Even a valid blocked report retains the exact observed input/absence epoch.
    // Cancellation/deadline/drift remains an operation refusal, never readiness.
    observed.assert_current()?;
    Ok(RetainedStatusV1 { report, observed })
}

#[cfg(test)]
mod tests;

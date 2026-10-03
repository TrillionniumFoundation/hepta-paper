//! Original mixed-seed orchestration over the existing bounded archive owner.
//! All workers join before cleanup/publication; results retain lockfile order.
use super::{
    ArchiveExecution, MAX_ARCHIVE_BYTES, SourceObservation, Value, copy_seed_archive_with_control,
    require_acquisition_active, verify_seed_archive,
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    time::Instant,
};

mod manifest_wire;
pub(super) use manifest_wire::encode as encode_manifest;

const TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const NETWORK_CAPTURE_BYTES: u64 = 63 * 1024 * 1024 + 1024;
struct BytesBudget {
    occupied: AtomicU64,
}
struct Reservation<'a> {
    budget: &'a BytesBudget,
    reserved: u64,
    committed: bool,
}
impl BytesBudget {
    fn reserve(&self, bytes: u64) -> Result<Reservation<'_>, String> {
        self.occupied
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes).filter(|used| *used <= TOTAL_BYTES)
            })
            .map_err(|_| "r_runtime_source_cas_observation_limit_exceeded")?;
        Ok(Reservation {
            budget: self,
            reserved: bytes,
            committed: false,
        })
    }
}
impl Reservation<'_> {
    fn commit(mut self, bytes: u64) -> Result<(), String> {
        let remainder = self
            .reserved
            .checked_sub(bytes)
            .ok_or("r_runtime_source_cas_observation_limit_exceeded")?;
        self.budget.occupied.fetch_sub(remainder, Ordering::AcqRel);
        self.committed = true;
        Ok(())
    }
}
impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        if !self.committed {
            self.budget
                .occupied
                .fetch_sub(self.reserved, Ordering::AcqRel);
        }
    }
}
pub(super) struct Outcome<'a> {
    pub(super) result: Result<Vec<Value>, String>,
    pub(super) retained: Vec<SourceObservation<'a>>,
    pub(super) owned_archives: Vec<String>,
    pub(super) cleanup_verified: bool,
}
struct Worker<'a> {
    values: Vec<(usize, Value)>,
    observed: Option<SourceObservation<'a>>,
    failure: Option<String>,
    cleanup_verified: bool,
}

pub(super) fn acquire<'a>(
    expected: &[Value],
    staging: &Path,
    seeds: Option<&BTreeMap<String, PathBuf>>,
    concurrency: usize,
    cancelled: &'a AtomicBool,
    deadline: Instant,
    lock_bytes: u64,
) -> Outcome<'a> {
    let budget = BytesBudget {
        occupied: AtomicU64::new(lock_bytes),
    };
    let cursor = AtomicUsize::new(0);
    let stopped = AtomicBool::new(false);
    let shared_reads = super::observation::SharedInventoryReadBudgetV1::new();
    let mut cleanup_verified = true;
    let mut workers = Vec::new();
    std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(concurrency.min(expected.len()));
        for _ in 0..concurrency.min(expected.len()) {
            let handle = std::thread::Builder::new().name("r-source-cas-acquire".into()).spawn_scoped(scope, || {
                let mut execution = ArchiveExecution::new_with_deadline(cancelled, deadline);
                let mut worker = Worker { values: Vec::new(), observed: None, failure: None, cleanup_verified: true };
                let mut observed=match SourceObservation::new_with_deadline(staging,cancelled,deadline) {
                    Ok(value)=>value,
                    Err(error)=>{stopped.store(true,Ordering::Release);worker.failure=Some(error);worker.cleanup_verified=false;return worker;}
                };
                if let Err(error)=shared_reads.attach(&mut observed) { stopped.store(true,Ordering::Release);worker.failure=Some(error);worker.cleanup_verified=false;return worker; }
                let result = (|| {
                    while !stopped.load(Ordering::Acquire) {
                        require_acquisition_active(cancelled, Some(deadline))?;
                        let index = cursor.fetch_add(1, Ordering::AcqRel);
                        let Some(entry) = expected.get(index) else { break; };
                        let file = entry["file"].as_str().ok_or("r_runtime_source_cas_lock_entry_invalid")?;
                        let target = staging.join("src/contrib").join(file);
                        let seed = seeds.and_then(|seeds| seeds.get(file));
                        let value = if let Some(seed) = seed {
                            let metadata = fs::symlink_metadata(seed).map_err(|_| "r_runtime_source_cas_seed_file_invalid")?;
                            if !metadata.is_file() || metadata.len() > MAX_ARCHIVE_BYTES { return Err("r_runtime_source_cas_seed_file_invalid".into()); }
                            let reservation = budget.reserve(metadata.len())?;
                            copy_seed_archive_with_control(seed, &target, cancelled, deadline, metadata.len())?;
                            let value = match verify_seed_archive(entry, &target, &mut execution, &mut observed) {
                                Ok(value) => value,
                                Err(error) => {
                                    if execution.cleanup_verified() && observed.remove_failed_archive_v1(file).is_err() { execution.retain_unknown_cleanup(); }
                                    return Err(error);
                                }
                            };
                            reservation.commit(value["bytes"].as_u64().ok_or("r_runtime_source_cas_archive_invalid")?)?;
                            value
                        } else {
                            let mut last_error = None;
                            let mut accepted = None;
                            for _ in 0..3 {
                                require_acquisition_active(cancelled, Some(deadline))?;
                                let reservation = budget.reserve(NETWORK_CAPTURE_BYTES)?;
                                let mut written = false;
                                let attempt = (|| {
                                    let bytes = execution.snapshot_archive(entry, &target)?;
                                    require_acquisition_active(cancelled, Some(deadline))?;
                                    super::write_new_file(&target, &bytes)?;
                                    written = true;
                                    verify_seed_archive(entry, &target, &mut execution, &mut observed)
                                })();
                                match attempt {
                                    Ok(value) => {
                                        reservation.commit(value["bytes"].as_u64().ok_or("r_runtime_source_cas_archive_invalid")?)?;
                                        accepted = Some(value); break;
                                    }
                                    Err(error) => {
                                        if !execution.cleanup_verified() { return Err(error); }
                                        require_acquisition_active(cancelled, Some(deadline))?;
                                        if written {
                                            if observed.remove_failed_archive_v1(file).is_err() {
                                                execution.retain_unknown_cleanup();
                                                return Err("r_runtime_source_cas_failed_archive_identity_unknown".into());
                                            }
                                        } else {
                                            match fs::symlink_metadata(&target) {
                                                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                                                _ => { execution.retain_unknown_cleanup(); return Err("r_runtime_source_cas_failed_archive_identity_unknown".into()); }
                                            }
                                        }
                                        last_error = Some(error);
                                    }
                                }
                            }
                            accepted.ok_or_else(|| format!("r_runtime_source_cas_download_failed:{}:{}", entry["package"].as_str().unwrap_or("invalid"), last_error.as_deref().unwrap_or("unknown")))?
                        };
                        worker.values.push((index, value));
                    }
                    observed.assert_current()?;
                    Ok::<(), String>(())
                })();
                if let Err(error) = result { stopped.store(true, Ordering::Release); worker.failure = Some(error); }
                if observed.assert_current().is_err() { execution.retain_unknown_cleanup(); }
                worker.observed=Some(observed);
                worker.cleanup_verified = execution.cleanup_verified();
                worker
            });
            match handle {
                Ok(handle) => handles.push(handle),
                Err(_) => {
                    stopped.store(true, Ordering::Release);
                    workers.push(Worker {
                        values: Vec::new(),
                        observed: None,
                        failure: Some("r_runtime_source_cas_worker_unavailable".into()),
                        cleanup_verified: true,
                    });
                    break;
                }
            }
        }
        // Never abandon another live worker merely because one result failed.
        for handle in handles {
            match handle.join() {
                Ok(worker) => {
                    cleanup_verified &= worker.cleanup_verified;
                    workers.push(worker);
                }
                Err(_) => {
                    stopped.store(true, Ordering::Release);
                    cleanup_verified = false;
                }
            }
        }
    });
    let mut failure = if cleanup_verified {
        None
    } else {
        Some("r_runtime_source_cas_mixed_cleanup_unverified".to_owned())
    };
    let mut values: Vec<Option<Value>> = (0..expected.len()).map(|_| None).collect();
    let mut retained = Vec::with_capacity(workers.len());
    let mut owned_archives = Vec::new();
    for worker in workers {
        if failure.is_none() {
            failure = worker.failure;
        }
        if let Some(observed) = worker.observed {
            retained.push(observed);
        }
        for (index, value) in worker.values {
            if let Some(file) = value["file"].as_str() {
                owned_archives.push(file.to_owned());
            }
            match values.get_mut(index) {
                Some(slot) if slot.is_none() => *slot = Some(value),
                _ => {
                    failure = Some("r_runtime_source_cas_mixed_result_invalid".into());
                    cleanup_verified = false;
                }
            }
        }
    }
    let result = match failure {
        Some(error) => Err(error),
        None => values
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| "r_runtime_source_cas_mixed_result_incomplete".to_owned()),
    };
    Outcome {
        result,
        retained,
        owned_archives,
        cleanup_verified,
    }
}

pub(super) fn known_failed_namespace(
    observed: &mut SourceObservation<'_>,
    workers: &[SourceObservation<'_>],
    owned: &[String],
) -> Result<(), String> {
    for worker in workers {
        worker.assert_current()?;
    }
    for (relative, expected) in [("", vec![("src", true)]), ("src", vec![("contrib", true)])] {
        let entries = observed.inventory_entries(Path::new(relative))?;
        if entries.len() != expected.len()
            || entries
                .iter()
                .zip(expected)
                .any(|(actual, (name, directory))| {
                    actual.name != name
                        || actual.directory != directory
                        || actual.symlink
                        || actual.regular
                })
        {
            return Err("r_runtime_source_cas_failed_namespace_unknown".into());
        }
    }
    let entries = observed.inventory_entries(Path::new("src/contrib"))?;
    let mut names = owned.to_vec();
    names.sort();
    if entries.len() != names.len()
        || entries.iter().zip(&names).any(|(actual, name)| {
            actual.name != *name || !actual.regular || actual.directory || actual.symlink
        })
    {
        return Err("r_runtime_source_cas_failed_namespace_unknown".into());
    }
    observed.assert_current()?;
    for worker in workers {
        worker.assert_current()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;

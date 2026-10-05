//! Bounded pure computation. The coordinator alone owns admission, intent and CAS.
use super::*;
use crate::native_business::{NativeBusinessOutputV1, execute_native_business_for_capability_v1};
use std::{thread::ScopedJoinHandle, time::Instant};

type Computation = Result<NativeBusinessOutputV1, ServiceError>;
struct Pending<'scope, 'request> {
    request: &'request ExecutionRequestV1,
    identity: Sha256Digest,
    handle: ScopedJoinHandle<'scope, Computation>,
}

fn check_control(cancelled: &AtomicBool, deadline: Option<Instant>) -> Result<(), ServiceError> {
    if cancelled.load(Ordering::Acquire) || deadline.is_some_and(|at| Instant::now() >= at) {
        return Err(ServiceError::Execution);
    }
    Ok(())
}

pub(super) fn compute(
    job: NativeBusinessJobV1,
    capability: &str,
    cancelled: &AtomicBool,
    deadline: Option<Instant>,
) -> Computation {
    check_control(cancelled, deadline)?;
    // These kernels have fixed input/work bounds. Cancellation prevents entry
    // and publication; it is not a claim of interrupting a Rust thread mid-kernel.
    let output = execute_native_business_for_capability_v1(job, capability)
        .map_err(|_| ServiceError::Execution)?;
    check_control(cancelled, deadline)?;
    Ok(output)
}

// Service/broker callbacks use ServiceError internally. Keep the coordinator's
// first typed admission failure across that adapter instead of flattening a
// clock/lease refusal into an execution failure. The refusal is sticky even if
// an inner operation accidentally calls its callback again or returns success.
fn preserve_admission_error<T>(
    admission: &mut dyn FnMut() -> Result<(), ControlPlaneError>,
    operation: impl FnOnce(&mut dyn FnMut() -> Result<(), ServiceError>) -> Result<T, ServiceError>,
) -> Result<T, ControlPlaneError> {
    let mut admission_error = None;
    let result = operation(&mut || {
        if admission_error.is_some() {
            return Err(ServiceError::Execution);
        }
        admission().map_err(|error| {
            admission_error = Some(error);
            ServiceError::Execution
        })
    });
    match admission_error {
        Some(error) => Err(error),
        None => result.map_err(|_| ControlPlaneError::ExecutionInvalid),
    }
}

impl ServiceExecutorV1 {
    fn capture_pure_business(
        &self,
        request: &ExecutionRequestV1,
    ) -> Result<Option<(Sha256Digest, NativeBusinessJobV1)>, ServiceError> {
        check_control(&self.cancelled, self.inherited_native_deadline)?;
        let binding = self
            .workers
            .get(&request.candidate.module_id)
            .ok_or(ServiceError::Configuration)?;
        if !matches!(binding, WorkerBindingV1::Native) {
            return Ok(None);
        }
        let identity = execution_identity(request, binding)?;
        // Existing records, including a duplicate of an in-flight request, are
        // serial barriers. Replay/recovery remains owned by execute_one.
        if self.objects.attempt_path(&identity, "prepared").exists()
            || self.objects.attempt_path(&identity, "started").exists()
        {
            return Ok(None);
        }
        let bytes = self.objects.read(&request.candidate.payload_hash)?;
        let job: NativeJobV1 =
            serde_json::from_slice(&bytes).map_err(|_| ServiceError::Configuration)?;
        let NativeJobV1::Business { job } = job else {
            return Ok(None);
        };
        // Explicit closed allowlist. New or CAS-consuming variants cannot gain
        // concurrency accidentally, and workers never receive an ObjectStore.
        match &job {
            NativeBusinessJobV1::AuthorDraft { .. }
            | NativeBusinessJobV1::ReviewerAssessment { .. }
            | NativeBusinessJobV1::FormalCertificate { .. }
            | NativeBusinessJobV1::EmpiricalAggregate { .. }
            | NativeBusinessJobV1::EmpiricalInference { .. }
            | NativeBusinessJobV1::NumericalLinearSolve { .. }
            | NativeBusinessJobV1::BuildPackage { .. }
            | NativeBusinessJobV1::LegacySubmissionManifestV1 { .. }
            | NativeBusinessJobV1::LegacySubmissionIntentV1 { .. }
            | NativeBusinessJobV1::PrepareSubmission { .. } => {}
            NativeBusinessJobV1::ResearchDataWorkerV1 { .. }
            | NativeBusinessJobV1::ResearchObservedAssessmentFromCasV1 { .. }
            | NativeBusinessJobV1::PrepareLocalSubmissionFromCasV1 { .. } => return Ok(None),
        }
        if job.capability_id() != request.candidate.capability_id
            || !request
                .candidate
                .resources
                .fits_within(request.reservation.reserved)
        {
            return Err(ServiceError::Configuration);
        }
        Ok(Some((identity, job)))
    }

    fn drain_pure_business(
        &self,
        pending: &mut Vec<Pending<'_, '_>>,
        prepared: &mut Vec<PreparedResultV1>,
        guard: &recovery::DispatchGuardV1,
        admission: &mut dyn FnMut() -> Result<(), ControlPlaneError>,
        publish_allowed: bool,
    ) -> Result<(), ControlPlaneError> {
        let mut first_error = None;
        for pending in pending.drain(..) {
            // Always join every started worker, including after a panic/failure.
            // The wave guard and all reservations outlive the last computation.
            let output = pending
                .handle
                .join()
                .map_err(|_| ServiceError::Execution)
                .and_then(|output| output);
            if !publish_allowed || first_error.is_some() {
                continue;
            }
            let result = preserve_admission_error(admission, |admission| {
                let output = output?;
                guard.validate()?;
                check_control(&self.cancelled, self.inherited_native_deadline)?;
                admission()?;
                guard.validate()?;
                check_control(&self.cancelled, self.inherited_native_deadline)?;
                let (artifacts, evidence) = self.store_native_output(&pending.identity, output)?;
                let result = self.publish_result(
                    pending.request,
                    &pending.identity,
                    (artifacts, evidence),
                    pending.request.candidate.cost_microusd,
                    None,
                    &mut || {
                        guard.validate()?;
                        check_control(&self.cancelled, self.inherited_native_deadline)?;
                        admission()?;
                        guard.validate()?;
                        check_control(&self.cancelled, self.inherited_native_deadline)
                    },
                )?;
                guard.validate()?;
                Ok(result)
            });
            match result {
                Ok(result) => prepared.push(result),
                Err(error) => first_error = Some(error),
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    pub(super) fn execute_bounded_batch<F>(
        &self,
        requests: &[ExecutionRequestV1],
        admission: &mut dyn FnMut() -> Result<(), ControlPlaneError>,
        guard: &recovery::DispatchGuardV1,
        limit: usize,
        compute: &F,
    ) -> Result<Vec<PreparedResultV1>, ControlPlaneError>
    where
        F: Fn(NativeBusinessJobV1, &str, &AtomicBool, Option<Instant>) -> Computation + Sync,
    {
        if !(1..=2).contains(&limit) {
            return Err(ControlPlaneError::ExecutionInvalid);
        }
        std::thread::scope(|scope| {
            let mut pending = Vec::with_capacity(limit);
            let mut prepared = Vec::with_capacity(requests.len());
            let mut first_error = None;
            for request in requests {
                let result = (|| {
                    // Drain before capturing another bounded payload: even input
                    // preparation cannot accumulate an unbounded queue.
                    // Repeated exact immutable work is a serial barrier even
                    // when candidate/attempt identities differ. Publishing its
                    // predecessor may change the live clock/lease observation;
                    // do not spend a second reservation on the same payload
                    // before that observation. Distinct payloads still overlap.
                    if pending.len() == limit
                        || pending.iter().any(|work: &Pending<'_, '_>| {
                            work.request.candidate.payload_hash == request.candidate.payload_hash
                        })
                    {
                        self.drain_pure_business(
                            &mut pending,
                            &mut prepared,
                            guard,
                            admission,
                            true,
                        )?;
                    }
                    let captured = self
                        .capture_pure_business(request)
                        .map_err(|_| ControlPlaneError::ExecutionInvalid)?;
                    let Some((identity, job)) = captured else {
                        self.drain_pure_business(
                            &mut pending,
                            &mut prepared,
                            guard,
                            admission,
                            true,
                        )?;
                        guard
                            .validate()
                            .map_err(|_| ControlPlaneError::ExecutionInvalid)?;
                        admission()?;
                        let result = preserve_admission_error(admission, |refresh| {
                            self.execute_one(request, refresh)
                        })?;
                        guard
                            .validate()
                            .map_err(|_| ControlPlaneError::ExecutionInvalid)?;
                        prepared.push(result);
                        return Ok(());
                    };
                    guard
                        .validate()
                        .map_err(|_| ControlPlaneError::ExecutionInvalid)?;
                    admission()?;
                    check_control(&self.cancelled, self.inherited_native_deadline)
                        .map_err(|_| ControlPlaneError::ExecutionInvalid)?;
                    self.objects
                        .record(
                            &self.objects.attempt_path(&identity, "started"),
                            identity.to_string().as_bytes(),
                        )
                        .map_err(|_| ControlPlaneError::ExecutionInvalid)?;
                    // Intent I/O can advance the clock. A pre-intent observation
                    // is not a transferable permit to launch this worker later.
                    guard
                        .validate()
                        .map_err(|_| ControlPlaneError::ExecutionInvalid)?;
                    admission()?;
                    check_control(&self.cancelled, self.inherited_native_deadline)
                        .map_err(|_| ControlPlaneError::ExecutionInvalid)?;
                    let cancelled = &*self.cancelled;
                    let deadline = self.inherited_native_deadline;
                    let capability = request.candidate.capability_id.as_str();
                    let handle = std::thread::Builder::new()
                        .name("hepta-native-pure".into())
                        .spawn_scoped(scope, move || compute(job, capability, cancelled, deadline))
                        .map_err(|_| ControlPlaneError::ExecutionInvalid)?;
                    pending.push(Pending {
                        request,
                        identity,
                        handle,
                    });
                    Ok(())
                })();
                if let Err(error) = result {
                    first_error = Some(error);
                    break;
                }
            }
            // An outer failure (especially revoked admission) makes the remaining
            // drain join-only. Successful computation cannot renew that authority.
            let drained = self.drain_pure_business(
                &mut pending,
                &mut prepared,
                guard,
                admission,
                first_error.is_none(),
            );
            if let Some(error) = first_error {
                return Err(error);
            }
            drained?;
            Ok(prepared)
        })
    }
}

#[cfg(test)]
#[path = "worker_bounded_tests.rs"]
mod tests;

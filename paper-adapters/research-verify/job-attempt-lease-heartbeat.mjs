export const NATIVE_RESEARCH_WORKER_JOB_LEASE_SECONDS = 1800;

export async function withJobAttemptLeaseHeartbeat(jobReceiptStore, attempt, operation, {
  leaseSeconds = NATIVE_RESEARCH_WORKER_JOB_LEASE_SECONDS,
  scheduler = { setInterval, clearInterval, unref: (handle) => handle?.unref?.() },
} = {}) {
  if (typeof operation !== 'function') throw new Error('job_attempt_lease_operation_required');
  if (!jobReceiptStore || !attempt) return operation();
  if (typeof jobReceiptStore.renewAttemptLease !== 'function') throw new Error('job_attempt_lease_renewal_not_supported');
  let leaseError = null;
  let heartbeat;
  const controller = new AbortController();
  const renew = () => {
    try {
      jobReceiptStore.renewAttemptLease({
        jobId: attempt.jobId,
        attemptId: attempt.attemptId,
        workerId: attempt.workerId,
        leaseGeneration: attempt.leaseGeneration,
        leaseSeconds,
      });
    } catch (error) {
      leaseError ||= error;
      if (!controller.signal.aborted) controller.abort('job_attempt_lease_lost');
      if (heartbeat) scheduler.clearInterval(heartbeat);
    }
  };
  heartbeat = scheduler.setInterval(renew, Math.max(1000, Math.floor(leaseSeconds * 1000 / 3)));
  scheduler.unref?.(heartbeat);
  try {
    const result = await operation(controller.signal);
    if (leaseError) throw new Error('job_attempt_lease_lost', { cause: leaseError });
    return result;
  } catch (error) {
    if (leaseError) throw new Error('job_attempt_lease_lost', { cause: leaseError });
    throw error;
  } finally {
    scheduler.clearInterval(heartbeat);
  }
}

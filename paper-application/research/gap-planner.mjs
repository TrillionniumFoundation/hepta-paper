import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildResearchGapPlan({ paperTask, claimRegistry, evidenceQualityGate, priorJobs = [], priorities = {} } = {}) {
  const covered = new Set(evidenceQualityGate?.coveredClaimIds || []);
  const priorByClaim = new Map(priorJobs.map((job) => [job.claimId, job]));
  const jobs = (claimRegistry?.claims || []).filter((claim) => !covered.has(claim.claimId)).map((claim) => ({
    jobId: `research-gap:${paperTask?.paperId || 'paper'}:${claim.claimId}`,
    claimId: claim.claimId,
    action: 'produce_or_bind_research_evidence',
    priority: Number(priorities[claim.claimId] ?? 100),
    deduplicationKey: `${paperTask?.paperId || 'paper'}:${claim.claimId}:${claim.status}`,
    priorReceiptHash: priorByClaim.get(claim.claimId)?.receiptHash || null,
    arbitraryCommandAllowed: false,
  })).sort((left, right) => left.priority - right.priority || left.claimId.localeCompare(right.claimId));
  const record = { version: 2, kind: 'ResearchGapPlan', paperId: paperTask?.paperId || null, jobs };
  return { ...record, researchGapPlanHash: hashRecord('ResearchGapPlan', record) };
}

export function bindResearchGapPlan({ plan, jobReceiptStore, receiptLedger, clock, workerId = null } = {}) {
  if (!plan || !jobReceiptStore || !receiptLedger || !clock) {
    throw new Error('Gap plan binding requires plan, jobReceiptStore, receiptLedger and clock');
  }
  const bindings = [];
  for (const job of plan.jobs || []) {
    const persisted = jobReceiptStore.createJob({
      ...job,
      paperId: plan.paperId,
      kind: 'research-gap-planning',
    });
    let lease = null;
    let attempt = null;
    if (workerId && ['queued', 'failed_retryable'].includes(persisted?.status)) {
      lease = jobReceiptStore.acquireLease({ jobId: job.jobId, workerId, leaseSeconds: 60 });
      if (lease) {
        attempt = jobReceiptStore.recordAttempt({ jobId: job.jobId, workerId });
        const completionPayload = {
          version: 1,
          kind: 'ResearchGapPlanningReceipt',
          status: 'research_gap_job_bound',
          paperId: plan.paperId,
          jobId: job.jobId,
          claimId: job.claimId,
          planHash: plan.researchGapPlanHash,
          attemptId: attempt.attemptId,
          createdAt: clock.nowIso(),
        };
        const receiptHash = hashRecord('ResearchGapPlanningReceipt', completionPayload);
        jobReceiptStore.completeJob({ jobId: job.jobId, attemptId: attempt.attemptId, receipt: { ...completionPayload, receiptHash } });
      }
    }
    bindings.push({
      jobId: job.jobId,
      claimId: job.claimId,
      persistedStatus: jobReceiptStore.get(job.jobId)?.status || persisted?.status || null,
      leaseOwner: lease?.lease_owner || null,
      attemptId: attempt?.attemptId || null,
    });
  }
  const receiptPayload = {
    version: 1,
    kind: 'ResearchGapPlanBindingReceipt',
    status: 'research_gap_plan_bound',
    paperId: plan.paperId,
    planHash: plan.researchGapPlanHash,
    jobCount: bindings.length,
    bindings,
    createdAt: clock.nowIso(),
  };
  const receiptHash = hashRecord('ResearchGapPlanBindingReceipt', receiptPayload);
  const ledger = receiptLedger.record({ ...receiptPayload, receiptHash }, { stream: 'research-gap-jobs', paperId: plan.paperId });
  return { ...receiptPayload, receiptHash, ledgerReceiptId: ledger.receiptId };
}

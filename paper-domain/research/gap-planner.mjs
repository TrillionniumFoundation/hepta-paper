import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const GAP_CONTRACTS = Object.freeze({
  proof: Object.freeze({ action: 'verify_or_complete_formal_proof', resourceProfile: { cpu: 2, memoryMb: 4096, timeoutMs: 120000 }, requiredOutputs: ['source_bound_theorem', 'formal_verification_receipt'], successCriteria: ['lake_build_verified', 'all_proof_obligations_covered'], forbiddenActions: ['direct_source_mutation', 'caller_supplied_verification_flags'], negativeResultPolicy: 'block_promotion_and_return_revision' }),
  experiment: Object.freeze({ action: 'run_declared_experiment_contract', resourceProfile: { cpu: 4, memoryMb: 8192, timeoutMs: 3600000 }, requiredOutputs: ['experiment_manifest', 'metrics', 'execution_receipt'], successCriteria: ['declared_metric_evaluated', 'result_policy_recorded'], forbiddenActions: ['arbitrary_operator_command', 'undeclared_dataset'], negativeResultPolicy: 'preserve_negative_or_inconclusive_result_without_promotion' }),
  reproducibility: Object.freeze({ action: 'reproduce_bound_research_result', resourceProfile: { cpu: 4, memoryMb: 8192, timeoutMs: 3600000 }, requiredOutputs: ['replay_manifest', 'replay_receipt', 'hash_comparison'], successCriteria: ['replay_inputs_hash_bound', 'replay_outcome_classified'], forbiddenActions: ['source_mutation', 'unbound_environment'], negativeResultPolicy: 'record_reproduction_failure_without_promotion' }),
  artifact: Object.freeze({ action: 'produce_or_bind_research_artifact', resourceProfile: { cpu: 1, memoryMb: 2048, timeoutMs: 300000 }, requiredOutputs: ['content_addressed_artifact', 'provenance_receipt'], successCriteria: ['artifact_hash_verified', 'source_locator_bound'], forbiddenActions: ['path_escape', 'untracked_side_effect'], negativeResultPolicy: 'block_promotion' }),
  claim_evidence: Object.freeze({ action: 'produce_or_bind_research_evidence', resourceProfile: { cpu: 1, memoryMb: 2048, timeoutMs: 300000 }, requiredOutputs: ['claim_bound_evidence', 'provenance_receipt'], successCriteria: ['claim_coverage_verified'], forbiddenActions: ['arbitrary_operator_command', 'direct_source_mutation'], negativeResultPolicy: 'allow_negative_evidence_only_with_explicit_non_promotion' }),
});

function gapKind(riskClass = '') {
  const risk = String(riskClass).toLowerCase();
  if (['theorem_readiness', 'proof', 'formal_verification'].includes(risk)) return 'proof';
  if (['experiment', 'empirical', 'benchmark'].includes(risk)) return 'experiment';
  if (['reproducibility', 'reproduction'].includes(risk)) return 'reproducibility';
  if (['artifact', 'package', 'evidence_artifact'].includes(risk)) return 'artifact';
  return 'claim_evidence';
}

function jobContract(kind) { return { gapKind: kind, ...GAP_CONTRACTS[kind] }; }

export function buildResearchGapPlan({ paperTask, claimRegistry, evidenceQualityGate, priorJobs = [], priorities = {}, revisionRequests = [] } = {}) {
  const covered = new Set(evidenceQualityGate?.coveredClaimIds || []);
  const priorByClaim = new Map(priorJobs.map((job) => [job.claimId, job]));
  const claimJobs = (claimRegistry?.claims || []).filter((claim) => !covered.has(claim.claimId)).map((claim) => ({
    jobId: `research-gap:${paperTask?.paperId || 'paper'}:${claim.claimId}`,
    claimId: claim.claimId,
    ...jobContract(gapKind(claim.riskClass || claim.kind)),
    priority: Number(priorities[claim.claimId] ?? 100),
    deduplicationKey: `${paperTask?.paperId || 'paper'}:${claim.claimId}:${claim.status}`,
    priorReceiptHash: priorByClaim.get(claim.claimId)?.receiptHash || null,
    arbitraryCommandAllowed: false,
    source: 'claim_registry',
  }));
  const revisionJobs = revisionRequests.filter((request) => !['resolved', 'closed'].includes(request.status)).map((request) => {
    const kind = gapKind(request.risk_class || request.riskClass);
    const key = String(request.request_key || request.requestKey || request.request_id || 'revision').replace(/[^A-Za-z0-9_.:-]/g, '_');
    return {
      jobId: `research-gap:${paperTask?.paperId || 'paper'}:revision:${key}`,
      claimId: request.claim_id || request.claimId || `revision:${key}`,
      revisionRequestId: request.request_id || request.requestId || null,
      revisionRequestKey: request.request_key || request.requestKey || key,
      ...jobContract(kind),
      priority: Number(request.matrix_rank ?? request.matrixRank ?? 50),
      deduplicationKey: `${paperTask?.paperId || 'paper'}:revision:${key}:${request.updated_at || request.updatedAt || request.status || 'requested'}`,
      priorReceiptHash: null,
      arbitraryCommandAllowed: false,
      source: 'referee_revision_requests',
      sourceLocator: request.source_locator || request.sourceLocator || null,
      evidenceNeeded: request.evidence_needed || request.evidenceNeeded || null,
      verificationPlan: request.verification || null,
    };
  });
  const jobs = [...claimJobs, ...revisionJobs].sort((left, right) => left.priority - right.priority || left.claimId.localeCompare(right.claimId));
  const record = { version: 3, kind: 'ResearchGapPlan', paperId: paperTask?.paperId || null, jobs };
  return { ...record, researchGapPlanHash: hashRecord('ResearchGapPlan', record) };
}

export function bindResearchGapPlan({ plan, jobReceiptStore, receiptLedger, clock, workerId = null } = {}) {
  if (!plan || !jobReceiptStore || !receiptLedger || !clock) throw new Error('Gap plan binding requires plan, jobReceiptStore, receiptLedger and clock');
  const bindings = [];
  for (const job of plan.jobs || []) {
    const persisted = jobReceiptStore.createJob({ ...job, paperId: plan.paperId, kind: 'research-gap-planning' });
    let lease = null;
    let attempt = null;
    if (workerId && ['queued', 'failed_retryable'].includes(persisted?.status)) {
      lease = jobReceiptStore.acquireLease({ jobId: job.jobId, workerId, leaseSeconds: 60 });
      if (lease) {
        attempt = jobReceiptStore.recordAttempt({ jobId: job.jobId, workerId });
        const completionPayload = { version: 1, kind: 'ResearchGapPlanningReceipt', status: 'research_gap_job_bound', paperId: plan.paperId, jobId: job.jobId, claimId: job.claimId, planHash: plan.researchGapPlanHash, attemptId: attempt.attemptId, createdAt: clock.nowIso() };
        const receiptHash = hashRecord('ResearchGapPlanningReceipt', completionPayload);
        jobReceiptStore.completeJob({ jobId: job.jobId, attemptId: attempt.attemptId, receipt: { ...completionPayload, receiptHash } });
      }
    }
    bindings.push({ jobId: job.jobId, claimId: job.claimId, persistedStatus: jobReceiptStore.get(job.jobId)?.status || persisted?.status || null, leaseOwner: lease?.lease_owner || null, attemptId: attempt?.attemptId || null });
  }
  const receiptPayload = { version: 1, kind: 'ResearchGapPlanBindingReceipt', status: 'research_gap_plan_bound', paperId: plan.paperId, planHash: plan.researchGapPlanHash, jobCount: bindings.length, bindings, createdAt: clock.nowIso() };
  const receiptHash = hashRecord('ResearchGapPlanBindingReceipt', receiptPayload);
  const ledger = receiptLedger.record({ ...receiptPayload, receiptHash }, { stream: 'research-gap-jobs', paperId: plan.paperId });
  return { ...receiptPayload, receiptHash, ledgerReceiptId: ledger.receiptId };
}

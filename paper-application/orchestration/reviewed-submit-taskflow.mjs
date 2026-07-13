import { assertTaskFlowPort } from '../../paper-ports/task-flow-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const REVIEWED_SUBMIT_TASKFLOW_PILOT_PAPER = 'A_Theory_of__Expectations';
export const REVIEWED_SUBMIT_TASKFLOW_CONTROLLER = 'hepta-paper/reviewed-submit';

const CHECKPOINTS = Object.freeze([
  ['semanticPromotionStatus', 'semantic_promotion_unlocked', 'await_semantic_promotion_lock', 'semantic_promotion_lock'],
  ['academicEvidenceStatus', 'academic_evidence_verified', 'await_academic_evidence', 'academic_evidence'],
  ['independentRefereeStatus', 'independent_referee_acceptance_verified', 'await_independent_referee', 'independent_referee'],
  ['liveAuthorizationStatus', 'live_submission_authorization_verified', 'await_dual_live_authorization', 'dual_live_authorization'],
  ['dispatchAuthorizationStatus', 'submission_dispatch_authorization_ready', 'await_dispatch_authorization', 'dispatch_authorization'],
  ['providerReceiptStatus', 'provider_receipt_verified', 'await_provider_receipt', 'provider_receipt'],
  ['reconciliationStatus', 'live_submission_reconciled', 'await_provider_reconciliation', 'provider_reconciliation'],
  ['releaseLockStatus', 'submission_release_unlocked', 'await_domain_release_lock', 'domain_release_lock'],
]);

function firstRecordHash(record) {
  if (!record || typeof record !== 'object') return null;
  return Object.entries(record).find(([key, value]) => key.endsWith('Hash') && typeof value === 'string')?.[1] || null;
}

export function buildReviewedSubmitDomainSnapshot({
  paperTask,
  releaseCommit,
  artifactPackage,
  semanticPromotionLock = null,
  academicEvidenceReceipt = null,
  independentRefereeReceipt = null,
  liveAuthorizationReceipt = null,
  dispatchAuthorization = null,
  providerReceiptVerification = null,
  reconciliation = null,
  releaseLock = null,
  blockerCodes = [],
} = {}) {
  if (!paperTask?.paperId || !releaseCommit || !artifactPackage?.artifactPackageHash) {
    throw new Error('paperTask, releaseCommit and artifactPackageHash are required');
  }
  const records = [
    semanticPromotionLock,
    academicEvidenceReceipt,
    independentRefereeReceipt,
    liveAuthorizationReceipt,
    dispatchAuthorization,
    providerReceiptVerification,
    reconciliation,
    releaseLock,
  ];
  return Object.freeze({
    version: 1,
    kind: 'ReviewedSubmitDomainSnapshot',
    domainSource: 'hepta_sqlite_and_verified_receipts',
    paperId: paperTask.paperId,
    releaseCommit,
    packageHash: artifactPackage.artifactPackageHash,
    semanticPromotionStatus: semanticPromotionLock?.status || null,
    semanticPromotionLockHash: semanticPromotionLock?.semanticPromotionLockHash || null,
    academicEvidenceStatus: academicEvidenceReceipt?.status || null,
    independentRefereeStatus: independentRefereeReceipt?.status || null,
    liveAuthorizationStatus: liveAuthorizationReceipt?.status || null,
    dispatchAuthorizationStatus: dispatchAuthorization?.status || null,
    providerReceiptStatus: providerReceiptVerification?.status || null,
    reconciliationStatus: reconciliation?.status || null,
    releaseLockStatus: releaseLock?.status || null,
    receiptHashes: records.map(firstRecordHash).filter(Boolean),
    blockerCodes: [...new Set([
      ...blockerCodes,
      ...records.flatMap((record) => Array.isArray(record?.blockers) ? record.blockers : []),
    ].filter(Boolean).map(String))].sort(),
  });
}

function assertDomainSnapshot(snapshot) {
  if (snapshot?.kind !== 'ReviewedSubmitDomainSnapshot' || snapshot?.version !== 1) {
    throw new Error('ReviewedSubmitDomainSnapshot v1 is required');
  }
  if (!snapshot.paperId || !snapshot.releaseCommit || !snapshot.packageHash || !snapshot.semanticPromotionLockHash) {
    throw new Error('paperId, releaseCommit, packageHash and semanticPromotionLockHash are required');
  }
  if (snapshot.domainSource !== 'hepta_sqlite_and_verified_receipts') {
    throw new Error('TaskFlow may only consume a hepta verified domain snapshot');
  }
  return snapshot;
}

function assertFlowIdentity(currentFlow, snapshot) {
  const state = currentFlow?.stateJson;
  if (!state || state.paperId !== snapshot.paperId
    || state.releaseCommit !== snapshot.releaseCommit
    || state.packageHash !== snapshot.packageHash
    || state.semanticPromotionLockHash !== snapshot.semanticPromotionLockHash) {
    throw new Error('TaskFlow paper, release commit and package identity must remain fixed');
  }
}

export function buildReviewedSubmitCoordinationPlan(snapshot) {
  assertDomainSnapshot(snapshot);
  const missing = CHECKPOINTS.find(([field, expected]) => snapshot[field] !== expected) || null;
  const domainSnapshotHash = hashRecord('ReviewedSubmitDomainSnapshot', snapshot);
  const stateJson = {
    paperId: snapshot.paperId,
    releaseCommit: snapshot.releaseCommit,
    packageHash: snapshot.packageHash,
    semanticPromotionLockHash: snapshot.semanticPromotionLockHash || null,
    domainSnapshotHash,
    receiptHashes: [...new Set((snapshot.receiptHashes || []).filter(Boolean).map(String))].sort(),
    blockerCodes: [...new Set((snapshot.blockerCodes || []).filter(Boolean).map(String))].sort(),
  };
  if (!missing) {
    return Object.freeze({ action: 'finish', currentStep: 'domain_reconciliation_verified', stateJson, waitJson: null });
  }
  const [field, expected, currentStep, kind] = missing;
  const providerReady = currentStep === 'await_provider_receipt';
  return Object.freeze({
    action: providerReady ? 'run_task_and_wait' : 'wait',
    currentStep,
    stateJson,
    waitJson: Object.freeze({
      kind,
      paperId: snapshot.paperId,
      expectedDomainStatus: expected,
      currentDomainStatus: snapshot[field] || null,
      domainSnapshotHash,
    }),
  });
}

function linkChildTask({ taskFlow, flowId, childTask, now }) {
  if (!childTask) return null;
  const result = taskFlow.runTask({
    flowId,
    runtime: childTask.runtime || 'acp',
    childSessionKey: childTask.childSessionKey,
    runId: childTask.runId,
    task: childTask.task,
    status: 'running',
    startedAt: now,
    lastEventAt: now,
  });
  if (!result?.created) throw new Error(result?.reason || 'taskflow_child_task_link_failed');
  return result;
}

function applyPlan({ taskFlow, flow, plan, childTask = null, now = Date.now() }) {
  if (plan.action === 'finish') {
    const finished = taskFlow.finish({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      stateJson: plan.stateJson,
    });
    if (!finished?.applied) throw new Error(finished?.code || 'taskflow_finish_failed');
    return Object.freeze({ status: 'taskflow_coordination_finished', flow: finished.flow, plan, externalActionPerformed: false });
  }
  if (childTask && plan.action !== 'run_task_and_wait') {
    throw new Error('provider child task requires hepta dispatch authorization');
  }
  if (childTask) linkChildTask({ taskFlow, flowId: flow.flowId, childTask, now });
  const waiting = taskFlow.setWaiting({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    currentStep: plan.currentStep,
    stateJson: plan.stateJson,
    waitJson: plan.waitJson,
  });
  if (!waiting?.applied) throw new Error(waiting?.code || 'taskflow_set_waiting_failed');
  return Object.freeze({ status: 'taskflow_coordination_waiting', flow: waiting.flow, plan, externalActionPerformed: false });
}

export function startReviewedSubmitTaskFlow({ taskFlow, domainSnapshot, enabled = false, childTask = null, now = Date.now() } = {}) {
  if (!enabled) return Object.freeze({ status: 'taskflow_pilot_feature_disabled', flowCreated: false, externalActionPerformed: false });
  assertTaskFlowPort(taskFlow);
  assertDomainSnapshot(domainSnapshot);
  if (domainSnapshot.paperId !== REVIEWED_SUBMIT_TASKFLOW_PILOT_PAPER) {
    return Object.freeze({ status: 'taskflow_pilot_paper_not_allowed', flowCreated: false, externalActionPerformed: false });
  }
  const plan = buildReviewedSubmitCoordinationPlan(domainSnapshot);
  if (childTask && plan.action !== 'run_task_and_wait') {
    throw new Error('provider child task requires hepta dispatch authorization');
  }
  const created = taskFlow.createManaged({
    controllerId: REVIEWED_SUBMIT_TASKFLOW_CONTROLLER,
    goal: `coordinate reviewed submission for ${domainSnapshot.paperId}`,
    currentStep: 'read_domain_preflight',
    stateJson: plan.stateJson,
  });
  if (!created?.flowId || !Number.isInteger(created.revision)) throw new Error('taskflow_managed_flow_creation_failed');
  const result = applyPlan({ taskFlow, flow: created, plan, childTask, now });
  return Object.freeze({ ...result, flowCreated: true });
}

export function advanceReviewedSubmitTaskFlow({ taskFlow, currentFlow, domainSnapshot, childTask = null, now = Date.now() } = {}) {
  assertTaskFlowPort(taskFlow);
  assertDomainSnapshot(domainSnapshot);
  if (!currentFlow?.flowId || !Number.isInteger(currentFlow.revision)) throw new Error('current TaskFlow revision is required');
  if (domainSnapshot.paperId !== REVIEWED_SUBMIT_TASKFLOW_PILOT_PAPER) throw new Error('TaskFlow pilot paper is not allowed');
  assertFlowIdentity(currentFlow, domainSnapshot);
  const plan = buildReviewedSubmitCoordinationPlan(domainSnapshot);
  if (childTask && plan.action !== 'run_task_and_wait') {
    throw new Error('provider child task requires hepta dispatch authorization');
  }
  const resumed = taskFlow.resume({
    flowId: currentFlow.flowId,
    expectedRevision: currentFlow.revision,
    status: 'running',
    currentStep: 'revalidate_hepta_domain_state',
    stateJson: plan.stateJson,
  });
  if (!resumed?.applied) throw new Error(resumed?.code || 'taskflow_resume_failed');
  return applyPlan({ taskFlow, flow: resumed.flow, plan, childTask, now });
}

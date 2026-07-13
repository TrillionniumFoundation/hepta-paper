import assert from 'node:assert/strict';
import test from 'node:test';
import { openClawTaskFlowRuntimeStatus } from '../../paper-adapters/orchestration/openclaw-taskflow-adapter.mjs';
import {
  advanceReviewedSubmitTaskFlow,
  buildReviewedSubmitDomainSnapshot,
  buildReviewedSubmitCoordinationPlan,
  startReviewedSubmitTaskFlow,
} from '../../paper-application/orchestration/reviewed-submit-taskflow.mjs';

function snapshot(overrides = {}) {
  return {
    version: 1,
    kind: 'ReviewedSubmitDomainSnapshot',
    domainSource: 'hepta_sqlite_and_verified_receipts',
    paperId: 'A_Theory_of__Expectations',
    releaseCommit: 'release-commit',
    packageHash: `sha256:${'1'.repeat(64)}`,
    semanticPromotionStatus: 'semantic_promotion_unlocked',
    semanticPromotionLockHash: `sha256:${'3'.repeat(64)}`,
    academicEvidenceStatus: 'academic_evidence_attestation_missing',
    independentRefereeStatus: 'independent_referee_authority_blocked',
    liveAuthorizationStatus: 'live_submission_authorization_blocked',
    dispatchAuthorizationStatus: 'submission_dispatch_authorization_blocked',
    releaseLockStatus: 'submission_release_locked',
    providerReceiptStatus: 'provider_receipt_missing',
    reconciliationStatus: 'reconciliation_missing',
    receiptHashes: [`sha256:${'2'.repeat(64)}`],
    blockerCodes: ['academic_evidence_required'],
    privateKeyPem: 'must-never-enter-taskflow-state',
    ...overrides,
  };
}

function fakeTaskFlow() {
  const calls = [];
  const flow = (revision, status, currentStep, stateJson = {}) => ({ flowId: 'flow-1', revision, status, currentStep, stateJson });
  return {
    calls,
    createManaged(input) { calls.push(['createManaged', input]); return flow(1, 'running', input.currentStep, input.stateJson); },
    runTask(input) { calls.push(['runTask', input]); return { created: true, taskId: 'task-1' }; },
    setWaiting(input) { calls.push(['setWaiting', input]); return { applied: true, flow: flow(input.expectedRevision + 1, 'waiting', input.currentStep, input.stateJson) }; },
    resume(input) { calls.push(['resume', input]); return { applied: true, flow: flow(input.expectedRevision + 1, 'running', input.currentStep, input.stateJson) }; },
    finish(input) { calls.push(['finish', input]); return { applied: true, flow: flow(input.expectedRevision + 1, 'finished', 'finished', input.stateJson) }; },
    fail(input) { calls.push(['fail', input]); return { applied: true, flow: flow(input.expectedRevision + 1, 'failed', 'failed') }; },
    requestCancel(input) { calls.push(['requestCancel', input]); return { applied: true, flow: flow(input.expectedRevision + 1, 'cancelling', 'cancelling') }; },
    cancel(input) { calls.push(['cancel', input]); return { applied: true, flow: flow(input.expectedRevision + 1, 'cancelled', 'cancelled') }; },
    getTaskSummary(flowId) { calls.push(['getTaskSummary', flowId]); return { flowId, tasks: [] }; },
  };
}

function currentFlow(revision = 2, overrides = {}) {
  return {
    flowId: 'flow-1',
    revision,
    stateJson: {
      paperId: 'A_Theory_of__Expectations',
      releaseCommit: 'release-commit',
      packageHash: `sha256:${'1'.repeat(64)}`,
      semanticPromotionLockHash: `sha256:${'3'.repeat(64)}`,
      ...overrides,
    },
  };
}

test('TaskFlow pilot is disabled by default and never creates authority', () => {
  const taskFlow = fakeTaskFlow();
  const result = startReviewedSubmitTaskFlow({ taskFlow, domainSnapshot: snapshot() });
  assert.equal(result.status, 'taskflow_pilot_feature_disabled');
  assert.equal(taskFlow.calls.length, 0);
  const status = openClawTaskFlowRuntimeStatus({ api: {}, enabled: false });
  assert.equal(status.grantsSubmissionAuthority, false);
  assert.equal(status.externalActionPerformed, false);
});

test('domain snapshot is rebuilt from native receipt statuses and hashes', () => {
  const built = buildReviewedSubmitDomainSnapshot({
    paperTask: { paperId: 'A_Theory_of__Expectations' },
    releaseCommit: 'release-commit',
    artifactPackage: { artifactPackageHash: `sha256:${'1'.repeat(64)}` },
    semanticPromotionLock: { status: 'semantic_promotion_unlocked', semanticPromotionLockHash: `sha256:${'3'.repeat(64)}`, blockers: [] },
    academicEvidenceReceipt: {
      status: 'academic_evidence_verified',
      academicEvidenceAttestationVerificationHash: `sha256:${'2'.repeat(64)}`,
      blockers: [],
    },
    independentRefereeReceipt: { status: 'independent_referee_authority_blocked', blockers: ['independent_referee_required'] },
  });
  assert.equal(built.domainSource, 'hepta_sqlite_and_verified_receipts');
  assert.deepEqual(built.receiptHashes, [`sha256:${'3'.repeat(64)}`, `sha256:${'2'.repeat(64)}`]);
  assert.deepEqual(built.blockerCodes, ['independent_referee_required']);
  assert.equal(buildReviewedSubmitCoordinationPlan(built).currentStep, 'await_independent_referee');
});

test('managed pilot stores only minimal hashes and waits on hepta-verified checkpoints', () => {
  const taskFlow = fakeTaskFlow();
  const result = startReviewedSubmitTaskFlow({ taskFlow, domainSnapshot: snapshot(), enabled: true });
  assert.equal(result.status, 'taskflow_coordination_waiting');
  assert.equal(result.plan.currentStep, 'await_academic_evidence');
  assert.equal(JSON.stringify(result.plan.stateJson).includes('PRIVATE KEY'), false);
  assert.equal(JSON.stringify(result.plan.stateJson).includes('must-never-enter'), false);
  assert.deepEqual(Object.keys(result.plan.stateJson).sort(), ['blockerCodes', 'domainSnapshotHash', 'packageHash', 'paperId', 'receiptHashes', 'releaseCommit', 'semanticPromotionLockHash']);
  assert.equal(taskFlow.calls[0][0], 'createManaged');
  assert.equal(taskFlow.calls[1][0], 'setWaiting');
  assert.equal(taskFlow.calls[1][1].expectedRevision, 1);
});

test('resume revalidates domain state, links provider child only after dispatch authorization, then finishes', () => {
  const taskFlow = fakeTaskFlow();
  const providerPending = snapshot({
    academicEvidenceStatus: 'academic_evidence_verified',
    independentRefereeStatus: 'independent_referee_acceptance_verified',
    liveAuthorizationStatus: 'live_submission_authorization_verified',
    dispatchAuthorizationStatus: 'submission_dispatch_authorization_ready',
  });
  const pendingPlan = buildReviewedSubmitCoordinationPlan(providerPending);
  assert.equal(pendingPlan.action, 'run_task_and_wait');
  const pending = advanceReviewedSubmitTaskFlow({
    taskFlow,
    currentFlow: currentFlow(4),
    domainSnapshot: providerPending,
    childTask: { childSessionKey: 'agent:provider', runId: 'provider-run-1', task: 'perform externally authorized provider handoff' },
    now: 42,
  });
  assert.equal(pending.status, 'taskflow_coordination_waiting');
  assert.deepEqual(taskFlow.calls.map(([name]) => name), ['resume', 'runTask', 'setWaiting']);
  assert.equal(taskFlow.calls[2][1].expectedRevision, 5);

  const complete = advanceReviewedSubmitTaskFlow({
    taskFlow,
    currentFlow: pending.flow,
    domainSnapshot: snapshot({
      academicEvidenceStatus: 'academic_evidence_verified',
      independentRefereeStatus: 'independent_referee_acceptance_verified',
      liveAuthorizationStatus: 'live_submission_authorization_verified',
      dispatchAuthorizationStatus: 'submission_dispatch_authorization_ready',
      releaseLockStatus: 'submission_release_unlocked',
      providerReceiptStatus: 'provider_receipt_verified',
      reconciliationStatus: 'live_submission_reconciled',
    }),
  });
  assert.equal(complete.status, 'taskflow_coordination_finished');
  assert.equal(complete.externalActionPerformed, false);
  assert.equal(taskFlow.calls.at(-1)[0], 'finish');
});

test('pilot rejects non-pilot papers and untrusted domain snapshots', () => {
  const taskFlow = fakeTaskFlow();
  assert.equal(startReviewedSubmitTaskFlow({ taskFlow, domainSnapshot: snapshot({ paperId: 'other-paper' }), enabled: true }).status, 'taskflow_pilot_paper_not_allowed');
  assert.throws(() => buildReviewedSubmitCoordinationPlan(snapshot({ domainSource: 'taskflow_state' })), /hepta verified domain snapshot/);
  assert.throws(() => advanceReviewedSubmitTaskFlow({
    taskFlow,
    currentFlow: currentFlow(2, { releaseCommit: 'stale-commit' }),
    domainSnapshot: snapshot(),
  }), /identity must remain fixed/);
  assert.throws(() => advanceReviewedSubmitTaskFlow({
    taskFlow,
    currentFlow: currentFlow(),
    domainSnapshot: snapshot(),
    childTask: { childSessionKey: 'agent:provider', runId: 'early-provider', task: 'must remain blocked' },
  }), /requires hepta dispatch authorization/);
  assert.equal(taskFlow.calls.length, 0);
});

test('revision conflicts and child-link failures fail closed', () => {
  const revisionConflict = fakeTaskFlow();
  revisionConflict.resume = (input) => {
    revisionConflict.calls.push(['resume', input]);
    return { applied: false, code: 'revision_conflict' };
  };
  assert.throws(() => advanceReviewedSubmitTaskFlow({
    taskFlow: revisionConflict,
    currentFlow: currentFlow(),
    domainSnapshot: snapshot(),
  }), /revision_conflict/);
  assert.deepEqual(revisionConflict.calls.map(([name]) => name), ['resume']);

  const childFailure = fakeTaskFlow();
  childFailure.runTask = (input) => {
    childFailure.calls.push(['runTask', input]);
    return { created: false, reason: 'child_rejected' };
  };
  assert.throws(() => advanceReviewedSubmitTaskFlow({
    taskFlow: childFailure,
    currentFlow: currentFlow(),
    domainSnapshot: snapshot({
      academicEvidenceStatus: 'academic_evidence_verified',
      independentRefereeStatus: 'independent_referee_acceptance_verified',
      liveAuthorizationStatus: 'live_submission_authorization_verified',
      dispatchAuthorizationStatus: 'submission_dispatch_authorization_ready',
    }),
    childTask: { childSessionKey: 'agent:provider', runId: 'run-1', task: 'provider handoff' },
  }), /child_rejected/);
  assert.deepEqual(childFailure.calls.map(([name]) => name), ['resume', 'runTask']);
});

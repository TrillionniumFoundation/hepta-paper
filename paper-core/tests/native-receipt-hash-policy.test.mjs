import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrapLegacyPaperExecutionContext } from '../../paper-composition/compat/legacy-context-bootstrap.mjs';
import { composeTrustedReceiptLedgers } from '../../paper-composition/bootstrap/receipt-ledger-composition.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import {
  runNativeResearchWorkers,
  verifyNativeResearchWorkerExecutionReport,
} from '../../paper-adapters/research-verify/worker-runtime.mjs';
import {
  computeReceiptHash,
  RECEIPT_HASH_POLICIES,
  sealReceiptHash,
} from '../../paper-domain/evidence/receipt-hash-policy.mjs';
import { recomputeReceiptHash, verifyTrustedLedgerReceipt } from '../../paper-domain/evidence/trusted-ledger-receipt.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

function goldenPayload() {
  return {
    version: 1,
    kind: 'NativeResearchWorkerExecutionReceipt',
    status: 'native_research_worker_execution_verified',
    paperId: 'paper-golden',
    workerId: 'worker-golden',
    attemptId: 'job:attempt:1',
    leaseGeneration: 1,
  };
}

function beginAttempt(jobs, jobId, workerId) {
  jobs.createJob({ jobId, deduplicationKey: `dedupe:${jobId}`, kind: 'native-research', paperId: 'paper-golden' });
  const lease = jobs.acquireLease({ jobId, workerId });
  return jobs.recordAttempt({ jobId, workerId, leaseGeneration: lease.leaseGeneration });
}

function nativeCompletionReceipt({ jobId, attempt, overrides = {} }) {
  return sealReceiptHash({
    ...goldenPayload(),
    jobId,
    attemptId: attempt.attemptId,
    leaseGeneration: attempt.leaseGeneration,
    workerId: attempt.workerId,
    academicEvidenceEligible: true,
    blockers: [],
    ...overrides,
  }, { hashField: 'nativeResearchWorkerExecutionReceiptHash' });
}

function verifiedWorkerReceipt({
  workerId = 'formal-worker',
  workerType = 'formal_verifier_lake',
  result = {
    status: 'formal_claim_verified',
    replayReceipt: { status: 'formal_claim_replay_verified' },
    formalCertificateReplayReceiptHash: 'sha256:formal-replay',
  },
} = {}) {
  return sealReceiptHash({
    version: 1,
    kind: 'NativeResearchWorkerExecutionReceipt',
    paperId: 'paper-report',
    taskKey: 'paper:report',
    workerId,
    workerType,
    jobId: `research-worker:paper-report:${workerId}`,
    attemptId: `research-worker:paper-report:${workerId}:attempt:1`,
    leaseGeneration: 1,
    status: 'native_research_worker_execution_verified',
    planHash: 'sha256:worker-plan',
    theoremSpecificationHash: 'sha256:theorem-specification',
    workerDefinitionHash: `sha256:worker-definition:${workerId}`,
    engineHash: 'sha256:worker-engine',
    inputs: [],
    result,
    resultHash: hashPaperRecord('NativeResearchWorkerResult', result),
    academicEvidenceEligible: true,
    sourceMutationDetected: false,
    blockers: [],
  }, { hashField: 'nativeResearchWorkerExecutionReceiptHash' });
}

function workerExecutionReport(workerReceipts, overrides = {}) {
  const payload = {
    version: 1,
    kind: 'NativeResearchWorkerExecutionReport',
    paperId: 'paper-report',
    taskKey: 'paper:report',
    status: 'native_research_workers_verified',
    executeRequested: true,
    planHash: 'sha256:worker-plan',
    theoremSpecificationHash: 'sha256:theorem-specification',
    engineHash: 'sha256:worker-engine',
    workerTypeFilter: ['formal_verifier_lake'],
    plannedResearchWorkerCount: workerReceipts.length,
    executedResearchWorkerCount: workerReceipts.length,
    verifiedAcademicEvidenceWorkerCount: workerReceipts.length,
    workerReceipts,
    workerReceiptHashes: workerReceipts.map((receipt) => receipt.nativeResearchWorkerExecutionReceiptHash),
    blockers: [],
    ...overrides,
  };
  return {
    ...payload,
    nativeResearchWorkerExecutionReportHash: hashPaperRecord('NativeResearchWorkerExecutionReport', payload),
  };
}

function migrateFixtureStore(root, runtimeRoot) {
  const store = createDefaultPaperStore({ root, runtimeRoot });
  store.close();
}

function decoupledFixture(prefix) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.join(parent, 'assets');
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(root, { recursive: true });
  migrateFixtureStore(root, runtimeRoot);
  return { parent, root, runtimeRoot };
}

test('native receipt v2 has a stable golden vector and legacy paper-record hashes remain readable', () => {
  const current = sealReceiptHash(goldenPayload(), { hashField: 'nativeResearchWorkerExecutionReceiptHash' });
  assert.equal(current.receiptHashPolicy, RECEIPT_HASH_POLICIES.CURRENT);
  assert.equal(current.nativeResearchWorkerExecutionReceiptHash, 'sha256:bb46f30f815c89a487db0942d02940588bf94e08839dc62a4d6b324ae0b206ca');
  assert.equal(recomputeReceiptHash(current), current.nativeResearchWorkerExecutionReceiptHash);

  const legacyPayload = goldenPayload();
  const legacy = {
    ...legacyPayload,
    nativeResearchWorkerExecutionReceiptHash: hashPaperRecord(legacyPayload.kind, legacyPayload),
  };
  assert.equal(recomputeReceiptHash(legacy), legacy.nativeResearchWorkerExecutionReceiptHash);
  assert.equal(computeReceiptHash({ ...current, receiptHashPolicy: 'caller-invented-policy' }), null);
});

test('native worker report verification accepts exact formal lineage and rejects malformed or mixed scope', () => {
  const formalReceipt = verifiedWorkerReceipt();
  const validReport = workerExecutionReport([formalReceipt]);
  assert.deepEqual(verifyNativeResearchWorkerExecutionReport(validReport, {
    paperId: 'paper-report',
    taskKey: 'paper:report',
    requireFormalWorkers: true,
    theoremSpecificationHash: 'sha256:theorem-specification',
  }), { valid: true, blockers: [] });

  const missing = verifyNativeResearchWorkerExecutionReport(null, {
    paperId: 'paper-report',
    taskKey: 'paper:report',
    requireFormalWorkers: true,
    theoremSpecificationHash: 'sha256:theorem-specification',
  });
  assert.equal(missing.valid, false);
  for (const blocker of [
    'native_research_worker_execution_report_shape_invalid',
    'native_research_worker_execution_report_hash_invalid',
    'native_research_worker_execution_report_paper_mismatch',
    'native_research_worker_execution_report_task_mismatch',
    'native_research_worker_execution_report_theorem_specification_mismatch',
    'native_research_workers_not_verified',
    'native_research_worker_receipts_invalid',
    'native_research_worker_execution_report_counts_invalid',
    'formal_lake_worker_receipt_required',
    'formal_verification_worker_scope_invalid',
  ]) assert.ok(missing.blockers.includes(blocker), blocker);

  const invalidFormalReceipt = {
    ...formalReceipt,
    paperId: 'paper-other',
    planHash: 'sha256:other-plan',
    theoremSpecificationHash: 'sha256:other-theorem-specification',
    engineHash: 'sha256:other-engine',
    status: 'native_research_worker_execution_blocked',
    academicEvidenceEligible: false,
    sourceMutationDetected: true,
    result: { status: 'formal_claim_failed', replayReceipt: { status: 'formal_claim_replay_failed' } },
    resultHash: 'sha256:invalid-result',
    nativeResearchWorkerExecutionReceiptHash: 'sha256:invalid-receipt',
  };
  const nonFormalReceipt = verifiedWorkerReceipt({
    workerId: 'integrity-worker',
    workerType: 'artifact_integrity',
    result: { status: 'artifact_integrity_verified' },
  });
  const mixedReport = workerExecutionReport([invalidFormalReceipt, nonFormalReceipt], {
    status: 'native_research_workers_blocked',
    executeRequested: false,
    workerTypeFilter: [],
    plannedResearchWorkerCount: 0,
    executedResearchWorkerCount: 0,
    verifiedAcademicEvidenceWorkerCount: 0,
    workerReceiptHashes: [],
    blockers: ['injected_report_blocker'],
  });
  const mixed = verifyNativeResearchWorkerExecutionReport(mixedReport, {
    paperId: 'paper-report',
    taskKey: 'paper:report',
    requireFormalWorkers: true,
    theoremSpecificationHash: 'sha256:theorem-specification',
  });
  assert.equal(mixed.valid, false);
  for (const blocker of [
    'native_research_workers_not_verified',
    'native_research_worker_execution_report_has_blockers',
    'native_research_worker_receipt_hash_invalid:formal-worker',
    'native_research_worker_result_hash_invalid:formal-worker',
    'native_research_worker_report_binding_invalid:formal-worker',
    'native_research_worker_receipt_not_verified:formal-worker',
    'native_research_worker_execution_report_counts_invalid',
    'formal_verification_worker_scope_invalid',
    'formal_verification_scope_contains_non_formal_worker',
    'formal_lake_worker_receipt_incomplete:formal-worker',
  ]) assert.ok(mixed.blockers.includes(blocker), blocker);
});

test('native worker dry-run rejects hostile plans, invalid inputs, and empty type filters', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-native-worker-fail-closed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside source scope\n');
  fs.writeFileSync(path.join(sourceRoot, 'input.txt'), 'trusted input\n');
  fs.writeFileSync(path.join(sourceRoot, 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}\n');
  const planPath = path.join(sourceRoot, 'RESEARCH_WORKER_PLAN.json');
  const paperTask = {
    paperId: 'paper-hostile-plan',
    taskKey: 'paper:hostile-plan',
    sourceWorkspace: sourceRoot,
    mainTex: path.join(sourceRoot, 'main.tex'),
  };
  const writePlan = (plan) => fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  writePlan({
    version: 2,
    kind: 'CallerDefinedResearchWorkerPlan',
    paperId: 'paper-other',
    taskKey: 'paper:other',
    workers: [{
      id: 'bad id!',
      type: 'not_allowlisted',
      evidenceClass: 'caller_evidence',
      syntheticInput: true,
      outcomesPreprogrammed: true,
      claimIds: [],
      inputs: [
        { role: 'outside', path: '../outside.txt' },
        { role: 'missing', path: 'missing.txt', sha256: `sha256:${'1'.repeat(64)}` },
        { role: 'mismatched', path: 'input.txt', sha256: `sha256:${'2'.repeat(64)}` },
      ],
    }],
  });
  const hostile = await runNativeResearchWorkers({
    root, sourceRoot, runtimeRoot, paperTask, execute: false,
  });
  assert.equal(hostile.status, 'native_research_workers_blocked');
  for (const blocker of [
    'research_worker_plan_schema_invalid',
    'research_worker_plan_paper_id_mismatch',
    'research_worker_plan_task_key_mismatch',
    'research_worker_id_invalid',
    'native_research_worker_type_not_allowed',
    'research_worker_evidence_class_invalid',
    'research_worker_synthetic_input_not_eligible',
    'research_worker_preprogrammed_outcomes_not_eligible',
    'research_worker_claim_ids_missing',
    '../outside.txt:research_worker_input_outside_source_workspace',
    '../outside.txt:research_worker_input_missing',
    '../outside.txt:research_worker_input_hash_missing',
    'missing.txt:research_worker_input_missing',
    'input.txt:research_worker_input_hash_mismatch',
    'native_research_worker_execution_receipt_missing',
  ]) assert.ok(hostile.blockers.includes(blocker), blocker);
  assert.equal(hostile.workerReceipts[0].academicEvidenceEligible, false);
  assert.equal(hostile.workerReceipts[0].status, 'native_research_worker_execution_verification_blocked');

  writePlan({
    version: 1,
    kind: 'NativeResearchWorkerPlan',
    paperId: paperTask.paperId,
    taskKey: paperTask.taskKey,
    workers: [{
      id: 'integrity',
      type: 'artifact_integrity',
      evidenceClass: 'research_evidence',
      syntheticInput: false,
      outcomesPreprogrammed: false,
      claimIds: ['claim-1'],
      inputs: [],
    }],
  });
  const missingInputs = await runNativeResearchWorkers({
    root, sourceRoot, runtimeRoot, paperTask, execute: false,
  });
  assert.ok(missingInputs.blockers.includes('research_worker_inputs_missing'));
  assert.ok(missingInputs.blockers.includes('native_research_worker_execution_receipt_missing'));

  const invalidFilter = await runNativeResearchWorkers({
    root, sourceRoot, runtimeRoot, paperTask, execute: false, workerTypes: ['caller_worker'],
  });
  assert.equal(invalidFilter.plannedResearchWorkerCount, 0);
  assert.ok(invalidFilter.blockers.includes('native_research_worker_type_filter_invalid'));
  assert.ok(invalidFilter.blockers.includes('native_research_worker_type_filter_empty'));
});

test('native trusted writer is selected by a composition-bound producer API, never by receipt kind', () => {
  const { parent, root, runtimeRoot } = decoupledFixture('hepta-native-receipt-policy-');
  const context = bootstrapLegacyPaperExecutionContext({ root, runtimeRoot, mode: 'native-receipt-policy-test' });
  const { store, receiptLedger, jobReceiptStore: ordinaryJobs, nativeResearchWorkerJobReceiptStore: nativeProducerJobs } = context.services;
  try {
    const forgedAttempt = beginAttempt(ordinaryJobs, 'forged-job', 'forger');
    const forgedKind = sealReceiptHash({ ...goldenPayload(), attemptId: forgedAttempt.attemptId, leaseGeneration: forgedAttempt.leaseGeneration }, { hashField: 'nativeResearchWorkerExecutionReceiptHash' });
    assert.throws(() => ordinaryJobs.completeJob({ jobId: 'forged-job', attemptId: forgedAttempt.attemptId, workerId: forgedAttempt.workerId, leaseGeneration: forgedAttempt.leaseGeneration, receipt: forgedKind }), /job receipt kind forbidden/);
    assert.equal(ordinaryJobs.get('forged-job').status, 'running');
    assert.equal(receiptLedger.listRawForAudit({ stream: 'jobs' }).length, 0);

    const nativeAttempt = beginAttempt(nativeProducerJobs, 'native-job', 'native-worker');
    const wrongPayload = { version: 1, kind: 'ResearchGapPlanningReceipt', status: 'recorded', attemptId: nativeAttempt.attemptId };
    const wrongKind = { ...wrongPayload, receiptHash: hashRecord(wrongPayload.kind, wrongPayload) };
    assert.throws(() => nativeProducerJobs.completeJob({ jobId: 'native-job', attemptId: nativeAttempt.attemptId, workerId: nativeAttempt.workerId, leaseGeneration: nativeAttempt.leaseGeneration, receipt: wrongKind }), /job receipt kind forbidden/);
    assert.equal(nativeProducerJobs.get('native-job').status, 'running');
    assert.equal(receiptLedger.listRawForAudit({ stream: 'jobs' }).length, 0);

    const legal = nativeCompletionReceipt({ jobId: 'native-job', attempt: nativeAttempt });
    const completed = nativeProducerJobs.completeJob({ jobId: 'native-job', attemptId: nativeAttempt.attemptId, workerId: nativeAttempt.workerId, leaseGeneration: nativeAttempt.leaseGeneration, receipt: legal });
    const stored = receiptLedger.getRawForAudit(completed.ledgerReceipt.receiptId);
    assert.equal(stored.writer_trusted, 1);
    assert.equal(stored.issuer_policy_id, 'native-research-worker');
    const verification = verifyTrustedLedgerReceipt({
      receipt: { ...legal, ledgerReceiptId: completed.ledgerReceipt.receiptId },
      ledgerReceiptId: completed.ledgerReceipt.receiptId,
      receiptLedger,
      expectedKinds: ['NativeResearchWorkerExecutionReceipt'],
      expectedStreams: ['jobs'],
      expectedWriterKinds: ['native-research-worker'],
    });
    assert.equal(verification.status, 'trusted_ledger_receipt_verified');
    assert.equal(verification.receiptHashPolicy, RECEIPT_HASH_POLICIES.CURRENT);
    const subjectReceipt = sealReceiptHash({
      ...legal,
      jobId: 'native-subject-ledger-only',
    }, { hashField: 'nativeResearchWorkerExecutionReceiptHash' });
    const subjectLedger = composeTrustedReceiptLedgers({
      store,
      clock: context.services.clock,
    }).nativeResearchWorker;
    const subjectRecorded = subjectLedger.record(subjectReceipt, {
      stream: 'jobs',
      paperId: 'paper-subject-forged',
    });
    const subjectMismatch = verifyTrustedLedgerReceipt({
      receipt: { ...subjectReceipt, ledgerReceiptId: subjectRecorded.receiptId },
      ledgerReceiptId: subjectRecorded.receiptId,
      receiptLedger,
      expectedKinds: ['NativeResearchWorkerExecutionReceipt'],
      expectedStreams: ['jobs'],
    });
    assert.equal(subjectMismatch.status, 'trusted_ledger_receipt_blocked');
    assert.equal(subjectMismatch.blockers.includes('trusted_receipt_ledger_paper_mismatch'), true);
  } finally {
    store.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('native completion binds every trusted receipt identity field and eligibility to the active attempt', () => {
  const { parent, root, runtimeRoot } = decoupledFixture('hepta-native-receipt-context-');
  const context = bootstrapLegacyPaperExecutionContext({ root, runtimeRoot, mode: 'native-receipt-context-test' });
  const { store, receiptLedger, nativeResearchWorkerJobReceiptStore: jobs } = context.services;
  const mismatchCases = [
    ['jobId', 'other-job', /native_job_completion_receipt_job_id_mismatch/],
    ['attemptId', 'other-attempt', /native_job_completion_receipt_attempt_id_mismatch/],
    ['leaseGeneration', 2, /native_job_completion_receipt_lease_generation_mismatch/],
    ['workerId', 'other-worker', /native_job_completion_receipt_worker_id_mismatch/],
    ['paperId', 'other-paper', /native_job_completion_receipt_paper_id_mismatch/],
    ['status', 'native_research_worker_execution_blocked', /native_job_completion_receipt_status_ineligible/],
    ['academicEvidenceEligible', false, /native_job_completion_receipt_academic_evidence_ineligible/],
  ];
  try {
    mismatchCases.forEach(([field, mismatchedValue, expectedError], index) => {
      const jobId = `context-job-${index}`;
      const attempt = beginAttempt(jobs, jobId, `worker-${index}`);
      const receipt = nativeCompletionReceipt({
        jobId,
        attempt,
        overrides: { [field]: mismatchedValue },
      });
      assert.equal(
        computeReceiptHash(receipt),
        receipt.nativeResearchWorkerExecutionReceiptHash,
        `${field} mismatch fixture must retain a valid receipt hash`,
      );
      assert.throws(() => jobs.completeJob({
        jobId,
        attemptId: attempt.attemptId,
        workerId: attempt.workerId,
        leaseGeneration: attempt.leaseGeneration,
        receipt,
      }), expectedError);
      const job = jobs.get(jobId);
      const attemptRow = store.query(`SELECT status,receipt_id,completed_at FROM job_attempts WHERE attempt_id='${attempt.attemptId}';`).rows[0];
      assert.equal(job.status, 'running');
      assert.equal(job.result_receipt_id, null);
      assert.equal(job.lease_owner, attempt.workerId);
      assert.deepEqual(attemptRow, { status: 'running', receipt_id: null, completed_at: null });
      assert.equal(receiptLedger.listRawForAudit({ stream: 'jobs' }).length, 0);
    });
  } finally {
    store.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('native completion and failure require the current self-hash policy and share active-attempt context fencing', () => {
  const { parent, root, runtimeRoot } = decoupledFixture('hepta-native-receipt-settlement-');
  const context = bootstrapLegacyPaperExecutionContext({ root, runtimeRoot, mode: 'native-receipt-settlement-test' });
  const { store, receiptLedger, nativeResearchWorkerJobReceiptStore: jobs } = context.services;
  const assertUnsettled = (jobId, attempt) => {
    assert.equal(jobs.get(jobId).status, 'running');
    assert.deepEqual(
      store.query(`SELECT status,receipt_id,completed_at FROM job_attempts WHERE attempt_id='${attempt.attemptId}';`).rows[0],
      { status: 'running', receipt_id: null, completed_at: null },
    );
    assert.equal(receiptLedger.listRawForAudit({ stream: 'jobs' }).length, 0);
  };
  try {
    const invalidHashJob = 'native-invalid-self-hash';
    const invalidHashAttempt = beginAttempt(jobs, invalidHashJob, 'native-invalid-self-hash-worker');
    const validCompletion = nativeCompletionReceipt({ jobId: invalidHashJob, attempt: invalidHashAttempt });
    assert.throws(() => jobs.completeJob({
      jobId: invalidHashJob,
      attemptId: invalidHashAttempt.attemptId,
      workerId: invalidHashAttempt.workerId,
      leaseGeneration: invalidHashAttempt.leaseGeneration,
      receipt: { ...validCompletion, nativeResearchWorkerExecutionReceiptHash: 'sha256:definitely-invalid' },
    }), /native_job_completion_receipt_hash_invalid/);
    assertUnsettled(invalidHashJob, invalidHashAttempt);

    const legacyJob = 'native-legacy-write-policy';
    const legacyAttempt = beginAttempt(jobs, legacyJob, 'native-legacy-write-worker');
    const current = nativeCompletionReceipt({ jobId: legacyJob, attempt: legacyAttempt });
    const { receiptHashPolicy: _policy, nativeResearchWorkerExecutionReceiptHash: _hash, ...legacyPayload } = current;
    const legacy = {
      ...legacyPayload,
      nativeResearchWorkerExecutionReceiptHash: hashPaperRecord(legacyPayload.kind, legacyPayload),
    };
    assert.equal(computeReceiptHash(legacy), legacy.nativeResearchWorkerExecutionReceiptHash);
    assert.throws(() => jobs.completeJob({
      jobId: legacyJob,
      attemptId: legacyAttempt.attemptId,
      workerId: legacyAttempt.workerId,
      leaseGeneration: legacyAttempt.leaseGeneration,
      receipt: legacy,
    }), /native_job_completion_receipt_hash_policy_invalid/);
    assertUnsettled(legacyJob, legacyAttempt);

    const forgedFailureJob = 'native-forged-failure-context';
    const forgedFailureAttempt = beginAttempt(jobs, forgedFailureJob, 'native-failure-worker');
    const forgedFailure = nativeCompletionReceipt({
      jobId: forgedFailureJob,
      attempt: forgedFailureAttempt,
      overrides: {
        paperId: 'paper-forged',
        status: 'native_research_worker_execution_blocked',
        academicEvidenceEligible: false,
        blockers: ['worker_failed'],
      },
    });
    assert.throws(() => jobs.failJob({
      jobId: forgedFailureJob,
      attemptId: forgedFailureAttempt.attemptId,
      workerId: forgedFailureAttempt.workerId,
      leaseGeneration: forgedFailureAttempt.leaseGeneration,
      failureClass: 'worker_verification_failed',
      receipt: forgedFailure,
    }), /native_job_failure_receipt_paper_id_mismatch/);
    assertUnsettled(forgedFailureJob, forgedFailureAttempt);

    const validFailureJob = 'native-valid-failure';
    const validFailureAttempt = beginAttempt(jobs, validFailureJob, 'native-valid-failure-worker');
    const validFailure = nativeCompletionReceipt({
      jobId: validFailureJob,
      attempt: validFailureAttempt,
      overrides: {
        status: 'native_research_worker_execution_blocked',
        academicEvidenceEligible: false,
        blockers: ['worker_failed'],
      },
    });
    const failed = jobs.failJob({
      jobId: validFailureJob,
      attemptId: validFailureAttempt.attemptId,
      workerId: validFailureAttempt.workerId,
      leaseGeneration: validFailureAttempt.leaseGeneration,
      failureClass: 'worker_verification_failed',
      receipt: validFailure,
    });
    assert.equal(failed.status, 'failed_terminal');
    assert.equal(receiptLedger.getRawForAudit(failed.ledgerReceipt.receiptId).writer_trusted, 1);
  } finally {
    store.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('native completion rolls ledger, attempt and job state back when final job settlement fails', () => {
  const { parent, root, runtimeRoot } = decoupledFixture('hepta-native-receipt-rollback-');
  const context = bootstrapLegacyPaperExecutionContext({ root, runtimeRoot, mode: 'native-receipt-rollback-test' });
  const { store, receiptLedger, nativeResearchWorkerJobReceiptStore: jobs } = context.services;
  try {
    const jobId = 'rollback-job';
    const attempt = beginAttempt(jobs, jobId, 'rollback-worker');
    const receipt = nativeCompletionReceipt({ jobId, attempt });
    assert.equal(store.execute(`
      CREATE TRIGGER reject_native_job_completion
      BEFORE UPDATE OF status ON jobs
      WHEN OLD.job_id='rollback-job' AND NEW.status='completed'
      BEGIN
        SELECT RAISE(ABORT,'injected_native_job_completion_failure');
      END;
    `).ok, true);

    assert.throws(() => jobs.completeJob({
      jobId,
      attemptId: attempt.attemptId,
      workerId: attempt.workerId,
      leaseGeneration: attempt.leaseGeneration,
      receipt,
    }), /injected_native_job_completion_failure/);

    const job = jobs.get(jobId);
    const attemptRow = store.query(`SELECT status,receipt_id,completed_at FROM job_attempts WHERE attempt_id='${attempt.attemptId}';`).rows[0];
    assert.equal(job.status, 'running');
    assert.equal(job.result_receipt_id, null);
    assert.equal(job.lease_owner, attempt.workerId);
    assert.deepEqual(attemptRow, { status: 'running', receipt_id: null, completed_at: null });
    assert.equal(receiptLedger.listRawForAudit({ stream: 'jobs' }).length, 0);
  } finally {
    store.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('real native worker emits a v2 receipt that passes trusted-ledger verification', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-native-worker-positive-'));
  const root = path.join(parent, 'assets');
  const sourceRoot = path.join(root, 'source');
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const input = Buffer.from('trusted native worker input\n');
  fs.writeFileSync(path.join(sourceRoot, 'input.txt'), input);
  fs.writeFileSync(path.join(sourceRoot, 'RESEARCH_WORKER_PLAN.json'), `${JSON.stringify({
    version: 1,
    kind: 'NativeResearchWorkerPlan',
    paperId: 'paper-native-positive',
    taskKey: 'paper:paper-native-positive',
    workers: [{
      id: 'integrity',
      type: 'artifact_integrity',
      evidenceClass: 'research_evidence',
      syntheticInput: false,
      outcomesPreprogrammed: false,
      claimIds: ['claim-1'],
      inputs: [{ role: 'evidence', path: 'input.txt', sha256: hashBytes(input) }],
    }],
  }, null, 2)}\n`);
  migrateFixtureStore(root, runtimeRoot);
  const context = bootstrapLegacyPaperExecutionContext({ root, runtimeRoot, mode: 'native-worker-positive-test', execute: true });
  try {
    const report = await runNativeResearchWorkers({
      root,
      sourceRoot,
      runtimeRoot,
      paperTask: { paperId: 'paper-native-positive', taskKey: 'paper:paper-native-positive' },
      execute: true,
      jobReceiptStore: context.services.nativeResearchWorkerJobReceiptStore,
      artifactRepositoryFactory: context.services.artifactRepositoryFactory,
    });
    assert.equal(report.status, 'native_research_workers_verified');
    const receipt = report.workerReceipts[0];
    assert.equal(receipt.receiptHashPolicy, RECEIPT_HASH_POLICIES.CURRENT);
    assert.equal(receipt.attemptId, 'research-worker:paper-native-positive:integrity:attempt:1');
    assert.equal(receipt.leaseGeneration, 1);
    assert.ok(receipt.ledgerReceiptId);
    const verification = verifyTrustedLedgerReceipt({
      receipt,
      ledgerReceiptId: receipt.ledgerReceiptId,
      receiptLedger: context.services.receiptLedger,
      expectedKinds: ['NativeResearchWorkerExecutionReceipt'],
      expectedStatuses: ['native_research_worker_execution_verified'],
      expectedStreams: ['jobs'],
      expectedWriterKinds: ['native-research-worker'],
    });
    assert.equal(verification.status, 'trusted_ledger_receipt_verified');
    assert.deepEqual(verification.blockers, []);
    assert.equal(context.services.nativeResearchWorkerJobReceiptStore.get('research-worker:paper-native-positive:integrity').status, 'completed');
  } finally {
    context.services.persistenceSession.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

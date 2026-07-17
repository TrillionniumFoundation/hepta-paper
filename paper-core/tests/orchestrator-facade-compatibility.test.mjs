import assert from 'node:assert/strict';
import test from 'node:test';
import * as submissionFacade from '../../paper-adapters/submission/index.mjs';
import { prepareSubmissionAuthorities } from '../../paper-adapters/submission/submission-authority-orchestrator.mjs';
import { buildSubmissionLifecycle } from '../../paper-adapters/submission/submission-lifecycle-orchestrator.mjs';
import { buildSubmissionVenuePlan } from '../../paper-adapters/submission/submission-venue-plan.mjs';
import { createSqliteDeliveryRedriveOperations } from '../../paper-adapters/submission/sqlite-delivery-redrive-operations.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const FIXED_NOW = '2026-07-13T00:00:00.000Z';

function sealRecord(kind, field, payload) {
  return { ...payload, [field]: hashRecord(kind, payload) };
}

function createRedriveHarness(initialMessages = {}) {
  const messages = new Map(Object.entries(initialMessages));
  const statements = [];
  const ledgerRecords = [];
  const preparedRecords = [];
  const deadLetterCalls = [];
  const persistence = {
    execute(sql) {
      statements.push(sql);
      for (const match of String(sql).matchAll(/prepared-ledger-(\d+)/g)) {
        const prepared = preparedRecords[Number(match[1]) - 1];
        if (prepared) ledgerRecords.push(prepared);
      }
      return { ok: true };
    },
    query(sql) {
      statements.push(sql);
      return { ok: true, rows: [{ message_id: 'updated' }] };
    },
    rollback() {
      statements.push('ROLLBACK;');
      return { ok: true };
    },
  };
  const receiptLedger = {
    prepare(receipt, context) {
      const existingIndex = preparedRecords.findIndex((item) => item.receipt.receiptHash === receipt.receiptHash);
      if (existingIndex >= 0) return { receiptId: `ledger-${existingIndex + 1}`, receiptHash: receipt.receiptHash, sql: `/* prepared-ledger-${existingIndex + 1} */` };
      const receiptId = `ledger-${preparedRecords.length + 1}`;
      preparedRecords.push({ receipt, context });
      return { receiptId, receiptHash: receipt.receiptHash, sql: `/* prepared-ledger-${preparedRecords.length} */` };
    },
    record(receipt, context) {
      ledgerRecords.push({ receipt, context });
      return { receiptId: `ledger-${ledgerRecords.length}` };
    },
  };
  const api = {
    getOutbox(messageId) {
      return messages.get(messageId) || null;
    },
    deadLetter(input) {
      deadLetterCalls.push(input);
      return { status: 'dead_lettered_by_attempt_limit', ...input };
    },
  };
  const clock = {
    now: () => new Date(FIXED_NOW),
    nowIso: () => FIXED_NOW,
  };
  const operations = createSqliteDeliveryRedriveOperations({ persistence, receiptLedger, clock, getApi: () => api });
  return { operations, persistence, receiptLedger, api, messages, statements, ledgerRecords, preparedRecords, deadLetterCalls };
}

function retryableMessage(overrides = {}) {
  return {
    message_id: 'message-1',
    paper_id: 'paper-1',
    dispatch_hash: `sha256:${'a'.repeat(64)}`,
    nonce: 'nonce-original',
    provider: 'provider-1',
    account_id: 'account-1',
    status: 'retryable_failure',
    attempt_count: 0,
    next_attempt_at: FIXED_NOW,
    payload_json: JSON.stringify({ _delivery: { attempt: 1 } }),
    ...overrides,
  };
}

function redrivePlan(message, overrides = {}) {
  return sealRecord('SubmissionRedrivePlan', 'submissionRedrivePlanHash', {
    version: 1,
    kind: 'SubmissionRedrivePlan',
    status: 'submission_redrive_reauthorization_required',
    dispatchAuthorizationHash: message.dispatch_hash,
    nextAttempt: 2,
    ...overrides,
  });
}

test('submission index remains a compatible façade over bounded orchestrators', () => {
  assert.equal(submissionFacade.prepareSubmissionAuthorities, prepareSubmissionAuthorities);
  assert.equal(submissionFacade.buildSubmissionLifecycle, buildSubmissionLifecycle);
  assert.equal(submissionFacade.buildSubmissionVenuePlan, buildSubmissionVenuePlan);
  assert.deepEqual(Object.keys(submissionFacade).sort(), [
    'buildProviderCapabilitySubject',
    'buildReviewedSubmissionDecisionPacket',
    'buildReviewedVenueEvidence',
    'buildSubmissionLifecycle',
    'buildSubmissionRedriveDecision',
    'buildSubmissionVenuePlan',
    'buildVenueObservationSubject',
    'consumeCampaignReleaseBundleForSubmission',
    'exportSubmissionHandoffBundle',
    'prepareSubmissionAuthorities',
    'verifyCampaignReleaseBundleForSubmission',
    'verifyProviderCapabilityAttestation',
    'verifyReviewedVenueObservationSource',
    'verifySignedAmbiguousRedriveReview',
    'verifySignedExecutorResponse',
  ]);
});

test('SQLite delivery façade preserves the complete public operation surface', () => {
  const delivery = createSqliteSubmissionDeliveryStore({
    store: { execute() { return { ok: true }; }, query() { return { ok: true, rows: [] }; } },
    receiptLedger: {},
    clock: {},
  });
  assert.equal(delivery.version, 1);
  assert.equal(delivery.kind, 'SqliteSubmissionDeliveryStore');
  const methods = [
    'acquireReleaseLock',
    'advanceResponseCursor',
    'claimNextResponse',
    'claimPending',
    'completeResponseConsumption',
    'deadLetter',
    'enqueue',
    'enqueueAuthorized',
    'enqueueRedrive',
    'getOutbox',
    'getReleaseLock',
    'getResponseConsumption',
    'getResponseCursor',
    'heartbeatClaim',
    'listOutbox',
    'listQuarantine',
    'quarantineInvalidIntake',
    'recordResponse',
    'recoverPending',
    'registerProviderCapability',
    'release',
    'reviewAmbiguousResult',
    'scheduleRedrive',
  ];
  assert.deepEqual(Object.keys(delivery).filter((key) => typeof delivery[key] === 'function').sort(), methods);
  for (const method of methods) assert.equal(typeof delivery[method], 'function');
});

test('redrive scheduling records an auditable reauthorization and blocks invalid or exhausted attempts', () => {
  const message = retryableMessage();
  const harness = createRedriveHarness({ [message.message_id]: message });
  const plan = redrivePlan(message);

  const receipt = harness.operations.scheduleRedrive({ messageId: message.message_id, redrivePlan: plan, delaySeconds: 30 });
  assert.equal(receipt.status, 'submission_redrive_reauthorization_required');
  assert.equal(receipt.eligibleAt, '2026-07-13T00:00:30.000Z');
  assert.equal(receipt.ledgerReceiptId, 'ledger-1');
  assert.equal(receipt.receiptHash, hashRecord('SubmissionRedriveReauthorizationRequiredReceipt', {
    version: receipt.version,
    kind: receipt.kind,
    status: receipt.status,
    messageId: receipt.messageId,
    paperId: receipt.paperId,
    priorDispatchAuthorizationHash: receipt.priorDispatchAuthorizationHash,
    priorNonce: receipt.priorNonce,
    redrivePlanHash: receipt.redrivePlanHash,
    nextAttempt: receipt.nextAttempt,
    eligibleAt: receipt.eligibleAt,
    externalActionPerformed: receipt.externalActionPerformed,
    createdAt: receipt.createdAt,
  }));
  assert.match(harness.statements.join('\n'), /status='reauthorization_required'/);
  assert.match(harness.statements.join('\n'), /2026-07-13T00:00:30\.000Z/);
  assert.deepEqual(harness.ledgerRecords[0].context, { stream: 'submission-delivery', paperId: message.paper_id, strictInsert: true });

  const wrongStatus = retryableMessage({ message_id: 'message-pending', status: 'pending' });
  harness.messages.set(wrongStatus.message_id, wrongStatus);
  assert.throws(
    () => harness.operations.scheduleRedrive({ messageId: wrongStatus.message_id, redrivePlan: redrivePlan(wrongStatus) }),
    /only retryable failures/,
  );
  assert.throws(
    () => harness.operations.scheduleRedrive({ messageId: 'missing', redrivePlan: plan }),
    /outbox message missing/,
  );
  assert.throws(
    () => harness.operations.scheduleRedrive({ messageId: message.message_id, redrivePlan: { ...plan, submissionRedrivePlanHash: 'sha256:tampered' } }),
    /redrive plan hash invalid/,
  );
  assert.throws(
    () => harness.operations.scheduleRedrive({ messageId: message.message_id, redrivePlan: redrivePlan(message, { nextAttempt: 3 }) }),
    /redrive plan attempt mismatch/,
  );

  const exhausted = retryableMessage({
    message_id: 'message-exhausted',
    attempt_count: 2,
    payload_json: JSON.stringify({ _delivery: { attempt: 3 } }),
  });
  harness.messages.set(exhausted.message_id, exhausted);
  assert.deepEqual(
    harness.operations.scheduleRedrive({ messageId: exhausted.message_id, maximumAttempts: 3 }),
    { status: 'dead_lettered_by_attempt_limit', messageId: exhausted.message_id, failureClass: 'redrive_attempt_limit_reached' },
  );
  assert.deepEqual(harness.deadLetterCalls, [{ messageId: exhausted.message_id, failureClass: 'redrive_attempt_limit_reached' }]);
});

test('ambiguous-result review supports waiting and approved paths while failing closed', () => {
  const message = retryableMessage({ status: 'pending', payload_json: '{}' });
  const harness = createRedriveHarness({ [message.message_id]: message });
  const waitingDecision = sealRecord('SubmissionRedriveDecision', 'submissionRedriveDecisionHash', {
    version: 1,
    kind: 'SubmissionRedriveDecision',
    status: 'submission_redrive_waiting',
    decision: 'continue_waiting',
    dispatchAuthorizationHash: message.dispatch_hash,
    responseDueAt: '2026-07-13T01:00:00.000Z',
  });

  const waiting = harness.operations.reviewAmbiguousResult({ messageId: message.message_id, redriveDecision: waitingDecision });
  assert.deepEqual(waiting, {
    status: 'submission_redrive_waiting',
    messageId: message.message_id,
    responseDueAt: waitingDecision.responseDueAt,
    externalActionPerformed: false,
  });
  assert.match(harness.statements.at(-1), /status='waiting_for_response'/);

  const approvedDecision = sealRecord('SubmissionRedriveDecision', 'submissionRedriveDecisionHash', {
    version: 1,
    kind: 'SubmissionRedriveDecision',
    status: 'submission_redrive_reauthorization_approved',
    decision: 'redrive',
    dispatchAuthorizationHash: message.dispatch_hash,
    responseDueAt: waitingDecision.responseDueAt,
  });
  const approvedPlan = redrivePlan(message, { redriveDecisionHash: approvedDecision.submissionRedriveDecisionHash });
  const approved = harness.operations.reviewAmbiguousResult({
    messageId: message.message_id,
    redriveDecision: approvedDecision,
    redrivePlan: approvedPlan,
  });
  assert.deepEqual(approved, {
    status: 'submission_redrive_reauthorization_required',
    messageId: message.message_id,
    redrivePlanHash: approvedPlan.submissionRedrivePlanHash,
    externalActionPerformed: false,
  });
  assert.match(harness.statements.at(-1), /status='reauthorization_required'/);
  assert.match(harness.statements.at(-1), new RegExp(approvedPlan.submissionRedrivePlanHash.replace(':', '\\:')));

  assert.throws(
    () => harness.operations.reviewAmbiguousResult({ messageId: message.message_id, redriveDecision: { ...approvedDecision, dispatchAuthorizationHash: 'sha256:wrong' }, redrivePlan: approvedPlan }),
    /decision dispatch mismatch/,
  );
  assert.throws(
    () => harness.operations.reviewAmbiguousResult({ messageId: message.message_id, redriveDecision: { ...approvedDecision, submissionRedriveDecisionHash: 'sha256:tampered' }, redrivePlan: approvedPlan }),
    /decision hash invalid/,
  );
  assert.throws(
    () => harness.operations.reviewAmbiguousResult({ messageId: message.message_id, redriveDecision: approvedDecision, redrivePlan: { ...approvedPlan, redriveDecisionHash: 'sha256:wrong' } }),
    /approved ambiguous result decision and redrive plan required/,
  );
});

test('enqueueRedrive consumes fresh authorization in one transaction and rejects stale scope', () => {
  const planHash = `sha256:${'b'.repeat(64)}`;
  const previous = retryableMessage({
    status: 'reauthorization_required',
    payload_json: JSON.stringify({ _delivery: { redriveReauthorization: { redrivePlanHash: planHash, nextAttempt: 2, eligibleAt: FIXED_NOW } } }),
    next_attempt_at: FIXED_NOW,
  });
  const authorization = sealRecord('SubmissionDispatchAuthorization', 'submissionDispatchAuthorizationHash', {
    version: 1,
    kind: 'SubmissionDispatchAuthorization',
    status: 'submission_dispatch_authorization_ready',
    provider: previous.provider,
    accountId: previous.account_id,
    nonce: 'nonce-redrive-2',
    attempt: 2,
    redrivePlanHash: planHash,
    replayKey: `sha256:${'c'.repeat(64)}`,
    actionScopeKey: `sha256:${'d'.repeat(64)}`,
    dispatchCycleHash: `sha256:${'e'.repeat(64)}`,
    liveAuthorizationHash: `sha256:${'f'.repeat(64)}`,
    responseDueAt: '2026-07-13T02:00:00.000Z',
    providerCapabilityVerificationReceiptHash: `sha256:${'1'.repeat(64)}`,
    portalRoute: '/submit',
  });
  const newMessageId = `submission:${authorization.submissionDispatchAuthorizationHash}`;
  const harness = createRedriveHarness({
    [previous.message_id]: previous,
    [newMessageId]: { ...previous, message_id: newMessageId, dispatch_hash: authorization.submissionDispatchAuthorizationHash, nonce: authorization.nonce, status: 'pending' },
  });

  const receipt = harness.operations.enqueueRedrive({ previousMessageId: previous.message_id, dispatchAuthorization: authorization, payload: { packageHash: 'sha256:package' } });
  assert.equal(receipt.status, 'submission_redrive_enqueued_with_fresh_authorization');
  assert.equal(receipt.messageId, newMessageId);
  assert.equal(receipt.ledgerReceiptId, 'ledger-1');
  const transaction = harness.statements[0];
  assert.match(transaction, /^BEGIN IMMEDIATE;/);
  assert.match(transaction, /status='superseded'/);
  assert.match(transaction, /INSERT INTO submission_outbox/);
  assert.match(transaction, /INSERT INTO submission_authorization_consumptions/);
  assert.match(transaction, /UPDATE submission_release_locks/);
  assert.match(transaction, /COMMIT;$/);

  assert.throws(
    () => harness.operations.enqueueRedrive({ previousMessageId: previous.message_id, dispatchAuthorization: { ...authorization, nonce: previous.nonce }, payload: {} }),
    /authorization hash invalid/,
  );
  const mismatchedScope = sealRecord('SubmissionDispatchAuthorization', 'submissionDispatchAuthorizationHash', {
    ...Object.fromEntries(Object.entries(authorization).filter(([key]) => key !== 'submissionDispatchAuthorizationHash')),
    accountId: 'other-account',
  });
  assert.throws(
    () => harness.operations.enqueueRedrive({ previousMessageId: previous.message_id, dispatchAuthorization: mismatchedScope, payload: {} }),
    /provider\/account scope mismatch/,
  );

  const transactionFailure = createRedriveHarness({ [previous.message_id]: previous, [newMessageId]: harness.messages.get(newMessageId) });
  transactionFailure.persistence.execute = () => { throw new Error('transaction aborted'); };
  assert.throws(
    () => transactionFailure.operations.enqueueRedrive({ previousMessageId: previous.message_id, dispatchAuthorization: authorization, payload: {} }),
    /transaction aborted/,
  );
  assert.equal(transactionFailure.ledgerRecords.length, 0);
});

test('dead-letter writes are deterministic and use an idempotent transactional insert', () => {
  const message = retryableMessage({ attempt_count: 3 });
  const harness = createRedriveHarness({ [message.message_id]: message });

  const first = harness.operations.deadLetter({ messageId: message.message_id, failureClass: 'provider_rejected' });
  const second = harness.operations.deadLetter({ messageId: message.message_id, failureClass: 'provider_rejected' });
  assert.deepEqual(second, first);
  assert.equal(first.status, 'submission_dead_letter_recorded');
  assert.equal(harness.statements.length, 2);
  assert.equal(harness.statements[0], harness.statements[1]);
  assert.match(harness.statements[0], /^BEGIN IMMEDIATE; \/\* prepared-ledger-\d+ \*\/ INSERT OR IGNORE INTO submission_dead_letters/);
  assert.match(harness.statements[0], /UPDATE submission_outbox SET status='dead_letter'/);
  assert.match(harness.statements[0], /COMMIT;$/);
  assert.equal(harness.ledgerRecords.length, 2);
  assert.equal(harness.ledgerRecords[0].receipt.receiptHash, harness.ledgerRecords[1].receipt.receiptHash);
  assert.throws(() => harness.operations.deadLetter({ messageId: 'missing', failureClass: 'unknown' }), /outbox message missing/);
});

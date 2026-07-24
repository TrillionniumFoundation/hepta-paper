import {
  compileExternallyFencedSqliteMutationOperation as operation,
  defineExternallyFencedSqliteMutationStatement,
  externallyFencedSqliteWriterPlanHash,
} from '../automation/externally-fenced-sqlite-mutation-plan.mjs';
import {
  NATIVE_STORE_LEDGER_STATEMENT_IDS,
} from './native-store-ledger-mutation-plan.mjs';

export const NATIVE_STORE_SUBMISSION_DELIVERY_WRITER_ID =
  'writer:native-store:submission-delivery:v1';

export const NATIVE_STORE_SUBMISSION_DELIVERY_OPERATION_IDS = Object.freeze({
  acquireReleaseLock:
    'native-store.delivery-outbox-operations.acquireReleaseLock.v1',
  advanceResponseCursor:
    'native-store.delivery-consumption-operations.advanceResponseCursor.v1',
  claimNextResponse:
    'native-store.delivery-consumption-operations.claimNextResponse.v1',
  claimPending: 'native-store.delivery-outbox-operations.claimPending.v1',
  beginAutonomousSubmissionAttempt:
    'native-store.delivery-outbox-operations.beginAutonomousSubmissionAttempt.v1',
  completeResponseConsumption:
    'native-store.delivery-consumption-operations.completeResponseConsumption.v1',
  deadLetter: 'native-store.delivery-redrive-operations.deadLetter.v1',
  enqueue: 'native-store.delivery-outbox-operations.enqueue.v1',
  enqueueAuthorized:
    'native-store.delivery-outbox-operations.enqueueAuthorized.v1',
  enqueueRedrive:
    'native-store.delivery-redrive-operations.enqueueRedrive.v1',
  heartbeatClaim:
    'native-store.delivery-outbox-operations.heartbeatClaim.v1',
  prepareAutonomousSubmission:
    'native-store.delivery-outbox-operations.prepareAutonomousSubmission.v1',
  quarantineInvalidIntake:
    'native-store.delivery-response-operations.quarantineInvalidIntake.v1',
  recordResponse:
    'native-store.delivery-response-operations.recordResponse.v1',
  recoverPending:
    'native-store.delivery-outbox-operations.recoverPending.v1',
  recordAutonomousSubmissionOutcome:
    'native-store.delivery-outbox-operations.recordAutonomousSubmissionOutcome.v1',
  registerProviderCapability:
    'native-store.delivery-outbox-operations.registerProviderCapability.v1',
  release: 'native-store.delivery-consumption-operations.release.v1',
  reviewAmbiguousResult:
    'native-store.delivery-redrive-operations.reviewAmbiguousResult.v1',
  scheduleRedrive:
    'native-store.delivery-redrive-operations.scheduleRedrive.v1',
});

export const NATIVE_STORE_SUBMISSION_DELIVERY_STATEMENT_IDS = Object.freeze({
  acquireReleaseLock:
    'submission.delivery.release-lock.acquire.v1',
  advanceCursor:
    'submission.delivery.cursor.advance.v1',
  beginAutonomousSubmissionAttempt:
    'submission.delivery.autonomous.begin-attempt.v1',
  claimOutbox:
    'submission.delivery.outbox.claim.v1',
  claimResponse:
    'submission.delivery.response-consumption.claim.v1',
  completeResponseConsumption:
    'submission.delivery.response-consumption.complete.v1',
  deadLetterInsert:
    'submission.delivery.dead-letter.insert.v1',
  enqueueAuthorizationConsumption:
    'submission.delivery.authorization-consumption.enqueue.v1',
  enqueueOutbox:
    'submission.delivery.outbox.enqueue.v1',
  enqueueOutboxAuthorized:
    'submission.delivery.outbox.enqueue-authorized.v1',
  enqueueReleaseLock:
    'submission.delivery.release-lock.enqueue.v1',
  enqueueRedriveAuthorizationConsumption:
    'submission.delivery.authorization-consumption.enqueue-redrive.v1',
  enqueueRedriveOutbox:
    'submission.delivery.outbox.enqueue-redrive.v1',
  enqueueRedriveReleaseLock:
    'submission.delivery.release-lock.enqueue-redrive.v1',
  expireOutboxClaims:
    'submission.delivery.outbox.expire-claims.v1',
  expireResponseClaims:
    'submission.delivery.response-consumption.expire-claims.v1',
  getClaimedOutbox:
    'submission.delivery.outbox.get-claimed.v1',
  getClaimedResponse:
    'submission.delivery.response-consumption.get-claimed.v1',
  getAutonomousSubmission:
    'submission.delivery.autonomous.get.v1',
  getCursor:
    'submission.delivery.cursor.get.v1',
  getEffectiveReceipt:
    'submission.delivery.receipt-ledger.get-effective.v1',
  getInboxResponse:
    'submission.delivery.inbox.get-response.v1',
  getLockedOutbox:
    'submission.delivery.outbox.get-locked.v1',
  getNextResponse:
    'submission.delivery.response-consumption.get-next.v1',
  getResponseConsumption:
    'submission.delivery.response-consumption.get.v1',
  getScopedResponse:
    'submission.delivery.response-consumption.get-scoped.v1',
  heartbeatClaim:
    'submission.delivery.outbox.heartbeat-claim.v1',
  inboxInsert:
    'submission.delivery.inbox.insert.v1',
  prepareAutonomousSubmission:
    'submission.delivery.autonomous.prepare.v1',
  quarantineInsert:
    'submission.delivery.quarantine.insert.v1',
  receiptInsert: NATIVE_STORE_LEDGER_STATEMENT_IDS.insertReceipt,
  receiptInsertIgnore: NATIVE_STORE_LEDGER_STATEMENT_IDS.insertReceiptOrIgnore,
  recoverPending:
    'submission.delivery.outbox.recover-pending.v1',
  recordAutonomousSubmissionOutcome:
    'submission.delivery.autonomous.record-outcome.v1',
  redriveMarkReauthorization:
    'submission.delivery.outbox.redrive-mark-reauthorization.v1',
  redriveMarkWaiting:
    'submission.delivery.outbox.redrive-mark-waiting.v1',
  redriveSchedule:
    'submission.delivery.outbox.redrive-schedule.v1',
  redriveSupersede:
    'submission.delivery.outbox.redrive-supersede.v1',
  registerProviderCapability:
    'submission.delivery.provider-capability.register.v1',
  releaseLock:
    'submission.delivery.release-lock.release.v1',
  responseConsumptionInsert:
    'submission.delivery.response-consumption.insert.v1',
  responseOutboxUpdate:
    'submission.delivery.outbox.record-response.v1',
  selectProviderCapability:
    'submission.delivery.provider-capability.select.v1',
  setDeadLetter:
    'submission.delivery.outbox.set-dead-letter.v1',
});

const S = NATIVE_STORE_SUBMISSION_DELIVERY_STATEMENT_IDS;

const RECEIPT_COLUMNS = `receipt_id,stream,paper_id,kind,status,receipt_json,
  receipt_sha256,created_at,environment,evidence_class,release_commit,writer_id,
  writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,issuer_assurance`;
const RECEIPT_VALUES = '?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?';

const statement = (statementId, mode, sql) => (
  defineExternallyFencedSqliteMutationStatement(statementId, sql, mode)
);

const run = (statementId, sql) => statement(statementId, 'run', sql);
const get = (statementId, sql) => statement(statementId, 'get', sql);

const RECEIPT_INSERT_STATEMENT = run(
  S.receiptInsert,
  `INSERT INTO receipt_ledger(${RECEIPT_COLUMNS}) VALUES(${RECEIPT_VALUES})`,
);
const RECEIPT_INSERT_IGNORE_STATEMENT = run(
  S.receiptInsertIgnore,
  `INSERT OR IGNORE INTO receipt_ledger(${RECEIPT_COLUMNS}) VALUES(${RECEIPT_VALUES})`,
);
const receiptInsert = (strict = true) => (
  strict ? RECEIPT_INSERT_STATEMENT : RECEIPT_INSERT_IGNORE_STATEMENT
);

const O = NATIVE_STORE_SUBMISSION_DELIVERY_OPERATION_IDS;

const plans = [
  operation(O.prepareAutonomousSubmission, [
    get(S.getAutonomousSubmission, `SELECT * FROM submission_outbox
      WHERE delivery_kind='autonomous' AND message_id=? LIMIT 1`),
    run(S.prepareAutonomousSubmission, `INSERT INTO submission_outbox(
      delivery_kind,message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,attempt_count,
      payload_json,next_attempt_at,created_at,updated_at,replay_key,action_scope_key,
      dispatch_cycle_hash,authorization_receipt_hash,executor_descriptor_hash,portal_route
    ) VALUES('autonomous',?,?,?,?,?,?,'pending',0,?,?,?,?,?,?,?,?,?,?)`),
    receiptInsert(false),
  ]),
  operation(O.beginAutonomousSubmissionAttempt, [
    run(S.beginAutonomousSubmissionAttempt, `UPDATE submission_outbox SET
      status='in_flight',attempt_count=?,payload_json=?,next_attempt_at=?,updated_at=?
      WHERE delivery_kind='autonomous' AND message_id=? AND status=?
        AND attempt_count=? AND payload_json=?`),
    get(S.getAutonomousSubmission, `SELECT * FROM submission_outbox
      WHERE delivery_kind='autonomous' AND message_id=? LIMIT 1`),
    receiptInsert(false),
  ]),
  operation(O.recordAutonomousSubmissionOutcome, [
    run(S.recordAutonomousSubmissionOutcome, `UPDATE submission_outbox SET
      status=?,payload_json=?,claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,
      heartbeat_at=NULL,updated_at=? WHERE delivery_kind='autonomous'
      AND message_id=? AND status=?
      AND attempt_count=? AND payload_json=?`),
    receiptInsert(false),
  ]),
  operation(O.enqueueAuthorized, [
    run(S.enqueueAuthorizationConsumption, `INSERT INTO submission_authorization_consumptions(
      nonce,authorization_receipt_hash,replay_key,dispatch_cycle_hash,paper_id,message_id,consumed_at
    ) VALUES(?,?,?,?,?,?,?)`),
    run(S.enqueueOutboxAuthorized, `INSERT INTO submission_outbox(
      delivery_kind,message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,attempt_count,
      payload_json,next_attempt_at,created_at,updated_at,replay_key,action_scope_key,
      dispatch_cycle_hash,authorization_receipt_hash,executor_descriptor_hash,
      response_due_at,executor_capabilities_hash,
      provider_capability_verification_receipt_hash,portal_route
    ) VALUES('reviewed',?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    run(S.enqueueReleaseLock, `INSERT INTO submission_release_locks(
      paper_id,message_id,lock_token,status,acquired_at
    ) VALUES(?,?,?,'locked',?)`),
  ]),
  operation(O.enqueue, [
    run(S.enqueueOutbox, `INSERT OR IGNORE INTO submission_outbox(
      delivery_kind,message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,attempt_count,
      payload_json,next_attempt_at,created_at,updated_at
    ) VALUES('reviewed',?,?,?,?,?,?,'pending',?,?,?,?,?)`),
  ]),
  operation(O.registerProviderCapability, [
    receiptInsert(false),
    run(S.registerProviderCapability, `INSERT OR IGNORE INTO submission_provider_capabilities(
      capability_id,provider,account_id,portal_route,executor_descriptor_hash,
      capabilities_hash,attestation_hash,verification_receipt_hash,
      verified_subject_ids_json,valid_from,expires_at,status,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'active',?)
      ON CONFLICT(provider,account_id,executor_descriptor_hash) DO NOTHING`),
    get(S.selectProviderCapability, `SELECT * FROM submission_provider_capabilities
      WHERE provider=? AND account_id=? AND executor_descriptor_hash=? LIMIT 1`),
  ]),
  operation(O.claimPending, [
    run(S.claimOutbox, `UPDATE submission_outbox SET status='in_flight',claimed_by=?,
      lease_token=?,lease_expires_at=?,heartbeat_at=?,updated_at=?
      WHERE delivery_kind='reviewed' AND message_id=(SELECT message_id FROM submission_outbox
        WHERE delivery_kind='reviewed' AND status='pending' AND provider=? AND account_id=?
          AND executor_descriptor_hash=? AND executor_capabilities_hash=?
          AND provider_capability_verification_receipt_hash=? AND portal_route=?
          AND response_due_at>? AND (next_attempt_at IS NULL OR next_attempt_at<=?)
        ORDER BY created_at LIMIT 1)`),
    run(S.expireOutboxClaims, `UPDATE submission_outbox SET status='pending',
      claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
      updated_at=? WHERE delivery_kind='reviewed' AND status='in_flight'
      AND lease_expires_at<=?`),
    get(S.getClaimedOutbox, `SELECT * FROM submission_outbox
      WHERE delivery_kind='reviewed' AND lease_token=? LIMIT 1`),
    receiptInsert(true),
  ]),
  operation(O.heartbeatClaim, [
    run(S.heartbeatClaim, `UPDATE submission_outbox SET lease_expires_at=?,
      heartbeat_at=?,updated_at=? WHERE message_id=? AND lease_token=?
      AND delivery_kind='reviewed' AND status='in_flight' AND lease_expires_at>?`),
  ]),
  operation(O.acquireReleaseLock, [
    run(S.acquireReleaseLock, `INSERT OR IGNORE INTO submission_release_locks(
      paper_id,message_id,lock_token,status,acquired_at
    ) VALUES(?,?,?,'locked',?)`),
  ]),
  operation(O.recoverPending, [
    run(S.recoverPending, `UPDATE submission_outbox SET status='pending',
      claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
      updated_at=? WHERE delivery_kind='reviewed' AND status='in_flight'
      AND lease_expires_at<=?`),
  ]),
  operation(O.recordResponse, [
    get(S.getEffectiveReceipt, `SELECT * FROM effective_receipt_ledger
      WHERE receipt_id=? LIMIT 1`),
    get(S.getInboxResponse, `SELECT * FROM submission_inbox
      WHERE response_id=? LIMIT 1`),
    get(S.getLockedOutbox, `SELECT * FROM submission_outbox
      WHERE delivery_kind='reviewed' AND message_id=? LIMIT 1`),
    run(S.inboxInsert, `INSERT INTO submission_inbox(
      response_id,message_id,dispatch_hash,provider_receipt_hash,outcome,response_json,
      received_at,verification_receipt_hash,verification_receipt_json,persisted_receipt_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`),
    receiptInsert(true),
    run(S.responseConsumptionInsert, `INSERT INTO submission_response_consumption(
      response_id,message_id,provider,account_id,anchor_hash,state,created_at,updated_at
    ) VALUES(?,?,?,?,?,'UNCONSUMED',?,?)`),
    run(S.responseOutboxUpdate, `UPDATE submission_outbox SET status=?,claimed_by=NULL,
      lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=?
      WHERE delivery_kind='reviewed' AND message_id=?`),
  ]),
  operation(O.quarantineInvalidIntake, [
    run(S.quarantineInsert, `INSERT OR IGNORE INTO submission_intake_quarantine(
      quarantine_id,message_id,paper_id,payload_hash,failure_codes_json,boundary_kind,received_at
    ) VALUES(?,?,?,?,?,'executor_response',?)`),
    receiptInsert(false),
  ]),
  operation(O.scheduleRedrive, [
    receiptInsert(true),
    run(S.redriveSchedule, `UPDATE submission_outbox SET
      status='reauthorization_required',attempt_count=?,payload_json=?,next_attempt_at=?,
      updated_at=? WHERE delivery_kind='reviewed' AND message_id=?
      AND status='retryable_failure' AND dispatch_hash=?`),
  ]),
  operation(O.reviewAmbiguousResult, [
    run(S.redriveMarkReauthorization, `UPDATE submission_outbox SET
      status='reauthorization_required',attempt_count=?,payload_json=?,next_attempt_at=?,
      updated_at=? WHERE delivery_kind='reviewed' AND message_id=?`),
    run(S.redriveMarkWaiting, `UPDATE submission_outbox SET
      status='waiting_for_response',next_attempt_at=?,updated_at=?
      WHERE delivery_kind='reviewed' AND message_id=?`),
  ]),
  operation(O.enqueueRedrive, [
    run(S.enqueueRedriveAuthorizationConsumption, `INSERT INTO submission_authorization_consumptions(
      nonce,authorization_receipt_hash,replay_key,dispatch_cycle_hash,paper_id,message_id,consumed_at
    ) VALUES(?,?,?,?,?,?,?)`),
    run(S.enqueueRedriveOutbox, `INSERT INTO submission_outbox(
      delivery_kind,message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,attempt_count,
      payload_json,next_attempt_at,created_at,updated_at,replay_key,action_scope_key,
      dispatch_cycle_hash,authorization_receipt_hash,executor_descriptor_hash,
      response_due_at,executor_capabilities_hash,
      provider_capability_verification_receipt_hash,portal_route
    ) VALUES('reviewed',?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    run(S.enqueueRedriveReleaseLock, `UPDATE submission_release_locks SET
      message_id=?,lock_token=?,status='locked',released_at=NULL,reconciliation_hash=NULL
      WHERE paper_id=?`),
    receiptInsert(true),
    run(S.redriveSupersede, `UPDATE submission_outbox SET status='superseded',
      updated_at=? WHERE delivery_kind='reviewed' AND message_id=?`),
  ]),
  operation(O.deadLetter, [
    run(S.deadLetterInsert, `INSERT OR IGNORE INTO submission_dead_letters(
      dead_letter_id,message_id,failure_class,attempt_count,receipt_json,created_at
    ) VALUES(?,?,?,?,?,?)`),
    receiptInsert(false),
    run(S.setDeadLetter, `UPDATE submission_outbox SET status='dead_letter',
      updated_at=? WHERE delivery_kind='reviewed' AND message_id=?`),
  ]),
  operation(O.release, [
    receiptInsert(true),
    run(S.releaseLock, `UPDATE submission_release_locks SET status='released',
      released_at=?,reconciliation_hash=? WHERE paper_id=? AND lock_token=?
      AND status='locked'`),
  ]),
  operation(O.advanceResponseCursor, [
    run(S.advanceCursor, `INSERT INTO submission_delivery_cursors(
      provider,account_id,cursor_response_id,cursor_received_at,cursor_hash,updated_at,cursor_sequence
    ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(provider,account_id) DO UPDATE SET
      cursor_response_id=excluded.cursor_response_id,
      cursor_received_at=excluded.cursor_received_at,cursor_hash=excluded.cursor_hash,
      updated_at=excluded.updated_at,cursor_sequence=excluded.cursor_sequence
      WHERE submission_delivery_cursors.cursor_sequence<excluded.cursor_sequence`),
    get(S.getCursor, `SELECT * FROM submission_delivery_cursors
      WHERE provider=? AND account_id=? LIMIT 1`),
    get(S.getNextResponse, `SELECT response_id,sequence,state
      FROM submission_response_consumption WHERE provider=? AND account_id=?
        AND sequence>? ORDER BY sequence LIMIT 1`),
    get(S.getScopedResponse, `SELECT i.response_id,i.received_at,o.provider,o.account_id,
      c.sequence,c.state FROM submission_inbox i JOIN submission_outbox o
      ON o.message_id=i.message_id JOIN submission_response_consumption c
      ON c.response_id=i.response_id WHERE i.response_id=? AND o.provider=?
      AND o.account_id=? AND o.delivery_kind='reviewed' LIMIT 1`),
  ]),
  operation(O.claimNextResponse, [
    run(S.claimResponse, `UPDATE submission_response_consumption SET
      state='IN_PROGRESS',claimed_by=?,lease_token=?,lease_expires_at=?,updated_at=?
      WHERE sequence=(SELECT sequence FROM submission_response_consumption
        WHERE provider=? AND account_id=? AND sequence>? ORDER BY sequence LIMIT 1)
        AND anchor_hash=? AND state='UNCONSUMED'`),
    run(S.expireResponseClaims, `UPDATE submission_response_consumption SET
      state='UNCONSUMED',claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,
      updated_at=? WHERE state='IN_PROGRESS' AND lease_expires_at<=?`),
    get(S.getClaimedResponse, `SELECT * FROM submission_response_consumption
      WHERE lease_token=? LIMIT 1`),
  ]),
  operation(O.completeResponseConsumption, [
    run(S.completeResponseConsumption, `UPDATE submission_response_consumption SET
      state=?,consumed_at=?,claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,
      updated_at=? WHERE response_id=? AND lease_token=? AND state='IN_PROGRESS'
      AND lease_expires_at>?`),
    get(S.getResponseConsumption, `SELECT * FROM submission_response_consumption
      WHERE response_id=? LIMIT 1`),
  ]),
];

export const NATIVE_STORE_SUBMISSION_DELIVERY_MUTATION_PLANS = Object.freeze(
  Object.fromEntries(plans.map((entry) => [entry.operationId, entry])),
);

export const NATIVE_STORE_SUBMISSION_DELIVERY_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: NATIVE_STORE_SUBMISSION_DELIVERY_WRITER_ID,
    operationPlans: plans,
  });

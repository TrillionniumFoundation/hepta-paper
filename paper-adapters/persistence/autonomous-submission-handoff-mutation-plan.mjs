import {
  compileExternallyFencedSqliteMutationOperation as operation,
  defineExternallyFencedSqliteMutationStatement,
  externallyFencedSqliteWriterPlanHash,
} from '../automation/externally-fenced-sqlite-mutation-plan.mjs';

export const AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_ROLE = 'submission-handoff';
export const AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_INSTANCE_ID =
  AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_ROLE;
export const AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_CONTRACT_ID =
  'autonomous-submission-handoff-schema-v2';
export const AUTONOMOUS_SUBMISSION_HANDOFF_WRITER_ID =
  'writer:submission-handoff:delivery:v1';

export const AUTONOMOUS_SUBMISSION_HANDOFF_OPERATION_IDS = Object.freeze({
  prepare: 'submission-handoff.delivery-outbox-operations.prepareAutonomousSubmission.v1',
  beginAttempt:
    'submission-handoff.delivery-outbox-operations.beginAutonomousSubmissionAttempt.v1',
  recordOutcome:
    'submission-handoff.delivery-outbox-operations.recordAutonomousSubmissionOutcome.v1',
});

export const AUTONOMOUS_SUBMISSION_HANDOFF_STATEMENT_IDS = Object.freeze({
  getAutonomousSubmission: 'submission.handoff.autonomous.get.v1',
  prepareAutonomousSubmission: 'submission.handoff.autonomous.prepare.v1',
  beginAutonomousSubmissionAttempt: 'submission.handoff.autonomous.begin-attempt.v1',
  consumeAutonomousAuthorization:
    'submission.handoff.autonomous.authorization-consume.v1',
  recordAutonomousSubmissionOutcome: 'submission.handoff.autonomous.record-outcome.v1',
  receiptInsertIgnore: 'submission.handoff.receipt.insert-ignore.v1',
});

const statement = (statementId, mode, sql) => (
  defineExternallyFencedSqliteMutationStatement(statementId, sql, mode)
);
const run = (statementId, sql) => statement(statementId, 'run', sql);
const get = (statementId, sql) => statement(statementId, 'get', sql);
const S = AUTONOMOUS_SUBMISSION_HANDOFF_STATEMENT_IDS;
const O = AUTONOMOUS_SUBMISSION_HANDOFF_OPERATION_IDS;
const receiptColumns = `receipt_id,stream,paper_id,kind,status,receipt_json,
  receipt_sha256,created_at,environment,evidence_class,release_commit,writer_id,
  writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,issuer_assurance`;
const receiptInsert = run(S.receiptInsertIgnore,
  `INSERT OR IGNORE INTO receipt_ledger(${receiptColumns})
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const getState = get(S.getAutonomousSubmission, `SELECT * FROM submission_outbox
  WHERE delivery_kind='autonomous' AND message_id=? LIMIT 1`);

const plans = [
  operation(O.prepare, [
    getState,
    run(S.prepareAutonomousSubmission, `INSERT INTO submission_outbox(
      delivery_kind,message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,
      attempt_count,payload_json,next_attempt_at,created_at,updated_at,replay_key,
      action_scope_key,dispatch_cycle_hash,authorization_receipt_hash,
      executor_descriptor_hash,portal_route
    ) VALUES('autonomous',?,?,?,?,?,?,'pending',0,?,?,?,?,?,?,?,?,?,?)`),
    receiptInsert,
  ]),
  operation(O.beginAttempt, [
    run(S.consumeAutonomousAuthorization, `INSERT INTO submission_authorization_consumptions(
      nonce,authorization_receipt_hash,replay_key,dispatch_cycle_hash,paper_id,message_id,consumed_at
    ) VALUES(?,?,?,?,?,?,?)`),
    run(S.beginAutonomousSubmissionAttempt, `UPDATE submission_outbox SET
      status='in_flight',attempt_count=?,payload_json=?,next_attempt_at=?,updated_at=?
      WHERE delivery_kind='autonomous' AND message_id=? AND status=?
        AND attempt_count=? AND payload_json=?`),
    getState,
    receiptInsert,
  ]),
  operation(O.recordOutcome, [
    run(S.recordAutonomousSubmissionOutcome, `UPDATE submission_outbox SET
      status=?,payload_json=?,claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,
      heartbeat_at=NULL,updated_at=? WHERE delivery_kind='autonomous'
      AND message_id=? AND status=? AND attempt_count=? AND payload_json=?`),
    receiptInsert,
  ]),
];

export const AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_PLANS = Object.freeze(
  Object.fromEntries(plans.map((plan) => [plan.operationId, plan])),
);

export const AUTONOMOUS_SUBMISSION_HANDOFF_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: AUTONOMOUS_SUBMISSION_HANDOFF_WRITER_ID,
    operationPlans: plans,
  });

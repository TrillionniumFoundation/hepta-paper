import {
  compileExternallyFencedSqliteMutationOperation as operation,
  defineExternallyFencedSqliteMutationStatement as statement,
  externallyFencedSqliteWriterPlanHash,
} from '../automation/externally-fenced-sqlite-mutation-plan.mjs';

export const NATIVE_STORE_LEDGER_WRITER_ID =
  'writer:native-store:ledger-job-workflow:v1';

export const NATIVE_STORE_LEDGER_OPERATION_IDS = Object.freeze({
  acquireJobLease: 'native-store.job-receipt-store.acquireLease.v1',
  completeJob: 'native-store.job-receipt-store.completeJob.v1',
  createJob: 'native-store.job-receipt-store.createJob.v1',
  failJob: 'native-store.job-receipt-store.failJob.v1',
  qualifyReceipt: 'native-store.receipt-ledger-qualification.qualify.v1',
  recordJobAttempt: 'native-store.job-receipt-store.recordAttempt.v1',
  recordReceipt: 'native-store.receipt-ledger.record.v1',
  renewJobAttemptLease: 'native-store.job-receipt-store.renewAttemptLease.v1',
  putWorkflowState: 'native-store.workflow-state-store.put.v1',
});

export const NATIVE_STORE_LEDGER_STATEMENT_IDS = Object.freeze({
  acquireJobLease: 'native-store.jobs.acquire-lease.v1',
  createJob: 'native-store.jobs.create.v1',
  fenceStaleJobAttempts: 'native-store.job-attempts.fence-stale.v1',
  getJob: 'native-store.jobs.get.v1',
  insertJobAttempt: 'native-store.job-attempts.insert.v1',
  insertReceipt: 'native-store.receipt-ledger.insert.v1',
  insertReceiptOrIgnore: 'native-store.receipt-ledger.insert-or-ignore.v1',
  qualifyReceipt: 'native-store.receipt-ledger-qualifications.insert.v1',
  renewJobAttemptLease: 'native-store.jobs.renew-attempt-lease.v1',
  selectActiveJobAttempt: 'native-store.job-attempts.select-active.v1',
  settleJob: 'native-store.jobs.settle.v1',
  settleJobAttempt: 'native-store.job-attempts.settle.v1',
  startJobAttempt: 'native-store.jobs.start-attempt.v1',
  upsertWorkflowState: 'native-store.workflow-states.upsert.v1',
});

const O = NATIVE_STORE_LEDGER_OPERATION_IDS;
const S = NATIVE_STORE_LEDGER_STATEMENT_IDS;

const RECEIPT_COLUMNS = `receipt_id,stream,paper_id,kind,status,receipt_json,
  receipt_sha256,created_at,environment,evidence_class,release_commit,writer_id,
  writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,issuer_assurance`;
const RECEIPT_VALUES = '?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?';

const INSERT_RECEIPT = statement(
  S.insertReceipt,
  `INSERT INTO receipt_ledger(${RECEIPT_COLUMNS}) VALUES(${RECEIPT_VALUES})`,
);

const INSERT_RECEIPT_OR_IGNORE = statement(
  S.insertReceiptOrIgnore,
  `INSERT OR IGNORE INTO receipt_ledger(${RECEIPT_COLUMNS}) VALUES(${RECEIPT_VALUES})`,
);

const GET_JOB = statement(
  S.getJob,
  'SELECT * FROM jobs WHERE job_id=? LIMIT 1',
  'get',
);

const SELECT_ACTIVE_JOB_ATTEMPT = statement(
  S.selectActiveJobAttempt,
  `SELECT a.attempt_id,j.paper_id
  FROM job_attempts a JOIN jobs j ON j.job_id=a.job_id
  WHERE a.attempt_id=? AND a.job_id=? AND a.worker_id=?
    AND a.lease_generation=? AND a.status='running' AND j.status='running'
    AND j.lease_owner=? AND j.lease_generation=? AND j.lease_expires_at>?
  LIMIT 1`,
  'get',
);

const SETTLE_JOB_ATTEMPT = statement(
  S.settleJobAttempt,
  `UPDATE job_attempts SET status=?,failure_class=?,receipt_id=?,completed_at=?
  WHERE attempt_id=? AND job_id=? AND worker_id=? AND lease_generation=?
    AND status='running'`,
);

const SETTLE_JOB = statement(
  S.settleJob,
  `UPDATE jobs SET status=?,failure_class=?,result_receipt_id=?,lease_owner=NULL,
    lease_expires_at=NULL,updated_at=?
  WHERE job_id=? AND status='running' AND lease_owner=? AND lease_generation=?
    AND lease_expires_at>?`,
);

const SETTLEMENT_STATEMENTS = Object.freeze([
  GET_JOB,
  INSERT_RECEIPT,
  SELECT_ACTIVE_JOB_ATTEMPT,
  SETTLE_JOB,
  SETTLE_JOB_ATTEMPT,
]);

const plans = [
  operation(O.createJob, [
    statement(S.createJob, `INSERT OR IGNORE INTO jobs(
      job_id,deduplication_key,paper_id,kind,status,priority,spec_json,created_at,
      updated_at,environment,evidence_class
    ) VALUES(?,?,?,?,'queued',?,?,?,?,?,?)`),
  ]),
  operation(O.acquireJobLease, [
    statement(S.acquireJobLease, `UPDATE jobs SET status='leased',lease_owner=?,
      lease_expires_at=?,lease_generation=lease_generation+1,failure_class=NULL,
      updated_at=?
    WHERE job_id=? AND (status IN ('queued','failed_retryable')
      OR (status IN ('leased','running') AND lease_expires_at<=?))`),
    statement(S.fenceStaleJobAttempts, `UPDATE job_attempts
      SET status='lost_lease',failure_class='lease_expired',completed_at=?
      WHERE job_id=? AND status='running' AND lease_generation<?`),
    GET_JOB,
  ]),
  operation(O.recordJobAttempt, [
    GET_JOB,
    statement(S.insertJobAttempt, `INSERT INTO job_attempts(
      attempt_id,job_id,attempt_number,worker_id,status,started_at,environment,
      evidence_class,lease_generation
    ) VALUES(?,?,?,?,'running',?,?,?,?)`),
    statement(S.startJobAttempt, `UPDATE jobs SET attempt_count=attempt_count+1,
      status='running',updated_at=?
    WHERE job_id=? AND status='leased' AND lease_owner=? AND lease_generation=?
      AND lease_expires_at>?`),
  ]),
  operation(O.renewJobAttemptLease, [
    GET_JOB,
    statement(S.renewJobAttemptLease, `UPDATE jobs SET lease_expires_at=?,updated_at=?
    WHERE job_id=? AND status='running' AND lease_owner=? AND lease_generation=?
      AND lease_expires_at>?
      AND EXISTS(SELECT 1 FROM job_attempts a WHERE a.attempt_id=?
        AND a.job_id=jobs.job_id AND a.worker_id=? AND a.lease_generation=?
        AND a.status='running')`),
  ]),
  operation(O.completeJob, SETTLEMENT_STATEMENTS),
  operation(O.failJob, SETTLEMENT_STATEMENTS),
  operation(O.recordReceipt, [INSERT_RECEIPT, INSERT_RECEIPT_OR_IGNORE]),
  operation(O.qualifyReceipt, [
    statement(S.qualifyReceipt, `INSERT INTO receipt_ledger_qualifications(
      qualification_id,receipt_id,disposition,reason,replacement_receipt_id,
      qualification_json,qualification_sha256,issuer_policy_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`),
  ]),
  operation(O.putWorkflowState, [
    INSERT_RECEIPT,
    statement(S.upsertWorkflowState, `INSERT INTO workflow_states(
      paper_id,state_json,state_sha256,updated_at,ledger_receipt_id,
      projection_receipt_sha256
    ) VALUES(?,?,?,?,?,?)
    ON CONFLICT(paper_id) DO UPDATE SET state_json=excluded.state_json,
      state_sha256=excluded.state_sha256,updated_at=excluded.updated_at,
      ledger_receipt_id=excluded.ledger_receipt_id,
      projection_receipt_sha256=excluded.projection_receipt_sha256`),
  ]),
];

export const NATIVE_STORE_LEDGER_MUTATION_PLANS = Object.freeze(
  Object.fromEntries(plans.map((plan) => [plan.operationId, plan])),
);

export const NATIVE_STORE_LEDGER_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: NATIVE_STORE_LEDGER_WRITER_ID,
    operationPlans: Object.values(NATIVE_STORE_LEDGER_MUTATION_PLANS),
  });

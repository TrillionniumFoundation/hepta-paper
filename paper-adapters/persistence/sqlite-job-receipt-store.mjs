import { assertJobReceiptStorePort } from '../../paper-ports/job-receipt-store-port.mjs';
import { assertStoreQueryResult, failClosedStoreQueries, sqlText, sqlJson } from '../../paper-ports/store-port.mjs';
import {
  computeReceiptHash,
  RECEIPT_HASH_POLICIES,
  resolveReceiptHashPolicy,
} from '../../paper-domain/evidence/receipt-hash-policy.mjs';
import { parseJsonOrThrow } from '../../workflow-kernel/runtime/data-utils.mjs';

function parse(row) {
  if (!row) return null;
  return {
    ...row,
    spec: parseJsonOrThrow(row.spec_json || '{}', 'job_spec_json_invalid'),
    attemptCount: Number(row.attempt_count || 0),
    leaseGeneration: Number(row.lease_generation || 0),
  };
}

function resultError(result, fallback) {
  return new Error(result?.message || result?.error || result?.stderr || fallback, result instanceof Error ? { cause: result } : undefined);
}

function queryRows(store, sql, fallback) {
  try {
    return assertStoreQueryResult(store.query(sql)).rows;
  } catch (error) {
    throw resultError(error, fallback);
  }
}

function immediateTransaction(store, operation) {
  const begun = store.execute('BEGIN IMMEDIATE;');
  if (!begun.ok) throw resultError(begun, 'job_transaction_begin_failed');
  try {
    const value = operation();
    const committed = store.execute('COMMIT;');
    if (!committed.ok) throw resultError(committed, 'job_transaction_commit_failed');
    return value;
  } catch (error) {
    store.execute('ROLLBACK;');
    throw error;
  }
}

function requiredLeaseGeneration(value) {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('job_lease_generation_required');
  return generation;
}

function recordedLedger(prepared) {
  const { sql: _sql, ...recorded } = prepared;
  return Object.freeze(recorded);
}

const NATIVE_RESEARCH_WORKER_RECEIPT_KIND = 'NativeResearchWorkerExecutionReceipt';
const DEFAULT_JOB_RECEIPT_KINDS = Object.freeze([
  'NativeResearchWorkerExecutionReceipt',
  'OperationalJobResultReceipt',
  'ResearchGapPlanningReceipt',
]);
const SETTLEMENT_RECEIPT_POLICIES = Object.freeze({
  NativeResearchWorkerExecutionReceipt: Object.freeze({ version: 1, hashField: 'nativeResearchWorkerExecutionReceiptHash', forbiddenHashFields: ['receiptHash', 'writeReceiptHash', 'jobReceiptHash'] }),
  OperationalJobResultReceipt: Object.freeze({ version: 1, hashField: 'jobReceiptHash', forbiddenHashFields: ['receiptHash', 'writeReceiptHash'] }),
  ResearchGapPlanningReceipt: Object.freeze({ version: 1, hashField: 'receiptHash', forbiddenHashFields: ['writeReceiptHash', 'jobReceiptHash'] }),
});

function assertSettlementReceiptIntegrity({ receipt, active, jobId, attemptId }) {
  const receiptPolicy = SETTLEMENT_RECEIPT_POLICIES[receipt?.kind];
  if (!receiptPolicy || receipt?.version !== receiptPolicy.version) {
    throw new Error('job_settlement_receipt_kind_or_version_invalid');
  }
  const hashField = receiptPolicy.hashField;
  const policy = resolveReceiptHashPolicy(receipt || {});
  if (!Object.values(RECEIPT_HASH_POLICIES).includes(policy)
    || receiptPolicy.forbiddenHashFields.some((field) => Object.hasOwn(receipt, field))) {
    throw new Error('job_settlement_receipt_hash_policy_invalid');
  }
  if (!receipt?.[hashField] || computeReceiptHash(receipt, { hashField, policy }) !== receipt[hashField]) {
    throw new Error('job_settlement_receipt_hash_invalid');
  }
  if (Object.hasOwn(receipt, 'jobId') && receipt.jobId !== jobId) {
    throw new Error('job_settlement_receipt_job_id_mismatch');
  }
  if (Object.hasOwn(receipt, 'attemptId') && receipt.attemptId !== attemptId) {
    throw new Error('job_settlement_receipt_attempt_id_mismatch');
  }
  if (Object.hasOwn(receipt, 'paperId') && receipt.paperId !== active.paper_id) {
    throw new Error('job_settlement_receipt_paper_id_mismatch');
  }
}

function assertNativeSettlementReceiptContext({
  receipt,
  active,
  jobId,
  attemptId,
  workerId,
  leaseGeneration,
  status,
}) {
  if (receipt?.kind !== NATIVE_RESEARCH_WORKER_RECEIPT_KIND) return;
  const phase = status === 'completed' ? 'completion' : 'failure';
  const bindings = [
    ['job_id', receipt.jobId, jobId],
    ['attempt_id', receipt.attemptId, attemptId],
    ['lease_generation', receipt.leaseGeneration, leaseGeneration],
    ['worker_id', receipt.workerId, workerId],
    ['paper_id', receipt.paperId, active.paper_id],
  ];
  for (const [field, actual, expected] of bindings) {
    if (actual !== expected) throw new Error(`native_job_${phase}_receipt_${field}_mismatch`);
  }
  if (receipt.receiptHashPolicy !== RECEIPT_HASH_POLICIES.CURRENT) {
    throw new Error(`native_job_${phase}_receipt_hash_policy_invalid`);
  }
  if (!receipt.nativeResearchWorkerExecutionReceiptHash
    || computeReceiptHash(receipt) !== receipt.nativeResearchWorkerExecutionReceiptHash) {
    throw new Error(`native_job_${phase}_receipt_hash_invalid`);
  }
  if (status === 'completed' && receipt.status !== 'native_research_worker_execution_verified') {
    throw new Error('native_job_completion_receipt_status_ineligible');
  }
  if (status === 'completed' && receipt.academicEvidenceEligible !== true) {
    throw new Error('native_job_completion_receipt_academic_evidence_ineligible');
  }
  if (status !== 'completed' && receipt.status !== 'native_research_worker_execution_blocked') {
    throw new Error('native_job_failure_receipt_status_invalid');
  }
  if (status !== 'completed' && receipt.academicEvidenceEligible !== false) {
    throw new Error('native_job_failure_receipt_academic_evidence_invalid');
  }
}

export function createSqliteJobReceiptStore({ store: suppliedStore, receiptLedger, clock, allowedReceiptKinds = null, deniedReceiptKinds = [] } = {}) {
  if (!suppliedStore || !receiptLedger || !clock) throw new Error('Job store requires store, receiptLedger and clock');
  const store = failClosedStoreQueries(suppliedStore);
  if (typeof receiptLedger.prepare !== 'function') throw new Error('Job store requires atomic receipt ledger prepare');
  const allowedKinds = new Set((Array.isArray(allowedReceiptKinds)
    ? allowedReceiptKinds
    : DEFAULT_JOB_RECEIPT_KINDS).map(String));
  const deniedKinds = new Set((deniedReceiptKinds || []).map(String));

  const assertReceiptKindAllowed = (receipt) => {
    if (!receipt?.kind || deniedKinds.has(receipt.kind) || (allowedKinds && !allowedKinds.has(receipt.kind))) {
      throw new Error(`job receipt kind forbidden:${receipt?.kind || 'missing'}`);
    }
  };

  const persistReceipt = (receipt, paperId) => {
    assertReceiptKindAllowed(receipt);
    const prepared = receiptLedger.prepare(receipt, {
      stream: 'jobs',
      paperId: paperId || null,
      strictInsert: true,
    });
    const inserted = store.execute(prepared.sql);
    if (!inserted.ok) throw resultError(inserted, 'job_receipt_ledger_write_failed');
    return recordedLedger(prepared);
  };

  const activeAttempt = ({ jobId, attemptId, workerId, leaseGeneration, now }) => {
    const rows = queryRows(store, `SELECT a.attempt_id,j.paper_id FROM job_attempts a JOIN jobs j ON j.job_id=a.job_id WHERE a.attempt_id=${sqlText(attemptId)} AND a.job_id=${sqlText(jobId)} AND a.worker_id=${sqlText(workerId)} AND a.lease_generation=${leaseGeneration} AND a.status='running' AND j.status='running' AND j.lease_owner=${sqlText(workerId)} AND j.lease_generation=${leaseGeneration} AND j.lease_expires_at>${sqlText(now)} LIMIT 1;`, 'job_attempt_validation_failed');
    if (rows.length !== 1) throw new Error('active_job_attempt_lease_fence_required');
    return rows[0];
  };

  const settleJob = ({ jobId, attemptId, workerId, leaseGeneration: rawGeneration, status, failureClass = null, receipt = null }) => {
    if (!jobId || !attemptId || !workerId) throw new Error('jobId, attemptId and workerId are required');
    const leaseGeneration = requiredLeaseGeneration(rawGeneration);
    const now = clock.nowIso();
    return immediateTransaction(store, () => {
      const active = activeAttempt({ jobId, attemptId, workerId, leaseGeneration, now });
      if (receipt) {
        assertReceiptKindAllowed(receipt);
        assertNativeSettlementReceiptContext({
          receipt,
          active,
          jobId,
          attemptId,
          workerId,
          leaseGeneration,
          status,
        });
        assertSettlementReceiptIntegrity({ receipt, active, jobId, attemptId });
      }
      const ledger = receipt ? persistReceipt(receipt, active.paper_id) : null;
      const attemptRows = queryRows(store, `UPDATE job_attempts SET status=${sqlText(status)},failure_class=${failureClass ? sqlText(failureClass) : 'NULL'},receipt_id=${ledger ? sqlText(ledger.receiptId) : 'NULL'},completed_at=${sqlText(now)} WHERE attempt_id=${sqlText(attemptId)} AND job_id=${sqlText(jobId)} AND worker_id=${sqlText(workerId)} AND lease_generation=${leaseGeneration} AND status='running' RETURNING *;`, 'job_attempt_settlement_failed');
      if (attemptRows.length !== 1) throw new Error('job_attempt_settlement_fence_lost');
      const jobRows = queryRows(store, `UPDATE jobs SET status=${sqlText(status)},failure_class=${failureClass ? sqlText(failureClass) : 'NULL'},result_receipt_id=${ledger ? sqlText(ledger.receiptId) : 'NULL'},lease_owner=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE job_id=${sqlText(jobId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND lease_generation=${leaseGeneration} AND lease_expires_at>${sqlText(now)} RETURNING *;`, 'job_settlement_failed');
      if (jobRows.length !== 1) throw new Error('job_settlement_fence_lost');
      return { ...parse(jobRows[0]), ledgerReceipt: ledger };
    });
  };

  const api = {
    version: 2,
    kind: 'SqliteJobReceiptStore',
    createJob(spec = {}) {
      if (!spec.jobId || !spec.deduplicationKey || !spec.kind) throw new Error('jobId, deduplicationKey and kind are required');
      const now = clock.nowIso();
      const environment = spec.environment || process.env.HEPTA_EVIDENCE_ENVIRONMENT || 'production';
      const evidenceClass = spec.evidenceClass || process.env.HEPTA_EVIDENCE_CLASS || 'runtime_unclassified';
      const result = store.execute(`INSERT OR IGNORE INTO jobs(job_id,deduplication_key,paper_id,kind,status,priority,spec_json,created_at,updated_at,environment,evidence_class) VALUES(${sqlText(spec.jobId)},${sqlText(spec.deduplicationKey)},${spec.paperId ? sqlText(spec.paperId) : 'NULL'},${sqlText(spec.kind)},'queued',${Number(spec.priority || 100)},${sqlJson(spec)},${sqlText(now)},${sqlText(now)},${sqlText(environment)},${sqlText(evidenceClass)});`);
      if (!result.ok) throw resultError(result, 'job_create_failed');
      return api.get(spec.jobId) || api.list({ deduplicationKey: spec.deduplicationKey, limit: 1 })[0];
    },
    acquireLease({ jobId, workerId, leaseSeconds = 60 } = {}) {
      if (!jobId || !workerId) throw new Error('jobId and workerId are required');
      const now = clock.nowIso();
      const expires = new Date(clock.now().getTime() + Math.max(1, Number(leaseSeconds)) * 1000).toISOString();
      return immediateTransaction(store, () => {
        const rows = queryRows(store, `UPDATE jobs SET status='leased',lease_owner=${sqlText(workerId)},lease_expires_at=${sqlText(expires)},lease_generation=lease_generation+1,failure_class=NULL,updated_at=${sqlText(now)} WHERE job_id=${sqlText(jobId)} AND (status IN ('queued','failed_retryable') OR (status IN ('leased','running') AND lease_expires_at<=${sqlText(now)})) RETURNING *;`, 'job_lease_failed');
        if (!rows.length) return null;
        if (rows.length !== 1) throw new Error('job_lease_update_ambiguous');
        const job = parse(rows[0]);
        queryRows(store, `UPDATE job_attempts SET status='lost_lease',failure_class='lease_expired',completed_at=${sqlText(now)} WHERE job_id=${sqlText(jobId)} AND status='running' AND lease_generation<${job.leaseGeneration} RETURNING attempt_id;`, 'job_stale_attempt_fencing_failed');
        return job;
      });
    },
    recordAttempt({ jobId, workerId, leaseGeneration: rawGeneration, status = 'running' } = {}) {
      if (!jobId || !workerId) throw new Error('jobId and workerId are required');
      if (status !== 'running') throw new Error('job_attempt_initial_status_invalid');
      const leaseGeneration = requiredLeaseGeneration(rawGeneration);
      const startedAt = clock.nowIso();
      return immediateTransaction(store, () => {
        const jobs = queryRows(store, `UPDATE jobs SET attempt_count=attempt_count+1,status='running',updated_at=${sqlText(startedAt)} WHERE job_id=${sqlText(jobId)} AND status='leased' AND lease_owner=${sqlText(workerId)} AND lease_generation=${leaseGeneration} AND lease_expires_at>${sqlText(startedAt)} RETURNING *;`, 'job_attempt_lease_validation_failed');
        if (jobs.length !== 1) throw new Error('active_job_lease_fence_required');
        const job = parse(jobs[0]);
        const attemptNumber = job.attemptCount;
        const attemptId = `${jobId}:attempt:${attemptNumber}`;
        const attempts = queryRows(store, `INSERT INTO job_attempts(attempt_id,job_id,attempt_number,worker_id,status,started_at,environment,evidence_class,lease_generation) VALUES(${sqlText(attemptId)},${sqlText(jobId)},${attemptNumber},${sqlText(workerId)},'running',${sqlText(startedAt)},${sqlText(job.environment || 'legacy_unclassified')},${sqlText(job.evidence_class || 'legacy_unclassified')},${leaseGeneration}) RETURNING *;`, 'job_attempt_write_failed');
        if (attempts.length !== 1) throw new Error('job_attempt_insert_ambiguous');
        return Object.freeze({ attemptId, attemptNumber, jobId, workerId, leaseGeneration, startedAt, leaseExpiresAt: job.lease_expires_at });
      });
    },
    renewAttemptLease({ jobId, attemptId, workerId, leaseGeneration: rawGeneration, leaseSeconds = 180 } = {}) {
      if (!jobId || !attemptId || !workerId) throw new Error('jobId, attemptId and workerId are required');
      const leaseGeneration = requiredLeaseGeneration(rawGeneration);
      const now = clock.nowIso();
      const expires = new Date(clock.now().getTime() + Math.max(1, Number(leaseSeconds)) * 1000).toISOString();
      const rows = queryRows(store, `UPDATE jobs SET lease_expires_at=${sqlText(expires)},updated_at=${sqlText(now)} WHERE job_id=${sqlText(jobId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND lease_generation=${leaseGeneration} AND lease_expires_at>${sqlText(now)} AND EXISTS(SELECT 1 FROM job_attempts a WHERE a.attempt_id=${sqlText(attemptId)} AND a.job_id=jobs.job_id AND a.worker_id=${sqlText(workerId)} AND a.lease_generation=${leaseGeneration} AND a.status='running') RETURNING *;`, 'job_attempt_lease_renewal_failed');
      if (rows.length !== 1) throw new Error('active_job_attempt_lease_fence_required');
      return parse(rows[0]);
    },
    completeJob({ jobId, attemptId, workerId, leaseGeneration, receipt } = {}) {
      if (!receipt) throw new Error('job completion receipt is required');
      return settleJob({ jobId, attemptId, workerId, leaseGeneration, status: 'completed', receipt });
    },
    failJob({ jobId, attemptId, workerId, leaseGeneration, failureClass, retryable = false, receipt = null } = {}) {
      if (!failureClass) throw new Error('job failure class is required');
      return settleJob({
        jobId,
        attemptId,
        workerId,
        leaseGeneration,
        status: retryable ? 'failed_retryable' : 'failed_terminal',
        failureClass,
        receipt,
      });
    },
    get(jobId) {
      return parse(queryRows(store, `SELECT * FROM jobs WHERE job_id=${sqlText(jobId)} LIMIT 1;`, 'job_read_failed')[0]);
    },
    list({ status = null, deduplicationKey = null, limit = 100 } = {}) {
      const filters = [
        ...(status ? [`status=${sqlText(status)}`] : []),
        ...(deduplicationKey ? [`deduplication_key=${sqlText(deduplicationKey)}`] : []),
      ];
      return queryRows(store, `SELECT * FROM jobs${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY priority,created_at LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 100))};`, 'job_list_failed').map(parse);
    },
  };
  return assertJobReceiptStorePort(api);
}

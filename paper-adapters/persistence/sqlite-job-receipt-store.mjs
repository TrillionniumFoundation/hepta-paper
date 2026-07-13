import { assertJobReceiptStorePort } from '../../paper-ports/job-receipt-store-port.mjs';
import { sqlText, sqlJson } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function parse(row) {
  if (!row) return null;
  return { ...row, spec: JSON.parse(row.spec_json || '{}'), attemptCount: Number(row.attempt_count || 0) };
}

export function createSqliteJobReceiptStore({ store, receiptLedger, receiptLedgerResolver = null, clock } = {}) {
  if (!store || !receiptLedger || !clock) throw new Error('Job store requires store, receiptLedger and clock');
  const api = {
    version: 1,
    kind: 'SqliteJobReceiptStore',
    createJob(spec = {}) {
      if (!spec.jobId || !spec.deduplicationKey || !spec.kind) throw new Error('jobId, deduplicationKey and kind are required');
      const now = clock.nowIso();
      const environment = spec.environment || process.env.HEPTA_EVIDENCE_ENVIRONMENT || 'production';
      const evidenceClass = spec.evidenceClass || process.env.HEPTA_EVIDENCE_CLASS || 'runtime_unclassified';
      const result = store.execute(`INSERT OR IGNORE INTO jobs(job_id,deduplication_key,paper_id,kind,status,priority,spec_json,created_at,updated_at,environment,evidence_class) VALUES(${sqlText(spec.jobId)},${sqlText(spec.deduplicationKey)},${spec.paperId ? sqlText(spec.paperId) : 'NULL'},${sqlText(spec.kind)},'queued',${Number(spec.priority || 100)},${sqlJson(spec)},${sqlText(now)},${sqlText(now)},${sqlText(environment)},${sqlText(evidenceClass)});`);
      if (!result.ok) throw new Error(result.error || result.stderr || 'job_create_failed');
      return api.get(spec.jobId) || api.list({ deduplicationKey: spec.deduplicationKey, limit: 1 })[0];
    },
    acquireLease({ jobId, workerId, leaseSeconds = 60 } = {}) {
      const now = clock.nowIso();
      const expires = new Date(clock.now().getTime() + Math.max(1, Number(leaseSeconds)) * 1000).toISOString();
      const result = store.execute(`BEGIN IMMEDIATE; UPDATE jobs SET status='leased',lease_owner=${sqlText(workerId)},lease_expires_at=${sqlText(expires)},updated_at=${sqlText(now)} WHERE job_id=${sqlText(jobId)} AND status IN ('queued','failed_retryable') AND (lease_expires_at IS NULL OR lease_expires_at<${sqlText(now)}); COMMIT;`);
      if (!result.ok) throw new Error(result.error || result.stderr || 'job_lease_failed');
      const job = api.get(jobId);
      return job?.lease_owner === workerId ? job : null;
    },
    recordAttempt({ jobId, workerId, status = 'running' } = {}) {
      const job = api.get(jobId);
      if (!job || job.lease_owner !== workerId) throw new Error('active job lease required');
      const number = job.attemptCount + 1;
      const startedAt = clock.nowIso();
      const attemptId = `${jobId}:attempt:${number}`;
      const result = store.execute(`BEGIN IMMEDIATE; INSERT INTO job_attempts(attempt_id,job_id,attempt_number,worker_id,status,started_at,environment,evidence_class) VALUES(${sqlText(attemptId)},${sqlText(jobId)},${number},${sqlText(workerId)},${sqlText(status)},${sqlText(startedAt)},${sqlText(job.environment || 'legacy_unclassified')},${sqlText(job.evidence_class || 'legacy_unclassified')}); UPDATE jobs SET attempt_count=${number},status='running',updated_at=${sqlText(startedAt)} WHERE job_id=${sqlText(jobId)}; COMMIT;`);
      if (!result.ok) throw new Error(result.error || result.stderr || 'job_attempt_write_failed');
      return { attemptId, attemptNumber: number, startedAt };
    },
    completeJob({ jobId, attemptId, receipt } = {}) {
      const selectedLedger = typeof receiptLedgerResolver === 'function' ? receiptLedgerResolver(receipt) || receiptLedger : receiptLedger;
      const ledger = selectedLedger.record(receipt, { stream: 'jobs', paperId: api.get(jobId)?.paper_id || null });
      const now = clock.nowIso();
      const result = store.execute(`BEGIN IMMEDIATE; UPDATE job_attempts SET status='completed',receipt_id=${sqlText(ledger.receiptId)},completed_at=${sqlText(now)} WHERE attempt_id=${sqlText(attemptId)}; UPDATE jobs SET status='completed',result_receipt_id=${sqlText(ledger.receiptId)},lease_owner=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE job_id=${sqlText(jobId)}; COMMIT;`);
      if (!result.ok) throw new Error(result.error || result.stderr || 'job_completion_failed');
      return { ...api.get(jobId), ledgerReceipt: ledger };
    },
    failJob({ jobId, attemptId, failureClass, retryable = false, receipt = null } = {}) {
      const now = clock.nowIso();
      const selectedLedger = receipt && typeof receiptLedgerResolver === 'function' ? receiptLedgerResolver(receipt) || receiptLedger : receiptLedger;
      const ledger = receipt ? selectedLedger.record(receipt, { stream: 'jobs', paperId: api.get(jobId)?.paper_id || null }) : null;
      const status = retryable ? 'failed_retryable' : 'failed_terminal';
      const result = store.execute(`BEGIN IMMEDIATE; UPDATE job_attempts SET status=${sqlText(status)},failure_class=${sqlText(failureClass)},receipt_id=${ledger ? sqlText(ledger.receiptId) : 'NULL'},completed_at=${sqlText(now)} WHERE attempt_id=${sqlText(attemptId)}; UPDATE jobs SET status=${sqlText(status)},failure_class=${sqlText(failureClass)},result_receipt_id=${ledger ? sqlText(ledger.receiptId) : 'NULL'},lease_owner=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE job_id=${sqlText(jobId)}; COMMIT;`);
      if (!result.ok) throw new Error(result.error || result.stderr || 'job_failure_write_failed');
      return { ...api.get(jobId), ledgerReceipt: ledger };
    },
    get(jobId) {
      return parse(store.query(`SELECT * FROM jobs WHERE job_id=${sqlText(jobId)} LIMIT 1;`).rows[0]);
    },
    list({ status = null, deduplicationKey = null, limit = 100 } = {}) {
      const filters = [
        ...(status ? [`status=${sqlText(status)}`] : []),
        ...(deduplicationKey ? [`deduplication_key=${sqlText(deduplicationKey)}`] : []),
      ];
      return store.query(`SELECT * FROM jobs${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY priority,created_at LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 100))};`).rows.map(parse);
    },
  };
  return assertJobReceiptStorePort(api);
}

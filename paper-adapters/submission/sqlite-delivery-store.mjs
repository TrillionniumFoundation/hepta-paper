import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function createSqliteSubmissionDeliveryStore({ store, receiptLedger, clock } = {}) {
  if (!store || !receiptLedger || !clock) throw new Error('Delivery store requires store, receiptLedger and clock');
  const execute = (sql) => {
    const result = store.execute(sql);
    if (!result.ok) throw new Error(result.error || result.stderr || 'submission_delivery_store_failed');
  };
  return Object.freeze({
    version: 1,
    kind: 'SqliteSubmissionDeliveryStore',
    enqueue({ paperId, dispatchAuthorization, payload } = {}) {
      if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') throw new Error('ready dispatch authorization required');
      const dispatchHash = dispatchAuthorization.submissionDispatchAuthorizationHash;
      const messageId = `submission:${dispatchHash}`;
      const now = clock.nowIso();
      execute(`INSERT OR IGNORE INTO submission_outbox(message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,payload_json,next_attempt_at,created_at,updated_at) VALUES(${sqlText(messageId)},${sqlText(paperId)},${sqlText(dispatchHash)},${sqlText(dispatchAuthorization.provider)},${sqlText(dispatchAuthorization.accountId)},${sqlText(dispatchAuthorization.nonce)},'pending',${sqlJson(payload || {})},${sqlText(now)},${sqlText(now)},${sqlText(now)});`);
      return this.getOutbox(messageId);
    },
    recordResponse({ messageId, response } = {}) {
      const message = this.getOutbox(messageId);
      if (!message) throw new Error('outbox message missing');
      if (response?.dispatchAuthorizationHash !== message.dispatch_hash) throw new Error('response dispatch hash mismatch');
      if (!response?.responseId || !['submitted', 'rejected', 'failed', 'cancelled'].includes(response.outcome)) throw new Error('invalid executor response');
      if (response.outcome === 'submitted' && !response.providerReceiptHash) throw new Error('submitted response requires provider receipt hash');
      const now = clock.nowIso();
      execute(`BEGIN IMMEDIATE; INSERT OR IGNORE INTO submission_inbox(response_id,message_id,dispatch_hash,provider_receipt_hash,outcome,response_json,received_at) VALUES(${sqlText(response.responseId)},${sqlText(messageId)},${sqlText(message.dispatch_hash)},${response.providerReceiptHash ? sqlText(response.providerReceiptHash) : 'NULL'},${sqlText(response.outcome)},${sqlJson(response)},${sqlText(now)}); UPDATE submission_outbox SET status=${sqlText(response.outcome === 'failed' ? 'retryable_failure' : 'responded')},updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)}; COMMIT;`);
      const receipt = { version: 1, kind: 'SubmissionResponsePersistedReceipt', status: 'submission_response_persisted', messageId, responseId: response.responseId, outcome: response.outcome, dispatchAuthorizationHash: message.dispatch_hash, providerReceiptHash: response.providerReceiptHash || null, createdAt: now };
      return receiptLedger.record({ ...receipt, receiptHash: hashRecord('SubmissionResponsePersistedReceipt', receipt) }, { stream: 'submission-delivery', paperId: message.paper_id });
    },
    scheduleRedrive({ messageId, maximumAttempts = 3, delaySeconds = 60 } = {}) {
      const message = this.getOutbox(messageId);
      if (!message) throw new Error('outbox message missing');
      const attempts = Number(message.attempt_count || 0) + 1;
      const now = clock.nowIso();
      if (attempts >= maximumAttempts) return this.deadLetter({ messageId, failureClass: 'redrive_attempt_limit_reached' });
      const next = new Date(clock.now().getTime() + Math.max(1, Number(delaySeconds)) * 1000).toISOString();
      execute(`UPDATE submission_outbox SET status='pending',attempt_count=${attempts},next_attempt_at=${sqlText(next)},updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)};`);
      return this.getOutbox(messageId);
    },
    deadLetter({ messageId, failureClass } = {}) {
      const message = this.getOutbox(messageId);
      if (!message) throw new Error('outbox message missing');
      const now = clock.nowIso();
      const receipt = { version: 1, kind: 'SubmissionDeadLetterReceipt', status: 'submission_dead_letter_recorded', messageId, failureClass, attemptCount: Number(message.attempt_count || 0), createdAt: now };
      const id = `dead-letter:${hashRecord('SubmissionDeadLetterReceipt', receipt)}`;
      execute(`BEGIN IMMEDIATE; INSERT OR IGNORE INTO submission_dead_letters(dead_letter_id,message_id,failure_class,attempt_count,receipt_json,created_at) VALUES(${sqlText(id)},${sqlText(messageId)},${sqlText(failureClass)},${receipt.attemptCount},${sqlJson(receipt)},${sqlText(now)}); UPDATE submission_outbox SET status='dead_letter',updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)}; COMMIT;`);
      receiptLedger.record({ ...receipt, receiptHash: hashRecord('SubmissionDeadLetterReceipt', receipt) }, { stream: 'submission-delivery', paperId: message.paper_id });
      return receipt;
    },
    acquireReleaseLock({ paperId, messageId, lockToken } = {}) {
      const now = clock.nowIso();
      execute(`INSERT OR IGNORE INTO submission_release_locks(paper_id,message_id,lock_token,status,acquired_at) VALUES(${sqlText(paperId)},${sqlText(messageId)},${sqlText(lockToken)},'locked',${sqlText(now)});`);
      const lock = store.query(`SELECT * FROM submission_release_locks WHERE paper_id=${sqlText(paperId)} LIMIT 1;`).rows[0] || null;
      return lock?.lock_token === lockToken ? lock : null;
    },
    release({ paperId, lockToken, releaseLock } = {}) {
      if (releaseLock?.status !== 'submission_release_unlocked') throw new Error('verified release lock required');
      const current = store.query(`SELECT * FROM submission_release_locks WHERE paper_id=${sqlText(paperId)} AND lock_token=${sqlText(lockToken)} LIMIT 1;`).rows[0] || null;
      if (!current || current.status !== 'locked') throw new Error('active release lock missing');
      const response = store.query(`SELECT * FROM submission_inbox WHERE message_id=${sqlText(current.message_id)} ORDER BY received_at DESC LIMIT 1;`).rows[0] || null;
      if (!response || !['submitted', 'rejected', 'cancelled'].includes(response.outcome)) throw new Error('terminal executor response missing');
      if (response.outcome === 'submitted' && !response.provider_receipt_hash) throw new Error('provider receipt not verified');
      const reconciliationHash = releaseLock.reconciliationHash;
      if (!reconciliationHash) throw new Error('reconciliation hash required');
      const now = clock.nowIso();
      execute(`UPDATE submission_release_locks SET status='released',released_at=${sqlText(now)},reconciliation_hash=${sqlText(reconciliationHash)} WHERE paper_id=${sqlText(paperId)} AND lock_token=${sqlText(lockToken)} AND status='locked';`);
      const released = store.query(`SELECT * FROM submission_release_locks WHERE paper_id=${sqlText(paperId)} LIMIT 1;`).rows[0] || null;
      const receipt = { version: 1, kind: 'SubmissionReleasePersistedReceipt', status: 'submission_release_persisted', paperId, messageId: current.message_id, responseId: response.response_id, reconciliationHash, createdAt: now };
      receiptLedger.record({ ...receipt, receiptHash: hashRecord('SubmissionReleasePersistedReceipt', receipt) }, { stream: 'submission-delivery', paperId });
      return released;
    },
    getOutbox(messageId) {
      return store.query(`SELECT * FROM submission_outbox WHERE message_id=${sqlText(messageId)} LIMIT 1;`).rows[0] || null;
    },
    listOutbox({ status = null, limit = 100 } = {}) {
      return store.query(`SELECT * FROM submission_outbox${status ? ` WHERE status=${sqlText(status)}` : ''} ORDER BY created_at LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 100))};`).rows;
    },
  });
}

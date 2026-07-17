import crypto from 'node:crypto';
import { buildExecutorResponseIntake } from '../../paper-domain/submission/delivery-runtime.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { parseJsonOrThrow } from '../../workflow-kernel/runtime/data-utils.mjs';
import { sqlText } from './sqlite-delivery-persistence.mjs';
import { parseSubmissionOutboxPayload } from './sqlite-delivery-row-mappers.mjs';

export function createSqliteDeliveryConsumptionOperations({ persistence, receiptLedger, clock, getApi } = {}) {
  return {
    release({ paperId, lockToken, releaseLock } = {}) {
      if (releaseLock?.status !== 'submission_release_unlocked') throw new Error('verified release lock required');
      const current = persistence.one(`SELECT * FROM submission_release_locks WHERE paper_id=${sqlText(paperId)} AND lock_token=${sqlText(lockToken)} LIMIT 1;`);
      if (!current || current.status !== 'locked') throw new Error('active release lock missing');
      const response = persistence.one(`SELECT * FROM submission_inbox WHERE message_id=${sqlText(current.message_id)} ORDER BY received_at DESC LIMIT 1;`);
      if (!response || !['submitted', 'rejected', 'cancelled'].includes(response.outcome)) throw new Error('terminal executor response missing');
      if (response.outcome === 'submitted' && !response.provider_receipt_hash) throw new Error('provider receipt not verified');
      const reconciliationHash = releaseLock.reconciliationHash;
      if (!reconciliationHash) throw new Error('reconciliation hash required');
      const message = getApi().getOutbox(current.message_id);
      const authorization = parseSubmissionOutboxPayload(message)._delivery?.dispatchAuthorization;
      const responseIntake = buildExecutorResponseIntake({
        dispatchAuthorization: authorization,
        response: parseJsonOrThrow(response.response_json, 'submission_response_json_invalid'),
        responseVerificationReceipt: response.verification_receipt_json
          ? parseJsonOrThrow(response.verification_receipt_json, 'submission_response_verification_receipt_json_invalid')
          : null,
      });
      if (releaseLock.dispatchAuthorizationHash !== message.dispatch_hash) throw new Error('release lock dispatch hash mismatch');
      if (releaseLock.responseIntakeHash !== responseIntake.executorResponseIntakeHash) throw new Error('release lock response intake hash mismatch');
      const now = clock.nowIso();
      const receipt = { version: 1, kind: 'SubmissionReleasePersistedReceipt', status: 'submission_release_persisted', paperId, messageId: current.message_id, responseId: response.response_id, reconciliationHash, createdAt: now };
      const sealedReceipt = { ...receipt, receiptHash: hashRecord('SubmissionReleasePersistedReceipt', receipt) };
      if (typeof receiptLedger.prepare !== 'function') throw new Error('atomic receipt ledger preparation required');
      const preparedLedger = receiptLedger.prepare(sealedReceipt, { stream: 'submission-delivery', paperId, strictInsert: true });
      persistence.execute('BEGIN IMMEDIATE;');
      const updated = persistence.query(`UPDATE submission_release_locks SET status='released',released_at=${sqlText(now)},reconciliation_hash=${sqlText(reconciliationHash)} WHERE paper_id=${sqlText(paperId)} AND lock_token=${sqlText(lockToken)} AND status='locked' RETURNING paper_id;`);
      if (!updated.ok || updated.rows?.length !== 1) {
        persistence.rollback();
        throw new Error(updated.error || 'active release lock changed before commit');
      }
      try {
        persistence.execute(`${preparedLedger.sql} COMMIT;`);
      } catch (error) {
        persistence.rollback();
        throw error;
      }
      const released = getApi().getReleaseLock(paperId);
      return released;
    },
    advanceResponseCursor({ provider, accountId, responseId } = {}) {
      const now = clock.nowIso();
      persistence.execute('BEGIN IMMEDIATE;');
      const current = getApi().getResponseCursor({ provider, accountId });
      const row = persistence.one(`SELECT i.response_id,i.received_at,o.provider,o.account_id,c.sequence,c.state FROM submission_inbox i JOIN submission_outbox o ON o.message_id=i.message_id JOIN submission_response_consumption c ON c.response_id=i.response_id WHERE i.response_id=${sqlText(responseId)} AND o.provider=${sqlText(provider)} AND o.account_id=${sqlText(accountId)} LIMIT 1;`);
      const next = persistence.one(`SELECT response_id,sequence,state FROM submission_response_consumption WHERE provider=${sqlText(provider)} AND account_id=${sqlText(accountId)} AND sequence>${Number(current?.cursor_sequence || 0)} ORDER BY sequence LIMIT 1;`);
      if (!row) { persistence.rollback(); throw new Error('cursor response is outside provider/account scope'); }
      if (!next || next.response_id !== responseId) { persistence.rollback(); throw new Error('cursor response would skip an earlier response'); }
      if (!['CONSUMED', 'REJECTED'].includes(row.state)) { persistence.rollback(); throw new Error('cursor response must be terminally consumed first'); }
      const cursorHash = hashRecord('SubmissionDeliveryCursor', { provider, accountId, responseId: row.response_id, receivedAt: row.received_at, sequence: Number(row.sequence) });
      persistence.execute(`INSERT INTO submission_delivery_cursors(provider,account_id,cursor_response_id,cursor_received_at,cursor_hash,updated_at,cursor_sequence) VALUES(${sqlText(provider)},${sqlText(accountId)},${sqlText(row.response_id)},${sqlText(row.received_at)},${sqlText(cursorHash)},${sqlText(now)},${Number(row.sequence)}) ON CONFLICT(provider,account_id) DO UPDATE SET cursor_response_id=excluded.cursor_response_id,cursor_received_at=excluded.cursor_received_at,cursor_hash=excluded.cursor_hash,updated_at=excluded.updated_at,cursor_sequence=excluded.cursor_sequence WHERE submission_delivery_cursors.cursor_sequence<excluded.cursor_sequence;
        COMMIT;`);
      return getApi().getResponseCursor({ provider, accountId });
    },
    claimNextResponse({ workerId, provider, accountId, anchorHash, leaseSeconds = 60 } = {}) {
      if (!workerId || !provider || !accountId || !anchorHash) throw new Error('response claim scope and anchor are required');
      const now = clock.nowIso();
      const expiresAt = new Date(clock.now().getTime() + Math.max(1, Number(leaseSeconds) || 60) * 1000).toISOString();
      const leaseToken = crypto.randomUUID();
      const cursor = getApi().getResponseCursor({ provider, accountId });
      persistence.execute(`BEGIN IMMEDIATE;
        UPDATE submission_response_consumption SET state='UNCONSUMED',claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE state='IN_PROGRESS' AND lease_expires_at<=${sqlText(now)};
        UPDATE submission_response_consumption SET state='IN_PROGRESS',claimed_by=${sqlText(workerId)},lease_token=${sqlText(leaseToken)},lease_expires_at=${sqlText(expiresAt)},updated_at=${sqlText(now)} WHERE sequence=(SELECT sequence FROM submission_response_consumption WHERE provider=${sqlText(provider)} AND account_id=${sqlText(accountId)} AND sequence>${Number(cursor?.cursor_sequence || 0)} ORDER BY sequence LIMIT 1) AND anchor_hash=${sqlText(anchorHash)} AND state='UNCONSUMED';
        COMMIT;`);
      const claimed = persistence.one(`SELECT * FROM submission_response_consumption WHERE lease_token=${sqlText(leaseToken)} LIMIT 1;`);
      return claimed ? Object.freeze({ ...claimed, leaseToken }) : null;
    },
    completeResponseConsumption({ responseId, leaseToken, disposition = 'CONSUMED' } = {}) {
      if (!['CONSUMED', 'REJECTED'].includes(disposition)) throw new Error('response consumption disposition invalid');
      const now = clock.nowIso();
      const result = persistence.query(`UPDATE submission_response_consumption SET state=${sqlText(disposition)},consumed_at=${sqlText(now)},claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE response_id=${sqlText(responseId)} AND lease_token=${sqlText(leaseToken)} AND state='IN_PROGRESS' AND lease_expires_at>${sqlText(now)} RETURNING *;`);
      const row = result.rows?.[0] || null;
      if (!result.ok || !row) throw new Error('active response consumption lease required');
      return Object.freeze(row);
    },
    getResponseConsumption(responseId) {
      return persistence.one(`SELECT * FROM submission_response_consumption WHERE response_id=${sqlText(responseId)} LIMIT 1;`);
    },
    getResponseCursor({ provider, accountId } = {}) {
      return persistence.one(`SELECT * FROM submission_delivery_cursors WHERE provider=${sqlText(provider)} AND account_id=${sqlText(accountId)} LIMIT 1;`);
    },
  };
}

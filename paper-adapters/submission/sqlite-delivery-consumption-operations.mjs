import crypto from 'node:crypto';
import { buildExecutorResponseIntake } from '../../paper-domain/submission/delivery-runtime.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { parseJsonOrThrow } from '../../workflow-kernel/runtime/data-utils.mjs';
import {
  preparedSqliteReceiptLedgerMutation,
} from '../persistence/sqlite-receipt-ledger.mjs';
import {
  NATIVE_STORE_SUBMISSION_DELIVERY_STATEMENT_IDS,
} from '../persistence/native-store-submission-delivery-mutation-plan.mjs';
import { sqlText } from './sqlite-delivery-persistence.mjs';
import { parseSubmissionOutboxPayload } from './sqlite-delivery-row-mappers.mjs';

const S = NATIVE_STORE_SUBMISSION_DELIVERY_STATEMENT_IDS;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function authorizationHashes(...values) {
  return Object.freeze([...new Set(values.filter((value) => SHA256.test(String(value || ''))))]
    .sort());
}

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
      if (typeof persistence.mutate === 'function') {
        const ledgerMutation = preparedSqliteReceiptLedgerMutation(preparedLedger);
        persistence.mutate({
          databaseRole: 'native-store',
          operationId: 'native-store.delivery-consumption-operations.release.v1',
          authorizationReceiptHashes: authorizationHashes(
            releaseLock.submissionReleaseLockHash,
          ),
          sideEffectReservationHashes: [],
          mutate(transaction) {
            const updated = transaction.run(
              S.releaseLock,
              now,
              reconciliationHash,
              paperId,
              lockToken,
            );
            if (updated.changes !== 1) throw new Error('active release lock changed before commit');
            transaction.run(S.receiptInsert, ...ledgerMutation.parameters);
          },
        });
      } else {
      persistence.transaction((transaction) => {
        const updated = transaction.query(`UPDATE submission_release_locks SET status='released',released_at=${sqlText(now)},reconciliation_hash=${sqlText(reconciliationHash)} WHERE paper_id=${sqlText(paperId)} AND lock_token=${sqlText(lockToken)} AND status='locked' RETURNING paper_id;`);
        if (!updated.ok || updated.rows?.length !== 1) throw new Error(updated.error || 'active release lock changed before commit');
        transaction.execute(preparedLedger.sql);
      });
      }
      const released = getApi().getReleaseLock(paperId);
      return released;
    },
    advanceResponseCursor({ provider, accountId, responseId } = {}) {
      const now = clock.nowIso();
      if (typeof persistence.mutate === 'function') {
        persistence.mutate({
          databaseRole: 'native-store',
          operationId: 'native-store.delivery-consumption-operations.advanceResponseCursor.v1',
          authorizationReceiptHashes: [],
          sideEffectReservationHashes: [],
          mutate(transaction) {
            const current = transaction.get(S.getCursor, provider, accountId);
            const row = transaction.get(S.getScopedResponse, responseId, provider, accountId);
            const next = transaction.get(
              S.getNextResponse,
              provider,
              accountId,
              Number(current?.cursor_sequence || 0),
            );
            if (!row) throw new Error('cursor response is outside provider/account scope');
            if (!next || next.response_id !== responseId) throw new Error('cursor response would skip an earlier response');
            if (!['CONSUMED', 'REJECTED'].includes(row.state)) throw new Error('cursor response must be terminally consumed first');
            const cursorHash = hashRecord('SubmissionDeliveryCursor', { provider, accountId, responseId: row.response_id, receivedAt: row.received_at, sequence: Number(row.sequence) });
            transaction.run(
              S.advanceCursor,
              provider,
              accountId,
              row.response_id,
              row.received_at,
              cursorHash,
              now,
              Number(row.sequence),
            );
          },
        });
      } else {
      persistence.transaction((transaction) => {
        const current = transaction.one(`SELECT * FROM submission_delivery_cursors WHERE provider=${sqlText(provider)} AND account_id=${sqlText(accountId)} LIMIT 1;`);
        const row = transaction.one(`SELECT i.response_id,i.received_at,o.provider,o.account_id,c.sequence,c.state FROM submission_inbox i JOIN submission_outbox o ON o.message_id=i.message_id JOIN submission_response_consumption c ON c.response_id=i.response_id WHERE i.response_id=${sqlText(responseId)} AND o.delivery_kind='reviewed' AND o.provider=${sqlText(provider)} AND o.account_id=${sqlText(accountId)} LIMIT 1;`);
        const next = transaction.one(`SELECT response_id,sequence,state FROM submission_response_consumption WHERE provider=${sqlText(provider)} AND account_id=${sqlText(accountId)} AND sequence>${Number(current?.cursor_sequence || 0)} ORDER BY sequence LIMIT 1;`);
        if (!row) throw new Error('cursor response is outside provider/account scope');
        if (!next || next.response_id !== responseId) throw new Error('cursor response would skip an earlier response');
        if (!['CONSUMED', 'REJECTED'].includes(row.state)) throw new Error('cursor response must be terminally consumed first');
        const cursorHash = hashRecord('SubmissionDeliveryCursor', { provider, accountId, responseId: row.response_id, receivedAt: row.received_at, sequence: Number(row.sequence) });
        transaction.execute(`INSERT INTO submission_delivery_cursors(provider,account_id,cursor_response_id,cursor_received_at,cursor_hash,updated_at,cursor_sequence) VALUES(${sqlText(provider)},${sqlText(accountId)},${sqlText(row.response_id)},${sqlText(row.received_at)},${sqlText(cursorHash)},${sqlText(now)},${Number(row.sequence)}) ON CONFLICT(provider,account_id) DO UPDATE SET cursor_response_id=excluded.cursor_response_id,cursor_received_at=excluded.cursor_received_at,cursor_hash=excluded.cursor_hash,updated_at=excluded.updated_at,cursor_sequence=excluded.cursor_sequence WHERE submission_delivery_cursors.cursor_sequence<excluded.cursor_sequence;`);
      });
      }
      return getApi().getResponseCursor({ provider, accountId });
    },
    claimNextResponse({ workerId, provider, accountId, anchorHash, leaseSeconds = 60 } = {}) {
      if (!workerId || !provider || !accountId || !anchorHash) throw new Error('response claim scope and anchor are required');
      const now = clock.nowIso();
      const expiresAt = new Date(clock.now().getTime() + Math.max(1, Number(leaseSeconds) || 60) * 1000).toISOString();
      const leaseToken = crypto.randomUUID();
      const cursor = getApi().getResponseCursor({ provider, accountId });
      if (typeof persistence.mutate === 'function') {
        const claimed = persistence.mutate({
          databaseRole: 'native-store',
          operationId: 'native-store.delivery-consumption-operations.claimNextResponse.v1',
          authorizationReceiptHashes: [],
          sideEffectReservationHashes: [],
          mutate(transaction) {
            transaction.run(S.expireResponseClaims, now, now);
            transaction.run(
              S.claimResponse,
              workerId,
              leaseToken,
              expiresAt,
              now,
              provider,
              accountId,
              Number(cursor?.cursor_sequence || 0),
              anchorHash,
            );
            return transaction.get(S.getClaimedResponse, leaseToken);
          },
        });
        return claimed ? Object.freeze({ ...claimed, leaseToken }) : null;
      }
      const claimed = persistence.transaction((transaction) => {
        transaction.execute(`UPDATE submission_response_consumption SET state='UNCONSUMED',claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE state='IN_PROGRESS' AND lease_expires_at<=${sqlText(now)};
          UPDATE submission_response_consumption SET state='IN_PROGRESS',claimed_by=${sqlText(workerId)},lease_token=${sqlText(leaseToken)},lease_expires_at=${sqlText(expiresAt)},updated_at=${sqlText(now)} WHERE sequence=(SELECT sequence FROM submission_response_consumption WHERE provider=${sqlText(provider)} AND account_id=${sqlText(accountId)} AND sequence>${Number(cursor?.cursor_sequence || 0)} ORDER BY sequence LIMIT 1) AND anchor_hash=${sqlText(anchorHash)} AND state='UNCONSUMED';`);
        return transaction.one(`SELECT * FROM submission_response_consumption WHERE lease_token=${sqlText(leaseToken)} LIMIT 1;`);
      });
      return claimed ? Object.freeze({ ...claimed, leaseToken }) : null;
    },
    completeResponseConsumption({ responseId, leaseToken, disposition = 'CONSUMED' } = {}) {
      if (!['CONSUMED', 'REJECTED'].includes(disposition)) throw new Error('response consumption disposition invalid');
      const now = clock.nowIso();
      if (typeof persistence.mutate === 'function') {
        const row = persistence.mutate({
          databaseRole: 'native-store',
          operationId: 'native-store.delivery-consumption-operations.completeResponseConsumption.v1',
          authorizationReceiptHashes: [],
          sideEffectReservationHashes: [],
          mutate(transaction) {
            const result = transaction.run(
              S.completeResponseConsumption,
              disposition,
              now,
              now,
              responseId,
              leaseToken,
              now,
            );
            if (result.changes !== 1) throw new Error('active response consumption lease required');
            return transaction.get(S.getResponseConsumption, responseId);
          },
        });
        if (!row) throw new Error('active response consumption lease required');
        return Object.freeze(row);
      }
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

import { buildExecutorResponseIntake } from '../../paper-domain/submission/delivery-runtime.mjs';
import { validateBoundaryRecord } from '../../paper-ports/boundary-schema-catalog.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  preparedSqliteReceiptLedgerMutation,
} from '../persistence/sqlite-receipt-ledger.mjs';
import {
  NATIVE_STORE_SUBMISSION_DELIVERY_STATEMENT_IDS,
} from '../persistence/native-store-submission-delivery-mutation-plan.mjs';
import { sqlJson, sqlText } from './sqlite-delivery-persistence.mjs';
import { parseSubmissionOutboxPayload } from './sqlite-delivery-row-mappers.mjs';

const S = NATIVE_STORE_SUBMISSION_DELIVERY_STATEMENT_IDS;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function authorizationHashes(...values) {
  return Object.freeze([...new Set(values.filter((value) => SHA256.test(String(value || ''))))]
    .sort());
}

export function createSqliteDeliveryResponseOperations({
  persistence,
  receiptLedger,
  clock,
  executorResponseVerifier,
  getApi,
} = {}) {
  function intakeFailure(message, failureCode) {
    const error = new Error(message);
    error.submissionIntakeFailureCode = failureCode;
    return error;
  }

  return {
    recordResponse({ messageId, response, responseVerificationReceipt = null, leaseToken = null } = {}) {
      const message = getApi().getOutbox(messageId);
      if (!message) {
        getApi().quarantineInvalidIntake({ messageId, payload: response, failureCodes: ['outbox_message_missing'] });
        throw new Error('outbox message missing');
      }
      if (message.claimed_by && (!leaseToken || message.lease_token !== leaseToken || message.status !== 'in_flight' || Date.parse(message.lease_expires_at) <= clock.now().getTime())) {
        getApi().quarantineInvalidIntake({ messageId, payload: response, failureCodes: ['active_delivery_lease_required'] });
        throw new Error('active delivery lease required');
      }
      const authorization = parseSubmissionOutboxPayload(message)._delivery?.dispatchAuthorization;
      const identityBound = Boolean(authorization?.executorDescriptorHash);
      let verifiedResponseReceipt = responseVerificationReceipt;
      if (identityBound && typeof executorResponseVerifier === 'function') {
        try {
          verifiedResponseReceipt = executorResponseVerifier({ dispatchAuthorization: authorization, response });
        } catch (error) {
          getApi().quarantineInvalidIntake({ messageId, payload: response, failureCodes: ['executor_response_verifier_error'] });
          throw error;
        }
      }
      const intakeBlockers = [];
      if (response?.dispatchAuthorizationHash !== message.dispatch_hash) intakeBlockers.push('response_dispatch_hash_mismatch');
      if (!response?.responseId || !['submitted', 'rejected', 'failed', 'cancelled'].includes(response.outcome)) intakeBlockers.push('executor_response_schema_invalid');
      if (response?.outcome === 'submitted' && (!response.providerReceiptHash || !response.providerReceipt)) intakeBlockers.push('submitted_response_provider_receipt_missing');
      if (response?.outcome === 'submitted' && response.providerReceipt
        && hashRecord('ProviderSubmissionReceipt', response.providerReceipt) !== response.providerReceiptHash) intakeBlockers.push('provider_receipt_hash_mismatch');
      if (response?.outcome === 'submitted' && identityBound) intakeBlockers.push(...validateBoundaryRecord(response.providerReceipt).blockers);
      if (identityBound && typeof executorResponseVerifier !== 'function') intakeBlockers.push('trusted_executor_response_verifier_missing');
      if (identityBound) intakeBlockers.push(...validateBoundaryRecord(verifiedResponseReceipt).blockers);
      if (intakeBlockers.length) {
        getApi().quarantineInvalidIntake({ messageId, payload: response, failureCodes: intakeBlockers });
        throw new Error(`invalid executor response:${intakeBlockers.join(',')}`);
      }
      const responseIntake = buildExecutorResponseIntake({ dispatchAuthorization: authorization, response, responseVerificationReceipt: verifiedResponseReceipt });
      if (responseIntake.status !== 'executor_response_accepted') {
        getApi().quarantineInvalidIntake({ messageId, payload: response, failureCodes: responseIntake.blockers });
        throw new Error(`executor response rejected:${responseIntake.blockers.join(',')}`);
      }
      const now = clock.nowIso();
      const receipt = { version: 1, kind: 'SubmissionResponsePersistedReceipt', status: 'submission_response_persisted', messageId, responseId: response.responseId, outcome: response.outcome, dispatchAuthorizationHash: message.dispatch_hash, providerReceiptHash: response.providerReceiptHash || null, createdAt: now };
      const sealedReceipt = { ...receipt, receiptHash: hashRecord('SubmissionResponsePersistedReceipt', receipt) };
      if (typeof receiptLedger.prepare !== 'function') throw new Error('atomic receipt ledger preparation required');
      const preparedLedger = receiptLedger.prepare(sealedReceipt, { stream: 'submission-delivery', paperId: message.paper_id, strictInsert: true });
      try {
        if (typeof persistence.mutate === 'function') {
          const ledgerMutation = preparedSqliteReceiptLedgerMutation(preparedLedger);
          persistence.mutate({
            databaseRole: 'native-store',
            operationId: 'native-store.delivery-response-operations.recordResponse.v1',
            authorizationReceiptHashes: authorizationHashes(
              authorization?.liveAuthorizationHash,
              verifiedResponseReceipt?.executorResponseVerificationReceiptHash,
            ),
            sideEffectReservationHashes: [],
            mutate(transaction) {
              const lockedMessage = transaction.get(S.getLockedOutbox, messageId);
              const existing = transaction.get(S.getInboxResponse, response.responseId);
              const lockedLeaseValid = lockedMessage?.status === 'in_flight'
                && lockedMessage?.lease_token === leaseToken
                && Date.parse(lockedMessage?.lease_expires_at) > clock.now().getTime();
              const lockedUnclaimedValid = !lockedMessage?.claimed_by
                && (['pending', 'waiting_for_response'].includes(lockedMessage?.status)
                  || (existing && ['retryable_failure', 'responded'].includes(lockedMessage?.status)));
              if (!lockedMessage || lockedMessage.dispatch_hash !== message.dispatch_hash
                || (message.claimed_by ? !lockedLeaseValid : !lockedUnclaimedValid)) {
                throw intakeFailure('response state or delivery lease changed before commit', 'response_state_or_lease_changed_before_commit');
              }
              if (existing) {
                const identical = existing.message_id === messageId
                  && existing.dispatch_hash === message.dispatch_hash
                  && existing.outcome === response.outcome
                  && (existing.provider_receipt_hash || null) === (response.providerReceiptHash || null)
                  && existing.response_json === JSON.stringify(response)
                  && (existing.verification_receipt_json || null) === (verifiedResponseReceipt ? JSON.stringify(verifiedResponseReceipt) : null);
                if (!identical) throw intakeFailure('duplicate executor response conflict', 'duplicate_executor_response_conflict');
                const persistedReceipt = existing.persisted_receipt_id
                  ? transaction.get(S.getEffectiveReceipt, existing.persisted_receipt_id)
                  : null;
                if (existing.persisted_receipt_id !== preparedLedger.receiptId
                  || persistedReceipt?.receipt_sha256 !== preparedLedger.receiptHash
                  || persistedReceipt?.receipt_json !== JSON.stringify(sealedReceipt)) {
                  throw intakeFailure('duplicate executor response receipt mismatch', 'duplicate_response_receipt_mismatch');
                }
                return;
              }
              const anchorHash = hashRecord('SubmissionResponseAnchor', { messageId, dispatchAuthorizationHash: message.dispatch_hash, responseId: response.responseId, provider: message.provider, accountId: message.account_id });
              transaction.run(S.receiptInsert, ...ledgerMutation.parameters);
              transaction.run(
                S.inboxInsert,
                response.responseId,
                messageId,
                message.dispatch_hash,
                response.providerReceiptHash || null,
                response.outcome,
                JSON.stringify(response),
                now,
                verifiedResponseReceipt?.executorResponseVerificationReceiptHash || null,
                verifiedResponseReceipt ? JSON.stringify(verifiedResponseReceipt) : null,
                preparedLedger.receiptId,
              );
              transaction.run(
                S.responseConsumptionInsert,
                response.responseId,
                messageId,
                message.provider,
                message.account_id,
                anchorHash,
                now,
                now,
              );
              transaction.run(
                S.responseOutboxUpdate,
                response.outcome === 'failed' ? 'retryable_failure' : 'responded',
                now,
                messageId,
              );
            },
          });
        } else {
        persistence.transaction((transaction) => {
          const lockedMessage = transaction.one(`SELECT * FROM submission_outbox WHERE delivery_kind='reviewed' AND message_id=${sqlText(messageId)} LIMIT 1;`);
          const existing = transaction.one(`SELECT * FROM submission_inbox WHERE response_id=${sqlText(response.responseId)} LIMIT 1;`);
          const lockedLeaseValid = lockedMessage?.status === 'in_flight'
            && lockedMessage?.lease_token === leaseToken
            && Date.parse(lockedMessage?.lease_expires_at) > clock.now().getTime();
          const lockedUnclaimedValid = !lockedMessage?.claimed_by
            && (['pending', 'waiting_for_response'].includes(lockedMessage?.status)
              || (existing && ['retryable_failure', 'responded'].includes(lockedMessage?.status)));
          if (!lockedMessage || lockedMessage.dispatch_hash !== message.dispatch_hash
            || (message.claimed_by ? !lockedLeaseValid : !lockedUnclaimedValid)) {
            throw intakeFailure('response state or delivery lease changed before commit', 'response_state_or_lease_changed_before_commit');
          }
          if (existing) {
            const identical = existing.message_id === messageId
              && existing.dispatch_hash === message.dispatch_hash
              && existing.outcome === response.outcome
              && (existing.provider_receipt_hash || null) === (response.providerReceiptHash || null)
              && existing.response_json === JSON.stringify(response)
              && (existing.verification_receipt_json || null) === (verifiedResponseReceipt ? JSON.stringify(verifiedResponseReceipt) : null);
            if (!identical) throw intakeFailure('duplicate executor response conflict', 'duplicate_executor_response_conflict');
            const persistedReceipt = existing.persisted_receipt_id
              ? transaction.one(`SELECT * FROM effective_receipt_ledger WHERE receipt_id=${sqlText(existing.persisted_receipt_id)} LIMIT 1;`)
              : null;
            if (existing.persisted_receipt_id !== preparedLedger.receiptId
              || persistedReceipt?.receipt_sha256 !== preparedLedger.receiptHash
              || persistedReceipt?.receipt_json !== JSON.stringify(sealedReceipt)) {
              throw intakeFailure('duplicate executor response receipt mismatch', 'duplicate_response_receipt_mismatch');
            }
            return;
          }
          const anchorHash = hashRecord('SubmissionResponseAnchor', { messageId, dispatchAuthorizationHash: message.dispatch_hash, responseId: response.responseId, provider: message.provider, accountId: message.account_id });
          transaction.execute(`${preparedLedger.sql}
            INSERT INTO submission_inbox(response_id,message_id,dispatch_hash,provider_receipt_hash,outcome,response_json,received_at,verification_receipt_hash,verification_receipt_json,persisted_receipt_id) VALUES(${sqlText(response.responseId)},${sqlText(messageId)},${sqlText(message.dispatch_hash)},${response.providerReceiptHash ? sqlText(response.providerReceiptHash) : 'NULL'},${sqlText(response.outcome)},${sqlJson(response)},${sqlText(now)},${verifiedResponseReceipt?.executorResponseVerificationReceiptHash ? sqlText(verifiedResponseReceipt.executorResponseVerificationReceiptHash) : 'NULL'},${verifiedResponseReceipt ? sqlJson(verifiedResponseReceipt) : 'NULL'},${sqlText(preparedLedger.receiptId)});
            INSERT INTO submission_response_consumption(response_id,message_id,provider,account_id,anchor_hash,state,created_at,updated_at) VALUES(${sqlText(response.responseId)},${sqlText(messageId)},${sqlText(message.provider)},${sqlText(message.account_id)},${sqlText(anchorHash)},'UNCONSUMED',${sqlText(now)},${sqlText(now)});
            UPDATE submission_outbox SET status=${sqlText(response.outcome === 'failed' ? 'retryable_failure' : 'responded')},claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=${sqlText(now)} WHERE delivery_kind='reviewed' AND message_id=${sqlText(messageId)};`);
        });
        }
      } catch (error) {
        if (error?.submissionIntakeFailureCode) {
          getApi().quarantineInvalidIntake({ messageId, payload: response, failureCodes: [error.submissionIntakeFailureCode] });
        }
        throw error;
      }
      const { sql: _sql, ...ledgerRecord } = preparedLedger;
      return Object.freeze(ledgerRecord);
    },
    quarantineInvalidIntake({ messageId = null, payload = null, failureCodes = [] } = {}) {
      const message = messageId ? getApi().getOutbox(messageId) : null;
      const receivedAt = clock.nowIso();
      const codes = [...new Set((Array.isArray(failureCodes) ? failureCodes : []).filter(Boolean).map(String))].slice(0, 64);
      const payloadHash = hashRecord('RejectedSubmissionBoundaryPayload', payload);
      const quarantineId = `submission-quarantine:${hashRecord('SubmissionIntakeQuarantineIdentity', { messageId, payloadHash, codes })}`;
      const receipt = {
        version: 1,
        kind: 'SubmissionIntakeQuarantineReceipt',
        status: 'submission_intake_quarantined',
        quarantineId,
        messageId,
        paperId: message?.paper_id || null,
        payloadHash,
        failureCodes: codes,
        rawPayloadStored: false,
        receivedAt,
      };
      const schemaReport = validateBoundaryRecord(receipt);
      if (schemaReport.status !== 'boundary_schema_verified') throw new Error(schemaReport.blockers.join(','));
      const sealedReceipt = { ...receipt, receiptHash: hashRecord('SubmissionIntakeQuarantineReceipt', receipt) };
      if (typeof receiptLedger.prepare !== 'function') throw new Error('atomic receipt ledger preparation required');
      const preparedLedger = receiptLedger.prepare(sealedReceipt, { stream: 'submission-delivery', paperId: message?.paper_id || null });
      if (typeof persistence.mutate === 'function') {
        const ledgerMutation = preparedSqliteReceiptLedgerMutation(preparedLedger);
        persistence.mutate({
          databaseRole: 'native-store',
          operationId: 'native-store.delivery-response-operations.quarantineInvalidIntake.v1',
          authorizationReceiptHashes: [],
          sideEffectReservationHashes: [],
          mutate(transaction) {
            transaction.run(S.receiptInsertIgnore, ...ledgerMutation.parameters);
            transaction.run(
              S.quarantineInsert,
              quarantineId,
              messageId,
              message?.paper_id || null,
              payloadHash,
              JSON.stringify(codes),
              receivedAt,
            );
          },
        });
      } else {
      persistence.transaction((transaction) => transaction.execute(`${preparedLedger.sql} INSERT OR IGNORE INTO submission_intake_quarantine(quarantine_id,message_id,paper_id,payload_hash,failure_codes_json,boundary_kind,received_at) VALUES(${sqlText(quarantineId)},${messageId ? sqlText(messageId) : 'NULL'},${message?.paper_id ? sqlText(message.paper_id) : 'NULL'},${sqlText(payloadHash)},${sqlJson(codes)},'executor_response',${sqlText(receivedAt)});`));
      }
      return Object.freeze(receipt);
    },
    listQuarantine({ messageId = null, limit = 100 } = {}) {
      return persistence.rows(`SELECT * FROM submission_intake_quarantine${messageId ? ` WHERE message_id=${sqlText(messageId)}` : ''} ORDER BY received_at DESC LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 100))};`);
    },
  };
}

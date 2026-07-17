import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sqlJson, sqlText } from './sqlite-delivery-persistence.mjs';
import { hasValidDeliveryRecordHash, parseSubmissionOutboxPayload } from './sqlite-delivery-row-mappers.mjs';

export function createSqliteDeliveryRedriveOperations({ persistence, receiptLedger, clock, getApi } = {}) {
  return {
    scheduleRedrive({ messageId, redrivePlan = null, maximumAttempts = 3, delaySeconds = 60 } = {}) {
      const message = getApi().getOutbox(messageId);
      if (!message) throw new Error('outbox message missing');
      if (message.status !== 'retryable_failure') throw new Error('only retryable failures can be redriven');
      const payload = parseSubmissionOutboxPayload(message);
      const currentAttempt = Math.max(1, Number(payload._delivery?.attempt || Number(message.attempt_count || 0) + 1));
      const now = clock.nowIso();
      if (currentAttempt >= maximumAttempts) return getApi().deadLetter({ messageId, failureClass: 'redrive_attempt_limit_reached' });
      if (redrivePlan?.status !== 'submission_redrive_reauthorization_required') throw new Error('redrive plan requiring reauthorization is required');
      if (!hasValidDeliveryRecordHash('SubmissionRedrivePlan', redrivePlan, 'submissionRedrivePlanHash')) throw new Error('redrive plan hash invalid');
      if (redrivePlan.dispatchAuthorizationHash !== message.dispatch_hash) throw new Error('redrive plan dispatch hash mismatch');
      if (Number(redrivePlan.nextAttempt) !== currentAttempt + 1) throw new Error('redrive plan attempt mismatch');
      const eligibleAt = new Date(clock.now().getTime() + Math.max(1, Number(delaySeconds)) * 1000).toISOString();
      const updatedPayload = {
        ...payload,
        _delivery: {
          ...payload._delivery,
          redriveReauthorization: {
            redrivePlanHash: redrivePlan.submissionRedrivePlanHash,
            nextAttempt: redrivePlan.nextAttempt,
            eligibleAt,
          },
        },
      };
      const receipt = {
        version: 1,
        kind: 'SubmissionRedriveReauthorizationRequiredReceipt',
        status: 'submission_redrive_reauthorization_required',
        messageId,
        paperId: message.paper_id,
        priorDispatchAuthorizationHash: message.dispatch_hash,
        priorNonce: message.nonce,
        redrivePlanHash: redrivePlan.submissionRedrivePlanHash,
        nextAttempt: currentAttempt + 1,
        eligibleAt,
        externalActionPerformed: false,
        createdAt: now,
      };
      const receiptHash = hashRecord('SubmissionRedriveReauthorizationRequiredReceipt', receipt);
      if (typeof receiptLedger.prepare !== 'function') throw new Error('atomic receipt ledger preparation required');
      const preparedLedger = receiptLedger.prepare({ ...receipt, receiptHash }, { stream: 'submission-delivery', paperId: message.paper_id, strictInsert: true });
      persistence.execute('BEGIN IMMEDIATE;');
      const updated = persistence.query(`UPDATE submission_outbox SET status='reauthorization_required',attempt_count=${currentAttempt},payload_json=${sqlJson(updatedPayload)},next_attempt_at=${sqlText(eligibleAt)},updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)} AND status='retryable_failure' AND dispatch_hash=${sqlText(message.dispatch_hash)} RETURNING message_id;`);
      if (!updated.ok || updated.rows?.length !== 1) {
        persistence.rollback();
        throw new Error(updated.error || 'redrive message changed before commit');
      }
      try {
        persistence.execute(`${preparedLedger.sql} COMMIT;`);
      } catch (error) {
        persistence.rollback();
        throw error;
      }
      return Object.freeze({ ...receipt, receiptHash, ledgerReceiptId: preparedLedger.receiptId });
    },
    reviewAmbiguousResult({ messageId, redriveDecision, redrivePlan = null } = {}) {
      const message = getApi().getOutbox(messageId);
      if (!message) throw new Error('outbox message missing');
      if (!['pending', 'waiting_for_response'].includes(message.status)) throw new Error('ambiguous result review requires pending message');
      if (redriveDecision?.dispatchAuthorizationHash !== message.dispatch_hash) throw new Error('ambiguous result decision dispatch mismatch');
      if (!hasValidDeliveryRecordHash('SubmissionRedriveDecision', redriveDecision, 'submissionRedriveDecisionHash')) throw new Error('ambiguous result decision hash invalid');
      const now = clock.nowIso();
      if (redriveDecision?.decision === 'continue_waiting') {
        persistence.execute(`UPDATE submission_outbox SET status='waiting_for_response',next_attempt_at=${sqlText(redriveDecision.responseDueAt)},updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)};`);
        return Object.freeze({ status: 'submission_redrive_waiting', messageId, responseDueAt: redriveDecision.responseDueAt, externalActionPerformed: false });
      }
      if (redriveDecision?.status !== 'submission_redrive_reauthorization_approved'
        || redrivePlan?.status !== 'submission_redrive_reauthorization_required'
        || redrivePlan?.redriveDecisionHash !== redriveDecision?.submissionRedriveDecisionHash) {
        throw new Error('approved ambiguous result decision and redrive plan required');
      }
      if (!hasValidDeliveryRecordHash('SubmissionRedrivePlan', redrivePlan, 'submissionRedrivePlanHash')) throw new Error('ambiguous redrive plan hash invalid');
      const payload = parseSubmissionOutboxPayload(message);
      const updatedPayload = { ...payload, _delivery: { ...payload._delivery, redriveReauthorization: { redrivePlanHash: redrivePlan.submissionRedrivePlanHash, redriveDecisionHash: redriveDecision.submissionRedriveDecisionHash, nextAttempt: redrivePlan.nextAttempt, eligibleAt: now } } };
      persistence.execute(`UPDATE submission_outbox SET status='reauthorization_required',attempt_count=${Math.max(1, Number(message.attempt_count || 0) + 1)},payload_json=${sqlJson(updatedPayload)},next_attempt_at=${sqlText(now)},updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)};`);
      return Object.freeze({ status: 'submission_redrive_reauthorization_required', messageId, redrivePlanHash: redrivePlan.submissionRedrivePlanHash, externalActionPerformed: false });
    },
    enqueueRedrive({ previousMessageId, dispatchAuthorization, payload } = {}) {
      const previous = getApi().getOutbox(previousMessageId);
      if (!previous) throw new Error('previous outbox message missing');
      if (previous.status !== 'reauthorization_required') throw new Error('previous outbox message does not require reauthorization');
      if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') throw new Error('fresh dispatch authorization required');
      if (!hasValidDeliveryRecordHash('SubmissionDispatchAuthorization', dispatchAuthorization, 'submissionDispatchAuthorizationHash')) throw new Error('fresh dispatch authorization hash invalid');
      if (!dispatchAuthorization.redrivePlanHash) throw new Error('redrive plan hash required');
      if (dispatchAuthorization.submissionDispatchAuthorizationHash === previous.dispatch_hash) throw new Error('redrive dispatch authorization must be fresh');
      if (!dispatchAuthorization.nonce || dispatchAuthorization.nonce === previous.nonce) throw new Error('redrive nonce must be fresh');
      if (dispatchAuthorization.provider !== previous.provider || dispatchAuthorization.accountId !== previous.account_id) {
        throw new Error('redrive provider/account scope mismatch');
      }
      const previousPayload = parseSubmissionOutboxPayload(previous);
      const reauthorization = previousPayload._delivery?.redriveReauthorization;
      if (!reauthorization || reauthorization.redrivePlanHash !== dispatchAuthorization.redrivePlanHash) throw new Error('redrive authorization plan is not persisted');
      if (Number(dispatchAuthorization.attempt) !== Number(reauthorization.nextAttempt)) throw new Error('redrive dispatch attempt mismatch');
      if (new Date(previous.next_attempt_at).getTime() > clock.now().getTime()) throw new Error('redrive eligibility time not reached');
      const now = clock.nowIso();
      for (const field of ['replayKey', 'actionScopeKey', 'dispatchCycleHash', 'liveAuthorizationHash', 'responseDueAt', 'providerCapabilityVerificationReceiptHash', 'portalRoute']) {
        if (!dispatchAuthorization?.[field]) throw new Error(`redrive authorized dispatch ${field} required`);
      }
      const dispatchHash = dispatchAuthorization.submissionDispatchAuthorizationHash;
      const messageId = `submission:${dispatchHash}`;
      const storedPayload = { ...(payload || {}), redrive: { previousMessageId, priorDispatchAuthorizationHash: previous.dispatch_hash, redrivePlanHash: dispatchAuthorization.redrivePlanHash, attempt: dispatchAuthorization.attempt }, _delivery: { ...(payload?._delivery || {}), attempt: dispatchAuthorization.attempt, dispatchAuthorization } };
      const receipt = {
        version: 1,
        kind: 'SubmissionRedriveEnqueueReceipt',
        status: 'submission_redrive_enqueued_with_fresh_authorization',
        paperId: previous.paper_id,
        previousMessageId,
        messageId,
        priorDispatchAuthorizationHash: previous.dispatch_hash,
        dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash,
        redrivePlanHash: dispatchAuthorization.redrivePlanHash,
        priorNonce: previous.nonce,
        nonce: dispatchAuthorization.nonce,
        externalActionPerformed: false,
        createdAt: now,
      };
      const receiptHash = hashRecord('SubmissionRedriveEnqueueReceipt', receipt);
      if (typeof receiptLedger.prepare !== 'function') throw new Error('atomic receipt ledger preparation required');
      const preparedLedger = receiptLedger.prepare({ ...receipt, receiptHash }, { stream: 'submission-delivery', paperId: previous.paper_id, strictInsert: true });
      persistence.execute(`BEGIN IMMEDIATE;
        ${preparedLedger.sql}
        UPDATE submission_outbox SET status='superseded',updated_at=${sqlText(now)} WHERE message_id=${sqlText(previousMessageId)};
        INSERT INTO submission_outbox(message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,attempt_count,payload_json,next_attempt_at,created_at,updated_at,replay_key,action_scope_key,dispatch_cycle_hash,authorization_receipt_hash,executor_descriptor_hash,response_due_at,executor_capabilities_hash,provider_capability_verification_receipt_hash,portal_route)
        VALUES(${sqlText(messageId)},${sqlText(previous.paper_id)},${sqlText(dispatchHash)},${sqlText(dispatchAuthorization.provider)},${sqlText(dispatchAuthorization.accountId)},${sqlText(dispatchAuthorization.nonce)},'pending',${Number(dispatchAuthorization.attempt) - 1},${sqlJson(storedPayload)},${sqlText(now)},${sqlText(now)},${sqlText(now)},${sqlText(dispatchAuthorization.replayKey)},${sqlText(dispatchAuthorization.actionScopeKey)},${sqlText(dispatchAuthorization.dispatchCycleHash)},${sqlText(dispatchAuthorization.liveAuthorizationHash)},${dispatchAuthorization.executorDescriptorHash ? sqlText(dispatchAuthorization.executorDescriptorHash) : 'NULL'},${sqlText(dispatchAuthorization.responseDueAt)},${dispatchAuthorization.executorCapabilitiesHash ? sqlText(dispatchAuthorization.executorCapabilitiesHash) : 'NULL'},${sqlText(dispatchAuthorization.providerCapabilityVerificationReceiptHash)},${sqlText(dispatchAuthorization.portalRoute)});
        INSERT INTO submission_authorization_consumptions(nonce,authorization_receipt_hash,replay_key,dispatch_cycle_hash,paper_id,message_id,consumed_at)
        VALUES(${sqlText(dispatchAuthorization.nonce)},${sqlText(dispatchAuthorization.liveAuthorizationHash)},${sqlText(dispatchAuthorization.replayKey)},${sqlText(dispatchAuthorization.dispatchCycleHash)},${sqlText(previous.paper_id)},${sqlText(messageId)},${sqlText(now)});
        UPDATE submission_release_locks SET message_id=${sqlText(messageId)},lock_token=${sqlText(dispatchHash)},status='locked',released_at=NULL,reconciliation_hash=NULL WHERE paper_id=${sqlText(previous.paper_id)};
        COMMIT;`);
      const message = getApi().getOutbox(messageId);
      if (!message || message.message_id !== messageId) throw new Error('redrive message persistence failed');
      return Object.freeze({ ...receipt, receiptHash, ledgerReceiptId: preparedLedger.receiptId });
    },
    deadLetter({ messageId, failureClass } = {}) {
      const message = getApi().getOutbox(messageId);
      if (!message) throw new Error('outbox message missing');
      const now = clock.nowIso();
      const receipt = { version: 1, kind: 'SubmissionDeadLetterReceipt', status: 'submission_dead_letter_recorded', messageId, failureClass, attemptCount: Number(message.attempt_count || 0), createdAt: now };
      const id = `dead-letter:${hashRecord('SubmissionDeadLetterReceipt', receipt)}`;
      const sealedReceipt = { ...receipt, receiptHash: hashRecord('SubmissionDeadLetterReceipt', receipt) };
      if (typeof receiptLedger.prepare !== 'function') throw new Error('atomic receipt ledger preparation required');
      const preparedLedger = receiptLedger.prepare(sealedReceipt, { stream: 'submission-delivery', paperId: message.paper_id });
      persistence.execute(`BEGIN IMMEDIATE; ${preparedLedger.sql} INSERT OR IGNORE INTO submission_dead_letters(dead_letter_id,message_id,failure_class,attempt_count,receipt_json,created_at) VALUES(${sqlText(id)},${sqlText(messageId)},${sqlText(failureClass)},${receipt.attemptCount},${sqlJson(receipt)},${sqlText(now)}); UPDATE submission_outbox SET status='dead_letter',updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)}; COMMIT;`);
      return Object.freeze({ ...receipt, ledgerReceiptId: preparedLedger.receiptId });
    },
  };
}

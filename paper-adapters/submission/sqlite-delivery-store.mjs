import crypto from 'node:crypto';
import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildExecutorResponseIntake } from '../../paper-domain/submission/delivery-runtime.mjs';
import { validateBoundaryRecord } from '../../paper-ports/boundary-schema-catalog.mjs';

function parsedPayload(message) {
  try { return JSON.parse(message?.payload_json || '{}'); } catch { throw new Error('outbox payload is invalid'); }
}

function validRecordHash(kind, record, field) {
  if (!record?.[field]) return false;
  const { [field]: _claimed, ...payload } = record;
  return hashRecord(kind, payload) === record[field];
}

export function createSqliteSubmissionDeliveryStore({ store, receiptLedger, clock, executorResponseVerifier = null, providerCapabilityVerifier = null } = {}) {
  if (!store || !receiptLedger || !clock) throw new Error('Delivery store requires store, receiptLedger and clock');
  const execute = (sql) => {
    const result = store.execute(sql);
    if (!result.ok) throw new Error(result.error || result.stderr || 'submission_delivery_store_failed');
  };
  return Object.freeze({
    version: 1,
    kind: 'SqliteSubmissionDeliveryStore',
    enqueueAuthorized({ paperId, dispatchAuthorization, payload } = {}) {
      if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') throw new Error('ready dispatch authorization required');
      for (const field of ['replayKey', 'actionScopeKey', 'dispatchCycleHash', 'liveAuthorizationHash', 'nonce', 'responseDueAt', 'providerCapabilityVerificationReceiptHash', 'portalRoute']) {
        if (!dispatchAuthorization?.[field]) throw new Error(`authorized dispatch ${field} required`);
      }
      const dispatchHash = dispatchAuthorization.submissionDispatchAuthorizationHash;
      const messageId = `submission:${dispatchHash}`;
      const now = clock.nowIso();
      const attempt = Math.max(1, Number(dispatchAuthorization.attempt || 1));
      const storedPayload = {
        ...(payload || {}),
        _delivery: { ...(payload?._delivery || {}), attempt, dispatchAuthorization },
      };
      execute(`BEGIN IMMEDIATE;
        INSERT INTO submission_outbox(message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,attempt_count,payload_json,next_attempt_at,created_at,updated_at,replay_key,action_scope_key,dispatch_cycle_hash,authorization_receipt_hash,executor_descriptor_hash,response_due_at,executor_capabilities_hash,provider_capability_verification_receipt_hash,portal_route)
        VALUES(${sqlText(messageId)},${sqlText(paperId)},${sqlText(dispatchHash)},${sqlText(dispatchAuthorization.provider)},${sqlText(dispatchAuthorization.accountId)},${sqlText(dispatchAuthorization.nonce)},'pending',${attempt - 1},${sqlJson(storedPayload)},${sqlText(now)},${sqlText(now)},${sqlText(now)},${sqlText(dispatchAuthorization.replayKey)},${sqlText(dispatchAuthorization.actionScopeKey)},${sqlText(dispatchAuthorization.dispatchCycleHash)},${sqlText(dispatchAuthorization.liveAuthorizationHash)},${dispatchAuthorization.executorDescriptorHash ? sqlText(dispatchAuthorization.executorDescriptorHash) : 'NULL'},${sqlText(dispatchAuthorization.responseDueAt)},${dispatchAuthorization.executorCapabilitiesHash ? sqlText(dispatchAuthorization.executorCapabilitiesHash) : 'NULL'},${sqlText(dispatchAuthorization.providerCapabilityVerificationReceiptHash)},${sqlText(dispatchAuthorization.portalRoute)});
        INSERT INTO submission_authorization_consumptions(nonce,authorization_receipt_hash,replay_key,dispatch_cycle_hash,paper_id,message_id,consumed_at)
        VALUES(${sqlText(dispatchAuthorization.nonce)},${sqlText(dispatchAuthorization.liveAuthorizationHash)},${sqlText(dispatchAuthorization.replayKey)},${sqlText(dispatchAuthorization.dispatchCycleHash)},${sqlText(paperId)},${sqlText(messageId)},${sqlText(now)});
        INSERT INTO submission_release_locks(paper_id,message_id,lock_token,status,acquired_at)
        VALUES(${sqlText(paperId)},${sqlText(messageId)},${sqlText(dispatchHash)},'locked',${sqlText(now)});
        COMMIT;`);
      const message = this.getOutbox(messageId);
      return Object.freeze({ ...message, _releaseLock: this.getReleaseLock(paperId) });
    },
    enqueue({ paperId, dispatchAuthorization, payload } = {}) {
      if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') throw new Error('ready dispatch authorization required');
      const dispatchHash = dispatchAuthorization.submissionDispatchAuthorizationHash;
      const messageId = `submission:${dispatchHash}`;
      const now = clock.nowIso();
      const attempt = Math.max(1, Number(dispatchAuthorization.attempt || 1));
      const storedPayload = {
        ...(payload || {}),
        _delivery: {
          ...(payload?._delivery || {}),
          attempt,
          dispatchAuthorization,
        },
      };
      execute(`INSERT OR IGNORE INTO submission_outbox(message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,attempt_count,payload_json,next_attempt_at,created_at,updated_at) VALUES(${sqlText(messageId)},${sqlText(paperId)},${sqlText(dispatchHash)},${sqlText(dispatchAuthorization.provider)},${sqlText(dispatchAuthorization.accountId)},${sqlText(dispatchAuthorization.nonce)},'pending',${attempt - 1},${sqlJson(storedPayload)},${sqlText(now)},${sqlText(now)},${sqlText(now)});`);
      return this.getOutbox(messageId);
    },
    registerProviderCapability({ attestation, executorDescriptor } = {}) {
      if (typeof providerCapabilityVerifier !== 'function') throw new Error('trusted provider capability verifier required');
      const verification = providerCapabilityVerifier({ attestation, executorDescriptor });
      const schema = validateBoundaryRecord(verification);
      if (verification?.status !== 'provider_capability_verified' || verification?.cryptographicSignaturesVerified !== true || schema.status !== 'boundary_schema_verified') {
        throw new Error(`provider capability rejected:${[...(verification?.blockers || []), ...schema.blockers].join(',')}`);
      }
      const now = clock.nowIso();
      const capabilityId = `provider-capability:${verification.provider}:${verification.accountId}:${verification.executorDescriptorHash}`;
      execute(`INSERT OR IGNORE INTO submission_provider_capabilities(capability_id,provider,account_id,portal_route,executor_descriptor_hash,capabilities_hash,attestation_hash,verification_receipt_hash,verified_subject_ids_json,valid_from,expires_at,status,created_at)
        VALUES(${sqlText(capabilityId)},${sqlText(verification.provider)},${sqlText(verification.accountId)},${sqlText(verification.portalRoute)},${sqlText(verification.executorDescriptorHash)},${sqlText(verification.capabilitiesHash)},${sqlText(verification.attestationHash)},${sqlText(verification.providerCapabilityVerificationReceiptHash)},${sqlJson(verification.verifiedSubjectIds)},${sqlText(verification.validFrom)},${sqlText(verification.expiresAt)},'active',${sqlText(now)})
        ON CONFLICT(provider,account_id,executor_descriptor_hash) DO NOTHING;`);
      const persisted = store.query(`SELECT * FROM submission_provider_capabilities WHERE provider=${sqlText(verification.provider)} AND account_id=${sqlText(verification.accountId)} AND executor_descriptor_hash=${sqlText(verification.executorDescriptorHash)} LIMIT 1;`).rows[0] || null;
      if (!persisted || persisted.verification_receipt_hash !== verification.providerCapabilityVerificationReceiptHash
        || persisted.portal_route !== verification.portalRoute || persisted.capabilities_hash !== verification.capabilitiesHash) {
        throw new Error('provider capability replacement requires a new executor descriptor');
      }
      receiptLedger.record(verification, { stream: 'submission-provider-capability' });
      return Object.freeze({ capabilityId, ...verification });
    },
    claimPending({ workerId, provider, accountId, executorDescriptorHash, leaseSeconds = 60 } = {}) {
      if (!workerId || !provider || !accountId || !executorDescriptorHash) throw new Error('claim scope is required');
      const now = clock.nowIso();
      const expiresAt = new Date(clock.now().getTime() + Math.max(1, Number(leaseSeconds) || 60) * 1000).toISOString();
      const capability = store.query(`SELECT * FROM submission_provider_capabilities WHERE provider=${sqlText(provider)} AND account_id=${sqlText(accountId)} AND executor_descriptor_hash=${sqlText(executorDescriptorHash)} AND status='active' AND valid_from<=${sqlText(now)} AND expires_at>${sqlText(now)} LIMIT 1;`).rows[0] || null;
      if (!capability) throw new Error('active verified provider capability required');
      const leaseToken = crypto.randomUUID();
      execute(`BEGIN IMMEDIATE;
        UPDATE submission_outbox SET status='pending',claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=${sqlText(now)} WHERE status='in_flight' AND lease_expires_at<=${sqlText(now)};
        UPDATE submission_outbox SET status='in_flight',claimed_by=${sqlText(workerId)},lease_token=${sqlText(leaseToken)},lease_expires_at=${sqlText(expiresAt)},heartbeat_at=${sqlText(now)},updated_at=${sqlText(now)}
          WHERE message_id=(SELECT message_id FROM submission_outbox WHERE status='pending' AND provider=${sqlText(provider)} AND account_id=${sqlText(accountId)} AND executor_descriptor_hash=${sqlText(executorDescriptorHash)} AND executor_capabilities_hash=${sqlText(capability.capabilities_hash)} AND provider_capability_verification_receipt_hash=${sqlText(capability.verification_receipt_hash)} AND portal_route=${sqlText(capability.portal_route)} AND response_due_at>${sqlText(now)} AND (next_attempt_at IS NULL OR next_attempt_at<=${sqlText(now)}) ORDER BY created_at LIMIT 1);
        COMMIT;`);
      const message = store.query(`SELECT * FROM submission_outbox WHERE lease_token=${sqlText(leaseToken)} LIMIT 1;`).rows[0] || null;
      if (!message) return null;
      const leasePayload = { version: 1, kind: 'SubmissionDeliveryLeaseReceipt', status: 'submission_delivery_leased', messageId: message.message_id, provider, accountId, workerId, dispatchAuthorizationHash: message.dispatch_hash, leaseTokenHash: hashRecord('SubmissionDeliveryLeaseToken', { leaseToken }), leaseExpiresAt: expiresAt, providerCapabilityVerificationReceiptHash: capability.verification_receipt_hash, createdAt: now };
      const schema = validateBoundaryRecord(leasePayload);
      if (schema.status !== 'boundary_schema_verified') throw new Error(schema.blockers.join(','));
      const receiptHash = hashRecord('SubmissionDeliveryLeaseReceipt', leasePayload);
      receiptLedger.record({ ...leasePayload, receiptHash }, { stream: 'submission-delivery', paperId: message.paper_id });
      return Object.freeze({ ...message, leaseToken, leaseReceiptHash: receiptHash, providerCapabilityVerificationReceiptHash: capability.verification_receipt_hash });
    },
    heartbeatClaim({ messageId, leaseToken, leaseSeconds = 60 } = {}) {
      const now = clock.nowIso();
      const expiresAt = new Date(clock.now().getTime() + Math.max(1, Number(leaseSeconds) || 60) * 1000).toISOString();
      execute(`UPDATE submission_outbox SET lease_expires_at=${sqlText(expiresAt)},heartbeat_at=${sqlText(now)},updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)} AND lease_token=${sqlText(leaseToken)} AND status='in_flight' AND lease_expires_at>${sqlText(now)};`);
      const message = this.getOutbox(messageId);
      if (!message || message.lease_token !== leaseToken || message.status !== 'in_flight' || Date.parse(message.lease_expires_at) <= clock.now().getTime()) throw new Error('active delivery lease missing');
      return Object.freeze({ status: 'submission_delivery_lease_renewed', messageId, leaseExpiresAt: message.lease_expires_at });
    },
    recordResponse({ messageId, response, responseVerificationReceipt = null, leaseToken = null } = {}) {
      const message = this.getOutbox(messageId);
      if (!message) {
        this.quarantineInvalidIntake({ messageId, payload: response, failureCodes: ['outbox_message_missing'] });
        throw new Error('outbox message missing');
      }
      if (message.claimed_by && (!leaseToken || message.lease_token !== leaseToken || message.status !== 'in_flight' || Date.parse(message.lease_expires_at) <= clock.now().getTime())) {
        this.quarantineInvalidIntake({ messageId, payload: response, failureCodes: ['active_delivery_lease_required'] });
        throw new Error('active delivery lease required');
      }
      const authorization = parsedPayload(message)._delivery?.dispatchAuthorization;
      const identityBound = Boolean(authorization?.executorDescriptorHash);
      let verifiedResponseReceipt = responseVerificationReceipt;
      if (identityBound && typeof executorResponseVerifier === 'function') {
        try {
          verifiedResponseReceipt = executorResponseVerifier({ dispatchAuthorization: authorization, response });
        } catch (error) {
          this.quarantineInvalidIntake({ messageId, payload: response, failureCodes: ['executor_response_verifier_error'] });
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
        this.quarantineInvalidIntake({ messageId, payload: response, failureCodes: intakeBlockers });
        throw new Error(`invalid executor response:${intakeBlockers.join(',')}`);
      }
      const responseIntake = buildExecutorResponseIntake({ dispatchAuthorization: authorization, response, responseVerificationReceipt: verifiedResponseReceipt });
      if (responseIntake.status !== 'executor_response_accepted') {
        this.quarantineInvalidIntake({ messageId, payload: response, failureCodes: responseIntake.blockers });
        throw new Error(`executor response rejected:${responseIntake.blockers.join(',')}`);
      }
      const now = clock.nowIso();
      const receipt = { version: 1, kind: 'SubmissionResponsePersistedReceipt', status: 'submission_response_persisted', messageId, responseId: response.responseId, outcome: response.outcome, dispatchAuthorizationHash: message.dispatch_hash, providerReceiptHash: response.providerReceiptHash || null, createdAt: now };
      const sealedReceipt = { ...receipt, receiptHash: hashRecord('SubmissionResponsePersistedReceipt', receipt) };
      if (typeof receiptLedger.prepare !== 'function') throw new Error('atomic receipt ledger preparation required');
      const preparedLedger = receiptLedger.prepare(sealedReceipt, { stream: 'submission-delivery', paperId: message.paper_id, strictInsert: true });
      execute('BEGIN IMMEDIATE;');
      const rollback = () => { store.execute('ROLLBACK;'); };
      const lockedMessage = this.getOutbox(messageId);
      const existing = store.query(`SELECT * FROM submission_inbox WHERE response_id=${sqlText(response.responseId)} LIMIT 1;`).rows[0] || null;
      const lockedLeaseValid = lockedMessage?.status === 'in_flight'
        && lockedMessage?.lease_token === leaseToken
        && Date.parse(lockedMessage?.lease_expires_at) > clock.now().getTime();
      const lockedUnclaimedValid = !lockedMessage?.claimed_by
        && (['pending', 'waiting_for_response'].includes(lockedMessage?.status)
          || (existing && ['retryable_failure', 'responded'].includes(lockedMessage?.status)));
      if (!lockedMessage || lockedMessage.dispatch_hash !== message.dispatch_hash
        || (message.claimed_by ? !lockedLeaseValid : !lockedUnclaimedValid)) {
        rollback();
        this.quarantineInvalidIntake({ messageId, payload: response, failureCodes: ['response_state_or_lease_changed_before_commit'] });
        throw new Error('response state or delivery lease changed before commit');
      }
      if (existing) {
        const identical = existing.message_id === messageId
          && existing.dispatch_hash === message.dispatch_hash
          && existing.outcome === response.outcome
          && (existing.provider_receipt_hash || null) === (response.providerReceiptHash || null)
          && existing.response_json === JSON.stringify(response)
          && (existing.verification_receipt_json || null) === (verifiedResponseReceipt ? JSON.stringify(verifiedResponseReceipt) : null);
        if (!identical) {
          rollback();
          this.quarantineInvalidIntake({ messageId, payload: response, failureCodes: ['duplicate_executor_response_conflict'] });
          throw new Error('duplicate executor response conflict');
        }
        const persistedReceipt = existing.persisted_receipt_id ? receiptLedger.get(existing.persisted_receipt_id) : null;
        if (existing.persisted_receipt_id !== preparedLedger.receiptId
          || persistedReceipt?.receipt_sha256 !== preparedLedger.receiptHash
          || persistedReceipt?.receipt_json !== JSON.stringify(sealedReceipt)) {
          rollback();
          this.quarantineInvalidIntake({ messageId, payload: response, failureCodes: ['duplicate_response_receipt_mismatch'] });
          throw new Error('duplicate executor response receipt mismatch');
        }
        execute('COMMIT;');
      } else {
        const anchorHash = hashRecord('SubmissionResponseAnchor', { messageId, dispatchAuthorizationHash: message.dispatch_hash, responseId: response.responseId, provider: message.provider, accountId: message.account_id });
        execute(`${preparedLedger.sql}
          INSERT INTO submission_inbox(response_id,message_id,dispatch_hash,provider_receipt_hash,outcome,response_json,received_at,verification_receipt_hash,verification_receipt_json,persisted_receipt_id) VALUES(${sqlText(response.responseId)},${sqlText(messageId)},${sqlText(message.dispatch_hash)},${response.providerReceiptHash ? sqlText(response.providerReceiptHash) : 'NULL'},${sqlText(response.outcome)},${sqlJson(response)},${sqlText(now)},${verifiedResponseReceipt?.executorResponseVerificationReceiptHash ? sqlText(verifiedResponseReceipt.executorResponseVerificationReceiptHash) : 'NULL'},${verifiedResponseReceipt ? sqlJson(verifiedResponseReceipt) : 'NULL'},${sqlText(preparedLedger.receiptId)});
          INSERT INTO submission_response_consumption(response_id,message_id,provider,account_id,anchor_hash,state,created_at,updated_at) VALUES(${sqlText(response.responseId)},${sqlText(messageId)},${sqlText(message.provider)},${sqlText(message.account_id)},${sqlText(anchorHash)},'UNCONSUMED',${sqlText(now)},${sqlText(now)});
          UPDATE submission_outbox SET status=${sqlText(response.outcome === 'failed' ? 'retryable_failure' : 'responded')},claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)};
          COMMIT;`);
      }
      const { sql: _sql, ...ledgerRecord } = preparedLedger;
      return Object.freeze(ledgerRecord);
    },
    quarantineInvalidIntake({ messageId = null, payload = null, failureCodes = [] } = {}) {
      const message = messageId ? this.getOutbox(messageId) : null;
      const receivedAt = clock.nowIso();
      const codes = [...new Set((Array.isArray(failureCodes) ? failureCodes : []).filter(Boolean).map(String))].slice(0, 64);
      const payloadHash = hashRecord('RejectedSubmissionBoundaryPayload', payload);
      const quarantineId = `submission-quarantine:${hashRecord('SubmissionIntakeQuarantineIdentity', { messageId, payloadHash, codes })}`;
      execute(`INSERT OR IGNORE INTO submission_intake_quarantine(quarantine_id,message_id,paper_id,payload_hash,failure_codes_json,boundary_kind,received_at) VALUES(${sqlText(quarantineId)},${messageId ? sqlText(messageId) : 'NULL'},${message?.paper_id ? sqlText(message.paper_id) : 'NULL'},${sqlText(payloadHash)},${sqlJson(codes)},'executor_response',${sqlText(receivedAt)});`);
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
      receiptLedger.record({ ...receipt, receiptHash: hashRecord('SubmissionIntakeQuarantineReceipt', receipt) }, { stream: 'submission-delivery', paperId: message?.paper_id || null });
      return Object.freeze(receipt);
    },
    listQuarantine({ messageId = null, limit = 100 } = {}) {
      return store.query(`SELECT * FROM submission_intake_quarantine${messageId ? ` WHERE message_id=${sqlText(messageId)}` : ''} ORDER BY received_at DESC LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 100))};`).rows;
    },
    scheduleRedrive({ messageId, redrivePlan = null, maximumAttempts = 3, delaySeconds = 60 } = {}) {
      const message = this.getOutbox(messageId);
      if (!message) throw new Error('outbox message missing');
      if (message.status !== 'retryable_failure') throw new Error('only retryable failures can be redriven');
      const payload = parsedPayload(message);
      const currentAttempt = Math.max(1, Number(payload._delivery?.attempt || Number(message.attempt_count || 0) + 1));
      const now = clock.nowIso();
      if (currentAttempt >= maximumAttempts) return this.deadLetter({ messageId, failureClass: 'redrive_attempt_limit_reached' });
      if (redrivePlan?.status !== 'submission_redrive_reauthorization_required') throw new Error('redrive plan requiring reauthorization is required');
      if (!validRecordHash('SubmissionRedrivePlan', redrivePlan, 'submissionRedrivePlanHash')) throw new Error('redrive plan hash invalid');
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
      execute(`UPDATE submission_outbox SET status='reauthorization_required',attempt_count=${currentAttempt},payload_json=${sqlJson(updatedPayload)},next_attempt_at=${sqlText(eligibleAt)},updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)};`);
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
      const ledger = receiptLedger.record({ ...receipt, receiptHash }, { stream: 'submission-delivery', paperId: message.paper_id });
      return Object.freeze({ ...receipt, receiptHash, ledgerReceiptId: ledger.receiptId });
    },
    reviewAmbiguousResult({ messageId, redriveDecision, redrivePlan = null } = {}) {
      const message = this.getOutbox(messageId);
      if (!message) throw new Error('outbox message missing');
      if (!['pending', 'waiting_for_response'].includes(message.status)) throw new Error('ambiguous result review requires pending message');
      if (redriveDecision?.dispatchAuthorizationHash !== message.dispatch_hash) throw new Error('ambiguous result decision dispatch mismatch');
      if (!validRecordHash('SubmissionRedriveDecision', redriveDecision, 'submissionRedriveDecisionHash')) throw new Error('ambiguous result decision hash invalid');
      const now = clock.nowIso();
      if (redriveDecision?.decision === 'continue_waiting') {
        execute(`UPDATE submission_outbox SET status='waiting_for_response',next_attempt_at=${sqlText(redriveDecision.responseDueAt)},updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)};`);
        return Object.freeze({ status: 'submission_redrive_waiting', messageId, responseDueAt: redriveDecision.responseDueAt, externalActionPerformed: false });
      }
      if (redriveDecision?.status !== 'submission_redrive_reauthorization_approved'
        || redrivePlan?.status !== 'submission_redrive_reauthorization_required'
        || redrivePlan?.redriveDecisionHash !== redriveDecision?.submissionRedriveDecisionHash) {
        throw new Error('approved ambiguous result decision and redrive plan required');
      }
      if (!validRecordHash('SubmissionRedrivePlan', redrivePlan, 'submissionRedrivePlanHash')) throw new Error('ambiguous redrive plan hash invalid');
      const payload = parsedPayload(message);
      const updatedPayload = { ...payload, _delivery: { ...payload._delivery, redriveReauthorization: { redrivePlanHash: redrivePlan.submissionRedrivePlanHash, redriveDecisionHash: redriveDecision.submissionRedriveDecisionHash, nextAttempt: redrivePlan.nextAttempt, eligibleAt: now } } };
      execute(`UPDATE submission_outbox SET status='reauthorization_required',attempt_count=${Math.max(1, Number(message.attempt_count || 0) + 1)},payload_json=${sqlJson(updatedPayload)},next_attempt_at=${sqlText(now)},updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)};`);
      return Object.freeze({ status: 'submission_redrive_reauthorization_required', messageId, redrivePlanHash: redrivePlan.submissionRedrivePlanHash, externalActionPerformed: false });
    },
    enqueueRedrive({ previousMessageId, dispatchAuthorization, payload } = {}) {
      const previous = this.getOutbox(previousMessageId);
      if (!previous) throw new Error('previous outbox message missing');
      if (previous.status !== 'reauthorization_required') throw new Error('previous outbox message does not require reauthorization');
      if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') throw new Error('fresh dispatch authorization required');
      if (!validRecordHash('SubmissionDispatchAuthorization', dispatchAuthorization, 'submissionDispatchAuthorizationHash')) throw new Error('fresh dispatch authorization hash invalid');
      if (!dispatchAuthorization.redrivePlanHash) throw new Error('redrive plan hash required');
      if (dispatchAuthorization.submissionDispatchAuthorizationHash === previous.dispatch_hash) throw new Error('redrive dispatch authorization must be fresh');
      if (!dispatchAuthorization.nonce || dispatchAuthorization.nonce === previous.nonce) throw new Error('redrive nonce must be fresh');
      if (dispatchAuthorization.provider !== previous.provider || dispatchAuthorization.accountId !== previous.account_id) {
        throw new Error('redrive provider/account scope mismatch');
      }
      const previousPayload = parsedPayload(previous);
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
      execute(`BEGIN IMMEDIATE;
        UPDATE submission_outbox SET status='superseded',updated_at=${sqlText(now)} WHERE message_id=${sqlText(previousMessageId)};
        INSERT INTO submission_outbox(message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,attempt_count,payload_json,next_attempt_at,created_at,updated_at,replay_key,action_scope_key,dispatch_cycle_hash,authorization_receipt_hash,executor_descriptor_hash,response_due_at,executor_capabilities_hash,provider_capability_verification_receipt_hash,portal_route)
        VALUES(${sqlText(messageId)},${sqlText(previous.paper_id)},${sqlText(dispatchHash)},${sqlText(dispatchAuthorization.provider)},${sqlText(dispatchAuthorization.accountId)},${sqlText(dispatchAuthorization.nonce)},'pending',${Number(dispatchAuthorization.attempt) - 1},${sqlJson(storedPayload)},${sqlText(now)},${sqlText(now)},${sqlText(now)},${sqlText(dispatchAuthorization.replayKey)},${sqlText(dispatchAuthorization.actionScopeKey)},${sqlText(dispatchAuthorization.dispatchCycleHash)},${sqlText(dispatchAuthorization.liveAuthorizationHash)},${dispatchAuthorization.executorDescriptorHash ? sqlText(dispatchAuthorization.executorDescriptorHash) : 'NULL'},${sqlText(dispatchAuthorization.responseDueAt)},${dispatchAuthorization.executorCapabilitiesHash ? sqlText(dispatchAuthorization.executorCapabilitiesHash) : 'NULL'},${sqlText(dispatchAuthorization.providerCapabilityVerificationReceiptHash)},${sqlText(dispatchAuthorization.portalRoute)});
        INSERT INTO submission_authorization_consumptions(nonce,authorization_receipt_hash,replay_key,dispatch_cycle_hash,paper_id,message_id,consumed_at)
        VALUES(${sqlText(dispatchAuthorization.nonce)},${sqlText(dispatchAuthorization.liveAuthorizationHash)},${sqlText(dispatchAuthorization.replayKey)},${sqlText(dispatchAuthorization.dispatchCycleHash)},${sqlText(previous.paper_id)},${sqlText(messageId)},${sqlText(now)});
        UPDATE submission_release_locks SET message_id=${sqlText(messageId)},lock_token=${sqlText(dispatchHash)},status='locked',released_at=NULL,reconciliation_hash=NULL WHERE paper_id=${sqlText(previous.paper_id)};
        COMMIT;`);
      const message = this.getOutbox(messageId);
      const receipt = {
        version: 1,
        kind: 'SubmissionRedriveEnqueueReceipt',
        status: 'submission_redrive_enqueued_with_fresh_authorization',
        paperId: previous.paper_id,
        previousMessageId,
        messageId: message.message_id,
        priorDispatchAuthorizationHash: previous.dispatch_hash,
        dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash,
        redrivePlanHash: dispatchAuthorization.redrivePlanHash,
        priorNonce: previous.nonce,
        nonce: dispatchAuthorization.nonce,
        externalActionPerformed: false,
        createdAt: now,
      };
      const receiptHash = hashRecord('SubmissionRedriveEnqueueReceipt', receipt);
      const ledger = receiptLedger.record({ ...receipt, receiptHash }, { stream: 'submission-delivery', paperId: previous.paper_id });
      return Object.freeze({ ...receipt, receiptHash, ledgerReceiptId: ledger.receiptId });
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
    getReleaseLock(paperId) {
      return store.query(`SELECT * FROM submission_release_locks WHERE paper_id=${sqlText(paperId)} LIMIT 1;`).rows[0] || null;
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
      const message = this.getOutbox(current.message_id);
      const authorization = parsedPayload(message)._delivery?.dispatchAuthorization;
      const responseIntake = buildExecutorResponseIntake({ dispatchAuthorization: authorization, response: JSON.parse(response.response_json), responseVerificationReceipt: response.verification_receipt_json ? JSON.parse(response.verification_receipt_json) : null });
      if (releaseLock.dispatchAuthorizationHash !== message.dispatch_hash) throw new Error('release lock dispatch hash mismatch');
      if (releaseLock.responseIntakeHash !== responseIntake.executorResponseIntakeHash) throw new Error('release lock response intake hash mismatch');
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
    recoverPending({ at = clock.nowIso(), limit = 100 } = {}) {
      execute(`UPDATE submission_outbox SET status='pending',claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=${sqlText(at)} WHERE status='in_flight' AND lease_expires_at<=${sqlText(at)};`);
      return store.query(`SELECT * FROM submission_outbox WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=${sqlText(at)}) ORDER BY created_at LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 100))};`).rows;
    },
    advanceResponseCursor({ provider, accountId, responseId } = {}) {
      const now = clock.nowIso();
      execute('BEGIN IMMEDIATE;');
      const rollback = () => { store.execute('ROLLBACK;'); };
      const current = this.getResponseCursor({ provider, accountId });
      const row = store.query(`SELECT i.response_id,i.received_at,o.provider,o.account_id,c.sequence,c.state FROM submission_inbox i JOIN submission_outbox o ON o.message_id=i.message_id JOIN submission_response_consumption c ON c.response_id=i.response_id WHERE i.response_id=${sqlText(responseId)} AND o.provider=${sqlText(provider)} AND o.account_id=${sqlText(accountId)} LIMIT 1;`).rows[0] || null;
      const next = store.query(`SELECT response_id,sequence,state FROM submission_response_consumption WHERE provider=${sqlText(provider)} AND account_id=${sqlText(accountId)} AND sequence>${Number(current?.cursor_sequence || 0)} ORDER BY sequence LIMIT 1;`).rows[0] || null;
      if (!row) { rollback(); throw new Error('cursor response is outside provider/account scope'); }
      if (!next || next.response_id !== responseId) { rollback(); throw new Error('cursor response would skip an earlier response'); }
      if (!['CONSUMED', 'REJECTED'].includes(row.state)) { rollback(); throw new Error('cursor response must be terminally consumed first'); }
      const cursorHash = hashRecord('SubmissionDeliveryCursor', { provider, accountId, responseId: row.response_id, receivedAt: row.received_at, sequence: Number(row.sequence) });
      execute(`INSERT INTO submission_delivery_cursors(provider,account_id,cursor_response_id,cursor_received_at,cursor_hash,updated_at,cursor_sequence) VALUES(${sqlText(provider)},${sqlText(accountId)},${sqlText(row.response_id)},${sqlText(row.received_at)},${sqlText(cursorHash)},${sqlText(now)},${Number(row.sequence)}) ON CONFLICT(provider,account_id) DO UPDATE SET cursor_response_id=excluded.cursor_response_id,cursor_received_at=excluded.cursor_received_at,cursor_hash=excluded.cursor_hash,updated_at=excluded.updated_at,cursor_sequence=excluded.cursor_sequence WHERE submission_delivery_cursors.cursor_sequence<excluded.cursor_sequence;
        COMMIT;`);
      return this.getResponseCursor({ provider, accountId });
    },
    claimNextResponse({ workerId, provider, accountId, anchorHash, leaseSeconds = 60 } = {}) {
      if (!workerId || !provider || !accountId || !anchorHash) throw new Error('response claim scope and anchor are required');
      const now = clock.nowIso();
      const expiresAt = new Date(clock.now().getTime() + Math.max(1, Number(leaseSeconds) || 60) * 1000).toISOString();
      const leaseToken = crypto.randomUUID();
      const cursor = this.getResponseCursor({ provider, accountId });
      execute(`BEGIN IMMEDIATE;
        UPDATE submission_response_consumption SET state='UNCONSUMED',claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE state='IN_PROGRESS' AND lease_expires_at<=${sqlText(now)};
        UPDATE submission_response_consumption SET state='IN_PROGRESS',claimed_by=${sqlText(workerId)},lease_token=${sqlText(leaseToken)},lease_expires_at=${sqlText(expiresAt)},updated_at=${sqlText(now)} WHERE sequence=(SELECT sequence FROM submission_response_consumption WHERE provider=${sqlText(provider)} AND account_id=${sqlText(accountId)} AND sequence>${Number(cursor?.cursor_sequence || 0)} ORDER BY sequence LIMIT 1) AND anchor_hash=${sqlText(anchorHash)} AND state='UNCONSUMED';
        COMMIT;`);
      const claimed = store.query(`SELECT * FROM submission_response_consumption WHERE lease_token=${sqlText(leaseToken)} LIMIT 1;`).rows[0] || null;
      return claimed ? Object.freeze({ ...claimed, leaseToken }) : null;
    },
    completeResponseConsumption({ responseId, leaseToken, disposition = 'CONSUMED' } = {}) {
      if (!['CONSUMED', 'REJECTED'].includes(disposition)) throw new Error('response consumption disposition invalid');
      const now = clock.nowIso();
      const result = store.query(`UPDATE submission_response_consumption SET state=${sqlText(disposition)},consumed_at=${sqlText(now)},claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE response_id=${sqlText(responseId)} AND lease_token=${sqlText(leaseToken)} AND state='IN_PROGRESS' AND lease_expires_at>${sqlText(now)} RETURNING *;`);
      const row = result.rows?.[0] || null;
      if (!result.ok || !row) throw new Error('active response consumption lease required');
      return Object.freeze(row);
    },
    getResponseConsumption(responseId) {
      return store.query(`SELECT * FROM submission_response_consumption WHERE response_id=${sqlText(responseId)} LIMIT 1;`).rows[0] || null;
    },
    getResponseCursor({ provider, accountId } = {}) {
      return store.query(`SELECT * FROM submission_delivery_cursors WHERE provider=${sqlText(provider)} AND account_id=${sqlText(accountId)} LIMIT 1;`).rows[0] || null;
    },
  });
}

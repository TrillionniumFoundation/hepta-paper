import crypto from 'node:crypto';
import { validateBoundaryRecord } from '../../paper-ports/boundary-schema-catalog.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sqlJson, sqlText } from './sqlite-delivery-persistence.mjs';

export function createSqliteDeliveryOutboxOperations({
  persistence,
  receiptLedger,
  clock,
  providerCapabilityVerifier,
  getApi,
} = {}) {
  return {
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
      persistence.execute(`BEGIN IMMEDIATE;
        INSERT INTO submission_outbox(message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,attempt_count,payload_json,next_attempt_at,created_at,updated_at,replay_key,action_scope_key,dispatch_cycle_hash,authorization_receipt_hash,executor_descriptor_hash,response_due_at,executor_capabilities_hash,provider_capability_verification_receipt_hash,portal_route)
        VALUES(${sqlText(messageId)},${sqlText(paperId)},${sqlText(dispatchHash)},${sqlText(dispatchAuthorization.provider)},${sqlText(dispatchAuthorization.accountId)},${sqlText(dispatchAuthorization.nonce)},'pending',${attempt - 1},${sqlJson(storedPayload)},${sqlText(now)},${sqlText(now)},${sqlText(now)},${sqlText(dispatchAuthorization.replayKey)},${sqlText(dispatchAuthorization.actionScopeKey)},${sqlText(dispatchAuthorization.dispatchCycleHash)},${sqlText(dispatchAuthorization.liveAuthorizationHash)},${dispatchAuthorization.executorDescriptorHash ? sqlText(dispatchAuthorization.executorDescriptorHash) : 'NULL'},${sqlText(dispatchAuthorization.responseDueAt)},${dispatchAuthorization.executorCapabilitiesHash ? sqlText(dispatchAuthorization.executorCapabilitiesHash) : 'NULL'},${sqlText(dispatchAuthorization.providerCapabilityVerificationReceiptHash)},${sqlText(dispatchAuthorization.portalRoute)});
        INSERT INTO submission_authorization_consumptions(nonce,authorization_receipt_hash,replay_key,dispatch_cycle_hash,paper_id,message_id,consumed_at)
        VALUES(${sqlText(dispatchAuthorization.nonce)},${sqlText(dispatchAuthorization.liveAuthorizationHash)},${sqlText(dispatchAuthorization.replayKey)},${sqlText(dispatchAuthorization.dispatchCycleHash)},${sqlText(paperId)},${sqlText(messageId)},${sqlText(now)});
        INSERT INTO submission_release_locks(paper_id,message_id,lock_token,status,acquired_at)
        VALUES(${sqlText(paperId)},${sqlText(messageId)},${sqlText(dispatchHash)},'locked',${sqlText(now)});
        COMMIT;`);
      const message = getApi().getOutbox(messageId);
      return Object.freeze({ ...message, _releaseLock: getApi().getReleaseLock(paperId) });
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
      persistence.execute(`INSERT OR IGNORE INTO submission_outbox(message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,attempt_count,payload_json,next_attempt_at,created_at,updated_at) VALUES(${sqlText(messageId)},${sqlText(paperId)},${sqlText(dispatchHash)},${sqlText(dispatchAuthorization.provider)},${sqlText(dispatchAuthorization.accountId)},${sqlText(dispatchAuthorization.nonce)},'pending',${attempt - 1},${sqlJson(storedPayload)},${sqlText(now)},${sqlText(now)},${sqlText(now)});`);
      return getApi().getOutbox(messageId);
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
      if (typeof receiptLedger.prepare !== 'function') throw new Error('atomic receipt ledger preparation required');
      const preparedLedger = receiptLedger.prepare(verification, { stream: 'submission-provider-capability' });
      persistence.execute('BEGIN IMMEDIATE;');
      try {
        persistence.execute(`${preparedLedger.sql}
          INSERT OR IGNORE INTO submission_provider_capabilities(capability_id,provider,account_id,portal_route,executor_descriptor_hash,capabilities_hash,attestation_hash,verification_receipt_hash,verified_subject_ids_json,valid_from,expires_at,status,created_at)
          VALUES(${sqlText(capabilityId)},${sqlText(verification.provider)},${sqlText(verification.accountId)},${sqlText(verification.portalRoute)},${sqlText(verification.executorDescriptorHash)},${sqlText(verification.capabilitiesHash)},${sqlText(verification.attestationHash)},${sqlText(verification.providerCapabilityVerificationReceiptHash)},${sqlJson(verification.verifiedSubjectIds)},${sqlText(verification.validFrom)},${sqlText(verification.expiresAt)},'active',${sqlText(now)})
          ON CONFLICT(provider,account_id,executor_descriptor_hash) DO NOTHING;`);
        const persisted = persistence.one(`SELECT * FROM submission_provider_capabilities WHERE provider=${sqlText(verification.provider)} AND account_id=${sqlText(verification.accountId)} AND executor_descriptor_hash=${sqlText(verification.executorDescriptorHash)} LIMIT 1;`);
        if (!persisted || persisted.verification_receipt_hash !== verification.providerCapabilityVerificationReceiptHash
          || persisted.portal_route !== verification.portalRoute || persisted.capabilities_hash !== verification.capabilitiesHash) {
          throw new Error('provider capability replacement requires a new executor descriptor');
        }
        persistence.execute('COMMIT;');
      } catch (error) {
        persistence.rollback();
        throw error;
      }
      return Object.freeze({ capabilityId, ...verification, ledgerReceiptId: preparedLedger.receiptId });
    },
    claimPending({ workerId, provider, accountId, executorDescriptorHash, leaseSeconds = 60 } = {}) {
      if (!workerId || !provider || !accountId || !executorDescriptorHash) throw new Error('claim scope is required');
      const now = clock.nowIso();
      const expiresAt = new Date(clock.now().getTime() + Math.max(1, Number(leaseSeconds) || 60) * 1000).toISOString();
      const capability = persistence.one(`SELECT * FROM submission_provider_capabilities WHERE provider=${sqlText(provider)} AND account_id=${sqlText(accountId)} AND executor_descriptor_hash=${sqlText(executorDescriptorHash)} AND status='active' AND valid_from<=${sqlText(now)} AND expires_at>${sqlText(now)} LIMIT 1;`);
      if (!capability) throw new Error('active verified provider capability required');
      const leaseToken = crypto.randomUUID();
      persistence.execute(`BEGIN IMMEDIATE;
        UPDATE submission_outbox SET status='pending',claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=${sqlText(now)} WHERE status='in_flight' AND lease_expires_at<=${sqlText(now)};
        UPDATE submission_outbox SET status='in_flight',claimed_by=${sqlText(workerId)},lease_token=${sqlText(leaseToken)},lease_expires_at=${sqlText(expiresAt)},heartbeat_at=${sqlText(now)},updated_at=${sqlText(now)}
          WHERE message_id=(SELECT message_id FROM submission_outbox WHERE status='pending' AND provider=${sqlText(provider)} AND account_id=${sqlText(accountId)} AND executor_descriptor_hash=${sqlText(executorDescriptorHash)} AND executor_capabilities_hash=${sqlText(capability.capabilities_hash)} AND provider_capability_verification_receipt_hash=${sqlText(capability.verification_receipt_hash)} AND portal_route=${sqlText(capability.portal_route)} AND response_due_at>${sqlText(now)} AND (next_attempt_at IS NULL OR next_attempt_at<=${sqlText(now)}) ORDER BY created_at LIMIT 1);`);
      const message = persistence.one(`SELECT * FROM submission_outbox WHERE lease_token=${sqlText(leaseToken)} LIMIT 1;`);
      if (!message) {
        persistence.execute('COMMIT;');
        return null;
      }
      const leasePayload = { version: 1, kind: 'SubmissionDeliveryLeaseReceipt', status: 'submission_delivery_leased', messageId: message.message_id, provider, accountId, workerId, dispatchAuthorizationHash: message.dispatch_hash, leaseTokenHash: hashRecord('SubmissionDeliveryLeaseToken', { leaseToken }), leaseExpiresAt: expiresAt, providerCapabilityVerificationReceiptHash: capability.verification_receipt_hash, createdAt: now };
      const schema = validateBoundaryRecord(leasePayload);
      if (schema.status !== 'boundary_schema_verified') {
        persistence.rollback();
        throw new Error(schema.blockers.join(','));
      }
      const receiptHash = hashRecord('SubmissionDeliveryLeaseReceipt', leasePayload);
      if (typeof receiptLedger.prepare !== 'function') {
        persistence.rollback();
        throw new Error('atomic receipt ledger preparation required');
      }
      let preparedLedger;
      try {
        preparedLedger = receiptLedger.prepare({ ...leasePayload, receiptHash }, { stream: 'submission-delivery', paperId: message.paper_id, strictInsert: true });
      } catch (error) {
        persistence.rollback();
        throw error;
      }
      try {
        persistence.execute(`${preparedLedger.sql} COMMIT;`);
      } catch (error) {
        persistence.rollback();
        throw error;
      }
      return Object.freeze({ ...message, leaseToken, leaseReceiptHash: receiptHash, ledgerReceiptId: preparedLedger.receiptId, providerCapabilityVerificationReceiptHash: capability.verification_receipt_hash });
    },
    heartbeatClaim({ messageId, leaseToken, leaseSeconds = 60 } = {}) {
      const now = clock.nowIso();
      const expiresAt = new Date(clock.now().getTime() + Math.max(1, Number(leaseSeconds) || 60) * 1000).toISOString();
      persistence.execute(`UPDATE submission_outbox SET lease_expires_at=${sqlText(expiresAt)},heartbeat_at=${sqlText(now)},updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)} AND lease_token=${sqlText(leaseToken)} AND status='in_flight' AND lease_expires_at>${sqlText(now)};`);
      const message = getApi().getOutbox(messageId);
      if (!message || message.lease_token !== leaseToken || message.status !== 'in_flight' || Date.parse(message.lease_expires_at) <= clock.now().getTime()) throw new Error('active delivery lease missing');
      return Object.freeze({ status: 'submission_delivery_lease_renewed', messageId, leaseExpiresAt: message.lease_expires_at });
    },
    acquireReleaseLock({ paperId, messageId, lockToken } = {}) {
      const now = clock.nowIso();
      persistence.execute(`INSERT OR IGNORE INTO submission_release_locks(paper_id,message_id,lock_token,status,acquired_at) VALUES(${sqlText(paperId)},${sqlText(messageId)},${sqlText(lockToken)},'locked',${sqlText(now)});`);
      const lock = getApi().getReleaseLock(paperId);
      return lock?.lock_token === lockToken ? lock : null;
    },
    getReleaseLock(paperId) {
      return persistence.one(`SELECT * FROM submission_release_locks WHERE paper_id=${sqlText(paperId)} LIMIT 1;`);
    },
    getOutbox(messageId) {
      return persistence.one(`SELECT * FROM submission_outbox WHERE message_id=${sqlText(messageId)} LIMIT 1;`);
    },
    listOutbox({ status = null, limit = 100 } = {}) {
      return persistence.rows(`SELECT * FROM submission_outbox${status ? ` WHERE status=${sqlText(status)}` : ''} ORDER BY created_at LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 100))};`);
    },
    recoverPending({ at = clock.nowIso(), limit = 100 } = {}) {
      persistence.execute(`UPDATE submission_outbox SET status='pending',claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,updated_at=${sqlText(at)} WHERE status='in_flight' AND lease_expires_at<=${sqlText(at)};`);
      return persistence.rows(`SELECT * FROM submission_outbox WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=${sqlText(at)}) ORDER BY created_at LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 100))};`);
    },
  };
}

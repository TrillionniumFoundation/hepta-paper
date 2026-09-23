import {
  preparedSqliteReceiptLedgerMutation,
} from '../persistence/sqlite-receipt-ledger.mjs';
import {
  NATIVE_STORE_SUBMISSION_DELIVERY_STATEMENT_IDS,
} from '../persistence/native-store-submission-delivery-mutation-plan.mjs';
import {
  AUTONOMOUS_SUBMISSION_HANDOFF_STATEMENT_IDS,
} from '../persistence/autonomous-submission-handoff-mutation-plan.mjs';
import {
  assertAutonomousSubmissionHandoffOutboxPort,
  assertAutonomousSubmissionOutboxPort,
} from '../../paper-ports/autonomous-submission-outbox-port.mjs';
import { failClosedStoreQueries, sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import {
  autonomousSubmissionOutboxMessageId,
  autonomousSubmissionSideEffectReservationHash,
  AUTONOMOUS_SUBMISSION_DELIVERY_STATES,
  buildAutonomousSubmissionDeliveryStateReceipt,
  verifyAutonomousSubmissionDeliveryStateReceipt,
} from '../../paper-domain/automation/autonomous-submission-delivery-contract.mjs';
import {
  createAutonomousSubmissionCompletedReceiptVerifier,
} from './autonomous-submission-completed-receipt-verifier.mjs';
import {
  autonomousLiveSubmissionAuthorizationBinding,
} from '../../paper-domain/submission/autonomous-live-submission-authorization-contract.mjs';
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ROW_STATUS = Object.freeze({
  prepared: 'pending',
  dispatching: 'in_flight',
  completed: 'responded',
  explicit_failure: 'dead_letter',
  uncertain: 'waiting_for_response',
});
const persistedCompletedReceiptVerifier =
  createAutonomousSubmissionCompletedReceiptVerifier();

function authorizationHashes(...values) {
  return Object.freeze([...new Set(values.filter((value) => SHA256.test(String(value || ''))))]
    .sort());
}

function clockNow(clock) {
  return typeof clock?.now === 'function' ? clock.now() : new Date(clock.nowIso());
}

function envelope({ request, portalId, stateReceipt }) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionOutboxEnvelope',
    request: Object.freeze({ ...request }),
    portalId: String(portalId),
    stateReceipt: Object.freeze({ ...stateReceipt }),
  });
}

function parseEnvelope(row, {
  request = null,
  portalId = null,
  submissionRequestVerifier,
} = {}) {
  let stored;
  try { stored = JSON.parse(String(row?.payload_json || '')); }
  catch { throw new Error('autonomous_submission_outbox_payload_invalid'); }
  const boundRequest = stored?.request;
  const receipt = stored?.stateReceipt;
  if (row?.delivery_kind !== 'autonomous'
    || stored?.version !== 1 || stored?.kind !== 'AutonomousSubmissionOutboxEnvelope'
    || submissionRequestVerifier?.kind !== 'AutonomousSubmissionRequestVerifier'
    || submissionRequestVerifier.verify(boundRequest) !== true
    || !verifyAutonomousSubmissionDeliveryStateReceipt(receipt, {
      request: boundRequest,
      requestVerifier: submissionRequestVerifier,
      completedReceiptVerifier: persistedCompletedReceiptVerifier,
    })
    || stored.portalId !== receipt.portalId
    || row?.message_id !== receipt.messageId
    || row?.paper_id !== boundRequest.paperId
    || row?.dispatch_hash !== boundRequest.requestHash
    || row?.provider !== stored.portalId
    || row?.account_id !== boundRequest.portalConfigurationHash
    || row?.nonce !== boundRequest.idempotencyKey
    || row?.authorization_receipt_hash
      !== boundRequest.humanAuthorizationReceiptHash
    || row?.status !== ROW_STATUS[receipt.state]
    || Number(row?.attempt_count) !== receipt.attempt
    || (request && (boundRequest.requestHash !== request.requestHash
      || boundRequest.idempotencyKey !== request.idempotencyKey
      || JSON.stringify(boundRequest) !== JSON.stringify(request)))
    || (portalId && stored.portalId !== portalId)) {
    throw new Error('autonomous_submission_outbox_binding_invalid');
  }
  return Object.freeze({
    messageId: row.message_id,
    request: Object.freeze(boundRequest),
    portalId: stored.portalId,
    stateReceipt: Object.freeze(receipt),
  });
}

function preparedLedger(receiptLedger, receipt, paperId) {
  if (typeof receiptLedger?.prepare !== 'function') {
    throw new Error('atomic receipt ledger preparation required');
  }
  return receiptLedger.prepare(receipt, {
    stream: 'autonomous-submission-delivery', paperId,
  });
}

function result(value, externallyFencedMutations, ledgerReceiptId = null, extra = {}) {
  return Object.freeze({
    ...value,
    externallyFencedMutations,
    ...(ledgerReceiptId ? { ledgerReceiptId } : {}),
    ...extra,
  });
}

function assertMutationReceipt(receipt) {
  if (![
    'externally_fenced_sqlite_mutation_finalized',
    'externally_fenced_sqlite_mutation_no_change',
  ].includes(receipt?.status)) {
    throw new Error('autonomous_submission_outbox_mutation_receipt_invalid');
  }
  return receipt;
}

export function createAutonomousSubmissionOutboxRepository({
  store: suppliedStore,
  receiptLedger,
  clock,
  submissionRequestVerifier,
  dispatchCapability = null,
  handoffOnly = false,
  dedicatedHandoffRequired = false,
} = {}) {
  const dispatchReady = dispatchCapability?.kind
      === 'AutonomousSubmissionOutboxDispatchCapabilityAuthority'
    && typeof dispatchCapability.issueDispatchPermit === 'function'
    && typeof dispatchCapability.consumeAuthoritativeNotFoundReceipt === 'function';
  if (!suppliedStore || !receiptLedger || !clock
    || submissionRequestVerifier?.kind !== 'AutonomousSubmissionRequestVerifier'
    || typeof submissionRequestVerifier.verify !== 'function'
    || typeof handoffOnly !== 'boolean'
    || typeof dedicatedHandoffRequired !== 'boolean'
    || (!handoffOnly && !dispatchReady)) {
    throw new Error(
      'Autonomous submission outbox requires store, receiptLedger, clock, submissionRequestVerifier and dispatchCapability',
    );
  }
  const store = failClosedStoreQueries(suppliedStore);
  if (dedicatedHandoffRequired) {
    const cutover = store.query(`SELECT cutover_id,native_cutover_identity_hash,status
      FROM handoff_cutover WHERE singleton=1 LIMIT 1;`).rows[0] || null;
    if (cutover?.status !== 'active') {
      throw new Error('autonomous_submission_handoff_cutover_required');
    }
  }
  const externallyFencedMutations = typeof suppliedStore.mutate === 'function';
  if (dedicatedHandoffRequired && !externallyFencedMutations
    && suppliedStore.readOnly !== true) {
    throw new Error('autonomous_submission_handoff_external_mutation_coordinator_required');
  }
  const S = dedicatedHandoffRequired
    ? AUTONOMOUS_SUBMISSION_HANDOFF_STATEMENT_IDS
    : NATIVE_STORE_SUBMISSION_DELIVERY_STATEMENT_IDS;
  const currentHumanAuthorization = (request, observedAt) => (
    autonomousLiveSubmissionAuthorizationBinding(request, {
      observedAt,
      verifyAuthorityDocument: (input) => (
        submissionRequestVerifier.verifyHumanAuthorization?.({
          receipt: request?.humanAuthorizationReceipt,
          expectedSubject: input.expectedSubject,
          observedAt: input.observedAt,
        }) === true
      ),
    })
  );
  const getRow = (messageId) => store.query(
    `SELECT * FROM submission_outbox WHERE delivery_kind='autonomous'
      AND message_id=${sqlText(messageId)} LIMIT 1;`,
  ).rows[0] || null;
  const api = {
    version: 1,
    kind: 'AutonomousSubmissionOutboxPort',
    durability: 'sqlite-transactional-outbox-v1',
    singleUseDispatchCapabilityIssued: true,
    externallyFencedMutations,
    prepareAutonomousSubmission({ request, portalId } = {}) {
      if (submissionRequestVerifier.verify(request) !== true
        || !currentHumanAuthorization(request, clockNow(clock))) {
        throw new Error('autonomous_submission_delivery_request_invalid');
      }
      const messageId = autonomousSubmissionOutboxMessageId(request, {
        requestVerifier: submissionRequestVerifier,
      });
      const now = clock.nowIso();
      const stateReceipt = buildAutonomousSubmissionDeliveryStateReceipt({
        request,
        portalId,
        state: AUTONOMOUS_SUBMISSION_DELIVERY_STATES.PREPARED,
        attempt: 0,
        resolution: 'local-intent-persisted',
        recordedAt: now,
        requestVerifier: submissionRequestVerifier,
        completedReceiptVerifier: persistedCompletedReceiptVerifier,
      });
      const storedEnvelope = envelope({ request, portalId, stateReceipt });
      const ledger = preparedLedger(receiptLedger, stateReceipt, request.paperId);
      if (externallyFencedMutations) {
        const ledgerMutation = preparedSqliteReceiptLedgerMutation(ledger);
        const applyMutation = (transaction) => {
          const existing = transaction.get(S.getAutonomousSubmission, messageId);
          if (existing) return existing;
          transaction.run(S.receiptInsertIgnore, ...ledgerMutation.parameters);
          transaction.run(
            S.prepareAutonomousSubmission,
            messageId,
            request.paperId,
            request.requestHash,
            portalId,
            request.portalConfigurationHash,
            request.idempotencyKey,
            JSON.stringify(storedEnvelope),
            now,
            now,
            now,
            request.idempotencyKey,
            request.idempotencyKey,
            request.requestHash,
            request.humanAuthorizationReceiptHash,
            request.portalConfigurationHash,
            request.venueId,
          );
          return transaction.get(S.getAutonomousSubmission, messageId);
        };
        const mutationAuthority = {
          authorizationReceiptHashes: authorizationHashes(
            request.humanAuthorizationReceiptHash,
            request.qualificationReceiptHash,
            request.venueComplianceReceiptHash,
            request.submissionMetadataReceiptHash,
          ),
          sideEffectReservationHashes: [],
        };
        const mutationReceipt = dedicatedHandoffRequired
          ? suppliedStore.mutate({
            ...mutationAuthority,
            databaseRole: 'submission-handoff',
            operationId: 'submission-handoff.delivery-outbox-operations.prepareAutonomousSubmission.v1',
            mutate: applyMutation,
          })
          : suppliedStore.mutate({
            ...mutationAuthority,
            databaseRole: 'native-store',
            operationId: 'native-store.delivery-outbox-operations.prepareAutonomousSubmission.v1',
            mutate: applyMutation,
          });
        assertMutationReceipt(mutationReceipt);
      } else {
        suppliedStore.transaction((transaction) => {
          const existing = transaction.query(
            `SELECT message_id FROM submission_outbox WHERE delivery_kind='autonomous'
              AND message_id=${sqlText(messageId)} LIMIT 1;`,
          ).rows[0];
          if (existing) return;
          const write = transaction.execute(`${ledger.sql}
            INSERT INTO submission_outbox(
              delivery_kind,message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,attempt_count,
              payload_json,next_attempt_at,created_at,updated_at,replay_key,action_scope_key,
              dispatch_cycle_hash,authorization_receipt_hash,executor_descriptor_hash,portal_route
            ) VALUES(
              'autonomous',${sqlText(messageId)},${sqlText(request.paperId)},${sqlText(request.requestHash)},
              ${sqlText(portalId)},${sqlText(request.portalConfigurationHash)},
              ${sqlText(request.idempotencyKey)},'pending',0,${sqlJson(storedEnvelope)},
              ${sqlText(now)},${sqlText(now)},${sqlText(now)},
              ${sqlText(request.idempotencyKey)},${sqlText(request.idempotencyKey)},
              ${sqlText(request.requestHash)},${sqlText(request.humanAuthorizationReceiptHash)},
              ${sqlText(request.portalConfigurationHash)},${sqlText(request.venueId)}
            );`);
          if (!write.ok) throw new Error(write.error || 'autonomous_submission_prepare_failed');
        });
      }
      const persisted = parseEnvelope(getRow(messageId), {
        request, portalId, submissionRequestVerifier,
      });
      const persistedLedger = preparedLedger(
        receiptLedger, persisted.stateReceipt, request.paperId,
      );
      return result(persisted, externallyFencedMutations, persistedLedger.receiptId);
    },
    beginAutonomousSubmissionAttempt({
      request,
      portalId,
      authoritativeNotFoundReceipt = null,
    } = {}) {
      if (!currentHumanAuthorization(request, clockNow(clock))) {
        throw new Error('autonomous_submission_human_authorization_invalid');
      }
      const messageId = autonomousSubmissionOutboxMessageId(request, {
        requestVerifier: submissionRequestVerifier,
      });
      const current = parseEnvelope(getRow(messageId), {
        request, portalId, submissionRequestVerifier,
      });
      const initial = current.stateReceipt.state === 'prepared';
      const redrive = ['dispatching', 'uncertain'].includes(current.stateReceipt.state);
      if ((!initial && !redrive) || (initial && authoritativeNotFoundReceipt !== null)) {
        throw new Error('autonomous_submission_redrive_not_authorized');
      }
      if (redrive) {
        dispatchCapability.consumeAuthoritativeNotFoundReceipt({
          receipt: authoritativeNotFoundReceipt,
          request,
          portalId,
        });
      }
      const resolution = initial
        ? 'initial-dispatch' : 'remote-authoritative-not-found-redrive';
      const now = clock.nowIso();
      const stateReceipt = buildAutonomousSubmissionDeliveryStateReceipt({
        request,
        portalId,
        state: AUTONOMOUS_SUBMISSION_DELIVERY_STATES.DISPATCHING,
        attempt: current.stateReceipt.attempt + 1,
        resolution,
        previousStateReceiptHash:
          current.stateReceipt.autonomousSubmissionDeliveryStateReceiptHash,
        recordedAt: now,
        requestVerifier: submissionRequestVerifier,
        completedReceiptVerifier: persistedCompletedReceiptVerifier,
      });
      const storedEnvelope = envelope({ request, portalId, stateReceipt });
      const previousEnvelope = envelope({ request, portalId, stateReceipt: current.stateReceipt });
      const ledger = preparedLedger(receiptLedger, stateReceipt, request.paperId);
      const reservationHash = autonomousSubmissionSideEffectReservationHash(request, {
        requestVerifier: submissionRequestVerifier,
      });
      const authorizationConsumption = Object.freeze({
        nonce: request.humanAuthorizationNonce,
        authorizationReceiptHash: request.humanAuthorizationReceiptHash,
        replayKey: request.idempotencyKey,
        dispatchCycleHash:
          stateReceipt.autonomousSubmissionDeliveryStateReceiptHash,
        paperId: request.paperId,
        messageId,
        consumedAt: now,
      });
      const priorConsumption = store.query(`SELECT nonce FROM
        submission_authorization_consumptions
        WHERE nonce=${sqlText(authorizationConsumption.nonce)}
        OR authorization_receipt_hash=${sqlText(
    authorizationConsumption.authorizationReceiptHash)}
        OR replay_key=${sqlText(authorizationConsumption.replayKey)} LIMIT 1;`).rows[0];
      if (priorConsumption) {
        throw new Error('autonomous_submission_human_authorization_already_consumed');
      }
      let mutationReceipt = null;
      if (externallyFencedMutations) {
        const ledgerMutation = preparedSqliteReceiptLedgerMutation(ledger);
        const applyMutation = (transaction) => {
          transaction.run(
            S.consumeAutonomousAuthorization,
            authorizationConsumption.nonce,
            authorizationConsumption.authorizationReceiptHash,
            authorizationConsumption.replayKey,
            authorizationConsumption.dispatchCycleHash,
            authorizationConsumption.paperId,
            authorizationConsumption.messageId,
            authorizationConsumption.consumedAt,
          );
          const updated = transaction.run(
            S.beginAutonomousSubmissionAttempt,
            stateReceipt.attempt,
            JSON.stringify(storedEnvelope),
            now,
            now,
            messageId,
            ROW_STATUS[current.stateReceipt.state],
            current.stateReceipt.attempt,
            JSON.stringify(previousEnvelope),
          );
          if (Number(updated.changes) !== 1) {
            throw new Error('autonomous_submission_outbox_transition_conflict');
          }
          transaction.run(S.receiptInsertIgnore, ...ledgerMutation.parameters);
          return transaction.get(S.getAutonomousSubmission, messageId);
        };
        const mutationAuthority = {
          authorizationReceiptHashes: authorizationHashes(
            request.humanAuthorizationReceiptHash,
            request.qualificationReceiptHash,
            request.venueComplianceReceiptHash,
          ),
          sideEffectReservationHashes: [reservationHash],
        };
        mutationReceipt = dedicatedHandoffRequired
          ? suppliedStore.mutate({
            ...mutationAuthority,
            databaseRole: 'submission-handoff',
            operationId: 'submission-handoff.delivery-outbox-operations.beginAutonomousSubmissionAttempt.v1',
            mutate: applyMutation,
          })
          : suppliedStore.mutate({
            ...mutationAuthority,
            databaseRole: 'native-store',
            operationId: 'native-store.delivery-outbox-operations.beginAutonomousSubmissionAttempt.v1',
            mutate: applyMutation,
          });
        assertMutationReceipt(mutationReceipt);
      } else {
        suppliedStore.transaction((transaction) => {
          const consumed = transaction.execute(`INSERT INTO submission_authorization_consumptions(
            nonce,authorization_receipt_hash,replay_key,dispatch_cycle_hash,paper_id,message_id,
            consumed_at) VALUES(${sqlText(authorizationConsumption.nonce)},
            ${sqlText(authorizationConsumption.authorizationReceiptHash)},
            ${sqlText(authorizationConsumption.replayKey)},
            ${sqlText(authorizationConsumption.dispatchCycleHash)},
            ${sqlText(authorizationConsumption.paperId)},
            ${sqlText(authorizationConsumption.messageId)},
            ${sqlText(authorizationConsumption.consumedAt)});`);
          if (!consumed.ok) {
            throw new Error('autonomous_submission_human_authorization_already_consumed');
          }
          const updated = transaction.query(`UPDATE submission_outbox SET
            status='in_flight',attempt_count=${stateReceipt.attempt},
            payload_json=${sqlJson(storedEnvelope)},next_attempt_at=${sqlText(now)},
            updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)}
            AND delivery_kind='autonomous'
            AND status=${sqlText(ROW_STATUS[current.stateReceipt.state])}
            AND attempt_count=${current.stateReceipt.attempt}
            AND payload_json=${sqlJson(previousEnvelope)} RETURNING message_id;`);
          if (updated.rows.length !== 1) {
            throw new Error('autonomous_submission_outbox_transition_conflict');
          }
          const write = transaction.execute(ledger.sql);
          if (!write.ok) throw new Error(write.error || 'autonomous_submission_ledger_failed');
        });
      }
      const permit = mutationReceipt?.sideEffectPermitHash || null;
      if (externallyFencedMutations && !SHA256.test(String(permit || ''))) {
        throw new Error('autonomous_submission_side_effect_permit_missing');
      }
      const persisted = parseEnvelope(getRow(messageId), {
        request, portalId, submissionRequestVerifier,
      });
      const sideEffectPermit = dispatchCapability.issueDispatchPermit({
        request,
        portalId,
        attempt: stateReceipt.attempt,
        previousState: current.stateReceipt.state,
        previousStateReceiptHash:
          current.stateReceipt.autonomousSubmissionDeliveryStateReceiptHash,
        dispatchStateReceiptHash:
          persisted.stateReceipt.autonomousSubmissionDeliveryStateReceiptHash,
        resolution,
        authoritativeNotFoundReceiptHash:
          authoritativeNotFoundReceipt
            ?.autonomousSubmissionAuthoritativeNotFoundReceiptHash || null,
        onlineMutationSideEffectPermitHash: permit,
      });
      return result(persisted,
        externallyFencedMutations, ledger.receiptId, {
          sideEffectReservationHash: reservationHash,
          sideEffectPermitHash: permit,
          sideEffectPermit,
        });
    },
    recordAutonomousSubmissionOutcome({
      request,
      portalId,
      state,
      resolution,
      submissionReceipt = null,
      failure = null,
    } = {}) {
      if (!['completed', 'explicit_failure', 'uncertain'].includes(state)) {
        throw new Error('autonomous_submission_outcome_invalid');
      }
      const messageId = autonomousSubmissionOutboxMessageId(request, {
        requestVerifier: submissionRequestVerifier,
      });
      const current = parseEnvelope(getRow(messageId), {
        request, portalId, submissionRequestVerifier,
      });
      if (!['dispatching', 'uncertain'].includes(current.stateReceipt.state)
        || (current.stateReceipt.state === 'uncertain' && state === 'uncertain')) {
        throw new Error('autonomous_submission_outcome_transition_invalid');
      }
      const now = clock.nowIso();
      const stateReceipt = buildAutonomousSubmissionDeliveryStateReceipt({
        request,
        portalId,
        state,
        attempt: current.stateReceipt.attempt,
        resolution,
        previousStateReceiptHash:
          current.stateReceipt.autonomousSubmissionDeliveryStateReceiptHash,
        submissionReceipt,
        failure,
        recordedAt: now,
        requestVerifier: submissionRequestVerifier,
        completedReceiptVerifier: persistedCompletedReceiptVerifier,
      });
      const storedEnvelope = envelope({ request, portalId, stateReceipt });
      const previousEnvelope = envelope({ request, portalId, stateReceipt: current.stateReceipt });
      const ledger = preparedLedger(receiptLedger, stateReceipt, request.paperId);
      if (externallyFencedMutations) {
        const ledgerMutation = preparedSqliteReceiptLedgerMutation(ledger);
        const applyMutation = (transaction) => {
          const updated = transaction.run(
            S.recordAutonomousSubmissionOutcome,
            ROW_STATUS[state],
            JSON.stringify(storedEnvelope),
            now,
            messageId,
            ROW_STATUS[current.stateReceipt.state],
            current.stateReceipt.attempt,
            JSON.stringify(previousEnvelope),
          );
          if (Number(updated.changes) !== 1) {
            throw new Error('autonomous_submission_outbox_transition_conflict');
          }
          transaction.run(S.receiptInsertIgnore, ...ledgerMutation.parameters);
        };
        const mutationAuthority = {
          authorizationReceiptHashes: authorizationHashes(
            request.qualificationReceiptHash,
            submissionReceipt?.autonomousSubmissionReceiptHash,
          ),
          sideEffectReservationHashes: [],
        };
        const mutationReceipt = dedicatedHandoffRequired
          ? suppliedStore.mutate({
            ...mutationAuthority,
            databaseRole: 'submission-handoff',
            operationId: 'submission-handoff.delivery-outbox-operations.recordAutonomousSubmissionOutcome.v1',
            mutate: applyMutation,
          })
          : suppliedStore.mutate({
            ...mutationAuthority,
            databaseRole: 'native-store',
            operationId: 'native-store.delivery-outbox-operations.recordAutonomousSubmissionOutcome.v1',
            mutate: applyMutation,
          });
        assertMutationReceipt(mutationReceipt);
      } else {
        suppliedStore.transaction((transaction) => {
          const updated = transaction.query(`UPDATE submission_outbox SET
            status=${sqlText(ROW_STATUS[state])},payload_json=${sqlJson(storedEnvelope)},
            claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
            updated_at=${sqlText(now)} WHERE message_id=${sqlText(messageId)}
            AND delivery_kind='autonomous'
            AND status=${sqlText(ROW_STATUS[current.stateReceipt.state])}
            AND attempt_count=${current.stateReceipt.attempt}
            AND payload_json=${sqlJson(previousEnvelope)} RETURNING message_id;`);
          if (updated.rows.length !== 1) {
            throw new Error('autonomous_submission_outbox_transition_conflict');
          }
          const write = transaction.execute(ledger.sql);
          if (!write.ok) throw new Error(write.error || 'autonomous_submission_ledger_failed');
        });
      }
      return result(parseEnvelope(getRow(messageId), {
        request, portalId, submissionRequestVerifier,
      }),
        externallyFencedMutations, ledger.receiptId);
    },
    getAutonomousSubmission({ request, portalId = null } = {}) {
      const row = getRow(autonomousSubmissionOutboxMessageId(request, {
        requestVerifier: submissionRequestVerifier,
      }));
      return row ? result(parseEnvelope(row, {
        request, portalId, submissionRequestVerifier,
      }),
        externallyFencedMutations) : null;
    },
    listAutonomousSubmissionsForCampaign({ campaignId, paperId, portalId = null } = {}) {
      const normalizedCampaignId = String(campaignId || '').trim();
      const normalizedPaperId = String(paperId || '').trim();
      if (!normalizedCampaignId || !normalizedPaperId) {
        throw new Error('autonomous_submission_outbox_campaign_binding_required');
      }
      return Object.freeze(store.query(`SELECT * FROM submission_outbox
        WHERE delivery_kind='autonomous'
        AND paper_id=${sqlText(normalizedPaperId)}
        ORDER BY created_at ASC,message_id ASC;`).rows
        .map((row) => parseEnvelope(row, { portalId, submissionRequestVerifier }))
        .filter((candidate) => candidate.request.campaignId === normalizedCampaignId)
        .map((candidate) => result(candidate, externallyFencedMutations)));
    },
    listDispatchableAutonomousSubmissions({ campaignId = null, limit = 100 } = {}) {
      const normalizedCampaignId = campaignId === null
        ? null : String(campaignId || '').trim();
      const bounded = Number(limit);
      if ((campaignId !== null && !normalizedCampaignId)
        || !Number.isSafeInteger(bounded) || bounded < 1 || bounded > 1000) {
        throw new Error('autonomous_submission_dispatchable_query_invalid');
      }
      return Object.freeze(store.query(`SELECT * FROM submission_outbox
        WHERE delivery_kind='autonomous'
        AND status IN ('pending','in_flight','waiting_for_response')
        ORDER BY created_at ASC,message_id ASC LIMIT ${bounded};`).rows
        .map((row) => parseEnvelope(row, { submissionRequestVerifier }))
        .filter((candidate) => normalizedCampaignId === null
          || candidate.request.campaignId === normalizedCampaignId)
        .map((candidate) => result(candidate, externallyFencedMutations)));
    },
  };
  if (handoffOnly) {
    return assertAutonomousSubmissionHandoffOutboxPort(Object.freeze({
      version: 1,
      kind: 'AutonomousSubmissionHandoffOutboxPort',
      durability: api.durability,
      dispatchCapabilityAvailable: false,
      externallyFencedMutations,
      prepareAutonomousSubmission: api.prepareAutonomousSubmission,
      getAutonomousSubmission: api.getAutonomousSubmission,
      listAutonomousSubmissionsForCampaign: api.listAutonomousSubmissionsForCampaign,
    }));
  }
  return assertAutonomousSubmissionOutboxPort(Object.freeze(api));
}

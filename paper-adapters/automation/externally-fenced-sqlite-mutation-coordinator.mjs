import crypto from 'node:crypto';

import {
  assertAutonomousResearchOnlineMutationReserveRequest,
  autonomousResearchOnlineMutationReceiptHash,
  autonomousResearchOnlineMutationStateHash,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  assertExternallyFencedSqliteMutationCoordinatorPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertExternallyFencedSqliteMutationDatabaseSurface,
  createExternallyFencedSqliteMutationTransaction,
} from './externally-fenced-sqlite-mutation-plan.mjs';
import {
  validateExternallyFencedSqliteMutationCoordinatorFactory,
  validateExternallyFencedSqliteMutationInput,
} from './externally-fenced-sqlite-mutation-coordinator-validation.mjs';
import {
  buildExternallyFencedSqliteMutationFinalizeRequest,
  recordExternallyFencedSqliteMutationFinalization,
  recoverExternallyFencedSqliteMutations,
} from './externally-fenced-sqlite-mutation-recovery.mjs';
import {
  externallyFencedSqliteMutationExactSchemaHash as exactSchemaHash,
  observedExternallyFencedSqliteMutationNow as observedNow,
  readExternallyFencedSqliteMutationMetadata as metadata,
} from './externally-fenced-sqlite-storage-primitives.mjs';

const SYSTEM_TABLES = Object.freeze([
  'autonomous_research_online_mutation_authority_metadata',
  'autonomous_research_online_mutation_authority_marker',
  'autonomous_research_online_mutation_finalization_receipt',
]);

function fail(code, extra = {}) {
  const error = new Error(code);
  Object.assign(error, extra);
  throw error;
}

function latestLocalHead(database, databaseInstanceId) {
  const genesis = metadata(database);
  const marker = database.prepare(`
SELECT * FROM autonomous_research_online_mutation_authority_marker
WHERE database_instance_id=?
ORDER BY database_sequence DESC
LIMIT 1;
`).get(databaseInstanceId);
  return Object.freeze(marker ? {
    sequence: Number(marker.database_sequence),
    hash: marker.database_hash,
    schemaHash: marker.schema_hash,
    stateHash: marker.post_state_hash,
  } : {
    sequence: Number(genesis.genesis_database_sequence),
    hash: genesis.genesis_database_hash,
    schemaHash: genesis.schema_hash,
    stateHash: genesis.genesis_state_hash,
  });
}

function systemTableCounts(database) {
  return Object.freeze(Object.fromEntries(SYSTEM_TABLES.map((table) => [
    table,
    Number(database.prepare(`SELECT count(*) AS count FROM ${table};`).get().count),
  ])));
}

function pendingFinalizationCount(database) {
  return Number(database.prepare(`
SELECT count(*) AS count
FROM autonomous_research_online_mutation_authority_marker marker
LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized
  ON finalized.reservation_id=marker.reservation_id
WHERE finalized.reservation_id IS NULL;
`).get().count);
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function currentHeadRequest(trust, requestedAt) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationCurrentHeadRequest',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    scopeId: trust.scopeId,
    databaseScopeHash: trust.databaseScopeHash,
    writerManifestHash: trust.writerManifestHash,
    nonce: `head:${crypto.randomUUID()}`,
    requestedAt,
  });
}

function matchingAuthorityDatabaseHead(receipt, input, localHead) {
  const rows = (receipt?.databaseHeads || []).filter((head) => (
    head.databaseRole === input.databaseRole
    && head.databaseInstanceId === input.databaseInstanceId
  ));
  if (rows.length !== 1) fail('externally_fenced_sqlite_mutation_authority_head_missing');
  const head = rows[0];
  if (head.sequence !== localHead.sequence
    || head.hash !== localHead.hash
    || head.schemaHash !== localHead.schemaHash
    || head.stateHash !== localHead.stateHash) {
    fail('externally_fenced_sqlite_mutation_local_authority_head_mismatch');
  }
  return head;
}

function reserveRequest({
  input,
  trust,
  authorityHead,
  databaseHead,
  schemaHash,
  changeset,
  requestedAt,
  requestedLeaseMs,
  mutationAttemptId,
}) {
  const changesetBase64 = changeset.toString('base64');
  const changesetHash = hashBytes(changeset);
  const postStateHash = autonomousResearchOnlineMutationStateHash({
    databaseRole: input.databaseRole,
    databaseInstanceId: input.databaseInstanceId,
    writerId: input.writerId,
    operationId: input.operationId,
    schemaHash,
    previousStateHash: databaseHead.stateHash,
    changesetHash,
    databaseSequence: databaseHead.sequence + 1,
    authorizationReceiptHashes: input.authorizationReceiptHashes,
    sideEffectReservationHashes: input.sideEffectReservationHashes,
  });
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationReserveRequest',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    scopeId: trust.scopeId,
    databaseScopeHash: trust.databaseScopeHash,
    writerManifestHash: trust.writerManifestHash,
    databaseRole: input.databaseRole,
    databaseInstanceId: input.databaseInstanceId,
    writerId: input.writerId,
    operationId: input.operationId,
    codeProvenanceHash: input.codeProvenanceHash,
    mutationAttemptId,
    globalPreviousSequence: authorityHead.globalSequence,
    globalPreviousHash: authorityHead.globalHash,
    databasePreviousSequence: databaseHead.sequence,
    databasePreviousHash: databaseHead.hash,
    schemaContractId: input.schemaContractId,
    schemaHash,
    preStateHash: databaseHead.stateHash,
    postStateHash,
    changesetEncoding: 'base64',
    changesetBase64,
    changesetByteLength: changeset.length,
    changesetHash,
    authorizationReceiptHashes: input.authorizationReceiptHashes,
    sideEffectReservationHashes: input.sideEffectReservationHashes,
    requestedAt,
    requestedLeaseMs,
  });
}

function abortRequest(reservation, reason, requestedAt) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAbortRequest',
    protocol: reservation.protocol,
    scopeId: reservation.scopeId,
    databaseScopeHash: reservation.databaseScopeHash,
    writerManifestHash: reservation.writerManifestHash,
    reservationId: reservation.reservationId,
    reservationReceiptHash: autonomousResearchOnlineMutationReceiptHash(reservation),
    databaseRole: reservation.databaseRole,
    databaseInstanceId: reservation.databaseInstanceId,
    writerId: reservation.writerId,
    operationId: reservation.operationId,
    mutationAttemptId: reservation.mutationAttemptId,
    globalSequence: reservation.globalSequence,
    globalHash: reservation.globalHash,
    databaseSequence: reservation.databaseSequence,
    databaseHash: reservation.databaseHash,
    changesetHash: reservation.changesetHash,
    reason,
    requestedAt,
  });
}

function resolutionRequest(reserveRequest, requestedAt) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationResolutionRequest',
    protocol: reserveRequest.protocol,
    scopeId: reserveRequest.scopeId,
    databaseScopeHash: reserveRequest.databaseScopeHash,
    writerManifestHash: reserveRequest.writerManifestHash,
    mutationAttemptId: reserveRequest.mutationAttemptId,
    reserveRequestHash: hashRecord(
      'AutonomousResearchOnlineMutationReserveRequest', reserveRequest,
    ),
    requestedAt,
  });
}

function insertMarker(database, reservation, request, reserveRequest) {
  database.prepare(`
INSERT INTO autonomous_research_online_mutation_authority_marker(
  reservation_id,database_role,database_instance_id,writer_id,operation_id,
  global_sequence,global_hash,database_sequence,database_hash,schema_hash,
  pre_state_hash,post_state_hash,changeset_hash,reserve_request_hash,
  reserve_request_json,reservation_receipt_hash,reservation_receipt_json,
  local_marker_hash,committed_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);
`).run(
    reservation.reservationId,
    reservation.databaseRole,
    reservation.databaseInstanceId,
    reservation.writerId,
    reservation.operationId,
    reservation.globalSequence,
    reservation.globalHash,
    reservation.databaseSequence,
    reservation.databaseHash,
    reservation.schemaHash,
    reservation.preStateHash,
    reservation.postStateHash,
    reservation.changesetHash,
    hashRecord('AutonomousResearchOnlineMutationReserveRequest', reserveRequest),
    JSON.stringify(reserveRequest),
    autonomousResearchOnlineMutationReceiptHash(reservation),
    JSON.stringify(reservation),
    request.localMarkerHash,
    request.committedAt,
  );
}

export function createExternallyFencedSqliteMutationCoordinator({
  authorityClient,
  authorityTrust = authorityClient?.trust,
  manifest,
  operationPlans = {},
  databaseInstances,
  requestedLeaseMs = Math.min(60_000, authorityTrust?.maximumReservationLeaseMs || 0),
  commitSafetyMarginMs = 1_000,
  recoverabilityEpochFence = null,
  clock = { now: () => new Date() },
} = {}) {
  const { checkedManifest, checkedPlans } =
    validateExternallyFencedSqliteMutationCoordinatorFactory({
    authorityClient,
    authorityTrust,
    manifest,
    databaseInstances,
    operationPlans,
    recoverabilityEpochFence,
  });
  if (!Number.isSafeInteger(commitSafetyMarginMs)
    || commitSafetyMarginMs < 100 || commitSafetyMarginMs >= requestedLeaseMs) {
    fail('externally_fenced_sqlite_mutation_commit_safety_margin_invalid');
  }
  const coveredDatabaseRoles = Object.freeze([
    ...checkedManifest.coverage.coveredDatabaseRoles,
  ]);

  function controlOutcome(code, input, extra = {}, {
    reconciliationRequired = true,
  } = {}) {
    if (recoverabilityEpochFence && reconciliationRequired) {
      recoverabilityEpochFence.markMutationReconciliationRequired({
        reason: code,
        databaseRole: input?.databaseRole,
        databaseInstanceId: input?.databaseInstanceId,
        reservationId: extra.reservationId || null,
        mutationAttemptId: extra.mutationAttemptId || null,
        committed: extra.committed ?? false,
      });
    }
    const error = new Error(code);
    Object.assign(error, extra);
    if (recoverabilityEpochFence) {
      error.stateRecoverabilityDeferred = true;
      error.retryable = true;
    }
    throw error;
  }

  function executeMutation(input) {
    const { writer, plan } = validateExternallyFencedSqliteMutationInput(
      input,
      checkedManifest,
      authorityTrust,
      checkedPlans,
    );
    if (input.database.isTransaction) fail('externally_fenced_sqlite_mutation_nested_forbidden');
    const meta = metadata(input.database);
    const schemaHash = exactSchemaHash(input.database);
    if (meta.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
      || meta.database_role !== input.databaseRole
      || meta.database_instance_id !== input.databaseInstanceId
      || meta.schema_contract_id !== input.schemaContractId
      || meta.schema_hash !== schemaHash
      || meta.database_scope_hash !== authorityTrust.databaseScopeHash
      || meta.writer_manifest_hash !== authorityTrust.writerManifestHash) {
      fail('externally_fenced_sqlite_mutation_metadata_mismatch');
    }
    const pendingFinalizations = pendingFinalizationCount(input.database);
    if (pendingFinalizations !== 0) {
      let recovery;
      try {
        recovery = recoverExternallyFencedSqliteMutations({
          database: input.database,
          authorityClient,
          authorityTrust,
          clock,
        });
      } catch (error) {
        if (error?.stateRecoverabilityFatal === true) throw error;
        controlOutcome('externally_fenced_sqlite_mutation_pending_recovery_failed', input, {
          pendingFinalizationCount: pendingFinalizations,
          cause: error,
        });
      }
      const recoveredReservationIds = Object.freeze([
        ...(recovery?.recoveredReservationIds || []),
      ]);
      for (const head of recovery?.finalizedHeads || []) {
        recoverabilityEpochFence?.markMutationFinalized({
          globalSequence: head.globalSequence,
          globalHash: head.globalHash,
        });
      }
      if (pendingFinalizationCount(input.database) !== 0) {
        controlOutcome('externally_fenced_sqlite_mutation_pending_recovery_incomplete', input, {
          pendingFinalizationCount: pendingFinalizations,
          recoveredReservationIds,
        });
      }
      controlOutcome(
        'externally_fenced_sqlite_mutation_pending_recovery_completed_retry_required',
        input,
        {
          recoveredReservationIds,
        },
        { reconciliationRequired: false },
      );
    }
    assertExternallyFencedSqliteMutationDatabaseSurface(input.database, plan);
    const requestedAt = observedNow(clock).toISOString();
    const headRequest = currentHeadRequest(authorityTrust, requestedAt);
    const authorityHead = authorityClient.observeCurrentHead({
      request: headRequest,
      now: observedNow(clock),
      expectedDatabaseInstances: databaseInstances,
    });
    const localHead = latestLocalHead(input.database, input.databaseInstanceId);
    const databaseHead = matchingAuthorityDatabaseHead(authorityHead, input, localHead);
    const systemCountsBefore = systemTableCounts(input.database);
    let session = null;
    let began = false;
    let committed = false;
    let commitAttempted = false;
    let reservation = null;
    let abortReason = 'local-apply-failed';
    let transaction = null;
    let value;
    try {
      input.database.exec('BEGIN IMMEDIATE;');
      began = true;
      if (!sameRecord(localHead, latestLocalHead(
        input.database,
        input.databaseInstanceId,
      ))) fail('externally_fenced_sqlite_mutation_local_head_changed');
      session = input.database.createSession();
      transaction = createExternallyFencedSqliteMutationTransaction(input.database, plan);
      try { value = input.mutate(transaction.transaction); }
      finally { transaction.revoke(); }
      if (value && typeof value.then === 'function') {
        fail('externally_fenced_sqlite_mutation_async_callback_forbidden');
      }
      if (!input.database.isTransaction) {
        fail('externally_fenced_sqlite_mutation_transaction_boundary_escaped');
      }
      const afterSchemaHash = exactSchemaHash(input.database);
      if (afterSchemaHash !== schemaHash) {
        fail('externally_fenced_sqlite_mutation_ddl_forbidden');
      }
      if (!sameRecord(systemCountsBefore, systemTableCounts(input.database))) {
        fail('externally_fenced_sqlite_mutation_system_table_write_forbidden');
      }
      const changeset = Buffer.from(session.changeset());
      if (changeset.length === 0) {
        input.database.exec('ROLLBACK;');
        began = false;
        return Object.freeze({
          version: 1,
          kind: 'ExternallyFencedSqliteMutationReceipt',
          status: 'externally_fenced_sqlite_mutation_no_change',
          value,
          sideEffectPermitHash: null,
        });
      }
      const request = reserveRequest({
        input: Object.freeze({
          ...input,
          codeProvenanceHash: writer.implementationHash,
        }),
        trust: authorityTrust,
        authorityHead,
        databaseHead,
        schemaHash,
        changeset,
        requestedAt: observedNow(clock).toISOString(),
        requestedLeaseMs,
        mutationAttemptId: `mutation:${crypto.randomUUID()}`,
      });
      assertAutonomousResearchOnlineMutationReserveRequest(request, {
        trust: authorityTrust,
        hashChangesetBase64: (candidate) => hashBytes(Buffer.from(candidate, 'base64')),
      });
      try {
        reservation = authorityClient.reserveMutation({
          request,
          now: observedNow(clock),
        });
      } catch (reserveError) {
        try {
          reservation = authorityClient.resolveMutationAttempt({
            request: resolutionRequest(request, observedNow(clock).toISOString()),
            reserveRequest: request,
            now: observedNow(clock),
          });
        } catch (resolutionError) {
          controlOutcome(
            'externally_fenced_sqlite_mutation_reservation_resolution_pending',
            input,
            {
              mutationAttemptId: request.mutationAttemptId,
              cause: reserveError,
              resolutionCause: resolutionError,
            },
          );
        }
        if (!reservation) {
          fail('externally_fenced_sqlite_mutation_reservation_not_applied', {
            mutationAttemptId: request.mutationAttemptId,
            cause: reserveError,
          });
        }
      }
      const commitObservedAt = observedNow(clock);
      const reservationExpiresAt = Date.parse(String(reservation.expiresAt || ''));
      if (!Number.isFinite(reservationExpiresAt)
        || reservationExpiresAt - commitObservedAt.getTime() < commitSafetyMarginMs) {
        fail('externally_fenced_sqlite_mutation_reservation_expiring');
      }
      const committedAt = commitObservedAt.toISOString();
      const finalRequest = buildExternallyFencedSqliteMutationFinalizeRequest(
        reservation,
        committedAt,
      );
      abortReason = 'local-marker-failed';
      insertMarker(input.database, reservation, finalRequest, request);
      abortReason = 'local-commit-failed';
      if (reservationExpiresAt - observedNow(clock).getTime() < commitSafetyMarginMs) {
        fail('externally_fenced_sqlite_mutation_reservation_expiring');
      }
      commitAttempted = true;
      try { input.database.exec('COMMIT;'); }
      catch (error) {
        controlOutcome('externally_fenced_sqlite_mutation_commit_outcome_unknown', input, {
          committed: 'unknown',
          reservationId: reservation.reservationId,
          mutationAttemptId: request.mutationAttemptId,
          cause: error,
        });
      }
      began = false;
      committed = true;
      let finalization;
      try {
        finalization = authorityClient.finalizeMutation({
          request: finalRequest,
          reservation,
          now: observedNow(clock),
        });
      } catch (error) {
        controlOutcome(
          'externally_fenced_sqlite_mutation_committed_finalization_pending',
          input,
          {
            committed: true,
            reservationId: reservation.reservationId,
            mutationAttemptId: request.mutationAttemptId,
            cause: error,
          },
        );
      }
      try {
        recordExternallyFencedSqliteMutationFinalization(
          input.database,
          finalization,
          observedNow(clock).toISOString(),
        );
      } catch (error) {
        controlOutcome(
          'externally_fenced_sqlite_mutation_committed_finalization_record_pending',
          input,
          {
            committed: true,
            reservationId: reservation.reservationId,
            mutationAttemptId: request.mutationAttemptId,
            cause: error,
          },
        );
      }
      if (recoverabilityEpochFence) {
        try {
          recoverabilityEpochFence.markMutationFinalized({
            globalSequence: finalization.globalSequence,
            globalHash: finalization.globalHash,
          });
        } catch (error) {
          error.committed = true;
          error.reservationId = reservation.reservationId;
          throw error;
        }
      }
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationReceipt',
        status: 'externally_fenced_sqlite_mutation_finalized',
        value,
        reservationId: reservation.reservationId,
        reservationReceiptHash: autonomousResearchOnlineMutationReceiptHash(reservation),
        finalizationReceiptHash: autonomousResearchOnlineMutationReceiptHash(finalization),
        sideEffectPermitHash: finalization.sideEffectPermitHash,
      });
    } catch (error) {
      if (began && input.database.isTransaction) {
        try { input.database.exec('ROLLBACK;'); } catch { /* preserve original failure */ }
      }
      if (reservation && !committed && !commitAttempted) {
        try {
          const request = abortRequest(
            reservation,
            abortReason,
            observedNow(clock).toISOString(),
          );
          authorityClient.abortMutation({
            request,
            reservation,
            now: observedNow(clock),
          });
        } catch (abortError) {
          controlOutcome('externally_fenced_sqlite_mutation_reservation_abort_pending', input, {
            committed: false,
            reservationId: reservation.reservationId,
            mutationAttemptId: reservation.mutationAttemptId || null,
            cause: error,
            abortCause: abortError,
          });
        }
      }
      throw error;
    } finally {
      try { session?.close(); } catch { /* database remains fail-closed on later use */ }
    }
  }

  function recoverPendingMutations({ database } = {}) {
    const recovery = recoverExternallyFencedSqliteMutations({
      database,
      authorityClient,
      authorityTrust,
      clock,
    });
    for (const head of recovery.finalizedHeads || []) {
      recoverabilityEpochFence?.markMutationFinalized({
        globalSequence: head.globalSequence,
        globalHash: head.globalHash,
      });
    }
    return recovery;
  }

  return assertExternallyFencedSqliteMutationCoordinatorPort(Object.freeze({
    implemented: true,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    coveredDatabaseRoles,
    executeMutation,
    recoverPendingMutations,
    inspectStatus() {
      const complete = checkedManifest.coverage.percent === 100;
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationCoordinatorStatus',
        status: complete
          ? 'externally_fenced_sqlite_mutation_coordinator_configured'
          : 'externally_fenced_sqlite_mutation_coordinator_partial',
        implemented: true,
        coveredDatabaseRoles,
        blockers: Object.freeze([
          ...(complete ? [] : [
            'autonomous_research_online_writer_manifest_100_percent_required',
          ]),
          'autonomous_research_online_mutation_runtime_activation_required',
        ]),
      });
    },
  }));
}

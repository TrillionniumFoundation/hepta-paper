import crypto from 'node:crypto';

import {
  assertAutonomousResearchOnlineMutationAbortRequest,
  assertAutonomousResearchOnlineMutationResolutionRequest,
} from '../../paper-domain/automation/autonomous-research-online-mutation-recovery-contract.mjs';
import {
  assertAutonomousResearchOnlineMutationFinalizeRequest,
  assertAutonomousResearchOnlineMutationReserveRequest,
  assertAutonomousResearchOnlineMutationScopeRequest,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  assertAutonomousResearchOnlineUnresolvedReservationListRequest,
  autonomousResearchOnlineUnresolvedReservationSetHash,
} from '../../paper-domain/automation/autonomous-research-online-unresolved-reservation-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  failLocalStateAuthority,
  LOCAL_STATE_AUTHORITY_SAFE_ID,
  LOCAL_STATE_AUTHORITY_SHA256,
  localStateAuthorityExpiry,
  localStateAuthorityNow,
  localStateAuthorityTimestamp,
  parseLocalStateAuthorityRecord,
  readLocalStateAuthorityDatabaseHeads,
  readLocalStateAuthorityMetadata,
  runLocalStateAuthorityTransaction,
} from './local-autonomous-research-state-authority-support.mjs';

const HEAD_REQUEST_KEYS = Object.freeze([
  'version', 'kind', 'protocol', 'scopeId', 'databaseScopeHash',
  'writerManifestHash', 'nonce', 'requestedAt',
]);
const CHALLENGE_REQUEST_KEYS = Object.freeze([
  'version', 'kind', 'protocol', 'scopeId', 'databaseScopeHash',
  'writerManifestHash', 'challengeNonce', 'requestedAt',
]);

function exactAuthorityRequest(request, keys, kind, configuration) {
  if (!hasExactObjectKeys(request, keys)
    || request.version !== 1
    || request.kind !== kind
    || request.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
    || request.scopeId !== configuration.scopeId
    || request.databaseScopeHash !== configuration.databaseScopeHash
    || request.writerManifestHash !== configuration.writerManifestHash
    || localStateAuthorityTimestamp(request.requestedAt) === null) {
    failLocalStateAuthority('local_state_authority_request_invalid');
  }
  return request;
}

export function createLocalAutonomousResearchStateAuthorityMutationHandlers({
  database,
  configuration,
  clock,
  trust,
  signOnline,
} = {}) {
  function reserveMutation(request) {
    assertAutonomousResearchOnlineMutationReserveRequest(request, {
      trust,
      hashChangesetBase64: (value) => hashBytes(Buffer.from(value, 'base64')),
    });
    return runLocalStateAuthorityTransaction(database, () => {
      const existing = database.prepare(`
SELECT * FROM authority_mutation WHERE mutation_attempt_id=?;
`).get(request.mutationAttemptId);
      if (existing) {
        const storedRequest = parseLocalStateAuthorityRecord(
          existing.reserve_request_json,
          'local_state_authority_mutation_state_invalid',
        );
        if (existing.status !== 'reserved'
          || JSON.stringify(storedRequest) !== JSON.stringify(request)) {
          failLocalStateAuthority('local_state_authority_mutation_attempt_conflict');
        }
        return Object.freeze(parseLocalStateAuthorityRecord(
          existing.reservation_receipt_json,
          'local_state_authority_mutation_state_invalid',
        ));
      }
      const current = readLocalStateAuthorityMetadata(database);
      if (current.schema_transition_state !== 'finalized'
        || database.prepare(`
SELECT count(*) AS count FROM authority_mutation WHERE status='reserved';
`).get().count !== 0
        || request.globalPreviousSequence !== Number(current.global_sequence)
        || request.globalPreviousHash !== current.global_hash) {
        failLocalStateAuthority('local_state_authority_global_head_conflict');
      }
      const head = database.prepare(`
SELECT * FROM authority_database_head WHERE database_instance_id=?;
`).get(request.databaseInstanceId);
      if (!head
        || head.database_role !== request.databaseRole
        || Number(head.sequence) !== request.databasePreviousSequence
        || head.hash !== request.databasePreviousHash
        || head.schema_hash !== request.schemaHash
        || head.state_hash !== request.preStateHash) {
        failLocalStateAuthority('local_state_authority_database_head_conflict');
      }
      const requestHash = hashRecord(
        'AutonomousResearchOnlineMutationReserveRequest',
        request,
      );
      const globalSequence = Number(current.global_sequence) + 1;
      const databaseSequence = Number(head.sequence) + 1;
      const issuedAt = localStateAuthorityNow(clock);
      const receipt = signOnline({
        version: 1,
        kind: 'AutonomousResearchOnlineMutationReservationReceipt',
        status: 'autonomous_research_online_mutation_reserved',
        authorityId: configuration.authorityId,
        keyId: configuration.keyId,
        requestHash,
        reservationId: `mutation:${crypto.randomUUID()}`,
        protocol: request.protocol,
        scopeId: request.scopeId,
        databaseScopeHash: request.databaseScopeHash,
        writerManifestHash: request.writerManifestHash,
        databaseRole: request.databaseRole,
        databaseInstanceId: request.databaseInstanceId,
        writerId: request.writerId,
        operationId: request.operationId,
        codeProvenanceHash: request.codeProvenanceHash,
        mutationAttemptId: request.mutationAttemptId,
        globalPreviousSequence: request.globalPreviousSequence,
        globalPreviousHash: request.globalPreviousHash,
        globalSequence,
        globalHash: hashRecord('HeptaLocalStateAuthorityGlobalHead', {
          previousSequence: request.globalPreviousSequence,
          previousHash: request.globalPreviousHash,
          requestHash,
          globalSequence,
        }),
        databasePreviousSequence: request.databasePreviousSequence,
        databasePreviousHash: request.databasePreviousHash,
        databaseSequence,
        databaseHash: hashRecord('HeptaLocalStateAuthorityDatabaseHead', {
          databaseInstanceId: request.databaseInstanceId,
          previousSequence: request.databasePreviousSequence,
          previousHash: request.databasePreviousHash,
          requestHash,
          databaseSequence,
        }),
        schemaContractId: request.schemaContractId,
        schemaHash: request.schemaHash,
        preStateHash: request.preStateHash,
        postStateHash: request.postStateHash,
        changesetEncoding: request.changesetEncoding,
        changesetBase64: request.changesetBase64,
        changesetByteLength: request.changesetByteLength,
        changesetHash: request.changesetHash,
        authorizationReceiptHashes: request.authorizationReceiptHashes,
        sideEffectReservationHashes: request.sideEffectReservationHashes,
        issuedAt,
        expiresAt: localStateAuthorityExpiry(issuedAt, request.requestedLeaseMs),
      });
      database.prepare(`
INSERT INTO authority_mutation(
  mutation_attempt_id,reservation_id,status,global_sequence,database_instance_id,
  reserve_request_json,reservation_receipt_json
) VALUES(?,?,'reserved',?,?,?,?);
`).run(
        request.mutationAttemptId,
        receipt.reservationId,
        receipt.globalSequence,
        request.databaseInstanceId,
        JSON.stringify(request),
        JSON.stringify(receipt),
      );
      return receipt;
    });
  }

  function finalizeMutation(request) {
    return runLocalStateAuthorityTransaction(database, () => {
      const row = database.prepare(`
SELECT * FROM authority_mutation WHERE reservation_id=?;
`).get(request.reservationId);
      if (!row) {
        failLocalStateAuthority('local_state_authority_mutation_reservation_required');
      }
      const reservation = parseLocalStateAuthorityRecord(
        row.reservation_receipt_json,
        'local_state_authority_mutation_state_invalid',
      );
      assertAutonomousResearchOnlineMutationFinalizeRequest(request, reservation);
      if (row.status === 'finalized') {
        const storedRequest = parseLocalStateAuthorityRecord(
          row.finalize_request_json,
          'local_state_authority_mutation_state_invalid',
        );
        if (JSON.stringify(storedRequest) !== JSON.stringify(request)) {
          failLocalStateAuthority('local_state_authority_mutation_finalization_conflict');
        }
        return Object.freeze(parseLocalStateAuthorityRecord(
          row.finalization_receipt_json,
          'local_state_authority_mutation_state_invalid',
        ));
      }
      if (row.status !== 'reserved') {
        failLocalStateAuthority('local_state_authority_mutation_not_reserved');
      }
      const finalizedAt = localStateAuthorityNow(clock);
      const receipt = signOnline({
        version: 1,
        kind: 'AutonomousResearchOnlineMutationFinalizationReceipt',
        status: 'autonomous_research_online_mutation_finalized',
        authorityId: configuration.authorityId,
        keyId: configuration.keyId,
        requestHash: hashRecord(
          'AutonomousResearchOnlineMutationFinalizeRequest',
          request,
        ),
        reservationId: request.reservationId,
        reservationReceiptHash: request.reservationReceiptHash,
        protocol: request.protocol,
        scopeId: request.scopeId,
        databaseScopeHash: request.databaseScopeHash,
        writerManifestHash: request.writerManifestHash,
        databaseRole: request.databaseRole,
        databaseInstanceId: request.databaseInstanceId,
        writerId: request.writerId,
        operationId: request.operationId,
        globalSequence: request.globalSequence,
        globalHash: request.globalHash,
        databaseSequence: request.databaseSequence,
        databaseHash: request.databaseHash,
        schemaHash: request.schemaHash,
        postStateHash: request.postStateHash,
        changesetHash: request.changesetHash,
        localMarkerHash: request.localMarkerHash,
        authorizationReceiptHashes: request.authorizationReceiptHashes,
        sideEffectReservationHashes: request.sideEffectReservationHashes,
        sideEffectPermitHash: hashRecord('HeptaLocalStateAuthoritySideEffectPermit', {
          reservationId: request.reservationId,
          localMarkerHash: request.localMarkerHash,
        }),
        finalizedAt,
      });
      database.prepare(`
UPDATE authority_metadata SET global_sequence=?,global_hash=? WHERE singleton=1;
`).run(request.globalSequence, request.globalHash);
      database.prepare(`
UPDATE authority_database_head
SET sequence=?,hash=?,schema_hash=?,state_hash=?
WHERE database_instance_id=?;
`).run(
        request.databaseSequence,
        request.databaseHash,
        request.schemaHash,
        request.postStateHash,
        request.databaseInstanceId,
      );
      database.prepare(`
UPDATE authority_mutation SET status='finalized',
  finalize_request_json=?,finalization_receipt_json=?
WHERE reservation_id=?;
`).run(JSON.stringify(request), JSON.stringify(receipt), request.reservationId);
      return receipt;
    });
  }

  function abortMutation(request) {
    return runLocalStateAuthorityTransaction(database, () => {
      const row = database.prepare(`
SELECT * FROM authority_mutation WHERE reservation_id=?;
`).get(request.reservationId);
      if (!row) {
        failLocalStateAuthority('local_state_authority_mutation_reservation_required');
      }
      const reservation = parseLocalStateAuthorityRecord(
        row.reservation_receipt_json,
        'local_state_authority_mutation_state_invalid',
      );
      assertAutonomousResearchOnlineMutationAbortRequest(request, reservation);
      if (row.status === 'aborted') {
        const storedRequest = parseLocalStateAuthorityRecord(
          row.abort_request_json,
          'local_state_authority_mutation_state_invalid',
        );
        if (JSON.stringify(storedRequest) !== JSON.stringify(request)) {
          failLocalStateAuthority('local_state_authority_mutation_abort_conflict');
        }
        return Object.freeze(parseLocalStateAuthorityRecord(
          row.abort_receipt_json,
          'local_state_authority_mutation_state_invalid',
        ));
      }
      if (row.status !== 'reserved') {
        failLocalStateAuthority('local_state_authority_mutation_not_reserved');
      }
      const receipt = signOnline({
        version: 1,
        kind: 'AutonomousResearchOnlineMutationAbortReceipt',
        status: 'autonomous_research_online_mutation_aborted',
        authorityId: configuration.authorityId,
        keyId: configuration.keyId,
        requestHash: hashRecord('AutonomousResearchOnlineMutationAbortRequest', request),
        protocol: request.protocol,
        scopeId: request.scopeId,
        databaseScopeHash: request.databaseScopeHash,
        writerManifestHash: request.writerManifestHash,
        reservationId: request.reservationId,
        reservationReceiptHash: request.reservationReceiptHash,
        databaseRole: request.databaseRole,
        databaseInstanceId: request.databaseInstanceId,
        writerId: request.writerId,
        operationId: request.operationId,
        mutationAttemptId: request.mutationAttemptId,
        globalSequence: request.globalSequence,
        globalHash: request.globalHash,
        databaseSequence: request.databaseSequence,
        databaseHash: request.databaseHash,
        changesetHash: request.changesetHash,
        reason: request.reason,
        requestedAt: request.requestedAt,
        abortedAt: localStateAuthorityNow(clock),
      });
      database.prepare(`
UPDATE authority_mutation SET status='aborted',abort_request_json=?,abort_receipt_json=?
WHERE reservation_id=?;
`).run(JSON.stringify(request), JSON.stringify(receipt), request.reservationId);
      return receipt;
    });
  }

  function resolveMutation(request) {
    const row = database.prepare(`
SELECT * FROM authority_mutation WHERE mutation_attempt_id=?;
`).get(request.mutationAttemptId);
    const reserveRequest = row
      ? parseLocalStateAuthorityRecord(
        row.reserve_request_json,
        'local_state_authority_mutation_state_invalid',
      ) : null;
    if (reserveRequest) {
      assertAutonomousResearchOnlineMutationResolutionRequest(request, reserveRequest);
    } else if (!hasExactObjectKeys(request, [
      'version', 'kind', 'protocol', 'scopeId', 'databaseScopeHash',
      'writerManifestHash', 'mutationAttemptId', 'reserveRequestHash', 'requestedAt',
    ])
      || request.version !== 1
      || request.kind !== 'AutonomousResearchOnlineMutationResolutionRequest'
      || request.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
      || request.scopeId !== configuration.scopeId
      || request.databaseScopeHash !== configuration.databaseScopeHash
      || request.writerManifestHash !== configuration.writerManifestHash
      || !LOCAL_STATE_AUTHORITY_SAFE_ID.test(String(request.mutationAttemptId || ''))
      || !LOCAL_STATE_AUTHORITY_SHA256.test(String(request.reserveRequestHash || ''))
      || localStateAuthorityTimestamp(request.requestedAt) === null) {
      failLocalStateAuthority('local_state_authority_resolution_request_invalid');
    }
    const reserved = row?.status === 'reserved';
    return signOnline({
      version: 1,
      kind: 'AutonomousResearchOnlineMutationResolutionReceipt',
      status: 'autonomous_research_online_mutation_resolution_observed',
      authorityId: configuration.authorityId,
      keyId: configuration.keyId,
      requestHash: hashRecord(
        'AutonomousResearchOnlineMutationResolutionRequest',
        request,
      ),
      protocol: request.protocol,
      scopeId: request.scopeId,
      databaseScopeHash: request.databaseScopeHash,
      writerManifestHash: request.writerManifestHash,
      mutationAttemptId: request.mutationAttemptId,
      reserveRequestHash: request.reserveRequestHash,
      requestedAt: request.requestedAt,
      resolution: reserved ? 'reserved' : 'not-found',
      reservation: reserved
        ? parseLocalStateAuthorityRecord(
          row.reservation_receipt_json,
          'local_state_authority_mutation_state_invalid',
        ) : null,
      observedAt: localStateAuthorityNow(clock),
    });
  }

  function listUnresolved(request) {
    assertAutonomousResearchOnlineUnresolvedReservationListRequest(request, trust);
    const rows = database.prepare(`
SELECT reserve_request_json,reservation_receipt_json
FROM authority_mutation
WHERE status='reserved' AND database_instance_id=?
ORDER BY mutation_attempt_id LIMIT 2;
`).all(request.databaseInstanceId);
    if (rows.length > 1) {
      failLocalStateAuthority('local_state_authority_multiple_unresolved_reservations');
    }
    const entries = rows.map((entry) => Object.freeze({
      reserveRequest: parseLocalStateAuthorityRecord(
        entry.reserve_request_json,
        'local_state_authority_mutation_state_invalid',
      ),
      reservation: parseLocalStateAuthorityRecord(
        entry.reservation_receipt_json,
        'local_state_authority_mutation_state_invalid',
      ),
    }));
    const observedAt = localStateAuthorityNow(clock);
    return signOnline({
      version: 1,
      kind: 'AutonomousResearchOnlineUnresolvedReservationListReceipt',
      status: 'autonomous_research_online_unresolved_reservations_observed',
      authorityId: configuration.authorityId,
      keyId: configuration.keyId,
      requestHash: hashRecord(
        'AutonomousResearchOnlineUnresolvedReservationListRequest',
        request,
      ),
      protocol: request.protocol,
      scopeId: request.scopeId,
      databaseScopeHash: request.databaseScopeHash,
      writerManifestHash: request.writerManifestHash,
      databaseRole: request.databaseRole,
      databaseInstanceId: request.databaseInstanceId,
      nonce: request.nonce,
      requestedAt: request.requestedAt,
      unresolvedReservationCount: entries.length,
      unresolvedReservationSetHash:
        autonomousResearchOnlineUnresolvedReservationSetHash(entries),
      unresolvedReservations: entries,
      observedAt,
      expiresAt: localStateAuthorityExpiry(
        observedAt,
        configuration.maximumObservationAgeMs,
      ),
    });
  }

  function observeCurrentHead(request) {
    exactAuthorityRequest(
      request,
      HEAD_REQUEST_KEYS,
      'AutonomousResearchOnlineMutationCurrentHeadRequest',
      configuration,
    );
    const current = readLocalStateAuthorityMetadata(database);
    const observedAt = localStateAuthorityNow(clock);
    return signOnline({
      version: 1,
      kind: 'AutonomousResearchOnlineMutationCurrentHeadReceipt',
      status: 'autonomous_research_online_mutation_current_head_observed',
      authorityId: configuration.authorityId,
      keyId: configuration.keyId,
      requestHash: hashRecord(
        'AutonomousResearchOnlineMutationCurrentHeadRequest',
        request,
      ),
      protocol: request.protocol,
      scopeId: request.scopeId,
      databaseScopeHash: request.databaseScopeHash,
      writerManifestHash: request.writerManifestHash,
      globalSequence: Number(current.global_sequence),
      globalHash: current.global_hash,
      databaseHeads: readLocalStateAuthorityDatabaseHeads(database),
      unresolvedReservationCount: Number(database.prepare(`
SELECT count(*) AS count FROM authority_mutation WHERE status='reserved';
`).get().count),
      observedAt,
      expiresAt: localStateAuthorityExpiry(
        observedAt,
        configuration.maximumObservationAgeMs,
      ),
    });
  }

  function challengeAuthority(request) {
    exactAuthorityRequest(
      request,
      CHALLENGE_REQUEST_KEYS,
      'AutonomousResearchOnlineMutationActiveChallengeRequest',
      configuration,
    );
    const current = readLocalStateAuthorityMetadata(database);
    const challengedAt = localStateAuthorityNow(clock);
    return signOnline({
      version: 1,
      kind: 'AutonomousResearchOnlineMutationActiveChallengeReceipt',
      status: 'autonomous_research_online_mutation_active_challenge_verified',
      authorityId: configuration.authorityId,
      keyId: configuration.keyId,
      requestHash: hashRecord(
        'AutonomousResearchOnlineMutationActiveChallengeRequest',
        request,
      ),
      protocol: request.protocol,
      scopeId: request.scopeId,
      databaseScopeHash: request.databaseScopeHash,
      writerManifestHash: request.writerManifestHash,
      globalSequence: Number(current.global_sequence),
      globalHash: current.global_hash,
      databaseHeads: readLocalStateAuthorityDatabaseHeads(database),
      challengeNonce: request.challengeNonce,
      challengedAt,
      expiresAt: localStateAuthorityExpiry(
        challengedAt,
        configuration.maximumObservationAgeMs,
      ),
    });
  }

  function observeScope(request) {
    assertAutonomousResearchOnlineMutationScopeRequest(request, trust);
    const current = readLocalStateAuthorityMetadata(database);
    const observedAt = localStateAuthorityNow(clock);
    return signOnline({
      version: 1,
      kind: 'AutonomousResearchOnlineMutationScopeReceipt',
      status: 'autonomous_research_online_mutation_scope_observed',
      authorityId: configuration.authorityId,
      keyId: configuration.keyId,
      requestHash: hashRecord('AutonomousResearchOnlineMutationScopeRequest', request),
      protocol: request.protocol,
      scopeId: request.scopeId,
      databaseScopeHash: request.databaseScopeHash,
      writerManifestHash: request.writerManifestHash,
      staticInspectionReceiptHash: request.staticInspectionReceiptHash,
      astGateReceiptHash: request.astGateReceiptHash,
      codeProvenanceHash: request.codeProvenanceHash,
      operationCount: request.operationCount,
      operationIds: request.operationIds,
      requiredDatabaseRoles: request.requiredDatabaseRoles,
      coveredDatabaseRoles: request.coveredDatabaseRoles,
      globalSequence: Number(current.global_sequence),
      globalHash: current.global_hash,
      observedAt,
      expiresAt: localStateAuthorityExpiry(
        observedAt,
        configuration.maximumObservationAgeMs,
      ),
    });
  }

  return Object.freeze({
    reserveMutation,
    finalizeMutation,
    abortMutation,
    resolveMutation,
    listUnresolved,
    observeCurrentHead,
    challengeAuthority,
    observeScope,
  });
}

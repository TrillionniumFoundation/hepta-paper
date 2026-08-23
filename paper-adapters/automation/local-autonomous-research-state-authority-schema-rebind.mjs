import crypto from 'node:crypto';

import {
  autonomousResearchOnlineMutationSignedPayload,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest,
  assertAutonomousResearchOnlineSchemaTransitionObserveRequest,
  buildAutonomousResearchPristineSchemaRebindGenesis,
  autonomousResearchOnlineSchemaTransitionReceiptHash,
  verifyAutonomousResearchOnlineSchemaTransitionFinalization,
  verifyAutonomousResearchOnlineSchemaTransitionReservation,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  failLocalStateAuthority as fail,
  localStateAuthorityExpiry as expiry,
  localStateAuthorityNow as isoNow,
  parseLocalStateAuthorityRecord as parseRecord,
  readLocalStateAuthorityDatabaseHeads as databaseHeads,
  readLocalStateAuthorityMetadata as metadata,
  runLocalStateAuthorityTransaction as transaction,
} from './local-autonomous-research-state-authority-support.mjs';

const REBIND_STATE_INVALID = 'local_state_authority_schema_rebind_state_invalid';

function onlineTrust(configuration) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
    authorityId: configuration.authorityId,
    keyId: configuration.keyId,
    scopeId: configuration.scopeId,
    databaseScopeHash: configuration.databaseScopeHash,
    writerManifestHash: configuration.writerManifestHash,
    maximumReservationLeaseMs: configuration.maximumReservationLeaseMs,
    maximumObservationAgeMs: configuration.maximumObservationAgeMs,
  });
}

function verifyReceiptSignature(privateKey, receipt) {
  try {
    return crypto.verify(
      null,
      Buffer.from(autonomousResearchOnlineMutationSignedPayload(receipt), 'utf8'),
      crypto.createPublicKey(privateKey),
      Buffer.from(String(receipt?.signature || ''), 'base64'),
    );
  } catch { return false; }
}

export function activateFinalizedLocalAutonomousResearchStateAuthoritySchemaRebind({
  database,
  configuration,
  configurationHash,
  privateKey,
}) {
  const current = metadata(database);
  if (current.configuration_hash === configurationHash) return Object.freeze({
    activated: false,
    schemaRebindFinalizationReceiptHash: null,
    schemaRebindTargetConfigurationHash: null,
  });
  const rows = database.prepare(`
SELECT * FROM authority_schema_rebind
WHERE finalization_receipt_json IS NOT NULL AND target_configuration_hash=?
ORDER BY transition_id;
`).all(configurationHash);
  if (rows.length !== 1 || current.schema_transition_state !== 'reserved') {
    fail('local_state_authority_persisted_identity_mismatch');
  }
  const row = rows[0];
  const request = parseRecord(row.reserve_request_json, REBIND_STATE_INVALID);
  const reservation = parseRecord(row.reservation_receipt_json, REBIND_STATE_INVALID);
  const finalizeRequest = parseRecord(row.finalize_request_json, REBIND_STATE_INVALID);
  const finalization = parseRecord(row.finalization_receipt_json, REBIND_STATE_INVALID);
  const targetTrust = onlineTrust(configuration);
  const verifySignature = (receipt) => verifyReceiptSignature(privateKey, receipt);
  if (request.transitionId !== row.transition_id
    || request.writerManifestHash !== configuration.writerManifestHash
    || request.databaseScopeHash !== configuration.databaseScopeHash
    || reservation.targetAuthorityConfigurationHash !== configurationHash
    || !verifyAutonomousResearchOnlineSchemaTransitionReservation({
      receipt: reservation,
      request,
      trust: targetTrust,
      now: new Date(reservation.issuedAt),
      verifySignature,
    })
    || !verifyAutonomousResearchOnlineSchemaTransitionFinalization({
      receipt: finalization,
      request: finalizeRequest,
      reservation,
      trust: targetTrust,
      now: new Date(finalization.finalizedAt),
      verifySignature,
    })) {
    fail('local_state_authority_schema_rebind_activation_invalid');
  }
  transaction(database, () => {
    const updateHead = database.prepare(`
UPDATE authority_database_head
SET database_role=?,sequence=?,hash=?,schema_hash=?,state_hash=?
WHERE database_instance_id=?;
`);
    for (const genesis of reservation.databaseGenesis) {
      const result = updateHead.run(
        genesis.databaseRole,
        genesis.databaseSequence,
        genesis.databaseHash,
        genesis.schemaHash,
        genesis.stateHash,
        genesis.databaseInstanceId,
      );
      if (Number(result.changes) !== 1) {
        fail('local_state_authority_schema_rebind_head_activation_invalid');
      }
    }
    database.prepare(`
UPDATE authority_metadata
SET configuration_hash=?,database_scope_hash=?,writer_manifest_hash=?,
    global_sequence=?,global_hash=?,schema_transition_state='finalized'
WHERE singleton=1;
`).run(
      configurationHash,
      configuration.databaseScopeHash,
      configuration.writerManifestHash,
      reservation.databaseGenesis[0].globalSequence,
      reservation.databaseGenesis[0].globalHash,
    );
  });
  return Object.freeze({
    activated: true,
    schemaRebindFinalizationReceiptHash:
      autonomousResearchOnlineSchemaTransitionReceiptHash(finalization),
    schemaRebindTargetConfigurationHash: configurationHash,
  });
}

export function createLocalAutonomousResearchStateAuthoritySchemaRebindHandlers({
  database,
  configuration,
  clock,
  signOnline,
  trust,
}) {
  function reserve(request) {
    return transaction(database, () => {
      const existing = database.prepare(`
SELECT * FROM authority_schema_rebind WHERE transition_id=?;
`).get(request.transitionId);
      if (existing) {
        const storedRequest = parseRecord(existing.reserve_request_json, REBIND_STATE_INVALID);
        if (JSON.stringify(storedRequest) !== JSON.stringify(request)) {
          fail('local_state_authority_schema_rebind_conflict');
        }
        const storedReceipt = parseRecord(
          existing.reservation_receipt_json,
          REBIND_STATE_INVALID,
        );
        const renewalAt = isoNow(clock);
        if (existing.finalization_receipt_json
          || Date.parse(storedReceipt.expiresAt) > Date.parse(renewalAt)) {
          return Object.freeze(storedReceipt);
        }
        const current = metadata(database);
        if (current.schema_transition_state !== 'reserved'
          || Number(current.global_sequence) !== storedReceipt.previousGlobalSequence
          || current.global_hash !== storedReceipt.previousGlobalHash
          || current.writer_manifest_hash !== storedReceipt.sourceWriterManifestHash
          || JSON.stringify(databaseHeads(database))
            !== JSON.stringify(storedReceipt.previousDatabaseHeads)
          || database.prepare('SELECT count(*) AS count FROM authority_mutation;')
            .get().count !== 0
          || database.prepare(`SELECT count(*) AS count FROM authority_backup_reservation
            WHERE finalization_receipt_json IS NULL;`).get().count !== 0) {
          fail('local_state_authority_schema_rebind_recovery_preimage_changed');
        }
        const { signature: _discarded, ...renewedPayload } = storedReceipt;
        const renewed = signOnline({
          ...renewedPayload,
          reservationId: `schema-rebind-recovery:${crypto.randomUUID()}`,
          issuedAt: renewalAt,
          expiresAt: expiry(renewalAt, request.requestedLeaseMs),
        });
        database.prepare(`
UPDATE authority_schema_rebind SET reservation_receipt_json=? WHERE transition_id=?;
`).run(JSON.stringify(renewed), request.transitionId);
        return renewed;
      }
      const current = metadata(database);
      const previousDatabaseHeads = databaseHeads(database);
      const initialTransition = database.prepare(`
SELECT finalization_receipt_json FROM authority_schema_transition WHERE singleton=1;
`).get();
      const requestById = new Map(request.instances.map((instance) => [
        instance.databaseInstanceId,
        instance,
      ]));
      if (current.schema_transition_state !== 'finalized'
        || Number(current.global_sequence) !== 0
        || current.writer_manifest_hash !== request.sourceWriterManifestHash
        || current.database_scope_hash !== request.databaseScopeHash
        || previousDatabaseHeads.length !== request.instances.length
        || previousDatabaseHeads.some((head) => (
          head.sequence !== 0
          || head.databaseRole !== requestById.get(head.databaseInstanceId)?.databaseRole
          || head.schemaHash !== requestById.get(head.databaseInstanceId)?.preSchemaHash
        ))
        || database.prepare('SELECT count(*) AS count FROM authority_mutation;')
          .get().count !== 0
        || database.prepare(`SELECT count(*) AS count FROM authority_backup_reservation
          WHERE finalization_receipt_json IS NULL;`).get().count !== 0
        || !initialTransition?.finalization_receipt_json) {
        fail('local_state_authority_pristine_schema_rebind_precondition_failed');
      }
      const databaseGenesis = buildAutonomousResearchPristineSchemaRebindGenesis({
        request,
        previousGlobalHash: current.global_hash,
        previousDatabaseHeads,
      });
      const targetAuthorityConfigurationHash = hashRecord(
        'HeptaLocalAutonomousResearchStateAuthorityConfiguration',
        Object.freeze({
          ...configuration,
          databaseScopeHash: request.databaseScopeHash,
          writerManifestHash: request.writerManifestHash,
        }),
      );
      const issuedAt = isoNow(clock);
      const receipt = signOnline({
        version: 2,
        kind: 'AutonomousResearchOnlineSchemaTransitionReservationReceipt',
        status: 'autonomous_research_online_schema_transition_reserved',
        authorityId: configuration.authorityId,
        keyId: configuration.keyId,
        requestHash: hashRecord(
          'AutonomousResearchOnlineSchemaTransitionReserveRequest',
          request,
        ),
        reservationId: `schema-rebind:${crypto.randomUUID()}`,
        protocol: request.protocol,
        scopeId: request.scopeId,
        databaseScopeHash: request.databaseScopeHash,
        writerManifestHash: request.writerManifestHash,
        stateDatabaseManifestHash: request.stateDatabaseManifestHash,
        transitionInventoryHash: request.transitionInventoryHash,
        schemaBundleHash: request.schemaBundleHash,
        authorityJournalSchemaContractId: request.authorityJournalSchemaContractId,
        authorityJournalSchemaHash: request.authorityJournalSchemaHash,
        markerSchemaHash: request.markerSchemaHash,
        transitionId: request.transitionId,
        instances: request.instances,
        databaseGenesis,
        transitionMode: request.transitionMode,
        sourceWriterManifestHash: request.sourceWriterManifestHash,
        prePristineRuntimeStateHash: request.prePristineRuntimeStateHash,
        previousGlobalSequence: 0,
        previousGlobalHash: current.global_hash,
        previousDatabaseHeads,
        targetAuthorityConfigurationHash,
        authorityRestartRequired: true,
        issuedAt,
        expiresAt: expiry(issuedAt, request.requestedLeaseMs),
        allRegisteredMutationsFenced: true,
        quiescenceMode: 'pristine-scope-held-through-target-configuration-restart',
      });
      database.prepare(`
INSERT INTO authority_schema_rebind(
  transition_id,reserve_request_json,reservation_receipt_json,target_configuration_hash
) VALUES(?,?,?,?);
`).run(
        request.transitionId,
        JSON.stringify(request),
        JSON.stringify(receipt),
        targetAuthorityConfigurationHash,
      );
      database.prepare(`
UPDATE authority_metadata SET schema_transition_state='reserved' WHERE singleton=1;
`).run();
      return receipt;
    });
  }

  function finalize(request) {
    return transaction(database, () => {
      const row = database.prepare(`
SELECT * FROM authority_schema_rebind WHERE transition_id=?;
`).get(request.transitionId);
      if (!row) fail('local_state_authority_schema_rebind_reservation_required');
      const reservation = parseRecord(row.reservation_receipt_json, REBIND_STATE_INVALID);
      assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest(request, reservation);
      if (row.finalization_receipt_json) {
        const storedRequest = parseRecord(row.finalize_request_json, REBIND_STATE_INVALID);
        if (JSON.stringify(storedRequest) !== JSON.stringify(request)) {
          fail('local_state_authority_schema_rebind_finalization_conflict');
        }
        return Object.freeze(parseRecord(row.finalization_receipt_json, REBIND_STATE_INVALID));
      }
      const current = metadata(database);
      if (current.schema_transition_state !== 'reserved'
        || Number(current.global_sequence) !== reservation.previousGlobalSequence
        || current.global_hash !== reservation.previousGlobalHash
        || current.writer_manifest_hash !== reservation.sourceWriterManifestHash
        || JSON.stringify(databaseHeads(database))
          !== JSON.stringify(reservation.previousDatabaseHeads)
        || database.prepare('SELECT count(*) AS count FROM authority_mutation;')
          .get().count !== 0) {
        fail('local_state_authority_schema_rebind_finalize_preimage_changed');
      }
      const finalizedAt = isoNow(clock);
      if (Date.parse(finalizedAt) >= Date.parse(reservation.expiresAt)) {
        fail('local_state_authority_schema_rebind_reservation_expired');
      }
      const receipt = signOnline({
        version: 2,
        kind: 'AutonomousResearchOnlineSchemaTransitionFinalizationReceipt',
        status: 'autonomous_research_online_schema_transition_finalized',
        authorityId: configuration.authorityId,
        keyId: configuration.keyId,
        requestHash: hashRecord(
          'AutonomousResearchOnlineSchemaTransitionFinalizeRequest',
          request,
        ),
        protocol: request.protocol,
        scopeId: request.scopeId,
        databaseScopeHash: request.databaseScopeHash,
        writerManifestHash: request.writerManifestHash,
        transitionId: request.transitionId,
        transitionInventoryHash: request.transitionInventoryHash,
        schemaBundleHash: request.schemaBundleHash,
        reservationId: request.reservationId,
        reservationReceiptHash: request.reservationReceiptHash,
        postInventoryHash: request.postInventoryHash,
        postPristineRuntimeStateHash: request.postPristineRuntimeStateHash,
        installations: request.installations,
        globalSequence: reservation.databaseGenesis[0].globalSequence,
        globalHash: reservation.databaseGenesis[0].globalHash,
        transitionMode: reservation.transitionMode,
        sourceWriterManifestHash: reservation.sourceWriterManifestHash,
        targetAuthorityConfigurationHash: reservation.targetAuthorityConfigurationHash,
        authorityRestartRequired: true,
        finalizedAt,
        allRegisteredMutationsFencedThroughFinalize: true,
      });
      database.prepare(`
UPDATE authority_schema_rebind
SET finalize_request_json=?,finalization_receipt_json=?
WHERE transition_id=?;
`).run(JSON.stringify(request), JSON.stringify(receipt), request.transitionId);
      return receipt;
    });
  }

  function observe(request) {
    assertAutonomousResearchOnlineSchemaTransitionObserveRequest(request, { trust });
    const row = database.prepare(`
SELECT * FROM authority_schema_rebind WHERE transition_id=?;
`).get(request.transitionId);
    if (!row?.finalization_receipt_json) {
      fail('local_state_authority_schema_rebind_not_finalized');
    }
    const finalization = parseRecord(row.finalization_receipt_json, REBIND_STATE_INVALID);
    const current = metadata(database);
    if (request.transitionId !== finalization.transitionId
      || request.transitionInventoryHash !== finalization.transitionInventoryHash
      || request.schemaBundleHash !== finalization.schemaBundleHash
      || request.finalizationReceiptHash
        !== autonomousResearchOnlineSchemaTransitionReceiptHash(finalization)
      || request.postInventoryHash !== finalization.postInventoryHash
      || request.postPristineRuntimeStateHash
        !== finalization.postPristineRuntimeStateHash
      || current.schema_transition_state !== 'finalized'
      || current.configuration_hash !== row.target_configuration_hash
      || current.writer_manifest_hash !== request.writerManifestHash) {
      fail('local_state_authority_schema_rebind_target_configuration_activation_required');
    }
    const observedAt = isoNow(clock);
    return signOnline({
      version: 2,
      kind: 'AutonomousResearchOnlineSchemaTransitionObservationReceipt',
      status: 'autonomous_research_online_schema_transition_observed_finalized',
      authorityId: configuration.authorityId,
      keyId: configuration.keyId,
      requestHash: hashRecord(
        'AutonomousResearchOnlineSchemaTransitionObserveRequest',
        request,
      ),
      protocol: request.protocol,
      scopeId: request.scopeId,
      databaseScopeHash: request.databaseScopeHash,
      writerManifestHash: request.writerManifestHash,
      transitionId: request.transitionId,
      transitionInventoryHash: request.transitionInventoryHash,
      schemaBundleHash: request.schemaBundleHash,
      finalizationReceiptHash: request.finalizationReceiptHash,
      postInventoryHash: request.postInventoryHash,
      postPristineRuntimeStateHash: request.postPristineRuntimeStateHash,
      transitionState: 'finalized',
      globalSequence: Number(current.global_sequence),
      globalHash: current.global_hash,
      transitionMode: request.transitionMode,
      sourceWriterManifestHash: request.sourceWriterManifestHash,
      authorityConfigurationActivated: true,
      observedAt,
      expiresAt: expiry(observedAt, configuration.maximumObservationAgeMs),
    });
  }

  function inspect() {
    const current = metadata(database);
    const row = database.prepare(`
SELECT reservation_receipt_json,finalization_receipt_json,target_configuration_hash
FROM authority_schema_rebind
ORDER BY rowid DESC LIMIT 1;
`).get() || null;
    const reservation = row
      ? parseRecord(row.reservation_receipt_json, REBIND_STATE_INVALID)
      : null;
    const finalization = row?.finalization_receipt_json
      ? parseRecord(row.finalization_receipt_json, REBIND_STATE_INVALID)
      : null;
    const restartRequired = Boolean(
      finalization && current.configuration_hash !== row.target_configuration_hash,
    );
    return Object.freeze({
      configurationHash: current.configuration_hash,
      authorityWriterManifestHash: current.writer_manifest_hash,
      schemaRebindRestartRequired: restartRequired,
      pendingTargetWriterManifestHash: restartRequired ? reservation.writerManifestHash : null,
      pendingTargetAuthorityConfigurationHash: restartRequired
        ? row.target_configuration_hash : null,
      schemaRebindFinalizationReceiptHash: finalization
        ? autonomousResearchOnlineSchemaTransitionReceiptHash(finalization) : null,
      schemaRebindTargetConfigurationHash: finalization
        ? row.target_configuration_hash : null,
      schemaRebindActivated: Boolean(
        finalization && current.configuration_hash === row.target_configuration_hash,
      ),
      unfinishedSchemaRebindCount: Number(database.prepare(`
SELECT count(*) AS count FROM authority_schema_rebind
WHERE finalization_receipt_json IS NULL;
`).get().count),
      unfinishedBackupCount: Number(database.prepare(`
SELECT count(*) AS count FROM authority_backup_reservation
WHERE finalization_receipt_json IS NULL;
`).get().count),
    });
  }

  return Object.freeze({ reserve, finalize, observe, inspect });
}

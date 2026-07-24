import crypto from 'node:crypto';

import {
  autonomousResearchOnlineFinalizedHeadInspectionReceiptHash,
  assertAutonomousResearchOnlineFinalizedHeadInspectionReceipt,
  AUTONOMOUS_RESEARCH_ONLINE_FINALIZED_HEAD_REMAINING_BLOCKERS,
} from '../../paper-domain/automation/autonomous-research-online-finalized-head-contract.mjs';
import {
  autonomousResearchOnlineMutationReceiptHash,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  autonomousResearchStateDatabaseInventoryHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  assertAutonomousResearchOnlineWriterOperationManifest,
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildExternallyFencedSqliteMutationFinalizeRequest,
} from './externally-fenced-sqlite-mutation-recovery.mjs';
import {
  externallyFencedSqliteMutationExactSchemaHash as exactSchemaHash,
  observedExternallyFencedSqliteMutationNow,
} from './externally-fenced-sqlite-storage-primitives.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fail(code, extra = {}) {
  const error = new Error(code);
  Object.assign(error, extra);
  throw error;
}

const observedNow = (clock) => observedExternallyFencedSqliteMutationNow(
  clock,
  'autonomous_research_online_finalized_head_clock_invalid',
);

function parseJson(value, blocker) {
  try {
    const parsed = JSON.parse(String(value || ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { fail(blocker); }
}

function timestamp(value, blocker) {
  const milliseconds = Date.parse(String(value || ''));
  if (!Number.isFinite(milliseconds)) fail(blocker);
  return milliseconds;
}

function inspectDatabaseSurface(database) {
  const databaseList = database.prepare('PRAGMA database_list;').all();
  if (databaseList.length !== 1
    || databaseList[0]?.name !== 'main'
    || database.prepare(`SELECT count(*) AS count FROM temp.sqlite_schema;`).get().count !== 0) {
    fail('autonomous_research_online_finalized_head_database_surface_invalid');
  }
  const quick = database.prepare('PRAGMA quick_check;').all();
  if (quick.length !== 1
    || String(quick[0]?.quick_check || quick[0]?.integrity_check) !== 'ok'
    || database.prepare('PRAGMA foreign_key_check;').all().length !== 0) {
    fail('autonomous_research_online_finalized_head_database_integrity_invalid');
  }
  return exactSchemaHash(database);
}

function readMetadata(database) {
  const rows = database.prepare(`
SELECT singleton,schema_version,protocol,database_role,database_instance_id,
       schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,
       genesis_global_sequence,genesis_global_hash,genesis_database_sequence,
       genesis_database_hash,genesis_state_hash,provisioned_at
FROM autonomous_research_online_mutation_authority_metadata
WHERE singleton=1;
`).all();
  if (rows.length !== 1) {
    fail('autonomous_research_online_finalized_head_metadata_required');
  }
  return rows[0];
}

function validateInventory(inventory, databaseInstanceId, authorityTrust) {
  let computedInventoryHash;
  try { computedInventoryHash = autonomousResearchStateDatabaseInventoryHash(inventory); }
  catch { fail('autonomous_research_online_finalized_head_inventory_invalid'); }
  const matches = inventory.instances.filter((instance) => (
    instance.instanceId === databaseInstanceId
  ));
  if (inventory.status !== 'autonomous_research_state_database_inventory_ready'
    || inventory.inventoryHash !== computedInventoryHash
    || inventory.databaseScopeHash !== authorityTrust?.databaseScopeHash
    || !Array.isArray(inventory.blockers)
    || inventory.blockers.length !== 0
    || matches.length !== 1
    || matches[0].quickCheck !== 'ok'
    || matches[0].foreignKeyViolationCount !== 0
    || !Array.isArray(matches[0].missingSchemaObjects)
    || matches[0].missingSchemaObjects.length !== 0
    || !SHA256.test(String(matches[0].schemaHash || ''))) {
    fail('autonomous_research_online_finalized_head_inventory_invalid');
  }
  return Object.freeze({
    instance: matches[0],
    expectedDatabaseInstances: Object.freeze(inventory.instances.map((instance) => (
      Object.freeze({
        databaseRole: instance.role,
        databaseInstanceId: instance.instanceId,
        schemaHash: instance.schemaHash,
      })
    )).sort((left, right) => (
      left.databaseInstanceId.localeCompare(right.databaseInstanceId)
    ))),
  });
}

function validateConfiguration({
  database,
  authorityClient,
  authorityTrust,
  writerManifest,
  inventory,
  databaseInstanceId,
}) {
  const manifest = assertAutonomousResearchOnlineWriterOperationManifest(writerManifest);
  const inventoryBinding = validateInventory(
    inventory,
    databaseInstanceId,
    authorityTrust,
  );
  if (!database
    || database.isTransaction
    || typeof database.prepare !== 'function'
    || authorityClient?.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
    || authorityClient.trust !== authorityTrust
    || typeof authorityClient.observeCurrentHead !== 'function'
    || typeof authorityClient.verifyStoredReservation !== 'function'
    || typeof authorityClient.verifyStoredFinalization !== 'function'
    || authorityTrust?.writerManifestHash
      !== autonomousResearchOnlineWriterOperationManifestHash(manifest)
    || !manifest.coverage.coveredDatabaseRoles.includes(inventoryBinding.instance.role)) {
    fail('autonomous_research_online_finalized_head_configuration_invalid');
  }
  return Object.freeze({ manifest, ...inventoryBinding });
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

function validateMetadata(meta, instance, authorityTrust, schemaHash) {
  if (meta.singleton !== 1
    || meta.schema_version !== 1
    || meta.protocol !== AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL
    || meta.database_role !== instance.role
    || meta.database_instance_id !== instance.instanceId
    || meta.schema_contract_id !== instance.schemaContractId
    || meta.schema_hash !== schemaHash
    || instance.schemaHash !== schemaHash
    || meta.database_scope_hash !== authorityTrust.databaseScopeHash
    || meta.writer_manifest_hash !== authorityTrust.writerManifestHash
    || meta.genesis_global_sequence !== 0
    || meta.genesis_database_sequence !== 0
    || !SHA256.test(String(meta.genesis_global_hash || ''))
    || !SHA256.test(String(meta.genesis_database_hash || ''))
    || !SHA256.test(String(meta.genesis_state_hash || ''))
    || !Number.isFinite(Date.parse(String(meta.provisioned_at || '')))) {
    fail('autonomous_research_online_finalized_head_metadata_invalid');
  }
}

function manifestBinding(reserveRequest, reservation, manifest, instance) {
  const operation = manifest.operations.find((candidate) => (
    candidate.operationId === reservation.operationId
  ));
  const writer = manifest.writers.find((candidate) => (
    candidate.writerId === reservation.writerId
    && candidate.operationIds.includes(reservation.operationId)
  ));
  if (!operation?.coordinatorIntegrated
    || operation.databaseRole !== instance.role
    || !writer
    || writer.implementationHash !== reservation.codeProvenanceHash
    || reserveRequest.databaseRole !== instance.role
    || reserveRequest.databaseInstanceId !== instance.instanceId
    || reserveRequest.schemaContractId !== instance.schemaContractId) {
    fail('autonomous_research_online_finalized_head_manifest_binding_invalid');
  }
}

function exactMarkerBinding(row, reserveRequest, reservation, finalizeRequest) {
  const reserveRequestHash = hashRecord(
    'AutonomousResearchOnlineMutationReserveRequest', reserveRequest,
  );
  const reservationHash = autonomousResearchOnlineMutationReceiptHash(reservation);
  return row.reservation_id === reservation.reservationId
    && row.database_role === reservation.databaseRole
    && row.database_instance_id === reservation.databaseInstanceId
    && row.writer_id === reservation.writerId
    && row.operation_id === reservation.operationId
    && row.global_sequence === reservation.globalSequence
    && row.global_hash === reservation.globalHash
    && row.database_sequence === reservation.databaseSequence
    && row.database_hash === reservation.databaseHash
    && row.schema_hash === reservation.schemaHash
    && row.pre_state_hash === reservation.preStateHash
    && row.post_state_hash === reservation.postStateHash
    && row.changeset_hash === reservation.changesetHash
    && row.reserve_request_hash === reserveRequestHash
    && row.reservation_receipt_hash === reservationHash
    && row.local_marker_hash === finalizeRequest.localMarkerHash;
}

function validateFinalization(row, reservation, finalizeRequest, authorityClient) {
  const finalization = parseJson(
    row.finalization_receipt_json,
    'autonomous_research_online_finalized_head_finalization_json_invalid',
  );
  const finalizationHash = autonomousResearchOnlineMutationReceiptHash(finalization);
  if (row.finalization_reservation_id !== reservation.reservationId
    || row.finalization_receipt_hash !== finalizationHash
    || row.side_effect_permit_hash !== finalization.sideEffectPermitHash
    || row.finalized_at !== finalization.finalizedAt
    || timestamp(
      row.recorded_at,
      'autonomous_research_online_finalized_head_recorded_at_invalid',
    ) < timestamp(
      finalization.finalizedAt,
      'autonomous_research_online_finalized_head_finalized_at_invalid',
    )
    || !authorityClient.verifyStoredFinalization({
      receipt: finalization,
      request: finalizeRequest,
      reservation,
    })) {
    fail('autonomous_research_online_finalized_head_finalization_invalid');
  }
  return Object.freeze({ finalization, finalizationHash });
}

function inspectMarkerChain({
  database,
  meta,
  schemaHash,
  instance,
  manifest,
  authorityClient,
  authorityHead,
}) {
  const rows = database.prepare(`
SELECT marker.*,
       finalized.reservation_id AS finalization_reservation_id,
       finalized.finalization_receipt_hash,
       finalized.finalization_receipt_json,
       finalized.side_effect_permit_hash,
       finalized.finalized_at,
       finalized.recorded_at
FROM autonomous_research_online_mutation_authority_marker marker
LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized
  ON finalized.reservation_id=marker.reservation_id
ORDER BY marker.database_sequence;
`).all();
  const finalizationCount = database.prepare(`
SELECT count(*) AS count
FROM autonomous_research_online_mutation_finalization_receipt;
`).get().count;
  if (finalizationCount !== rows.length) {
    fail('autonomous_research_online_finalized_head_finalization_coverage_invalid');
  }
  let previous = Object.freeze({
    sequence: 0,
    hash: meta.genesis_database_hash,
    stateHash: meta.genesis_state_hash,
  });
  let previousGlobalSequence = -1;
  const chain = [];
  for (const row of rows) {
    const reserveRequest = parseJson(
      row.reserve_request_json,
      'autonomous_research_online_finalized_head_reserve_request_json_invalid',
    );
    const reservation = parseJson(
      row.reservation_receipt_json,
      'autonomous_research_online_finalized_head_reservation_json_invalid',
    );
    if (!authorityClient.verifyStoredReservation({
      receipt: reservation,
      request: reserveRequest,
    })) {
      fail('autonomous_research_online_finalized_head_reservation_invalid');
    }
    manifestBinding(reserveRequest, reservation, manifest, instance);
    const finalizeRequest = buildExternallyFencedSqliteMutationFinalizeRequest(
      reservation,
      row.committed_at,
    );
    if (!exactMarkerBinding(row, reserveRequest, reservation, finalizeRequest)
      || reservation.schemaHash !== schemaHash
      || reservation.databasePreviousSequence !== previous.sequence
      || reservation.databasePreviousHash !== previous.hash
      || reservation.preStateHash !== previous.stateHash
      || reservation.databaseSequence !== previous.sequence + 1
      || reservation.globalPreviousSequence + 1 !== reservation.globalSequence
      || reservation.globalSequence <= previousGlobalSequence
      || reservation.globalSequence > authorityHead.globalSequence) {
      fail('autonomous_research_online_finalized_head_marker_chain_invalid');
    }
    const checkedFinalization = validateFinalization(
      row,
      reservation,
      finalizeRequest,
      authorityClient,
    );
    chain.push(Object.freeze({
      reservationId: reservation.reservationId,
      reservationReceiptHash: row.reservation_receipt_hash,
      finalizationReceiptHash: checkedFinalization.finalizationHash,
      globalSequence: reservation.globalSequence,
      globalHash: reservation.globalHash,
      databaseSequence: reservation.databaseSequence,
      databaseHash: reservation.databaseHash,
      stateHash: reservation.postStateHash,
    }));
    previous = Object.freeze({
      sequence: reservation.databaseSequence,
      hash: reservation.databaseHash,
      stateHash: reservation.postStateHash,
    });
    previousGlobalSequence = reservation.globalSequence;
  }
  return Object.freeze({
    markerCount: rows.length,
    finalizationCount,
    localHead: previous,
    markerChainHash: hashRecord('AutonomousResearchOnlineFinalizedMarkerChain', {
      databaseRole: instance.role,
      databaseInstanceId: instance.instanceId,
      genesisGlobalSequence: 0,
      genesisGlobalHash: meta.genesis_global_hash,
      genesisDatabaseSequence: 0,
      genesisDatabaseHash: meta.genesis_database_hash,
      genesisStateHash: meta.genesis_state_hash,
      markers: chain,
    }),
  });
}

export function inspectAutonomousResearchOnlineFinalizedDatabaseHead({
  database,
  databaseInstanceId,
  inventory,
  authorityClient,
  authorityTrust = authorityClient?.trust,
  writerManifest,
  clock = { now: () => new Date() },
} = {}) {
  const configured = validateConfiguration({
    database,
    authorityClient,
    authorityTrust,
    writerManifest,
    inventory,
    databaseInstanceId,
  });
  const schemaHash = inspectDatabaseSurface(database);
  const meta = readMetadata(database);
  validateMetadata(meta, configured.instance, authorityTrust, schemaHash);
  const requestedAt = observedNow(clock).toISOString();
  const request = currentHeadRequest(authorityTrust, requestedAt);
  const currentHead = authorityClient.observeCurrentHead({
    request,
    now: observedNow(clock),
    expectedDatabaseInstances: configured.expectedDatabaseInstances,
  });
  const matches = currentHead.databaseHeads.filter((head) => (
    head.databaseRole === configured.instance.role
    && head.databaseInstanceId === configured.instance.instanceId
  ));
  if (matches.length !== 1) {
    fail('autonomous_research_online_finalized_head_authority_instance_missing');
  }
  const authorityHead = Object.freeze({
    ...matches[0],
    globalSequence: currentHead.globalSequence,
  });
  const chain = inspectMarkerChain({
    database,
    meta,
    schemaHash,
    instance: configured.instance,
    manifest: configured.manifest,
    authorityClient,
    authorityHead,
  });
  if (authorityHead.schemaHash !== schemaHash
    || authorityHead.sequence !== chain.localHead.sequence
    || authorityHead.hash !== chain.localHead.hash
    || authorityHead.stateHash !== chain.localHead.stateHash) {
    fail('autonomous_research_online_finalized_head_local_authority_mismatch');
  }
  const base = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineFinalizedHeadInspectionReceipt',
    status: 'autonomous_research_online_finalized_head_reconciled',
    inventoryHash: inventory.inventoryHash,
    databaseScopeHash: inventory.databaseScopeHash,
    writerManifestHash: authorityTrust.writerManifestHash,
    databaseRole: configured.instance.role,
    databaseInstanceId: configured.instance.instanceId,
    schemaContractId: configured.instance.schemaContractId,
    schemaHash,
    currentHeadReceiptHash: autonomousResearchOnlineMutationReceiptHash(currentHead),
    authorityGlobalSequence: currentHead.globalSequence,
    authorityGlobalHash: currentHead.globalHash,
    localDatabaseSequence: chain.localHead.sequence,
    localDatabaseHash: chain.localHead.hash,
    localStateHash: chain.localHead.stateHash,
    markerCount: chain.markerCount,
    finalizationCount: chain.finalizationCount,
    genesisZeroHeadVerified: true,
    markerChainHash: chain.markerChainHash,
    inspectedAt: observedNow(clock).toISOString(),
    remainingBlockers: AUTONOMOUS_RESEARCH_ONLINE_FINALIZED_HEAD_REMAINING_BLOCKERS,
    runtimeReady: false,
  });
  return Object.freeze(assertAutonomousResearchOnlineFinalizedHeadInspectionReceipt({
    ...base,
    inspectionReceiptHash:
      autonomousResearchOnlineFinalizedHeadInspectionReceiptHash(base),
  }));
}

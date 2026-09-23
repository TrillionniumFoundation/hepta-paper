import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertAutonomousResearchStateDatabaseManifest,
  autonomousResearchStateBackupBundleManifestHash,
  autonomousResearchStateBackupContentHash,
  autonomousResearchStateDatabaseManifestHash,
  autonomousResearchStateDatabaseScopeHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import { copySqliteDatabase } from '../persistence/sqlite-consistent-copy.mjs';
import { fsyncDirectorySync, writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import { fileSha256HashSync, readRegularJsonFileSync } from '../runtime/pinned-file-reader.mjs';
import {
  autonomousResearchStateBackupAuthorityReceiptHash,
  AUTONOMOUS_RESEARCH_STATE_BACKUP_FINALIZED_JOURNAL_PROTOCOL,
  AUTONOMOUS_RESEARCH_STATE_BACKUP_MAXIMUM_JOURNAL_ENTRIES,
  verifyAutonomousResearchStateBackupAuthorityCurrentHead,
  verifyAutonomousResearchStateBackupAuthorityFinalization,
  verifyAutonomousResearchStateBackupAuthorityJournalRange,
  verifyAutonomousResearchStateBackupAuthorityReservation,
} from './autonomous-research-state-backup-authority.mjs';
import {
  inspectSqliteDatabase,
  resolveAutonomousResearchStateDatabaseInventory,
  withAutonomousResearchStateDatabasePrivateSnapshotAsync,
} from './autonomous-research-state-database-inventory.mjs';
import {
  drillDatabaseCopiesWithReplay,
  validateLiveInventoryFinalizedHeads,
} from './autonomous-research-state-backup-journal-replay.mjs';
import {
  createAutonomousResearchStateBackupSourceOperations,
} from './autonomous-research-state-backup-source-operations.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
function observedNow(clock) {
  const value = typeof clock?.now === 'function' ? clock.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('autonomous_research_state_backup_clock_invalid');
  return date;
}
function syncFile(candidate) {
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function safeBundlePath(backupRoot, candidate) {
  const root = path.resolve(backupRoot);
  const resolved = path.resolve(candidate);
  if (!pathWithin(root, resolved)
    || !fs.existsSync(resolved)
    || !fs.lstatSync(resolved).isDirectory()
    || fs.lstatSync(resolved).isSymbolicLink()
    || !pathWithin(fs.realpathSync(root), fs.realpathSync(resolved))) {
    throw new Error('autonomous_research_state_backup_bundle_path_unsafe');
  }
  return resolved;
}
function blockedReceipt(operation, blockers, extra = {}) {
  return Object.freeze({
    version: 1,
    kind: operation === 'backup'
      ? 'AutonomousResearchStateBackupReceipt'
      : 'AutonomousResearchStateRestoreDrillReceipt',
    status: operation === 'backup'
      ? 'autonomous_research_state_backup_blocked'
      : 'autonomous_research_state_restore_drill_blocked',
    blockers: Object.freeze([...new Set(blockers)].sort()),
    ...extra,
  });
}
function reserveRequest(inventory, requestedAt, maximumLeaseMs) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateBackupAuthorityReserveRequest',
    inventoryHash: inventory.inventoryHash,
    databaseScopeHash: inventory.databaseScopeHash,
    databaseInstanceIds: Object.freeze(inventory.instances.map((entry) => entry.instanceId).sort()),
    requestedAt,
    maximumLeaseMs,
  });
}
function finalizeRequest({ reservation, snapshotContentHash, requestedAt }) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateBackupAuthorityFinalizeRequest',
    reservationId: reservation.reservationId,
    inventoryHash: reservation.inventoryHash,
    databaseScopeHash: reservation.databaseScopeHash,
    snapshotContentHash,
    requestedAt,
  });
}
function currentHeadRequest(bundle, requestedAt, maximumLeaseMs) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateBackupAuthorityCurrentHeadRequest',
    reservationId: bundle.authorityReservation.reservationId,
    databaseScopeHash: bundle.content.databaseScopeHash,
    snapshotContentHash: bundle.snapshotContentHash,
    requestedAt,
    maximumLeaseMs,
  });
}
function finalizedJournalRangeRequest({
  bundle,
  currentHead,
  onlineMutationVerifier,
  requestedAt,
  maximumLeaseMs,
}) {
  const delta = currentHead.headSequence - bundle.authorityFinalization.headSequence;
  if (!Number.isSafeInteger(delta)
    || delta < 1
    || delta > AUTONOMOUS_RESEARCH_STATE_BACKUP_MAXIMUM_JOURNAL_ENTRIES) {
    throw new Error('autonomous_research_state_restore_journal_range_unbounded');
  }
  const onlineTrust = onlineMutationVerifier?.trust;
  if (!onlineTrust
    || onlineTrust.databaseScopeHash !== bundle.content.databaseScopeHash) {
    throw new Error('autonomous_research_state_restore_online_authority_trust_required');
  }
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateBackupAuthorityJournalRangeRequest',
    reservationId: bundle.authorityReservation.reservationId,
    databaseScopeHash: bundle.content.databaseScopeHash,
    snapshotContentHash: bundle.snapshotContentHash,
    onlineAuthorityId: onlineTrust.authorityId,
    onlineKeyId: onlineTrust.keyId,
    scopeId: onlineTrust.scopeId,
    writerManifestHash: onlineTrust.writerManifestHash,
    fromGlobalSequence: bundle.authorityFinalization.headSequence,
    fromGlobalHash: bundle.authorityFinalization.headHash,
    toGlobalSequence: currentHead.headSequence,
    toGlobalHash: currentHead.headHash,
    requestedAt,
    maximumLeaseMs,
    maximumEntries: delta,
  });
}
function backupFilename(instance, index) {
  const token = crypto.createHash('sha256').update(instance.instanceId).digest('hex').slice(0, 16);
  return `${String(index + 1).padStart(3, '0')}-${instance.role}-${token}.sqlite`;
}
function assertBackupCopySidecarsAbsent(databasePath, instanceId) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try {
      fs.lstatSync(`${databasePath}${suffix}`);
      throw new Error(
        `autonomous_research_state_backup_copy_sidecar_unexpected:${instanceId}`,
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}
async function copyInventoryDatabases({ inventory, stagingRoot }) {
  const databaseRoot = path.join(stagingRoot, 'databases');
  fs.mkdirSync(databaseRoot, { recursive: true, mode: 0o700 });
  const databases = [];
  for (const [index, instance] of inventory.instances.entries()) {
    const filename = backupFilename(instance, index);
    const destinationPath = path.join(databaseRoot, filename);
    await withAutonomousResearchStateDatabasePrivateSnapshotAsync({
      sourcePath: path.join(inventory.runtimeRoot, instance.sourceRelativePath),
      inspect: (snapshotPath) => copySqliteDatabase({
        sourcePath: snapshotPath,
        destinationPath,
      }),
    });
    syncFile(destinationPath);
    const inspection = inspectSqliteDatabase(destinationPath, { immutable: true });
    assertBackupCopySidecarsAbsent(destinationPath, instance.instanceId);
    if (inspection.quickCheck !== 'ok'
      || inspection.foreignKeyViolationCount !== 0
      || inspection.schemaHash !== instance.schemaHash) {
      throw new Error(`autonomous_research_state_backup_copy_invalid:${instance.instanceId}`);
    }
    databases.push(Object.freeze({
      instanceId: instance.instanceId,
      role: instance.role,
      paperId: instance.paperId,
      sourceRelativePath: instance.sourceRelativePath,
      backupRelativePath: `databases/${filename}`,
      backupSha256: fileSha256HashSync(destinationPath),
      bytes: fs.statSync(destinationPath).size,
      schemaContractId: instance.schemaContractId,
      schemaHash: inspection.schemaHash,
      userVersion: inspection.userVersion,
      applicationId: inspection.applicationId,
      quickCheck: inspection.quickCheck,
      foreignKeyViolationCount: inspection.foreignKeyViolationCount,
    }));
  }
  fsyncDirectorySync(databaseRoot);
  return Object.freeze(databases);
}
function withRuntimeRoot(inventory, runtimeRoot) {
  return Object.freeze({ ...inventory, runtimeRoot: path.resolve(runtimeRoot) });
}

function buildContent({ inventory, databases, reservation, createdAt }) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateBackupContent',
    manifestId: inventory.manifestId,
    manifestHash: inventory.manifestHash,
    inventoryHash: inventory.inventoryHash,
    databaseScopeHash: inventory.databaseScopeHash,
    authorityReservationHash: autonomousResearchStateBackupAuthorityReceiptHash(reservation),
    authorityHead: Object.freeze({
      sequence: reservation.headSequence,
      hash: reservation.headHash,
    }),
    createdAt,
    databases,
  });
}

export async function createAutonomousResearchStateBackup({
  runtimeRoot,
  backupRoot = path.join(runtimeRoot, 'backups', 'autonomous-research-state'),
  stateDatabaseManifest,
  authorityClient,
  authorityTrust,
  onlineMutationVerifier = null,
  clock = null,
} = {}) {
  const blockers = [];
  let stagingRoot = null;
  let authorityFinalized = false;
  try {
    if (!authorityClient?.reserveSnapshot || !authorityClient?.finalizeSnapshot || !authorityTrust) {
      throw new Error('autonomous_research_state_backup_external_authority_required');
    }
    const manifest = assertAutonomousResearchStateDatabaseManifest(stateDatabaseManifest);
    let inventory = resolveAutonomousResearchStateDatabaseInventory({ runtimeRoot, manifest });
    if (inventory.status !== 'autonomous_research_state_database_inventory_ready') {
      return blockedReceipt('backup', inventory.blockers, { inventory });
    }
    inventory = withRuntimeRoot(inventory, runtimeRoot);
    const requestedAt = observedNow(clock).toISOString();
    const request = reserveRequest(inventory, requestedAt, authorityTrust.maximumReservationLeaseMs);
    const reservation = await authorityClient.reserveSnapshot(request);
    if (!verifyAutonomousResearchStateBackupAuthorityReservation({
      receipt: reservation, request, trust: authorityTrust, now: observedNow(clock),
    })) throw new Error('autonomous_research_state_backup_authority_reservation_invalid');
    if (onlineMutationVerifier) {
      validateLiveInventoryFinalizedHeads({
        runtimeRoot,
        inventory,
        reservation,
        onlineMutationVerifier,
      });
    }

    const fencedInventory = resolveAutonomousResearchStateDatabaseInventory({ runtimeRoot, manifest });
    if (fencedInventory.status !== 'autonomous_research_state_database_inventory_ready'
      || fencedInventory.inventoryHash !== inventory.inventoryHash) {
      throw new Error('autonomous_research_state_backup_inventory_changed_after_reservation');
    }
    const resolvedBackupRoot = path.resolve(backupRoot);
    fs.mkdirSync(resolvedBackupRoot, { recursive: true, mode: 0o700 });
    stagingRoot = path.join(resolvedBackupRoot, `.pending-${crypto.randomUUID()}`);
    fs.mkdirSync(stagingRoot, { mode: 0o700 });
    const databases = await copyInventoryDatabases({ inventory, stagingRoot });

    const postCopyInventory = resolveAutonomousResearchStateDatabaseInventory({ runtimeRoot, manifest });
    if (postCopyInventory.status !== 'autonomous_research_state_database_inventory_ready'
      || postCopyInventory.inventoryHash !== inventory.inventoryHash) {
      throw new Error('autonomous_research_state_backup_source_changed_during_copy');
    }
    const createdAt = observedNow(clock).toISOString();
    const content = buildContent({ inventory, databases, reservation, createdAt });
    const snapshotContentHash = autonomousResearchStateBackupContentHash(content);
    const finalRequest = finalizeRequest({ reservation, snapshotContentHash, requestedAt: createdAt });
    const finalization = await authorityClient.finalizeSnapshot(finalRequest);
    if (!verifyAutonomousResearchStateBackupAuthorityFinalization({
      receipt: finalization,
      request: finalRequest,
      reservation,
      trust: authorityTrust,
      now: observedNow(clock),
    })) throw new Error('autonomous_research_state_backup_authority_finalization_invalid');
    authorityFinalized = true;

    const bundlePayload = {
      version: 1,
      kind: 'AutonomousResearchStateBackupBundleManifest',
      status: 'autonomous_research_state_backup_recorded',
      snapshotContentHash,
      content,
      authorityReserveRequest: request,
      authorityReservation: reservation,
      authorityFinalizeRequest: finalRequest,
      authorityFinalization: finalization,
      productionStateMutated: false,
    };
    const bundle = {
      ...bundlePayload,
      bundleManifestHash: autonomousResearchStateBackupBundleManifestHash(bundlePayload),
    };
    writeDurableJsonSync(path.join(stagingRoot, 'AUTONOMOUS_RESEARCH_STATE_BACKUP.json'), bundle);
    fsyncDirectorySync(stagingRoot);
    const bundleId = snapshotContentHash.replace(/^sha256:/, '');
    const bundlePath = path.join(resolvedBackupRoot, bundleId);
    if (fs.existsSync(bundlePath)) throw new Error('autonomous_research_state_backup_bundle_already_exists');
    fs.renameSync(stagingRoot, bundlePath);
    fsyncDirectorySync(resolvedBackupRoot);
    stagingRoot = null;
    return Object.freeze({
      version: 1,
      kind: 'AutonomousResearchStateBackupReceipt',
      status: 'autonomous_research_state_backup_recorded',
      bundlePath,
      bundleManifestHash: bundle.bundleManifestHash,
      snapshotContentHash,
      inventoryHash: inventory.inventoryHash,
      databaseCount: databases.length,
      authorityId: reservation.authorityId,
      authorityHeadSequence: reservation.headSequence,
      authorityHeadHash: reservation.headHash,
      blockers: Object.freeze([]),
    });
  } catch (error) {
    blockers.push(error?.message || 'autonomous_research_state_backup_failed');
    const recoverableStagingPath = authorityFinalized && stagingRoot ? stagingRoot : null;
    if (stagingRoot && !authorityFinalized) fs.rmSync(stagingRoot, { recursive: true, force: true });
    return blockedReceipt('backup', blockers, { recoverableStagingPath });
  }
}

function validateBundle({ bundle, stateDatabaseManifest }) {
  const blockers = [];
  const manifest = assertAutonomousResearchStateDatabaseManifest(stateDatabaseManifest);
  if (!bundle || autonomousResearchStateBackupBundleManifestHash(bundle) !== bundle.bundleManifestHash) {
    blockers.push('autonomous_research_state_backup_bundle_manifest_hash_invalid');
    return blockers;
  }
  if (bundle.content.manifestHash !== autonomousResearchStateDatabaseManifestHash(manifest)) {
    blockers.push('autonomous_research_state_backup_database_manifest_mismatch');
  }
  if (bundle.content.manifestId !== manifest.manifestId) {
    blockers.push('autonomous_research_state_backup_database_manifest_id_mismatch');
  }
  if (autonomousResearchStateBackupContentHash(bundle.content) !== bundle.snapshotContentHash) {
    blockers.push('autonomous_research_state_backup_content_hash_invalid');
  }
  const scopeHash = autonomousResearchStateDatabaseScopeHash(bundle.content.databases);
  if (scopeHash !== bundle.content.databaseScopeHash) blockers.push('autonomous_research_state_backup_scope_hash_invalid');
  if (bundle.productionStateMutated !== false) blockers.push('autonomous_research_state_backup_production_mutation_claim_invalid');
  if (bundle.content.inventoryHash !== bundle.authorityReservation.inventoryHash
    || bundle.content.databaseScopeHash !== bundle.authorityReservation.databaseScopeHash) {
    blockers.push('autonomous_research_state_backup_authority_scope_binding_invalid');
  }
  if (bundle.content.authorityReservationHash
    !== autonomousResearchStateBackupAuthorityReceiptHash(bundle.authorityReservation)) {
    blockers.push('autonomous_research_state_backup_authority_reservation_hash_invalid');
  }
  if (bundle.authorityFinalization.snapshotContentHash !== bundle.snapshotContentHash
    || bundle.authorityFinalization.headSequence !== bundle.content.authorityHead?.sequence
    || bundle.authorityFinalization.headHash !== bundle.content.authorityHead?.hash) {
    blockers.push('autonomous_research_state_backup_authority_finalization_binding_invalid');
  }
  const instanceIds = bundle.content.databases.map((entry) => entry.instanceId);
  const sourcePaths = bundle.content.databases.map((entry) => entry.sourceRelativePath);
  const backupPaths = bundle.content.databases.map((entry) => entry.backupRelativePath);
  if (new Set(instanceIds).size !== instanceIds.length
    || new Set(sourcePaths).size !== sourcePaths.length
    || new Set(backupPaths).size !== backupPaths.length) {
    blockers.push('autonomous_research_state_backup_database_identity_duplicate');
  }
  if (bundle.content.databases.some((entry) => (
    typeof entry.instanceId !== 'string'
    || !entry.instanceId
    || typeof entry.sourceRelativePath !== 'string'
    || entry.sourceRelativePath.startsWith('/')
    || entry.sourceRelativePath.split('/').includes('..')
    || !/^databases\/[A-Za-z0-9][A-Za-z0-9.-]*\.sqlite$/.test(String(entry.backupRelativePath || ''))
    || !SHA256.test(String(entry.backupSha256 || ''))
    || typeof entry.schemaContractId !== 'string'
    || !entry.schemaContractId
    || !SHA256.test(String(entry.schemaHash || ''))
    || !Number.isSafeInteger(entry.bytes)
    || entry.bytes < 1
    || entry.quickCheck !== 'ok'
    || entry.foreignKeyViolationCount !== 0
  ))) blockers.push('autonomous_research_state_backup_database_record_invalid');
  for (const definition of manifest.databases) {
    const count = bundle.content.databases.filter((entry) => entry.role === definition.role).length;
    if (count < definition.minimumInstances) blockers.push(`autonomous_research_state_backup_role_missing:${definition.role}`);
    if (definition.cardinality === 'singleton' && count !== 1) blockers.push(`autonomous_research_state_backup_role_cardinality_invalid:${definition.role}`);
  }
  if (bundle.content.databases.some((entry) => !manifest.databases.some((definition) => definition.role === entry.role))) {
    blockers.push('autonomous_research_state_backup_unregistered_role');
  }
  return blockers;
}

async function drillDatabaseCopiesWithoutReplay({ bundleRoot, databases }) {
  const blockers = [];
  const expected = new Set(databases.map((entry) => entry.backupRelativePath));
  const databaseRoot = path.join(bundleRoot, 'databases');
  const present = fs.existsSync(databaseRoot)
    ? fs.readdirSync(databaseRoot).map((name) => `databases/${name}`)
    : [];
  if (present.some((entry) => !expected.has(entry)) || present.length !== expected.size) {
    blockers.push('autonomous_research_state_backup_database_set_mismatch');
  }
  const drillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-state-restore-drill-'));
  try {
    for (const entry of databases) {
      const sourcePath = path.resolve(bundleRoot, entry.backupRelativePath);
      if (!pathWithin(bundleRoot, sourcePath)
        || !fs.existsSync(sourcePath)
        || fs.lstatSync(sourcePath).isSymbolicLink()
        || !fs.lstatSync(sourcePath).isFile()
        || !pathWithin(fs.realpathSync(bundleRoot), fs.realpathSync(sourcePath))) {
        blockers.push(`autonomous_research_state_backup_database_unsafe:${entry.instanceId}`);
        continue;
      }
      if (fileSha256HashSync(sourcePath) !== entry.backupSha256
        || fs.statSync(sourcePath).size !== entry.bytes) {
        blockers.push(`autonomous_research_state_backup_database_hash_mismatch:${entry.instanceId}`);
        continue;
      }
      const drillPath = path.join(drillRoot, path.basename(entry.backupRelativePath));
      await copySqliteDatabase({
        sourcePath,
        destinationPath: drillPath,
        sourceImmutable: true,
      });
      const inspection = inspectSqliteDatabase(drillPath, { immutable: true });
      if (inspection.quickCheck !== 'ok') blockers.push(`autonomous_research_state_restore_quick_check_failed:${entry.instanceId}`);
      if (inspection.foreignKeyViolationCount !== 0) blockers.push(`autonomous_research_state_restore_foreign_key_check_failed:${entry.instanceId}`);
      if (inspection.schemaHash !== entry.schemaHash) blockers.push(`autonomous_research_state_restore_schema_mismatch:${entry.instanceId}`);
    }
  } finally { fs.rmSync(drillRoot, { recursive: true, force: true }); }
  return blockers;
}

export async function drillAutonomousResearchStateRestore({
  bundlePath,
  backupRoot = path.dirname(bundlePath || ''),
  stateDatabaseManifest,
  authorityClient,
  authorityTrust,
  onlineMutationVerifier = null,
  clock = null,
} = {}) {
  const blockers = [];
  let bundle = null;
  let currentHead = null;
  let journalRequest = null;
  let journalRange = null;
  try {
    if (!authorityClient?.observeCurrentHead || !authorityTrust) {
      throw new Error('autonomous_research_state_restore_external_authority_required');
    }
    const bundleRoot = safeBundlePath(backupRoot, bundlePath);
    bundle = readRegularJsonFileSync(path.join(bundleRoot, 'AUTONOMOUS_RESEARCH_STATE_BACKUP.json'));
    blockers.push(...validateBundle({ bundle, stateDatabaseManifest }));
    if (blockers.length) return blockedReceipt('restore', blockers, { bundlePath: bundleRoot });

    if (!verifyAutonomousResearchStateBackupAuthorityReservation({
      receipt: bundle.authorityReservation,
      request: bundle.authorityReserveRequest,
      trust: authorityTrust,
      now: bundle.authorityReservation.issuedAt,
    })) blockers.push('autonomous_research_state_restore_authority_reservation_invalid');
    if (!verifyAutonomousResearchStateBackupAuthorityFinalization({
      receipt: bundle.authorityFinalization,
      request: bundle.authorityFinalizeRequest,
      reservation: bundle.authorityReservation,
      trust: authorityTrust,
      now: bundle.authorityFinalization.finalizedAt,
    })) blockers.push('autonomous_research_state_restore_authority_finalization_invalid');
    if (blockers.length) return blockedReceipt('restore', blockers, { bundlePath: bundleRoot });

    const requestedAt = observedNow(clock).toISOString();
    const request = currentHeadRequest(
      bundle,
      requestedAt,
      authorityTrust.maximumReservationLeaseMs,
    );
    currentHead = await authorityClient.observeCurrentHead(request);
    if (!verifyAutonomousResearchStateBackupAuthorityCurrentHead({
      receipt: currentHead, request, trust: authorityTrust, now: observedNow(clock),
    })) blockers.push('autonomous_research_state_restore_current_authority_head_invalid');
    const snapshotSequence = bundle.authorityFinalization.headSequence;
    const snapshotHash = bundle.authorityFinalization.headHash;
    const headUnchanged = currentHead?.headSequence === snapshotSequence
      && currentHead?.headHash === snapshotHash;
    let recoveredDatabaseHeads = Object.freeze([]);
    if (currentHead?.headSequence < snapshotSequence
      || (currentHead?.headSequence === snapshotSequence
        && currentHead?.headHash !== snapshotHash)) {
      blockers.push('autonomous_research_state_restore_authority_head_rollback_or_equivocation');
    } else if (headUnchanged) {
      blockers.push(...await drillDatabaseCopiesWithoutReplay({
        bundleRoot,
        databases: bundle.content.databases,
      }));
    } else if (!authorityClient?.readFinalizedMutationJournal || !onlineMutationVerifier) {
      blockers.push('autonomous_research_state_restore_snapshot_stale_against_authority_head');
      blockers.push('autonomous_research_state_restore_complete_finalized_journal_required');
    } else {
      journalRequest = finalizedJournalRangeRequest({
        bundle,
        currentHead,
        onlineMutationVerifier,
        requestedAt: observedNow(clock).toISOString(),
        maximumLeaseMs: authorityTrust.maximumReservationLeaseMs,
      });
      journalRange = await authorityClient.readFinalizedMutationJournal(journalRequest);
      if (!verifyAutonomousResearchStateBackupAuthorityJournalRange({
        receipt: journalRange,
        request: journalRequest,
        trust: authorityTrust,
        now: observedNow(clock),
      })) {
        blockers.push('autonomous_research_state_restore_authority_journal_range_invalid');
      } else if (journalRange.toGlobalSequence !== currentHead.headSequence
        || journalRange.toGlobalHash !== currentHead.headHash) {
        blockers.push('autonomous_research_state_restore_journal_current_head_mismatch');
      } else {
        const replay = await drillDatabaseCopiesWithReplay({
          bundleRoot,
          databases: bundle.content.databases,
          journalRange,
          onlineMutationVerifier,
          snapshotHead: Object.freeze({ sequence: snapshotSequence, hash: snapshotHash }),
        });
        blockers.push(...replay.blockers);
        recoveredDatabaseHeads = replay.recoveredDatabaseHeads;
      }
    }
    if (Date.parse(String(currentHead?.expiresAt || '')) <= observedNow(clock).getTime()) {
      blockers.push('autonomous_research_state_restore_authority_fence_expired_during_drill');
    }
    if (journalRange
      && Date.parse(String(journalRange.expiresAt || '')) <= observedNow(clock).getTime()) {
      blockers.push('autonomous_research_state_restore_journal_fence_expired_during_drill');
    }
    const status = blockers.length
      ? 'autonomous_research_state_restore_drill_blocked'
      : 'autonomous_research_state_restore_drill_passed';
    const payload = {
      version: 1,
      kind: 'AutonomousResearchStateRestoreDrillReceipt',
      status,
      bundlePath: bundleRoot,
      bundleManifestHash: bundle.bundleManifestHash,
      snapshotContentHash: bundle.snapshotContentHash,
      authorityCurrentHeadRequest: request,
      authorityCurrentHeadReceipt: currentHead,
      authorityCurrentHeadReceiptHash: currentHead
        ? autonomousResearchStateBackupAuthorityReceiptHash(currentHead)
        : null,
      authorityJournalRangeRequest: journalRequest,
      authorityJournalRangeReceipt: journalRange,
      authorityJournalRangeReceiptHash: journalRange
        ? autonomousResearchStateBackupAuthorityReceiptHash(journalRange)
        : null,
      journalReplayMutationCount: journalRange?.entries?.length || 0,
      recoveredDatabaseHeads,
      recoverabilityProtocol: journalRange
        ? AUTONOMOUS_RESEARCH_STATE_BACKUP_FINALIZED_JOURNAL_PROTOCOL
        : 'snapshot-current-head-exact-v1',
      completeFinalizedMutationJournal: journalRange
        ? journalRange.completeFinalizedMutationJournal === true
        : false,
      databaseCount: bundle.content.databases.length,
      productionStateMutated: false,
      performedAt: observedNow(clock).toISOString(),
      blockers: Object.freeze([...new Set(blockers)].sort()),
    };
    payload.recoverabilityBindingHash = hashRecord(
      'AutonomousResearchStateRestoreRecoverabilityBinding',
      {
        bundleManifestHash: payload.bundleManifestHash,
        snapshotContentHash: payload.snapshotContentHash,
        currentHeadReceiptHash: payload.authorityCurrentHeadReceiptHash,
        journalRangeReceiptHash: payload.authorityJournalRangeReceiptHash,
        journalReplayMutationCount: payload.journalReplayMutationCount,
        recoveredDatabaseHeads: payload.recoveredDatabaseHeads,
        recoverabilityProtocol: payload.recoverabilityProtocol,
        completeFinalizedMutationJournal: payload.completeFinalizedMutationJournal,
      },
    );
    const receipt = Object.freeze({
      ...payload,
      restoreDrillReceiptHash: hashRecord('AutonomousResearchStateRestoreDrillReceipt', payload),
    });
    writeDurableJsonSync(path.join(bundleRoot, 'RESTORE_DRILL_RECEIPT.json'), receipt);
    return receipt;
  } catch (error) {
    blockers.push(error?.message || 'autonomous_research_state_restore_drill_failed');
    return blockedReceipt('restore', blockers, {
      bundlePath: bundlePath || null,
      bundleManifestHash: bundle?.bundleManifestHash || null,
      authorityCurrentHeadReceiptHash: currentHead
        ? autonomousResearchStateBackupAuthorityReceiptHash(currentHead)
        : null,
    });
  }
}

const sourceOperations = createAutonomousResearchStateBackupSourceOperations({
  safeBundlePath,
  validateBundle,
  observedNow,
  currentHeadRequest,
});

export const observeAutonomousResearchStateBackupCurrentHead =
  sourceOperations.observeCurrentHead;
export const publishAutonomousResearchStateBackupRenewalReceipt =
  sourceOperations.publishRenewalReceipt;
export const resolveLatestAutonomousResearchStateBackupSources =
  sourceOperations.resolveLatestSources;

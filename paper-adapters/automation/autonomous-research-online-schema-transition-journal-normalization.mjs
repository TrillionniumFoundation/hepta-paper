import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { fileSha256HashSync } from '../runtime/pinned-file-reader.mjs';
import {
  assertSchemaTransitionNoSidecars,
  schemaTransitionDatabasePath,
  schemaTransitionFileIdentity,
  schemaTransitionJournalPreimageHash,
  schemaTransitionNormalizedProjectionMatches,
  schemaTransitionNow,
  schemaTransitionSameIdentity,
  schemaTransitionStableFileIdentity,
} from './autonomous-research-online-schema-transition-schema.mjs';

function fail(code, extra = {}) {
  const error = new Error(code);
  Object.assign(error, extra);
  throw error;
}

const QUIESCED_MAINTENANCE_CAPABILITIES = new WeakMap();

function assertLease(reservation, clock, minimumMs) {
  const remaining = Date.parse(reservation.expiresAt) - schemaTransitionNow(clock).getTime();
  if (!Number.isFinite(remaining) || remaining < minimumMs) {
    fail('autonomous_research_online_schema_transition_quiescence_lease_insufficient');
  }
}

function runtimeRootIdentity(runtimeRoot) {
  const resolved = path.resolve(String(runtimeRoot || ''));
  const stat = fs.lstatSync(resolved, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    fail('autonomous_research_online_schema_transition_runtime_root_identity_invalid');
  }
  return Object.freeze({
    resolved,
    realpath: fs.realpathSync(resolved),
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
    gid: String(stat.gid),
  });
}

function fileIdentityFromStat(stat) {
  return Object.freeze({
    device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode),
    links: String(stat.nlink), bytes: String(stat.size), modifiedNs: String(stat.mtimeNs),
    changedNs: String(stat.ctimeNs),
  });
}

function removeUnchangedStaleSharedMemory(candidate, beforeIdentity, databaseRole) {
  const shmPath = `${candidate}-shm`;
  if (!fs.existsSync(shmPath)) return;
  const pathIdentity = schemaTransitionFileIdentity(shmPath, { databaseRole });
  if (!beforeIdentity || beforeIdentity.links !== '1'
    || !schemaTransitionSameIdentity(beforeIdentity, pathIdentity)
    || fs.existsSync(`${candidate}-wal`)) {
    fail('autonomous_research_online_schema_transition_stale_shm_cleanup_unsafe');
  }
  const descriptor = fs.openSync(
    shmPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    if (!schemaTransitionSameIdentity(
      pathIdentity,
      fileIdentityFromStat(fs.fstatSync(descriptor, { bigint: true })),
    ) || !schemaTransitionSameIdentity(
      pathIdentity,
      schemaTransitionFileIdentity(shmPath, { databaseRole }),
    ) || fs.existsSync(`${candidate}-wal`)) {
      fail('autonomous_research_online_schema_transition_stale_shm_cleanup_unsafe');
    }
    fs.unlinkSync(shmPath);
    if (fs.existsSync(shmPath)) {
      fail('autonomous_research_online_schema_transition_stale_shm_cleanup_failed');
    }
  } finally { fs.closeSync(descriptor); }
  const parent = fs.openSync(path.dirname(candidate), fs.constants.O_RDONLY);
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

function exactSchemaTransitionScope({
  runtimeRoot,
  plan,
  reserveRequest,
  reservation,
  currentInventory,
}) {
  const roles = [...new Set(plan.instances.map((entry) => entry.databaseRole))].sort();
  const requiredRoles = [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort();
  const currentRoles = currentInventory.instances.map((entry) => entry.role);
  const currentInstanceIds = currentInventory.instances.map((entry) => entry.instanceId);
  const inventoryById = new Map(currentInventory.instances.map((entry) => [
    entry.instanceId,
    entry,
  ]));
  const mirroredKeys = [
    'protocol',
    'scopeId',
    'databaseScopeHash',
    'writerManifestHash',
    'stateDatabaseManifestHash',
    'transitionInventoryHash',
    'schemaBundleHash',
    'transitionId',
  ];
  return roles.join('\0') === requiredRoles.join('\0')
    && plan.instances.length === requiredRoles.length
    && currentInventory.instances.length === requiredRoles.length
    && new Set(currentRoles).size === currentRoles.length
    && new Set(currentInstanceIds).size === currentInstanceIds.length
    && [...currentRoles].sort().join('\0') === requiredRoles.join('\0')
    && plan.instances.length === reserveRequest.instances.length
    && JSON.stringify(plan.instances) === JSON.stringify(reserveRequest.instances)
    && JSON.stringify(reservation.instances) === JSON.stringify(reserveRequest.instances)
    && mirroredKeys.every((key) => (
      plan[key] === reserveRequest[key] && reservation[key] === reserveRequest[key]
    ))
    && reserveRequest.requiredExecutionWindowMs === plan.requiredExecutionWindowMs
    && currentInventory.databaseScopeHash === plan.databaseScopeHash
    && plan.instances.every((entry) => {
      const observed = inventoryById.get(entry.databaseInstanceId);
      if (observed?.role !== entry.databaseRole
        || observed.sourceRelativePath !== entry.sourceRelativePath) return false;
      const candidate = schemaTransitionDatabasePath(runtimeRoot, observed);
      const candidateSha256 = fileSha256HashSync(candidate);
      const stableIdentityHash = hashRecord(
        'AutonomousResearchOnlineSchemaTransitionSourceFileIdentity',
        schemaTransitionStableFileIdentity(schemaTransitionFileIdentity(candidate, {
          databaseRole: observed.role,
        })),
      );
      const noSidecars = !fs.existsSync(`${candidate}-wal`)
        && !fs.existsSync(`${candidate}-shm`);
      const preimageState = candidateSha256 === entry.sourceSha256
        && observed.sourceSha256 === candidateSha256
        && schemaTransitionJournalPreimageHash(candidate, {
          databaseRole: observed.role,
        }) === entry.journalPreimageHash;
      const normalizedState = candidateSha256 === entry.expectedNormalizedSourceSha256
        && noSidecars;
      const installedState = observed.schemaHash === entry.expectedPostSchemaHash
        && observed.sourceSha256 === candidateSha256
        && noSidecars;
      if (stableIdentityHash !== entry.sourceFileIdentityHash) return false;
      if (preimageState || normalizedState || installedState) return true;
      return observed.schemaHash === entry.preSchemaHash
        && schemaTransitionNormalizedProjectionMatches(
          candidate,
          entry.expectedNormalizedSourceSha256,
          { databaseRole: observed.role },
        );
    });
}

function assertQuiescedMaintenanceCapability({
  capability,
  runtimeRoot,
  authorityClient,
  reserveRequest,
  reservation,
  plan,
  currentInventory,
  clock,
}) {
  const bound = QUIESCED_MAINTENANCE_CAPABILITIES.get(capability);
  const now = schemaTransitionNow(clock);
  const expectedQuiescenceMode = plan.version === 2
    ? 'pristine-scope-held-through-target-configuration-restart'
    : 'scope-wide-no-new-reservations-until-finalize-or-expiry';
  if (!bound
    || bound.authorityClient !== authorityClient
    || bound.reserveRequest !== reserveRequest
    || bound.reservation !== reservation
    || bound.plan !== plan
    || bound.currentInventory !== currentInventory
    || JSON.stringify(bound.runtimeRootIdentity) !== JSON.stringify(
      runtimeRootIdentity(runtimeRoot),
    )
    || typeof authorityClient?.verifyStoredReservation !== 'function'
    || authorityClient.verifyStoredReservation({
      receipt: reservation,
      request: reserveRequest,
      now,
    }) !== true
    || reservation.allRegisteredMutationsFenced !== true
    || reservation.quiescenceMode !== expectedQuiescenceMode
    || !exactSchemaTransitionScope({
      runtimeRoot,
      plan,
      reserveRequest,
      reservation,
      currentInventory,
    })) {
    fail('autonomous_research_online_schema_transition_quiescence_capability_invalid');
  }
  assertLease(reservation, clock, plan.requiredExecutionWindowMs);
}

function normalizationRecord(planInstance, beforeSha256, normalizedSha256, extra = {}) {
  return Object.freeze({
    databaseRole: planInstance.databaseRole,
    databaseInstanceId: planInstance.databaseInstanceId,
    journalPreimageHash: planInstance.journalPreimageHash,
    beforeSha256,
    normalizedSha256,
    journalMode: 'delete',
    sidecarsPresent: false,
    ...extra,
  });
}

function normalizeAutonomousResearchOnlineSchemaTransitionJournals({
  runtimeRoot,
  currentInventory,
  plan,
  reserveRequest,
  reservation,
  authorityClient,
  clock,
  maintenanceCapability,
  faultInjector,
}) {
  const currentById = new Map(currentInventory.instances.map((entry) => [entry.instanceId, entry]));
  const records = [];
  for (const planInstance of plan.instances) {
    assertQuiescedMaintenanceCapability({
      capability: maintenanceCapability,
      runtimeRoot,
      authorityClient,
      reserveRequest,
      reservation,
      plan,
      currentInventory,
      clock,
    });
    const instance = currentById.get(planInstance.databaseInstanceId);
    if (!instance
      || instance.role !== planInstance.databaseRole
      || instance.sourceRelativePath !== planInstance.sourceRelativePath) {
      fail('autonomous_research_online_schema_transition_journal_preimage_changed');
    }
    const candidate = schemaTransitionDatabasePath(runtimeRoot, instance);
    if (instance.schemaHash === planInstance.expectedPostSchemaHash) {
      assertSchemaTransitionNoSidecars(candidate);
      const candidateSha256 = fileSha256HashSync(candidate);
      records.push(normalizationRecord(
        planInstance,
        candidateSha256,
        candidateSha256,
        { alreadyInstalled: true },
      ));
      continue;
    }
    const beforeSha256 = fileSha256HashSync(candidate);
    const sidecarsPresent = fs.existsSync(`${candidate}-wal`)
      || fs.existsSync(`${candidate}-shm`);
    if (beforeSha256 === planInstance.expectedNormalizedSourceSha256 && !sidecarsPresent) {
      records.push(normalizationRecord(
        planInstance,
        beforeSha256,
        beforeSha256,
        { alreadyNormalized: true },
      ));
      continue;
    }
    const originalState = beforeSha256 === planInstance.sourceSha256
      && schemaTransitionJournalPreimageHash(candidate, {
        databaseRole: planInstance.databaseRole,
      }) === planInstance.journalPreimageHash;
    if (instance.schemaHash !== planInstance.preSchemaHash
      || (!originalState && !schemaTransitionNormalizedProjectionMatches(
        candidate,
        planInstance.expectedNormalizedSourceSha256,
        { databaseRole: planInstance.databaseRole },
      ))) {
      fail('autonomous_research_online_schema_transition_journal_preimage_changed');
    }
    const database = new DatabaseSync(candidate);
    try {
      database.exec('PRAGMA busy_timeout=10000;');
      const initialMode = String(database.prepare('PRAGMA journal_mode;').get()?.journal_mode || '');
      if (fs.existsSync(`${candidate}-wal`) && initialMode === 'delete'
        && String(database.prepare('PRAGMA journal_mode=WAL;').get()?.journal_mode || '')
          !== 'wal') {
        fail('autonomous_research_online_schema_transition_stale_sidecar_cleanup_failed');
      }
      const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
      if (Number(checkpoint?.busy || 0) !== 0) {
        fail('autonomous_research_online_schema_transition_checkpoint_busy', {
          databaseInstanceId: planInstance.databaseInstanceId,
        });
      }
      faultInjector?.({
        point: 'after_journal_checkpoint',
        databaseInstanceId: planInstance.databaseInstanceId,
      });
      const mode = String(
        database.prepare('PRAGMA journal_mode=DELETE;').get()?.journal_mode || '',
      );
      database.exec('PRAGMA synchronous=FULL;');
      if (mode !== 'delete') {
        fail('autonomous_research_online_schema_transition_journal_mode_normalization_failed');
      }
    } finally { database.close(); }
    if (fs.existsSync(`${candidate}-shm`)) {
      assertQuiescedMaintenanceCapability({
        capability: maintenanceCapability,
        runtimeRoot,
        authorityClient,
        reserveRequest,
        reservation,
        plan,
        currentInventory,
        clock,
      });
      removeUnchangedStaleSharedMemory(
        candidate,
        schemaTransitionFileIdentity(`${candidate}-shm`, {
          databaseRole: planInstance.databaseRole,
        }),
        planInstance.databaseRole,
      );
    }
    assertSchemaTransitionNoSidecars(candidate);
    const normalizedSha256 = fileSha256HashSync(candidate);
    if (normalizedSha256 !== planInstance.expectedNormalizedSourceSha256) {
      fail('autonomous_research_online_schema_transition_normalized_source_hash_mismatch', {
        databaseInstanceId: planInstance.databaseInstanceId,
      });
    }
    records.push(normalizationRecord(planInstance, beforeSha256, normalizedSha256));
  }
  return Object.freeze(records);
}

export function executeAutonomousResearchOnlineSchemaTransitionJournalNormalization({
  runtimeRoot,
  currentInventory,
  plan,
  reserveRequest,
  reservation,
  authorityClient,
  clock,
  faultInjector = null,
}) {
  const maintenanceCapability = Object.freeze({});
  QUIESCED_MAINTENANCE_CAPABILITIES.set(maintenanceCapability, Object.freeze({
    authorityClient,
    reserveRequest,
    reservation,
    plan,
    currentInventory,
    runtimeRootIdentity: runtimeRootIdentity(runtimeRoot),
  }));
  try {
    assertQuiescedMaintenanceCapability({
      capability: maintenanceCapability,
      runtimeRoot,
      authorityClient,
      reserveRequest,
      reservation,
      plan,
      currentInventory,
      clock,
    });
    const records = normalizeAutonomousResearchOnlineSchemaTransitionJournals({
      runtimeRoot,
      currentInventory,
      plan,
      reserveRequest,
      reservation,
      authorityClient,
      clock,
      maintenanceCapability,
      faultInjector,
    });
    assertQuiescedMaintenanceCapability({
      capability: maintenanceCapability,
      runtimeRoot,
      authorityClient,
      reserveRequest,
      reservation,
      plan,
      currentInventory,
      clock,
    });
    return records;
  } finally {
    QUIESCED_MAINTENANCE_CAPABILITIES.delete(maintenanceCapability);
  }
}

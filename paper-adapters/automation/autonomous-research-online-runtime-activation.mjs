import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  assertAutonomousResearchOnlineRuntimeActivationReceipt,
  autonomousResearchOnlineRuntimeActivationReceiptHash,
} from '../../paper-domain/automation/autonomous-research-online-runtime-activation-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
  autonomousResearchStateDatabaseInventoryHash,
  autonomousResearchStateDatabaseScopeHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  assertAutonomousResearchOnlineWriterOperationManifest,
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  evaluateAutonomousResearchStateSafetyReadiness,
} from '../../paper-domain/automation/autonomous-research-state-safety-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_CONTRACT_HASH,
} from '../../paper-domain/automation/autonomous-research-online-authority-evidence-cache-contract.mjs';
import {
  autonomousResearchOnlineSchemaTransitionReadyReceiptHash,
  AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import {
  assertExternallyFencedSqliteMutationCoordinatorPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import {
  inspectAutonomousResearchOnlineMutationActiveEvidence,
} from './autonomous-research-online-mutation-passive-inspection.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_RELATIVE_PATH,
  createAutonomousResearchOnlineAuthorityEvidenceCacheWriter,
} from './autonomous-research-online-authority-evidence-cache.mjs';
import {
  observedExternallyFencedSqliteMutationNow,
} from './externally-fenced-sqlite-storage-primitives.mjs';

function fail(code, extra = {}) {
  const error = new Error(code);
  Object.assign(error, extra);
  throw error;
}

const observedNow = (clock) => observedExternallyFencedSqliteMutationNow(
  clock,
  'autonomous_research_online_runtime_activation_clock_invalid',
);

function fileIdentity(candidate, { databaseRole = null } = {}) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  const mode = Number(stat.mode);
  const groupWritePermitted = databaseRole === 'submission-handoff';
  if (!stat.isFile() || stat.isSymbolicLink() || mode & 0o002
    || (!groupWritePermitted && mode & 0o020)) {
    fail('autonomous_research_online_runtime_activation_database_unsafe');
  }
  return Object.freeze({
    device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode),
    links: String(stat.nlink), bytes: String(stat.size),
    modifiedNs: String(stat.mtimeNs), changedNs: String(stat.ctimeNs),
  });
}

export function openAutonomousResearchOnlineRuntimeActivationDatabase({
  runtimeRoot,
  instance,
}) {
  const root = path.resolve(runtimeRoot);
  const candidate = path.resolve(root, String(instance?.sourceRelativePath || ''));
  if (!instance?.sourceRelativePath
    || !pathWithin(root, candidate)
    || !fs.existsSync(candidate)
    || !pathWithin(fs.realpathSync(root), fs.realpathSync(candidate))
    || JSON.stringify(fileIdentity(candidate, { databaseRole: instance.role }))
      !== JSON.stringify(instance.sourceFileIdentity)) {
    fail('autonomous_research_online_runtime_activation_database_identity_changed');
  }
  return new DatabaseSync(candidate);
}

function validateInventory(inventory, manifest) {
  let inventoryHash;
  try { inventoryHash = autonomousResearchStateDatabaseInventoryHash(inventory); }
  catch { fail('autonomous_research_online_runtime_activation_inventory_invalid'); }
  const roles = inventory.instances.map((entry) => entry.role);
  const instanceIds = inventory.instances.map((entry) => entry.instanceId);
  let scopeHash;
  try { scopeHash = autonomousResearchStateDatabaseScopeHash(inventory.instances); }
  catch { fail('autonomous_research_online_runtime_activation_inventory_invalid'); }
  if (inventory.status !== 'autonomous_research_state_database_inventory_ready'
    || inventory.manifestId !== 'hepta-paper-autonomous-research-state-databases-v1'
    || inventory.inventoryHash !== inventoryHash
    || inventory.databaseScopeHash !== scopeHash
    || !Array.isArray(inventory.blockers)
    || inventory.blockers.length !== 0
    || inventory.instances.length !== AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length
    || new Set(instanceIds).size !== instanceIds.length
    || new Set(roles).size !== roles.length
    || [...roles].sort().join('\0')
      !== [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort().join('\0')
    || [...instanceIds].sort().join('\0') !== instanceIds.join('\0')
    || inventory.instances.some((entry) => (
      typeof entry?.instanceId !== 'string' || entry.instanceId.length === 0
      || typeof entry?.role !== 'string'
      || !AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.includes(entry.role)
      || typeof entry?.sourceRelativePath !== 'string'
      || entry.sourceRelativePath.length === 0
      || typeof entry?.schemaContractId !== 'string'
      || entry.schemaContractId.length === 0
      || !/^sha256:[0-9a-f]{64}$/.test(String(entry.schemaHash || ''))
      || entry.quickCheck !== 'ok'
      || entry.foreignKeyViolationCount !== 0
      || !Array.isArray(entry.missingSchemaObjects)
      || entry.missingSchemaObjects.length !== 0
    ))
    || manifest.coverage.coveredRoleCount !== manifest.coverage.requiredRoleCount
    || manifest.coverage.percent !== 100
    || manifest.coverage.coveredDatabaseRoles.join('\0')
      !== manifest.requiredDatabaseRoles.join('\0')) {
    fail('autonomous_research_online_runtime_activation_inventory_invalid');
  }
  return inventory;
}

function stableInventoryScope(left, right) {
  const project = (inventory) => inventory.instances.map((entry) => Object.freeze({
    role: entry.role,
    instanceId: entry.instanceId,
    sourceRelativePath: entry.sourceRelativePath,
    schemaContractId: entry.schemaContractId,
    schemaHash: entry.schemaHash,
    sourceSha256: entry.sourceSha256,
    sourceFileIdentity: entry.sourceFileIdentity,
    walSha256: entry.walSha256,
    walFileIdentity: entry.walFileIdentity,
    missingSchemaObjects: entry.missingSchemaObjects,
    quickCheck: entry.quickCheck,
    foreignKeyViolationCount: entry.foreignKeyViolationCount,
  })).sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  return left.databaseScopeHash === right.databaseScopeHash
    && JSON.stringify(project(left)) === JSON.stringify(project(right));
}

function configuredCoordinatorStatus(coordinator, manifest) {
  const checked = assertExternallyFencedSqliteMutationCoordinatorPort(coordinator);
  const status = checked.inspectStatus();
  if (checked.implemented !== true
    || status?.implemented !== true
    || status.status !== 'externally_fenced_sqlite_mutation_coordinator_configured'
    || status.coveredDatabaseRoles?.join('\0')
      !== manifest.coverage.coveredDatabaseRoles.join('\0')
    || status.blockers?.join('\0')
      !== 'autonomous_research_online_mutation_runtime_activation_required') {
    fail('autonomous_research_online_runtime_activation_coordinator_invalid');
  }
  return checked;
}

function readyCoordinatorStatus(coveredDatabaseRoles, activationReceiptHash) {
  return Object.freeze({
    version: 1,
    kind: 'ExternallyFencedSqliteMutationCoordinatorStatus',
    status: 'externally_fenced_sqlite_mutation_coordinator_ready',
    implemented: true,
    coveredDatabaseRoles,
    activationReceiptHash,
    blockers: Object.freeze([]),
  });
}

function createActivatedCoordinator(configuredCoordinator, coveredDatabaseRoles, receipt) {
  const checkedReceipt = assertAutonomousResearchOnlineRuntimeActivationReceipt(receipt);
  const status = readyCoordinatorStatus(
    coveredDatabaseRoles,
    checkedReceipt.activationReceiptHash,
  );
  return assertExternallyFencedSqliteMutationCoordinatorPort(Object.freeze({
    implemented: true,
    protocol: configuredCoordinator.protocol,
    coveredDatabaseRoles,
    executeMutation(input) { return configuredCoordinator.executeMutation(input); },
    recoverPendingMutations(input) {
      return configuredCoordinator.recoverPendingMutations(input);
    },
    inspectStatus() { return status; },
  }));
}

function withDatabase({ runtimeRoot, instance, openDatabase, action }) {
  const database = openDatabase({ runtimeRoot, instance });
  try { return action(database); }
  finally { database?.close?.(); }
}

function validateSchemaTransitionReadiness({
  readiness,
  inventory,
  manifest,
  clock,
}) {
  const payload = Object.fromEntries(Object.entries(readiness || {}).filter(([key]) => (
    key !== 'readinessReceiptHash'
  )));
  if (readiness?.version !== 1
    || readiness.kind !== 'AutonomousResearchOnlineSchemaTransitionReadyReceipt'
    || readiness.status !== 'autonomous_research_online_schema_transition_ready'
    || readiness.protocol !== AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL
    || readiness.databaseScopeHash !== inventory.databaseScopeHash
    || readiness.writerManifestHash
      !== autonomousResearchOnlineWriterOperationManifestHash(manifest)
    || readiness.inventoryHash !== inventory.inventoryHash
    || !/^sha256:[0-9a-f]{64}$/.test(String(readiness.schemaTransitionReceiptHash || ''))
    || !/^sha256:[0-9a-f]{64}$/.test(String(readiness.liveObservationReceiptHash || ''))
    || readiness.externalAuthorityVerified !== true
    || !Array.isArray(readiness.blockers)
    || readiness.blockers.length !== 0
    || !Number.isFinite(Date.parse(String(readiness.observedAt || '')))
    || !Number.isFinite(Date.parse(String(readiness.expiresAt || '')))
    || Date.parse(readiness.expiresAt) <= observedNow(clock).getTime()
    || readiness.readinessReceiptHash
      !== autonomousResearchOnlineSchemaTransitionReadyReceiptHash(payload)) {
    fail('autonomous_research_online_runtime_activation_schema_transition_required');
  }
  return readiness;
}

export function activateAutonomousResearchOnlineMutationRuntime({
  workspaceRoot,
  runtimeRoot,
  inventory,
  latestRestoreDrill,
  authorityProcessConfigurationPath,
  authorityConfigurationPath,
  configuredCoordinator,
  writerManifest,
  authorityClient,
  reconcileDatabaseStartup,
  inspectFinalizedDatabaseHead,
  refreshAuthorityEvidence,
  resolveInventory,
  inspectActiveEvidence = inspectAutonomousResearchOnlineMutationActiveEvidence,
  createAuthorityEvidenceCacheWriter =
    createAutonomousResearchOnlineAuthorityEvidenceCacheWriter,
  schemaTransitionReadiness,
  openDatabase = openAutonomousResearchOnlineRuntimeActivationDatabase,
  clock = { now: () => new Date() },
} = {}) {
  const manifest = assertAutonomousResearchOnlineWriterOperationManifest(writerManifest);
  validateInventory(inventory, manifest);
  const transitionReadiness = validateSchemaTransitionReadiness({
    readiness: schemaTransitionReadiness,
    inventory,
    manifest,
    clock,
  });
  const configured = configuredCoordinatorStatus(configuredCoordinator, manifest);
  if (!workspaceRoot || !runtimeRoot || !authorityProcessConfigurationPath
    || !authorityConfigurationPath
    || authorityClient?.trust?.writerManifestHash
      !== autonomousResearchOnlineWriterOperationManifestHash(manifest)
    || authorityClient.trust.databaseScopeHash !== inventory.databaseScopeHash
    || typeof reconcileDatabaseStartup !== 'function'
    || typeof inspectFinalizedDatabaseHead !== 'function'
    || typeof refreshAuthorityEvidence !== 'function'
    || typeof resolveInventory !== 'function'
    || typeof inspectActiveEvidence !== 'function'
    || typeof createAuthorityEvidenceCacheWriter !== 'function'
    || typeof openDatabase !== 'function') {
    fail('autonomous_research_online_runtime_activation_configuration_invalid');
  }
  const startupByInstance = new Map();
  for (const instance of inventory.instances) {
    const receipt = withDatabase({
      runtimeRoot,
      instance,
      openDatabase,
      action: (database) => reconcileDatabaseStartup({
        database,
        databaseRole: instance.role,
        databaseInstanceId: instance.instanceId,
        authorityClient,
        authorityTrust: authorityClient.trust,
        writerManifest: manifest,
        clock,
      }),
    });
    if (receipt?.status
        !== 'autonomous_research_online_mutation_unresolved_reservations_reconciled'
      || receipt.runtimeReady !== false
      || receipt.databaseRole !== instance.role
      || receipt.databaseInstanceId !== instance.instanceId) {
      fail('autonomous_research_online_runtime_activation_startup_reconciliation_invalid');
    }
    startupByInstance.set(instance.instanceId, receipt);
  }
  const currentInventory = validateInventory(resolveInventory(), manifest);
  if (!stableInventoryScope(inventory, currentInventory)) {
    fail('autonomous_research_online_runtime_activation_inventory_scope_changed');
  }
  const activeRefresh = refreshAuthorityEvidence({
    workspaceRoot,
    runtimeRoot,
    inventory: currentInventory,
    authorityProcessConfigurationPath,
    manifest,
    clock,
    createAuthorityClient: () => authorityClient,
    recordJournalEvidence: false,
  });
  if (activeRefresh?.status
      !== 'autonomous_research_online_mutation_active_refresh_complete'
    || activeRefresh.externalActionPerformed !== true
    || activeRefresh.journalRecorded !== false
    || activeRefresh.journalReceipt !== null) {
    fail('autonomous_research_online_runtime_activation_active_challenge_invalid');
  }
  const finalizedByInstance = new Map();
  for (const instance of currentInventory.instances) {
    const receipt = withDatabase({
      runtimeRoot,
      instance,
      openDatabase,
      action: (database) => inspectFinalizedDatabaseHead({
        database,
        databaseInstanceId: instance.instanceId,
        inventory: currentInventory,
        authorityClient,
        authorityTrust: authorityClient.trust,
        writerManifest: manifest,
        clock,
      }),
    });
    if (receipt?.status !== 'autonomous_research_online_finalized_head_reconciled'
      || receipt.runtimeReady !== false
      || receipt.databaseRole !== instance.role
      || receipt.databaseInstanceId !== instance.instanceId
      || receipt.authorityGlobalSequence !== activeRefresh.globalSequence
      || receipt.authorityGlobalHash !== activeRefresh.globalHash) {
      fail('autonomous_research_online_runtime_activation_finalized_head_invalid');
    }
    finalizedByInstance.set(instance.instanceId, receipt);
  }
  const provisionalStatus = readyCoordinatorStatus(
    manifest.coverage.coveredDatabaseRoles,
    null,
  );
  const activeInspection = inspectActiveEvidence({
    workspaceRoot,
    inventory: currentInventory,
    authorityConfigurationPath,
    now: observedNow(clock),
    coordinatorStatus: provisionalStatus,
    activeRefreshReceipt: activeRefresh,
    manifest,
  });
  const safety = evaluateAutonomousResearchStateSafetyReadiness({
    inventory: currentInventory,
    latestRestoreDrill,
    onlineAntiRollback: activeInspection,
    now: observedNow(clock),
  });
  if (safety.ready !== true || safety.blockers.length !== 0) {
    fail('autonomous_research_online_runtime_activation_state_safety_required', {
      blockers: safety.blockers,
    });
  }
  const evidenceExpiry = Math.min(...[
    activeInspection.currentHeadReceipt?.expiresAt,
    activeInspection.activeChallengeReceipt?.expiresAt,
    activeInspection.writerCoverage?.brokerScopeReceipt?.expiresAt,
  ].map((value) => Date.parse(String(value || ''))));
  if (!Number.isFinite(evidenceExpiry) || evidenceExpiry <= observedNow(clock).getTime()) {
    fail('autonomous_research_online_runtime_activation_evidence_cache_invalid');
  }
  const evidenceCacheReceipt = createAuthorityEvidenceCacheWriter({
    runtimeRoot,
  }).recordActiveAuthorityEvidence({
    activeRefreshReceipt: activeRefresh,
    databaseScopeHash: currentInventory.databaseScopeHash,
    writerManifestHash: authorityClient.trust.writerManifestHash,
    expiresAt: new Date(evidenceExpiry).toISOString(),
  });
  if (evidenceCacheReceipt?.status
      !== 'autonomous_research_online_authority_evidence_cache_recorded'
    || evidenceCacheReceipt.cacheRelativePath
      !== AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_RELATIVE_PATH
    || evidenceCacheReceipt.cacheContractHash
      !== AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_CONTRACT_HASH
    || evidenceCacheReceipt.activeRefreshReceiptHash !== hashRecord(
      'AutonomousResearchOnlineMutationActiveRefreshReceipt',
      activeRefresh,
    )
    || evidenceCacheReceipt.recordedAt !== activeRefresh.recordedAt) {
    fail('autonomous_research_online_runtime_activation_evidence_cache_invalid');
  }
  const evidenceCacheReceiptHash = hashRecord(
    'AutonomousResearchOnlineAuthorityEvidenceCacheWriteReceipt',
    evidenceCacheReceipt,
  );
  const inventoryAfterCacheWrite = validateInventory(resolveInventory(), manifest);
  if (inventoryAfterCacheWrite.inventoryHash !== currentInventory.inventoryHash
    || !stableInventoryScope(currentInventory, inventoryAfterCacheWrite)) {
    fail('autonomous_research_online_runtime_activation_cache_mutated_state_inventory');
  }
  const currentEvidence = activeRefresh.authorityEvidence?.currentHead?.receipt;
  const databaseActivations = Object.freeze(currentInventory.instances.map((instance) => {
    const startup = startupByInstance.get(instance.instanceId);
    const finalized = finalizedByInstance.get(instance.instanceId);
    return Object.freeze({
      databaseRole: instance.role,
      databaseInstanceId: instance.instanceId,
      schemaContractId: instance.schemaContractId,
      schemaHash: instance.schemaHash,
      startupReconciliationReceiptHash: hashRecord(
        'AutonomousResearchOnlineMutationUnresolvedReservationReconciliationReceipt',
        startup,
      ),
      finalizedHeadInspectionReceiptHash: finalized.inspectionReceiptHash,
      databaseSequence: finalized.localDatabaseSequence,
      databaseHash: finalized.localDatabaseHash,
      stateHash: finalized.localStateHash,
    });
  }).sort((a, b) => a.databaseInstanceId.localeCompare(b.databaseInstanceId)));
  const base = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineRuntimeActivationReceipt',
    status: 'autonomous_research_online_mutation_runtime_activated',
    protocol: configured.protocol,
    inventoryHash: currentInventory.inventoryHash,
    databaseScopeHash: currentInventory.databaseScopeHash,
    writerManifestHash: authorityClient.trust.writerManifestHash,
    authorityId: currentEvidence.authorityId,
    keyId: currentEvidence.keyId,
    authorityGlobalSequence: activeRefresh.globalSequence,
    authorityGlobalHash: activeRefresh.globalHash,
    databaseActivations,
    activeRefreshReceiptHash: hashRecord(
      'AutonomousResearchOnlineMutationActiveRefreshReceipt', activeRefresh,
    ),
    authorityEvidenceCacheReceiptHash: evidenceCacheReceiptHash,
    restoreDrillReceiptHash: latestRestoreDrill.restoreDrillReceiptHash,
    schemaTransitionReceiptHash: transitionReadiness.schemaTransitionReceiptHash,
    activatedAt: observedNow(clock).toISOString(),
    coordinatorRuntimeReady: true,
    remainingBlockers: Object.freeze([]),
  });
  const receipt = assertAutonomousResearchOnlineRuntimeActivationReceipt(Object.freeze({
    ...base,
    activationReceiptHash: autonomousResearchOnlineRuntimeActivationReceiptHash(base),
  }));
  return Object.freeze({
    receipt,
    coordinator: createActivatedCoordinator(
      configured,
      manifest.coverage.coveredDatabaseRoles,
      receipt,
    ),
    inventory: currentInventory,
    activeInspection,
    stateSafetyInspection: safety,
    authorityEvidenceCacheReceipt: evidenceCacheReceipt,
  });
}

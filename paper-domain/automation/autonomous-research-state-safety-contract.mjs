import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
  autonomousResearchStateDatabaseInventoryHash,
  autonomousResearchStateDatabaseScopeHash,
} from './autonomous-research-state-backup-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ONLINE_PROTOCOL = 'external-linearizable-reserve-apply-finalize-v1';
const ONLINE_INSPECTION_SOURCE = 'pinned-external-authority-receipt-verifier-v1';
const PINNED_SIGNATURE_VERIFIER = 'pinned-external-authority-public-key-v1';
const PASSIVE_INSPECTION_MODE = 'passive-signed-receipt-validation';
const ACTIVE_INSPECTION_MODE = 'active-external-authority-challenge';
const WRITER_COVERAGE_KIND = 'AutonomousResearchOnlineWriterCoverageInspection';
const WRITER_MANIFEST_KIND = 'AutonomousResearchOnlineWriterCoverageManifest';
const CANONICAL_STATE_MANIFEST_ID =
  'hepta-paper-autonomous-research-state-databases-v1';
const FINALIZED_JOURNAL_PROTOCOL =
  'external-linearizable-finalized-mutation-journal-v1';

export const AUTONOMOUS_RESEARCH_ONLINE_ANTI_ROLLBACK_COORDINATOR_DEPLOYMENT_BLOCKER =
  'autonomous_research_online_anti_rollback_coordinator_deployment_not_ready';
export const AUTONOMOUS_RESEARCH_ONLINE_ANTI_ROLLBACK_COORDINATOR_LEGACY_BLOCKER =
  'autonomous_research_online_anti_rollback_coordinator_not_implemented';

export const AUTONOMOUS_RESEARCH_STATE_SAFETY_BLOCKER_CODE_COMPATIBILITY = Object.freeze({
  version: 1,
  kind: 'AutonomousResearchStateSafetyBlockerCodeCompatibility',
  aliases: Object.freeze([
    Object.freeze({
      canonicalCode:
        AUTONOMOUS_RESEARCH_ONLINE_ANTI_ROLLBACK_COORDINATOR_DEPLOYMENT_BLOCKER,
      legacyAliasCode:
        AUTONOMOUS_RESEARCH_ONLINE_ANTI_ROLLBACK_COORDINATOR_LEGACY_BLOCKER,
      appliesToReportVersions: Object.freeze([1]),
      disposition: 'deprecated_read_compatibility_alias',
    }),
  ]),
});

export function expandAutonomousResearchStateSafetyBlockerCodeCompatibility(
  blockers = [],
) {
  if (!Array.isArray(blockers)
    || blockers.some((code) => typeof code !== 'string' || code.length === 0)) {
    throw new Error('autonomous_research_state_safety_blocker_codes_invalid');
  }
  const expanded = new Set(blockers);
  for (const alias of
    AUTONOMOUS_RESEARCH_STATE_SAFETY_BLOCKER_CODE_COMPATIBILITY.aliases) {
    if (expanded.has(alias.canonicalCode) || expanded.has(alias.legacyAliasCode)) {
      expanded.add(alias.canonicalCode);
      expanded.add(alias.legacyAliasCode);
    }
  }
  return Object.freeze([...expanded].sort());
}

export const AUTONOMOUS_RESEARCH_STATE_RESTORE_DRILL_MAXIMUM_AGE_MS =
  24 * 60 * 60 * 1000;

export const AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES = Object.freeze(
  [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort(),
);

function unique(values) {
  return [...new Set(values)];
}

function validDate(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function explicitNow(now) {
  const milliseconds = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error('autonomous_research_state_safety_now_required');
  }
  return milliseconds;
}

function sameValues(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function coveredRoles(records, roleSelector) {
  const allowed = new Set(AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES);
  return unique((Array.isArray(records) ? records : [])
    .map(roleSelector)
    .filter((role) => allowed.has(role)))
    .sort();
}

function restoredDatabaseRole(source) {
  const prefix = 'autonomous_state_database:';
  if (typeof source?.role !== 'string' || !source.role.startsWith(prefix)) return null;
  return source.role.slice(prefix.length).split(':')[0] || null;
}

function restoredDatabaseInstanceId(source) {
  const prefix = 'autonomous_state_database:';
  if (typeof source?.role !== 'string' || !source.role.startsWith(prefix)) return null;
  return source.role.slice(prefix.length) || null;
}

function inspectCanonicalInventoryEvidence(inventory) {
  const roles = coveredRoles(inventory?.instances, (entry) => entry?.role);
  const instanceIds = (Array.isArray(inventory?.instances) ? inventory.instances : [])
    .map((entry) => entry?.instanceId)
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .sort();
  const databaseBindings = (Array.isArray(inventory?.instances) ? inventory.instances : [])
    .map((entry) => Object.freeze({
      databaseRole: entry?.role || null,
      databaseInstanceId: entry?.instanceId || null,
      schemaHash: entry?.schemaHash || null,
    }))
    .sort((left, right) => String(left.databaseInstanceId)
      .localeCompare(String(right.databaseInstanceId)));
  let scopeHashVerified = false;
  let inventoryHashVerified = false;
  try {
    scopeHashVerified = autonomousResearchStateDatabaseScopeHash(inventory.instances)
      === inventory.databaseScopeHash;
  } catch {
    scopeHashVerified = false;
  }
  try {
    inventoryHashVerified = autonomousResearchStateDatabaseInventoryHash(inventory)
      === inventory.inventoryHash;
  } catch {
    inventoryHashVerified = false;
  }
  const exactShape = hasExactObjectKeys(inventory, [
    'version', 'kind', 'status', 'manifestId', 'manifestHash',
    'databaseScopeHash', 'instances', 'blockers', 'inventoryHash',
  ]);
  const ready = Boolean(
    exactShape
    && inventory.version === 1
    && inventory.kind === 'AutonomousResearchStateDatabaseInventory'
    && inventory.status === 'autonomous_research_state_database_inventory_ready'
    && inventory.manifestId === CANONICAL_STATE_MANIFEST_ID
    && SHA256.test(String(inventory.manifestHash || ''))
    && SHA256.test(String(inventory.databaseScopeHash || ''))
    && SHA256.test(String(inventory.inventoryHash || ''))
    && Array.isArray(inventory.blockers)
    && inventory.blockers.length === 0
    && roles.length === AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length
    && instanceIds.length === inventory.instances.length
    && new Set(instanceIds).size === instanceIds.length
    && scopeHashVerified
    && inventoryHashVerified,
  );
  return Object.freeze({
    ready,
    roles: Object.freeze(roles),
    instanceIds: Object.freeze(instanceIds),
    databaseBindings: Object.freeze(databaseBindings),
    manifestId: inventory?.manifestId || null,
    manifestHash: inventory?.manifestHash || null,
    inventoryHash: inventory?.inventoryHash || null,
    databaseScopeHash: inventory?.databaseScopeHash || null,
    scopeHashVerified,
    inventoryHashVerified,
  });
}

function inspectCanonicalRestoreEvidence({ latestRestoreDrill, inventory, now }) {
  const restoredRoles = coveredRoles(
    latestRestoreDrill?.sources,
    restoredDatabaseRole,
  );
  const restoredInstanceIds = (Array.isArray(latestRestoreDrill?.sources)
    ? latestRestoreDrill.sources : [])
    .map(restoredDatabaseInstanceId)
    .filter(Boolean)
    .sort();
  const performedAt = validDate(latestRestoreDrill?.restoreDrillPerformedAt);
  const fresh = performedAt !== null
    && performedAt <= now
    && now - performedAt <= AUTONOMOUS_RESEARCH_STATE_RESTORE_DRILL_MAXIMUM_AGE_MS;
  const legacyExactShape = hasExactObjectKeys(latestRestoreDrill, [
    'version', 'kind', 'status', 'bundlePath', 'manifestId', 'manifestHash',
    'bundleManifestHash', 'snapshotContentHash', 'inventoryHash',
    'databaseScopeHash', 'databaseInstanceIds', 'restoreDrillReceiptHash',
    'restoreDrillPerformedAt', 'authorityId', 'keyId', 'headSequence',
    'headHash', 'sources', 'skippedCandidates', 'blockers',
  ]);
  const snapshotExactShape = hasExactObjectKeys(latestRestoreDrill, [
    'version', 'kind', 'status', 'bundlePath', 'manifestId', 'manifestHash',
    'bundleManifestHash', 'snapshotContentHash', 'snapshotCreatedAt', 'inventoryHash',
    'databaseScopeHash', 'databaseInstanceIds', 'restoreDrillReceiptHash',
    'restoreDrillPerformedAt', 'authorityId', 'keyId', 'headSequence',
    'headHash', 'sources', 'skippedCandidates', 'blockers',
  ]);
  const journalExactShape = hasExactObjectKeys(latestRestoreDrill, [
    'version', 'kind', 'status', 'bundlePath', 'manifestId', 'manifestHash',
    'bundleManifestHash', 'snapshotContentHash', 'snapshotCreatedAt', 'inventoryHash',
    'databaseScopeHash', 'databaseInstanceIds', 'restoreDrillReceiptHash',
    'restoreDrillPerformedAt', 'authorityId', 'keyId', 'headSequence',
    'headHash', 'recoverabilityProtocol', 'recoverabilityBindingHash',
    'completeFinalizedMutationJournal', 'journalReplayMutationCount',
    'journalRangeReceiptHash', 'recoveredDatabaseHeads',
    'sources', 'skippedCandidates', 'blockers',
  ]);
  const journalRecovery = latestRestoreDrill?.recoverabilityProtocol
      === FINALIZED_JOURNAL_PROTOCOL
    && latestRestoreDrill?.completeFinalizedMutationJournal === true
    && Number.isSafeInteger(latestRestoreDrill?.journalReplayMutationCount)
    && latestRestoreDrill.journalReplayMutationCount > 0
    && SHA256.test(String(latestRestoreDrill?.journalRangeReceiptHash || ''))
    && SHA256.test(String(latestRestoreDrill?.recoverabilityBindingHash || ''))
    && Array.isArray(latestRestoreDrill?.recoveredDatabaseHeads)
    && JSON.stringify(latestRestoreDrill.recoveredDatabaseHeads.map((head) => ({
      databaseRole: head?.databaseRole || null,
      databaseInstanceId: head?.databaseInstanceId || null,
      schemaHash: head?.schemaHash || null,
    })))
      === JSON.stringify(inventory.databaseBindings);
  const exactSnapshotRecovery = legacyExactShape || snapshotExactShape;
  const metadataValid = Boolean(
    (legacyExactShape || snapshotExactShape || journalExactShape)
    && latestRestoreDrill.version === 1
    && latestRestoreDrill.kind === 'AutonomousResearchStateBackupSourcesInspection'
    && latestRestoreDrill.status === 'autonomous_research_state_backup_sources_ready'
    && latestRestoreDrill.manifestId === CANONICAL_STATE_MANIFEST_ID
    && SHA256.test(String(latestRestoreDrill.manifestHash || ''))
    && SHA256.test(String(latestRestoreDrill.bundleManifestHash || ''))
    && SHA256.test(String(latestRestoreDrill.snapshotContentHash || ''))
    && (legacyExactShape
      || validDate(latestRestoreDrill.snapshotCreatedAt) !== null)
    && SHA256.test(String(latestRestoreDrill.inventoryHash || ''))
    && SHA256.test(String(latestRestoreDrill.databaseScopeHash || ''))
    && SHA256.test(String(latestRestoreDrill.restoreDrillReceiptHash || ''))
    && (journalRecovery || exactSnapshotRecovery)
    && typeof latestRestoreDrill.authorityId === 'string'
    && latestRestoreDrill.authorityId.length > 0
    && typeof latestRestoreDrill.keyId === 'string'
    && latestRestoreDrill.keyId.length > 0
    && Number.isSafeInteger(latestRestoreDrill.headSequence)
    && latestRestoreDrill.headSequence >= 0
    && SHA256.test(String(latestRestoreDrill.headHash || ''))
    && Array.isArray(latestRestoreDrill.skippedCandidates)
    && Array.isArray(latestRestoreDrill.blockers)
    && latestRestoreDrill.blockers.length === 0
    && restoredRoles.length === AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length
    && sameValues(
      [...(latestRestoreDrill.databaseInstanceIds || [])].sort(),
      restoredInstanceIds,
    )
  );
  const inventoryBindingVerified = Boolean(
    inventory.ready
    && metadataValid
    && latestRestoreDrill.manifestId === inventory.manifestId
    && latestRestoreDrill.manifestHash === inventory.manifestHash
    && latestRestoreDrill.databaseScopeHash === inventory.databaseScopeHash
    && sameValues(restoredInstanceIds, inventory.instanceIds)
    && (latestRestoreDrill.inventoryHash === inventory.inventoryHash || journalRecovery)
  );
  return Object.freeze({
    ready: metadataValid && fresh && inventoryBindingVerified,
    metadataValid,
    fresh,
    inventoryBindingVerified,
    roles: Object.freeze(restoredRoles),
    instanceIds: Object.freeze(restoredInstanceIds),
    performedAt: performedAt === null ? null : new Date(performedAt).toISOString(),
  });
}

function assertWriterCoverageManifest(manifest) {
  if (manifest?.version !== 1
    || manifest?.kind !== WRITER_MANIFEST_KIND
    || !sameValues(
      [...(manifest.requiredDatabaseRoles || [])].sort(),
      AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES,
    )
    || !Array.isArray(manifest.writers)) {
    throw new Error('autonomous_research_online_writer_coverage_manifest_invalid');
  }
  const writerIds = [];
  for (const writer of manifest.writers) {
    const databaseRoles = [...(writer?.databaseRoles || [])].sort();
    if (typeof writer?.writerId !== 'string'
      || writer.writerId.length === 0
      || !SHA256.test(String(writer?.implementationHash || ''))
      || writer?.protocol !== ONLINE_PROTOCOL
      || databaseRoles.length === 0
      || new Set(databaseRoles).size !== databaseRoles.length
      || databaseRoles.some((role) => (
        !AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES.includes(role)
      ))) {
      throw new Error('autonomous_research_online_writer_coverage_writer_invalid');
    }
    writerIds.push(writer.writerId);
  }
  if (new Set(writerIds).size !== writerIds.length) {
    throw new Error('autonomous_research_online_writer_coverage_writer_duplicate');
  }
  return manifest;
}

export function autonomousResearchOnlineWriterCoverageManifestHash(manifest) {
  return hashRecord(
    WRITER_MANIFEST_KIND,
    assertWriterCoverageManifest(manifest),
  );
}

function signedReceiptCurrent(receipt, timeField, now) {
  const observedAt = validDate(receipt?.[timeField]);
  const expiresAt = validDate(receipt?.expiresAt);
  return Boolean(
    typeof receipt?.authorityId === 'string'
    && receipt.authorityId.length > 0
    && typeof receipt?.keyId === 'string'
    && receipt.keyId.length > 0
    && Number.isSafeInteger(receipt?.sequence)
    && receipt.sequence >= 0
    && SHA256.test(String(receipt?.hash || ''))
    && SHA256.test(String(receipt?.receiptHash || ''))
    && receipt?.signatureVerified === true
    && receipt?.verificationSource === PINNED_SIGNATURE_VERIFIER
    && observedAt !== null
    && expiresAt !== null
    && observedAt <= now
    && expiresAt > now,
  );
}

function sameAuthorityHead(left, right) {
  return Boolean(
    left && right
    && left.authorityId === right.authorityId
    && left.keyId === right.keyId
    && left.sequence === right.sequence
    && left.hash === right.hash,
  );
}

export function inspectAutonomousResearchOnlineWriterCoverage({
  candidate,
  authorityHead,
  now,
} = {}) {
  const currentTime = explicitNow(now);
  let manifestValid = false;
  let manifestHash = null;
  let coveredDatabaseRoles = [];
  try {
    manifestHash = autonomousResearchOnlineWriterCoverageManifestHash(candidate?.manifest);
    manifestValid = candidate?.manifestHash === manifestHash;
    coveredDatabaseRoles = unique(candidate.manifest.writers
      .flatMap((writer) => writer.databaseRoles))
      .sort();
  } catch {
    manifestValid = false;
  }
  const requiredDatabaseRoleCount =
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES.length;
  const coveredDatabaseRoleCount = coveredDatabaseRoles.length;
  const staticInspection = candidate?.staticInspection || null;
  const brokerScopeReceipt = candidate?.brokerScopeReceipt || null;
  const staticCoverageVerified = Boolean(
    manifestValid
    && staticInspection?.version === 1
    && staticInspection?.kind === 'AutonomousResearchOnlineWriterStaticCoverageInspection'
    && staticInspection?.status === 'autonomous_research_online_writer_static_coverage_complete'
    && staticInspection?.inspectionSource === 'repository-ast-import-gate-v1'
    && staticInspection?.manifestHash === manifestHash
    && sameValues(
      [...(staticInspection?.coveredDatabaseRoles || [])].sort(),
      coveredDatabaseRoles,
    )
    && SHA256.test(String(staticInspection?.astGateReceiptHash || ''))
    && SHA256.test(String(staticInspection?.codeProvenanceHash || '')),
  );
  const brokerScopeCurrent = signedReceiptCurrent(
    brokerScopeReceipt,
    'observedAt',
    currentTime,
  );
  const brokerScopeVerified = Boolean(
    manifestValid
    && brokerScopeReceipt?.version === 1
    && brokerScopeReceipt?.kind === 'AutonomousResearchOnlineWriterBrokerScopeReceipt'
    && brokerScopeReceipt?.status === 'autonomous_research_online_writer_broker_scope_complete'
    && brokerScopeReceipt?.manifestHash === manifestHash
    && sameValues(
      [...(brokerScopeReceipt?.coveredDatabaseRoles || [])].sort(),
      coveredDatabaseRoles,
    )
    && brokerScopeReceipt?.sequence === authorityHead?.sequence
    && brokerScopeReceipt?.hash === authorityHead?.hash
    && brokerScopeCurrent,
  );
  const coverageComplete = Boolean(
    candidate?.version === 1
    && candidate?.kind === WRITER_COVERAGE_KIND
    && candidate?.status === 'autonomous_research_online_writer_coverage_complete'
    && manifestValid
    && coveredDatabaseRoleCount === requiredDatabaseRoleCount
    && staticCoverageVerified
    && brokerScopeVerified,
  );
  return Object.freeze({
    manifestValid,
    manifestHash: manifestValid ? manifestHash : null,
    requiredDatabaseRoleCount,
    coveredDatabaseRoleCount,
    coveredDatabaseRoles: Object.freeze(coveredDatabaseRoles),
    coveragePercent: Number((coveredDatabaseRoleCount * 100
      / requiredDatabaseRoleCount).toFixed(2)),
    staticCoverageVerified,
    brokerScopeVerified,
    coverageComplete,
  });
}

function inspectOnlineAntiRollbackEvidence(candidate, now) {
  const currentTime = explicitNow(now);
  const currentHeadReceipt = candidate?.currentHeadReceipt || null;
  const activeChallengeReceipt = candidate?.activeChallengeReceipt || null;
  const coordinatorImplemented = candidate?.version === 1
    && candidate?.kind === 'AutonomousResearchOnlineAntiRollbackInspection'
    && candidate?.inspectionSource === ONLINE_INSPECTION_SOURCE
    && [PASSIVE_INSPECTION_MODE, ACTIVE_INSPECTION_MODE].includes(candidate?.inspectionMode)
    && candidate?.externalActionPerformed === (candidate?.inspectionMode === ACTIVE_INSPECTION_MODE);
  const currentHeadReceiptVerified = currentHeadReceipt?.status
      === 'autonomous_research_online_authority_head_current'
    && signedReceiptCurrent(currentHeadReceipt, 'observedAt', currentTime);
  const recentActiveChallengeVerified = activeChallengeReceipt?.status
      === 'autonomous_research_online_authority_active_challenge_verified'
    && signedReceiptCurrent(activeChallengeReceipt, 'challengedAt', currentTime);
  const sameVerifiedHead = currentHeadReceiptVerified
    && recentActiveChallengeVerified
    && sameAuthorityHead(currentHeadReceipt, activeChallengeReceipt);
  const liveExternalAuthorityVerified = Boolean(
    coordinatorImplemented
    && candidate?.status === 'autonomous_research_online_anti_rollback_ready'
    && candidate?.protocol === ONLINE_PROTOCOL
    && sameVerifiedHead,
  );
  const writerInspection = inspectAutonomousResearchOnlineWriterCoverage({
    candidate: candidate?.writerCoverage,
    authorityHead: currentHeadReceipt,
    now,
  });
  return Object.freeze({
    coordinatorImplemented,
    currentHeadReceiptVerified,
    recentActiveChallengeVerified,
    sameVerifiedHead,
    liveExternalAuthorityVerified,
    authorityHeadCurrent: liveExternalAuthorityVerified,
    writerManifestHash: writerInspection.manifestHash,
    requiredWriterCount: writerInspection.requiredDatabaseRoleCount,
    coveredWriterCount: writerInspection.coveredDatabaseRoleCount,
    coveredWriterRoles: writerInspection.coveredDatabaseRoles,
    writerManifestCoveragePercent: writerInspection.coveragePercent,
    writerStaticCoverageVerified: writerInspection.staticCoverageVerified,
    writerBrokerScopeVerified: writerInspection.brokerScopeVerified,
    writerManifestComplete: liveExternalAuthorityVerified
      && writerInspection.coverageComplete,
  });
}

export function unavailableAutonomousResearchOnlineAntiRollbackInspection({
  writerManifest = null,
} = {}) {
  const manifest = writerManifest || Object.freeze({
    version: 1,
    kind: WRITER_MANIFEST_KIND,
    requiredDatabaseRoles: AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES,
    writers: Object.freeze([]),
  });
  const manifestHash = autonomousResearchOnlineWriterCoverageManifestHash(manifest);
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineAntiRollbackInspectionUnavailable',
    status: 'autonomous_research_online_anti_rollback_blocked',
    inspectionSource: null,
    inspectionMode: PASSIVE_INSPECTION_MODE,
    protocol: ONLINE_PROTOCOL,
    externalActionPerformed: false,
    currentHeadReceipt: null,
    activeChallengeReceipt: null,
    writerCoverage: Object.freeze({
      version: 1,
      kind: WRITER_COVERAGE_KIND,
      status: 'autonomous_research_online_writer_coverage_blocked',
      manifest,
      manifestHash,
      staticInspection: null,
      brokerScopeReceipt: null,
      blockers: Object.freeze([
        'autonomous_research_online_writer_manifest_100_percent_required',
      ]),
    }),
    blockerCodeCompatibility:
      AUTONOMOUS_RESEARCH_STATE_SAFETY_BLOCKER_CODE_COMPATIBILITY,
    blockers: expandAutonomousResearchStateSafetyBlockerCodeCompatibility([
      AUTONOMOUS_RESEARCH_ONLINE_ANTI_ROLLBACK_COORDINATOR_DEPLOYMENT_BLOCKER,
      'autonomous_research_online_authority_head_current_required',
      'autonomous_research_online_authority_recent_active_challenge_required',
      'autonomous_research_online_writer_manifest_100_percent_required',
    ]),
  });
}

export function evaluateAutonomousResearchStateSafetyReadiness({
  inventory,
  latestRestoreDrill,
  onlineAntiRollback,
  now,
} = {}) {
  const currentTime = explicitNow(now);
  const inventoryEvidence = inspectCanonicalInventoryEvidence(inventory);
  const inventoryRoles = inventoryEvidence.roles;
  const requiredDatabaseRoleCount = AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length;
  const inventoryRoleCoverageComplete = inventoryEvidence.ready;
  const restoreEvidence = inspectCanonicalRestoreEvidence({
    latestRestoreDrill,
    inventory: inventoryEvidence,
    now: currentTime,
  });
  const restoredRoles = restoreEvidence.roles;
  const latestValidRestoreDrillReady = restoreEvidence.ready;
  const onlineInspection = onlineAntiRollback
    || unavailableAutonomousResearchOnlineAntiRollbackInspection();
  const online = inspectOnlineAntiRollbackEvidence(onlineInspection, now);
  const prerequisitesReady = inventoryRoleCoverageComplete
    && latestValidRestoreDrillReady
    && online.liveExternalAuthorityVerified
    && online.authorityHeadCurrent
    && online.writerManifestComplete;
  const blockers = [
    ...(inventoryRoleCoverageComplete
      ? [] : [`autonomous_research_state_database_inventory_${requiredDatabaseRoleCount}_of_${requiredDatabaseRoleCount}_required`]),
    ...(!inventoryEvidence.scopeHashVerified
      ? ['autonomous_research_state_database_inventory_scope_hash_invalid'] : []),
    ...(!inventoryEvidence.inventoryHashVerified
      ? ['autonomous_research_state_database_inventory_hash_invalid'] : []),
    ...(Array.isArray(inventory?.blockers) ? inventory.blockers : []),
    ...(latestValidRestoreDrillReady
      ? [] : ['autonomous_research_state_latest_valid_restore_drill_required']),
    ...(!restoreEvidence.metadataValid
      ? ['autonomous_research_state_restore_canonical_metadata_required'] : []),
    ...(!restoreEvidence.fresh
      ? ['autonomous_research_state_restore_drill_freshness_required'] : []),
    ...(!restoreEvidence.inventoryBindingVerified
      ? ['autonomous_research_state_restore_current_inventory_binding_required'] : []),
    ...(Array.isArray(latestRestoreDrill?.blockers)
      ? latestRestoreDrill.blockers : []),
    ...(!online.coordinatorImplemented
      ? [AUTONOMOUS_RESEARCH_ONLINE_ANTI_ROLLBACK_COORDINATOR_DEPLOYMENT_BLOCKER] : []),
    ...(!online.currentHeadReceiptVerified
      ? ['autonomous_research_online_authority_head_current_required'] : []),
    ...(!online.recentActiveChallengeVerified
      ? ['autonomous_research_online_authority_recent_active_challenge_required'] : []),
    ...(!online.sameVerifiedHead
      ? ['autonomous_research_online_authority_receipts_same_head_required'] : []),
    ...(!online.writerStaticCoverageVerified
      ? ['autonomous_research_online_writer_static_coverage_required'] : []),
    ...(!online.writerBrokerScopeVerified
      ? ['autonomous_research_online_writer_broker_scope_required'] : []),
    ...(!online.writerManifestComplete
      ? ['autonomous_research_online_writer_manifest_100_percent_required'] : []),
    ...(onlineInspection?.blockers || []),
  ];
  const compatibleBlockers =
    expandAutonomousResearchStateSafetyBlockerCodeCompatibility(blockers);
  const ready = prerequisitesReady && compatibleBlockers.length === 0;
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateSafetyInspection',
    status: ready
      ? 'autonomous_research_state_safety_ready'
      : 'autonomous_research_state_safety_blocked',
    ready,
    requiredDatabaseRoleCount,
    inventoryCoveredRoleCount: inventoryRoles.length,
    inventoryCoveredRoles: Object.freeze(inventoryRoles),
    inventoryRoleCoverageComplete,
    latestRestoreDrillCoveredRoleCount: restoredRoles.length,
    latestRestoreDrillCoveredRoles: Object.freeze(restoredRoles),
    latestValidRestoreDrillReady,
    onlineAntiRollbackCoordinatorImplemented: online.coordinatorImplemented,
    liveExternalAuthorityVerified: online.liveExternalAuthorityVerified,
    currentHeadReceiptVerified: online.currentHeadReceiptVerified,
    recentActiveChallengeVerified: online.recentActiveChallengeVerified,
    onlineAuthorityHeadCurrent: online.authorityHeadCurrent,
    writerManifestHash: online.writerManifestHash,
    requiredWriterCount: online.requiredWriterCount,
    coveredWriterCount: online.coveredWriterCount,
    coveredWriterRoles: online.coveredWriterRoles,
    writerManifestCoveragePercent: online.writerManifestCoveragePercent,
    writerStaticCoverageVerified: online.writerStaticCoverageVerified,
    writerBrokerScopeVerified: online.writerBrokerScopeVerified,
    writerManifestComplete: online.writerManifestComplete,
    statusReadOnly: onlineInspection.externalActionPerformed !== true,
    externalActionPerformed: onlineInspection.externalActionPerformed === true,
    inventory: Object.freeze({
      version: inventory?.version || null,
      kind: inventory?.kind || null,
      status: inventory?.status || 'autonomous_research_state_database_inventory_blocked',
      manifestId: inventoryEvidence.manifestId,
      manifestHash: inventoryEvidence.manifestHash,
      inventoryHash: inventoryEvidence.inventoryHash,
      databaseScopeHash: inventoryEvidence.databaseScopeHash,
      databaseInstanceIds: inventoryEvidence.instanceIds,
      coveredDatabaseRoles: inventoryEvidence.roles,
      blockers: Object.freeze(Array.isArray(inventory?.blockers)
        ? [...inventory.blockers] : []),
    }),
    latestRestoreDrill: Object.freeze({
      version: latestRestoreDrill?.version || null,
      kind: latestRestoreDrill?.kind || null,
      status: latestRestoreDrill?.status
        || 'autonomous_research_state_backup_sources_blocked',
      manifestId: latestRestoreDrill?.manifestId || null,
      manifestHash: latestRestoreDrill?.manifestHash || null,
      bundleManifestHash: latestRestoreDrill?.bundleManifestHash || null,
      snapshotContentHash: latestRestoreDrill?.snapshotContentHash || null,
      snapshotCreatedAt: latestRestoreDrill?.snapshotCreatedAt || null,
      inventoryHash: latestRestoreDrill?.inventoryHash || null,
      databaseScopeHash: latestRestoreDrill?.databaseScopeHash || null,
      databaseInstanceIds: restoreEvidence.instanceIds,
      restoreDrillReceiptHash: latestRestoreDrill?.restoreDrillReceiptHash || null,
      restoreDrillPerformedAt: restoreEvidence.performedAt,
      authorityId: latestRestoreDrill?.authorityId || null,
      keyId: latestRestoreDrill?.keyId || null,
      headSequence: latestRestoreDrill?.headSequence ?? null,
      headHash: latestRestoreDrill?.headHash || null,
      coveredDatabaseRoles: restoreEvidence.roles,
      skippedCandidateCount: Array.isArray(latestRestoreDrill?.skippedCandidates)
        ? latestRestoreDrill.skippedCandidates.length : 0,
      blockers: Object.freeze(Array.isArray(latestRestoreDrill?.blockers)
        ? [...latestRestoreDrill.blockers] : []),
    }),
    onlineAntiRollback: onlineInspection,
    blockerCodeCompatibility:
      AUTONOMOUS_RESEARCH_STATE_SAFETY_BLOCKER_CODE_COMPATIBILITY,
    blockers: compatibleBlockers,
  });
}

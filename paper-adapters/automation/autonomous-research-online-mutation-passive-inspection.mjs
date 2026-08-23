
import {
  autonomousResearchOnlineMutationReceiptHash,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_VERIFICATION_SOURCE,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from './autonomous-research-online-writer-operation-manifest.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_ANTI_ROLLBACK_COORDINATOR_DEPLOYMENT_BLOCKER,
  AUTONOMOUS_RESEARCH_STATE_SAFETY_BLOCKER_CODE_COMPATIBILITY,
  expandAutonomousResearchStateSafetyBlockerCodeCompatibility,
} from '../../paper-domain/automation/autonomous-research-state-safety-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  createAutonomousResearchOnlineAuthorityEvidenceCacheReader,
} from './autonomous-research-online-authority-evidence-cache.mjs';
import {
  createAutonomousResearchOnlineMutationReceiptVerifier,
} from './autonomous-research-online-mutation-authority.mjs';
import {
  inspectAutonomousResearchOnlineWriterStaticCoverage,
} from './autonomous-research-online-writer-static-inspection.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fail(code) {
  throw new Error(code);
}

function expectedDatabaseInstances(inventory) {
  if (inventory?.status !== 'autonomous_research_state_database_inventory_ready'
    || !Array.isArray(inventory.instances)
    || inventory.instances.length !== AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length) {
    fail('autonomous_research_online_mutation_closed_inventory_required');
  }
  const rows = inventory.instances.map((instance) => Object.freeze({
    databaseRole: instance.role,
    databaseInstanceId: instance.instanceId,
    schemaHash: instance.schemaHash,
  })).sort((left, right) => left.databaseInstanceId.localeCompare(right.databaseInstanceId));
  if (new Set(rows.map((row) => row.databaseRole)).size !== rows.length
    || new Set(rows.map((row) => row.databaseInstanceId)).size !== rows.length
    || [...rows.map((row) => row.databaseRole)].sort().join('\0')
      !== [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort().join('\0')
    || rows.some((row) => (
    typeof row.databaseRole !== 'string'
    || typeof row.databaseInstanceId !== 'string'
    || !SHA256.test(String(row.schemaHash || ''))
    ))) {
    fail('autonomous_research_online_mutation_inventory_identity_invalid');
  }
  return Object.freeze(rows);
}

function sameHead(left, right) {
  return left.authorityId === right.authorityId
    && left.keyId === right.keyId
    && left.globalSequence === right.globalSequence
    && left.globalHash === right.globalHash;
}

function normalizedCurrentHead(receipt) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineAuthorityHeadReceipt',
    status: 'autonomous_research_online_authority_head_current',
    authorityId: receipt.authorityId,
    keyId: receipt.keyId,
    sequence: receipt.globalSequence,
    hash: receipt.globalHash,
    observedAt: receipt.observedAt,
    expiresAt: receipt.expiresAt,
    receiptHash: autonomousResearchOnlineMutationReceiptHash(receipt),
    signatureVerified: true,
    verificationSource: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_VERIFICATION_SOURCE,
  });
}

function normalizedActiveChallenge(receipt) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineAuthorityActiveChallengeReceipt',
    status: 'autonomous_research_online_authority_active_challenge_verified',
    authorityId: receipt.authorityId,
    keyId: receipt.keyId,
    sequence: receipt.globalSequence,
    hash: receipt.globalHash,
    challengedAt: receipt.challengedAt,
    expiresAt: receipt.expiresAt,
    receiptHash: autonomousResearchOnlineMutationReceiptHash(receipt),
    signatureVerified: true,
    verificationSource: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_VERIFICATION_SOURCE,
  });
}

function normalizedScope(receipt, staticInspection) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineWriterBrokerScopeReceipt',
    status: 'autonomous_research_online_writer_broker_scope_complete',
    manifestHash: receipt.writerManifestHash,
    coveredDatabaseRoles: Object.freeze([...receipt.coveredDatabaseRoles]),
    operationCount: receipt.operationCount,
    operationIds: Object.freeze([...receipt.operationIds]),
    astGateReceiptHash: receipt.astGateReceiptHash,
    codeProvenanceHash: receipt.codeProvenanceHash,
    authorityId: receipt.authorityId,
    keyId: receipt.keyId,
    sequence: receipt.globalSequence,
    hash: receipt.globalHash,
    observedAt: receipt.observedAt,
    expiresAt: receipt.expiresAt,
    receiptHash: autonomousResearchOnlineMutationReceiptHash(receipt),
    signatureVerified: true,
    verificationSource: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_VERIFICATION_SOURCE,
    localStaticInspectionMatched: receipt.astGateReceiptHash
      === staticInspection.astGateReceiptHash,
  });
}

function inspectEvidence({
  workspaceRoot,
  inventory,
  authorityConfigurationPath,
  now,
  coordinatorStatus = null,
  manifest = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  createReceiptVerifier = createAutonomousResearchOnlineMutationReceiptVerifier,
  evidence,
  inspectionMode,
  externalActionPerformed,
  journalSchemaContractHash = null,
} = {}) {
  if (!evidence?.currentHead || !evidence?.activeChallenge || !evidence?.brokerScope
    || !['passive-signed-receipt-validation', 'active-external-authority-challenge']
      .includes(inspectionMode)
    || externalActionPerformed !== (inspectionMode === 'active-external-authority-challenge')) {
    fail('autonomous_research_online_mutation_evidence_inspection_invalid');
  }
  const manifestHash = autonomousResearchOnlineWriterOperationManifestHash(manifest);
  const staticInspection = inspectAutonomousResearchOnlineWriterStaticCoverage({
    workspaceRoot,
    manifest,
  });
  if (staticInspection.status
      !== 'autonomous_research_online_writer_static_coverage_complete'
    || staticInspection.blockers.length !== 0) {
    fail('autonomous_research_online_writer_static_coverage_required');
  }
  const verifier = createReceiptVerifier({
    configurationPath: authorityConfigurationPath,
  });
  if (verifier.trust.writerManifestHash !== manifestHash
    || verifier.trust.databaseScopeHash !== inventory?.databaseScopeHash) {
    fail('autonomous_research_online_mutation_authority_scope_mismatch');
  }
  const expectedInstances = expectedDatabaseInstances(inventory);
  if (!verifier.verifyCurrentHead({
    ...evidence.currentHead,
    now,
    expectedDatabaseInstances: expectedInstances,
  })) {
    fail('autonomous_research_online_mutation_current_head_receipt_invalid');
  }
  if (!verifier.verifyActiveChallenge({
    ...evidence.activeChallenge,
    now,
    expectedDatabaseInstances: expectedInstances,
  })) {
    fail('autonomous_research_online_mutation_active_challenge_receipt_invalid');
  }
  if (!verifier.verifyScope({ ...evidence.brokerScope, now })) {
    fail('autonomous_research_online_mutation_scope_receipt_invalid');
  }
  const current = evidence.currentHead.receipt;
  const challenge = evidence.activeChallenge.receipt;
  const scope = evidence.brokerScope.receipt;
  const operationIds = manifest.operations.map((operation) => operation.operationId).sort();
  const coveredDatabaseRoles = Object.freeze([
    ...manifest.coverage.coveredDatabaseRoles,
  ]);
  const writerCoverageComplete = manifest.coverage.coveredRoleCount
    === manifest.coverage.requiredRoleCount
    && manifest.coverage.percent === 100;
  const coordinatorImplemented = coordinatorStatus?.implemented === true
    && coordinatorStatus.status === 'externally_fenced_sqlite_mutation_coordinator_ready'
    && Array.isArray(coordinatorStatus.coveredDatabaseRoles)
    && coordinatorStatus.coveredDatabaseRoles.join('\0')
      === coveredDatabaseRoles.join('\0')
    && Array.isArray(coordinatorStatus.blockers)
    && coordinatorStatus.blockers.length === 0;
  const onlineReady = writerCoverageComplete && coordinatorImplemented;
  if (!sameHead(current, challenge)
    || !sameHead(current, scope)
    || scope.staticInspectionReceiptHash !== staticInspection.astGateReceiptHash
    || scope.astGateReceiptHash !== staticInspection.astGateReceiptHash
    || scope.codeProvenanceHash !== staticInspection.codeProvenanceHash
    || scope.operationCount !== operationIds.length
    || scope.operationIds.join('\0') !== operationIds.join('\0')
    || scope.requiredDatabaseRoles.join('\0')
      !== manifest.requiredDatabaseRoles.join('\0')
    || scope.coveredDatabaseRoles.join('\0') !== coveredDatabaseRoles.join('\0')) {
    fail('autonomous_research_online_mutation_passive_evidence_binding_invalid');
  }
  const normalizedStaticInspection = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineWriterStaticCoverageInspection',
    status: 'autonomous_research_online_writer_static_coverage_complete',
    inspectionSource: 'repository-ast-import-gate-v1',
    manifestHash,
    coveredDatabaseRoles,
    operationCount: staticInspection.operationCount,
    operationIds: staticInspection.operationIds,
    astGateReceiptHash: staticInspection.astGateReceiptHash,
    codeProvenanceHash: staticInspection.codeProvenanceHash,
  });
  return Object.freeze({
    version: 1,
    kind: onlineReady
      ? 'AutonomousResearchOnlineAntiRollbackInspection'
      : 'AutonomousResearchOnlineAntiRollbackInspectionUnavailable',
    status: onlineReady
      ? 'autonomous_research_online_anti_rollback_ready'
      : 'autonomous_research_online_anti_rollback_blocked',
    inspectionSource: 'pinned-external-authority-receipt-verifier-v1',
    inspectionMode,
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    coordinatorImplementationStatus: coordinatorStatus?.status
      || 'unavailable-not-integrated',
    externalActionPerformed,
    currentHeadReceipt: normalizedCurrentHead(current),
    activeChallengeReceipt: normalizedActiveChallenge(challenge),
    writerCoverage: Object.freeze({
      version: 1,
      kind: 'AutonomousResearchOnlineWriterCoverageInspection',
      status: writerCoverageComplete
        ? 'autonomous_research_online_writer_coverage_complete'
        : 'autonomous_research_online_writer_coverage_blocked',
      manifest,
      manifestHash,
      staticInspection: normalizedStaticInspection,
      brokerScopeReceipt: normalizedScope(scope, staticInspection),
      blockers: Object.freeze(writerCoverageComplete ? [] : [
        'autonomous_research_online_writer_manifest_100_percent_required',
      ]),
    }),
    authorityConfigurationHash: verifier.configurationHash,
    journalSchemaContractHash,
    blockerCodeCompatibility:
      AUTONOMOUS_RESEARCH_STATE_SAFETY_BLOCKER_CODE_COMPATIBILITY,
    blockers: expandAutonomousResearchStateSafetyBlockerCodeCompatibility([
      ...(coordinatorImplemented
        ? [] : [
          AUTONOMOUS_RESEARCH_ONLINE_ANTI_ROLLBACK_COORDINATOR_DEPLOYMENT_BLOCKER,
        ]),
      ...(writerCoverageComplete
        ? [] : ['autonomous_research_online_writer_manifest_100_percent_required']),
    ]),
  });
}

export function inspectAutonomousResearchOnlineMutationPassiveEvidence({
  workspaceRoot,
  runtimeRoot,
  inventory,
  authorityConfigurationPath,
  now,
  coordinatorStatus = null,
  manifest = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  createReceiptVerifier = createAutonomousResearchOnlineMutationReceiptVerifier,
  createJournalReader = createAutonomousResearchOnlineAuthorityEvidenceCacheReader,
} = {}) {
  const journal = createJournalReader({
    runtimeRoot,
  }).readPassiveAuthorityEvidence({
    databaseScopeHash: inventory?.databaseScopeHash,
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(manifest),
    now,
  });
  if (journal.externalActionPerformed !== false) {
    fail('autonomous_research_online_mutation_passive_inspection_side_effect_forbidden');
  }
  return inspectEvidence({
    workspaceRoot,
    inventory,
    authorityConfigurationPath,
    now,
    coordinatorStatus,
    manifest,
    createReceiptVerifier,
    evidence: journal,
    inspectionMode: 'passive-signed-receipt-validation',
    externalActionPerformed: false,
    journalSchemaContractHash: journal.cacheContractHash,
  });
}

export function inspectAutonomousResearchOnlineMutationActiveEvidence({
  workspaceRoot,
  inventory,
  authorityConfigurationPath,
  now,
  coordinatorStatus = null,
  activeRefreshReceipt,
  manifest = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  createReceiptVerifier = createAutonomousResearchOnlineMutationReceiptVerifier,
} = {}) {
  if (activeRefreshReceipt?.status
      !== 'autonomous_research_online_mutation_active_refresh_complete'
    || activeRefreshReceipt.externalActionPerformed !== true
    || activeRefreshReceipt.journalRecorded !== false
    || activeRefreshReceipt.journalReceipt !== null) {
    fail('autonomous_research_online_mutation_active_evidence_required');
  }
  return inspectEvidence({
    workspaceRoot,
    inventory,
    authorityConfigurationPath,
    now,
    coordinatorStatus,
    manifest,
    createReceiptVerifier,
    evidence: activeRefreshReceipt.authorityEvidence,
    inspectionMode: 'active-external-authority-challenge',
    externalActionPerformed: true,
  });
}

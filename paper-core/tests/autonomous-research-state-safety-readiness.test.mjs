import assert from 'node:assert/strict';
import test from 'node:test';

import {
  autonomousResearchOnlineWriterCoverageManifestHash,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES,
  evaluateAutonomousResearchStateSafetyReadiness,
} from '../../paper-domain/automation/autonomous-research-state-safety-contract.mjs';
import {
  inspectAutonomousResearchStateSafety,
} from '../../paper-composition/automation/autonomous-research-state-safety-inspection.mjs';
import {
  autonomousResearchStateDatabaseInventoryHash,
  autonomousResearchStateDatabaseScopeHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('AutonomousResearchStateSafetyReadinessTest', { label });
const NOW = new Date('2026-07-18T08:00:00.000Z');

function closedInventory() {
  const instances = Object.freeze(
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES.map((role) => ({
      instanceId: role,
      role,
      sourceRelativePath: `autonomous-research/${role}.sqlite`,
    })),
  );
  const base = {
    version: 1,
    kind: 'AutonomousResearchStateDatabaseInventory',
    status: 'autonomous_research_state_database_inventory_ready',
    manifestId: 'hepta-paper-autonomous-research-state-databases-v1',
    manifestHash: H('state-manifest'),
    databaseScopeHash: autonomousResearchStateDatabaseScopeHash(instances),
    instances,
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...base,
    inventoryHash: autonomousResearchStateDatabaseInventoryHash(base),
  });
}

function latestRestoreDrill(inventory = closedInventory()) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateBackupSourcesInspection',
    status: 'autonomous_research_state_backup_sources_ready',
    bundlePath: '/evidence/bundle',
    manifestId: inventory.manifestId,
    manifestHash: inventory.manifestHash,
    bundleManifestHash: H('bundle'),
    snapshotContentHash: H('snapshot'),
    inventoryHash: inventory.inventoryHash,
    databaseScopeHash: inventory.databaseScopeHash,
    databaseInstanceIds: Object.freeze(inventory.instances
      .map((entry) => entry.instanceId).sort()),
    restoreDrillReceiptHash: H('restore-drill-receipt'),
    restoreDrillPerformedAt: '2026-07-18T07:59:00.000Z',
    authorityId: 'backup-authority',
    keyId: 'backup-key-1',
    headSequence: 17,
    headHash: H('backup-authority-head'),
    sources: Object.freeze([
      { role: 'autonomous_state_backup_manifest', path: '/evidence/manifest.json' },
      { role: 'autonomous_state_restore_drill_receipt', path: '/evidence/restore.json' },
      ...inventory.instances.map((entry) => ({
        role: `autonomous_state_database:${entry.instanceId}`,
        path: `/evidence/${entry.role}.sqlite`,
      })),
    ]),
    skippedCandidates: Object.freeze([]),
    blockers: Object.freeze([]),
  });
}

function onlineInspection({
  coveredRoles = AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES,
  inspectionMode = 'passive-signed-receipt-validation',
  activeHeadHash = H('authority-head'),
  activeExpiresAt = '2026-07-18T08:05:00.000Z',
} = {}) {
  const authorityHead = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineAuthorityHeadReceipt',
    status: 'autonomous_research_online_authority_head_current',
    authorityId: 'external-authority',
    keyId: 'external-key-1',
    sequence: 41,
    hash: H('authority-head'),
    observedAt: '2026-07-18T07:59:45.000Z',
    expiresAt: '2026-07-18T08:05:00.000Z',
    receiptHash: H('current-head-receipt'),
    signatureVerified: true,
    verificationSource: 'pinned-external-authority-public-key-v1',
  });
  const activeChallenge = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineAuthorityActiveChallengeReceipt',
    status: 'autonomous_research_online_authority_active_challenge_verified',
    authorityId: 'external-authority',
    keyId: 'external-key-1',
    sequence: 41,
    hash: activeHeadHash,
    challengedAt: '2026-07-18T07:59:30.000Z',
    expiresAt: activeExpiresAt,
    receiptHash: H('active-challenge-receipt'),
    signatureVerified: true,
    verificationSource: 'pinned-external-authority-public-key-v1',
  });
  const manifest = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineWriterCoverageManifest',
    requiredDatabaseRoles: AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES,
    writers: Object.freeze(coveredRoles.map((role) => Object.freeze({
      writerId: `writer:${role}`,
      databaseRoles: Object.freeze([role]),
      implementationHash: H(`writer:${role}`),
      protocol: 'external-linearizable-reserve-apply-finalize-v1',
    }))),
  });
  const manifestHash = autonomousResearchOnlineWriterCoverageManifestHash(manifest);
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineAntiRollbackInspection',
    status: 'autonomous_research_online_anti_rollback_ready',
    inspectionSource: 'pinned-external-authority-receipt-verifier-v1',
    inspectionMode,
    protocol: 'external-linearizable-reserve-apply-finalize-v1',
    externalActionPerformed: inspectionMode === 'active-external-authority-challenge',
    currentHeadReceipt: authorityHead,
    activeChallengeReceipt: activeChallenge,
    writerCoverage: Object.freeze({
      version: 1,
      kind: 'AutonomousResearchOnlineWriterCoverageInspection',
      status: 'autonomous_research_online_writer_coverage_complete',
      manifest,
      manifestHash,
      staticInspection: Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineWriterStaticCoverageInspection',
        status: 'autonomous_research_online_writer_static_coverage_complete',
        inspectionSource: 'repository-ast-import-gate-v1',
        manifestHash,
        coveredDatabaseRoles: Object.freeze([...coveredRoles].sort()),
        astGateReceiptHash: H('ast-gate'),
        codeProvenanceHash: H('code-provenance'),
      }),
      brokerScopeReceipt: Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineWriterBrokerScopeReceipt',
        status: 'autonomous_research_online_writer_broker_scope_complete',
        manifestHash,
        coveredDatabaseRoles: Object.freeze([...coveredRoles].sort()),
        authorityId: authorityHead.authorityId,
        keyId: authorityHead.keyId,
        sequence: authorityHead.sequence,
        hash: authorityHead.hash,
        observedAt: '2026-07-18T07:59:40.000Z',
        expiresAt: '2026-07-18T08:05:00.000Z',
        receiptHash: H('writer-scope-receipt'),
        signatureVerified: true,
        verificationSource: 'pinned-external-authority-public-key-v1',
      }),
      blockers: Object.freeze([]),
    }),
    blockers: Object.freeze([]),
  });
}

test('passive state-safety inspection stays blocked without pinned restore authority or an online coordinator', () => {
  const calls = [];
  const stateBackupService = Object.freeze({
    authorityConfigured: false,
    authorityConfigurationHash: null,
    inventory() {
      calls.push('inventory');
      return closedInventory();
    },
    offhostSources() {
      calls.push('offhostSources');
      return latestRestoreDrill();
    },
    backup() { throw new Error('backup_must_not_run'); },
    restoreDrill() { throw new Error('restore_drill_must_not_run'); },
  });
  const inspection = inspectAutonomousResearchStateSafety({
    workspaceRoot: '/unused',
    runtimeRoot: '/unused',
    stateBackupService,
    now: NOW,
  });
  assert.deepEqual(calls, ['inventory', 'offhostSources']);
  assert.equal(
    inspection.inventoryCoveredRoleCount,
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES.length,
  );
  assert.equal(inspection.latestRestoreDrillCoveredRoleCount, 0);
  assert.equal(inspection.latestValidRestoreDrillReady, false);
  assert.equal(inspection.restoreAuthorityConfigured, false);
  assert.equal(inspection.restoreAuthorityConfigurationHash, null);
  assert.equal(
    inspection.coveredWriterCount,
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES.length,
  );
  assert.equal(
    inspection.requiredWriterCount,
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES.length,
  );
  assert.equal(inspection.writerManifestCoveragePercent, 100);
  assert.equal(inspection.statusReadOnly, true);
  assert.equal(inspection.externalActionPerformed, false);
  assert.equal(inspection.ready, false);
  assert.ok(inspection.blockers.includes(
    'autonomous_research_online_anti_rollback_coordinator_not_implemented',
  ));
  assert.ok(inspection.blockers.includes(
    'autonomous_research_state_restore_authority_trust_configuration_required',
  ));
});

test('pinned restore authority configuration reaches cryptographically reverified restore status without calling the broker', () => {
  const calls = [];
  const authorityConfigurationHash = H('restore-authority-configuration');
  const inspection = inspectAutonomousResearchStateSafety({
    workspaceRoot: '/workspace',
    runtimeRoot: '/runtime',
    environment: {
      HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG:
        '/run/hepta/authority.json',
    },
    composeStateBackupService(input) {
      calls.push(input);
      return Object.freeze({
        authorityConfigured: true,
        authorityConfigurationHash,
        inventory: closedInventory,
        offhostSources: latestRestoreDrill,
        backup() { throw new Error('backup_must_not_run'); },
        restoreDrill() { throw new Error('restore_drill_must_not_run'); },
      });
    },
    now: NOW,
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].authorityConfigurationPath,
    '/run/hepta/authority.json',
  );
  assert.equal(inspection.restoreAuthorityConfigured, true);
  assert.equal(inspection.restoreAuthorityConfigurationHash, authorityConfigurationHash);
  assert.equal(inspection.latestValidRestoreDrillReady, true);
  assert.equal(
    inspection.latestRestoreDrillCoveredRoleCount,
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES.length,
  );
  assert.equal(Object.hasOwn(inspection, 'authorityConfigurationPath'), false);
  assert.equal(inspection.externalActionPerformed, false);
});

test('configured online authority is inspected passively and failures stay fail-closed', () => {
  const calls = [];
  const inventory = closedInventory();
  const stateBackupService = Object.freeze({
    authorityConfigured: true,
    authorityConfigurationHash: H('restore-authority-configuration'),
    inventory: () => inventory,
    offhostSources: () => latestRestoreDrill(inventory),
  });
  const passive = onlineInspection();
  const ready = inspectAutonomousResearchStateSafety({
    workspaceRoot: '/workspace',
    runtimeRoot: '/runtime',
    environment: {
      HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG:
        '/run/hepta/online-authority.json',
    },
    stateBackupService,
    now: NOW,
    inspectOnlineAntiRollback(input) {
      calls.push(input);
      return passive;
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorityConfigurationPath, '/run/hepta/online-authority.json');
  assert.equal(Object.hasOwn(ready, 'authorityConfigurationPath'), false);
  assert.equal(ready.onlineAntiRollback, passive);
  assert.equal(ready.ready, true);

  const blocked = inspectAutonomousResearchStateSafety({
    workspaceRoot: '/workspace',
    runtimeRoot: '/runtime',
    environment: {
      HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG:
        '/run/hepta/online-authority.json',
    },
    stateBackupService,
    now: NOW,
    inspectOnlineAntiRollback() {
      throw new Error('signed_receipt_invalid');
    },
  });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.includes(
    'autonomous_research_online_anti_rollback_inspection_failed:signed_receipt_invalid',
  ));
});

test('local booleans and restore receipts cannot substitute for live signed anti-rollback evidence', () => {
  assert.throws(
    () => evaluateAutonomousResearchStateSafetyReadiness({}),
    /autonomous_research_state_safety_now_required/,
  );
  const absentEvidence = evaluateAutonomousResearchStateSafetyReadiness({ now: NOW });
  assert.equal(absentEvidence.ready, false);
  assert.deepEqual(absentEvidence.inventory.databaseInstanceIds, []);
  assert.deepEqual(absentEvidence.inventory.blockers, []);
  assert.equal(
    absentEvidence.inventory.status,
    'autonomous_research_state_database_inventory_blocked',
  );
  assert.equal(
    absentEvidence.latestRestoreDrill.status,
    'autonomous_research_state_backup_sources_blocked',
  );
  assert.deepEqual(absentEvidence.latestRestoreDrill.blockers, []);
  assert.ok(absentEvidence.blockers.includes(
    'autonomous_research_state_database_inventory_10_of_10_required',
  ));
  for (const onlineAntiRollback of [
    { ready: true, writerManifestComplete: true, authorityHeadCurrent: true },
    {
      version: 1,
      kind: 'AutonomousResearchStateRestoreDrillReceipt',
      status: 'autonomous_research_state_restore_drill_passed',
      blockers: [],
    },
  ]) {
    const inspection = evaluateAutonomousResearchStateSafetyReadiness({
      inventory: closedInventory(),
      latestRestoreDrill: latestRestoreDrill(),
      onlineAntiRollback,
      now: NOW,
    });
    assert.equal(inspection.ready, false);
    assert.equal(inspection.onlineAntiRollbackCoordinatorImplemented, false);
    assert.ok(inspection.blockers.includes(
      'autonomous_research_online_anti_rollback_coordinator_not_implemented',
    ));
  }
});

test('writer coverage is computed by canonical database role and a resident-only slice remains blocked', () => {
  const inspection = evaluateAutonomousResearchStateSafetyReadiness({
    inventory: closedInventory(),
    latestRestoreDrill: latestRestoreDrill(),
    onlineAntiRollback: onlineInspection({ coveredRoles: ['resident-instance'] }),
    now: NOW,
  });
  assert.equal(inspection.coveredWriterCount, 1);
  assert.equal(
    inspection.requiredWriterCount,
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES.length,
  );
  assert.equal(
    inspection.writerManifestCoveragePercent,
    Number((100 / AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES.length).toFixed(2)),
  );
  assert.deepEqual(inspection.coveredWriterRoles, ['resident-instance']);
  assert.equal(inspection.writerManifestComplete, false);
  assert.ok(inspection.blockers.includes(
    'autonomous_research_online_writer_manifest_100_percent_required',
  ));
});

test('passive status validates current signed receipts only after 10/10 writer coverage and a same-head active challenge', () => {
  const inspection = evaluateAutonomousResearchStateSafetyReadiness({
    inventory: closedInventory(),
    latestRestoreDrill: latestRestoreDrill(),
    onlineAntiRollback: onlineInspection(),
    now: NOW,
  });
  assert.equal(inspection.ready, true);
  assert.equal(inspection.status, 'autonomous_research_state_safety_ready');
  assert.equal(
    inspection.inventoryCoveredRoleCount,
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES.length,
  );
  assert.equal(
    inspection.latestRestoreDrillCoveredRoleCount,
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES.length,
  );
  assert.equal(
    inspection.coveredWriterCount,
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_REQUIRED_DATABASE_ROLES.length,
  );
  assert.equal(inspection.writerManifestCoveragePercent, 100);
  assert.equal(inspection.currentHeadReceiptVerified, true);
  assert.equal(inspection.recentActiveChallengeVerified, true);
  assert.equal(inspection.writerStaticCoverageVerified, true);
  assert.equal(inspection.writerBrokerScopeVerified, true);
  assert.equal(inspection.statusReadOnly, true);
  assert.equal(inspection.externalActionPerformed, false);
  assert.deepEqual(inspection.blockers, []);

  const contradictory = structuredClone(onlineInspection());
  contradictory.blockers = ['external_authority_reported_scope_transition_pending'];
  const blocked = evaluateAutonomousResearchStateSafetyReadiness({
    inventory: closedInventory(),
    latestRestoreDrill: latestRestoreDrill(),
    onlineAntiRollback: contradictory,
    now: NOW,
  });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.includes(
    'external_authority_reported_scope_transition_pending',
  ));
});

test('stale or different-head active challenge evidence fails closed', () => {
  const stale = evaluateAutonomousResearchStateSafetyReadiness({
    inventory: closedInventory(),
    latestRestoreDrill: latestRestoreDrill(),
    onlineAntiRollback: onlineInspection({
      activeExpiresAt: '2026-07-18T07:59:59.000Z',
    }),
    now: NOW,
  });
  assert.equal(stale.ready, false);
  assert.ok(stale.blockers.includes(
    'autonomous_research_online_authority_recent_active_challenge_required',
  ));
  const differentHead = evaluateAutonomousResearchStateSafetyReadiness({
    inventory: closedInventory(),
    latestRestoreDrill: latestRestoreDrill(),
    onlineAntiRollback: onlineInspection({ activeHeadHash: H('different-head') }),
    now: NOW,
  });
  assert.equal(differentHead.ready, false);
  assert.ok(differentHead.blockers.includes(
    'autonomous_research_online_authority_receipts_same_head_required',
  ));
});

test('inventory and restore evidence require exact canonical hashes, empty blockers, current binding, and bounded freshness', () => {
  const inventory = closedInventory();
  const restore = latestRestoreDrill(inventory);
  const evaluate = ({ candidateInventory = inventory, candidateRestore = restore } = {}) => (
    evaluateAutonomousResearchStateSafetyReadiness({
      inventory: candidateInventory,
      latestRestoreDrill: candidateRestore,
      onlineAntiRollback: onlineInspection(),
      now: NOW,
    })
  );
  const ready = evaluate();
  assert.equal(ready.ready, true);
  assert.equal(Object.hasOwn(ready.inventory, 'instances'), false);
  assert.equal(Object.hasOwn(ready.latestRestoreDrill, 'bundlePath'), false);
  assert.equal(Object.hasOwn(ready.latestRestoreDrill, 'sources'), false);
  assert.doesNotMatch(JSON.stringify(ready), /\/evidence\//);

  const inventoryWithBlocker = structuredClone(inventory);
  inventoryWithBlocker.blockers = ['self_reported_ready_with_blocker'];
  assert.equal(evaluate({ candidateInventory: inventoryWithBlocker }).ready, false);

  const wrongInventoryScope = structuredClone(inventory);
  wrongInventoryScope.databaseScopeHash = H('wrong-inventory-scope');
  const wrongScope = evaluate({ candidateInventory: wrongInventoryScope });
  assert.equal(wrongScope.ready, false);
  assert.ok(wrongScope.blockers.includes(
    'autonomous_research_state_database_inventory_scope_hash_invalid',
  ));

  const incompleteInventory = structuredClone(inventory);
  incompleteInventory.status = 'autonomous_research_state_database_inventory_blocked';
  incompleteInventory.instances = incompleteInventory.instances.slice(0, 3);
  incompleteInventory.databaseScopeHash = autonomousResearchStateDatabaseScopeHash(
    incompleteInventory.instances,
  );
  incompleteInventory.inventoryHash = null;
  incompleteInventory.blockers = [
    'autonomous_research_state_database_required_missing:machine-intake',
  ];
  const incomplete = evaluate({ candidateInventory: incompleteInventory });
  assert.equal(incomplete.ready, false);
  assert.ok(incomplete.blockers.includes(
    'autonomous_research_state_database_inventory_10_of_10_required',
  ));
  assert.ok(incomplete.blockers.includes(
    'autonomous_research_state_database_inventory_hash_invalid',
  ));
  assert.equal(incomplete.blockers.includes(
    'autonomous_research_state_database_inventory_scope_hash_invalid',
  ), false);

  const restoreWithBlocker = structuredClone(restore);
  restoreWithBlocker.blockers = ['self_reported_restore_ready_with_blocker'];
  assert.equal(evaluate({ candidateRestore: restoreWithBlocker }).ready, false);

  const staleRestore = structuredClone(restore);
  staleRestore.restoreDrillPerformedAt = new Date(
    NOW.getTime() - (24 * 60 * 60 * 1000) - 1,
  ).toISOString();
  const stale = evaluate({ candidateRestore: staleRestore });
  assert.equal(stale.ready, false);
  assert.ok(stale.blockers.includes(
    'autonomous_research_state_restore_drill_freshness_required',
  ));

  const wrongRestoreBinding = structuredClone(restore);
  wrongRestoreBinding.inventoryHash = H('wrong-restore-inventory');
  const mismatched = evaluate({ candidateRestore: wrongRestoreBinding });
  assert.equal(mismatched.ready, false);
  assert.ok(mismatched.blockers.includes(
    'autonomous_research_state_restore_current_inventory_binding_required',
  ));

  const missingInstance = structuredClone(restore);
  missingInstance.databaseInstanceIds.pop();
  assert.equal(evaluate({ candidateRestore: missingInstance }).ready, false);

  const invalidAuthorityMetadata = structuredClone(restore);
  invalidAuthorityMetadata.headSequence = -1;
  assert.equal(evaluate({ candidateRestore: invalidAuthorityMetadata }).ready, false);
});

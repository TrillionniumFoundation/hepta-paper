import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renewAutonomousResearchStateBackup,
} from '../../paper-application/automation/autonomous-research-state-backup-renewal.mjs';
import {
  reconcileAndRenewAutonomousResearchStateBackup,
} from '../../paper-application/automation/autonomous-research-state-reconcile-and-renew.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
  autonomousResearchStateDatabaseInventoryHash,
  autonomousResearchStateDatabaseScopeHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA = (label) => hashRecord('AutonomousResearchStateBackupRenewalTest', { label });

function exactInventory({ revision = 1, suffix = '' } = {}) {
  const instances = AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.map((role) => Object.freeze({
    role,
    instanceId: role,
    sourceRelativePath: `autonomous-research/${role}${suffix}.sqlite`,
    schemaContractId: `${role}-schema-v1`,
    schemaHash: SHA(`schema:${role}`),
    sourceSha256: SHA(`source:${role}:${revision}`),
  })).sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  const base = {
    version: 1,
    kind: 'AutonomousResearchStateDatabaseInventory',
    status: 'autonomous_research_state_database_inventory_ready',
    manifestId: 'autonomous-research-state-databases-v1',
    manifestHash: SHA('state-manifest'),
    databaseScopeHash: autonomousResearchStateDatabaseScopeHash(instances),
    instances: Object.freeze(instances),
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...base,
    inventoryHash: autonomousResearchStateDatabaseInventoryHash(base),
  });
}

function reconciliationReceipt(instance, recoveredReservationIds = []) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationUnresolvedReservationReconciliationReceipt',
    status: 'autonomous_research_online_mutation_unresolved_reservations_reconciled',
    databaseRole: instance.role,
    databaseInstanceId: instance.instanceId,
    initialUnresolvedReservationCount: recoveredReservationIds.length,
    recoveredReservationIds: Object.freeze([...recoveredReservationIds]),
    finalizedHeads: Object.freeze(recoveredReservationIds.map(
      (reservationId, index) => Object.freeze({
        reservationId,
        globalSequence: index + 1,
        globalHash: SHA(`finalized-head:${reservationId}`),
      }),
    )),
    abortedRemoteOnlyReservationIds: Object.freeze([]),
    abortedRemoteOnlyAbortReceiptHashes: Object.freeze([]),
    abortedRemoteOnlyAbortReceipts: Object.freeze([]),
    initialRemoteOnlyReservationCount: 0,
    remoteOnlyReservationCount: 0,
    businessDmlReplayed: false,
    confirmationReceiptHash: SHA(`confirmation:${instance.instanceId}`),
    remainingBlockers: Object.freeze([
      'autonomous_research_online_mutation_finalized_head_reconciliation_required',
      'autonomous_research_online_mutation_active_startup_head_challenge_required',
    ]),
    runtimeReady: false,
  });
}

function completeRenewalReceipt() {
  return Object.freeze({
    status: 'autonomous_research_state_backup_renewal_complete',
    renewalReceiptHash: SHA('startup-renewal'),
    blockers: Object.freeze([]),
  });
}

function backupReceipt() {
  return Object.freeze({
    status: 'autonomous_research_state_backup_recorded',
    bundlePath: '/bounded/backups/exact-bundle',
    bundleManifestHash: SHA('bundle'),
    snapshotContentHash: SHA('snapshot'),
    authorityHeadSequence: 7,
    authorityHeadHash: SHA('backup-head'),
    blockers: Object.freeze([]),
  });
}

function restoreReceipt(bundle = backupReceipt()) {
  return Object.freeze({
    status: 'autonomous_research_state_restore_drill_passed',
    bundlePath: bundle.bundlePath,
    bundleManifestHash: bundle.bundleManifestHash,
    snapshotContentHash: bundle.snapshotContentHash,
    authorityCurrentHeadReceipt: Object.freeze({
      headSequence: 9,
      headHash: SHA('restore-head'),
    }),
    restoreDrillReceiptHash: SHA('restore-receipt'),
    recoverabilityBindingHash: SHA('recoverability'),
    completeFinalizedMutationJournal: true,
    journalReplayMutationCount: 2,
    blockers: Object.freeze([]),
  });
}

test('renew publishes only after drilling the exact newly created bundle', async () => {
  const backup = backupReceipt();
  const calls = [];
  let published = null;
  const receipt = await renewAutonomousResearchStateBackup({
    async createBackup() {
      calls.push('backup');
      return backup;
    },
    async drillExactBundle(input) {
      calls.push(`drill:${input.bundlePath}`);
      return restoreReceipt(backup);
    },
    async publishRenewalReceipt(input) {
      calls.push(`publish:${input.bundlePath}`);
      published = input.receipt;
    },
    clock: { now: () => new Date('2026-07-20T12:00:00.000Z') },
  });
  assert.equal(receipt.status, 'autonomous_research_state_backup_renewal_complete');
  assert.deepEqual(calls, [
    'backup',
    'drill:/bounded/backups/exact-bundle',
    'publish:/bounded/backups/exact-bundle',
  ]);
  assert.equal(published, receipt);
  assert.equal(receipt.restoreDrillReceiptHash, SHA('restore-receipt'));
  assert.equal(receipt.journalReplayMutationCount, 2);
});

test('renew never drills or publishes after a blocked backup', async () => {
  let drillCalls = 0;
  let publishCalls = 0;
  const receipt = await renewAutonomousResearchStateBackup({
    async createBackup() {
      return Object.freeze({
        status: 'autonomous_research_state_backup_blocked',
        blockers: Object.freeze(['authority_unavailable']),
      });
    },
    async drillExactBundle() { drillCalls += 1; },
    async publishRenewalReceipt() { publishCalls += 1; },
  });
  assert.equal(receipt.status, 'autonomous_research_state_backup_renewal_blocked');
  assert.equal(drillCalls, 0);
  assert.equal(publishCalls, 0);
  assert.ok(receipt.blockers.includes('authority_unavailable'));
});

test('renew does not publish success when the exact-bundle drill or publication fails', async () => {
  const backup = backupReceipt();
  let publishCalls = 0;
  const drillBlocked = await renewAutonomousResearchStateBackup({
    async createBackup() { return backup; },
    async drillExactBundle() {
      return Object.freeze({
        status: 'autonomous_research_state_restore_drill_blocked',
        bundlePath: backup.bundlePath,
        blockers: Object.freeze(['journal_incomplete']),
      });
    },
    async publishRenewalReceipt() { publishCalls += 1; },
  });
  assert.equal(drillBlocked.status, 'autonomous_research_state_backup_renewal_blocked');
  assert.equal(publishCalls, 0);
  assert.ok(drillBlocked.blockers.includes('journal_incomplete'));

  const publicationBlocked = await renewAutonomousResearchStateBackup({
    async createBackup() { return backup; },
    async drillExactBundle() { return restoreReceipt(backup); },
    async publishRenewalReceipt() {
      throw new Error('renewal_receipt_store_unavailable');
    },
  });
  assert.equal(publicationBlocked.status, 'autonomous_research_state_backup_renewal_blocked');
  assert.ok(publicationBlocked.blockers.includes('renewal_receipt_store_unavailable'));
});

test('reconcile-and-renew checks every canonical database and renews only after zero pending', async () => {
  const initial = exactInventory({ revision: 1 });
  const current = exactInventory({ revision: 2 });
  const calls = [];
  const authorityTrust = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
    authorityId: 'online-authority:test',
    keyId: 'online-key:test',
    scopeId: 'online-scope:test',
    databaseScopeHash: initial.databaseScopeHash,
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(
      AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    ),
  });
  const receipt = await reconcileAndRenewAutonomousResearchStateBackup({
    resolveInventory() {
      calls.push('inventory');
      return calls.filter((value) => value === 'inventory').length === 1
        ? initial : current;
    },
    authorityTrust,
    backupOnlineMutationTrust: authorityTrust,
    writerManifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    reconcileDatabaseStartup({ instance }) {
      calls.push(`reconcile:${instance.instanceId}`);
      return reconciliationReceipt(instance);
    },
    inspectPendingFinalizations({ instance }) {
      calls.push(`pending:${instance.instanceId}`);
      return Object.freeze({
        databaseRole: instance.role,
        databaseInstanceId: instance.instanceId,
        pendingFinalizationCount: 0,
      });
    },
    renewBackup() {
      calls.push('renew');
      return completeRenewalReceipt();
    },
    clock: { now: () => new Date('2026-07-20T13:00:00.000Z') },
  });
  assert.equal(receipt.status, 'autonomous_research_state_reconcile_and_renew_complete');
  assert.equal(receipt.reconciledDatabaseCount, 10);
  assert.equal(receipt.recoveredFinalizationCount, 0);
  assert.equal(receipt.abortedRemoteOnlyReservationCount, 0);
  assert.equal(receipt.businessDmlReplayed, false);
  assert.equal(receipt.backupAttempted, true);
  assert.equal(calls.filter((value) => value.startsWith('reconcile:')).length, 10);
  assert.equal(calls.filter((value) => value.startsWith('pending:')).length, 10);
  assert.equal(calls.at(-1), 'renew');
});

test('reconcile-and-renew blocks scope drift, reconciliation failures, and pending markers before backup', async () => {
  const initial = exactInventory({ revision: 1 });
  const manifestHash = autonomousResearchOnlineWriterOperationManifestHash(
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  );
  const cases = [
    Object.freeze({
      name: 'authority-scope',
      authorityScopeHash: SHA('wrong-scope'),
      expected: 'autonomous_research_state_reconcile_and_renew_authority_scope_mismatch',
    }),
    Object.freeze({
      name: 'tampered-marker',
      reconcileError: 'autonomous_research_online_mutation_startup_marker_binding_invalid',
      expected: 'autonomous_research_online_mutation_startup_marker_binding_invalid',
    }),
    Object.freeze({
      name: 'backup-online-authority-mismatch',
      backupOnlineMutationTrust: Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
        authorityId: 'different-online-authority',
        keyId: 'online-key:test',
        scopeId: 'online-scope:test',
        databaseScopeHash: initial.databaseScopeHash,
        writerManifestHash: manifestHash,
      }),
      expected:
        'autonomous_research_state_reconcile_and_renew_backup_online_authority_mismatch',
    }),
    Object.freeze({
      name: 'unknown-operation',
      reconcileError: 'autonomous_research_online_mutation_startup_manifest_binding_invalid',
      expected: 'autonomous_research_online_mutation_startup_manifest_binding_invalid',
    }),
    Object.freeze({
      name: 'finalize-failure',
      reconcileError: 'autonomous_research_online_mutation_authority_process_failed',
      expected: 'autonomous_research_online_mutation_authority_process_failed',
    }),
    Object.freeze({
      name: 'pending-finalization',
      pendingFinalizationCount: 1,
      expected: 'autonomous_research_state_reconcile_and_renew_pending_finalization_required',
    }),
    Object.freeze({
      name: 'inventory-scope-change',
      currentInventory: exactInventory({ revision: 2, suffix: '-changed' }),
      expected: 'autonomous_research_state_reconcile_and_renew_inventory_scope_changed',
    }),
  ];
  for (const scenario of cases) {
    let inventoryCallCount = 0;
    let renewalCalls = 0;
    const authorityTrust = Object.freeze({
      version: 1,
      kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
      authorityId: 'online-authority:test',
      keyId: 'online-key:test',
      scopeId: 'online-scope:test',
      databaseScopeHash: scenario.authorityScopeHash || initial.databaseScopeHash,
      writerManifestHash: manifestHash,
    });
    const receipt = await reconcileAndRenewAutonomousResearchStateBackup({
      resolveInventory() {
        inventoryCallCount += 1;
        return inventoryCallCount === 1
          ? initial : scenario.currentInventory || exactInventory({ revision: 2 });
      },
      authorityTrust,
      backupOnlineMutationTrust:
        scenario.backupOnlineMutationTrust || authorityTrust,
      writerManifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
      reconcileDatabaseStartup({ instance }) {
        if (scenario.reconcileError) throw new Error(scenario.reconcileError);
        return reconciliationReceipt(instance);
      },
      inspectPendingFinalizations({ instance }) {
        return Object.freeze({
          databaseRole: instance.role,
          databaseInstanceId: instance.instanceId,
          pendingFinalizationCount: scenario.pendingFinalizationCount || 0,
        });
      },
      renewBackup() {
        renewalCalls += 1;
        return completeRenewalReceipt();
      },
    });
    assert.equal(receipt.status,
      'autonomous_research_state_reconcile_and_renew_blocked', scenario.name);
    assert.equal(receipt.backupAttempted, false, scenario.name);
    assert.equal(receipt.businessDmlReplayed, false, scenario.name);
    assert.equal(renewalCalls, 0, scenario.name);
    assert.ok(receipt.blockers.includes(scenario.expected), scenario.name);
  }
});

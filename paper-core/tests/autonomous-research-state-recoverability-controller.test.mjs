import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAutonomousResearchStateRecoverabilityController,
} from '../../paper-application/automation/autonomous-research-state-recoverability-controller.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  autonomousResearchOnlineMutationReceiptHash,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const hash = (label) => hashRecord('StateRecoverabilityControllerTest', { label });

const reconciliationRows = ({ finalizedHeads = [], abortReceipts = [] } = {}) => (
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.map((role, index) => Object.freeze({
    databaseRole: role,
    databaseInstanceId: role,
    recoveredReservationIds: Object.freeze(index === 0
      ? finalizedHeads.map((head) => head.reservationId) : []),
    finalizedHeads: Object.freeze(index === 0 ? [...finalizedHeads] : []),
    abortedRemoteOnlyReservationIds: Object.freeze(index === 0
      ? abortReceipts.map((receipt) => receipt.reservationId) : []),
    abortedRemoteOnlyAbortReceiptHashes: Object.freeze(index === 0
      ? abortReceipts.map(autonomousResearchOnlineMutationReceiptHash) : []),
    abortedRemoteOnlyAbortReceipts: Object.freeze(index === 0
      ? [...abortReceipts] : []),
    reconciliationReceiptHash: hash(`reconciliation:${role}`),
  }))
);

const pendingInspections = () => AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.map(
  (role) => Object.freeze({
    databaseRole: role,
    databaseInstanceId: role,
    pendingFinalizationCount: 0,
  }),
);

function completePendingReconciliation({ finalizedHeads = [], abortReceipts = [] } = {}) {
  const reconciliations = Object.freeze(reconciliationRows({
    finalizedHeads,
    abortReceipts,
  }));
  const recovery = Object.freeze({
    finalizedHeads: Object.freeze([...finalizedHeads]),
    abortedRemoteOnlyReservationIds: Object.freeze(abortReceipts.map(
      (receipt) => receipt.reservationId,
    )),
    abortedRemoteOnlyAbortReceiptHashes: Object.freeze(abortReceipts.map(
      autonomousResearchOnlineMutationReceiptHash,
    )),
    abortedRemoteOnlyAbortReceipts: Object.freeze([...abortReceipts]),
  });
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStatePendingReconciliationReceipt',
    status: 'autonomous_research_state_pending_reconciliation_complete',
    businessDmlReplayed: false,
    databaseScopeHash: hash('scope'),
    reconciledDatabaseCount: AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length,
    recoveredFinalizationCount: finalizedHeads.length,
    abortedRemoteOnlyReservationCount: abortReceipts.length,
    reconciliationAttempted: true,
    recovery,
    reconciliations,
    pendingInspections: Object.freeze(pendingInspections()),
    completedAt: '2026-07-20T00:00:00.000Z',
    blockers: Object.freeze([]),
  });
  return Object.freeze({
    ...payload,
    pendingReconciliationReceiptHash: hashRecord(
      'AutonomousResearchStatePendingReconciliationReceipt', payload,
    ),
  });
}

function completeRenewal({ bundlePath, headSequence, headHash }) {
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateBackupRenewalReceipt',
    status: 'autonomous_research_state_backup_renewal_complete',
    bundlePath,
    bundleManifestHash: hash(`bundle:${bundlePath}`),
    snapshotContentHash: hash(`snapshot:${bundlePath}`),
    backupAuthorityHeadSequence: headSequence,
    backupAuthorityHeadHash: headHash,
    restoreAuthorityHeadSequence: headSequence,
    restoreAuthorityHeadHash: headHash,
    restoreDrillReceiptHash: hash(`restore:${bundlePath}`),
    recoverabilityBindingHash: hash(`binding:${bundlePath}`),
    completeFinalizedMutationJournal: true,
    journalReplayMutationCount: 0,
    renewedAt: '2026-07-20T00:00:00.000Z',
    productionStateMutated: false,
    blockers: Object.freeze([]),
  });
  return Object.freeze({
    ...payload,
    renewalReceiptHash: hashRecord(
      'AutonomousResearchStateBackupRenewalReceipt', payload,
    ),
  });
}

function completeReconcileAndRenew({ renewal, finalizedHeads = [], abortReceipts = [] }) {
  const reconciliations = Object.freeze(reconciliationRows({
    finalizedHeads,
    abortReceipts,
  }));
  const inspections = Object.freeze(pendingInspections());
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateReconcileAndRenewReceipt',
    status: 'autonomous_research_state_reconcile_and_renew_complete',
    databaseScopeHash: hash('scope'),
    writerManifestHash: hash('writer-manifest'),
    initialInventoryHash: hash('inventory-before'),
    reconciledInventoryHash: hash('inventory-after'),
    reconciledDatabaseCount: AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length,
    recoveredFinalizationCount: finalizedHeads.length,
    abortedRemoteOnlyReservationCount: abortReceipts.length,
    businessDmlReplayed: false,
    backupAttempted: true,
    renewalReceiptHash: renewal.renewalReceiptHash,
    reconciliationReceiptHashes: Object.freeze(reconciliations.map(
      (receipt) => receipt.reconciliationReceiptHash,
    )),
    pendingInspectionSetHash: hashRecord(
      'AutonomousResearchStatePendingFinalizationInspectionSet', inspections,
    ),
    completedAt: '2026-07-20T00:00:00.000Z',
    blockers: Object.freeze([]),
  });
  return Object.freeze({
    ...payload,
    reconcileAndRenewReceiptHash: hashRecord(
      'AutonomousResearchStateReconcileAndRenewReceipt', payload,
    ),
    reconciliations,
    pendingInspections: inspections,
    renewalReceipt: renewal,
  });
}

function abortReceipt(reservationId) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAbortReceipt',
    status: 'autonomous_research_online_mutation_aborted',
    reservationId,
    authorityId: 'authority:test',
    keyId: 'key:test',
    signature: 'dGVzdA==',
  });
}

function fixture({ initialVerifiedHead = null } = {}) {
  const clock = { now: () => new Date('2026-07-20T00:00:00.000Z') };
  let liveHead = { sequence: 0, hash: hash('head-0') };
  let sources = {
    status: 'autonomous_research_state_backup_sources_ready',
    bundlePath: '/backups/baseline',
    restoreDrillReceiptHash: hash('restore-0'),
    snapshotCreatedAt: '2026-07-19T23:00:00.000Z',
    restoreDrillPerformedAt: '2026-07-19T23:00:00.000Z',
    headSequence: 0,
    headHash: hash('head-0'),
    recoverabilityBindingHash: hash('binding:/backups/baseline'),
  };
  let observationBlockers = null;
  let drillBlockers = null;
  let restoreCalls = 0;
  let renewCalls = 0;
  let pendingCalls = 0;
  let leaseCalls = 0;
  let pendingRecovery = { finalizedHeads: [], abortReceipts: [] };
  let pendingBlockers = null;
  const service = {
    async offhostSources() { return Object.freeze({ ...sources }); },
    async observeBundleHead() {
      if (observationBlockers) {
        return Object.freeze({
          status: 'autonomous_research_state_backup_current_head_blocked',
          blockers: Object.freeze([...observationBlockers]),
        });
      }
      return Object.freeze({
        status: 'autonomous_research_state_backup_current_head_observed',
        authorityCurrentHeadReceipt: Object.freeze({
          headSequence: liveHead.sequence,
          headHash: liveHead.hash,
          expiresAt: '2026-07-20T01:00:00.000Z',
        }),
        blockers: Object.freeze([]),
      });
    },
    async restoreDrill({ bundlePath }) {
      restoreCalls += 1;
      if (drillBlockers) {
        return Object.freeze({
          status: 'autonomous_research_state_restore_drill_blocked',
          bundlePath,
          blockers: Object.freeze([...drillBlockers]),
        });
      }
      sources = {
        ...sources,
        headSequence: liveHead.sequence,
        headHash: liveHead.hash,
        restoreDrillReceiptHash: hash(`restore-${liveHead.sequence}`),
      };
      return Object.freeze({
        status: 'autonomous_research_state_restore_drill_passed',
        bundlePath,
        restoreDrillReceiptHash: sources.restoreDrillReceiptHash,
        blockers: Object.freeze([]),
      });
    },
    async reconcilePending() {
      pendingCalls += 1;
      if (pendingBlockers) {
        return Object.freeze({
          status: 'autonomous_research_state_pending_reconciliation_blocked',
          businessDmlReplayed: false,
          blockers: Object.freeze([...pendingBlockers]),
        });
      }
      const recovery = pendingRecovery;
      pendingRecovery = { finalizedHeads: [], abortReceipts: [] };
      const latest = recovery.finalizedHeads.at(-1);
      if (latest) {
        liveHead = { sequence: latest.globalSequence, hash: latest.globalHash };
      }
      return completePendingReconciliation(recovery);
    },
    async reconcileAndRenew() {
      renewCalls += 1;
      const bundlePath = `/backups/fresh-${renewCalls}`;
      const renewal = completeRenewal({
        bundlePath,
        headSequence: liveHead.sequence,
        headHash: liveHead.hash,
      });
      sources = {
        ...sources,
        bundlePath,
        headSequence: liveHead.sequence,
        headHash: liveHead.hash,
        restoreDrillReceiptHash: renewal.restoreDrillReceiptHash,
        recoverabilityBindingHash: renewal.recoverabilityBindingHash,
        snapshotCreatedAt: clock.now().toISOString(),
        restoreDrillPerformedAt: clock.now().toISOString(),
      };
      return completeReconcileAndRenew({
        renewal,
        finalizedHeads: [],
        abortReceipts: [],
      });
    },
  };
  const controller = createAutonomousResearchStateRecoverabilityController({
    service,
    assertResidentLease: async () => { leaseCalls += 1; return true; },
    clock,
    initialVerifiedHead,
  });
  return {
    controller,
    advanceHead(sequence) {
      liveHead = { sequence, hash: hash(`head-${sequence}`) };
    },
    setObservationBlockers(blockers) { observationBlockers = blockers; },
    setDrillBlockers(blockers) { drillBlockers = blockers; },
    setPendingBlockers(blockers) { pendingBlockers = blockers; },
    setPendingRecovery(value) {
      pendingRecovery = {
        finalizedHeads: [...(value?.finalizedHeads || [])],
        abortReceipts: [...(value?.abortReceipts || [])],
      };
    },
    ageSources() {
      sources = {
        ...sources,
        snapshotCreatedAt: '2026-07-19T00:00:00.000Z',
        restoreDrillPerformedAt: '2026-07-20T00:00:00.000Z',
      };
    },
    counts: () => ({ restoreCalls, renewCalls, leaseCalls }),
    pendingCalls: () => pendingCalls,
  };
}

test('quiet-point controller journal-renews the same bundle across two mutation cycles', async () => {
  const setup = fixture();
  assert.throws(
    () => setup.controller.assertCurrent({ action: 'provider-before-initial-reconcile' }),
    (error) => error.name === 'AutonomousResearchStateRecoverabilityDeferredError',
  );
  setup.advanceHead(1);
  setup.controller.markMutationFinalized({
    globalSequence: 1,
    globalHash: hash('head-1'),
  });
  assert.throws(
    () => setup.controller.assertCurrent({ action: 'provider-after-mutation-1' }),
    (error) => error.name === 'AutonomousResearchStateRecoverabilityDeferredError',
  );
  const first = await setup.controller.reconcile({ requiredValidityMs: 30_000 });
  assert.equal(first.status, 'autonomous_research_state_recoverability_ready');
  assert.equal(first.mode, 'journal-renewed');
  assert.equal(first.headSequence, 1);
  assert.equal(
    setup.controller.assertCurrent({ action: 'provider-after-reconcile-1' }).globalSequence,
    1,
  );

  setup.advanceHead(2);
  setup.controller.markMutationFinalized({
    globalSequence: 2,
    globalHash: hash('head-2'),
  });
  assert.throws(
    () => setup.controller.assertCurrent({ action: 'submission-after-mutation-2' }),
    (error) => error.name === 'AutonomousResearchStateRecoverabilityDeferredError',
  );
  const second = await setup.controller.reconcile({ requiredValidityMs: 30_000 });
  assert.equal(second.mode, 'journal-renewed');
  assert.equal(second.headSequence, 2);
  assert.equal(
    setup.controller.assertCurrent({ action: 'submission-after-reconcile-2' }).globalSequence,
    2,
  );

  const current = await setup.controller.reconcile({ requiredValidityMs: 30_000 });
  assert.equal(current.mode, 'current');
  assert.deepEqual(setup.counts(), { restoreCalls: 2, renewCalls: 0, leaseCalls: 10 });
  assert.equal(setup.pendingCalls(), 0);
});

test('quiet point recovers a committed pending finalization even when the fresh bundle and live head were still old', async () => {
  const setup = fixture({
    initialVerifiedHead: {
      globalSequence: 0,
      globalHash: hash('head-0'),
    },
  });
  setup.setPendingRecovery({
    finalizedHeads: [Object.freeze({
      reservationId: 'reservation:committed-pending',
      globalSequence: 1,
      globalHash: hash('head-1'),
    })],
  });
  setup.controller.markMutationReconciliationRequired({
    reason: 'externally_fenced_sqlite_mutation_committed_finalization_pending',
    databaseRole: 'resident-instance',
    databaseInstanceId: 'resident-instance',
    reservationId: 'reservation:committed-pending',
    mutationAttemptId: 'mutation:committed-pending',
    committed: true,
  });
  assert.throws(
    () => setup.controller.assertCurrent({ action: 'provider-before-pending-recovery' }),
    (error) => error.stateRecoverabilityDeferred === true,
  );
  const recovered = await setup.controller.reconcile();
  assert.equal(recovered.mode, 'journal-renewed');
  assert.equal(recovered.headSequence, 1);
  assert.equal(setup.pendingCalls(), 1);
  assert.equal(setup.counts().restoreCalls, 1);
  assert.equal(setup.counts().renewCalls, 0);
  assert.equal(
    setup.controller.assertCurrent({ action: 'provider-after-pending-recovery' })
      .globalSequence,
    1,
  );
});

test('quiet point aborts signed remote-only work without replaying DML or forcing a fresh backup', async () => {
  const setup = fixture({
    initialVerifiedHead: {
      globalSequence: 0,
      globalHash: hash('head-0'),
    },
  });
  setup.setPendingRecovery({
    abortReceipts: [abortReceipt('reservation:remote-only')],
  });
  setup.controller.markMutationReconciliationRequired({
    reason: 'externally_fenced_sqlite_mutation_reservation_resolution_pending',
    databaseRole: 'resident-instance',
    databaseInstanceId: 'resident-instance',
    mutationAttemptId: 'mutation:remote-only',
    committed: false,
  });
  const recovered = await setup.controller.reconcile();
  assert.equal(recovered.mode, 'current');
  assert.equal(recovered.headSequence, 0);
  assert.equal(setup.pendingCalls(), 1);
  assert.deepEqual(setup.counts(), {
    restoreCalls: 0,
    renewCalls: 0,
    leaseCalls: 4,
  });
  assert.equal(
    setup.controller.epochStatus().reconciliationRequirements.length,
    0,
  );
});

test('pending reconciliation failure stays sticky and scope drift is fatal', async () => {
  const transientSetup = fixture({
    initialVerifiedHead: {
      globalSequence: 0,
      globalHash: hash('head-0'),
    },
  });
  transientSetup.controller.markMutationReconciliationRequired({
    reason: 'externally_fenced_sqlite_mutation_committed_finalization_pending',
    databaseRole: 'resident-instance',
    databaseInstanceId: 'resident-instance',
    reservationId: 'reservation:retry',
    committed: true,
  });
  transientSetup.setPendingBlockers([
    'autonomous_research_online_mutation_authority_process_failed',
  ]);
  const deferred = await transientSetup.controller.reconcile();
  assert.equal(deferred.mode, 'pending-reconciliation');
  assert.equal(
    transientSetup.controller.epochStatus().reconciliationRequirements.length,
    1,
  );
  assert.throws(
    () => transientSetup.controller.assertCurrent({ action: 'must-remain-closed' }),
    (error) => error.stateRecoverabilityDeferred === true,
  );

  const drifted = fixture({
    initialVerifiedHead: {
      globalSequence: 0,
      globalHash: hash('head-0'),
    },
  });
  drifted.controller.markMutationReconciliationRequired({
    reason: 'externally_fenced_sqlite_mutation_reservation_resolution_pending',
    databaseRole: 'resident-instance',
    databaseInstanceId: 'resident-instance',
    mutationAttemptId: 'mutation:drift',
    committed: false,
  });
  drifted.setPendingBlockers([
    'autonomous_research_state_reconcile_and_renew_inventory_scope_changed',
  ]);
  await assert.rejects(
    drifted.controller.reconcile(),
    (error) => error.stateRecoverabilityFatal === true,
  );
  assert.equal(
    drifted.controller.epochStatus().status,
    'autonomous_research_state_recoverability_epoch_fatal',
  );
});

test('conflicting finalized epoch becomes sticky fatal for synchronous fences', async () => {
  const setup = fixture();
  await setup.controller.reconcile();
  setup.controller.markMutationFinalized({
    globalSequence: 1,
    globalHash: hash('head-1'),
  });
  assert.throws(
    () => setup.controller.markMutationFinalized({
      globalSequence: 1,
      globalHash: hash('conflicting-head-1'),
    }),
    (error) => error.name === 'AutonomousResearchStateRecoverabilityFatalError',
  );
  assert.equal(
    setup.controller.epochStatus().status,
    'autonomous_research_state_recoverability_epoch_fatal',
  );
  assert.throws(
    () => setup.controller.assertCurrent({ action: 'qualification-after-conflict' }),
    (error) => error.name === 'AutonomousResearchStateRecoverabilityFatalError',
  );
});

test('transient authority failure becomes global deferred without running a drill', async () => {
  const setup = fixture();
  setup.advanceHead(1);
  setup.setObservationBlockers([
    'autonomous_research_state_backup_authority_process_failed',
  ]);
  const deferred = await setup.controller.reconcile();
  assert.equal(deferred.status, 'autonomous_research_state_recoverability_deferred');
  assert.equal(deferred.mode, 'current-head-observation');
  assert.equal(deferred.nextAttemptAt, '2026-07-20T00:15:00.000Z');
  assert.equal(setup.counts().restoreCalls, 0);
});

test('journal tamper is fatal while an overlong range falls back to a fresh snapshot', async () => {
  const tampered = fixture();
  tampered.advanceHead(1);
  tampered.setDrillBlockers([
    'autonomous_research_state_restore_journal_reservation_invalid',
  ]);
  await assert.rejects(
    tampered.controller.reconcile(),
    (error) => error.name === 'AutonomousResearchStateRecoverabilityFatalError'
      && error.blockers.includes(
        'autonomous_research_state_restore_journal_reservation_invalid',
      ),
  );
  assert.equal(tampered.counts().renewCalls, 0);

  const overlong = fixture();
  overlong.advanceHead(5000);
  overlong.setDrillBlockers([
    'autonomous_research_state_restore_journal_range_unbounded',
  ]);
  const renewed = await overlong.controller.reconcile();
  assert.equal(renewed.mode, 'fresh-snapshot-renewed');
  assert.equal(overlong.counts().renewCalls, 1);
});

test('hourly journal drills do not hide a baseline entering its fresh-snapshot age window', async () => {
  const setup = fixture();
  setup.ageSources();
  const renewed = await setup.controller.reconcile();
  assert.equal(renewed.mode, 'fresh-snapshot-renewed');
  assert.equal(setup.counts().renewCalls, 1);
  assert.equal(setup.counts().restoreCalls, 0);
  assert.equal(setup.pendingCalls(), 0);
});

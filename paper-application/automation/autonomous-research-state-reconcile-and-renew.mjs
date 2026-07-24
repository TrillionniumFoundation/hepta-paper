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
  autonomousResearchOnlineMutationReceiptHash,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function observedNow(clock) {
  const value = typeof clock?.now === 'function' ? clock.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_state_reconcile_and_renew_clock_invalid');
  }
  return date;
}

function fail(code, extra = {}) {
  const error = new Error(code);
  Object.assign(error, extra);
  throw error;
}

function validateExactInventory(inventory) {
  let inventoryHash;
  let databaseScopeHash;
  try {
    inventoryHash = autonomousResearchStateDatabaseInventoryHash(inventory);
    databaseScopeHash = autonomousResearchStateDatabaseScopeHash(inventory.instances);
  } catch {
    fail('autonomous_research_state_reconcile_and_renew_inventory_invalid');
  }
  const roles = inventory.instances.map((instance) => instance.role).sort();
  const requiredRoles = [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort();
  if (inventory.status !== 'autonomous_research_state_database_inventory_ready'
    || inventory.inventoryHash !== inventoryHash
    || inventory.databaseScopeHash !== databaseScopeHash
    || inventory.instances.length !== requiredRoles.length
    || roles.join('\0') !== requiredRoles.join('\0')
    || inventory.blockers?.length !== 0) {
    fail('autonomous_research_state_reconcile_and_renew_inventory_invalid');
  }
  return inventory;
}

function scopeProjection(inventory) {
  return inventory.instances.map((instance) => Object.freeze({
    role: instance.role,
    instanceId: instance.instanceId,
    sourceRelativePath: instance.sourceRelativePath,
    schemaContractId: instance.schemaContractId,
    schemaHash: instance.schemaHash,
  })).sort((left, right) => left.instanceId.localeCompare(right.instanceId));
}

function stableExactScope(left, right) {
  return left.manifestId === right.manifestId
    && left.manifestHash === right.manifestHash
    && left.databaseScopeHash === right.databaseScopeHash
    && JSON.stringify(scopeProjection(left)) === JSON.stringify(scopeProjection(right));
}

function exactAbortEvidence(receipt) {
  const ids = receipt?.abortedRemoteOnlyReservationIds;
  const hashes = receipt?.abortedRemoteOnlyAbortReceiptHashes;
  const receipts = receipt?.abortedRemoteOnlyAbortReceipts;
  return Array.isArray(ids)
    && Array.isArray(hashes)
    && Array.isArray(receipts)
    && ids.length === hashes.length
    && ids.length === receipts.length
    && new Set(ids).size === ids.length
    && receipts.every((abortReceipt, index) => (
      abortReceipt?.kind === 'AutonomousResearchOnlineMutationAbortReceipt'
      && abortReceipt.status === 'autonomous_research_online_mutation_aborted'
      && abortReceipt.reservationId === ids[index]
      && typeof abortReceipt.authorityId === 'string'
      && abortReceipt.authorityId.length > 0
      && typeof abortReceipt.keyId === 'string'
      && abortReceipt.keyId.length > 0
      && typeof abortReceipt.signature === 'string'
      && abortReceipt.signature.length > 0
      && hashes[index] === autonomousResearchOnlineMutationReceiptHash(abortReceipt)
    ));
}

function exactFinalizedHeads(receipt) {
  const recovered = receipt?.recoveredReservationIds;
  const finalizedHeads = receipt?.finalizedHeads || [];
  return Array.isArray(recovered)
    && Array.isArray(finalizedHeads)
    && finalizedHeads.length === recovered.length
    && new Set(finalizedHeads.map((head) => head?.reservationId)).size
      === finalizedHeads.length
    && finalizedHeads.every((head, index) => (
      head?.reservationId === recovered[index]
      && Number.isSafeInteger(head?.globalSequence)
      && head.globalSequence >= 0
      && SHA256.test(String(head?.globalHash || ''))
    ));
}

function validatedReconciliationSummary(receipt, instance) {
  if (receipt?.status
      !== 'autonomous_research_online_mutation_unresolved_reservations_reconciled'
    || receipt.databaseRole !== instance.role
    || receipt.databaseInstanceId !== instance.instanceId
    || receipt.runtimeReady !== false
    || !exactFinalizedHeads(receipt)
    || !exactAbortEvidence(receipt)
    || receipt.businessDmlReplayed !== false
    || receipt.remoteOnlyReservationCount !== 0) {
    fail('autonomous_research_state_reconcile_and_renew_reconciliation_invalid');
  }
  return Object.freeze({
    databaseRole: instance.role,
    databaseInstanceId: instance.instanceId,
    recoveredReservationIds: Object.freeze([...receipt.recoveredReservationIds]),
    finalizedHeads: Object.freeze(receipt.finalizedHeads
      ? [...receipt.finalizedHeads] : []),
    abortedRemoteOnlyReservationIds: Object.freeze([
      ...receipt.abortedRemoteOnlyReservationIds,
    ]),
    abortedRemoteOnlyAbortReceiptHashes: Object.freeze([
      ...receipt.abortedRemoteOnlyAbortReceiptHashes,
    ]),
    abortedRemoteOnlyAbortReceipts: Object.freeze([
      ...receipt.abortedRemoteOnlyAbortReceipts,
    ]),
    reconciliationReceiptHash: hashRecord(
      'AutonomousResearchOnlineMutationUnresolvedReservationReconciliationReceipt',
      receipt,
    ),
  });
}

function blocked({
  blockers,
  initialInventory = null,
  reconciledInventory = null,
  reconciliations = [],
  pendingInspections = [],
  renewalReceipt = null,
  backupAttempted = false,
}) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateReconcileAndRenewReceipt',
    status: 'autonomous_research_state_reconcile_and_renew_blocked',
    businessDmlReplayed: false,
    backupAttempted,
    initialInventoryHash: initialInventory?.inventoryHash || null,
    reconciledInventoryHash: reconciledInventory?.inventoryHash || null,
    databaseScopeHash:
      reconciledInventory?.databaseScopeHash || initialInventory?.databaseScopeHash || null,
    reconciliations: Object.freeze([...reconciliations]),
    pendingInspections: Object.freeze([...pendingInspections]),
    renewalReceipt,
    blockers: Object.freeze([...new Set(blockers)].sort()),
  });
}

async function reconcileExactPendingState({
  resolveInventory,
  authorityTrust,
  backupOnlineMutationTrust,
  writerManifest,
  reconcileDatabaseStartup,
  inspectPendingFinalizations,
} = {}) {
  let initialInventory = null;
  let reconciledInventory = null;
  let writerManifestHash = null;
  const reconciliations = [];
  const pendingInspections = [];
  try {
    if (typeof resolveInventory !== 'function'
      || typeof reconcileDatabaseStartup !== 'function'
      || typeof inspectPendingFinalizations !== 'function') {
      fail('autonomous_research_state_reconcile_and_renew_configuration_invalid');
    }
    const manifest = assertAutonomousResearchOnlineWriterOperationManifest(writerManifest);
    writerManifestHash = autonomousResearchOnlineWriterOperationManifestHash(manifest);
    initialInventory = validateExactInventory(await resolveInventory());
    if (authorityTrust?.version !== 1
      || authorityTrust.kind !== 'AutonomousResearchOnlineMutationAuthorityTrust'
      || backupOnlineMutationTrust?.version !== 1
      || backupOnlineMutationTrust.kind
        !== 'AutonomousResearchOnlineMutationAuthorityTrust'
      || authorityTrust?.databaseScopeHash !== initialInventory.databaseScopeHash
      || authorityTrust?.writerManifestHash !== writerManifestHash) {
      fail('autonomous_research_state_reconcile_and_renew_authority_scope_mismatch');
    }
    for (const key of [
      'authorityId', 'keyId', 'scopeId', 'databaseScopeHash', 'writerManifestHash',
    ]) {
      if (backupOnlineMutationTrust?.[key] !== authorityTrust?.[key]) {
        fail(
          'autonomous_research_state_reconcile_and_renew_backup_online_authority_mismatch',
        );
      }
    }
    for (const instance of initialInventory.instances) {
      const receipt = await reconcileDatabaseStartup({
        inventory: initialInventory,
        instance,
        authorityTrust,
        writerManifest: manifest,
      });
      reconciliations.push(validatedReconciliationSummary(receipt, instance));
    }
    reconciledInventory = validateExactInventory(await resolveInventory());
    if (!stableExactScope(initialInventory, reconciledInventory)) {
      fail('autonomous_research_state_reconcile_and_renew_inventory_scope_changed');
    }
    for (const instance of reconciledInventory.instances) {
      const inspection = await inspectPendingFinalizations({
        inventory: reconciledInventory,
        instance,
      });
      if (inspection?.databaseRole !== instance.role
        || inspection.databaseInstanceId !== instance.instanceId
        || inspection.pendingFinalizationCount !== 0) {
        fail('autonomous_research_state_reconcile_and_renew_pending_finalization_required');
      }
      pendingInspections.push(Object.freeze({ ...inspection }));
    }
    return Object.freeze({
      ready: true,
      writerManifestHash,
      initialInventory,
      reconciledInventory,
      reconciliations: Object.freeze([...reconciliations]),
      pendingInspections: Object.freeze([...pendingInspections]),
      blocker: null,
    });
  } catch (error) {
    return Object.freeze({
      ready: false,
      writerManifestHash,
      initialInventory,
      reconciledInventory,
      reconciliations: Object.freeze([...reconciliations]),
      pendingInspections: Object.freeze([...pendingInspections]),
      blocker: error?.message || 'autonomous_research_state_reconcile_and_renew_failed',
    });
  }
}

export async function reconcileAndRenewAutonomousResearchStateBackup({
  resolveInventory,
  authorityTrust,
  backupOnlineMutationTrust,
  writerManifest,
  reconcileDatabaseStartup,
  inspectPendingFinalizations,
  renewBackup,
  clock = { now: () => new Date() },
} = {}) {
  if (typeof renewBackup !== 'function') {
    return blocked({
      blockers: ['autonomous_research_state_reconcile_and_renew_configuration_invalid'],
    });
  }
  const state = await reconcileExactPendingState({
    resolveInventory,
    authorityTrust,
    backupOnlineMutationTrust,
    writerManifest,
    reconcileDatabaseStartup,
    inspectPendingFinalizations,
  });
  const {
    initialInventory,
    reconciledInventory,
    reconciliations,
    pendingInspections,
    writerManifestHash,
  } = state;
  if (!state.ready) {
    return blocked({
      blockers: [state.blocker],
      initialInventory,
      reconciledInventory,
      reconciliations,
      pendingInspections,
    });
  }
  let renewalReceipt = null;
  try {
    renewalReceipt = await renewBackup();
    if (renewalReceipt?.status !== 'autonomous_research_state_backup_renewal_complete'
      || !SHA256.test(String(renewalReceipt?.renewalReceiptHash || ''))) {
      return blocked({
        blockers: [
          ...(renewalReceipt?.blockers || []),
          'autonomous_research_state_reconcile_and_renew_backup_renewal_required',
        ],
        initialInventory,
        reconciledInventory,
        reconciliations,
        pendingInspections,
        renewalReceipt,
        backupAttempted: true,
      });
    }
    const payload = Object.freeze({
      version: 1,
      kind: 'AutonomousResearchStateReconcileAndRenewReceipt',
      status: 'autonomous_research_state_reconcile_and_renew_complete',
      databaseScopeHash: reconciledInventory.databaseScopeHash,
      writerManifestHash,
      initialInventoryHash: initialInventory.inventoryHash,
      reconciledInventoryHash: reconciledInventory.inventoryHash,
      reconciledDatabaseCount: reconciliations.length,
      recoveredFinalizationCount: reconciliations.reduce(
        (count, receipt) => count + receipt.recoveredReservationIds.length,
        0,
      ),
      abortedRemoteOnlyReservationCount: reconciliations.reduce(
        (count, receipt) => count + receipt.abortedRemoteOnlyReservationIds.length,
        0,
      ),
      businessDmlReplayed: false,
      backupAttempted: true,
      renewalReceiptHash: renewalReceipt.renewalReceiptHash,
      reconciliationReceiptHashes: Object.freeze(reconciliations.map(
        (receipt) => receipt.reconciliationReceiptHash,
      )),
      pendingInspectionSetHash: hashRecord(
        'AutonomousResearchStatePendingFinalizationInspectionSet',
        pendingInspections,
      ),
      completedAt: observedNow(clock).toISOString(),
      blockers: Object.freeze([]),
    });
    return Object.freeze({
      ...payload,
      reconcileAndRenewReceiptHash: hashRecord(
        'AutonomousResearchStateReconcileAndRenewReceipt', payload,
      ),
      reconciliations: Object.freeze([...reconciliations]),
      pendingInspections: Object.freeze([...pendingInspections]),
      renewalReceipt,
    });
  } catch (error) {
    return blocked({
      blockers: [
        error?.message || 'autonomous_research_state_reconcile_and_renew_failed',
      ],
      initialInventory,
      reconciledInventory,
      reconciliations,
      pendingInspections,
      renewalReceipt,
      backupAttempted: true,
    });
  }
}

export async function reconcileAutonomousResearchStatePendingMutations(options = {}) {
  const reconciled = await reconcileExactPendingState(options);
  if (!reconciled.ready) {
    return Object.freeze({
      version: 1,
      kind: 'AutonomousResearchStatePendingReconciliationReceipt',
      status: 'autonomous_research_state_pending_reconciliation_blocked',
      businessDmlReplayed: false,
      databaseScopeHash:
        reconciled.reconciledInventory?.databaseScopeHash
        || reconciled.initialInventory?.databaseScopeHash
        || null,
      reconciliationAttempted: true,
      recovery: null,
      reconciliations: reconciled.reconciliations,
      pendingInspections: reconciled.pendingInspections,
      blockers: Object.freeze([reconciled.blocker]),
    });
  }
  const finalizedHeads = reconciled.reconciliations.flatMap(
    (receipt) => receipt.finalizedHeads,
  );
  const abortedRemoteOnlyReservationIds = reconciled.reconciliations.flatMap(
    (receipt) => receipt.abortedRemoteOnlyReservationIds,
  );
  const abortedRemoteOnlyAbortReceiptHashes = reconciled.reconciliations.flatMap(
    (receipt) => receipt.abortedRemoteOnlyAbortReceiptHashes,
  );
  const abortedRemoteOnlyAbortReceipts = reconciled.reconciliations.flatMap(
    (receipt) => receipt.abortedRemoteOnlyAbortReceipts,
  );
  const recovery = Object.freeze({
    finalizedHeads: Object.freeze(finalizedHeads),
    abortedRemoteOnlyReservationIds: Object.freeze(abortedRemoteOnlyReservationIds),
    abortedRemoteOnlyAbortReceiptHashes: Object.freeze(
      abortedRemoteOnlyAbortReceiptHashes,
    ),
    abortedRemoteOnlyAbortReceipts: Object.freeze(abortedRemoteOnlyAbortReceipts),
  });
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStatePendingReconciliationReceipt',
    status: 'autonomous_research_state_pending_reconciliation_complete',
    businessDmlReplayed: false,
    databaseScopeHash: reconciled.reconciledInventory.databaseScopeHash,
    reconciledDatabaseCount: reconciled.reconciliations.length,
    recoveredFinalizationCount: finalizedHeads.length,
    abortedRemoteOnlyReservationCount: abortedRemoteOnlyReservationIds.length,
    reconciliationAttempted: true,
    recovery,
    reconciliations: reconciled.reconciliations,
    pendingInspections: reconciled.pendingInspections,
    completedAt: observedNow(options.clock).toISOString(),
    blockers: Object.freeze([]),
  });
  return Object.freeze({
    ...payload,
    pendingReconciliationReceiptHash: hashRecord(
      'AutonomousResearchStatePendingReconciliationReceipt', payload,
    ),
  });
}

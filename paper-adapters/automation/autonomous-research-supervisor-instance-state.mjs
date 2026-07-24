const SCOPE_ID = 'resident-autonomous-research-supervisor';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function observedSupervisorInstanceDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_supervisor_instance_clock_invalid');
  }
  return date;
}

export function normalizeSupervisorInstanceTiming({
  leaseMs = 15 * 60 * 1_000,
  heartbeatMs = 30_000,
} = {}) {
  const lease = Number(leaseMs);
  const heartbeat = Number(heartbeatMs);
  if (!Number.isSafeInteger(lease) || lease < 1_000 || lease > 30 * 60 * 1_000
    || !Number.isSafeInteger(heartbeat) || heartbeat < 250
    || heartbeat * 2 >= lease) {
    throw new Error('autonomous_research_supervisor_instance_timing_invalid');
  }
  return Object.freeze({ leaseMs: lease, heartbeatMs: heartbeat });
}

export function supervisorInstanceLeaseIdentity(value = {}) {
  if (!SAFE_ID.test(String(value.ownerId || ''))
    || !SAFE_ID.test(String(value.leaseToken || ''))
    || !Number.isSafeInteger(Number(value.leaseGeneration))
    || Number(value.leaseGeneration) < 1) {
    throw new Error('autonomous_research_supervisor_instance_lease_identity_invalid');
  }
  return Object.freeze({
    ownerId: String(value.ownerId),
    leaseToken: String(value.leaseToken),
    leaseGeneration: Number(value.leaseGeneration),
  });
}

export function mapSupervisorInstanceRow(row) {
  if (!row) return null;
  return Object.freeze({
    scopeId: row.scope_id,
    status: row.status,
    ownerId: row.owner_id || null,
    leaseToken: row.lease_token || null,
    leaseGeneration: Number(row.lease_generation),
    leaseDurationMs: Number(row.lease_duration_ms),
    heartbeatIntervalMs: Number(row.heartbeat_interval_ms),
    startedAt: row.started_at || null,
    lastHeartbeatAt: row.last_heartbeat_at || null,
    leaseExpiresAt: row.lease_expires_at || null,
    startupReconciledAt: row.startup_reconciled_at || null,
    startupReconciliationReceiptHash: row.startup_reconciliation_receipt_hash || null,
    fullyAutonomousRequired: Number(row.fully_autonomous_required || 0) === 1,
    fullyAutonomousPrerequisiteIdentityHash:
      row.fully_autonomous_prerequisite_identity_hash || null,
    machineIntakeReconciledAt: row.machine_intake_reconciled_at || null,
    machineIntakeReconciliationReceiptHash:
      row.machine_intake_reconciliation_receipt_hash || null,
    machineIntakeConfigurationHash: row.machine_intake_configuration_hash || null,
    machineIntakeDatasetSnapshotHash: row.machine_intake_dataset_snapshot_hash || null,
    machineIntakeReconciliationFailedAt:
      row.machine_intake_reconciliation_failed_at || null,
    machineIntakeReconciliationFailure: row.machine_intake_reconciliation_failure || null,
    lastCycleAt: row.last_cycle_at || null,
    lastCycleReceiptHash: row.last_cycle_receipt_hash || null,
    stoppedAt: row.stopped_at || null,
    stopReason: row.stop_reason || null,
    recoveredLeaseCount: Number(row.recovered_lease_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function persistedSupervisorInstanceStateValid(instance) {
  if (!instance || instance.scopeId !== SCOPE_ID
    || !['running', 'stopped'].includes(instance.status)
    || !Number.isSafeInteger(instance.leaseGeneration) || instance.leaseGeneration < 1
    || !Number.isSafeInteger(instance.leaseDurationMs) || instance.leaseDurationMs < 1_000
    || instance.leaseDurationMs > 30 * 60 * 1_000
    || !Number.isSafeInteger(instance.heartbeatIntervalMs)
    || instance.heartbeatIntervalMs < 250
    || instance.heartbeatIntervalMs * 2 >= instance.leaseDurationMs
    || !Number.isFinite(Date.parse(instance.createdAt || ''))
    || !Number.isFinite(Date.parse(instance.updatedAt || ''))
    || ((instance.startupReconciliationReceiptHash === null)
      !== (instance.startupReconciledAt === null))
    || (instance.startupReconciliationReceiptHash !== null
      && (!SHA256.test(String(instance.startupReconciliationReceiptHash))
        || !Number.isFinite(Date.parse(instance.startupReconciledAt || ''))))
    || (!instance.fullyAutonomousRequired
      && instance.fullyAutonomousPrerequisiteIdentityHash !== null)
    || (instance.fullyAutonomousRequired
      && instance.startupReconciliationReceiptHash !== null
      && !SHA256.test(String(instance.fullyAutonomousPrerequisiteIdentityHash || '')))
    || ((instance.machineIntakeReconciliationReceiptHash === null)
      !== (instance.machineIntakeReconciledAt === null))
    || ((instance.machineIntakeReconciliationReceiptHash === null)
      !== (instance.machineIntakeConfigurationHash === null))
    || (instance.machineIntakeReconciliationReceiptHash !== null
      && (!SHA256.test(String(instance.machineIntakeReconciliationReceiptHash))
        || !SHA256.test(String(instance.machineIntakeConfigurationHash))
        || !Number.isFinite(Date.parse(instance.machineIntakeReconciledAt || ''))
        || instance.startupReconciliationReceiptHash === null))
    || (instance.machineIntakeDatasetSnapshotHash !== null
      && (!SHA256.test(String(instance.machineIntakeDatasetSnapshotHash))
        || instance.machineIntakeReconciliationReceiptHash === null))
    || ((instance.machineIntakeReconciliationFailure === null)
      !== (instance.machineIntakeReconciliationFailedAt === null))
    || (instance.machineIntakeReconciliationFailure !== null
      && (!Number.isFinite(Date.parse(instance.machineIntakeReconciliationFailedAt || ''))
        || String(instance.machineIntakeReconciliationFailure).length > 1000
        || instance.startupReconciliationReceiptHash === null))
    || (instance.machineIntakeReconciliationReceiptHash !== null
      && instance.machineIntakeReconciliationFailure !== null)
    || ((instance.lastCycleReceiptHash === null) !== (instance.lastCycleAt === null))
    || (instance.lastCycleReceiptHash !== null
      && (!SHA256.test(String(instance.lastCycleReceiptHash))
        || !Number.isFinite(Date.parse(instance.lastCycleAt || ''))))) return false;
  if (instance.status === 'stopped') {
    return instance.ownerId === null && instance.leaseToken === null
      && instance.leaseExpiresAt === null;
  }
  const heartbeatAt = Date.parse(instance.lastHeartbeatAt || '');
  const expiresAt = Date.parse(instance.leaseExpiresAt || '');
  return SAFE_ID.test(String(instance.ownerId || ''))
    && SAFE_ID.test(String(instance.leaseToken || ''))
    && Number.isFinite(Date.parse(instance.startedAt || ''))
    && Number.isFinite(heartbeatAt)
    && Number.isFinite(expiresAt)
    && expiresAt > heartbeatAt
    && expiresAt - heartbeatAt <= instance.leaseDurationMs + 1_000;
}

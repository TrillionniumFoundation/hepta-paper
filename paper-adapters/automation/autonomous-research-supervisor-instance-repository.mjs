import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCOPE_ID = 'resident-autonomous-research-supervisor';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;

function observedDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_supervisor_instance_clock_invalid');
  }
  return date;
}

function normalizeTiming({ leaseMs = 15 * 60 * 1_000, heartbeatMs = 30_000 } = {}) {
  const lease = Number(leaseMs);
  const heartbeat = Number(heartbeatMs);
  if (!Number.isSafeInteger(lease) || lease < 1_000 || lease > 30 * 60 * 1_000
    || !Number.isSafeInteger(heartbeat) || heartbeat < 250
    || heartbeat * 2 >= lease) {
    throw new Error('autonomous_research_supervisor_instance_timing_invalid');
  }
  return Object.freeze({ leaseMs: lease, heartbeatMs: heartbeat });
}

function leaseIdentity(value = {}) {
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

function mapRow(row) {
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
    fullyAutonomousPrerequisiteIdentityHash: row.fully_autonomous_prerequisite_identity_hash || null,
    machineIntakeReconciledAt: row.machine_intake_reconciled_at || null,
    machineIntakeReconciliationReceiptHash: row.machine_intake_reconciliation_receipt_hash || null,
    machineIntakeConfigurationHash: row.machine_intake_configuration_hash || null,
    machineIntakeDatasetSnapshotHash: row.machine_intake_dataset_snapshot_hash || null,
    machineIntakeReconciliationFailedAt: row.machine_intake_reconciliation_failed_at || null,
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
function persistedInstanceStateValid(instance) {
  if (!instance || instance.scopeId !== SCOPE_ID
    || !['running', 'stopped'].includes(instance.status)
    || !Number.isSafeInteger(instance.leaseGeneration) || instance.leaseGeneration < 1
    || !Number.isSafeInteger(instance.leaseDurationMs) || instance.leaseDurationMs < 1_000
    || instance.leaseDurationMs > 30 * 60 * 1_000
    || !Number.isSafeInteger(instance.heartbeatIntervalMs) || instance.heartbeatIntervalMs < 250
    || instance.heartbeatIntervalMs * 2 >= instance.leaseDurationMs
    || !Number.isFinite(Date.parse(instance.createdAt || ''))
    || !Number.isFinite(Date.parse(instance.updatedAt || ''))
    || ((instance.startupReconciliationReceiptHash === null) !== (instance.startupReconciledAt === null))
    || (instance.startupReconciliationReceiptHash !== null
      && (!SHA256.test(String(instance.startupReconciliationReceiptHash))
        || !Number.isFinite(Date.parse(instance.startupReconciledAt || ''))))
    || (!instance.fullyAutonomousRequired && instance.fullyAutonomousPrerequisiteIdentityHash !== null)
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

function validateDatabaseFile(databasePath) {
  const stat = fs.lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    throw new Error('autonomous_research_supervisor_instance_database_invalid');
  }
}

export function createAutonomousResearchSupervisorInstanceRepository({
  runtimeRoot,
  create = true,
  busyTimeoutMs = 10_000,
} = {}) {
  if (!runtimeRoot) {
    throw new Error('autonomous_research_supervisor_instance_runtime_root_required');
  }
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) {
    throw new Error('autonomous_research_supervisor_instance_busy_timeout_invalid');
  }
  const stateRoot = path.join(path.resolve(runtimeRoot), 'autonomous-research', 'supervisor');
  const databasePath = path.join(stateRoot, 'resident-instance.sqlite');
  if (create) {
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateRoot, 0o700);
    if (!fs.existsSync(databasePath)) fs.closeSync(fs.openSync(databasePath, 'wx', 0o600));
  }
  if (fs.existsSync(databasePath)) validateDatabaseFile(databasePath);
  const database = fs.existsSync(databasePath)
    ? new DatabaseSync(databasePath, { readOnly: !create }) : null;
  if (database) database.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
  if (database && create) {
    try {
      // DELETE journaling preserves the zero-write health/status read contract.
      database.exec('PRAGMA journal_mode=DELETE;');
      database.exec('PRAGMA synchronous=FULL;');
      database.exec(`CREATE TABLE IF NOT EXISTS autonomous_research_supervisor_instance (
        scope_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('running','stopped')),
        owner_id TEXT,
        lease_token TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
        lease_duration_ms INTEGER NOT NULL CHECK(lease_duration_ms >= 1000),
        heartbeat_interval_ms INTEGER NOT NULL CHECK(heartbeat_interval_ms >= 250),
        started_at TEXT,
        last_heartbeat_at TEXT,
        lease_expires_at TEXT,
        startup_reconciled_at TEXT,
        startup_reconciliation_receipt_hash TEXT,
        fully_autonomous_required INTEGER NOT NULL DEFAULT 0 CHECK(fully_autonomous_required IN (0,1)),
        fully_autonomous_prerequisite_identity_hash TEXT,
        machine_intake_reconciled_at TEXT,
        machine_intake_reconciliation_receipt_hash TEXT,
        machine_intake_configuration_hash TEXT,
        machine_intake_dataset_snapshot_hash TEXT,
        machine_intake_reconciliation_failed_at TEXT,
        machine_intake_reconciliation_failure TEXT,
        last_cycle_at TEXT,
        last_cycle_receipt_hash TEXT,
        stopped_at TEXT,
        stop_reason TEXT,
        recovered_lease_count INTEGER NOT NULL DEFAULT 0 CHECK(recovered_lease_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;`);
      const columns = new Set(database.prepare(
        'PRAGMA table_info(autonomous_research_supervisor_instance)',
      ).all().map((column) => column.name));
      if (!columns.has('startup_reconciled_at')) {
        database.exec(`ALTER TABLE autonomous_research_supervisor_instance
          ADD COLUMN startup_reconciled_at TEXT;`);
      }
      if (!columns.has('startup_reconciliation_receipt_hash')) {
        database.exec(`ALTER TABLE autonomous_research_supervisor_instance
          ADD COLUMN startup_reconciliation_receipt_hash TEXT;`);
      }
      for (const [column, type] of [
        ['fully_autonomous_required', 'INTEGER NOT NULL DEFAULT 0 CHECK(fully_autonomous_required IN (0,1))'],
        ['fully_autonomous_prerequisite_identity_hash', 'TEXT'],
        ['machine_intake_reconciled_at', 'TEXT'],
        ['machine_intake_reconciliation_receipt_hash', 'TEXT'],
        ['machine_intake_configuration_hash', 'TEXT'],
        ['machine_intake_dataset_snapshot_hash', 'TEXT'],
        ['machine_intake_reconciliation_failed_at', 'TEXT'],
        ['machine_intake_reconciliation_failure', 'TEXT'],
      ]) {
        if (!columns.has(column)) {
          database.exec(`ALTER TABLE autonomous_research_supervisor_instance
            ADD COLUMN ${column} ${type};`);
        }
      }
      fs.chmodSync(databasePath, 0o600);
    } catch (error) {
      database.close();
      throw error;
    }
  }
  let closed = false;

  function requireDatabase({ writable = false } = {}) {
    if (closed) throw new Error('autonomous_research_supervisor_instance_repository_closed');
    if (!database) {
      if (writable) throw new Error('autonomous_research_supervisor_instance_state_missing');
      return null;
    }
    if (writable && !create) {
      throw new Error('autonomous_research_supervisor_instance_repository_read_only');
    }
    return database;
  }

  function readInstance() {
    const db = requireDatabase();
    if (!db) return null;
    return mapRow(db.prepare(`SELECT * FROM autonomous_research_supervisor_instance
      WHERE scope_id=?`).get(SCOPE_ID));
  }

  function rollback() {
    if (database?.isTransaction) {
      try { database.exec('ROLLBACK;'); } catch { /* preserve original failure */ }
    }
  }

  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorInstanceRepository',
    durable: true,
    compareAndSwap: true,
    systemOwnedRuntimeState: true,
    readOnly: !create,
    databasePath,
    readInstance,
    acquireInstanceLease({
      ownerId,
      leaseMs = 15 * 60 * 1_000,
      heartbeatMs = 30_000,
      fullyAutonomousRequired = false,
      now = new Date(),
    } = {}) {
      const db = requireDatabase({ writable: true });
      if (!SAFE_ID.test(String(ownerId || ''))) {
        throw new Error('autonomous_research_supervisor_instance_owner_invalid');
      }
      const timing = normalizeTiming({ leaseMs, heartbeatMs });
      const observedAt = observedDate(now);
      try {
        db.exec('BEGIN IMMEDIATE;');
        const current = readInstance();
        if (current && !persistedInstanceStateValid(current)) {
          throw new Error('autonomous_research_supervisor_instance_state_invalid');
        }
        const currentExpiry = Date.parse(current?.leaseExpiresAt || '');
        if (current?.status === 'running' && Number.isFinite(currentExpiry)
          && currentExpiry > observedAt.getTime()) {
          db.exec('COMMIT;');
          return null;
        }
        const recovered = current?.status === 'running' && Number.isFinite(currentExpiry)
          && currentExpiry <= observedAt.getTime();
        const lease = Object.freeze({
          ownerId: String(ownerId),
          leaseToken: `instance:${crypto.randomUUID()}`,
          leaseGeneration: Number(current?.leaseGeneration || 0) + 1,
          heartbeatMs: timing.heartbeatMs,
          leaseMs: timing.leaseMs,
          expiresAt: new Date(observedAt.getTime() + timing.leaseMs).toISOString(),
        });
        db.prepare(`INSERT INTO autonomous_research_supervisor_instance(
          scope_id,status,owner_id,lease_token,lease_generation,lease_duration_ms,
          heartbeat_interval_ms,started_at,last_heartbeat_at,lease_expires_at,
          startup_reconciled_at,startup_reconciliation_receipt_hash,
          fully_autonomous_required,fully_autonomous_prerequisite_identity_hash,
          machine_intake_reconciled_at,machine_intake_reconciliation_receipt_hash,
          machine_intake_configuration_hash,machine_intake_dataset_snapshot_hash,
          machine_intake_reconciliation_failed_at,
          machine_intake_reconciliation_failure,last_cycle_at,last_cycle_receipt_hash,
          stopped_at,stop_reason,recovered_lease_count,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(scope_id) DO UPDATE SET
          status='running',owner_id=excluded.owner_id,lease_token=excluded.lease_token,
          lease_generation=excluded.lease_generation,
          lease_duration_ms=excluded.lease_duration_ms,
          heartbeat_interval_ms=excluded.heartbeat_interval_ms,
          started_at=excluded.started_at,last_heartbeat_at=excluded.last_heartbeat_at,
          lease_expires_at=excluded.lease_expires_at,startup_reconciled_at=NULL,
          startup_reconciliation_receipt_hash=NULL,machine_intake_reconciled_at=NULL,
          fully_autonomous_required=excluded.fully_autonomous_required,
          fully_autonomous_prerequisite_identity_hash=NULL,
          machine_intake_reconciliation_receipt_hash=NULL,
          machine_intake_configuration_hash=NULL,
          machine_intake_dataset_snapshot_hash=NULL,
          machine_intake_reconciliation_failed_at=NULL,
          machine_intake_reconciliation_failure=NULL,last_cycle_at=NULL,
          last_cycle_receipt_hash=NULL,stopped_at=NULL,stop_reason=NULL,
          recovered_lease_count=autonomous_research_supervisor_instance.recovered_lease_count+?,
          updated_at=excluded.updated_at`).run(
          SCOPE_ID,
          'running',
          lease.ownerId,
          lease.leaseToken,
          lease.leaseGeneration,
          timing.leaseMs,
          timing.heartbeatMs,
          observedAt.toISOString(),
          observedAt.toISOString(),
          lease.expiresAt,
          null,
          null,
          fullyAutonomousRequired ? 1 : 0,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          recovered ? 1 : 0,
          observedAt.toISOString(),
          observedAt.toISOString(),
          recovered ? 1 : 0,
        );
        db.exec('COMMIT;');
        return lease;
      } catch (error) {
        rollback();
        throw error;
      }
    },
    markStartupReconciled({ lease, receiptHash, fullyAutonomousPrerequisiteReceipt = null,
      now = new Date() } = {}) {
      const db = requireDatabase({ writable: true });
      const identity = leaseIdentity(lease);
      if (!SHA256.test(String(receiptHash || ''))) {
        throw new Error(
          'autonomous_research_supervisor_startup_reconciliation_receipt_invalid',
        );
      }
      const current = readInstance();
      const prerequisiteIdentityHash = fullyAutonomousPrerequisiteReceipt
        ?.autonomousResearchResidentPrerequisiteIdentityHash || null;
      if ((current?.fullyAutonomousRequired === true
          && (fullyAutonomousPrerequisiteReceipt?.infrastructureReady !== true
            || !SHA256.test(String(prerequisiteIdentityHash || ''))))
        || (current?.fullyAutonomousRequired !== true
          && fullyAutonomousPrerequisiteReceipt !== null)) {
        throw new Error(
          'autonomous_research_supervisor_full_prerequisite_receipt_invalid',
        );
      }
      const timing = normalizeTiming({
        leaseMs: lease?.leaseMs,
        heartbeatMs: lease?.heartbeatMs,
      });
      const observedAt = observedDate(now);
      const expiresAt = new Date(observedAt.getTime() + timing.leaseMs).toISOString();
      const result = db.prepare(`UPDATE autonomous_research_supervisor_instance SET
        last_heartbeat_at=?,lease_expires_at=?,startup_reconciled_at=?,
        startup_reconciliation_receipt_hash=?,
        fully_autonomous_prerequisite_identity_hash=?,updated_at=? WHERE scope_id=?
        AND status='running' AND owner_id=? AND lease_token=? AND lease_generation=?
        AND julianday(lease_expires_at)>julianday(?)`).run(
        observedAt.toISOString(),
        expiresAt,
        observedAt.toISOString(),
        receiptHash,
        prerequisiteIdentityHash,
        observedAt.toISOString(),
        SCOPE_ID,
        identity.ownerId,
        identity.leaseToken,
        identity.leaseGeneration,
        observedAt.toISOString(),
      );
      return Number(result.changes) === 1
        ? Object.freeze({ ...lease, expiresAt }) : null;
    },
    markMachineIntakeReconciled({
      lease,
      receiptHash,
      configurationHash,
      datasetSnapshotHash = null,
      now = new Date(),
    } = {}) {
      const db = requireDatabase({ writable: true });
      const identity = leaseIdentity(lease);
      if (!SHA256.test(String(receiptHash || ''))
        || !SHA256.test(String(configurationHash || ''))
        || (datasetSnapshotHash !== null
          && !SHA256.test(String(datasetSnapshotHash)))) {
        throw new Error(
          'autonomous_research_supervisor_machine_intake_reconciliation_receipt_invalid',
        );
      }
      const timing = normalizeTiming({
        leaseMs: lease?.leaseMs,
        heartbeatMs: lease?.heartbeatMs,
      });
      const observedAt = observedDate(now);
      const expiresAt = new Date(observedAt.getTime() + timing.leaseMs).toISOString();
      const result = db.prepare(`UPDATE autonomous_research_supervisor_instance SET
        last_heartbeat_at=?,lease_expires_at=?,machine_intake_reconciled_at=?,
        machine_intake_reconciliation_receipt_hash=?,machine_intake_configuration_hash=?,
        machine_intake_dataset_snapshot_hash=?,
        machine_intake_reconciliation_failed_at=NULL,
        machine_intake_reconciliation_failure=NULL,updated_at=? WHERE scope_id=?
        AND status='running' AND owner_id=? AND lease_token=? AND lease_generation=?
        AND startup_reconciliation_receipt_hash IS NOT NULL
        AND julianday(lease_expires_at)>julianday(?)`).run(
        observedAt.toISOString(),
        expiresAt,
        observedAt.toISOString(),
        receiptHash,
        configurationHash,
        datasetSnapshotHash,
        observedAt.toISOString(),
        SCOPE_ID,
        identity.ownerId,
        identity.leaseToken,
        identity.leaseGeneration,
        observedAt.toISOString(),
      );
      return Number(result.changes) === 1
        ? Object.freeze({ ...lease, expiresAt }) : null;
    },
    markMachineIntakeReconciliationFailed({ lease, reason, now = new Date() } = {}) {
      const db = requireDatabase({ writable: true });
      const identity = leaseIdentity(lease);
      const failure = String(reason || '').slice(0, 1000);
      if (!failure) {
        throw new Error(
          'autonomous_research_supervisor_machine_intake_reconciliation_failure_invalid',
        );
      }
      const timing = normalizeTiming({
        leaseMs: lease?.leaseMs,
        heartbeatMs: lease?.heartbeatMs,
      });
      const observedAt = observedDate(now);
      const expiresAt = new Date(observedAt.getTime() + timing.leaseMs).toISOString();
      const result = db.prepare(`UPDATE autonomous_research_supervisor_instance SET
        last_heartbeat_at=?,lease_expires_at=?,machine_intake_reconciled_at=NULL,
        machine_intake_reconciliation_receipt_hash=NULL,
        machine_intake_configuration_hash=NULL,machine_intake_dataset_snapshot_hash=NULL,
        machine_intake_reconciliation_failed_at=?,
        machine_intake_reconciliation_failure=?,updated_at=? WHERE scope_id=?
        AND status='running' AND owner_id=? AND lease_token=? AND lease_generation=?
        AND startup_reconciliation_receipt_hash IS NOT NULL
        AND julianday(lease_expires_at)>julianday(?)`).run(
        observedAt.toISOString(),
        expiresAt,
        observedAt.toISOString(),
        failure,
        observedAt.toISOString(),
        SCOPE_ID,
        identity.ownerId,
        identity.leaseToken,
        identity.leaseGeneration,
        observedAt.toISOString(),
      );
      return Number(result.changes) === 1
        ? Object.freeze({ ...lease, expiresAt }) : null;
    },
    assertInstanceLease({ lease, now = new Date() } = {}) {
      const db = requireDatabase();
      const identity = leaseIdentity(lease);
      const observedAt = observedDate(now);
      const current = mapRow(db.prepare(`SELECT *
        FROM autonomous_research_supervisor_instance WHERE scope_id=?
        AND status='running' AND owner_id=? AND lease_token=? AND lease_generation=?
        AND julianday(lease_expires_at)>julianday(?)`).get(
        SCOPE_ID,
        identity.ownerId,
        identity.leaseToken,
        identity.leaseGeneration,
        observedAt.toISOString(),
      ));
      if (!current || !persistedInstanceStateValid(current)) {
        throw new Error('autonomous_research_supervisor_instance_lease_fence_conflict');
      }
      return current;
    },
    heartbeatInstanceLease({ lease, cycleReceipt = null, now = new Date() } = {}) {
      const db = requireDatabase({ writable: true });
      const identity = leaseIdentity(lease);
      const timing = normalizeTiming({
        leaseMs: lease?.leaseMs,
        heartbeatMs: lease?.heartbeatMs,
      });
      const observedAt = observedDate(now);
      const cycleHash = cycleReceipt?.autonomousResearchSupervisorCycleReceiptHash || null;
      if (cycleHash !== null && !SHA256.test(String(cycleHash))) {
        throw new Error('autonomous_research_supervisor_instance_cycle_receipt_invalid');
      }
      const expiresAt = new Date(observedAt.getTime() + timing.leaseMs).toISOString();
      const result = db.prepare(`UPDATE autonomous_research_supervisor_instance SET
        last_heartbeat_at=?,lease_expires_at=?,last_cycle_at=CASE WHEN ? IS NULL
          THEN last_cycle_at ELSE ? END,last_cycle_receipt_hash=coalesce(?,last_cycle_receipt_hash),
        updated_at=? WHERE scope_id=? AND status='running' AND owner_id=?
        AND lease_token=? AND lease_generation=?
        AND julianday(lease_expires_at)>julianday(?)`).run(
        observedAt.toISOString(),
        expiresAt,
        cycleHash,
        observedAt.toISOString(),
        cycleHash,
        observedAt.toISOString(),
        SCOPE_ID,
        identity.ownerId,
        identity.leaseToken,
        identity.leaseGeneration,
        observedAt.toISOString(),
      );
      return Number(result.changes) === 1
        ? Object.freeze({ ...lease, expiresAt }) : null;
    },
    releaseInstanceLease({ lease, reason = 'supervisor_process_shutdown', now = new Date() } = {}) {
      const db = requireDatabase({ writable: true });
      const identity = leaseIdentity(lease);
      const observedAt = observedDate(now);
      const result = db.prepare(`UPDATE autonomous_research_supervisor_instance SET
        status='stopped',owner_id=NULL,lease_token=NULL,lease_expires_at=NULL,
        stopped_at=?,stop_reason=?,updated_at=? WHERE scope_id=? AND status='running'
        AND owner_id=? AND lease_token=? AND lease_generation=?
        AND julianday(lease_expires_at)>julianday(?)`).run(
        observedAt.toISOString(),
        String(reason || 'supervisor_stopped').slice(0, 1000),
        observedAt.toISOString(),
        SCOPE_ID,
        identity.ownerId,
        identity.leaseToken,
        identity.leaseGeneration,
        observedAt.toISOString(),
      );
      return Number(result.changes) === 1;
    },
    close() {
      if (!closed) database?.close();
      closed = true;
    },
  });
}

export function inspectAutonomousResearchSupervisorInstanceStatus({
  runtimeRoot,
  now = new Date(),
  maximumClockSkewMs = 30_000,
} = {}) {
  const observedAt = observedDate(now);
  if (!Number.isSafeInteger(maximumClockSkewMs) || maximumClockSkewMs < 0
    || maximumClockSkewMs > 5 * 60 * 1_000) {
    throw new Error('autonomous_research_supervisor_instance_clock_skew_invalid');
  }
  let repository = null;
  const healthBlockers = [];
  try {
    repository = createAutonomousResearchSupervisorInstanceRepository({
      runtimeRoot,
      create: false,
    });
    const instance = repository.readInstance();
    if (!instance) healthBlockers.push('autonomous_research_supervisor_instance_missing');
    const heartbeatAt = Date.parse(instance?.lastHeartbeatAt || '');
    const expiresAt = Date.parse(instance?.leaseExpiresAt || '');
    const timingValid = persistedInstanceStateValid(instance);
    if (instance && instance.status !== 'running') {
      healthBlockers.push('autonomous_research_supervisor_instance_stopped');
    }
    if (instance && !timingValid) {
      healthBlockers.push('autonomous_research_supervisor_instance_state_invalid');
    }
    if (timingValid && heartbeatAt > observedAt.getTime() + maximumClockSkewMs) {
      healthBlockers.push('autonomous_research_supervisor_instance_heartbeat_from_future');
    }
    if (timingValid && expiresAt <= observedAt.getTime()) {
      healthBlockers.push('autonomous_research_supervisor_instance_heartbeat_expired');
    }
    const healthy = healthBlockers.length === 0;
    const startupReady = healthy
      && Boolean(instance?.startupReconciliationReceiptHash);
    const fullyAutonomousPrerequisitesReady = startupReady
      && (instance?.fullyAutonomousRequired !== true || SHA256.test(String(
        instance?.fullyAutonomousPrerequisiteIdentityHash || '',
      )));
    const machineIntakeReconciliationReady = startupReady
      && Boolean(instance?.machineIntakeReconciliationReceiptHash)
      && Boolean(instance?.machineIntakeConfigurationHash);
    const blockers = [
      ...healthBlockers,
      ...(healthy && !instance?.startupReconciliationReceiptHash
        ? ['autonomous_research_supervisor_startup_reconciliation_incomplete'] : []),
      ...(startupReady && !fullyAutonomousPrerequisitesReady ?
        ['autonomous_research_supervisor_full_prerequisites_required'] : []),
      ...(startupReady && !machineIntakeReconciliationReady
        ? ['autonomous_research_machine_intake_reconciliation_required'] : []),
    ];
    const ready = machineIntakeReconciliationReady && fullyAutonomousPrerequisitesReady
      && blockers.length === 0;
    return Object.freeze({
      version: 1,
      kind: 'AutonomousResearchSupervisorInstanceStatus',
      status: ready
        ? 'autonomous_research_supervisor_instance_ready'
        : healthy
          ? 'autonomous_research_supervisor_instance_healthy_starting'
          : 'autonomous_research_supervisor_instance_unhealthy',
      ready,
      healthy,
      startupReady,
      fullyAutonomousPrerequisitesReady,
      machineIntakeReconciliationReady,
      instance,
      blockers: Object.freeze(blockers),
      healthBlockers: Object.freeze(healthBlockers),
      inspectedAt: observedAt.toISOString(),
      statusReadOnly: true,
    });
  } catch (error) {
    return Object.freeze({
      version: 1,
      kind: 'AutonomousResearchSupervisorInstanceStatus',
      status: 'autonomous_research_supervisor_instance_unhealthy',
      ready: false,
      healthy: false,
      startupReady: false,
      fullyAutonomousPrerequisitesReady: false,
      machineIntakeReconciliationReady: false,
      instance: null,
      blockers: Object.freeze([
        'autonomous_research_supervisor_instance_state_invalid_or_migration_required',
      ]),
      healthBlockers: Object.freeze([
        'autonomous_research_supervisor_instance_state_invalid_or_migration_required',
      ]),
      stateError: String(error?.message || error),
      inspectedAt: observedAt.toISOString(),
      statusReadOnly: true,
    });
  } finally {
    repository?.close();
  }
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  validateExternallyFencedSqliteMutationCoordinatorConfiguration,
} from './externally-fenced-sqlite-mutation-coordinator-configuration.mjs';
import {
  AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_DATABASE_INSTANCE_ID,
  AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_ID,
  createOfflineResidentInstanceMutationCoordinator,
} from './autonomous-research-supervisor-instance-mutation-plan.mjs';
import {
  mapSupervisorInstanceRow as mapRow,
  normalizeSupervisorInstanceTiming as normalizeTiming,
  observedSupervisorInstanceDate as observedDate,
  persistedSupervisorInstanceStateValid as persistedInstanceStateValid,
  supervisorInstanceLeaseIdentity as leaseIdentity,
} from './autonomous-research-supervisor-instance-state.mjs';
export {
  inspectAutonomousResearchStrictMachineIntakeReconciliation,
  publishAutonomousResearchStrictMachineIntakeReconciliation,
} from './autonomous-research-strict-machine-intake-reconciliation-repository.mjs';

const SCOPE_ID = 'resident-autonomous-research-supervisor';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;
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
  offlineProvision = create,
  mutationCoordinator = null,
  databaseInstanceId = AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_DATABASE_INSTANCE_ID,
  schemaContractId = AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_SCHEMA_CONTRACT_ID,
  writerId = AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_ID,
  requireExternallyFencedMutations = false,
} = {}) {
  if (!runtimeRoot) {
    throw new Error('autonomous_research_supervisor_instance_runtime_root_required');
  }
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) {
    throw new Error('autonomous_research_supervisor_instance_busy_timeout_invalid');
  }
  if (typeof create !== 'boolean'
    || typeof offlineProvision !== 'boolean'
    || typeof requireExternallyFencedMutations !== 'boolean'
    || (offlineProvision && !create)
    || !SAFE_ID.test(String(databaseInstanceId || ''))
    || !SAFE_ID.test(String(schemaContractId || ''))
    || !SAFE_ID.test(String(writerId || ''))) {
    throw new Error('autonomous_research_supervisor_instance_repository_configuration_invalid');
  }
  let coordinator = validateExternallyFencedSqliteMutationCoordinatorConfiguration({
    mutationCoordinator,
    requireExternallyFencedMutations,
    offlineProvision,
    databaseRole: 'resident-instance',
    requiredErrorCode:
      'autonomous_research_supervisor_instance_external_mutation_coordinator_required',
  });
  coordinator ||= createOfflineResidentInstanceMutationCoordinator({
    databaseInstanceId,
    schemaContractId,
    writerId,
  });
  const stateRoot = path.join(path.resolve(runtimeRoot), 'autonomous-research', 'supervisor');
  const databasePath = path.join(stateRoot, 'resident-instance.sqlite');
  if (offlineProvision) {
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateRoot, 0o700);
    if (!fs.existsSync(databasePath)) fs.closeSync(fs.openSync(databasePath, 'wx', 0o600));
  }
  if (create && !offlineProvision && !fs.existsSync(databasePath)) {
    throw new Error(
      'autonomous_research_supervisor_instance_offline_provisioning_required',
    );
  }
  if (fs.existsSync(databasePath)) validateDatabaseFile(databasePath);
  const database = fs.existsSync(databasePath)
    ? new DatabaseSync(databasePath, { readOnly: !create }) : null;
  if (database) database.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
  if (database && offlineProvision) {
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

  function mutationValue(receipt) {
    if (!receipt || !Object.prototype.hasOwnProperty.call(receipt, 'value')) {
      throw new Error('autonomous_research_supervisor_instance_mutation_receipt_invalid');
    }
    return receipt.value;
  }

  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorInstanceRepository',
    durable: true,
    compareAndSwap: true,
    systemOwnedRuntimeState: true,
    readOnly: !create,
    offlineProvisioningPerformed: offlineProvision,
    externallyFencedMutations: coordinator.implemented === true,
    externallyFencedMutationsRequired: requireExternallyFencedMutations,
    databaseInstanceId,
    schemaContractId,
    writerId,
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
      return mutationValue(coordinator.executeMutation({
        database: db,
        databaseRole: 'resident-instance',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'resident-instance.supervisor-instance-repository.acquireInstanceLease.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
        const current = mapRow(transaction.get(
          'resident-instance.acquire.current.v1',
          SCOPE_ID,
        ));
        if (current && !persistedInstanceStateValid(current)) {
          throw new Error('autonomous_research_supervisor_instance_state_invalid');
        }
        const currentExpiry = Date.parse(current?.leaseExpiresAt || '');
        if (current?.status === 'running' && Number.isFinite(currentExpiry)
          && currentExpiry > observedAt.getTime()) {
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
        transaction.run(
          'resident-instance.acquire.upsert.v1',
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
        return lease;
        },
      }));
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
      const prerequisiteIdentityHash = fullyAutonomousPrerequisiteReceipt
        ?.autonomousResearchResidentPrerequisiteIdentityHash || null;
      const timing = normalizeTiming({
        leaseMs: lease?.leaseMs,
        heartbeatMs: lease?.heartbeatMs,
      });
      const observedAt = observedDate(now);
      const expiresAt = new Date(observedAt.getTime() + timing.leaseMs).toISOString();
      return mutationValue(coordinator.executeMutation({
        database: db,
        databaseRole: 'resident-instance',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'resident-instance.supervisor-instance-repository.markStartupReconciled.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const current = mapRow(transaction.get(
            'resident-instance.startup.current.v1',
            SCOPE_ID,
          ));
          if ((current?.fullyAutonomousRequired === true
              && (fullyAutonomousPrerequisiteReceipt?.infrastructureReady !== true
                || !SHA256.test(String(prerequisiteIdentityHash || ''))))
            || (current?.fullyAutonomousRequired !== true
              && fullyAutonomousPrerequisiteReceipt !== null)) {
            throw new Error(
              'autonomous_research_supervisor_full_prerequisite_receipt_invalid',
            );
          }
          const result = transaction.run(
            'resident-instance.startup.apply.v1',
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
      }));
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
      return mutationValue(coordinator.executeMutation({
        database: db,
        databaseRole: 'resident-instance',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'resident-instance.supervisor-instance-repository.markMachineIntakeReconciled.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const result = transaction.run(
            'resident-instance.machine-intake-reconciled.apply.v1',
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
      }));
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
      return mutationValue(coordinator.executeMutation({
        database: db,
        databaseRole: 'resident-instance',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'resident-instance.supervisor-instance-repository.markMachineIntakeReconciliationFailed.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const result = transaction.run(
            'resident-instance.machine-intake-failed.apply.v1',
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
      }));
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
      return mutationValue(coordinator.executeMutation({
        database: db,
        databaseRole: 'resident-instance',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'resident-instance.supervisor-instance-repository.heartbeatInstanceLease.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const result = transaction.run(
            'resident-instance.heartbeat.apply.v1',
            observedAt.toISOString(),
            expiresAt,
            cycleHash === null ? null : observedAt.toISOString(),
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
      }));
    },
    releaseInstanceLease({ lease, reason = 'supervisor_process_shutdown', now = new Date() } = {}) {
      const db = requireDatabase({ writable: true });
      const identity = leaseIdentity(lease);
      const observedAt = observedDate(now);
      return mutationValue(coordinator.executeMutation({
        database: db,
        databaseRole: 'resident-instance',
        databaseInstanceId,
        schemaContractId,
        writerId,
        operationId:
          'resident-instance.supervisor-instance-repository.releaseInstanceLease.v1',
        authorizationReceiptHashes: [],
        sideEffectReservationHashes: [],
        mutate(transaction) {
          const result = transaction.run(
            'resident-instance.release.apply.v1',
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
      }));
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

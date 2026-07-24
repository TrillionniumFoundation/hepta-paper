import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  createAutonomousResearchMachineIntakeRepository,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-repository.mjs';
import {
  AUTONOMOUS_RESEARCH_MACHINE_INTAKE_MUTATION_PLANS,
  AUTONOMOUS_RESEARCH_MACHINE_INTAKE_WRITER_PLAN_HASH,
  createOfflineMachineIntakeMutationCoordinator,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-mutation-plan.mjs';
import {
  assertExternallyFencedSqliteMutationDatabaseSurface,
  externallyFencedSqliteWriterPlanHash,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-plan.mjs';
import {
  buildAutonomousResearchMachineIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  composeAutonomousResearchMachineIntakePlane,
} from '../../paper-composition/automation/autonomous-research-machine-intake-composition.mjs';

const H = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

function intake(label) {
  const paperId = `paper:${label}`;
  return buildAutonomousResearchMachineIntake({
    intakeId: `intake:${label}`,
    paperId,
    campaignId: `autonomous-research:${paperId}`,
    launchMode: 'production-run',
    objective: `Evaluate the bounded ${label} objective.`,
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: [{
      name: `benchmark-${label}`,
      source: `/datasets/benchmark-${label}`,
      readOnly: true,
      manifestHash: H(`dataset-${label}`),
      licenseId: 'CC0-1.0',
      benchmarkFamily: 'ml_algorithm_benchmark',
    }],
    budgets: {
      maxWallTimeMs: 60 * 60 * 1000,
      maxAgentCalls: 24,
      maxCpuJobs: 32,
      maxGpuJobs: 0,
      maxTokenCount: 100_000,
      maxCostUsd: 25,
      maxMemoryMiB: 4096,
    },
    providerConfigurationHash: H('provider'),
    revisionRounds: 2,
    refereeCount: 3,
    admissionCreatedAt: '2026-07-18T08:00:00.000Z',
    recurringGoldenProvenance: null,
  });
}

function coordinator({ calls = [], ready = true } = {}) {
  const local = createOfflineMachineIntakeMutationCoordinator();
  const coveredDatabaseRoles = Object.freeze(['machine-intake']);
  return Object.freeze({
    implemented: true,
    coveredDatabaseRoles,
    executeMutation(input) {
      calls.push(Object.freeze({
        operationId: input.operationId,
        databaseRole: input.databaseRole,
        writerId: input.writerId,
        authorizationReceiptHashes: Object.freeze([...input.authorizationReceiptHashes]),
      }));
      return local.executeMutation(input);
    },
    recoverPendingMutations() { return Object.freeze({ recovered: 0 }); },
    inspectStatus() {
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationCoordinatorStatus',
        status: ready
          ? 'externally_fenced_sqlite_mutation_coordinator_ready'
          : 'externally_fenced_sqlite_mutation_coordinator_configured',
        implemented: true,
        coveredDatabaseRoles,
        blockers: Object.freeze(ready ? [] : [
          'autonomous_research_online_mutation_runtime_activation_required',
        ]),
      });
    },
  });
}

test('machine intake strict mode rejects unactivated fencing before filesystem I/O', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-machine-strict-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  assert.throws(() => createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    create: true,
    offlineProvision: false,
    authorizedSourceAuthorityHash: H('authority'),
    mutationCoordinator: coordinator({ ready: false }),
    requireExternallyFencedMutations: true,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => composeAutonomousResearchMachineIntakePlane({
    runtimeRoot,
    producerInspection: Object.freeze({ ready: true }),
    machineIntakeMutationCoordinator: coordinator({ ready: false }),
    requireExternallyFencedMachineIntake: true,
  }), /external_mutation_coordinator_required/);
  assert.deepEqual(fs.readdirSync(runtimeRoot), []);
});

test('machine intake eight-operation writer preserves append, lease, and transition semantics', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-machine-online-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const authority = H('machine-online-authority');
  const provisioner = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: authority,
  });
  const databasePath = provisioner.databasePath;
  provisioner.close();
  const surfaceDatabase = new DatabaseSync(databasePath);
  for (const plan of Object.values(AUTONOMOUS_RESEARCH_MACHINE_INTAKE_MUTATION_PLANS)) {
    assertExternallyFencedSqliteMutationDatabaseSurface(surfaceDatabase, plan);
  }
  surfaceDatabase.close();
  const calls = [];
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    create: true,
    offlineProvision: false,
    authorizedSourceAuthorityHash: authority,
    mutationCoordinator: coordinator({ calls }),
    requireExternallyFencedMutations: true,
  });
  t.after(() => repository.close());
  assert.equal(repository.offlineProvisioningPerformed, false);
  assert.equal(repository.externallyFencedMutations, true);
  assert.equal(Object.keys(AUTONOMOUS_RESEARCH_MACHINE_INTAKE_MUTATION_PLANS).length, 8);
  assert.match(AUTONOMOUS_RESEARCH_MACHINE_INTAKE_WRITER_PLAN_HASH, /^sha256:[0-9a-f]{64}$/);

  const value = intake('online');
  const appended = repository.appendIntake({
    intake: value,
    sourceKind: 'static-file',
    sourceRef: '/intake/online.json',
    sourceAuthorityHash: authority,
    now: new Date('2026-07-18T08:00:00.000Z'),
  });
  assert.equal(appended.inserted, true);
  let lease = repository.tryAcquireIntakeLease({
    intakeId: value.intakeId,
    ownerId: 'supervisor:first',
    leaseMs: 60_000,
    now: new Date('2026-07-18T08:00:01.000Z'),
  });
  lease = repository.renewIntakeLease({
    intakeId: value.intakeId,
    ...lease,
    leaseMs: 60_000,
    now: new Date('2026-07-18T08:00:02.000Z'),
  });
  const deferred = repository.deferIntake({
    intakeId: value.intakeId,
    ...lease,
    error: 'retry',
    retryAfterMs: 1000,
    now: new Date('2026-07-18T08:00:03.000Z'),
  });
  assert.equal(deferred.failureCount, 1);
  lease = repository.tryAcquireIntakeLease({
    intakeId: value.intakeId,
    ownerId: 'supervisor:second',
    leaseMs: 60_000,
    now: new Date('2026-07-18T08:00:05.000Z'),
  });
  const enqueued = repository.markIntakeEnqueued({
    intakeId: value.intakeId,
    ...lease,
    autonomousResearchMachineIntakeAdmissionHash: appended.record.admissionHash,
    campaignPlanHash: H('campaign-plan'),
    autonomousResearchLoopPreparationReportHash: H('preparation'),
    now: new Date('2026-07-18T08:00:06.000Z'),
  });
  assert.equal(enqueued.disposition, 'enqueued');
  assert.equal(repository.markEnqueuedIntakeInvalid({
    intakeId: value.intakeId,
    autonomousResearchMachineIntakeAdmissionHash: appended.record.admissionHash,
    reason: 'qualification_invalid',
    now: new Date('2026-07-18T08:00:07.000Z'),
  }).disposition, 'invalid');
  assert.deepEqual(repository.reconcileExpiredIntakeLeases({
    now: new Date('2026-07-18T08:00:08.000Z'),
  }), {
    recoveredLeaseCount: 0,
    reconciledAt: '2026-07-18T08:00:08.000Z',
  });

  const second = intake('release');
  repository.appendIntake({
    intake: second,
    sourceKind: 'static-file',
    sourceRef: '/intake/release.json',
    sourceAuthorityHash: authority,
    now: new Date('2026-07-18T08:01:00.000Z'),
  });
  const releasable = repository.tryAcquireIntakeLease({
    intakeId: second.intakeId,
    ownerId: 'supervisor:release',
    leaseMs: 60_000,
    now: new Date('2026-07-18T08:01:01.000Z'),
  });
  assert.equal(repository.releaseIntakeLease({ intakeId: second.intakeId, ...releasable }), true);
  assert.deepEqual(new Set(calls.map((call) => call.operationId)), new Set(
    Object.keys(AUTONOMOUS_RESEARCH_MACHINE_INTAKE_MUTATION_PLANS),
  ));
});

function databaseSurface({ foreignKey = 'NO ACTION', noPrimaryKey = false, trigger = false }) {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE parent(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE child(
      id TEXT ${noPrimaryKey ? '' : 'PRIMARY KEY'},
      parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE ${foreignKey}
    ) STRICT;`);
  if (trigger) {
    database.exec(`CREATE TRIGGER child_side_write AFTER UPDATE ON child
      BEGIN UPDATE parent SET id=id WHERE id=NEW.parent_id; END;`);
  }
  return database;
}

test('mutation surface requires explicit-PK foreign keys and rejects target write triggers', (t) => {
  const plan = Object.freeze({
    statements: Object.freeze([{ writeTable: 'child' }]),
  });
  const safe = databaseSurface({});
  t.after(() => safe.close());
  assert.doesNotThrow(() => assertExternallyFencedSqliteMutationDatabaseSurface(safe, plan));

  const cascading = databaseSurface({ foreignKey: 'CASCADE' });
  t.after(() => cascading.close());
  assert.doesNotThrow(
    () => assertExternallyFencedSqliteMutationDatabaseSurface(cascading, plan),
  );
  const withoutPrimaryKey = databaseSurface({ noPrimaryKey: true });
  t.after(() => withoutPrimaryKey.close());
  assert.throws(
    () => assertExternallyFencedSqliteMutationDatabaseSurface(withoutPrimaryKey, plan),
    /explicit_primary_key_required/,
  );
  const withTrigger = databaseSurface({ trigger: true });
  t.after(() => withTrigger.close());
  assert.throws(
    () => assertExternallyFencedSqliteMutationDatabaseSurface(withTrigger, plan),
    /business_trigger_forbidden/,
  );
});

test('mutation surface scopes unrelated hazards but rejects a target cascade closure', (t) => {
  const scoped = new DatabaseSync(':memory:');
  t.after(() => scoped.close());
  scoped.exec(`CREATE TABLE planned(id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE unrelated_parent(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE unrelated_child(
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES unrelated_parent(id) ON DELETE CASCADE
    ) STRICT;
    CREATE TRIGGER unrelated_write AFTER UPDATE ON unrelated_child
      BEGIN UPDATE unrelated_parent SET id=id WHERE id=NEW.parent_id; END;
    CREATE TRIGGER planned_validation BEFORE UPDATE ON planned
      BEGIN SELECT CASE WHEN NEW.value='' THEN RAISE(ABORT, 'value_required') END; END;`);
  assert.doesNotThrow(() => assertExternallyFencedSqliteMutationDatabaseSurface(
    scoped,
    { statements: [{ writeTable: 'planned', sql: 'UPDATE planned SET value=? WHERE id=?' }] },
  ));

  const cascading = new DatabaseSync(':memory:');
  t.after(() => cascading.close());
  cascading.exec(`CREATE TABLE parent(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE child(
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES parent(id) ON UPDATE CASCADE
    ) STRICT;`);
  assert.throws(
    () => assertExternallyFencedSqliteMutationDatabaseSurface(
      cascading,
      { statements: [{ writeTable: 'parent', sql: 'UPDATE parent SET id=? WHERE id=?' }] },
    ),
    /foreign_key_forbidden:child/,
  );
});

test('authority rotation remains a quiesced scope transition, never an online Session plan', () => {
  assert.equal(
    Object.keys(AUTONOMOUS_RESEARCH_MACHINE_INTAKE_MUTATION_PLANS)
      .some((operationId) => /authorityRotation|rotation/i.test(operationId)),
    false,
  );
  assert.throws(() => externallyFencedSqliteWriterPlanHash({
    writerId: 'writer:machine-intake:unsafe-rotation:v1',
    operationPlans: [{
      version: 1,
      operationId: 'machine-intake.unsafe-authority-rotation.v1',
      statements: [{
        statementId: 'rotation.attach-supervisor.apply.v1',
        mode: 'run',
        sql: "ATTACH DATABASE '/runtime/supervisor.sqlite' AS supervisor",
      }],
    }],
  }), /statement_plan_invalid/);
});

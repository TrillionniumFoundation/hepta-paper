import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createAutonomousResearchMachineIntakeRepository,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-repository.mjs';
import {
  migrateLegacyMachineIntakeSchema,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-repository-support.mjs';
import {
  buildAutonomousResearchMachineIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('MachineIntakeMigrationTestHash', { label });

function intake(label, admissionCreatedAt) {
  return buildAutonomousResearchMachineIntake({
    intakeId: `intake:${label}`,
    paperId: `paper:${label}`,
    campaignId: `autonomous-research:paper:${label}`,
    launchMode: 'production-run',
    admissionCreatedAt,
    objective: `Evaluate the bounded ${label} migration objective.`,
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: [{
      name: `dataset-${label}`,
      source: `/datasets/${label}`,
      readOnly: true,
      manifestHash: H(`dataset:${label}`),
      licenseId: 'CC0-1.0',
      benchmarkFamily: 'ml_algorithm_benchmark',
    }],
    budgets: {
      maxWallTimeMs: 60 * 60 * 1000,
      maxAgentCalls: 10,
      maxCpuJobs: 10,
      maxGpuJobs: 0,
      maxTokenCount: 10_000,
      maxCostUsd: 10,
      maxMemoryMiB: 2048,
    },
    providerConfigurationHash: H('provider'),
    recurringGoldenProvenance: null,
    revisionRounds: 1,
    refereeCount: 2,
  });
}

function createLegacyDatabase({ runtimeRoot, rows, lease = null }) {
  const stateRoot = path.join(runtimeRoot, 'autonomous-research', 'machine-intake');
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const databasePath = path.join(stateRoot, 'machine-intake.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE autonomous_research_machine_intake (
    intake_id TEXT PRIMARY KEY,
    intake_hash TEXT NOT NULL UNIQUE,
    paper_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL UNIQUE,
    intake_json TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('machine','recurring-golden','static-file')),
    source_ref TEXT NOT NULL,
    source_authority_hash TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK(disposition IN ('pending','enqueued')),
    lease_generation INTEGER NOT NULL DEFAULT 0,
    campaign_plan_hash TEXT,
    preparation_hash TEXT,
    enqueued_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE autonomous_research_machine_intake_lease (
    intake_id TEXT PRIMARY KEY REFERENCES autonomous_research_machine_intake(intake_id),
    owner_id TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    lease_generation INTEGER NOT NULL,
    acquired_at TEXT NOT NULL,
    renewed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE autonomous_research_machine_intake_daily_admission (
    epoch_start TEXT PRIMARY KEY,
    machine_append_count INTEGER NOT NULL,
    reserved_cost_usd REAL NOT NULL,
    reserved_agent_calls INTEGER NOT NULL,
    reserved_gpu_jobs INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;`);
  const insert = database.prepare(`INSERT INTO autonomous_research_machine_intake(
    intake_id,intake_hash,paper_id,campaign_id,intake_json,source_kind,source_ref,
    source_authority_hash,disposition,lease_generation,campaign_plan_hash,preparation_hash,
    enqueued_at,failure_count,next_attempt_at,last_error,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  rows.forEach((row) => insert.run(
    row.intake.intakeId, row.intake.intakeHash, row.intake.paperId, row.intake.campaignId,
    JSON.stringify(row.serializedIntake || row.intake), 'machine', 'machine-api',
    row.sourceAuthorityHash, row.disposition || 'pending', row.leaseGeneration || 0,
    row.campaignPlanHash || null, row.preparationHash || null, row.enqueuedAt || null,
    0, row.now, null, row.now, row.now,
  ));
  if (lease) database.prepare(`INSERT INTO autonomous_research_machine_intake_lease(
    intake_id,owner_id,lease_token,lease_generation,acquired_at,renewed_at,expires_at
  ) VALUES(?,?,?,?,?,?,?)`).run(
    lease.intakeId, lease.ownerId, lease.leaseToken, lease.leaseGeneration,
    lease.acquiredAt, lease.renewedAt, lease.expiresAt,
  );
  database.close();
  fs.chmodSync(databasePath, 0o600);
  return databasePath;
}

test('legacy intake schema migrates trusted rows and quarantines unprovable rows idempotently', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-intake-migration-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const now = new Date();
  const nowIso = now.toISOString();
  const authorityHash = H('current-source-authority');
  const valid = intake('valid-v2', nowIso);
  const unprovable = intake('legacy-v1', nowIso);
  const legacyDocument = { ...unprovable, version: 1 };
  delete legacyDocument.admissionCreatedAt;
  const lease = {
    intakeId: valid.intakeId,
    ownerId: 'owner:migration',
    leaseToken: 'lease:migration',
    leaseGeneration: 1,
    acquiredAt: nowIso,
    renewedAt: nowIso,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  };
  const databasePath = createLegacyDatabase({
    runtimeRoot,
    rows: [
      {
        intake: valid,
        sourceAuthorityHash: authorityHash,
        disposition: 'pending',
        leaseGeneration: 1,
        now: nowIso,
      },
      {
        intake: unprovable,
        serializedIntake: legacyDocument,
        sourceAuthorityHash: authorityHash,
        disposition: 'pending',
        now: nowIso,
      },
    ],
    lease,
  });
  const legacyBefore = fs.statSync(databasePath);
  const legacyEntries = fs.readdirSync(path.dirname(databasePath)).sort();
  assert.throws(() => createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    create: false,
  }), /schema_migration_required/);
  assert.deepEqual(fs.readdirSync(path.dirname(databasePath)).sort(), legacyEntries);
  const legacyAfter = fs.statSync(databasePath);
  assert.deepEqual(
    [legacyAfter.size, legacyAfter.mtimeMs],
    [legacyBefore.size, legacyBefore.mtimeMs],
  );
  let repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: authorityHash,
  });
  assert.deepEqual(repository.schemaMigration, { migratedCount: 1, quarantinedCount: 1 });
  const migrated = repository.readIntake(valid.intakeId);
  assert.equal(migrated.admission.intakeHash, valid.intakeHash);
  assert.equal(migrated.admission.sourceAuthorityHash, authorityHash);
  assert.equal(migrated.lease.leaseToken, lease.leaseToken);
  assert.equal(repository.readIntake(unprovable.intakeId), null);
  repository.close();

  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(Number(inspection.prepare(`SELECT COUNT(*) AS count FROM
    autonomous_research_machine_intake_migration_quarantine`).get().count), 1);
  inspection.close();
  repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: authorityHash,
  });
  assert.equal(repository.schemaMigration, null);
  assert.equal(repository.readStatus().pendingCount, 1);
  repository.close();
});

test('legacy schema migration rolls back DDL and rows after an injected crash', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-intake-migration-crash-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const authorityHash = H('crash-source-authority');
  const value = intake('crash-v2', now);
  const databasePath = createLegacyDatabase({
    runtimeRoot,
    rows: [{ intake: value, sourceAuthorityHash: authorityHash, now }],
  });
  assert.throws(() => createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: authorityHash,
    migrationHooks: {
      afterLegacyTablesRenamed() { throw new Error('injected_migration_crash'); },
    },
  }), /schema_migration_failed:injected_migration_crash/);
  const afterCrash = new DatabaseSync(databasePath, { readOnly: true });
  const columns = afterCrash.prepare(
    'PRAGMA table_info(autonomous_research_machine_intake)',
  ).all().map((column) => column.name);
  assert.equal(columns.includes('admission_hash'), false);
  assert.equal(Number(afterCrash.prepare(`SELECT COUNT(*) AS count FROM
    autonomous_research_machine_intake`).get().count), 1);
  assert.ok(afterCrash.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name='autonomous_research_machine_intake_lease'`).get());
  afterCrash.close();
  const recovered = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: authorityHash,
  });
  assert.deepEqual(recovered.schemaMigration, { migratedCount: 1, quarantinedCount: 0 });
  assert.equal(recovered.readIntake(value.intakeId).intakeHash, value.intakeHash);
  recovered.close();
});

test('a committed legacy migration reopens after the migrating process exits', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-intake-migration-commit-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const authorityHash = H('committed-source-authority');
  const value = intake('committed-v2', now);
  const databasePath = createLegacyDatabase({
    runtimeRoot,
    rows: [{ intake: value, sourceAuthorityHash: authorityHash, now }],
  });

  const migratingProcess = new DatabaseSync(databasePath);
  migratingProcess.exec('BEGIN IMMEDIATE;');
  const result = migrateLegacyMachineIntakeSchema(migratingProcess, {
    authorizedSourceAuthorityHash: authorityHash,
  });
  migratingProcess.exec('COMMIT;');
  assert.deepEqual(result, { migratedCount: 1, quarantinedCount: 0 });
  migratingProcess.close();

  const recovered = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: authorityHash,
  });
  assert.equal(recovered.schemaMigration, null);
  assert.equal(recovered.readIntake(value.intakeId).intakeHash, value.intakeHash);
  recovered.close();
});

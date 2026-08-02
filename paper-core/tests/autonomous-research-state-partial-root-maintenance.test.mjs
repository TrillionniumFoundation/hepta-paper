import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  composeAutonomousResearchStatePartialRootMaintenanceService,
} from '../../paper-composition/bootstrap/autonomous-research-state-partial-root-maintenance-composition.mjs';
import {
  buildAutonomousResearchStatePartialRootWriterQuiescenceReceipt,
  PARTIAL_ROOT_EXISTING_ROLES,
  PARTIAL_ROOT_MISSING_ROLES,
  PARTIAL_ROOT_REQUIRED_QUIESCED_SERVICES,
  SUPERVISOR_BUSINESS_REPAIR_OBJECTS,
} from '../../paper-adapters/automation/autonomous-research-state-partial-root-maintenance-inspection.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {
  schemaTransitionTargetSchema,
  validateAutonomousResearchOnlineSchemaTransitionInventory,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  buildAutonomousResearchMachineIntakeConfiguration,
  producerProfile,
} from './support/autonomous-research-topic-producer-fixture.mjs';
import {
  parseAutonomousResearchStatePartialRootMaintenanceArguments,
} from '../bin/autonomous-research-state-partial-root-maintenance.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const stateDatabaseManifest = JSON.parse(fs.readFileSync(path.join(
  repositoryRoot, 'paper-core/config/autonomous-research-state-databases.v1.json',
), 'utf8'));
const fixedNow = new Date('2026-08-01T05:00:00.000Z');
const clock = Object.freeze({ now: () => new Date(fixedNow) });

function sqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function createSchemaObject(database, schemaObject) {
  const [type, name] = schemaObject.split(':');
  const identifier = sqlIdentifier(name);
  if (type === 'table') {
    database.exec(`CREATE TABLE ${identifier}(id TEXT PRIMARY KEY) STRICT;`);
  } else if (type === 'index') {
    database.exec(`CREATE INDEX ${identifier} ON fixture_anchor(value);`);
  } else if (type === 'trigger') {
    database.exec(`CREATE TRIGGER ${identifier} BEFORE UPDATE ON fixture_anchor
      BEGIN SELECT 1; END;`);
  } else if (type === 'view') {
    database.exec(`CREATE VIEW ${identifier} AS SELECT id,value FROM fixture_anchor;`);
  } else {
    throw new Error(`unsupported_partial_root_fixture_object:${schemaObject}`);
  }
}

function createHistoricalPartialDatabase(runtimeRoot, definition) {
  const candidate = path.join(runtimeRoot, definition.relativePath);
  fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
  const targetNames = new Set(schemaTransitionTargetSchema({ role: definition.role }).objects.keys());
  const database = new DatabaseSync(candidate);
  try {
    database.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE fixture_anchor(id TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
      INSERT INTO fixture_anchor(id,value) VALUES('preserved','business-state');`);
    for (const schemaObject of definition.requiredSchemaObjects) {
      const name = schemaObject.slice(schemaObject.indexOf(':') + 1);
      if (targetNames.has(name) || (definition.role === 'supervisor-state'
        && SUPERVISOR_BUSINESS_REPAIR_OBJECTS.includes(schemaObject))) continue;
      createSchemaObject(database, schemaObject);
    }
  } finally { database.close(); }
  fs.chmodSync(candidate, 0o600);
}

function setup(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-partial-root-maintenance-'));
  fs.chmodSync(root, 0o700);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const rescueRoot = path.join(root, 'rescue');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  fs.mkdirSync(rescueRoot, { mode: 0o700 });
  for (const definition of stateDatabaseManifest.databases.filter((entry) => (
    PARTIAL_ROOT_EXISTING_ROLES.includes(entry.role)
  ))) createHistoricalPartialDatabase(runtimeRoot, definition);
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot, manifest: stateDatabaseManifest,
  });
  const profile = producerProfile();
  const machineIntakeConfiguration = buildAutonomousResearchMachineIntakeConfiguration({
    recurringGoldenTemplates: [],
    machineAppendEnabled: true,
    machineProducerProfileHash: profile.producerProfileHash,
  });
  const writerManifestHash = autonomousResearchOnlineWriterOperationManifestHash(
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  );
  const writerQuiescenceReceipt =
    buildAutonomousResearchStatePartialRootWriterQuiescenceReceipt({
      runtimeRoot,
      databaseScopeHash: inventory.databaseScopeHash,
      writerManifestHash,
      quiescedWriterServices: PARTIAL_ROOT_REQUIRED_QUIESCED_SERVICES,
      activeWriterProcessIds: [],
      serviceInspectionComplete: true,
      processInspectionComplete: true,
      observedAt: new Date(fixedNow.getTime() - 60_000),
      expiresAt: new Date(fixedNow.getTime() + 10 * 60_000),
    });
  const service = composeAutonomousResearchStatePartialRootMaintenanceService({
    workspaceRoot: repositoryRoot,
    runtimeRoot,
    rescueRoot,
    writerQuiescenceReceipt,
    machineIntakeConfiguration,
    machineIntakeGenesisAuthorityMode: 'root-owned-configuration',
    topicProducerProfile: profile,
    runtimeReproducibilityPolicy: {
      maximumAttemptsPerEpoch: 2,
      maximumCostUsdPerEpoch: 1,
    },
    clock,
  });
  return Object.freeze({
    root, runtimeRoot, rescueRoot, service, inventory, writerQuiescenceReceipt,
  });
}

test('partial-root maintenance repairs only the historical 5+5 business closure', (context) => {
  const fixture = setup(context);
  const plan = fixture.service.plan();
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.existingRoles, PARTIAL_ROOT_EXISTING_ROLES);
  assert.deepEqual(plan.missingRoles, PARTIAL_ROOT_MISSING_ROLES);
  assert.equal(plan.externalAuthorityInvocationAllowed, false);
  const beforeSupervisor = new DatabaseSync(path.join(
    fixture.runtimeRoot, 'autonomous-research/supervisor/supervisor-state.sqlite',
  ), { readOnly: true });
  const preservedBefore = beforeSupervisor.prepare(
    'SELECT * FROM fixture_anchor ORDER BY id',
  ).all();
  beforeSupervisor.close();
  const receipt = fixture.service.execute({
    expectedMaintenancePlanId: plan.maintenancePlanId,
  });
  assert.equal(receipt.ready, true);
  assert.equal(receipt.externalAuthorityInvoked, false);
  assert.equal(receipt.rescueCopyRestoreVerified, true);
  assert.equal(receipt.businessStateAndRowsPreserved, true);
  assert.equal(receipt.unscopedExistingDatabaseBytesPreserved, true);
  assert.deepEqual(receipt.installedRoles, PARTIAL_ROOT_MISSING_ROLES);
  assert.equal(fs.existsSync(receipt.rescueBundlePath), true);
  const afterSupervisor = new DatabaseSync(path.join(
    fixture.runtimeRoot, 'autonomous-research/supervisor/supervisor-state.sqlite',
  ), { readOnly: true });
  assert.deepEqual(afterSupervisor.prepare(
    'SELECT * FROM fixture_anchor ORDER BY id',
  ).all(), preservedBefore);
  const repairedObjects = new Set(afterSupervisor.prepare(
    "SELECT type||':'||name AS object FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
  ).all().map((row) => row.object));
  afterSupervisor.close();
  assert.equal(SUPERVISOR_BUSINESS_REPAIR_OBJECTS.every(
    (object) => repairedObjects.has(object),
  ), true);
  assert.equal(repairedObjects.has(
    'index:idx_autonomous_research_supervisor_external_action_idempotency',
  ), false);
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: fixture.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  assert.equal(inventory.instances.length, 10);
  assert.doesNotThrow(() => validateAutonomousResearchOnlineSchemaTransitionInventory({
    runtimeRoot: fixture.runtimeRoot,
    inventory,
    stateDatabaseManifest,
  }));
  assert.throws(() => fixture.service.plan(), /role_closure_invalid/);
});

test('partial-root maintenance fails closed before mutation on plan or receipt drift', (context) => {
  const fixture = setup(context);
  const plan = fixture.service.plan();
  assert.throws(() => fixture.service.execute({
    expectedMaintenancePlanId: `sha256:${'0'.repeat(64)}`,
  }), /plan_mismatch/);
  assert.deepEqual(fs.readdirSync(fixture.rescueRoot), []);
  const unexpected = stateDatabaseManifest.databases.find(
    (entry) => entry.role === PARTIAL_ROOT_MISSING_ROLES[0],
  );
  createHistoricalPartialDatabase(fixture.runtimeRoot, unexpected);
  assert.throws(() => fixture.service.plan(), /role_closure_invalid|schema_gap_invalid/);
  assert.equal(fs.existsSync(path.join(
    fixture.runtimeRoot, 'autonomous-research/supervisor/runtime-reproducibility-refresh.sqlite',
  )), false);
  assert.equal(plan.externalAuthorityInvocationAllowed, false);
});

test('partial-root maintenance CLI is plan-default and double-gates execute', () => {
  const common = [
    '--runtime-root', '/var/lib/hepta-paper/runtime',
    '--rescue-root', '/var/lib/hepta-paper-rescue',
    '--writer-quiescence-receipt', '/run/hepta-paper/quiescence.json',
    '--machine-intake-config', '/etc/hepta-paper/intake/config.json',
    '--topic-producer-profile', '/etc/hepta-paper/intake/topic-producer-profile.json',
    '--dataset-root', '/srv/hepta-paper/datasets',
    '--runtime-reproducibility-maximum-attempts-per-epoch', '2',
    '--runtime-reproducibility-maximum-cost-usd-per-epoch', '1',
  ];
  assert.equal(
    parseAutonomousResearchStatePartialRootMaintenanceArguments(common).action,
    'plan',
  );
  assert.throws(() => parseAutonomousResearchStatePartialRootMaintenanceArguments([
    ...common, '--action', 'execute', '--maintenance-plan-id', `sha256:${'1'.repeat(64)}`,
  ]), /execute_confirmation_required/);
  const execute = parseAutonomousResearchStatePartialRootMaintenanceArguments([
    ...common, '--action', 'execute', '--execute',
    '--maintenance-plan-id', `sha256:${'1'.repeat(64)}`,
  ]);
  assert.equal(execute.action, 'execute');
  assert.equal(execute.expectedMaintenancePlanId, `sha256:${'1'.repeat(64)}`);
  assert.throws(() => parseAutonomousResearchStatePartialRootMaintenanceArguments([
    ...common, '--execute',
  ]), /execute_options_forbidden/);
});

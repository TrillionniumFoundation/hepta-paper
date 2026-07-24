import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  buildAutonomousResearchStateBusinessSchemaProvisioningPlan,
  provisionAutonomousResearchStateBusinessSchemas,
} from '../../paper-adapters/automation/autonomous-research-state-business-schema-provisioning-repository.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {
  validateAutonomousResearchOnlineSchemaTransitionInventory,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs';
import {
  parseAutonomousResearchStateProvisioningArguments,
} from '../bin/autonomous-research-state-provision.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const stateDatabaseManifest = JSON.parse(fs.readFileSync(path.join(
  repositoryRoot,
  'paper-core',
  'config',
  'autonomous-research-state-databases.v1.json',
), 'utf8'));
const H = (label) => hashRecord('AutonomousResearchStateProvisioningTest', { label });

const provisioningIdentity = Object.freeze({
  machineIntakeConfigurationHash: H('machine-intake-configuration'),
  providerCanaryPairMaximumCostUsd: 1,
  providerConfigurationHash: H('provider-configuration'),
  runtimeReproducibilityRefreshPolicyHash: H('runtime-refresh-policy'),
  topicProducerProfileHash: H('topic-producer-profile'),
  writerManifestHash: H('writer-manifest'),
});

function sqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function transitionSchemaObject(name) {
  return name.includes('autonomous_research_online_')
    || name === 'idx_autonomous_research_online_mutation_marker_head';
}

function createBusinessDatabase(candidate, definition) {
  fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(candidate);
  try {
    database.exec(`PRAGMA journal_mode=DELETE;
      CREATE TABLE fixture_anchor(id TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    for (const schemaObject of definition.requiredSchemaObjects) {
      const [type, name] = schemaObject.split(':');
      if (transitionSchemaObject(name)) continue;
      const identifier = sqlIdentifier(name);
      if (type === 'table') {
        database.exec(`CREATE TABLE ${identifier}(id TEXT PRIMARY KEY);`);
      } else if (type === 'index') {
        database.exec(`CREATE INDEX ${identifier} ON fixture_anchor(value);`);
      } else if (type === 'trigger') {
        database.exec(`CREATE TRIGGER ${identifier} BEFORE UPDATE ON fixture_anchor
          BEGIN SELECT 1; END;`);
      } else if (type === 'view') {
        database.exec(`CREATE VIEW ${identifier} AS SELECT id,value FROM fixture_anchor;`);
      } else {
        throw new Error(`unsupported_provisioning_test_schema_object:${schemaObject}`);
      }
    }
  } finally {
    database.close();
  }
  fs.chmodSync(candidate, 0o600);
}

function provisionFixtureBusinessSchemas({ runtimeRoot }) {
  for (const definition of stateDatabaseManifest.databases) {
    const relativePath = definition.cardinality === 'singleton'
      ? definition.relativePath
      : definition.relativePathPattern.replace('{paperId}', 'paper-alpha');
    createBusinessDatabase(path.join(runtimeRoot, relativePath), definition);
  }
}

function setup(context, label) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-${label}-`));
  fs.chmodSync(parent, 0o700);
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return Object.freeze({ parent, runtimeRoot: path.join(parent, 'runtime') });
}

test('fresh provisioning stages and atomically installs all ten business schemas', (context) => {
  const fixture = setup(context, 'state-provisioning');
  const plan = buildAutonomousResearchStateBusinessSchemaProvisioningPlan({
    runtimeRoot: fixture.runtimeRoot,
    stateDatabaseManifest,
    provisioningIdentity,
  });
  const repeatedPlan = buildAutonomousResearchStateBusinessSchemaProvisioningPlan({
    runtimeRoot: fixture.runtimeRoot,
    stateDatabaseManifest,
    provisioningIdentity,
  });
  assert.equal(repeatedPlan.provisioningPlanId, plan.provisioningPlanId);
  assert.equal(plan.databaseRoles.length, 10);
  const receipt = provisionAutonomousResearchStateBusinessSchemas({
    runtimeRoot: fixture.runtimeRoot,
    stateDatabaseManifest,
    provisioningIdentity,
    expectedProvisioningPlanId: plan.provisioningPlanId,
    provisionBusinessSchemas: provisionFixtureBusinessSchemas,
  });
  assert.equal(receipt.status, 'autonomous_research_state_business_schemas_provisioned');
  assert.equal(receipt.ready, true);
  assert.equal(receipt.databaseInstances.length, 10);
  assert.equal(receipt.externalAuthoritySelfSigned, false);
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
  assert.throws(() => buildAutonomousResearchStateBusinessSchemaProvisioningPlan({
    runtimeRoot: fixture.runtimeRoot,
    stateDatabaseManifest,
    provisioningIdentity,
  }), /fresh_runtime_required/);
});

test('failed or mismatched provisioning leaves no target or staging residue', (context) => {
  const fixture = setup(context, 'state-provisioning-failure');
  const plan = buildAutonomousResearchStateBusinessSchemaProvisioningPlan({
    runtimeRoot: fixture.runtimeRoot,
    stateDatabaseManifest,
    provisioningIdentity,
  });
  assert.throws(() => provisionAutonomousResearchStateBusinessSchemas({
    runtimeRoot: fixture.runtimeRoot,
    stateDatabaseManifest,
    provisioningIdentity,
    expectedProvisioningPlanId: H('wrong-plan'),
    provisionBusinessSchemas: provisionFixtureBusinessSchemas,
  }), /plan_mismatch/);
  assert.throws(() => provisionAutonomousResearchStateBusinessSchemas({
    runtimeRoot: fixture.runtimeRoot,
    stateDatabaseManifest,
    provisioningIdentity,
    expectedProvisioningPlanId: plan.provisioningPlanId,
    provisionBusinessSchemas({ runtimeRoot }) {
      createBusinessDatabase(
        path.join(runtimeRoot, stateDatabaseManifest.databases[0].relativePath),
        stateDatabaseManifest.databases[0],
      );
      throw new Error('injected_provisioning_failure');
    },
  }), /injected_provisioning_failure/);
  assert.equal(fs.existsSync(fixture.runtimeRoot), false);
  assert.deepEqual(fs.readdirSync(fixture.parent), []);
});

test('state provisioning CLI requires immutable inputs and double-gates execute', () => {
  const common = [
    '--runtime-root', '/var/lib/hepta-paper/runtime-next',
    '--machine-intake-config', '/etc/hepta-paper/intake/config.json',
    '--topic-producer-profile', '/etc/hepta-paper/intake/topic-profile.json',
    '--dataset-root', '/srv/hepta-paper/datasets',
    '--provider-canary-pair-maximum-cost-usd', '1',
    '--runtime-reproducibility-maximum-attempts-per-epoch', '4',
    '--runtime-reproducibility-maximum-cost-usd-per-epoch', '10',
  ];
  const plan = parseAutonomousResearchStateProvisioningArguments(common);
  assert.equal(plan.action, 'plan');
  assert.equal(plan.execute, false);
  assert.throws(() => parseAutonomousResearchStateProvisioningArguments([
    ...common, '--action', 'execute', '--plan-id', H('plan'),
  ]), /execute_confirmation_required/);
  const execute = parseAutonomousResearchStateProvisioningArguments([
    ...common, '--action', 'execute', '--execute', '--plan-id', H('plan'),
  ]);
  assert.equal(execute.action, 'execute');
  assert.equal(execute.expectedProvisioningPlanId, H('plan'));
  assert.throws(() => parseAutonomousResearchStateProvisioningArguments([
    ...common, '--execute',
  ]), /execute_options_forbidden/);
});

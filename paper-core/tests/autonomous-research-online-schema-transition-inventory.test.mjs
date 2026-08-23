import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateAutonomousResearchOnlineSchemaTransitionInventory,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {
  autonomousResearchStateDatabaseScopeHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  fixture,
  stateDatabaseManifest,
} from './support/autonomous-research-online-schema-transition-fixture.mjs';

test('schema transition inventory rejects extra or duplicate role projections', (context) => {
  const setup = fixture(context);
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const extraBody = Object.freeze({
    ...inventory,
    instances: Object.freeze([
      ...inventory.instances,
      Object.freeze({
        ...inventory.instances[0],
        instanceId: 'native-store:unexpected-extra',
        sourceRelativePath: 'autonomous-research/unexpected-extra.sqlite',
      }),
    ]),
  });
  assert.throws(
    () => validateAutonomousResearchOnlineSchemaTransitionInventory({
      runtimeRoot: setup.runtimeRoot,
      inventory: Object.freeze({
        ...extraBody,
        databaseScopeHash: autonomousResearchStateDatabaseScopeHash(extraBody.instances),
      }),
      stateDatabaseManifest,
    }),
    /autonomous_research_online_schema_transition_inventory_invalid/,
  );
  const duplicateBody = Object.freeze({
    ...inventory,
    instances: Object.freeze(inventory.instances.map((entry, index) => index === 1
      ? Object.freeze({ ...entry, role: inventory.instances[0].role })
      : entry)),
  });
  assert.throws(
    () => validateAutonomousResearchOnlineSchemaTransitionInventory({
      runtimeRoot: setup.runtimeRoot,
      inventory: Object.freeze({
        ...duplicateBody,
        databaseScopeHash: autonomousResearchStateDatabaseScopeHash(duplicateBody.instances),
      }),
      stateDatabaseManifest,
    }),
    /autonomous_research_online_schema_transition_inventory_invalid/,
  );
});

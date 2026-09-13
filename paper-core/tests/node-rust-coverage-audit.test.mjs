import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditCurrentCoverage, buildCoverageInventory } from '../../docs/tools/audit-node-rust-coverage.mjs';
import { COMMAND_REGISTRY_ROUTES } from '../src/command-registry-routes.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';

const report = auditCurrentCoverage();
test('inventory retains every command and every argument-dependent effect', () => {
  assert.equal(report.commands.length, COMMAND_REGISTRY_ROUTES.length);
  for (const route of COMMAND_REGISTRY_ROUTES) {
    const row = report.commands.find((value) => value.id === `${route.group}/${route.name}`);
    assert.ok(row);
    assert.deepEqual(row.nodeArgv, route.argv);
    assert.deepEqual(row.effects, route.effects);
    assert.deepEqual(row.forwardedArgumentSchema, route.forwardedArgumentSchema);
    assert.deepEqual(row.unsupportedModes, route.unsupportedModes);
    assert.equal(row.rustEntrypoint, null);
  }
});
test('catalog, command, module and global capability denominators stay separate', () => {
  assert.equal(report.catalogCapabilities.length, Object.keys(CAPABILITY_CATALOG).length);
  assert.equal(report.inventories.boundedKernelHints, 7);
  assert.equal(report.inventories.commands, 57);
  assert.equal(report.inventories.commandGroups.operator, 37);
  assert.equal(report.inventories.registeredModules, 32);
  assert.equal(report.inventories.globalCapabilities, 29);
});
test('bounded kernels never become accepted full business parity', () => {
  assert.equal(report.acceptedParityRows, 0);
  assert.equal(report.fullReplacementEstablished, false);
  assert.equal(report.productionActivationVerified, false);
  assert.equal(report.nodeRetirementVerified, false);
  assert.ok(report.globalCapabilities.every((row) => row.fullBusinessParity === 'not_established_by_this_inventory'));
});
test('duplicate command identities are rejected instead of losing a route', () => {
  const route = COMMAND_REGISTRY_ROUTES[0];
  assert.throws(() => buildCoverageInventory([route, route], {}, {}, {}), /duplicate command/);
});
test('unknown future command remains visible and unassessed', () => {
  const route = { ...COMMAND_REGISTRY_ROUTES[0], name: 'future-command' };
  const future = buildCoverageInventory([route], {}, {}, {});
  assert.equal(future.commands[0].command, 'future-command');
  assert.equal(future.commands[0].compatibilityDecision, 'unassessed');
  assert.equal(future.fullReplacementEstablished, false);
});
test('source inventory is deterministic and binds actual source bytes', () => {
  assert.deepEqual(auditCurrentCoverage(), report);
  assert.ok(report.sourceBindings.length > 50);
  assert.ok(report.sourceBindings.every((row) => /^sha256:[0-9a-f]{64}$/.test(row.sha256)));
});
test('completion mode rejects an inventory without independent acceptance', () => {
  const script = fileURLToPath(new URL('../../docs/tools/audit-node-rust-coverage.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--require-complete'], { encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).fullReplacementEstablished, false);
});

test('all declared campaign action modes retain source mapping or explicit gaps', () => {
  const modes = report.campaignModeMappings;
  assert.equal(modes.acceptedParity, false);
  assert.equal(modes.productionActivation, false);
  assert.equal(modes.nodeRetirement, false);
  assert.equal(modes.modes.length, 15);
  assert.equal(modes.modes.filter((row) => row.scope === 'partial_local_source').length, 11);
  assert.equal(new Set(modes.modes.map((row) => row.nodeAction)).size, modes.modes.length);
  assert.ok(modes.modes.find((row) => row.nodeAction === 'cancel-node').scope === 'unmapped');
  assert.ok(modes.modes.find((row) => row.nodeAction === 'resume').remaining.includes('not equivalent'));
  assert.equal(report.acceptedParityRows, 0);
});

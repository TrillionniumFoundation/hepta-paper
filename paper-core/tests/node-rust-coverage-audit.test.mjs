import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditCurrentCoverage, auditNodeRustCommandMap, buildCoverageInventory } from '../../docs/tools/audit-node-rust-coverage.mjs';
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
test('partial command mappings bind both concrete Rust sources and tests', () => {
  const partial = report.commandMappings.commands.filter((row) => row.scope === 'partial_local_source');
  assert.equal(partial.length, report.commandMappings.mappedCommands);
  assert.ok(partial.every((row) => row.rustEntrypoint && row.rustSources.length > 0 && row.tests.length > 0));
  assert.ok(report.commandMappings.commands.filter((row) => row.scope === 'unmapped').some((row) => row.id === 'verify/full'));
});

test('command source inventory rejects removed, empty, duplicated or falsely scoped bindings', () => {
  const mutations = [
    [row => { row.callChain = []; }, /missing Rust candidate/],
    [row => { row.testCases = []; }, /missing Rust candidate/],
    [row => { row.callChain[0].symbol = 'removed_rust_implementation'; }, /mapped command symbol missing/],
    [row => { row.testCases[0].symbol = 'not_an_executable_test'; }, /mapped command symbol missing/],
    [row => { row.callChain.push({ ...row.callChain[0] }); }, /duplicate command symbol binding/],
    [row => { row.callChain[0].path = row.tests[0]; }, /invalid command symbol binding/],
    [row => { row.compatibilityDecision = 'unmapped'; }, /missing Rust candidate/],
    [row => { row.scope = 'unmapped'; row.compatibilityDecision = 'unmapped'; }, /unmapped command claims Rust source/],
    [row => { row.rustSources[0] = 'rust/removed-source-that-does-not-exist.rs'; }, /ENOENT/],
  ];
  for (const [mutate, expected] of mutations) {
    const map = structuredClone(report.commandMappings);
    mutate(map.commands.find(row => row.scope === 'partial_local_source'));
    assert.throws(() => auditNodeRustCommandMap(COMMAND_REGISTRY_ROUTES, map), expected);
  }
});

test('source inventory does not confuse symbol existence with execution or call graph proof', () => {
  assert.equal(report.commandMappings.sourceSymbolsValidated, true);
  assert.equal(report.commandMappings.callGraphVerified, false);
  assert.equal(report.commandMappings.testsExecutedByThisValidator, false);
  const map = structuredClone(report.commandMappings);
  const row = map.commands.find(value => value.scope === 'partial_local_source');
  row.tests = [...row.rustSources];
  row.testCases = [{ ...row.callChain[0] }];
  assert.throws(() => auditNodeRustCommandMap(COMMAND_REGISTRY_ROUTES, map), /mapped command symbol missing/);
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
  assert.equal(modes.modes.filter((row) => row.scope === 'partial_local_source').length, 14);
  assert.equal(new Set(modes.modes.map((row) => row.nodeAction)).size, modes.modes.length);
  for (const action of ['gc', 'retention-recovery-readiness', 'provision-retention-recovery']) {
    const row = modes.modes.find((entry) => entry.nodeAction === action);
    assert.equal(row.scope, 'partial_local_source');
    assert.ok(row.callChain.length > 0 && row.tests.length > 0);
    assert.ok(row.remaining.length > 80);
  }
  assert.equal(modes.modes.filter((row) => row.scope === 'unmapped').length, 1);
  assert.equal(modes.modes.find((row) => row.nodeAction === 'cancel-node').scope, 'unmapped');
  assert.ok(modes.modes.find((row) => row.nodeAction === 'resume').remaining.includes('not equivalent'));
  assert.equal(report.acceptedParityRows, 0);
});

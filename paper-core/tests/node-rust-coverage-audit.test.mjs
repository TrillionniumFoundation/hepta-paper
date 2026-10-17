import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditCurrentCoverage, auditNodeRustCommandMap, buildCoverageInventory, loadCurrentNodeRustCommandMapV2 } from '../../docs/tools/audit-node-rust-coverage.mjs';
import { COMMAND_REGISTRY_ROUTES } from '../src/command-registry-routes.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';

function loadEncodedCommandMap() {
  return loadCurrentNodeRustCommandMapV2().map;
}


const report = auditCurrentCoverage();
const loadedCommandMap = loadCurrentNodeRustCommandMapV2();
const encodedCommandMap = loadEncodedCommandMap();

test('sharded V2 manifest binds every canonical ledger byte exactly once', () => {
  assert.equal(loadedCommandMap.manifest.kind, 'NodeRustCommandCompatibilityMapManifestV2');
  assert.equal(loadedCommandMap.manifest.commandCount, 57);
  assert.equal(loadedCommandMap.sourcePaths.length, 6);
  assert.equal(new Set(loadedCommandMap.sourcePaths).size, loadedCommandMap.sourcePaths.length);
  assert.ok(loadedCommandMap.manifest.shards.every((row) => /^sha256:[0-9a-f]{64}$/.test(row.sha256)));
});

test('indexed V2 command ledger expands to the complete validated route contract', () => {
  assert.equal(encodedCommandMap.schemaVersion, 2);
  assert.equal(encodedCommandMap.kind, 'NodeRustCommandCompatibilityMapV2');
  assert.equal(new Set(encodedCommandMap.paths).size, encodedCommandMap.paths.length);
  assert.equal(new Set(encodedCommandMap.symbols.map((entry) => JSON.stringify(entry))).size,
    encodedCommandMap.symbols.length);
  assert.ok(encodedCommandMap.commands.every((row) => row.tests.every(Number.isSafeInteger)
    && row.rustSources.every(Number.isSafeInteger)
    && row.callChain.every(Number.isSafeInteger)
    && row.testCases.every(Number.isSafeInteger)));
  const expanded = auditNodeRustCommandMap(COMMAND_REGISTRY_ROUTES, encodedCommandMap);
  assert.deepEqual(expanded.commands, report.commandMappings.commands);

  const outOfRange = structuredClone(encodedCommandMap);
  outOfRange.commands[0].tests[0] = outOfRange.paths.length;
  assert.throws(() => auditNodeRustCommandMap(COMMAND_REGISTRY_ROUTES, outOfRange),
    /invalid indexed Node\/Rust command binding/);

  const stale = structuredClone(encodedCommandMap);
  stale.paths.push('zz-unused-source.rs');
  assert.throws(() => auditNodeRustCommandMap(COMMAND_REGISTRY_ROUTES, stale),
    /unused table entries/);
});

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
  const full = report.commandMappings.commands.find((row) => row.id === 'verify/full');
  assert.equal(full.scope, 'partial_local_source');
  assert.equal(full.compatibilityDecision, 'candidate');
  assert.ok(full.callChain.some((row) => row.symbol === 'inspect_full_suite_verification_v1'));
  assert.ok(full.testCases.some((row) => row.symbol === 'require_parity_reports_inventory_without_running_node_or_npm'));
  assert.ok(full.callChain.some((row) => row.symbol === 'execute_full_suite_verification_v1'));
  assert.ok(full.testCases.some((row) => row.symbol === 'ordinary_native_verification_runs_real_rust_commands_and_binds_the_source'));
  assert.ok(full.testCases.some((row) => row.symbol === 'real_suite_sigterm_and_deadline_keep_failure_receipts_and_reap_the_test_group'));
  assert.equal(report.commandMappings.acceptedParity, false);
  assert.equal(report.fullReplacementEstablished, false);
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

test('canonical command ledger owns every campaign action mode and explicit gap', () => {
  const campaign = report.commandMappings.commands.find((row) => row.id === 'operator/campaign');
  assert.ok(campaign);
  const modes = campaign.argumentModes;
  assert.equal(report.commandMappings.acceptedParity, false);
  assert.equal(report.commandMappings.productionActivation, false);
  assert.equal(report.commandMappings.nodeRetirement, false);
  assert.equal(modes.length, 15);
  assert.equal(modes.filter((row) => row.scope === 'partial_local_source').length, 15);
  assert.equal(new Set(modes.map((row) => row.nodeAction)).size, modes.length);
  for (const action of ['gc', 'retention-recovery-readiness', 'provision-retention-recovery']) {
    const row = modes.find((entry) => entry.nodeAction === action);
    assert.equal(row.scope, 'partial_local_source');
    assert.ok(row.callChain.length > 0 && row.tests.length > 0);
    assert.ok(row.remaining.length > 80);
  }
  assert.equal(modes.filter((row) => row.scope === 'unmapped').length, 0);
  const cancelNode = modes.find((row) => row.nodeAction === 'cancel-node');
  assert.equal(cancelNode.scope, 'partial_local_source');
  assert.ok(cancelNode.callChain.length > 0 && cancelNode.tests.length > 0);
  assert.ok(modes.find((row) => row.nodeAction === 'resume').remaining.includes('not equivalent'));
  assert.equal(report.acceptedParityRows, 0);
});

test('raw registry and projected argv identities discover the same real action modes', () => {
  const projected = COMMAND_REGISTRY_ROUTES.map(({ argv, ...route }) => ({ ...route, nodeArgv: argv }));
  assert.deepEqual(auditNodeRustCommandMap(projected), auditNodeRustCommandMap(COMMAND_REGISTRY_ROUTES));
  const portal = report.commandMappings.commands.find((row) => row.id === 'operator/portal-target-qualification');
  assert.deepEqual(portal.argumentModes.map((mode) => mode.nodeAction).sort(),
    ['import-execute', 'import-plan', 'preflight', 'status']);
});

test('real action mapping cannot disappear or claim an unknown or duplicate action', () => {
  for (const mutate of [
    (row) => { row.argumentModes.pop(); },
    (row) => { row.argumentModes[0].nodeAction = 'unimplemented-future-action'; },
    (row) => { row.argumentModes.push(structuredClone(row.argumentModes[0])); },
  ]) {
    const map = structuredClone(report.commandMappings);
    mutate(map.commands.find((row) => row.id === 'operator/portal-target-qualification'));
    assert.throws(() => auditNodeRustCommandMap(COMMAND_REGISTRY_ROUTES, map), /action modes missing, duplicated or drifted/);
  }
});

test('missing and contradictory argv cannot bypass action-mode verification', () => {
  for (const patch of [
    { argv: undefined }, { argv: [] }, { argv: [null] },
    { nodeArgv: ['node', 'different-script.mjs'] },
  ]) {
    const routes = COMMAND_REGISTRY_ROUTES.map((route) => route.name === 'portal-target-qualification'
      ? { ...route, ...patch } : route);
    assert.throws(() => auditNodeRustCommandMap(routes), /Node (?:command arguments|argument identities)/);
  }
});

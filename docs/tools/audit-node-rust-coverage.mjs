#!/usr/bin/env node
// A source inventory, never a producer of parity or production authority.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { COMMAND_REGISTRY_ROUTES } from '../../paper-core/src/command-registry-routes.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const NATIVE = Object.freeze({
  'CAP-AUTHOR': ['author.rs', 'manuscript assembly, not model authorship'],
  'CAP-REVIEW': ['reviewer.rs', 'structural review, not independent scientific review'],
  'CAP-FORMAL': ['formal.rs', 'bounded propositional checking, not the complete formal toolchain'],
  'CAP-EMPIRICAL': ['empirical.rs', 'descriptive aggregation, not experiment execution'],
  'CAP-NUMERICAL': ['numerical.rs', 'dense linear solving, not all numerical or GPU workloads'],
  'CAP-BUILD': ['build.rs', 'deterministic bundle encoding, not full manuscript compilation'],
  'CAP-SUBMIT': ['submission.rs', 'submission preparation, not external delivery'],
});

function readSource(relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)
      || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('noncanonical source path');
  }
  let current = ROOT;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`source symlink: ${relative}`);
  }
  const stat = fs.lstatSync(current);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error(`invalid source: ${relative}`);
  const bytes = fs.readFileSync(current);
  return { path: relative, sha256: sha256(bytes) };
}

export function buildCoverageInventory(routes, catalog, globalCapabilities, modules) {
  const seen = new Set();
  const commands = [...routes].map((route) => {
    const id = `${route.group}/${route.name}`;
    if (seen.has(id)) throw new Error(`duplicate command: ${id}`);
    seen.add(id);
    if (!Array.isArray(route.argv) || !route.effects || !route.group || !route.name) throw new Error('invalid route');
    return {
      id, group: route.group, command: route.name,
      nodeArgv: [...route.argv], mutability: route.mutability,
      effects: { ...route.effects }, forwardingPolicy: route.forwardingPolicy,
      forwardedArgumentSchema: route.forwardedArgumentSchema,
      unsupportedModes: [...route.unsupportedModes],
      rustEntrypoint: null, compatibilityDecision: 'unassessed',
      parityEvidence: [], retirementEvidence: [],
      blocker: 'explicit_command_and_argument_mode_mapping_required',
    };
  }).sort((a, b) => compare(a.id, b.id));
  const catalogCapabilities = Object.entries(catalog).sort(([a], [b]) => compare(a, b))
    .map(([id, entry]) => ({ id, boundedContext: entry.boundedContext,
      nodeTarget: entry.target, rustEntrypoint: null,
      compatibilityDecision: 'unassessed', parityEvidence: [],
      blocker: 'capability_specific_call_chain_and_evidence_required' }));
  const globalRows = Object.keys(globalCapabilities).sort(compare).map((id) => ({
    id, registeredModuleIds: Object.entries(modules)
      .filter(([, module]) => module.capabilityIds.includes(id)).map(([key]) => key).sort(compare),
    rustCandidate: NATIVE[id] ? {
      scope: 'bounded_native_kernel',
      path: `rust/crates/hepta-paper-service/src/native_business/${NATIVE[id][0]}`,
      boundary: NATIVE[id][1],
      executableExample: 'docs/modules/examples/native-business.v1.json',
      testTarget: 'rust/crates/hepta-paper-service/tests/documented_native_business.rs',
    } : null,
    fullBusinessParity: 'not_established_by_this_inventory',
  }));
  const groups = Object.fromEntries([...new Set(commands.map((row) => row.group))].sort(compare)
    .map((group) => [group, commands.filter((row) => row.group === group).length]));
  return {
    kind: 'NodeRustCoverageInventoryV1', schemaVersion: 1,
    evidenceScope: 'source_inventory_not_acceptance',
    inventories: { commandGroups: groups, commands: commands.length,
      operatorCatalogCapabilities: catalogCapabilities.length, globalCapabilities: globalRows.length,
      registeredModules: Object.keys(modules).length, boundedKernelHints: globalRows.filter((row) => row.rustCandidate).length },
    commands, catalogCapabilities, globalCapabilities: globalRows,
    acceptedParityRows: 0,
    fullReplacementEstablished: false, productionActivationVerified: false, nodeRetirementVerified: false,
    remainingAcceptance: [
      'review every command, forwarded argument mode, state transition and effect',
      'bind Rust entrypoint and full call chain to exact source and executable tests',
      'accept exact, semantic, evaluation or explicitly reviewed retirement strategy',
      'retain capability-specific historical/live evaluation and recovery evidence',
      'accept exact-subject external qualification, shadow/canary and writer handoff',
      'prove old Node authority paths cannot reactivate',
    ],
  };
}

function actionModesFromNodeRoute(route) {
  if (!route || !Array.isArray(route.nodeArgv)) return { source: null, modes: [] };
  const fixedIndex = route.nodeArgv.indexOf('--action');
  if (fixedIndex >= 0 && typeof route.nodeArgv[fixedIndex + 1] === 'string') {
    return { source: null, modes: [] };
  }
  if (!route.forwardedArgumentSchema?.valueFlags?.includes('action')) {
    return { source: null, modes: [] };
  }
  const source = route.nodeArgv.find((value) => typeof value === 'string' && value.endsWith('.mjs'));
  if (!source) throw new Error(`dynamic action route missing Node source: ${route.group}/${route.name}`);
  const text = fs.readFileSync(path.join(ROOT, source), 'utf8');
  const modes = new Set();
  for (const match of text.matchAll(/--action(?:\\s+<[^>\\n]+>)?\\s+([a-z][a-z0-9-]*(?:\\|[a-z][a-z0-9-]+)+)/g)) {
    for (const value of match[1].split('|')) modes.add(value);
  }
  for (const match of text.matchAll(/--action\\s+([a-z][a-z0-9-]+)/g)) modes.add(match[1]);
  for (const match of text.matchAll(/\\[\\s*((?:(?:'|")[a-z][a-z0-9-]*(?:'|")\\s*,?\\s*){2,})\\]\\.includes\\(action\\)/g)) {
    for (const value of match[1].matchAll(/(?:'|")([a-z][a-z0-9-]*)(?:'|")/g)) modes.add(value[1]);
  }
  if (modes.size === 0) throw new Error(`dynamic Node action modes not discoverable: ${source}`);
  return { source, modes: [...modes].sort(compare) };
}

function actionModesFromRustEntrypoint(row) {
  if (typeof row.rustEntrypoint !== 'string') return [];
  const match = /--action\\s+([a-z][a-z0-9-]*(?:\\|[a-z][a-z0-9-]+)+)/.exec(row.rustEntrypoint);
  return match ? match[1].split('|').sort(compare) : [];
}

function validateCommandArgumentModes(row, route) {
  const node = actionModesFromNodeRoute(route);
  const expected = node.modes;
  const declared = Array.isArray(row.argumentModes)
    ? row.argumentModes.map((mode) => mode?.nodeAction).sort(compare)
    : [];
  if (JSON.stringify(declared) !== JSON.stringify(expected)
      || new Set(declared).size !== declared.length) {
    throw new Error(`canonical command map action modes missing, duplicated or drifted: ${row.id}`);
  }

  const topSources = new Set(row.callChain.map((reference) => `${reference.path}:${reference.symbol}`));
  const topTests = new Set(row.testCases.map((reference) => `${reference.path}:${reference.symbol}`));
  for (const mode of row.argumentModes || []) {
    if (!mode || typeof mode !== 'object' || Array.isArray(mode)
        || !['partial_local_source', 'unmapped'].includes(mode.scope)
        || typeof mode.remaining !== 'string' || mode.remaining.length < 20
        || !Array.isArray(mode.callChain) || !Array.isArray(mode.tests)) {
      throw new Error(`invalid command argument mode: ${row.id}:${String(mode?.nodeAction)}`);
    }
    if (mode.scope === 'partial_local_source'
        && (typeof mode.rustCommand !== 'string' || !mode.rustCommand
          || mode.callChain.length === 0 || mode.tests.length === 0)) {
      throw new Error(`argument mode missing Rust source mapping: ${row.id}:${mode.nodeAction}`);
    }
    if (mode.scope === 'unmapped'
        && (mode.rustCommand !== null || mode.callChain.length !== 0 || mode.tests.length !== 0)) {
      throw new Error(`unmapped argument mode claims Rust source: ${row.id}:${mode.nodeAction}`);
    }
    for (const [references, allowed, kind] of [
      [mode.callChain, topSources, 'source'], [mode.tests, topTests, 'test'],
    ]) {
      const seen = new Set();
      for (const reference of references) {
        if (!reference || typeof reference !== 'object' || Array.isArray(reference)
            || Object.keys(reference).sort().join(',') !== 'path,symbol'
            || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.symbol)) {
          throw new Error(`invalid argument-mode ${kind} binding: ${row.id}:${mode.nodeAction}`);
        }
        const identity = `${reference.path}:${reference.symbol}`;
        if (!allowed.has(identity) || seen.has(identity)) {
          throw new Error(`unbound or duplicate argument-mode ${kind}: ${row.id}:${mode.nodeAction}:${identity}`);
        }
        seen.add(identity);
      }
    }
  }

  const nodeSet = new Set(expected);
  const expectedExtensions = actionModesFromRustEntrypoint(row)
    .filter((mode) => !nodeSet.has(mode)).sort(compare);
  const declaredExtensions = Array.isArray(row.rustExtensionModes)
    ? [...row.rustExtensionModes].sort(compare) : [];
  if (JSON.stringify(declaredExtensions) !== JSON.stringify(expectedExtensions)
      || new Set(declaredExtensions).size !== declaredExtensions.length) {
    throw new Error(`Rust-only action modes are not explicitly classified: ${row.id}`);
  }
  return node.source ? [node.source] : [];
}

// This map is deliberately separate from acceptance.  It records only reviewed
// Rust command candidates (or an explicit unmapped decision), so that command
// coverage cannot silently disappear while the migration is in progress.
export function auditNodeRustCommandMap(routes, suppliedMap = null) {
  const relative = 'docs/migration/node-rust-command-map.v1.json';
  const map = suppliedMap ?? JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
  if (map.schemaVersion !== 1 || map.kind !== 'NodeRustCommandCompatibilityMapV1'
      || map.scope !== 'source_call_chain_mapping_not_parity_acceptance'
      || map.acceptedParity !== false || map.productionActivation !== false
      || map.nodeRetirement !== false || !Array.isArray(map.commands)) {
    throw new Error('invalid Node/Rust command map scope');
  }
  const expected = [...routes].map((route) => `${route.group}/${route.name}`).sort(compare);
  const actual = map.commands.map((row) => row.id).sort(compare);
  if (JSON.stringify(expected) !== JSON.stringify(actual)
      || new Set(actual).size !== actual.length) {
    throw new Error('Node/Rust command map is missing, duplicated or drifted');
  }
  const argumentModeSources = new Set();
  const routesById = new Map(routes.map((route) => [`${route.group}/${route.name}`, route]));
  for (const row of map.commands) {
    for (const source of validateCommandArgumentModes(row, routesById.get(row.id))) argumentModeSources.add(source);
    if (!['partial_local_source', 'unmapped'].includes(row.scope)
        || !['candidate', 'unmapped'].includes(row.compatibilityDecision)
        || typeof row.remaining !== 'string' || row.remaining.length < 20
        || !Array.isArray(row.tests) || !Array.isArray(row.rustSources)
        || !Array.isArray(row.callChain) || !Array.isArray(row.testCases)) {
      throw new Error(`invalid Node/Rust command map row: ${row.id}`);
    }
    if (row.scope === 'unmapped' && (row.compatibilityDecision !== 'unmapped'
        || row.rustEntrypoint !== null || row.tests.length || row.rustSources.length
        || row.callChain.length || row.testCases.length)) {
      throw new Error(`unmapped command claims Rust source: ${row.id}`);
    }
    if (row.scope === 'partial_local_source'
        && (!row.rustEntrypoint || row.compatibilityDecision !== 'candidate'
          || row.tests.length === 0 || row.rustSources.length === 0
          || row.callChain.length === 0 || row.testCases.length === 0)) {
      throw new Error(`partial command is missing Rust candidate, source, or test binding: ${row.id}`);
    }
    for (const test of row.tests) {
      if (!test || typeof test !== 'string') throw new Error(`invalid map test: ${row.id}`);
      readSource(test);
    }
    for (const source of row.rustSources) {
      if (!source || typeof source !== 'string') throw new Error(`invalid Rust source: ${row.id}`);
      readSource(source);
    }
    // Bounded source-symbol binding, not a call-graph or parity proof. A path
    // alone must not let a removed implementation retain a mapped status.
    for (const [references, paths, isTest] of [
      [row.callChain, row.rustSources, false], [row.testCases, row.tests, true],
    ]) {
      const seen = new Set();
      for (const reference of references) {
        if (!reference || typeof reference !== 'object' || Array.isArray(reference)
            || Object.keys(reference).sort().join(',') !== 'path,symbol'
            || !paths.includes(reference.path) || !reference.path.endsWith('.rs')
            || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.symbol)) {
          throw new Error(`invalid command symbol binding: ${row.id}`);
        }
        const identity = `${reference.path}:${reference.symbol}`;
        if (seen.has(identity)) throw new Error(`duplicate command symbol binding: ${row.id}`);
        seen.add(identity);
        const text = fs.readFileSync(path.join(ROOT, reference.path), 'utf8');
        const prefix = isTest ? '#\\[test\\]\\s*' : '^\\s*(?:pub(?:\\([^\\r\\n)]*\\))?\\s+)?';
        const declaration = new RegExp(`${prefix}(?:async\\s+)?fn\\s+${reference.symbol}\\s*(?:<[^\\r\\n]*>)?\\s*\\(`, 'm');
        if (!declaration.test(text)) throw new Error(`mapped command symbol missing: ${identity}`);
      }
    }
  }
  return {
    ...map,
    mappedCommands: map.commands.filter((row) => row.scope === 'partial_local_source').length,
    unmappedCommands: map.commands.filter((row) => row.scope === 'unmapped').length,
    sourceSymbolsValidated: true,
    callGraphVerified: false,
    testsExecutedByThisValidator: false,
    sourceBindings: [relative, ...argumentModeSources,
      ...map.commands.flatMap((row) => [...row.tests, ...row.rustSources])]
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort(compare).map(readSource),
  };
}

export function auditCurrentCoverage() {
  const globalFile = 'docs/system/truth/capabilities.v1.json';
  const moduleFile = 'docs/system/truth/modules.v1.json';
  const global = JSON.parse(fs.readFileSync(path.join(ROOT, globalFile), 'utf8'));
  const modules = JSON.parse(fs.readFileSync(path.join(ROOT, moduleFile), 'utf8'));
  const report = buildCoverageInventory(COMMAND_REGISTRY_ROUTES, CAPABILITY_CATALOG,
    global.capabilities, modules.modules);
  const sources = new Set([
    'docs/tools/audit-node-rust-coverage.mjs',
    'paper-core/src/command-registry-routes.mjs',
    'paper-core/src/command-registry-support-routes.mjs',
    'paper-core/src/command-registry-catalog.mjs',
    'paper-domain/governance/capability-catalog.mjs', globalFile, moduleFile,
  ]);
  for (const row of report.commands) for (const value of row.nodeArgv) {
    if (value.endsWith('.mjs')) sources.add(value);
  }
  for (const row of report.catalogCapabilities) sources.add(row.nodeTarget);
  for (const row of report.globalCapabilities) if (row.rustCandidate) {
    sources.add(row.rustCandidate.path);
    sources.add(row.rustCandidate.executableExample);
    sources.add(row.rustCandidate.testTarget);
  }
  report.commandMappings = auditNodeRustCommandMap(COMMAND_REGISTRY_ROUTES);
  for (const binding of report.commandMappings.sourceBindings) sources.add(binding.path);
  report.sourceBindings = [...sources].sort(compare).map(readSource);
  report.inventorySha256 = sha256(JSON.stringify(report));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 1 && args[0] === '--require-complete')) throw new Error('usage: audit-node-rust-coverage.mjs [--require-complete]');
    const report = auditCurrentCoverage();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    // This source inventory consumes no independent acceptance receipts. It cannot certify completion.
    if (args.includes('--require-complete')) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`coverage-audit: ${error.message}\n`);
    process.exitCode = 1;
  }
}

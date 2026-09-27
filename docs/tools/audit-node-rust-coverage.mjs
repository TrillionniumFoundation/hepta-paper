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

const COMMAND_MAP_V2_MANIFEST = 'docs/migration/node-rust-command-map.v2.json';
const COMMAND_MAP_V2_MANIFEST_KEYS = Object.freeze([
  'acceptedParity', 'commandCount', 'kind', 'ledgerKind', 'nodeRetirement',
  'pathCount', 'productionActivation', 'schemaVersion', 'scope', 'shards', 'symbolCount',
]);
const COMMAND_MAP_V2_SHARD_KEYS = Object.freeze(['count', 'kind', 'offset', 'path', 'sha256']);

function readBoundLedgerFile(relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)
      || !relative.startsWith('docs/migration/node-rust-command-map.v2.')
      || !relative.endsWith('.json') || relative.includes('\\')
      || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`noncanonical command-map shard: ${String(relative)}`);
  }
  let current = ROOT;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`command-map shard symlink: ${relative}`);
  }
  const stat = fs.lstatSync(current);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0 || stat.size > 1024 * 1024) {
    throw new Error(`invalid command-map shard: ${relative}`);
  }
  return fs.readFileSync(current);
}

export function loadCurrentNodeRustCommandMapV2() {
  const manifestBytes = readBoundLedgerFile(COMMAND_MAP_V2_MANIFEST);
  const manifest = JSON.parse(manifestBytes);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || Object.keys(manifest).sort().join(',') !== [...COMMAND_MAP_V2_MANIFEST_KEYS].sort().join(',')
      || manifest.schemaVersion !== 2
      || manifest.kind !== 'NodeRustCommandCompatibilityMapManifestV2'
      || manifest.ledgerKind !== 'NodeRustCommandCompatibilityMapV2'
      || manifest.scope !== 'source_call_chain_mapping_not_parity_acceptance'
      || manifest.acceptedParity !== false || manifest.productionActivation !== false
      || manifest.nodeRetirement !== false
      || !Number.isSafeInteger(manifest.pathCount) || manifest.pathCount <= 0
      || !Number.isSafeInteger(manifest.symbolCount) || manifest.symbolCount <= 0
      || !Number.isSafeInteger(manifest.commandCount) || manifest.commandCount <= 0
      || !Array.isArray(manifest.shards) || manifest.shards.length < 3) {
    throw new Error('invalid sharded Node/Rust command map manifest');
  }
  const tables = { paths: [], symbols: [], commands: [] };
  const sourcePaths = [COMMAND_MAP_V2_MANIFEST];
  const seenPaths = new Set(sourcePaths);
  for (const [index, shard] of manifest.shards.entries()) {
    if (!shard || typeof shard !== 'object' || Array.isArray(shard)
        || Object.keys(shard).sort().join(',') !== [...COMMAND_MAP_V2_SHARD_KEYS].sort().join(',')
        || !Object.hasOwn(tables, shard.kind)
        || !Number.isSafeInteger(shard.offset) || shard.offset < 0
        || !Number.isSafeInteger(shard.count) || shard.count <= 0
        || typeof shard.sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(shard.sha256)
        || seenPaths.has(shard.path)) {
      throw new Error(`invalid command-map shard manifest entry: ${index}`);
    }
    const target = tables[shard.kind];
    if (shard.offset !== target.length) throw new Error(`noncontiguous command-map shard: ${shard.path}`);
    const bytes = readBoundLedgerFile(shard.path);
    if (sha256(bytes) !== shard.sha256) throw new Error(`command-map shard digest mismatch: ${shard.path}`);
    const rows = JSON.parse(bytes);
    if (!Array.isArray(rows) || rows.length !== shard.count) {
      throw new Error(`command-map shard count mismatch: ${shard.path}`);
    }
    target.push(...rows);
    seenPaths.add(shard.path);
    sourcePaths.push(shard.path);
  }
  if (tables.paths.length !== manifest.pathCount
      || tables.symbols.length !== manifest.symbolCount
      || tables.commands.length !== manifest.commandCount) {
    throw new Error('sharded Node/Rust command map total count mismatch');
  }
  return {
    map: {
      schemaVersion: 2,
      kind: manifest.ledgerKind,
      scope: manifest.scope,
      acceptedParity: manifest.acceptedParity,
      productionActivation: manifest.productionActivation,
      nodeRetirement: manifest.nodeRetirement,
      paths: tables.paths,
      symbols: tables.symbols,
      commands: tables.commands,
    },
    manifest,
    sourcePaths,
  };
}

function actionModesFromNodeRoute(route) {
  // Raw registry routes use argv; projected inventory rows use nodeArgv.
  // Never silently pick one when a caller supplies contradictory identities.
  if (route?.argv !== undefined && route?.nodeArgv !== undefined
      && JSON.stringify(route.argv) !== JSON.stringify(route.nodeArgv)) {
    throw new Error('conflicting Node argument identities');
  }
  const nodeArgv = route?.argv ?? route?.nodeArgv;
  if (!Array.isArray(nodeArgv) || nodeArgv.length === 0
      || nodeArgv.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error('missing or invalid Node command arguments');
  }
  const fixedIndex = nodeArgv.indexOf('--action');
  if (fixedIndex >= 0 && typeof nodeArgv[fixedIndex + 1] === 'string') {
    return { source: null, modes: [] };
  }
  const actionDeclared = route.forwardedArgumentSchema?.valueFlags?.includes('action') === true;
  const source = nodeArgv.find((value) => typeof value === 'string' && value.endsWith('.mjs'));
  if (!source) {
    if (actionDeclared) {
      throw new Error(`dynamic action route missing Node source: ${route.group}/${route.name}`);
    }
    return { source: null, modes: [] };
  }
  const text = fs.readFileSync(path.join(ROOT, source), 'utf8');
  const modes = new Set();
  for (const match of text.matchAll(/--action(?:\s+<[^>\n]+>)?\s+([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]+)+)/g)) {
    for (const value of match[1].split('|')) modes.add(value);
  }
  for (const match of text.matchAll(/--action\s+([a-z][a-z0-9-]+)/g)) modes.add(match[1]);
  for (const match of text.matchAll(/\[\s*((?:(?:'|")[a-z][a-z0-9-]*(?:'|")\s*,?\s*){2,})\]\.includes\(action\)/g)) {
    for (const value of match[1].matchAll(/(?:'|")([a-z][a-z0-9-]*)(?:'|")/g)) modes.add(value[1]);
  }
  if (modes.size === 0) {
    if (actionDeclared) throw new Error(`dynamic Node action modes not discoverable: ${source}`);
    return { source: null, modes: [] };
  }
  return { source, modes: [...modes].sort(compare) };
}

function actionModesFromRustEntrypoint(row) {
  if (typeof row.rustEntrypoint !== 'string') return [];
  const match = /--action\s+([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]+)+)/.exec(row.rustEntrypoint);
  return match ? match[1].split('|').sort(compare) : [];
}

const COMMAND_MAP_V2_KEYS = Object.freeze([
  'acceptedParity', 'commands', 'kind', 'nodeRetirement', 'paths',
  'productionActivation', 'schemaVersion', 'scope', 'symbols',
]);

function decodeNodeRustCommandMapV2(raw, encodedRequired) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || raw.schemaVersion !== 2 || raw.kind !== 'NodeRustCommandCompatibilityMapV2') {
    throw new Error('invalid Node/Rust command map scope');
  }
  const encoded = Array.isArray(raw.paths) && Array.isArray(raw.symbols);
  if (!encoded) {
    if (encodedRequired || raw.paths !== undefined || raw.symbols !== undefined) {
      throw new Error('indexed Node/Rust command map tables missing');
    }
    return raw;
  }
  if (Object.keys(raw).sort().join(',') !== [...COMMAND_MAP_V2_KEYS].sort().join(',')) {
    throw new Error('indexed Node/Rust command map top-level fields drifted');
  }
  if (raw.paths.length === 0 || raw.symbols.length === 0
      || raw.paths.some((value) => typeof value !== 'string' || value.length === 0)
      || new Set(raw.paths).size !== raw.paths.length
      || JSON.stringify(raw.paths) !== JSON.stringify([...raw.paths].sort(compare))) {
    throw new Error('indexed Node/Rust command map path table invalid');
  }
  const symbols = raw.symbols.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2
        || !Number.isSafeInteger(entry[0]) || entry[0] < 0 || entry[0] >= raw.paths.length
        || typeof entry[1] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[1])) {
      throw new Error(`indexed Node/Rust command map symbol invalid: ${index}`);
    }
    return { path: raw.paths[entry[0]], symbol: entry[1], pathIndex: entry[0] };
  });
  const symbolIdentities = symbols.map((entry) => `${entry.path}:${entry.symbol}`);
  if (new Set(symbolIdentities).size !== symbolIdentities.length
      || JSON.stringify(symbolIdentities) !== JSON.stringify([...symbolIdentities].sort(compare))) {
    throw new Error('indexed Node/Rust command map symbol table invalid');
  }
  const usedPaths = new Set();
  const usedSymbols = new Set();
  const indexes = (values, maximum, label) => {
    if (!Array.isArray(values) || values.some((value) => !Number.isSafeInteger(value)
      || value < 0 || value >= maximum) || new Set(values).size !== values.length) {
      throw new Error(`invalid indexed Node/Rust command binding: ${label}`);
    }
    return values;
  };
  const expandPaths = (values, label) => indexes(values, raw.paths.length, label).map((index) => {
    usedPaths.add(index);
    return raw.paths[index];
  });
  const expandSymbols = (values, label) => indexes(values, symbols.length, label).map((index) => {
    const entry = symbols[index];
    usedSymbols.add(index);
    usedPaths.add(entry.pathIndex);
    return { path: entry.path, symbol: entry.symbol };
  });
  if (!Array.isArray(raw.commands)) throw new Error('indexed Node/Rust command rows missing');
  const commands = raw.commands.map((row, rowIndex) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`invalid indexed Node/Rust command row: ${rowIndex}`);
    }
    const expanded = {
      ...row,
      tests: expandPaths(row.tests, `${rowIndex}:tests`),
      rustSources: expandPaths(row.rustSources, `${rowIndex}:rustSources`),
      callChain: expandSymbols(row.callChain, `${rowIndex}:callChain`),
      testCases: expandSymbols(row.testCases, `${rowIndex}:testCases`),
    };
    if (row.argumentModes !== undefined) {
      if (!Array.isArray(row.argumentModes)) {
        throw new Error(`invalid indexed Node/Rust argument modes: ${rowIndex}`);
      }
      expanded.argumentModes = row.argumentModes.map((mode, modeIndex) => {
        if (!mode || typeof mode !== 'object' || Array.isArray(mode)) {
          throw new Error(`invalid indexed Node/Rust argument mode: ${rowIndex}:${modeIndex}`);
        }
        return {
          ...mode,
          callChain: expandSymbols(mode.callChain, `${rowIndex}:${modeIndex}:callChain`),
          tests: expandSymbols(mode.tests, `${rowIndex}:${modeIndex}:tests`),
        };
      });
    }
    return expanded;
  });
  if (usedPaths.size !== raw.paths.length || usedSymbols.size !== symbols.length) {
    throw new Error('indexed Node/Rust command map contains unused table entries');
  }
  return {
    schemaVersion: raw.schemaVersion,
    kind: raw.kind,
    scope: raw.scope,
    acceptedParity: raw.acceptedParity,
    productionActivation: raw.productionActivation,
    nodeRetirement: raw.nodeRetirement,
    commands,
  };
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
  const loaded = suppliedMap === null
    ? loadCurrentNodeRustCommandMapV2()
    : { map: suppliedMap, sourcePaths: [] };
  const raw = loaded.map;
  const map = decodeNodeRustCommandMapV2(raw, suppliedMap === null);
  if (map.schemaVersion !== 2 || map.kind !== 'NodeRustCommandCompatibilityMapV2'
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
    sourceBindings: [...loaded.sourcePaths, ...argumentModeSources,
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

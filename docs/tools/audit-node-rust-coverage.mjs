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

export function auditCampaignModeMappings() {
  const relative = 'docs/migration/campaign-mode-source-map.v1.json';
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
  if (map.schemaVersion !== 1 || map.kind !== 'NodeCampaignModeSourceMapV1'
      || map.scope !== 'source_call_chain_not_parity_acceptance'
      || map.acceptedParity !== false || map.productionActivation !== false || map.nodeRetirement !== false) {
    throw new Error('invalid campaign mode mapping scope');
  }
  const entry = fs.readFileSync(path.join(ROOT, map.nodeEntrypoint), 'utf8');
  const match = /--action <name>\s+([^'\n]+)/.exec(entry);
  if (!match) throw new Error('campaign action inventory changed');
  const actions = match[1].split('|').sort(compare);
  if (JSON.stringify(map.modes.map((row) => row.nodeAction).sort(compare)) !== JSON.stringify(actions)) {
    throw new Error('campaign action mapping missing, duplicated or drifted');
  }
  const sources = new Set([relative, map.nodeEntrypoint,
    'docs/modules/examples/local-inspection-requests.v1.json',
    'docs/modules/schemas/local-workflow-inspection-request-v1.schema.json',
    'docs/modules/schemas/local-workflow-inspection-response-v1.schema.json',
    'docs/modules/schemas/local-workflow-list-request-v1.schema.json',
  ]);
  for (const row of map.modes) {
    if (!['partial_local_source', 'unmapped'].includes(row.scope) || !row.remaining) throw new Error('invalid mapping');
    if (row.scope === 'partial_local_source' && (!row.rustCommand || !row.callChain.length || !row.tests.length)) throw new Error('missing source mapping');
    if (row.scope === 'unmapped' && (row.rustCommand !== null || row.callChain.length || row.tests.length)) throw new Error('unmapped row claims implementation');
    for (const reference of [...row.callChain, ...row.tests]) {
      readSource(reference.path);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.symbol)
          || !fs.readFileSync(path.join(ROOT, reference.path), 'utf8').includes(`fn ${reference.symbol}(`)) {
        throw new Error('mapped source symbol missing');
      }
      sources.add(reference.path);
    }
  }
  return { ...map, sourceBindings: [...sources].sort(compare).map(readSource) };
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
  report.campaignModeMappings = auditCampaignModeMappings();
  for (const binding of report.campaignModeMappings.sourceBindings) sources.add(binding.path);
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

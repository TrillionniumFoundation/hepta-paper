#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../..');
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'target',
  'coverage',
  'dist',
  '.cache',
]);

function parseArguments(argv) {
  let root = DEFAULT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--root') {
      const supplied = argv[index + 1];
      if (!supplied) throw new Error('docs-check: --root requires a path');
      root = path.resolve(supplied);
      index += 1;
      continue;
    }
    throw new Error(`docs-check: unknown argument ${value}`);
  }
  return { root };
}

function normalizeRelative(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function walkFiles(root, start, failures) {
  const absolute = path.resolve(root, start);
  if (!insideRoot(root, absolute)) {
    failures.push(`document root escapes repository: ${start}`);
    return [];
  }
  let initial;
  try {
    initial = fs.lstatSync(absolute);
  } catch {
    failures.push(`missing document root ${start}`);
    return [];
  }
  if (initial.isSymbolicLink()) {
    failures.push(`symbolic-link document root ${start}`);
    return [];
  }
  if (initial.isFile()) return [absolute];
  if (!initial.isDirectory()) {
    failures.push(`unsupported document root type ${start}`);
    return [];
  }

  const output = [];
  const pending = [absolute];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      const relative = normalizeRelative(path.relative(root, target));
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        failures.push(`symbolic link in documentation validation scope ${relative}`);
        continue;
      }
      if (stat.isDirectory()) pending.push(target);
      else if (stat.isFile()) output.push(target);
    }
  }
  return output.sort();
}

function readJson(root, relativePath, failures) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
  } catch (error) {
    failures.push(`${relativePath}: ${error.message}`);
    return {};
  }
}

function compilePatterns(values, label, failures) {
  const patterns = [];
  for (const value of values || []) {
    try {
      patterns.push(new RegExp(value, 'i'));
    } catch (error) {
      failures.push(`${label}: invalid pattern ${value}: ${error.message}`);
    }
  }
  return patterns;
}

function validateSchema(root, schemaPath, instancePath, failures) {
  const validator = path.join(root, 'docs/rust/tools/strict_json_schema.py');
  const result = spawnSync('python3', [
    validator,
    '--schema', path.join(root, schemaPath),
    '--instance', path.join(root, instancePath),
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    const diagnostic = (result.stderr || result.stdout || '').trim();
    failures.push(`${instancePath} schema: ${diagnostic || `exit ${result.status}`}`);
  }
}

function validateDirectedAcyclicGraph({ kind, records, dependenciesOf, failures }) {
  const visiting = new Set();
  const complete = new Set();

  function visit(id, chain) {
    if (visiting.has(id)) {
      const start = chain.indexOf(id);
      const cycle = [...chain.slice(start < 0 ? 0 : start), id];
      failures.push(`${kind} cycle ${cycle.join(' -> ')}`);
      return;
    }
    if (complete.has(id)) return;
    visiting.add(id);
    const record = records[id];
    for (const dependency of dependenciesOf(record) || []) {
      if (!Object.hasOwn(records, dependency)) {
        failures.push(`${id}: unknown ${kind} dependency ${dependency}`);
        continue;
      }
      visit(dependency, [...chain, id]);
    }
    visiting.delete(id);
    complete.add(id);
  }

  for (const id of Object.keys(records).sort()) visit(id, []);
}

function stripMarkdownCode(source) {
  return source
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
}

function markdownDestination(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('<')) {
    const closing = trimmed.indexOf('>');
    return closing < 0 ? null : trimmed.slice(1, closing);
  }
  const match = trimmed.match(/^(?:\\.|[^\s])+/);
  return match ? match[0] : null;
}

function validateMarkdownLinks(root, manifest, failures) {
  const markdown = new Set();
  for (const configuredRoot of manifest.localLinkRoots || []) {
    for (const file of walkFiles(root, configuredRoot, failures)) {
      if (file.endsWith('.md')) markdown.add(file);
    }
  }

  const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const file of [...markdown].sort()) {
    const relativeFile = normalizeRelative(path.relative(root, file));
    const source = stripMarkdownCode(fs.readFileSync(file, 'utf8'));
    for (const match of source.matchAll(linkPattern)) {
      let destination = markdownDestination(match[1]);
      if (!destination || external.test(destination)) continue;
      destination = destination.replace(/\\([() ])/g, '$1');
      destination = destination.split('#', 1)[0].split('?', 1)[0];
      if (!destination) continue;
      try {
        destination = decodeURIComponent(destination);
      } catch {
        failures.push(`${relativeFile}: malformed link encoding ${destination}`);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), destination);
      if (!insideRoot(root, resolved)) {
        failures.push(`${relativeFile}: local link escapes repository ${destination}`);
        continue;
      }
      if (!fs.existsSync(resolved)) {
        failures.push(`${relativeFile}: missing local link ${destination}`);
        continue;
      }
      if (fs.lstatSync(resolved).isSymbolicLink()) {
        failures.push(`${relativeFile}: local link targets symbolic link ${destination}`);
      }
    }
  }
  return markdown.size;
}

function activeConsumerFiles(root, manifest, failures) {
  const patterns = compilePatterns(
    manifest.activeConsumerFilePatterns,
    'activeConsumerFilePatterns',
    failures,
  );
  const files = new Set();
  for (const configuredRoot of manifest.activeConsumerRoots || []) {
    for (const file of walkFiles(root, configuredRoot, failures)) {
      const relative = normalizeRelative(path.relative(root, file));
      if (patterns.some((pattern) => pattern.test(relative))) files.add(file);
    }
  }
  return [...files].sort();
}

function validateActiveConsumerReferences(root, manifest, failures) {
  const consumers = activeConsumerFiles(root, manifest, failures);
  const forbidden = compilePatterns(
    manifest.forbiddenReferencePatterns,
    'forbiddenReferencePatterns',
    failures,
  );
  const allowlist = new Map();
  for (const row of manifest.referenceAllowlist || []) {
    const key = `${normalizeRelative(row.consumerPath)}\u0000${normalizeRelative(row.reference)}`;
    if (allowlist.has(key)) failures.push(`duplicate reference allowlist entry ${row.consumerPath}: ${row.reference}`);
    allowlist.set(key, row.reason);
  }
  const used = new Set();
  const referencePattern = /(?:docs|paper-core\/docs)\/[A-Za-z0-9_.\/-]+\.(?:md|json)(?:#[A-Za-z0-9_.:-]+)?/g;

  for (const file of consumers) {
    const consumerPath = normalizeRelative(path.relative(root, file));
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(referencePattern)) {
      const reference = normalizeRelative(match[0].split('#', 1)[0]);
      const key = `${consumerPath}\u0000${reference}`;
      if (allowlist.has(key)) {
        used.add(key);
        continue;
      }
      if (forbidden.some((pattern) => pattern.test(reference))) {
        failures.push(`${consumerPath}: forbidden historical document reference ${reference}`);
        continue;
      }
      const resolved = path.resolve(root, reference);
      if (!insideRoot(root, resolved) || !fs.existsSync(resolved)) {
        failures.push(`${consumerPath}: missing active-consumer document ${reference}`);
        continue;
      }
      if (fs.lstatSync(resolved).isSymbolicLink()) {
        failures.push(`${consumerPath}: active-consumer document is symbolic link ${reference}`);
      }
    }
  }

  for (const [key] of allowlist) {
    if (!used.has(key)) {
      const [consumerPath, reference] = key.split('\u0000');
      failures.push(`unused reference allowlist entry ${consumerPath}: ${reference}`);
    }
  }
  return consumers.length;
}

export function validateDevelopmentDocumentation(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const failures = [];
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) {
    return { ok: false, failures: [`invalid repository root ${root}`], report: null };
  }
  if (fs.lstatSync(root).isSymbolicLink()) {
    return { ok: false, failures: [`symbolic-link repository root ${root}`], report: null };
  }

  const files = {
    program: 'docs/system/truth/program.v2.json',
    capabilities: 'docs/system/truth/capabilities.v1.json',
    modules: 'docs/system/truth/modules.v1.json',
    work: 'docs/system/truth/work-items.v2.json',
    milestones: 'docs/system/truth/milestones.v1.json',
    risks: 'docs/system/truth/risks.v2.json',
    workloads: 'docs/system/truth/canonical-workloads.v1.json',
    documents: 'docs/system/truth/document-manifest.v1.json',
    evidence: 'docs/system/truth/evidence-bindings.v1.json',
  };
  const schemas = {
    program: 'docs/system/schemas/program-v2.schema.json',
    capabilities: 'docs/system/schemas/capabilities-v1.schema.json',
    modules: 'docs/system/schemas/modules-v1.schema.json',
    work: 'docs/system/schemas/work-items-v2.schema.json',
    milestones: 'docs/system/schemas/milestones-v1.schema.json',
    risks: 'docs/system/schemas/risks-v2.schema.json',
    workloads: 'docs/system/schemas/canonical-workloads-v1.schema.json',
    documents: 'docs/system/schemas/document-manifest-v1.schema.json',
    evidence: 'docs/system/schemas/evidence-bindings-v1.schema.json',
  };

  const truth = {};
  for (const key of Object.keys(files)) {
    truth[key] = readJson(root, files[key], failures);
    validateSchema(root, schemas[key], files[key], failures);
  }

  const capabilityRecords = truth.capabilities.capabilities || {};
  const moduleRecords = truth.modules.modules || {};
  const workRecords = truth.work.items || {};
  const milestoneRecords = truth.milestones.milestones || {};
  const riskRecords = truth.risks.risks || {};
  const evidenceRecords = truth.evidence.bindings || {};
  const capabilities = new Set(Object.keys(capabilityRecords));
  const modules = new Set(Object.keys(moduleRecords));
  const workItems = new Set(Object.keys(workRecords));
  const milestones = new Set(Object.keys(milestoneRecords));
  const risks = new Set(Object.keys(riskRecords));
  const bindings = new Set(Object.keys(evidenceRecords));
  const teams = new Set(truth.modules.teams || []);
  const workloads = new Set((truth.workloads.workloads || []).map((row) => row.workloadId));
  const invariantPath = path.join(root, 'docs/system/INVARIANTS.md');
  const invariantSource = fs.existsSync(invariantPath) ? fs.readFileSync(invariantPath, 'utf8') : '';
  const invariants = new Set([...invariantSource.matchAll(/\bINV-[0-9]{3}\b/g)].map((match) => match[0]));

  for (const [id, capability] of Object.entries(capabilityRecords)) {
    for (const dependency of capability.dependencies || []) {
      if (!capabilities.has(dependency)) failures.push(`${id}: unknown capability ${dependency}`);
    }
    for (const invariant of capability.invariants || []) {
      if (!invariants.has(invariant)) failures.push(`${id}: unknown invariant ${invariant}`);
    }
    for (const moduleId of capability.moduleIds || []) {
      if (!modules.has(moduleId)) failures.push(`${id}: unknown module ${moduleId}`);
    }
    for (const workItemId of capability.workItemIds || []) {
      if (!workItems.has(workItemId)) failures.push(`${id}: unknown work ${workItemId}`);
    }
    if (!bindings.has(id)) failures.push(`${id}: missing evidence binding`);
  }

  for (const [id, moduleRecord] of Object.entries(moduleRecords)) {
    for (const configuredPath of moduleRecord.paths || []) {
      const resolved = path.resolve(root, configuredPath);
      if (!insideRoot(root, resolved) || !fs.existsSync(resolved)) failures.push(`${id}: missing path ${configuredPath}`);
    }
    for (const capabilityId of moduleRecord.capabilityIds || []) {
      if (!capabilities.has(capabilityId)
          || !(capabilityRecords[capabilityId].moduleIds || []).includes(id)) {
        failures.push(`${id}: bad capability ${capabilityId}`);
      }
    }
    for (const dependency of moduleRecord.dependencies || []) {
      if (!modules.has(dependency)) failures.push(`${id}: unknown dependency ${dependency}`);
    }
    for (const workItemId of moduleRecord.workItemIds || []) {
      if (!workItems.has(workItemId)) failures.push(`${id}: unknown work ${workItemId}`);
    }
    for (const owner of moduleRecord.owners || []) {
      if (!teams.has(owner)) failures.push(`${id}: unknown team ${owner}`);
    }
    if (moduleRecord.authority === 'central_state_write'
        && !['module.commit-sequencer', 'module.node-control-plane'].includes(id)) {
      failures.push(`${id}: forbidden central writer`);
    }
  }

  for (const [id, workItem] of Object.entries(workRecords)) {
    if (!modules.has(workItem.moduleId)) failures.push(`${id}: unknown module`);
    for (const capabilityId of workItem.capabilityIds || []) {
      if (!capabilities.has(capabilityId)) failures.push(`${id}: unknown capability ${capabilityId}`);
    }
    for (const dependency of workItem.dependencies || []) {
      if (!workItems.has(dependency)) failures.push(`${id}: unknown dependency ${dependency}`);
    }
    if (!teams.has(workItem.ownerTeam)) failures.push(`${id}: unknown owner`);
  }

  for (const [id, milestone] of Object.entries(milestoneRecords)) {
    for (const dependency of milestone.dependencies || []) {
      if (!milestones.has(dependency)) failures.push(`${id}: unknown milestone ${dependency}`);
    }
    for (const workItemId of milestone.workItemIds || []) {
      if (!workItems.has(workItemId)) failures.push(`${id}: unknown work ${workItemId}`);
    }
    for (const owner of milestone.ownerTeams || []) {
      if (!teams.has(owner)) failures.push(`${id}: unknown team ${owner}`);
    }
  }

  for (const id of truth.program.openCriticalGates || []) {
    if (!milestones.has(id) || milestoneRecords[id].closureState === 'closed') {
      failures.push(`program: invalid open gate ${id}`);
    }
  }

  for (const [id, risk] of Object.entries(riskRecords)) {
    for (const owner of risk.ownerTeams || []) {
      if (!teams.has(owner)) failures.push(`${id}: unknown team ${owner}`);
    }
    for (const milestone of risk.milestones || []) {
      if (!milestones.has(milestone)) failures.push(`${id}: unknown milestone ${milestone}`);
    }
  }

  for (const [id, binding] of Object.entries(evidenceRecords)) {
    const capability = capabilityRecords[id];
    if (!capability) {
      failures.push(`${id}: unknown evidence capability`);
      continue;
    }
    for (const moduleId of binding.moduleIds || []) {
      if (!modules.has(moduleId)) failures.push(`${id}: bad evidence module ${moduleId}`);
    }
    for (const workItemId of binding.workItemIds || []) {
      if (!workItems.has(workItemId)) failures.push(`${id}: bad evidence work ${workItemId}`);
    }
    for (const workloadId of binding.canonicalWorkloadIds || []) {
      if (!workloads.has(workloadId)) failures.push(`${id}: bad workload ${workloadId}`);
    }
    for (const field of ['moduleIds', 'workItemIds', 'externalBlockerIds']) {
      const left = [...(binding[field] || [])].sort();
      const right = [...(capability[field] || [])].sort();
      if (JSON.stringify(left) !== JSON.stringify(right)) failures.push(`${id}: ${field} mismatch`);
    }
    if (binding.minimumEvidenceTier !== capability.minimumEvidenceTier) failures.push(`${id}: tier mismatch`);
  }

  validateDirectedAcyclicGraph({
    kind: 'capability',
    records: capabilityRecords,
    dependenciesOf: (record) => record.dependencies || [],
    failures,
  });
  validateDirectedAcyclicGraph({
    kind: 'module',
    records: moduleRecords,
    dependenciesOf: (record) => record.dependencies || [],
    failures,
  });
  validateDirectedAcyclicGraph({
    kind: 'work-item',
    records: workRecords,
    dependenciesOf: (record) => record.dependencies || [],
    failures,
  });
  validateDirectedAcyclicGraph({
    kind: 'milestone',
    records: milestoneRecords,
    dependenciesOf: (record) => record.dependencies || [],
    failures,
  });

  const manifest = truth.documents;
  for (const documentPath of Object.values(manifest.canonicalDocuments || {})) {
    if (!fs.existsSync(path.join(root, documentPath))) failures.push(`missing canonical document ${documentPath}`);
  }
  for (const configuredRoot of manifest.roots || []) {
    if (!fs.existsSync(path.join(root, configuredRoot))) failures.push(`missing document root ${configuredRoot}`);
  }
  for (const singleton of manifest.singletons || []) {
    if (!fs.existsSync(path.join(root, singleton))) failures.push(`missing singleton ${singleton}`);
  }
  for (const machineRecord of truth.program.machineRecords || []) {
    if (!fs.existsSync(path.join(root, machineRecord))) failures.push(`missing machine record ${machineRecord}`);
  }

  const markdownFiles = new Set();
  for (const configuredRoot of manifest.roots || []) {
    for (const file of walkFiles(root, configuredRoot, failures)) {
      if (file.endsWith('.md')) markdownFiles.add(file);
    }
  }
  const forbiddenNames = compilePatterns(manifest.forbiddenPatterns, 'forbiddenPatterns', failures);
  for (const file of markdownFiles) {
    const relative = normalizeRelative(path.relative(root, file));
    for (const pattern of forbiddenNames) {
      if (pattern.test(relative)) failures.push(`forbidden historical document ${relative}`);
    }
  }

  const linkedMarkdownCount = validateMarkdownLinks(root, manifest, failures);
  const activeConsumerCount = validateActiveConsumerReferences(root, manifest, failures);
  const report = {
    status: 'development_documentation_valid',
    planVersion: truth.program.planVersion,
    documents: markdownFiles.size,
    linkedDocuments: linkedMarkdownCount,
    activeConsumers: activeConsumerCount,
    capabilities: capabilities.size,
    modules: modules.size,
    workItems: workItems.size,
    milestones: milestones.size,
    risks: risks.size,
    workloads: workloads.size,
    dependencyGraphs: ['capability', 'module', 'work-item', 'milestone'],
  };
  return { ok: failures.length === 0, failures, report };
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const result = validateDevelopmentDocumentation(options);
  if (!result.ok) {
    for (const failure of result.failures) console.error(`docs-check: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result.report, null, 2));
}

if (path.resolve(process.argv[1] || '') === SCRIPT_PATH) main();

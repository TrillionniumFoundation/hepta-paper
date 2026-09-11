#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../..');
const MAX_FILE_BYTES = 1024 * 1024;
const REGISTRY_PATH = 'docs/system/truth/modules.v1.json';
const INDEX_PATH = 'docs/modules/module-documentation.v1.json';
const WORK_PATH = 'docs/system/truth/work-items.v2.json';
const SCHEMAS = {
  registry: 'docs/system/schemas/modules-v1.schema.json',
  index: 'docs/modules/schemas/module-documentation-index-v1.schema.json',
  work: 'docs/system/schemas/work-items-v2.schema.json',
  manifest: 'docs/modules/schemas/module-documentation-manifest-v1.schema.json',
};

function parseArguments(argv) {
  let root = DEFAULT_ROOT;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--root') {
      const supplied = argv[index + 1];
      if (!supplied) throw new Error('--root requires a path');
      root = path.resolve(supplied);
      index += 1;
    } else if (value === '--json') json = true;
    else throw new Error(`unknown argument ${value}`);
  }
  return { root, json };
}

// This is a static repository gate, not a replacement for runtime path authority.
// Reject aliases in every component, not just symlinks at the final filename.
function canonicalPath(root, relative, expected = null) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
      || relative.includes('\\') || relative.includes('\0')
      || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('expected canonical repository-relative path');
  }
  let current = root;
  let stat = fs.lstatSync(current);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('noncanonical repository root');
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('symbolic link in repository path');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('non-directory ancestor');
  }
  if (expected === 'file' && (!stat.isFile() || stat.nlink !== 1)) {
    throw new Error('expected single-link canonical regular file');
  }
  if (expected === 'directory' && !stat.isDirectory()) throw new Error('expected canonical directory');
  if (!stat.isDirectory() && !stat.isFile()) throw new Error('unsupported repository node');
  return { absolute: current, stat };
}

function sameFile(left, right) {
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => left[key] === right[key]);
}

function readText(root, relative, failures) {
  let descriptor;
  try {
    const { absolute, stat } = canonicalPath(root, relative, 'file');
    if (stat.size > MAX_FILE_BYTES) throw new Error('document exceeds byte limit');
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!sameFile(stat, opened)) throw new Error('document changed before read');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_FILE_BYTES || !sameFile(opened, fs.fstatSync(descriptor))
        || !sameFile(opened, canonicalPath(root, relative, 'file').stat)) {
      throw new Error('document changed during read or exceeds byte limit');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } catch (error) {
    failures.push(`${relative}: ${error.message}`);
    return '';
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readJson(root, relative, failures) {
  const source = readText(root, relative, failures);
  try { return { source, value: JSON.parse(source) }; }
  catch (error) {
    failures.push(`${relative}: invalid JSON: ${error.message}`);
    return { source, value: {} };
  }
}

function validateBatch(documents, failures) {
  if (documents.length === 0) return;
  const input = JSON.stringify(documents);
  if (Buffer.byteLength(input) > 4 * MAX_FILE_BYTES) {
    failures.push('module schema batch exceeds byte limit');
    return;
  }
  // Use the verifier beside this executable, never a candidate --root script.
  // The batch contains already captured schema/instance bytes; it opens no input paths.
  const result = spawnSync('python3', [
    path.join(DEFAULT_ROOT, 'docs/rust/tools/strict_json_schema.py'), '--batch-stdin',
  ], { input, encoding: 'utf8', timeout: 10000, maxBuffer: MAX_FILE_BYTES });
  try {
    const report = JSON.parse(result.stdout || '');
    if (!Array.isArray(report.failures)) throw new Error('malformed schema report');
    for (const row of report.failures) failures.push(`${row.name} schema: ${row.error}`);
    if (result.status !== 0 || report.ok !== true) {
      if (report.failures.length === 0) throw new Error('schema validator failed without diagnostics');
    }
  } catch {
    failures.push(`module schema validation unavailable or invalid: ${result.error?.code || result.status}`);
  }
}

function listFiles(root, relative, suffix, failures) {
  try {
    const { absolute } = canonicalPath(root, relative, 'directory');
    const entries = fs.readdirSync(absolute, { withFileTypes: true });
    if (entries.length > 1024) throw new Error('module directory exceeds entry limit');
    for (const entry of entries) {
      if (entry.isSymbolicLink()) failures.push(`${relative}/${entry.name}: symbolic module document`);
    }
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => `${relative}/${entry.name}`).sort();
  } catch (error) {
    failures.push(`${relative}: ${error.message}`);
    return [];
  }
}

function sectionsOf(source) {
  const sections = new Map();
  let current = null;
  let fence = null;
  for (const line of source.split(/\r?\n/)) {
    const boundary = /^\s*(`{3,}|~{3,})/.exec(line);
    if (boundary && (!fence || (boundary[1][0] === fence[0] && boundary[1].length >= fence.length))) {
      fence = fence ? null : boundary[1];
      continue;
    }
    if (!fence && line.startsWith('## ')) {
      current = [];
      const heading = line.slice(3);
      const matches = sections.get(heading) || [];
      matches.push(current);
      sections.set(heading, matches);
    } else if (current) current.push(line);
  }
  return sections;
}

function validateSpec(moduleId, record, source, headings, failures) {
  const sections = sectionsOf(source);
  if (/\b(?:TODO|TBD|PLACEHOLDER|FIXME)\b/i.test(source)) failures.push(`${moduleId}: specification contains placeholder language`);
  for (const heading of headings) {
    const matches = sections.get(heading) || [];
    if (matches.length === 0) failures.push(`${moduleId}: missing heading ## ${heading}`);
    else if (matches.length !== 1) failures.push(`${moduleId}: duplicate heading ## ${heading}`);
    else if (!matches[0].join('\n').trim()) failures.push(`${moduleId}: empty section ## ${heading}`);
  }
  const identity = sections.get('Identity')?.[0] || [];
  const fields = {
    moduleId, implementationKind: record.kind, staticImplementationState: record.state,
    staticActivation: record.activation, authorityClass: record.authority,
    qualificationRequirement: record.qualification, protocolMinimum: 1, protocolMaximum: 1,
    primaryOwnerTeam: record.owners[0], secondaryOwnerTeam: record.owners[1],
    independentReviewerTeam: record.owners[2],
  };
  for (const [key, value] of Object.entries(fields)) {
    if (identity.filter((line) => line.startsWith(`${key}:`)).length !== 1
        || !identity.includes(`${key}: ${value}`)) failures.push(`${moduleId}: specification ${key} mismatch`);
  }
  const required = {
    pure: ['no durable state', 'cannot grant'], read_only: ['read only', 'cannot mutate'],
    prepared_result_only: ['prepared result', 'commit sequencer'],
    central_state_write: ['single-writer', 'fencing'],
    external_effect: ['durable intent', 'idempotency', 'reconciliation', 'human'],
  }[record.authority] || [];
  for (const term of required) {
    if (!source.toLowerCase().includes(term)) failures.push(`${moduleId}: specification missing authority term "${term}"`);
  }
}

function validateManifest(moduleId, record, entry, manifest, failures) {
  const scalarChecks = {
    moduleId, specPath: entry.specPath, authorityClass: record.authority,
    qualificationRequirement: record.qualification, documentationStatus: 'complete',
    effectiveQualification: 'derived_only', registryRef: `${REGISTRY_PATH}#/modules/${moduleId}`,
    runbookPath: `${entry.specPath}#operational-runbook`,
  };
  for (const [field, expected] of Object.entries(scalarChecks)) {
    if (manifest[field] !== expected) failures.push(`${moduleId}: manifest ${field} mismatch`);
  }
  const arrayChecks = {
    implementationPaths: record.paths, capabilityIds: record.capabilityIds,
    dependencyModuleIds: record.dependencies, workItemIds: record.workItemIds,
  };
  for (const [field, expected] of Object.entries(arrayChecks)) {
    if (JSON.stringify([...manifest[field]].sort()) !== JSON.stringify([...expected].sort())) {
      failures.push(`${moduleId}: manifest ${field} mismatch`);
    }
  }
  // These are roles, not an unordered set: changing their order changes independence.
  if (JSON.stringify(manifest.ownerTeams) !== JSON.stringify(record.owners)) failures.push(`${moduleId}: owner role order mismatch`);
  if (manifest.rollout.automaticActivation !== false || manifest.rollout.productionActivation !== false) {
    failures.push(`${moduleId}: static documentation may not activate production`);
  }
  if (manifest.rollout.currentStaticActivation !== record.activation) failures.push(`${moduleId}: rollout static activation mismatch`);
  if (record.authority === 'central_state_write' && !manifest.rollout.mutualExclusionRequired) {
    failures.push(`${moduleId}: central writer must require mutual exclusion`);
  }
  const allowedEffects = {
    pure: ['none'], read_only: ['none'], central_state_write: ['central_commit'],
    workspace_local_write: ['local_ephemeral', 'workspace_mutation'],
    prepared_result_only: ['local_ephemeral', 'workspace_mutation', 'prepared_result'],
    external_effect: ['external_effect', 'portal_mutation', 'submission'],
  }[record.authority];
  if (manifest.sideEffectClasses.some((effect) => !allowedEffects?.includes(effect))) {
    failures.push(`${moduleId}: side effects exceed authority ceiling`);
  }
}

export function validateModuleDocumentation(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const failures = [];
  const report = { registryModules: 0, documentedModules: 0, specifications: 0, manifests: 0, requiredSections: 0 };
  const finish = () => ({ ok: failures.length === 0, failures, report });
  const schemas = Object.fromEntries(Object.entries(SCHEMAS)
    .map(([name, relative]) => [name, readText(root, relative, failures)]));
  const registry = readJson(root, REGISTRY_PATH, failures);
  const index = readJson(root, INDEX_PATH, failures);
  const work = readJson(root, WORK_PATH, failures);
  if (failures.length) return finish();
  validateBatch([
    { name: REGISTRY_PATH, schema: schemas.registry, instance: registry.source },
    { name: INDEX_PATH, schema: schemas.index, instance: index.source },
    { name: WORK_PATH, schema: schemas.work, instance: work.source },
  ], failures);
  if (failures.length) return finish();

  const modules = registry.value.modules;
  const documented = index.value.modules;
  const registryIds = Object.keys(modules).sort();
  const documentedIds = Object.keys(documented).sort();
  if (registryIds.length > 128 || documentedIds.length > 128) {
    failures.push('module registry exceeds validation limit');
    return finish();
  }
  report.registryModules = registryIds.length;
  report.documentedModules = documentedIds.length;
  report.requiredSections = index.value.requiredSections.length;
  if (JSON.stringify(registryIds) !== JSON.stringify(documentedIds)) failures.push(`module set mismatch: registry=${registryIds.length} documentation=${documentedIds.length}`);
  const manifests = new Map();
  const seenSpecs = new Set();
  const seenManifests = new Set();
  const batches = [];
  for (const moduleId of documentedIds) {
    const entry = documented[moduleId];
    for (const [field, seen] of [['specPath', seenSpecs], ['manifestPath', seenManifests]]) {
      if (seen.has(entry[field])) failures.push(`${moduleId}: duplicate ${field} ${entry[field]}`);
      seen.add(entry[field]);
    }
    const manifest = readJson(root, entry.manifestPath, failures);
    manifests.set(moduleId, manifest.value);
    batches.push({ name: entry.manifestPath, schema: schemas.manifest, instance: manifest.source });
  }
  validateBatch(batches, failures);
  if (failures.length) return finish();

  const projection = {};
  for (const moduleId of registryIds) {
    const record = modules[moduleId];
    const entry = documented[moduleId];
    const spec = readText(root, entry.specPath, failures);
    validateSpec(moduleId, record, spec, index.value.requiredSections, failures);
    validateManifest(moduleId, record, entry, manifests.get(moduleId), failures);
    for (const configuredPath of record.paths) {
      try { canonicalPath(root, configuredPath); }
      catch (error) { failures.push(`${moduleId}: missing or noncanonical implementation/contract path ${configuredPath}: ${error.message}`); }
    }
    for (const dependency of record.dependencies) {
      if (!Object.hasOwn(modules, dependency)) failures.push(`${moduleId}: unknown module dependency ${dependency}`);
    }
    for (const team of record.owners) {
      if (!registry.value.teams.includes(team)) failures.push(`${moduleId}: unregistered owner ${team}`);
    }
    const workStates = {};
    for (const workId of [...record.workItemIds].sort()) {
      const item = work.value.items[workId];
      if (!item) failures.push(`${moduleId}: unknown work item ${workId}`);
      else workStates[workId] = item.state;
    }
    const contractRefs = record.paths.filter((value) => value.endsWith('.md') || value.endsWith('.json'));
    projection[moduleId] = {
      staticImplementationState: record.state, staticActivation: record.activation,
      codeRoots: record.paths.filter((value) => !contractRefs.includes(value)), contractRefs,
      referencedWorkStates: workStates,
      pendingSourceWorkItemIds: Object.keys(workStates).filter((id) => ['not_started', 'design_ready'].includes(workStates[id])),
      blockedExternalWorkItemIds: Object.keys(workStates).filter((id) => workStates[id] === 'blocked_external'),
      effectiveQualification: 'not_evaluated', productionActivationVerified: false,
    };
  }
  const actualSpecs = listFiles(root, 'docs/modules/specs', '.md', failures);
  const actualManifests = listFiles(root, 'docs/modules/manifests', '.json', failures);
  for (const file of actualSpecs) if (!seenSpecs.has(file)) failures.push(`orphan module specification ${file}`);
  for (const file of actualManifests) if (!seenManifests.has(file)) failures.push(`orphan module manifest ${file}`);
  for (const file of seenSpecs) if (!actualSpecs.includes(file)) failures.push(`indexed specification not present ${file}`);
  for (const file of seenManifests) if (!actualManifests.includes(file)) failures.push(`indexed manifest not present ${file}`);
  report.specifications = actualSpecs.length;
  report.manifests = actualManifests.length;
  report.implementationProjection = {
    kind: 'ModuleImplementationDocumentationProjectionV1',
    sourceRecordSha256: Object.fromEntries([[REGISTRY_PATH, registry.source], [INDEX_PATH, index.source], [WORK_PATH, work.source]]
      .map(([name, source]) => [name, `sha256:${createHash('sha256').update(source).digest('hex')}`])),
    // Code roots are bindings, not a claim that all code is implemented or tested.
    coverageMeaning: 'structural_documentation_only', modules: projection,
  };
  return finish();
}

function main() {
  const { root, json } = parseArguments(process.argv.slice(2));
  const result = validateModuleDocumentation({ root });
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.ok) process.stdout.write(`module_documentation_ready modules=${result.report.registryModules} specs=${result.report.specifications} manifests=${result.report.manifests} sections=${result.report.requiredSections}\n`);
  else for (const failure of result.failures) process.stderr.write(`module-docs: ${failure}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) main();

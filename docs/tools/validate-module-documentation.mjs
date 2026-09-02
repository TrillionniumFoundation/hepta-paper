#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../..');

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
    } else if (value === '--json') {
      json = true;
    } else {
      throw new Error(`unknown argument ${value}`);
    }
  }
  return { root, json };
}

function normalize(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function readJson(root, relative, failures) {
  const absolute = path.resolve(root, relative);
  if (!inside(root, absolute)) {
    failures.push(`${relative}: path escapes repository`);
    return {};
  }
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      failures.push(`${relative}: expected canonical regular file`);
      return {};
    }
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    failures.push(`${relative}: ${error.message}`);
    return {};
  }
}

function readText(root, relative, failures) {
  const absolute = path.resolve(root, relative);
  if (!inside(root, absolute)) {
    failures.push(`${relative}: path escapes repository`);
    return '';
  }
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      failures.push(`${relative}: expected canonical regular file`);
      return '';
    }
    return fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    failures.push(`${relative}: ${error.message}`);
    return '';
  }
}

function sameSet(left, right) {
  return JSON.stringify([...(left || [])].sort()) === JSON.stringify([...(right || [])].sort());
}

function listFiles(root, relative, suffix, failures) {
  const absolute = path.resolve(root, relative);
  if (!inside(root, absolute)) {
    failures.push(`${relative}: directory escapes repository`);
    return [];
  }
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      failures.push(`${relative}: expected canonical directory`);
      return [];
    }
    return fs.readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(suffix))
      .map((entry) => normalize(path.join(relative, entry.name)))
      .sort();
  } catch (error) {
    failures.push(`${relative}: ${error.message}`);
    return [];
  }
}

function ensureImplementationPath(root, moduleId, configuredPath, failures) {
  const absolute = path.resolve(root, configuredPath);
  if (!inside(root, absolute) || !fs.existsSync(absolute)) {
    failures.push(`${moduleId}: missing implementation/contract path ${configuredPath}`);
    return;
  }
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) failures.push(`${moduleId}: symbolic implementation path ${configuredPath}`);
}

function validateAuthorityLanguage(moduleId, authority, source, failures) {
  const required = {
    pure: ['no durable state', 'cannot grant'],
    read_only: ['read only', 'cannot mutate'],
    prepared_result_only: ['prepared result', 'commit sequencer'],
    central_state_write: ['single-writer', 'fencing'],
    external_effect: ['durable intent', 'idempotency', 'reconciliation', 'human']
  }[authority] || [];
  const lower = source.toLowerCase();
  for (const term of required) {
    if (!lower.includes(term)) failures.push(`${moduleId}: specification missing authority term "${term}"`);
  }
}

export function validateModuleDocumentation(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const failures = [];
  const registryPath = 'docs/system/truth/modules.v1.json';
  const indexPath = 'docs/modules/module-documentation.v1.json';
  const registry = readJson(root, registryPath, failures);
  const index = readJson(root, indexPath, failures);
  const moduleRecords = registry.modules || {};
  const documented = index.modules || {};
  const requiredSections = index.requiredSections || [];

  if (registry.schemaVersion !== 1) failures.push(`${registryPath}: unsupported schemaVersion`);
  if (index.schemaVersion !== 1 || index.kind !== 'ModuleDocumentationIndexV1') failures.push(`${indexPath}: invalid identity`);
  if (index.registryPath !== registryPath) failures.push(`${indexPath}: registryPath mismatch`);
  if (!Array.isArray(requiredSections) || requiredSections.length < 15 || new Set(requiredSections).size !== requiredSections.length) failures.push(`${indexPath}: requiredSections must contain at least 15 unique headings`);

  const registryIds = Object.keys(moduleRecords).sort();
  const documentedIds = Object.keys(documented).sort();
  if (JSON.stringify(registryIds) !== JSON.stringify(documentedIds)) failures.push(`module set mismatch: registry=${registryIds.length} documentation=${documentedIds.length}`);

  const seenSpecs = new Set();
  const seenManifests = new Set();

  for (const moduleId of registryIds) {
    const record = moduleRecords[moduleId];
    const entry = documented[moduleId];
    if (!entry) continue;
    if (entry.documentationStatus !== 'complete') failures.push(`${moduleId}: documentationStatus is not complete`);
    for (const [field, seen] of [['specPath', seenSpecs], ['manifestPath', seenManifests]]) {
      const value = entry[field];
      if (typeof value !== 'string' || !value) {
        failures.push(`${moduleId}: missing ${field}`);
        continue;
      }
      if (seen.has(value)) failures.push(`${moduleId}: duplicate ${field} ${value}`);
      seen.add(value);
    }

    const spec = readText(root, entry.specPath, failures);
    if (!spec) continue;
    if (!spec.includes(`moduleId: ${moduleId}`)) failures.push(`${moduleId}: specification identity mismatch`);
    if (/\b(?:TODO|TBD|PLACEHOLDER|FIXME)\b/i.test(spec)) failures.push(`${moduleId}: specification contains placeholder language`);
    for (const heading of requiredSections) {
      const marker = `## ${heading}`;
      if (!spec.split(/\r?\n/).includes(marker)) failures.push(`${moduleId}: missing heading ${marker}`);
    }
    validateAuthorityLanguage(moduleId, record.authority, spec, failures);

    const manifest = readJson(root, entry.manifestPath, failures);
    if (manifest.schemaVersion !== 1 || manifest.kind !== 'ModuleDocumentationManifestV1') {
      failures.push(`${moduleId}: invalid documentation manifest identity`);
      continue;
    }
    const scalarChecks = {moduleId,specPath:entry.specPath,authorityClass:record.authority,qualificationRequirement:record.qualification,documentationStatus:'complete',effectiveQualification:'derived_only'};
    for (const [field, expected] of Object.entries(scalarChecks)) if (manifest[field] !== expected) failures.push(`${moduleId}: manifest ${field} mismatch`);
    const arrayChecks = {implementationPaths:record.paths,capabilityIds:record.capabilityIds,ownerTeams:record.owners,dependencyModuleIds:record.dependencies,workItemIds:record.workItemIds};
    for (const [field, expected] of Object.entries(arrayChecks)) if (!sameSet(manifest[field], expected)) failures.push(`${moduleId}: manifest ${field} mismatch`);
    if (manifest.registryRef !== `${registryPath}#/modules/${moduleId}`) failures.push(`${moduleId}: registryRef mismatch`);
    if (manifest.protocolRange?.minimum !== 1 || manifest.protocolRange?.maximum !== 1) failures.push(`${moduleId}: invalid protocolRange`);
    if (!Array.isArray(manifest.sideEffectClasses) || manifest.sideEffectClasses.length === 0) failures.push(`${moduleId}: empty sideEffectClasses`);
    if (!['deterministic','seeded','bounded_nondeterministic','external_observation'].includes(manifest.determinismClass)) failures.push(`${moduleId}: invalid determinismClass`);
    if (manifest.rollout?.automaticActivation !== false || manifest.rollout?.productionActivation !== false) failures.push(`${moduleId}: static documentation may not activate production`);
    const runbookPath = String(manifest.runbookPath || '').split('#', 1)[0];
    if (runbookPath !== entry.specPath) failures.push(`${moduleId}: runbookPath must bind its specification`);
    for (const configuredPath of record.paths || []) ensureImplementationPath(root, moduleId, configuredPath, failures);
  }

  const actualSpecs = listFiles(root, 'docs/modules/specs', '.md', failures);
  const actualManifests = listFiles(root, 'docs/modules/manifests', '.json', failures);
  for (const file of actualSpecs) if (!seenSpecs.has(file)) failures.push(`orphan module specification ${file}`);
  for (const file of actualManifests) if (!seenManifests.has(file)) failures.push(`orphan module manifest ${file}`);
  for (const file of seenSpecs) if (!actualSpecs.includes(file)) failures.push(`indexed specification not present ${file}`);
  for (const file of seenManifests) if (!actualManifests.includes(file)) failures.push(`indexed manifest not present ${file}`);

  return {ok:failures.length===0,failures,report:{registryModules:registryIds.length,documentedModules:documentedIds.length,specifications:actualSpecs.length,manifests:actualManifests.length,requiredSections:requiredSections.length}};
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

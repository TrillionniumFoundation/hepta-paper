#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../..');

function parseArguments(argv) {
  const options = { root: DEFAULT_ROOT, base: null, head: null, pathsFile: null, explicitPaths: [], output: null, pretty: true };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--root' || value === '--base' || value === '--head' || value === '--paths-file' || value === '--path' || value === '--output') {
      const supplied = argv[index + 1];
      if (!supplied) throw new Error(`${value} requires a value`);
      if (value === '--root') options.root = path.resolve(supplied);
      else if (value === '--base') options.base = supplied;
      else if (value === '--head') options.head = supplied;
      else if (value === '--paths-file') options.pathsFile = supplied;
      else if (value === '--path') options.explicitPaths.push(supplied);
      else options.output = supplied;
      index += 1;
    } else if (value === '--compact') {
      options.pretty = false;
    } else {
      throw new Error(`unknown argument ${value}`);
    }
  }
  return options;
}

function normalize(value) {
  return String(value).trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function readJson(root, relative, required = true) {
  const absolute = path.resolve(root, relative);
  if (!inside(root, absolute)) throw new Error(`${relative}: path escapes repository`);
  if (!fs.existsSync(absolute)) {
    if (!required) return {};
    throw new Error(`${relative}: missing`);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${relative}: expected canonical regular file`);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function changedPathsFromGit(root, base, head) {
  if (!base || !head) return [];
  const result = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', `${base}...${head}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git diff failed: ${(result.stderr || result.stdout || '').trim()}`);
  return result.stdout.split(/\r?\n/).map(normalize).filter(Boolean);
}

function collectChangedPaths(root, options) {
  const paths = [...options.explicitPaths];
  if (options.pathsFile) {
    const absolute = path.resolve(root, options.pathsFile);
    if (!inside(root, absolute)) throw new Error(`${options.pathsFile}: path escapes repository`);
    paths.push(...fs.readFileSync(absolute, 'utf8').split(/\r?\n/));
  }
  paths.push(...changedPathsFromGit(root, options.base, options.head));
  return [...new Set(paths.map(normalize).filter(Boolean))].sort();
}

function pathTouches(changed, configured) {
  const left = normalize(changed);
  const right = normalize(configured);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function sorted(values) {
  return [...new Set(values)].sort();
}

function listField(record, names) {
  for (const name of names) if (Array.isArray(record?.[name])) return record[name];
  return [];
}

export function generateChangeImpact(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const changedPaths = options.changedPaths ? sorted(options.changedPaths.map(normalize).filter(Boolean)) : collectChangedPaths(root, options);
  const modulesTruth = readJson(root, 'docs/system/truth/modules.v1.json');
  const capabilitiesTruth = readJson(root, 'docs/system/truth/capabilities.v1.json');
  const workTruth = readJson(root, 'docs/system/truth/work-items.v2.json');
  const milestonesTruth = readJson(root, 'docs/system/truth/milestones.v1.json');
  const risksTruth = readJson(root, 'docs/system/truth/risks.v2.json');
  const evidenceTruth = readJson(root, 'docs/system/truth/evidence-bindings.v1.json');
  const workloadsTruth = readJson(root, 'docs/system/truth/canonical-workloads.v1.json');
  const moduleDocs = readJson(root, 'docs/modules/module-documentation.v1.json', false);

  const modules = modulesTruth.modules || {};
  const capabilities = capabilitiesTruth.capabilities || {};
  const workItems = workTruth.items || {};
  const milestones = milestonesTruth.milestones || {};
  const risks = risksTruth.risks || {};
  const bindings = evidenceTruth.bindings || {};
  const workloads = new Map((workloadsTruth.workloads || []).map((item) => [item.workloadId, item]));

  const globalModuleContractPaths = [
    'docs/system/truth/modules.v1.json',
    'docs/system/schemas/modules-v1.schema.json',
    'docs/modules/MODULE_MODEL.md',
    'docs/modules/MODULE_PROTOCOL.md',
    'docs/modules/MODULE_REGISTRY.md',
    'docs/modules/MODULE_LIFECYCLE.md',
    'docs/modules/MODULE_CONFORMANCE.md',
    'docs/modules/MODULE_TEMPLATE.md',
    'docs/modules/module-documentation.v1.json',
    'rust/crates/hepta-module-platform',
  ];
  const touchesGlobalModuleContract = changedPaths.some((changed) => globalModuleContractPaths.some((configured) => pathTouches(changed, configured)));

  const changedModuleIds = [];
  for (const [moduleId, record] of Object.entries(modules)) {
    const documentation = moduleDocs.modules?.[moduleId] || {};
    const ownedPaths = [...(record.paths || []), documentation.specPath, documentation.manifestPath].filter(Boolean);
    if (touchesGlobalModuleContract || changedPaths.some((changed) => ownedPaths.some((configured) => pathTouches(changed, configured)))) changedModuleIds.push(moduleId);
  }

  const changedCapabilityIds = [];
  for (const [capabilityId, capability] of Object.entries(capabilities)) {
    if ((capability.moduleIds || []).some((moduleId) => changedModuleIds.includes(moduleId))) changedCapabilityIds.push(capabilityId);
    const binding = bindings[capabilityId] || {};
    const boundPaths = [
      ...listField(binding, ['contractPaths', 'contracts']),
      ...listField(binding, ['implementationPaths', 'implementations']),
      ...listField(binding, ['validationPaths', 'validations']),
    ];
    if (changedPaths.some((changed) => boundPaths.some((configured) => pathTouches(changed, configured)))) changedCapabilityIds.push(capabilityId);
  }

  const changedWorkItemIds = [];
  for (const [workItemId, item] of Object.entries(workItems)) {
    if (changedModuleIds.includes(item.moduleId) || (item.capabilityIds || []).some((id) => changedCapabilityIds.includes(id))) changedWorkItemIds.push(workItemId);
  }

  const changedMilestoneIds = [];
  for (const [milestoneId, milestone] of Object.entries(milestones)) {
    if ((milestone.workItemIds || []).some((id) => changedWorkItemIds.includes(id))) changedMilestoneIds.push(milestoneId);
  }

  const changedRiskIds = [];
  for (const [riskId, risk] of Object.entries(risks)) {
    if ((risk.milestones || []).some((id) => changedMilestoneIds.includes(id))) changedRiskIds.push(riskId);
  }

  const changedEvidenceBindingIds = sorted(changedCapabilityIds.filter((id) => Object.hasOwn(bindings, id)));
  const canonicalWorkloadIds = [];
  const requiredWorkflowContexts = [];
  const externalBlockerIds = [];
  for (const capabilityId of changedEvidenceBindingIds) {
    const binding = bindings[capabilityId];
    canonicalWorkloadIds.push(...listField(binding, ['canonicalWorkloadIds', 'workloadIds']));
    requiredWorkflowContexts.push(...listField(binding, ['requiredSourceContexts', 'workflowContexts', 'sourceWorkflowContexts']));
    externalBlockerIds.push(...listField(binding, ['externalBlockerIds']));
  }

  const authorityConsequences = sorted(changedModuleIds.map((moduleId) => `${moduleId}:${modules[moduleId].authority}`));
  const qualificationInvalidations = sorted(changedModuleIds.map((moduleId) => `${moduleId}:source/deployment evidence must be re-derived for the changed exact subject`));
  const rollbackDisposition = changedModuleIds.length === 0
    ? ['no registered module reached by the changed path set']
    : ['retain incumbent activation until fresh conformance and exact-subject evidence are accepted', 'do not reuse predecessor qualification artifacts', 'authority-bearing changes require an exact rollback target and mutual-exclusion proof'];

  return {
    schemaVersion: 1,
    kind: 'ChangeImpactSummaryV1',
    subject: { base: options.base || null, head: options.head || null },
    changedPaths,
    changedModuleIds: sorted(changedModuleIds),
    changedCapabilityIds: sorted(changedCapabilityIds),
    changedWorkItemIds: sorted(changedWorkItemIds),
    changedMilestoneIds: sorted(changedMilestoneIds),
    changedRiskIds: sorted(changedRiskIds),
    changedEvidenceBindingIds,
    canonicalWorkloadIds: sorted(canonicalWorkloadIds.filter((id) => workloads.has(id))),
    requiredWorkflowContexts: sorted(requiredWorkflowContexts),
    externalBlockerIds: sorted(externalBlockerIds),
    qualificationInvalidations,
    authorityConsequences,
    rollbackDisposition,
    emptyImpact: changedModuleIds.length === 0 && changedCapabilityIds.length === 0,
    grantsAuthority: false,
  };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = generateChangeImpact(options);
  const output = `${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`;
  if (options.output) {
    const absolute = path.resolve(options.root, options.output);
    if (!inside(options.root, absolute)) throw new Error(`${options.output}: output escapes repository`);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, output);
  }
  process.stdout.write(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try { main(); } catch (error) { process.stderr.write(`change-impact: ${error.message}\n`); process.exitCode = 1; }
}

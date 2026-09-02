#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACTIVE_RUNTIME_ROOTS = Object.freeze([
  'workflow-kernel',
  'paper-domain',
  'paper-application',
  'paper-ports',
  'paper-adapters',
  'paper-composition',
  'paper-core',
]);

export const SUPPORT_ROOTS = Object.freeze([
  'migration',
  'numerical-plugins',
  'runtime-images',
  'store',
]);

export const REQUIRED_MODULE_HEADINGS = Object.freeze([
  '## Purpose',
  '## Responsibilities',
  '## Dependencies',
  '## Contracts',
  '## Failure and recovery',
  '## Security',
  '## Testing',
  '## Change rules',
]);

export const REQUIRED_GUIDES = Object.freeze([
  'docs/README.md',
  'docs/documentation-standard.md',
  'docs/module-documentation-matrix.md',
  'docs/architecture/source-of-truth.md',
  'docs/architecture/module-map.md',
  'docs/architecture/dependency-rules.md',
  'docs/architecture/version-and-compatibility.md',
  'docs/contracts/port-semantics.md',
  'docs/workflows/campaign-state-machine.md',
  'docs/science/reproducibility-and-traceability.md',
  'docs/security/threat-model.md',
  'docs/operations/configuration-runtime-and-recovery.md',
  'docs/development/testing-and-change-policy.md',
  'docs/migrations/migration-policy.md',
  'docs/adr/0001-canonical-layering.md',
  'docs/adr/0002-reference-package-boundary.md',
]);

const ROOT_REQUIRED_HEADINGS = Object.freeze([
  '## Canonical architecture',
  '## Requirements and checkout',
  '## Supported command surface',
  '## Development validation',
  '## Runtime and data boundaries',
  '## Documentation map',
  '## Contribution rules',
]);

const MANAGED_DOCUMENTS = Object.freeze([
  'README.md',
  ...ACTIVE_RUNTIME_ROOTS.map((root) => `${root}/README.md`),
  ...SUPPORT_ROOTS.map((root) => `${root}/README.md`),
  ...REQUIRED_GUIDES,
  '.github/pull_request_template.md',
]);

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function readTextFile(workspaceRoot, relativePath) {
  const absolute = path.resolve(workspaceRoot, relativePath);
  if (!pathInside(workspaceRoot, absolute)) {
    throw new Error(`documentation_path_escape:${relativePath}`);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`documentation_not_regular_file:${relativePath}`);
  }
  const bytes = fs.readFileSync(absolute);
  if (bytes.includes(0)) throw new Error(`documentation_binary_file:${relativePath}`);
  return bytes.toString('utf8');
}

function requiredHeadingMissing(text, headings) {
  const lines = new Set(String(text).split(/\r?\n/u).map((line) => line.trim()));
  return headings.filter((heading) => !lines.has(heading));
}

export function inspectMarkdownDocument({
  relativePath,
  text,
  minimumBytes,
  requiredHeadings,
  requiredStatus = null,
}) {
  const blockers = [];
  if (Buffer.byteLength(text, 'utf8') < minimumBytes) {
    blockers.push(`documentation_too_small:${relativePath}`);
  }
  for (const heading of requiredHeadingMissing(text, requiredHeadings)) {
    blockers.push(`documentation_heading_missing:${relativePath}:${heading}`);
  }
  if (requiredStatus && !String(text).split(/\r?\n/u)
    .some((line) => line.trim() === requiredStatus)) {
    blockers.push(`documentation_status_missing:${relativePath}:${requiredStatus}`);
  }
  return Object.freeze(blockers);
}

function markdownTargets(text) {
  const targets = [];
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/gu;
  for (const match of String(text).matchAll(pattern)) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith('<') || /\s["']/u.test(raw)) continue;
    targets.push(raw);
  }
  return Object.freeze(targets);
}

export function inspectLocalMarkdownTarget({
  workspaceRoot,
  sourcePath,
  rawTarget,
}) {
  const target = rawTarget.split('#', 1)[0].split('?', 1)[0];
  if (!target
    || target.startsWith('#')
    || /^(?:https?:|mailto:|tel:)/iu.test(target)) return null;
  let decoded;
  try { decoded = decodeURIComponent(target); }
  catch { return `documentation_link_encoding_invalid:${sourcePath}:${rawTarget}`; }
  const absolute = path.resolve(workspaceRoot, path.dirname(sourcePath), decoded);
  if (!pathInside(workspaceRoot, absolute)) {
    return `documentation_link_escape:${sourcePath}:${rawTarget}`;
  }
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      return `documentation_link_symlink_forbidden:${sourcePath}:${rawTarget}`;
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      return `documentation_link_target_invalid:${sourcePath}:${rawTarget}`;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return `documentation_link_missing:${sourcePath}:${rawTarget}`;
    }
    throw error;
  }
  return null;
}

function inspectPackageMetadata(workspaceRoot) {
  const blockers = [];
  let packageJson;
  try { packageJson = JSON.parse(readTextFile(workspaceRoot, 'package.json')); }
  catch {
    return Object.freeze(['documentation_package_json_invalid']);
  }
  const declared = packageJson.heptaPaper?.activeRuntimeRoots;
  if (JSON.stringify(declared) !== JSON.stringify(ACTIVE_RUNTIME_ROOTS)) {
    blockers.push('documentation_active_runtime_roots_drift');
  }
  const reference = packageJson.heptaPaper?.referencePackages;
  if (!Array.isArray(reference)
    || !reference.some((entry) => entry?.path === 'core'
      && entry?.classification === 'pinned_submodule_reference'
      && entry?.productionImportPolicy === 'forbidden')) {
    blockers.push('documentation_core_reference_policy_missing');
  }
  return Object.freeze(blockers);
}

function inspectSubmodules(workspaceRoot) {
  const blockers = [];
  const text = readTextFile(workspaceRoot, '.gitmodules');
  const paths = [...text.matchAll(/^\s*path\s*=\s*(\S+)\s*$/gmu)].map((match) => match[1]);
  const urls = [...text.matchAll(/^\s*url\s*=\s*(\S+)\s*$/gmu)].map((match) => match[1]);
  if (!paths.includes('core')) blockers.push('documentation_core_submodule_missing');
  if (!paths.includes('runtime-images/r-scientific/source-cas')) {
    blockers.push('documentation_r_source_cas_submodule_missing');
  }
  for (const url of urls) {
    if (!url.startsWith('https://github.com/')) {
      blockers.push(`documentation_submodule_url_not_https:${url}`);
    }
  }
  return Object.freeze(blockers);
}

function inspectCoverageReferences(workspaceRoot) {
  const blockers = [];
  const rootReadme = readTextFile(workspaceRoot, 'README.md');
  const matrix = readTextFile(workspaceRoot, 'docs/module-documentation-matrix.md');
  for (const root of [...ACTIVE_RUNTIME_ROOTS, ...SUPPORT_ROOTS]) {
    if (!rootReadme.includes(`[\`${root}/\`](${root}/)`)) {
      blockers.push(`documentation_root_navigation_missing:${root}`);
    }
    if (!matrix.includes(`\`${root}\``)
      || !matrix.includes(`../${root}/README.md`)) {
      blockers.push(`documentation_matrix_entry_missing:${root}`);
    }
  }
  if (!matrix.includes('`core`')) blockers.push('documentation_matrix_core_reference_missing');
  return Object.freeze(blockers);
}

function inspectReviewAndWorkflow(workspaceRoot) {
  const blockers = [];
  const template = readTextFile(workspaceRoot, '.github/pull_request_template.md');
  if (!template.includes('## Documentation impact')) {
    blockers.push('documentation_pr_checklist_missing');
  }
  const workflow = readTextFile(
    workspaceRoot,
    '.github/workflows/documentation-integrity.yml',
  );
  for (const command of [
    'node paper-core/bin/documentation-integrity.mjs',
    'node --test --test-concurrency=1 paper-core/tests/documentation-integrity.test.mjs',
  ]) {
    if (!workflow.includes(command)) {
      blockers.push(`documentation_workflow_command_missing:${command}`);
    }
  }
  return Object.freeze(blockers);
}

export function inspectDocumentationIntegrity({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);
  const blockers = [];
  const checkedFiles = [];

  const rootReadme = readTextFile(root, 'README.md');
  checkedFiles.push('README.md');
  blockers.push(...inspectMarkdownDocument({
    relativePath: 'README.md',
    text: rootReadme,
    minimumBytes: 4_000,
    requiredHeadings: ROOT_REQUIRED_HEADINGS,
  }));

  for (const moduleRoot of [...ACTIVE_RUNTIME_ROOTS, ...SUPPORT_ROOTS]) {
    const relativePath = `${moduleRoot}/README.md`;
    const text = readTextFile(root, relativePath);
    checkedFiles.push(relativePath);
    blockers.push(...inspectMarkdownDocument({
      relativePath,
      text,
      minimumBytes: 1_500,
      requiredHeadings: REQUIRED_MODULE_HEADINGS,
    }));
  }

  for (const relativePath of REQUIRED_GUIDES) {
    const text = readTextFile(root, relativePath);
    checkedFiles.push(relativePath);
    blockers.push(...inspectMarkdownDocument({
      relativePath,
      text,
      minimumBytes: relativePath.startsWith('docs/adr/') ? 600 : 1_000,
      requiredHeadings: ['## Scope'],
      requiredStatus: 'Status: normative',
    }));
  }

  blockers.push(...inspectPackageMetadata(root));
  blockers.push(...inspectSubmodules(root));
  blockers.push(...inspectCoverageReferences(root));
  blockers.push(...inspectReviewAndWorkflow(root));

  for (const relativePath of MANAGED_DOCUMENTS) {
    const text = readTextFile(root, relativePath);
    for (const rawTarget of markdownTargets(text)) {
      const blocker = inspectLocalMarkdownTarget({
        workspaceRoot: root,
        sourcePath: relativePath,
        rawTarget,
      });
      if (blocker) blockers.push(blocker);
    }
  }

  const uniqueBlockers = Object.freeze([...new Set(blockers)].sort());
  return Object.freeze({
    version: 1,
    kind: 'DocumentationIntegrityReport',
    status: uniqueBlockers.length
      ? 'documentation_integrity_blocked'
      : 'documentation_integrity_ready',
    ready: uniqueBlockers.length === 0,
    activeRuntimeRoots: ACTIVE_RUNTIME_ROOTS,
    supportRoots: SUPPORT_ROOTS,
    checkedFiles: Object.freeze([...new Set(checkedFiles)].sort()),
    blockers: uniqueBlockers,
  });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const workspaceRoot = path.resolve(path.dirname(currentFile), '..', '..');
  let report;
  try {
    report = inspectDocumentationIntegrity({ workspaceRoot });
  } catch (error) {
    report = Object.freeze({
      version: 1,
      kind: 'DocumentationIntegrityReport',
      status: 'documentation_integrity_blocked',
      ready: false,
      activeRuntimeRoots: ACTIVE_RUNTIME_ROOTS,
      supportRoots: SUPPORT_ROOTS,
      checkedFiles: Object.freeze([]),
      blockers: Object.freeze([
        error instanceof Error ? error.message : String(error),
      ]),
    });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 1;
}

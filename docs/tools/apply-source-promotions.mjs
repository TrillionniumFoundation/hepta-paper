#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const WRITE = process.argv.includes('--write');
const EVIDENCE_PATHS = [
  'docs/system/evidence/repository-source-implementation-v1.json',
  'docs/system/evidence/rust-functional-source-closure-v1.json',
];
const WORK_ITEMS_PATH = 'docs/system/truth/work-items.v2.json';
const MODULES_PATH = 'docs/system/truth/modules.v1.json';
const MODULE_INDEX_PATH = 'docs/modules/module-documentation.v1.json';
const MATRIX_PATH = 'docs/modules/MODULE_DOCUMENTATION_MATRIX.md';

function fail(message) {
  throw new Error(`source_promotion_sync_failed:${message}`);
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

function writeText(relative, text) {
  const absolute = path.join(ROOT, relative);
  if (WRITE) fs.writeFileSync(absolute, text, 'utf8');
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function collectPromotions(evidenceDocuments) {
  const promotions = new Set();
  for (const [evidencePath, document] of evidenceDocuments) {
    if (document.kind !== 'RepositorySourceImplementationEvidenceV1') {
      fail(`unexpected_evidence_kind:${evidencePath}`);
    }
    for (const [recordId, record] of Object.entries(document.records ?? {})) {
      if (record.workItemId !== recordId) fail(`record_id_mismatch:${evidencePath}:${recordId}`);
      if (record.promotionRequested === true) promotions.add(recordId);
    }
  }
  if (promotions.size === 0) fail('no_promotions_requested');
  return promotions;
}

function promoteWorkItems(workItems, promotions) {
  for (const id of [...promotions].sort()) {
    const item = workItems.items?.[id];
    if (!item) fail(`unknown_work_item:${id}`);
    if (item.type === 'external_gap' || item.state === 'blocked_external') {
      fail(`external_work_item_forbidden:${id}`);
    }
    if (item.state !== 'design_ready' || item.evidenceTier !== 'design') {
      fail(`promotion_source_state_invalid:${id}:${item.state}:${item.evidenceTier}`);
    }
    item.state = 'source_implemented';
    item.evidenceTier = 'source';
  }
}

function promoteModules(modules, workItems) {
  const promoted = [];
  for (const [moduleId, module] of Object.entries(modules.modules ?? {})) {
    if (module.state !== 'design_ready') continue;
    const states = (module.workItemIds ?? []).map((id) => workItems.items?.[id]?.state ?? 'missing');
    const hasOpenRepositoryDesign = states.some((state) => state === 'design_ready' || state === 'not_started' || state === 'missing');
    if (!hasOpenRepositoryDesign) {
      module.state = 'source_implemented';
      promoted.push(moduleId);
    }
  }
  return promoted.sort();
}

function consumePromotionRequests(evidenceDocuments, promotions) {
  for (const [, document] of evidenceDocuments) {
    for (const record of Object.values(document.records ?? {})) {
      if (promotions.has(record.workItemId)) record.promotionRequested = false;
    }
  }
}

function syncSpecs(modules, moduleIndex, promotions) {
  const changed = [];
  for (const [moduleId, indexEntry] of Object.entries(moduleIndex.modules ?? {})) {
    const module = modules.modules?.[moduleId];
    if (!module) fail(`module_index_orphan:${moduleId}`);
    const specPath = indexEntry.specPath;
    const absolute = path.join(ROOT, specPath);
    let text = fs.readFileSync(absolute, 'utf8');
    const statePattern = /^staticImplementationState: ([a-z_]+)$/m;
    const activationPattern = /^staticActivation: ([a-z_]+)$/m;
    if (!statePattern.test(text)) fail(`spec_state_missing:${moduleId}`);
    if (!activationPattern.test(text)) fail(`spec_activation_missing:${moduleId}`);
    const before = text;
    text = text.replace(statePattern, `staticImplementationState: ${module.state}`);
    text = text.replace(activationPattern, `staticActivation: ${module.activation}`);
    for (const workItemId of module.workItemIds ?? []) {
      if (!promotions.has(workItemId)) continue;
      const blocker = new RegExp(`(\\\`${workItemId}\\\`\\s+—\\s+\\\`)design_ready(\\\`)`, 'g');
      text = text.replace(blocker, '$1source_implemented$2');
    }
    if (text !== before) {
      writeText(specPath, text);
      changed.push(specPath);
    }
  }
  return changed.sort();
}

function moduleLink(indexEntry, key, prefix) {
  const value = indexEntry[key];
  const relative = value.replace(/^docs\/modules\//, '');
  return `[${prefix}](${relative})`;
}

function buildMatrix(modules, moduleIndex) {
  const lines = [
    '# Module documentation matrix',
    '',
    'This matrix is generated from the canonical static module registry and the committed one-to-one documentation index. A `complete` row means the module has a normative specification and machine manifest with all required sections; it does **not** mean the module is target-host qualified, externally authorized, or production activated.',
    '',
    '| Module | Kind | Static state | Activation | Authority | Qualification | Specification | Manifest |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const moduleId of Object.keys(modules.modules ?? {}).sort()) {
    const module = modules.modules[moduleId];
    const indexEntry = moduleIndex.modules?.[moduleId];
    if (!indexEntry) fail(`module_documentation_missing:${moduleId}`);
    lines.push(`| \`${moduleId}\` | \`${module.kind}\` | \`${module.state}\` | \`${module.activation}\` | \`${module.authority}\` | \`${module.qualification}\` | ${moduleLink(indexEntry, 'specPath', 'spec')} | ${moduleLink(indexEntry, 'manifestPath', 'manifest')} |`);
  }
  lines.push(
    '',
    'Validate with:',
    '',
    '```bash',
    'node docs/tools/validate-module-documentation.mjs',
    '```',
    '',
    'The validator fails on missing/orphan specifications or manifests, registry drift, missing required headings, placeholder language, missing implementation roots, and absent authority-specific safety contracts.',
    '',
  );
  return lines.join('\n');
}

function main() {
  const evidenceDocuments = EVIDENCE_PATHS.map((relative) => [relative, readJson(relative)]);
  const workItems = readJson(WORK_ITEMS_PATH);
  const modules = readJson(MODULES_PATH);
  const moduleIndex = readJson(MODULE_INDEX_PATH);
  const promotions = collectPromotions(evidenceDocuments);

  promoteWorkItems(workItems, promotions);
  const promotedModules = promoteModules(modules, workItems);
  consumePromotionRequests(evidenceDocuments, promotions);

  writeText(WORK_ITEMS_PATH, jsonText(workItems));
  writeText(MODULES_PATH, jsonText(modules));
  for (const [relative, document] of evidenceDocuments) writeText(relative, jsonText(document));
  const changedSpecs = syncSpecs(modules, moduleIndex, promotions);
  writeText(MATRIX_PATH, buildMatrix(modules, moduleIndex));

  const result = {
    kind: 'SourcePromotionSyncV1',
    promotionCount: promotions.size,
    promotions: [...promotions].sort(),
    promotedModules,
    changedSpecs,
    write: WRITE,
    authorityClaims: {
      productionActivated: false,
      targetHostQualified: false,
      externalAuthorityGranted: false,
      writerCutoverAuthorized: false,
      nodeRetirementAuthorized: false,
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();

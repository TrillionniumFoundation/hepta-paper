#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './hash-utils.mjs';
import {
  CORE_MODEL_INDUSTRIES,
} from './llm-design-reference-resolver.mjs';
import {
  INDUSTRY_DEFS,
  INDUSTRY_TAXONOMY_VERSION,
} from './industry-taxonomy-contracts.mjs';

export const DESIGN_REFERENCE_TAXONOMY_SYNC_GATE_VERSION = 1;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(packageRoot, '..');

function unique(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function difference(left = [], right = []) {
  const rightSet = new Set(right || []);
  return unique(left).filter((item) => !rightSet.has(item));
}

function duplicates(values = []) {
  const seen = new Set();
  const dupes = new Set();
  for (const value of values || []) {
    if (!value) continue;
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

function readText(filePath, blockers = []) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    blockers.push({
      code: 'zbj_reference_snapshot_source_read_failed',
      filePath,
      notes: error?.message || String(error),
    });
    return '';
  }
}

function parseConstNumber(source = '', name = '') {
  const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*([0-9]+)`));
  return match ? Number(match[1]) : null;
}

function parseZbjIndustries(source = '') {
  const industries = [];
  const seen = new Set();
  const itemRe = /\{\s*id:\s*['"]([a-z0-9_]+)['"]\s*,\s*label:\s*['"]([^'"]*)['"]\s*,\s*domain:\s*['"]([^'"]*)['"]/g;
  let match = itemRe.exec(source);
  while (match) {
    const [, id, label, domain] = match;
    if (!seen.has(id)) {
      industries.push({ id, label: label || null, domain: domain || null });
      seen.add(id);
    }
    match = itemRe.exec(source);
  }
  return industries;
}

function isCoreIndustryTaxonomyShim(source = '') {
  return /\bfrom\s*['"]design-production-core['"]/.test(source)
    && /\b(?:INDUSTRY_DEFS|listIndustries|classifyIndustry|modelIndustrySpecFromSemanticIntake)\b/.test(source);
}

function coreIndustrySnapshot() {
  return INDUSTRY_DEFS.map((item) => ({
    id: item.id,
    label: item.label || null,
    domain: item.domain || null,
  }));
}

function parseRegistryPacks(source = '') {
  const packs = [];
  const seen = new Set();
  const packRe = /\{\s*id:\s*['"](refpack_[^'"]+)['"]\s*,\s*industryId:\s*['"]([a-z0-9_]+)['"]\s*,\s*label:\s*['"]([^'"]*)['"]/g;
  let match = packRe.exec(source);
  while (match) {
    const [, id, industryId, label] = match;
    const key = `${id}:${industryId}`;
    if (!seen.has(key)) {
      packs.push({ id, industryId, label: label || null, source: 'registry.mjs' });
      seen.add(key);
    }
    match = packRe.exec(source);
  }
  return packs;
}

function normalizeExternalPackEntries(payload = null) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.packs)) return payload.packs;
  if (payload.packs && typeof payload.packs === 'object') return Object.values(payload.packs);
  if (payload.id && payload.industryId) return [payload];
  return [];
}

function loadExternalPackJsonFiles({ packsDir, blockers }) {
  const dirs = [packsDir, path.join(packsDir, 'external')];
  const files = [];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      blockers.push({
        code: 'zbj_reference_snapshot_external_pack_dir_read_failed',
        filePath: dir,
        notes: error?.message || String(error),
      });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.json$/i.test(entry.name)) continue;
      files.push(path.join(dir, entry.name));
    }
  }
  return [...new Set(files)].sort();
}

function parseExternalJsonPacks({ packsDir, blockers }) {
  const packs = [];
  for (const filePath of loadExternalPackJsonFiles({ packsDir, blockers })) {
    let payload = null;
    try {
      payload = JSON.parse(readText(filePath, blockers) || '{}');
    } catch (error) {
      blockers.push({
        code: 'zbj_reference_snapshot_external_pack_json_invalid',
        filePath,
        notes: error?.message || String(error),
      });
      continue;
    }
    for (const entry of normalizeExternalPackEntries(payload)) {
      if (!entry?.id || !entry?.industryId) {
        blockers.push({
          code: 'zbj_reference_snapshot_external_pack_entry_invalid',
          filePath,
        });
        continue;
      }
      packs.push({
        id: String(entry.id),
        industryId: String(entry.industryId),
        label: entry.label ? String(entry.label) : null,
        source: path.relative(packsDir, filePath) || path.basename(filePath),
      });
    }
  }
  return packs;
}

function loadZbjReferenceSnapshot({ workspaceDir = workspaceRoot } = {}) {
  const blockers = [];
  const taxonomyModule = path.join(workspaceDir, 'zbj-auto-intake/src/core/industry-taxonomy.mjs');
  const packsDir = path.join(workspaceDir, 'zbj-auto-intake/src/hepta-design/packs');
  const registryModule = path.join(packsDir, 'registry.mjs');
  const taxonomySource = readText(taxonomyModule, blockers);
  const registrySource = readText(registryModule, blockers);
  const parsedIndustries = parseZbjIndustries(taxonomySource);
  const coreTaxonomyShim = !parsedIndustries.length && isCoreIndustryTaxonomyShim(taxonomySource);
  const industries = parsedIndustries.length ? parsedIndustries : (coreTaxonomyShim ? coreIndustrySnapshot() : []);
  const packs = [
    ...parseRegistryPacks(registrySource),
    ...parseExternalJsonPacks({ packsDir, blockers }),
  ];
  if (!industries.length) {
    blockers.push({ code: 'zbj_reference_snapshot_taxonomy_empty', filePath: taxonomyModule });
  }
  if (!packs.length) {
    blockers.push({ code: 'zbj_reference_snapshot_refpacks_empty', filePath: registryModule });
  }
  const snapshot = {
    ok: blockers.length === 0,
    taxonomyAuthority: coreTaxonomyShim ? 'design-production-core' : 'zbj-source',
    taxonomyVersion: parseConstNumber(taxonomySource, 'INDUSTRY_TAXONOMY_VERSION')
      ?? (coreTaxonomyShim ? INDUSTRY_TAXONOMY_VERSION : null),
    registryVersion: parseConstNumber(registrySource, 'DESIGN_REFERENCE_PACK_VERSION'),
    industries,
    packs,
  };
  return {
    ok: blockers.length === 0,
    snapshot,
    blockers,
  };
}

export function buildDesignReferenceTaxonomySyncGate({
  generatedAt = new Date().toISOString(),
  coreIndustries = CORE_MODEL_INDUSTRIES,
  workspaceDir = workspaceRoot,
} = {}) {
  const coreIds = unique((coreIndustries || []).map((item) => item.id));
  const coreDomains = Object.fromEntries((coreIndustries || []).map((item) => [item.id, item.domain || null]));
  const zbj = loadZbjReferenceSnapshot({ workspaceDir });
  const zbjIndustries = zbj.snapshot.industries || [];
  const zbjPacks = zbj.snapshot.packs || [];
  const zbjIndustryIds = unique(zbjIndustries.map((item) => item.id));
  const packIndustryIds = unique(zbjPacks.map((item) => item.industryId));
  const packIds = unique(zbjPacks.map((item) => item.id));
  const requiredSentinelPacks = Object.freeze({
    general_technology_b2b: 'refpack_general_technology_b2b_v1',
    ceramic_decal_character_design: 'refpack_ceramic_decal_character_v1',
  });
  const blockers = [
    ...zbj.blockers,
    ...duplicates(coreIds).map((id) => ({ code: 'core_model_industry_duplicate', industryId: id })),
    ...duplicates(zbjIndustries.map((item) => item.id)).map((id) => ({ code: 'zbj_industry_duplicate', industryId: id })),
    ...duplicates(zbjPacks.map((item) => item.id)).map((id) => ({ code: 'zbj_refpack_duplicate', refpackId: id })),
    ...difference(zbjIndustryIds, coreIds).map((id) => ({ code: 'core_model_industry_missing_zbj_taxonomy_id', industryId: id })),
    ...difference(coreIds, zbjIndustryIds).map((id) => ({ code: 'core_model_industry_not_in_zbj_taxonomy', industryId: id })),
    ...difference(zbjIndustryIds, packIndustryIds).map((id) => ({ code: 'zbj_taxonomy_industry_missing_refpack', industryId: id })),
    ...difference(packIndustryIds, zbjIndustryIds).map((id) => ({ code: 'zbj_refpack_industry_not_in_taxonomy', industryId: id })),
  ];
  for (const [industryId, refpackId] of Object.entries(requiredSentinelPacks)) {
    if (!zbjIndustryIds.includes(industryId)) {
      blockers.push({ code: 'sentinel_industry_missing_from_zbj_taxonomy', industryId });
    }
    if (!coreIds.includes(industryId)) {
      blockers.push({ code: 'sentinel_industry_missing_from_core_model_taxonomy', industryId });
    }
    if (!packIds.includes(refpackId)) {
      blockers.push({ code: 'sentinel_refpack_missing_from_zbj_registry', industryId, refpackId });
    }
  }
  const warnings = [];
  for (const item of zbjIndustries) {
    const coreDomain = coreDomains[item.id] || null;
    if (coreDomain && item.domain && coreDomain !== item.domain) {
      warnings.push({
        code: 'core_zbj_industry_domain_label_differs',
        industryId: item.id,
        coreDomain,
        zbjDomain: item.domain,
      });
    }
  }
  const report = {
    version: DESIGN_REFERENCE_TAXONOMY_SYNC_GATE_VERSION,
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked_design_reference_taxonomy_sync_gate' : 'pass_design_reference_taxonomy_sync_gate',
    generatedAt,
    summary: {
      coreIndustryCount: coreIds.length,
      zbjIndustryCount: zbjIndustryIds.length,
      zbjRefpackCount: packIds.length,
      missingInCoreCount: blockers.filter((item) => item.code === 'core_model_industry_missing_zbj_taxonomy_id').length,
      missingInZbjCount: blockers.filter((item) => item.code === 'core_model_industry_not_in_zbj_taxonomy').length,
      taxonomyIndustryMissingRefpackCount: blockers.filter((item) => item.code === 'zbj_taxonomy_industry_missing_refpack').length,
      refpackIndustryNotInTaxonomyCount: blockers.filter((item) => item.code === 'zbj_refpack_industry_not_in_taxonomy').length,
      warningCount: warnings.length,
    },
    sources: {
      core: {
        module: 'src/llm-design-reference-resolver.mjs',
        industryIds: coreIds,
      },
      zbj: {
        taxonomyModule: '../zbj-auto-intake/src/core/industry-taxonomy.mjs',
        registryModule: '../zbj-auto-intake/src/hepta-design/packs/registry.mjs',
        externalPackSource: '../zbj-auto-intake/src/hepta-design/packs/*.json',
        taxonomyAuthority: zbj.snapshot.taxonomyAuthority || 'zbj-source',
        taxonomyVersion: zbj.snapshot.taxonomyVersion || null,
        registryVersion: zbj.snapshot.registryVersion || null,
        industryIds: zbjIndustryIds,
        refpackIds: packIds,
      },
    },
    requiredSentinelPacks,
    blockers,
    warnings,
    safety: {
      localOnly: true,
      readsSiblingSourceOnly: true,
      executesExternalAction: false,
      callsProvider: false,
      callsModel: false,
      opensBrowser: false,
      uploads: false,
      submits: false,
      sendsMessage: false,
      pays: false,
      acceptsDelivery: false,
      deploys: false,
      grantsExecutionPermission: false,
    },
  };
  return {
    ...report,
    taxonomySyncGateHash: digest({
      version: report.version,
      status: report.status,
      summary: report.summary,
      sources: report.sources,
      requiredSentinelPacks: report.requiredSentinelPacks,
      blockers: report.blockers,
      warnings: report.warnings,
      safety: report.safety,
    }),
  };
}

if (isCliEntrypoint(import.meta.url)) {
  const report = buildDesignReferenceTaxonomySyncGate();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    throw new Error(report.status);
  }
}

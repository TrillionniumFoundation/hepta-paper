import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './hash-utils.mjs';

export const CHANNEL_IMPORT_ALLOWLIST_VERSION = 2;

export const CHANNEL_IMPORT_ALLOWLIST_STABLE_MODULE_ID = 'channel-import-allowlist';

export const CHANNEL_IMPORT_ALLOWLIST_REPORT_FILE_ID = 'channel-import-allowlist-latest.json';

export const CHANNEL_IMPORT_ALLOWLIST_TARGETS = Object.freeze([
  Object.freeze({
    channelId: 'zbj',
    label: 'ZBJ',
    roots: Object.freeze(['zbj-auto-intake']),
    runtimeRoots: Object.freeze(['src', 'scripts', 'package.json']),
    allowPackageRoot: true,
    allowedCoreModuleIds: Object.freeze([
      'contracts',
      'design-reference-adapter',
      'execution-gates',
      'external-action-lifecycle',
      'hash-utils',
      'migration-shims',
    ]),
  }),
  Object.freeze({
    channelId: 'epwk',
    label: 'EPWK',
    roots: Object.freeze(['epwk-auto-intake']),
    runtimeRoots: Object.freeze(['src', 'scripts', 'package.json']),
    allowPackageRoot: true,
    allowedCoreModuleIds: Object.freeze([
      'action-manifest',
      'buyer-asset-package',
      'contracts',
      'execution-gates',
      'external-action-lifecycle',
      'llm-design-reference-resolver',
      'migration-shims',
      'state-machine',
    ]),
  }),
  Object.freeze({
    channelId: 'hepta',
    label: 'Hepta',
    roots: Object.freeze(['skills/hepta_design', 'work/hepta-brand-kit', '.cache/hepta_design', 'tmp-hepta-review']),
    runtimeRoots: Object.freeze(['src', 'scripts', 'package.json', 'SKILL.md']),
    allowPackageRoot: true,
    allowedCoreModuleIds: Object.freeze([
      'action-manifest',
      'buyer-asset-package',
      'contracts',
      'design-reference-contracts',
      'execution-gates',
      'external-action-lifecycle',
      'hash-utils',
      'migration-shims',
    ]),
  }),
]);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(packageRoot, '..');

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function relative(filePath) {
  return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
}

function shouldSkipDir(name) {
  return ['node_modules', '.git', 'tmp', '.next', 'dist', 'reports'].includes(name);
}

function walkFiles(rootPath, limit = 20000) {
  const out = [];
  function walk(current) {
    if (out.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) walk(fullPath);
        continue;
      }
      if (entry.isFile()) out.push(fullPath);
    }
  }
  if (fs.existsSync(rootPath)) {
    const stat = fs.statSync(rootPath);
    if (stat.isFile()) return [rootPath];
    walk(rootPath);
  }
  return out;
}

function modulesFromIndexExport(exportName) {
  const indexText = readText(path.join(packageRoot, 'src', 'index.mjs'));
  const match = indexText.match(new RegExp(`${exportName}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!match) return [];
  const modules = [];
  const itemRegex = /'([^']+)'/g;
  let item = itemRegex.exec(match[1]);
  while (item) {
    modules.push(item[1]);
    item = itemRegex.exec(match[1]);
  }
  return modules;
}

function normalizeCoreModuleName(moduleName) {
  return String(moduleName || '')
    .replace(/\\/g, '/')
    .replace(/\.mjs$/, '')
    .replace(/\/index$/, '');
}

function lineForIndex(text, index) {
  return text.slice(0, index).split('\n').length;
}

function addSpecifier(out, seen, source, syntax, match) {
  const specifier = match[1];
  const line = lineForIndex(source.text, match.index);
  const key = `${source.file}:${line}:${specifier}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({
    syntax,
    specifier,
    line,
    file: source.file,
    absoluteFile: source.absolutePath,
  });
}

function extractImportSpecifiers(source) {
  const out = [];
  const seen = new Set();
  const patterns = [
    ['static_from', /\b(?:import|export)\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g],
    ['side_effect_import', /\bimport\s+['"]([^'"]+)['"]/g],
    ['dynamic_import', /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g],
    ['commonjs_require', /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g],
  ];
  for (const [syntax, regex] of patterns) {
    let match = regex.exec(source.text);
    while (match) {
      addSpecifier(out, seen, source, syntax, match);
      match = regex.exec(source.text);
    }
  }
  return out;
}

function classifyCoreSpecifier(specifier, absoluteFile) {
  if (specifier === 'design-production-core') {
    return {
      coreImport: true,
      specifierKind: 'package_root',
      moduleId: null,
      modulePath: null,
    };
  }
  if (specifier === 'design-production-core/package.json') {
    return {
      coreImport: true,
      specifierKind: 'package_metadata',
      moduleId: 'package.json',
      modulePath: 'package.json',
    };
  }
  if (specifier.startsWith('design-production-core/src/')) {
    const modulePath = specifier.slice('design-production-core/src/'.length);
    return {
      coreImport: true,
      specifierKind: 'package_deep_src',
      moduleId: normalizeCoreModuleName(modulePath),
      modulePath,
    };
  }
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const resolved = path.resolve(path.dirname(absoluteFile), specifier);
    const coreSrcRoot = path.join(packageRoot, 'src');
    const relativeToCoreSrc = path.relative(coreSrcRoot, resolved).replace(/\\/g, '/');
    if (relativeToCoreSrc && !relativeToCoreSrc.startsWith('..') && !path.isAbsolute(relativeToCoreSrc)) {
      return {
        coreImport: true,
        specifierKind: 'relative_core_src',
        moduleId: normalizeCoreModuleName(relativeToCoreSrc),
        modulePath: relativeToCoreSrc,
      };
    }
  }
  if (specifier.includes('design-production-core/src/')) {
    const modulePath = specifier.split('design-production-core/src/').pop();
    return {
      coreImport: true,
      specifierKind: 'text_core_src',
      moduleId: normalizeCoreModuleName(modulePath),
      modulePath,
    };
  }
  return {
    coreImport: false,
    specifierKind: 'other',
    moduleId: null,
    modulePath: null,
  };
}

function fileRecordsFromFixture(target, fileRecordsByChannel = {}) {
  const records = fileRecordsByChannel[target.channelId];
  if (!records) return null;
  return records.map((record) => {
    const file = String(record.file || `${target.roots[0]}/src/fixture.mjs`);
    const absolutePath = path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
    return {
      file: path.isAbsolute(file) ? relative(file) : file.replace(/\\/g, '/'),
      absolutePath,
      text: String(record.text || ''),
    };
  });
}

function scanTargetFiles(target, fileRecordsByChannel = null) {
  const fixtureRecords = fileRecordsByChannel ? fileRecordsFromFixture(target, fileRecordsByChannel) : null;
  if (fixtureRecords) return fixtureRecords;
  const files = [];
  for (const root of target.roots) {
    const absoluteRoot = path.join(workspaceRoot, root);
    if (!fs.existsSync(absoluteRoot)) continue;
    for (const runtimeRoot of target.runtimeRoots) {
      files.push(...walkFiles(path.join(absoluteRoot, runtimeRoot)));
    }
  }
  return [...new Set(files)]
    .filter((filePath) => /\.(mjs|js|ts|tsx|jsx|json|md)$/.test(filePath))
    .sort((left, right) => left.localeCompare(right))
    .map((filePath) => ({
      file: relative(filePath),
      absolutePath: filePath,
      text: readText(filePath),
    }));
}

function classifyImport({ target, specifierRecord, publicModules, compatibilityModules }) {
  const specifier = classifyCoreSpecifier(specifierRecord.specifier, specifierRecord.absoluteFile);
  if (!specifier.coreImport) return null;
  const publicSet = new Set(publicModules);
  const compatibilitySet = new Set(compatibilityModules);
  const allowedModuleSet = new Set(target.allowedCoreModuleIds || []);
  const moduleStability = !specifier.moduleId
    ? 'public_root'
    : publicSet.has(specifier.moduleId)
      ? 'stable'
      : compatibilitySet.has(specifier.moduleId)
        ? 'compatibility'
        : 'internal';
  const allowedByModule = !specifier.moduleId || allowedModuleSet.has(specifier.moduleId);
  const blockers = [];
  if (specifier.specifierKind === 'package_root') {
    if (!target.allowPackageRoot) {
      blockers.push({
        code: 'channel_package_root_import_not_allowed',
        notes: `${target.channelId} is not configured to import design-production-core by package root.`,
      });
    }
  } else if (specifier.specifierKind === 'package_metadata') {
    blockers.push({
      code: 'channel_package_metadata_import_not_allowed',
      notes: `${target.channelId} should not depend on design-production-core/package.json at runtime.`,
    });
  } else if (specifier.specifierKind === 'package_deep_src') {
    blockers.push({
      code: 'channel_package_deep_src_import_forbidden',
      notes: `${target.channelId} imports ${specifierRecord.specifier}; package deep src imports bypass the stable root surface and must stay blocked by package exports.`,
    });
  } else if (specifier.specifierKind === 'text_core_src') {
    blockers.push({
      code: 'channel_core_src_text_import_unresolved',
      notes: `${target.channelId} has a core src import-like specifier that could not be resolved as a local relative import.`,
    });
  }
  if (specifier.specifierKind === 'relative_core_src') {
    blockers.push({
      code: 'channel_relative_core_src_import_forbidden_after_package_root_migration',
      notes: `${target.channelId} imports ${specifier.moduleId || 'unknown'} through a sibling design-production-core/src path; channel runtime imports must use the design-production-core package root after the package-root migration.`,
    });
  }
  if (specifier.specifierKind === 'relative_core_src' && moduleStability !== 'stable') {
    blockers.push({
      code: 'channel_relative_core_src_import_not_stable',
      notes: `${target.channelId} imports ${specifier.moduleId || 'unknown'} from core src, but that module is ${moduleStability}.`,
    });
  } else if (specifier.specifierKind === 'relative_core_src' && !allowedByModule) {
    blockers.push({
      code: 'channel_relative_core_src_import_not_in_allowlist',
      notes: `${target.channelId} imports stable module ${specifier.moduleId}, but that module is not in the channel allowlist.`,
    });
  }
  return {
    channelId: target.channelId,
    file: specifierRecord.file,
    line: specifierRecord.line,
    syntax: specifierRecord.syntax,
    specifier: specifierRecord.specifier,
    specifierKind: specifier.specifierKind,
    moduleId: specifier.moduleId,
    modulePath: specifier.modulePath,
    moduleStability,
    allowedByModule,
    ok: blockers.length === 0,
    blockers,
  };
}

function auditTarget({ target, publicModules, compatibilityModules, fileRecordsByChannel }) {
  const files = scanTargetFiles(target, fileRecordsByChannel);
  const importRows = files
    .flatMap(extractImportSpecifiers)
    .map((specifierRecord) => classifyImport({
      target,
      specifierRecord,
      publicModules,
      compatibilityModules,
    }))
    .filter(Boolean)
    .sort((left, right) => `${left.file}:${left.line}:${left.specifier}`.localeCompare(`${right.file}:${right.line}:${right.specifier}`));
  const blockers = [
    ...(!importRows.length ? [{
      code: 'channel_core_imports_absent',
      notes: `${target.channelId} has no runtime imports from design-production-core in the scanned roots.`,
    }] : []),
    ...importRows.flatMap((row) => row.blockers.map((item) => ({
      ...item,
      file: row.file,
      line: row.line,
      moduleId: row.moduleId,
      specifier: row.specifier,
    }))),
  ];
  const bySpecifierKind = Object.fromEntries(
    [...new Set(importRows.map((row) => row.specifierKind))]
      .sort()
      .map((kind) => [kind, importRows.filter((row) => row.specifierKind === kind).length]),
  );
  return {
    channelId: target.channelId,
    label: target.label,
    status: blockers.length ? 'blocked_channel_import_allowlist' : 'pass_channel_import_allowlist',
    ok: blockers.length === 0,
    roots: target.roots.map((root) => ({
      path: root,
      exists: fs.existsSync(path.join(workspaceRoot, root)) || Boolean(fileRecordsByChannel?.[target.channelId]),
    })),
    runtimeRoots: [...target.runtimeRoots],
    allowPackageRoot: target.allowPackageRoot === true,
    allowedCoreModuleIds: [...target.allowedCoreModuleIds],
    scannedFileCount: files.length,
    importCount: importRows.length,
    stableRelativeImportCount: importRows.filter((row) => (
      row.specifierKind === 'relative_core_src' && row.moduleStability === 'stable'
    )).length,
    packageRootImportCount: importRows.filter((row) => row.specifierKind === 'package_root').length,
    packageDeepSrcImportCount: importRows.filter((row) => row.specifierKind === 'package_deep_src').length,
    compatibilityImportCount: importRows.filter((row) => row.moduleStability === 'compatibility').length,
    internalImportCount: importRows.filter((row) => row.moduleStability === 'internal').length,
    unallowedStableImportCount: importRows.filter((row) => (
      row.moduleStability === 'stable' && row.specifierKind === 'relative_core_src' && row.allowedByModule === false
    )).length,
    bySpecifierKind,
    importedCoreModuleIds: [...new Set(importRows.map((row) => row.moduleId).filter(Boolean))].sort(),
    imports: importRows,
    blockers,
  };
}

export function buildChannelImportAllowlist({
  channelTargets = CHANNEL_IMPORT_ALLOWLIST_TARGETS,
  publicModules = modulesFromIndexExport('CORE_PUBLIC_MODULES'),
  compatibilityModules = modulesFromIndexExport('CORE_COMPATIBILITY_MODULES'),
  fileRecordsByChannel = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const channels = channelTargets.map((target) => auditTarget({
    target,
    publicModules,
    compatibilityModules,
    fileRecordsByChannel,
  }));
  const blockers = channels.flatMap((channel) => channel.blockers.map((item) => ({
    code: `${channel.channelId}_${item.code}`,
    notes: item.notes,
    file: item.file || null,
    line: item.line || null,
    moduleId: item.moduleId || null,
    specifier: item.specifier || null,
  })));
  const report = {
    version: CHANNEL_IMPORT_ALLOWLIST_VERSION,
    kind: 'ChannelImportAllowlist',
    status: blockers.length ? 'blocked_channel_import_allowlist' : 'pass_channel_import_allowlist',
    ok: blockers.length === 0,
    generatedAt,
    packageRoot: relative(packageRoot),
    publicModuleCount: publicModules.length,
    compatibilityModuleCount: compatibilityModules.length,
    channels,
    summary: {
      channelCount: channels.length,
      passingChannels: channels.filter((channel) => channel.ok).length,
      importCount: channels.reduce((sum, channel) => sum + channel.importCount, 0),
      stableRelativeImportCount: channels.reduce((sum, channel) => sum + channel.stableRelativeImportCount, 0),
      packageRootImportCount: channels.reduce((sum, channel) => sum + channel.packageRootImportCount, 0),
      packageDeepSrcImportCount: channels.reduce((sum, channel) => sum + channel.packageDeepSrcImportCount, 0),
      compatibilityImportCount: channels.reduce((sum, channel) => sum + channel.compatibilityImportCount, 0),
      internalImportCount: channels.reduce((sum, channel) => sum + channel.internalImportCount, 0),
      unallowedStableImportCount: channels.reduce((sum, channel) => sum + channel.unallowedStableImportCount, 0),
      blockerCount: blockers.length,
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      executesExternalAction: false,
      providerSpend: false,
      browserAutomation: false,
      upload: false,
      submit: false,
      messaging: false,
      payment: false,
      acceptance: false,
      deployment: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
    },
  };
  const allowlistHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    packageRoot: report.packageRoot,
    publicModuleCount: report.publicModuleCount,
    compatibilityModuleCount: report.compatibilityModuleCount,
    channels: report.channels.map((channel) => ({
      channelId: channel.channelId,
      status: channel.status,
      allowPackageRoot: channel.allowPackageRoot,
      allowedCoreModuleIds: channel.allowedCoreModuleIds,
      scannedFileCount: channel.scannedFileCount,
      importCount: channel.importCount,
      stableRelativeImportCount: channel.stableRelativeImportCount,
      packageRootImportCount: channel.packageRootImportCount,
      packageDeepSrcImportCount: channel.packageDeepSrcImportCount,
      compatibilityImportCount: channel.compatibilityImportCount,
      internalImportCount: channel.internalImportCount,
      unallowedStableImportCount: channel.unallowedStableImportCount,
      bySpecifierKind: channel.bySpecifierKind,
      importedCoreModuleIds: channel.importedCoreModuleIds,
      imports: channel.imports.map((row) => ({
        file: row.file,
        line: row.line,
        specifier: row.specifier,
        specifierKind: row.specifierKind,
        moduleId: row.moduleId,
        moduleStability: row.moduleStability,
        allowedByModule: row.allowedByModule,
        ok: row.ok,
      })),
      blockers: channel.blockers,
    })),
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    allowlistHash,
    hash: allowlistHash,
  };
}

export function summarizeChannelImportAllowlist(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_channel_import_allowlist',
    ok: report?.ok === true,
    allowlistHash: report?.allowlistHash || null,
    channelCount: report?.summary?.channelCount || 0,
    importCount: report?.summary?.importCount || 0,
    stableRelativeImportCount: report?.summary?.stableRelativeImportCount || 0,
    packageRootImportCount: report?.summary?.packageRootImportCount || 0,
    packageDeepSrcImportCount: report?.summary?.packageDeepSrcImportCount || 0,
    compatibilityImportCount: report?.summary?.compatibilityImportCount || 0,
    internalImportCount: report?.summary?.internalImportCount || 0,
    unallowedStableImportCount: report?.summary?.unallowedStableImportCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: report?.safety?.localOnly === true,
      readOnly: report?.safety?.readOnly === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
    },
  };
}

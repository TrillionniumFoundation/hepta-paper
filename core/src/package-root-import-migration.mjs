import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './hash-utils.mjs';
import { buildChannelImportAllowlist } from './channel-import-allowlist.mjs';
import { buildPackageRootResolverReport } from './package-root-resolver.mjs';

export const PACKAGE_ROOT_IMPORT_MIGRATION_VERSION = 2;

export const PACKAGE_ROOT_IMPORT_MIGRATION_STABLE_MODULE_ID = 'package-root-import-migration';

export const PACKAGE_ROOT_IMPORT_MIGRATION_REPORT_FILE_ID = 'package-root-import-migration-latest.json';

export const PACKAGE_ROOT_IMPORT_SPECIFIER = 'design-production-core';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(packageRoot, '..');
const reportsDir = path.join(packageRoot, 'reports');

function relative(filePath) {
  return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readDefaultPackageSurfaceReport() {
  return readJson(path.join(reportsDir, 'package-surface-latest.json'));
}

function compactPackageSurfaceReport(report) {
  return {
    exists: Boolean(report),
    ok: report?.ok === true,
    status: report?.status || null,
    hash: report?.surfaceHash || null,
    packageStableOnly: report?.summary?.packageStableOnly === true,
    rootImportOk: report?.summary?.rootImportOk === true,
    deepImportBlocked: report?.summary?.deepImportBlocked === true,
    rootPublicModuleCount: report?.summary?.rootPublicModuleCount ?? null,
    blockerCount: Array.isArray(report?.blockers) ? report.blockers.length : 0,
  };
}

function isMigratableRelativeImport(row) {
  return row?.specifierKind === 'relative_core_src'
    && row?.moduleStability === 'stable'
    && row?.allowedByModule === true
    && row?.ok !== false;
}

function migrationRiskForFile(fileImports) {
  const risks = [];
  if (fileImports.length > 1) {
    risks.push('merge_multiple_core_import_declarations');
  }
  const syntaxKinds = [...new Set(fileImports.map((row) => row.syntax))].sort();
  if (syntaxKinds.some((syntax) => syntax !== 'static_from')) {
    risks.push('review_non_static_from_import_syntax');
  }
  return risks;
}

function filePlanForImports({ channelId, label, file, imports }) {
  const sortedImports = [...imports].sort((left, right) => (
    `${left.line}:${left.moduleId}:${left.specifier}`.localeCompare(`${right.line}:${right.moduleId}:${right.specifier}`)
  ));
  const modules = [...new Set(sortedImports.map((row) => row.moduleId).filter(Boolean))].sort();
  const risks = migrationRiskForFile(sortedImports);
  return {
    channelId,
    label,
    file,
    status: 'ready_package_root_import_migration_plan',
    migrationMode: 'package_root_named_import',
    plannedSpecifier: PACKAGE_ROOT_IMPORT_SPECIFIER,
    importCount: sortedImports.length,
    moduleCount: modules.length,
    modules,
    lineNumbers: sortedImports.map((row) => row.line),
    sameFileCoreImportCount: sortedImports.length,
    riskLevel: risks.length ? 'review_merge' : 'low',
    risks,
    imports: sortedImports.map((row) => ({
      line: row.line,
      syntax: row.syntax,
      currentSpecifier: row.specifier,
      currentModuleId: row.moduleId,
      currentModulePath: row.modulePath,
      plannedSpecifier: PACKAGE_ROOT_IMPORT_SPECIFIER,
      migrationAction: 'replace_import_source_with_package_root',
    })),
    notes: [
      'Report-only plan. Do not rewrite channel files without a separate migration patch and verification pass.',
      'Actual edits must merge named imports carefully and check for local binding collisions.',
    ],
  };
}

function compactPackageRootResolverReport(report) {
  return {
    exists: Boolean(report),
    ok: report?.ok === true,
    status: report?.status || null,
    hash: report?.resolverHash || null,
    packageLinkReady: report?.summary?.packageLinkReady === true,
    resolverReadyChannels: report?.summary?.resolverReadyChannels ?? null,
    channelCount: report?.summary?.channelCount ?? null,
    blockerCount: Array.isArray(report?.blockers) ? report.blockers.length : 0,
  };
}

function fallbackPackageRootResolver(channelId) {
  return {
    channelId,
    cwd: null,
    ok: false,
    status: 'blocked_package_root_resolver_missing_channel_probe',
    exitCode: null,
    rootImport: {
      ok: false,
      publicModuleCount: null,
      compatibilityModuleCount: null,
      zeroCompatibilityInvariant: false,
      errorCode: 'PACKAGE_ROOT_RESOLVER_CHANNEL_MISSING',
      errorMessage: 'Package root resolver report did not include this channel.',
    },
    deepImport: {
      ok: false,
      errorCode: 'PACKAGE_ROOT_RESOLVER_CHANNEL_MISSING',
      errorMessage: 'Package root resolver report did not include this channel.',
    },
  };
}

function compactChannelResolver(channelResolver) {
  return {
    channelId: channelResolver.channelId,
    cwd: channelResolver.cwd || null,
    ok: channelResolver.ok === true,
    status: channelResolver.status || 'missing_package_root_resolver_channel_status',
    exitCode: channelResolver.exitCode ?? null,
    publicModuleCount: channelResolver.rootImport?.publicModuleCount ?? null,
    compatibilityModuleCount: channelResolver.rootImport?.compatibilityModuleCount ?? null,
    zeroCompatibilityInvariant: channelResolver.rootImport?.zeroCompatibilityInvariant === true,
    deepImportBlocked: channelResolver.deepImport?.errorCode === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    errorCode: channelResolver.rootImport?.errorCode || channelResolver.deepImport?.errorCode || null,
    errorMessage: channelResolver.rootImport?.errorMessage || channelResolver.deepImport?.errorMessage || null,
  };
}

function channelPlan(channel, resolverByChannel) {
  const migratableImports = (channel.imports || []).filter(isMigratableRelativeImport);
  const packageRootResolver = compactChannelResolver(
    resolverByChannel[channel.channelId] || fallbackPackageRootResolver(channel.channelId),
  );
  const fileGroups = new Map();
  for (const row of migratableImports) {
    const current = fileGroups.get(row.file) || [];
    current.push(row);
    fileGroups.set(row.file, current);
  }
  const filePlans = [...fileGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, imports]) => filePlanForImports({
      channelId: channel.channelId,
      label: channel.label,
      file,
      imports,
    }));
  const packageRootImports = (channel.imports || []).filter((row) => row.specifierKind === 'package_root');
  const nonMigratableImports = (channel.imports || []).filter((row) => (
    row.specifierKind !== 'package_root' && !isMigratableRelativeImport(row)
  ));
  return {
    channelId: channel.channelId,
    label: channel.label,
    status: channel.ok ? 'ready_package_root_import_migration_plan' : 'blocked_package_root_import_migration_plan',
    ok: channel.ok === true,
    currentImportCount: channel.importCount,
    packageRootImportCount: packageRootImports.length,
    migratableRelativeImportCount: migratableImports.length,
    nonMigratableImportCount: nonMigratableImports.length,
    filePlanCount: filePlans.length,
    packageRootResolver,
    rewriteReady: migratableImports.length === 0 || packageRootResolver.ok === true,
    moduleIds: [...new Set(migratableImports.map((row) => row.moduleId).filter(Boolean))].sort(),
    filePlans,
    nonMigratableImports: nonMigratableImports.map((row) => ({
      file: row.file,
      line: row.line,
      specifier: row.specifier,
      specifierKind: row.specifierKind,
      moduleId: row.moduleId,
      moduleStability: row.moduleStability,
      allowedByModule: row.allowedByModule,
      blockers: row.blockers || [],
    })),
  };
}

export function buildPackageRootImportMigrationPlan({
  channelImportAllowlist = null,
  packageRootResolverReport = null,
  packageSurfaceReport = readDefaultPackageSurfaceReport(),
  generatedAt = new Date().toISOString(),
} = {}) {
  const effectiveChannelImportAllowlist = channelImportAllowlist || buildChannelImportAllowlist({ generatedAt });
  const effectivePackageRootResolverReport = packageRootResolverReport || buildPackageRootResolverReport({ generatedAt });
  const channelImportAllowlistHash = effectiveChannelImportAllowlist.allowlistHash || null;
  const channelImportAllowlistGenericHash = effectiveChannelImportAllowlist.hash || null;
  const packageRootResolver = compactPackageRootResolverReport(effectivePackageRootResolverReport);
  const resolverByChannel = Object.fromEntries((effectivePackageRootResolverReport?.channels || []).map((channel) => [
    channel.channelId,
    channel,
  ]));
  const packageSurface = compactPackageSurfaceReport(packageSurfaceReport);
  const channels = (effectiveChannelImportAllowlist.channels || []).map((channel) => channelPlan(channel, resolverByChannel));
  const blockers = [
    ...(!channelImportAllowlistHash ? [{
      code: 'package_root_migration_allowlist_hash_required',
      notes: 'Channel import allowlist must expose allowlistHash; generic hash cannot stand in for the allowlist identity.',
    }] : []),
    ...(!channelImportAllowlistGenericHash ? [{
      code: 'package_root_migration_allowlist_generic_hash_required',
      notes: 'Channel import allowlist must preserve its generic hash beside allowlistHash for file binding.',
    }] : []),
    ...(channelImportAllowlistHash && channelImportAllowlistGenericHash && channelImportAllowlistHash !== channelImportAllowlistGenericHash ? [{
      code: 'package_root_migration_allowlist_hash_mismatch',
      notes: 'Channel import allowlist allowlistHash must match the generic hash binding.',
    }] : []),
    ...(!effectiveChannelImportAllowlist.ok ? [{
      code: 'package_root_migration_channel_allowlist_not_ok',
      notes: 'Channel import allowlist must pass before package-root import migration can be planned.',
    }] : []),
    ...(effectiveChannelImportAllowlist.blockers || []).map((item) => ({
      code: `package_root_migration_${item.code}`,
      notes: `${item.notes}${item.file ? ` (${item.file}:${item.line})` : ''}`,
      file: item.file || null,
      line: item.line || null,
      moduleId: item.moduleId || null,
    })),
    ...(!packageSurface.exists ? [{
      code: 'package_root_migration_package_surface_report_missing',
      notes: 'reports/package-surface-latest.json must exist before planning package-root channel imports.',
    }] : []),
    ...(packageSurface.exists && !packageSurface.ok ? [{
      code: 'package_root_migration_package_surface_report_not_ok',
      notes: `Package surface report is not ok: ${packageSurface.status || 'unknown status'}.`,
    }] : []),
    ...(packageSurface.exists && !packageSurface.packageStableOnly ? [{
      code: 'package_root_migration_package_surface_not_stable_only',
      notes: 'Package exports must remain stable-only before channels can migrate to package root imports.',
    }] : []),
    ...(packageSurface.exists && !packageSurface.rootImportOk ? [{
      code: 'package_root_migration_package_root_import_not_ok',
      notes: 'Package root import smoke test must pass before channels can migrate to package root imports.',
    }] : []),
    ...(packageSurface.exists && !packageSurface.deepImportBlocked ? [{
      code: 'package_root_migration_deep_import_not_blocked',
      notes: 'Deep package src import smoke test must stay blocked before channels migrate to package root imports.',
    }] : []),
    ...channels.flatMap((channel) => (channel.nonMigratableImports || []).map((row) => ({
      code: 'package_root_migration_non_migratable_core_import',
      notes: `${channel.channelId} has a non-migratable core import ${row.specifier} (${row.specifierKind}/${row.moduleStability}).`,
      file: row.file,
      line: row.line,
      moduleId: row.moduleId,
    }))),
  ];
  const allFilePlans = channels.flatMap((channel) => channel.filePlans);
  const rewriteBlockers = channels
    .filter((channel) => channel.migratableRelativeImportCount > 0 && channel.packageRootResolver?.ok !== true)
    .map((channel) => ({
      code: 'package_root_rewrite_channel_resolver_not_ready',
      channelId: channel.channelId,
      cwd: channel.packageRootResolver?.cwd || null,
      errorCode: channel.packageRootResolver?.errorCode || null,
      notes: `${channel.channelId} cannot resolve ${PACKAGE_ROOT_IMPORT_SPECIFIER} from its runtime root yet; do not rewrite sibling relative imports to package root until package linking/resolution is fixed.`,
    }));
  const report = {
    version: PACKAGE_ROOT_IMPORT_MIGRATION_VERSION,
    kind: 'PackageRootImportMigrationPlan',
    status: blockers.length ? 'blocked_package_root_import_migration_plan' : 'pass_package_root_import_migration_plan',
    ok: blockers.length === 0,
    generatedAt,
    packageRoot: relative(packageRoot),
    plannedSpecifier: PACKAGE_ROOT_IMPORT_SPECIFIER,
    packageSurface,
    channelImportAllowlist: {
      status: effectiveChannelImportAllowlist.status,
      ok: effectiveChannelImportAllowlist.ok === true,
      allowlistHash: channelImportAllowlistHash,
      summary: effectiveChannelImportAllowlist.summary || null,
    },
    packageRootResolver,
    channels,
    summary: {
      channelCount: channels.length,
      passingChannels: channels.filter((channel) => channel.ok).length,
      currentCoreImportCount: channels.reduce((sum, channel) => sum + channel.currentImportCount, 0),
      packageRootImportCount: channels.reduce((sum, channel) => sum + channel.packageRootImportCount, 0),
      migratableRelativeImportCount: channels.reduce((sum, channel) => sum + channel.migratableRelativeImportCount, 0),
      nonMigratableImportCount: channels.reduce((sum, channel) => sum + channel.nonMigratableImportCount, 0),
      filePlanCount: allFilePlans.length,
      reviewMergeFileCount: allFilePlans.filter((filePlan) => filePlan.riskLevel === 'review_merge').length,
      packageRootResolverReadyChannels: channels.filter((channel) => channel.packageRootResolver?.ok === true).length,
      rewriteReadyChannels: channels.filter((channel) => channel.rewriteReady).length,
      rewriteReady: rewriteBlockers.length === 0,
      rewriteBlockerCount: rewriteBlockers.length,
      packageRootResolverHash: packageRootResolver.hash,
      packageSurfaceHash: packageSurface.hash,
      allowlistHash: channelImportAllowlistHash,
      blockerCount: blockers.length,
    },
    rewriteBlockers,
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      reportOnly: true,
      mutatesChannelFiles: false,
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
  const migrationHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    packageRoot: report.packageRoot,
    plannedSpecifier: report.plannedSpecifier,
    packageSurface: report.packageSurface,
    channelImportAllowlist: report.channelImportAllowlist,
    packageRootResolver: report.packageRootResolver,
    channels: report.channels,
    summary: report.summary,
    rewriteBlockers: report.rewriteBlockers,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    migrationHash,
    hash: migrationHash,
  };
}

export function summarizePackageRootImportMigrationPlan(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_package_root_import_migration_plan',
    ok: report?.ok === true,
    migrationHash: report?.migrationHash || null,
    plannedSpecifier: report?.plannedSpecifier || PACKAGE_ROOT_IMPORT_SPECIFIER,
    channelCount: report?.summary?.channelCount || 0,
    currentCoreImportCount: report?.summary?.currentCoreImportCount || 0,
    packageRootImportCount: report?.summary?.packageRootImportCount || 0,
    migratableRelativeImportCount: report?.summary?.migratableRelativeImportCount || 0,
    nonMigratableImportCount: report?.summary?.nonMigratableImportCount || 0,
    filePlanCount: report?.summary?.filePlanCount || 0,
    rewriteReady: report?.summary?.rewriteReady === true,
    rewriteBlockerCount: report?.summary?.rewriteBlockerCount || 0,
    packageRootResolverHash: report?.summary?.packageRootResolverHash || null,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: report?.safety?.localOnly === true,
      readOnly: report?.safety?.readOnly === true,
      reportOnly: report?.safety?.reportOnly === true,
      mutatesChannelFiles: report?.safety?.mutatesChannelFiles === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
    },
  };
}

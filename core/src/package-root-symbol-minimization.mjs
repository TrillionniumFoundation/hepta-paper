import { digest } from './hash-utils.mjs';
import { buildPackageRootSymbolManifestReport } from './package-root-symbol-manifest.mjs';

export const PACKAGE_ROOT_SYMBOL_MINIMIZATION_VERSION = 1;

export const PACKAGE_ROOT_SYMBOL_MINIMIZATION_REPORT_FILE_ID = 'package-root-symbol-minimization-latest.json';

function compactSymbolManifest(report) {
  return {
    status: report?.status || 'missing_package_root_symbol_manifest',
    ok: report?.ok === true,
    hash: report?.symbolManifestHash || null,
    summary: report?.summary || null,
    blockerCount: report?.summary?.blockerCount || 0,
  };
}

function channelPlan(channel = {}) {
  const allowedSymbols = [...(channel.allowedSymbols || [])].sort((left, right) => left.localeCompare(right));
  const importedSymbols = [...(channel.importedSymbols || [])].sort((left, right) => left.localeCompare(right));
  const importedSet = new Set(importedSymbols);
  const allowedSet = new Set(allowedSymbols);
  const unusedAllowedSymbols = allowedSymbols.filter((symbol) => !importedSet.has(symbol));
  const proposedAllowedSymbols = importedSymbols.filter((symbol) => allowedSet.has(symbol));
  return {
    channelId: channel.channelId,
    label: channel.label,
    status: channel.ok ? 'pass_package_root_symbol_minimization_channel' : 'blocked_package_root_symbol_minimization_channel',
    ok: channel.ok === true,
    manifestSymbolCount: allowedSymbols.length,
    importedSymbolCount: channel.importedSymbolCount || 0,
    uniqueImportedSymbolCount: importedSymbols.length,
    currentAllowedSymbols: allowedSymbols,
    currentImportedSymbols: importedSymbols,
    unusedAllowedSymbols,
    proposedAllowedSymbols,
    proposedSymbolCount: proposedAllowedSymbols.length,
    shrinkableSymbolCount: unusedAllowedSymbols.length,
    shrinkable: unusedAllowedSymbols.length > 0,
    blockers: (channel.blockers || []).map((item) => ({
      code: item.code,
      notes: item.notes,
      file: item.file || null,
      line: item.line || null,
      importedName: item.importedName || null,
    })),
  };
}

export function buildPackageRootSymbolMinimizationReport({
  symbolManifestReport = null,
  fileRecordsByChannel = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const packageRootSymbolManifest = symbolManifestReport || buildPackageRootSymbolManifestReport({
    fileRecordsByChannel,
    generatedAt,
  });
  const channels = (packageRootSymbolManifest.channels || []).map(channelPlan);
  const blockers = [
    ...(packageRootSymbolManifest.ok === true ? [] : [{
      code: 'package_root_symbol_manifest_not_ok',
      notes: `Cannot propose an exact-current symbol manifest while the source manifest is ${packageRootSymbolManifest.status || 'unknown'}.`,
    }]),
    ...channels.flatMap((channel) => channel.blockers.map((item) => ({
      code: `${channel.channelId}_${item.code}`,
      notes: item.notes,
      file: item.file,
      line: item.line,
      importedName: item.importedName,
    }))),
  ];
  const report = {
    version: PACKAGE_ROOT_SYMBOL_MINIMIZATION_VERSION,
    kind: 'PackageRootSymbolMinimization',
    status: blockers.length ? 'blocked_package_root_symbol_minimization' : 'pass_package_root_symbol_minimization',
    ok: blockers.length === 0,
    generatedAt,
    sourceSymbolManifest: compactSymbolManifest(packageRootSymbolManifest),
    channels,
    summary: {
      channelCount: channels.length,
      passingChannels: channels.filter((channel) => channel.ok).length,
      importedSymbolCount: channels.reduce((sum, channel) => sum + channel.importedSymbolCount, 0),
      uniqueImportedSymbolCount: new Set(channels.flatMap((channel) => channel.currentImportedSymbols)).size,
      manifestSymbolCount: channels.reduce((sum, channel) => sum + channel.manifestSymbolCount, 0),
      uniqueManifestSymbolCount: new Set(channels.flatMap((channel) => channel.currentAllowedSymbols)).size,
      exactCurrentManifestSymbolCount: channels.reduce((sum, channel) => sum + channel.proposedSymbolCount, 0),
      unusedAllowedSymbolCount: channels.reduce((sum, channel) => sum + channel.unusedAllowedSymbols.length, 0),
      shrinkableSymbolCount: channels.reduce((sum, channel) => sum + channel.shrinkableSymbolCount, 0),
      shrinkableChannelCount: channels.filter((channel) => channel.shrinkable).length,
      minimizationReady: packageRootSymbolManifest.ok === true && blockers.length === 0,
      blockerCount: blockers.length,
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      reportOnly: true,
      mutatesChannelFiles: false,
      mutatesSymbolManifest: false,
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
  const symbolMinimizationHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    sourceSymbolManifest: report.sourceSymbolManifest,
    channels: report.channels,
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    symbolMinimizationHash,
    hash: symbolMinimizationHash,
  };
}

export function summarizePackageRootSymbolMinimizationReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_package_root_symbol_minimization',
    ok: report?.ok === true,
    symbolMinimizationHash: report?.symbolMinimizationHash || null,
    channelCount: report?.summary?.channelCount || 0,
    manifestSymbolCount: report?.summary?.manifestSymbolCount || 0,
    exactCurrentManifestSymbolCount: report?.summary?.exactCurrentManifestSymbolCount || 0,
    unusedAllowedSymbolCount: report?.summary?.unusedAllowedSymbolCount || 0,
    shrinkableSymbolCount: report?.summary?.shrinkableSymbolCount || 0,
    minimizationReady: report?.summary?.minimizationReady === true,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: report?.safety?.localOnly === true,
      readOnly: report?.safety?.readOnly === true,
      reportOnly: report?.safety?.reportOnly === true,
      mutatesChannelFiles: report?.safety?.mutatesChannelFiles === true,
      mutatesSymbolManifest: report?.safety?.mutatesSymbolManifest === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
    },
  };
}

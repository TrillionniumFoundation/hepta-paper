import { digest } from './hash-utils.mjs';
import { buildPackageRootSymbolManifestReport } from './package-root-symbol-manifest.mjs';

export const PACKAGE_ROOT_SYMBOL_REGRESSION_VERSION = 1;

export const PACKAGE_ROOT_SYMBOL_REGRESSION_REPORT_FILE_ID = 'package-root-symbol-regression-latest.json';

const EXPECTED_NAMESPACE_IMPORT_COUNT = 1;
const EXPECTED_DEFAULT_IMPORT_COUNT = 1;
const EXPECTED_UNALLOWED_SYMBOL_COUNT = 2;
const EXPECTED_MISSING_PACKAGE_EXPORT_COUNT = 1;
const EXPECTED_SYMBOL_MANIFEST_BLOCKER_COUNT = 5;

const BAD_PACKAGE_ROOT_SYMBOL_FIXTURE = Object.freeze({
  zbj: Object.freeze([Object.freeze({
    file: 'zbj-auto-intake/src/core/package-root-symbol-regression-namespace.mjs',
    text: "import * as Core from 'design-production-core';\n",
  })]),
  epwk: Object.freeze([Object.freeze({
    file: 'epwk-auto-intake/src/package-root-symbol-regression-default.mjs',
    text: "import Core from 'design-production-core';\n",
  })]),
  hepta: Object.freeze([Object.freeze({
    file: 'skills/hepta_design/scripts/package-root-symbol-regression-unlisted.mjs',
    text: "import { CORE_PUBLIC_MODULES, DefinitelyNotAProductionCoreExport } from 'design-production-core';\n",
  })]),
});

function countBlockers(blockers = [], predicate) {
  return blockers.filter(predicate).length;
}

function compactSymbolManifest(report) {
  return {
    status: report.status,
    ok: report.ok === true,
    hash: report.symbolManifestHash || null,
    summary: report.summary,
    blockers: (report.blockers || []).map((item) => ({
      code: item.code,
      file: item.file || null,
      line: item.line || null,
      importedName: item.importedName || null,
      localName: item.localName || null,
    })),
  };
}

export function buildPackageRootSymbolRegressionReport({
  fileRecordsByChannel = BAD_PACKAGE_ROOT_SYMBOL_FIXTURE,
  generatedAt = new Date().toISOString(),
} = {}) {
  const packageRootSymbolManifest = buildPackageRootSymbolManifestReport({
    fileRecordsByChannel,
    generatedAt,
  });
  const namespaceBlockerCount = countBlockers(
    packageRootSymbolManifest.blockers,
    (item) => item.code.endsWith('package_root_symbol_import_not_named') && item.importedName === '*',
  );
  const defaultBlockerCount = countBlockers(
    packageRootSymbolManifest.blockers,
    (item) => item.code.endsWith('package_root_symbol_import_not_named') && item.importedName === 'default',
  );
  const unallowedBlockerCount = countBlockers(
    packageRootSymbolManifest.blockers,
    (item) => item.code.endsWith('package_root_symbol_not_in_channel_manifest'),
  );
  const missingExportBlockerCount = countBlockers(
    packageRootSymbolManifest.blockers,
    (item) => item.code.endsWith('package_root_symbol_not_exported'),
  );
  const blockers = [
    ...(packageRootSymbolManifest.ok ? [{
      code: 'symbol_regression_manifest_unexpectedly_passed',
      notes: 'Synthetic package-root namespace/default/unlisted/missing-export imports must make the symbol manifest fail.',
    }] : []),
    ...(packageRootSymbolManifest.summary?.namespaceImportCount !== EXPECTED_NAMESPACE_IMPORT_COUNT ? [{
      code: 'symbol_regression_namespace_import_count_mismatch',
      notes: `Expected ${EXPECTED_NAMESPACE_IMPORT_COUNT} namespace import, got ${packageRootSymbolManifest.summary?.namespaceImportCount ?? 'null'}.`,
    }] : []),
    ...(packageRootSymbolManifest.summary?.defaultImportCount !== EXPECTED_DEFAULT_IMPORT_COUNT ? [{
      code: 'symbol_regression_default_import_count_mismatch',
      notes: `Expected ${EXPECTED_DEFAULT_IMPORT_COUNT} default import, got ${packageRootSymbolManifest.summary?.defaultImportCount ?? 'null'}.`,
    }] : []),
    ...(packageRootSymbolManifest.summary?.unallowedSymbolCount !== EXPECTED_UNALLOWED_SYMBOL_COUNT ? [{
      code: 'symbol_regression_unallowed_symbol_count_mismatch',
      notes: `Expected ${EXPECTED_UNALLOWED_SYMBOL_COUNT} unallowed symbols, got ${packageRootSymbolManifest.summary?.unallowedSymbolCount ?? 'null'}.`,
    }] : []),
    ...(packageRootSymbolManifest.summary?.missingPackageExportCount !== EXPECTED_MISSING_PACKAGE_EXPORT_COUNT ? [{
      code: 'symbol_regression_missing_package_export_count_mismatch',
      notes: `Expected ${EXPECTED_MISSING_PACKAGE_EXPORT_COUNT} missing package export, got ${packageRootSymbolManifest.summary?.missingPackageExportCount ?? 'null'}.`,
    }] : []),
    ...(namespaceBlockerCount !== EXPECTED_NAMESPACE_IMPORT_COUNT ? [{
      code: 'symbol_regression_namespace_blocker_count_mismatch',
      notes: `Expected ${EXPECTED_NAMESPACE_IMPORT_COUNT} namespace blocker, got ${namespaceBlockerCount}.`,
    }] : []),
    ...(defaultBlockerCount !== EXPECTED_DEFAULT_IMPORT_COUNT ? [{
      code: 'symbol_regression_default_blocker_count_mismatch',
      notes: `Expected ${EXPECTED_DEFAULT_IMPORT_COUNT} default blocker, got ${defaultBlockerCount}.`,
    }] : []),
    ...(unallowedBlockerCount !== EXPECTED_UNALLOWED_SYMBOL_COUNT ? [{
      code: 'symbol_regression_unallowed_blocker_count_mismatch',
      notes: `Expected ${EXPECTED_UNALLOWED_SYMBOL_COUNT} unallowed symbol blockers, got ${unallowedBlockerCount}.`,
    }] : []),
    ...(missingExportBlockerCount !== EXPECTED_MISSING_PACKAGE_EXPORT_COUNT ? [{
      code: 'symbol_regression_missing_export_blocker_count_mismatch',
      notes: `Expected ${EXPECTED_MISSING_PACKAGE_EXPORT_COUNT} missing export blocker, got ${missingExportBlockerCount}.`,
    }] : []),
    ...(packageRootSymbolManifest.summary?.blockerCount !== EXPECTED_SYMBOL_MANIFEST_BLOCKER_COUNT ? [{
      code: 'symbol_regression_manifest_blocker_count_mismatch',
      notes: `Expected ${EXPECTED_SYMBOL_MANIFEST_BLOCKER_COUNT} manifest blockers, got ${packageRootSymbolManifest.summary?.blockerCount ?? 'null'}.`,
    }] : []),
  ];
  const report = {
    version: PACKAGE_ROOT_SYMBOL_REGRESSION_VERSION,
    kind: 'PackageRootSymbolRegression',
    status: blockers.length ? 'blocked_package_root_symbol_regression' : 'pass_package_root_symbol_regression',
    ok: blockers.length === 0,
    generatedAt,
    fixture: {
      expectedNamespaceImportCount: EXPECTED_NAMESPACE_IMPORT_COUNT,
      expectedDefaultImportCount: EXPECTED_DEFAULT_IMPORT_COUNT,
      expectedUnallowedSymbolCount: EXPECTED_UNALLOWED_SYMBOL_COUNT,
      expectedMissingPackageExportCount: EXPECTED_MISSING_PACKAGE_EXPORT_COUNT,
      expectedSymbolManifestBlockerCount: EXPECTED_SYMBOL_MANIFEST_BLOCKER_COUNT,
      channels: Object.fromEntries(Object.entries(fileRecordsByChannel).map(([channelId, records]) => [
        channelId,
        records.map((record) => ({
          file: record.file,
          importText: record.text.trim(),
        })),
      ])),
    },
    symbolManifestRegression: compactSymbolManifest(packageRootSymbolManifest),
    summary: {
      expectedNamespaceImportCount: EXPECTED_NAMESPACE_IMPORT_COUNT,
      expectedDefaultImportCount: EXPECTED_DEFAULT_IMPORT_COUNT,
      expectedUnallowedSymbolCount: EXPECTED_UNALLOWED_SYMBOL_COUNT,
      expectedMissingPackageExportCount: EXPECTED_MISSING_PACKAGE_EXPORT_COUNT,
      expectedSymbolManifestBlockerCount: EXPECTED_SYMBOL_MANIFEST_BLOCKER_COUNT,
      symbolManifestOk: packageRootSymbolManifest.ok === true,
      namespaceImportCount: packageRootSymbolManifest.summary?.namespaceImportCount ?? null,
      defaultImportCount: packageRootSymbolManifest.summary?.defaultImportCount ?? null,
      unallowedSymbolCount: packageRootSymbolManifest.summary?.unallowedSymbolCount ?? null,
      missingPackageExportCount: packageRootSymbolManifest.summary?.missingPackageExportCount ?? null,
      namespaceBlockerCount,
      defaultBlockerCount,
      unallowedBlockerCount,
      missingExportBlockerCount,
      symbolManifestBlockerCount: packageRootSymbolManifest.summary?.blockerCount ?? null,
      blockerCount: blockers.length,
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      syntheticFixtureOnly: true,
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
  const symbolRegressionHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    fixture: report.fixture,
    symbolManifestRegression: report.symbolManifestRegression,
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    symbolRegressionHash,
    hash: symbolRegressionHash,
  };
}

export function summarizePackageRootSymbolRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_package_root_symbol_regression',
    ok: report?.ok === true,
    symbolRegressionHash: report?.symbolRegressionHash || null,
    expectedNamespaceImportCount: report?.summary?.expectedNamespaceImportCount || 0,
    expectedDefaultImportCount: report?.summary?.expectedDefaultImportCount || 0,
    expectedUnallowedSymbolCount: report?.summary?.expectedUnallowedSymbolCount || 0,
    expectedMissingPackageExportCount: report?.summary?.expectedMissingPackageExportCount || 0,
    symbolManifestOk: report?.summary?.symbolManifestOk === true,
    namespaceImportCount: report?.summary?.namespaceImportCount || 0,
    defaultImportCount: report?.summary?.defaultImportCount || 0,
    unallowedSymbolCount: report?.summary?.unallowedSymbolCount || 0,
    missingPackageExportCount: report?.summary?.missingPackageExportCount || 0,
    symbolManifestBlockerCount: report?.summary?.symbolManifestBlockerCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: report?.safety?.localOnly === true,
      readOnly: report?.safety?.readOnly === true,
      syntheticFixtureOnly: report?.safety?.syntheticFixtureOnly === true,
      mutatesChannelFiles: report?.safety?.mutatesChannelFiles === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
    },
  };
}

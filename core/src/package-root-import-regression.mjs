import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './hash-utils.mjs';
import { buildChannelImportAllowlist } from './channel-import-allowlist.mjs';
import { buildPackageRootResolverReport } from './package-root-resolver.mjs';
import { buildPackageRootImportMigrationPlan } from './package-root-import-migration.mjs';
import { CORE_PUBLIC_MODULES } from './index.mjs';

export const PACKAGE_ROOT_IMPORT_REGRESSION_VERSION = 2;

export const PACKAGE_ROOT_IMPORT_REGRESSION_REPORT_FILE_ID = 'package-root-import-regression-latest.json';

const EXPECTED_BAD_IMPORT_COUNT = 3;

const FORBIDDEN_RELATIVE_BLOCKER_CODE = 'channel_relative_core_src_import_forbidden_after_package_root_migration';

const BAD_RELATIVE_IMPORT_FIXTURE = Object.freeze({
  zbj: Object.freeze([Object.freeze({
    file: 'zbj-auto-intake/src/core/package-root-regression-bad-relative.mjs',
    text: "import { createChannelTask } from '../../../design-production-core/src/contracts.mjs';\n",
  })]),
  epwk: Object.freeze([Object.freeze({
    file: 'epwk-auto-intake/src/package-root-regression-bad-relative.mjs',
    text: "import { buildEpwkPlanOnlyMigration } from '../../design-production-core/src/migration-shims.mjs';\n",
  })]),
  hepta: Object.freeze([Object.freeze({
    file: 'skills/hepta_design/scripts/package-root-regression-bad-relative.mjs',
    text: "import { digest } from '../../../design-production-core/src/hash-utils.mjs';\n",
  })]),
});

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.join(packageRoot, 'docs');

function readyPackageRootResolverFixture({ generatedAt }) {
  return buildPackageRootResolverReport({
    packageLink: {
      path: 'node_modules/design-production-core',
      exists: true,
      isSymlink: true,
      rawTarget: '../design-production-core',
      resolvedTarget: 'design-production-core',
      expectedTarget: 'design-production-core',
      resolvesToPackageRoot: true,
      status: 'pass_package_root_workspace_link',
    },
    probeResultsByChannel: Object.fromEntries(['zbj', 'epwk', 'hepta'].map((channelId) => [channelId, {
      cwd: channelId === 'hepta' ? 'skills/hepta_design' : `${channelId}-auto-intake`,
      rootImport: {
        ok: true,
        publicModuleCount: CORE_PUBLIC_MODULES.length,
        compatibilityModuleCount: 0,
        zeroCompatibilityInvariant: true,
      },
      deepImport: {
        ok: false,
        errorCode: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      },
    }])),
    generatedAt,
  });
}

function readyPackageSurfaceFixture() {
  return {
    ok: true,
    status: 'pass_package_surface',
    surfaceHash: 'sha256:fixture-package-surface',
    summary: {
      packageStableOnly: true,
      rootImportOk: true,
      rootPublicModuleCount: CORE_PUBLIC_MODULES.length,
      rootCompatibilityModuleCount: 0,
      deepImportBlocked: true,
    },
    blockers: [],
  };
}

function countBlockers(blockers = [], predicate) {
  return blockers.filter(predicate).length;
}

function defaultDocsFileRecords() {
  const records = [];
  const readIfExists = (relativeFile) => {
    const absoluteFile = path.join(packageRoot, relativeFile);
    if (fs.existsSync(absoluteFile)) {
      records.push({
        file: relativeFile,
        text: fs.readFileSync(absoluteFile, 'utf8'),
      });
    }
  };
  readIfExists('README.md');
  for (const entry of fs.readdirSync(docsRoot, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      readIfExists(`docs/${entry.name}`);
    }
  }
  return records.sort((left, right) => left.file.localeCompare(right.file));
}

function importExampleRowsForDocs(fileRecords = []) {
  const rows = [];
  const importFromPattern = /\bfrom\s+['"]([^'"]+)['"]/g;
  for (const record of fileRecords) {
    const lines = String(record.text || '').split(/\r?\n/);
    lines.forEach((lineText, index) => {
      for (const match of lineText.matchAll(importFromPattern)) {
        rows.push({
          file: record.file,
          line: index + 1,
          specifier: match[1],
          text: lineText.trim(),
        });
      }
    });
  }
  return rows;
}

function isForbiddenDocsCoreSrcImport(specifier) {
  const value = String(specifier || '');
  return value === './src/index.mjs'
    || value.startsWith('./src/')
    || value.startsWith('design-production-core/src/')
    || /(?:^|\/)design-production-core\/src\//.test(value);
}

function compactAllowlist(report) {
  return {
    status: report.status,
    ok: report.ok === true,
    hash: report.allowlistHash || null,
    summary: report.summary,
    blockers: (report.blockers || []).map((item) => ({
      code: item.code,
      file: item.file || null,
      line: item.line || null,
      moduleId: item.moduleId || null,
      specifier: item.specifier || null,
    })),
  };
}

function compactMigration(report) {
  return {
    status: report.status,
    ok: report.ok === true,
    hash: report.migrationHash || null,
    summary: report.summary,
    blockers: (report.blockers || []).map((item) => ({
      code: item.code,
      file: item.file || null,
      line: item.line || null,
      moduleId: item.moduleId || null,
    })),
  };
}

export function buildPackageRootImportRegressionReport({
  fileRecordsByChannel = BAD_RELATIVE_IMPORT_FIXTURE,
  docsFileRecords = defaultDocsFileRecords(),
  generatedAt = new Date().toISOString(),
} = {}) {
  const channelImportAllowlist = buildChannelImportAllowlist({
    fileRecordsByChannel,
    generatedAt,
  });
  const packageRootImportMigration = buildPackageRootImportMigrationPlan({
    channelImportAllowlist,
    packageRootResolverReport: readyPackageRootResolverFixture({ generatedAt }),
    packageSurfaceReport: readyPackageSurfaceFixture(),
    generatedAt,
  });
  const allowlistRelativeBlockerCount = countBlockers(
    channelImportAllowlist.blockers,
    (item) => String(item.code || '').endsWith(FORBIDDEN_RELATIVE_BLOCKER_CODE),
  );
  const migrationAllowlistBlockerCount = countBlockers(
    packageRootImportMigration.blockers,
    (item) => item.code === 'package_root_migration_channel_allowlist_not_ok',
  );
  const migrationNonMigratableBlockerCount = countBlockers(
    packageRootImportMigration.blockers,
    (item) => item.code === 'package_root_migration_non_migratable_core_import',
  );
  const docsImportExamples = importExampleRowsForDocs(docsFileRecords);
  const docsForbiddenImportExamples = docsImportExamples.filter((row) => isForbiddenDocsCoreSrcImport(row.specifier));
  const blockers = [
    ...(channelImportAllowlist.ok ? [{
      code: 'regression_fixture_allowlist_unexpectedly_passed',
      notes: 'Synthetic sibling design-production-core/src relative imports must make the channel import allowlist fail.',
    }] : []),
    ...(channelImportAllowlist.summary?.stableRelativeImportCount !== EXPECTED_BAD_IMPORT_COUNT ? [{
      code: 'regression_fixture_bad_relative_import_count_mismatch',
      notes: `Expected ${EXPECTED_BAD_IMPORT_COUNT} synthetic relative core imports, got ${channelImportAllowlist.summary?.stableRelativeImportCount ?? 'null'}.`,
    }] : []),
    ...(allowlistRelativeBlockerCount !== EXPECTED_BAD_IMPORT_COUNT ? [{
      code: 'regression_fixture_allowlist_relative_blocker_count_mismatch',
      notes: `Expected ${EXPECTED_BAD_IMPORT_COUNT} allowlist relative-import blockers, got ${allowlistRelativeBlockerCount}.`,
    }] : []),
    ...(packageRootImportMigration.ok ? [{
      code: 'regression_fixture_migration_unexpectedly_passed',
      notes: 'Synthetic sibling design-production-core/src relative imports must make the package-root migration report fail.',
    }] : []),
    ...(!migrationAllowlistBlockerCount ? [{
      code: 'regression_fixture_migration_allowlist_blocker_missing',
      notes: 'Package-root migration must fail when the channel import allowlist fails on relative core src imports.',
    }] : []),
    ...(packageRootImportMigration.summary?.nonMigratableImportCount !== EXPECTED_BAD_IMPORT_COUNT ? [{
      code: 'regression_fixture_migration_non_migratable_count_mismatch',
      notes: `Expected ${EXPECTED_BAD_IMPORT_COUNT} non-migratable relative core imports, got ${packageRootImportMigration.summary?.nonMigratableImportCount ?? 'null'}.`,
    }] : []),
    ...(migrationNonMigratableBlockerCount !== EXPECTED_BAD_IMPORT_COUNT ? [{
      code: 'regression_fixture_migration_non_migratable_blocker_count_mismatch',
      notes: `Expected ${EXPECTED_BAD_IMPORT_COUNT} migration non-migratable blockers, got ${migrationNonMigratableBlockerCount}.`,
    }] : []),
    ...docsForbiddenImportExamples.map((row) => ({
      code: 'package_root_docs_core_src_import_example_forbidden',
      notes: `${row.file}:${row.line} uses ${row.specifier}; docs examples for package consumers and channel code must import the package root.`,
      file: row.file,
      line: row.line,
      specifier: row.specifier,
    })),
  ];
  const report = {
    version: PACKAGE_ROOT_IMPORT_REGRESSION_VERSION,
    kind: 'PackageRootImportRegression',
    status: blockers.length ? 'blocked_package_root_import_regression' : 'pass_package_root_import_regression',
    ok: blockers.length === 0,
    generatedAt,
    fixture: {
      expectedBadImportCount: EXPECTED_BAD_IMPORT_COUNT,
      forbiddenRelativeBlockerCode: FORBIDDEN_RELATIVE_BLOCKER_CODE,
      channels: Object.fromEntries(Object.entries(fileRecordsByChannel).map(([channelId, records]) => [
        channelId,
        records.map((record) => ({
          file: record.file,
          importText: record.text.trim(),
        })),
      ])),
    },
    allowlistRegression: compactAllowlist(channelImportAllowlist),
    migrationRegression: compactMigration(packageRootImportMigration),
    docsImportPolicy: {
      scannedFileCount: docsFileRecords.length,
      importExampleCount: docsImportExamples.length,
      forbiddenImportExampleCount: docsForbiddenImportExamples.length,
      forbiddenImportExamples: docsForbiddenImportExamples.map((row) => ({
        file: row.file,
        line: row.line,
        specifier: row.specifier,
        text: row.text,
      })),
    },
    summary: {
      expectedBadImportCount: EXPECTED_BAD_IMPORT_COUNT,
      allowlistOk: channelImportAllowlist.ok === true,
      allowlistStableRelativeImportCount: channelImportAllowlist.summary?.stableRelativeImportCount ?? null,
      allowlistRelativeBlockerCount,
      migrationOk: packageRootImportMigration.ok === true,
      migrationAllowlistBlockerCount,
      migrationNonMigratableImportCount: packageRootImportMigration.summary?.nonMigratableImportCount ?? null,
      migrationNonMigratableBlockerCount,
      docsScannedFileCount: docsFileRecords.length,
      docsImportExampleCount: docsImportExamples.length,
      docsForbiddenImportExampleCount: docsForbiddenImportExamples.length,
      blockerCount: blockers.length,
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      syntheticFixtureOnly: true,
      channelFixtureSyntheticOnly: true,
      scansDocsImportExamples: true,
      mutatesDocsFiles: false,
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
  const regressionHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    fixture: report.fixture,
    allowlistRegression: report.allowlistRegression,
    migrationRegression: report.migrationRegression,
    docsImportPolicy: report.docsImportPolicy,
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    regressionHash,
    hash: regressionHash,
  };
}

export function summarizePackageRootImportRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_package_root_import_regression',
    ok: report?.ok === true,
    regressionHash: report?.regressionHash || null,
    expectedBadImportCount: report?.summary?.expectedBadImportCount || 0,
    allowlistStableRelativeImportCount: report?.summary?.allowlistStableRelativeImportCount || 0,
    allowlistRelativeBlockerCount: report?.summary?.allowlistRelativeBlockerCount || 0,
    migrationNonMigratableImportCount: report?.summary?.migrationNonMigratableImportCount || 0,
    migrationNonMigratableBlockerCount: report?.summary?.migrationNonMigratableBlockerCount || 0,
    docsScannedFileCount: report?.summary?.docsScannedFileCount || 0,
    docsImportExampleCount: report?.summary?.docsImportExampleCount || 0,
    docsForbiddenImportExampleCount: report?.summary?.docsForbiddenImportExampleCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: report?.safety?.localOnly === true,
      readOnly: report?.safety?.readOnly === true,
      syntheticFixtureOnly: report?.safety?.syntheticFixtureOnly === true,
      channelFixtureSyntheticOnly: report?.safety?.channelFixtureSyntheticOnly === true,
      scansDocsImportExamples: report?.safety?.scansDocsImportExamples === true,
      mutatesDocsFiles: report?.safety?.mutatesDocsFiles === true,
      mutatesChannelFiles: report?.safety?.mutatesChannelFiles === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
    },
  };
}

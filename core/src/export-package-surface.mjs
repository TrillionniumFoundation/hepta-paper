#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './hash-utils.mjs';
import { summarizePackageExportSurface } from './integration-gate-tooling.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

export const PACKAGE_SURFACE_REPORT_VERSION = 2;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_PACKAGE_NAME = 'design-production-core';
const PACKAGE_SCRIPT_ID_PATTERN = /^[a-z][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)*$/;
const LOCAL_NODE_SCRIPT_COMMAND_PATTERN = /^node (?<targetFile>src\/[A-Za-z0-9-]+\.mjs)(?<flags>(?: --(?:strict|dry-run))*)$/;
const FORBIDDEN_PACKAGE_LIFECYCLE_SCRIPT_IDS = Object.freeze([
  'install',
  'postinstall',
  'postpack',
  'postprepare',
  'postpublish',
  'preinstall',
  'prepack',
  'preprepare',
  'prepublish',
  'prepublishOnly',
  'prepare',
  'publish',
]);
const FORBIDDEN_PACKAGE_DEPENDENCY_FIELDS = Object.freeze([
  'bundleDependencies',
  'bundledDependencies',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);
const FORBIDDEN_PACKAGE_DISTRIBUTION_FIELDS = Object.freeze([
  'bin',
  'directories',
  'files',
  'man',
]);

const PACKAGE_SCRIPT_POLICY_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'external_package_script_detection',
    expectedBlockerCode: 'package_surface_package_script_not_local_node',
    mutate(packageScripts) {
      packageScripts.selftest = ['c', 'url https://example.invalid/install.sh'].join('');
    },
  }),
  Object.freeze({
    scenarioId: 'missing_package_script_target_detection',
    expectedBlockerCode: 'package_surface_package_script_target_missing',
    mutate(packageScripts) {
      packageScripts.selftest = 'node src/missing-package-script-target.mjs';
    },
  }),
  Object.freeze({
    scenarioId: 'invalid_package_script_id_detection',
    expectedBlockerCode: 'package_surface_package_script_id_invalid',
    mutate(packageScripts) {
      packageScripts['Bad Script'] = 'node src/selftest.mjs';
    },
  }),
  Object.freeze({
    scenarioId: 'implicit_lifecycle_script_detection',
    expectedBlockerCode: 'package_surface_package_script_lifecycle_forbidden',
    mutate(packageScripts) {
      packageScripts.postinstall = 'node src/selftest.mjs';
    },
  }),
]);

const PACKAGE_MANIFEST_POLICY_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'private_flag_drift_detection',
    expectedBlockerCode: 'package_surface_private_flag_missing',
    mutate(packageJson) {
      packageJson.private = false;
    },
  }),
  Object.freeze({
    scenarioId: 'main_export_drift_detection',
    expectedBlockerCode: 'package_surface_main_export_mismatch',
    mutate(packageJson) {
      packageJson.main = './src/drifted-index.mjs';
    },
  }),
  Object.freeze({
    scenarioId: 'dependency_field_detection',
    expectedBlockerCode: 'package_surface_dependency_field_forbidden',
    mutate(packageJson) {
      packageJson.dependencies = { leftpad: '1.0.0' };
    },
  }),
  Object.freeze({
    scenarioId: 'distribution_field_detection',
    expectedBlockerCode: 'package_surface_distribution_field_forbidden',
    mutate(packageJson) {
      packageJson.bin = { 'design-production-core': 'src/index.mjs' };
    },
  }),
]);

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
}

function parseLocalNodeScriptCommand(command) {
  const match = LOCAL_NODE_SCRIPT_COMMAND_PATTERN.exec(String(command || ''));
  if (!match) return null;
  const flags = String(match.groups.flags || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return {
    targetFile: match.groups.targetFile,
    flags,
  };
}

export function summarizePackageScripts(packageScripts = {}, { rootDir = packageRoot } = {}) {
  const records = Object.entries(packageScripts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([scriptId, command]) => {
      const commandText = String(command || '');
      const parsed = parseLocalNodeScriptCommand(commandText);
      const scriptIdOk = PACKAGE_SCRIPT_ID_PATTERN.test(scriptId);
      const lifecycleForbidden = FORBIDDEN_PACKAGE_LIFECYCLE_SCRIPT_IDS.includes(scriptId);
      const commandShapeOk = Boolean(parsed);
      const targetExists = parsed
        ? fs.existsSync(path.join(rootDir, parsed.targetFile))
        : false;
      const blockers = [
        ...(!scriptIdOk ? ['package_surface_package_script_id_invalid'] : []),
        ...(lifecycleForbidden ? ['package_surface_package_script_lifecycle_forbidden'] : []),
        ...(!commandShapeOk ? ['package_surface_package_script_not_local_node'] : []),
        ...(commandShapeOk && !targetExists ? ['package_surface_package_script_target_missing'] : []),
      ];
      return {
        scriptId,
        command: commandText,
        status: blockers.length ? 'blocked_package_script_policy' : 'pass_package_script_policy',
        ok: blockers.length === 0,
        scriptIdOk,
        lifecycleForbidden,
        commandShapeOk,
        targetFile: parsed?.targetFile || null,
        targetExists,
        flags: parsed?.flags || [],
        blockers,
      };
    });
  const blockers = records.flatMap((record) => record.blockers.map((code) => ({
    code,
    scriptId: record.scriptId,
    notes: code === 'package_surface_package_script_id_invalid'
      ? `${record.scriptId} must use lowercase package-script id segments.`
      : code === 'package_surface_package_script_lifecycle_forbidden'
        ? `${record.scriptId} must not be an implicit npm lifecycle script.`
      : code === 'package_surface_package_script_target_missing'
        ? `${record.scriptId} must point at an existing local src/*.mjs file.`
        : `${record.scriptId} must run a local node src/*.mjs script with only --strict/--dry-run flags.`,
  })));
  const summary = {
    packageScriptPolicyOk: blockers.length === 0,
    packageScriptCount: records.length,
    localNodePackageScriptCount: records.filter((record) => record.commandShapeOk).length,
    existingTargetPackageScriptCount: records.filter((record) => record.commandShapeOk && record.targetExists).length,
    disallowedPackageScriptCount: records.filter((record) => !record.commandShapeOk).length,
    invalidPackageScriptIdCount: records.filter((record) => !record.scriptIdOk).length,
    forbiddenLifecyclePackageScriptCount: records.filter((record) => record.lifecycleForbidden).length,
    missingPackageScriptTargetCount: records.filter((record) => record.commandShapeOk && !record.targetExists).length,
  };
  return {
    ok: summary.packageScriptPolicyOk,
    status: summary.packageScriptPolicyOk ? 'pass_package_script_policy' : 'blocked_package_script_policy',
    summary,
    records,
    blockers,
  };
}

function runPackageScriptPolicyScenarios(packageScripts, { rootDir = packageRoot } = {}) {
  return PACKAGE_SCRIPT_POLICY_SCENARIOS.map((scenario) => {
    const mutatedScripts = { ...packageScripts };
    scenario.mutate(mutatedScripts);
    const result = summarizePackageScripts(mutatedScripts, { rootDir });
    const observedBlockerCodes = result.blockers.map((item) => item.code);
    const passed = result.ok === false && observedBlockerCodes.includes(scenario.expectedBlockerCode);
    return {
      scenarioId: scenario.scenarioId,
      status: passed ? 'pass_package_script_policy_scenario' : 'blocked_package_script_policy_scenario',
      expectedBlockerCode: scenario.expectedBlockerCode,
      observedBlockerCodes,
    };
  });
}

function hasOwnValue(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function packageRootExportTarget(packageJson = {}) {
  const exportsField = packageJson.exports || {};
  return typeof exportsField === 'object' && exportsField && typeof exportsField['.'] === 'string'
    ? exportsField['.']
    : null;
}

export function summarizePackageManifestSurface(packageJson = {}) {
  const rootExportTarget = packageRootExportTarget(packageJson);
  const dependencyFields = FORBIDDEN_PACKAGE_DEPENDENCY_FIELDS.map((field) => ({
    field,
    present: hasOwnValue(packageJson, field),
    valueType: hasOwnValue(packageJson, field) ? typeof packageJson[field] : null,
  }));
  const distributionFields = FORBIDDEN_PACKAGE_DISTRIBUTION_FIELDS.map((field) => ({
    field,
    present: hasOwnValue(packageJson, field),
    valueType: hasOwnValue(packageJson, field) ? typeof packageJson[field] : null,
  }));
  const blockers = [
    ...dependencyFields
      .filter((record) => record.present)
      .map((record) => ({
        code: 'package_surface_dependency_field_forbidden',
        field: record.field,
        notes: `${record.field} must stay absent so package surface remains dependency-free.`,
      })),
    ...distributionFields
      .filter((record) => record.present)
      .map((record) => ({
        code: 'package_surface_distribution_field_forbidden',
        field: record.field,
        notes: `${record.field} must stay absent so package surface does not add npm distribution entrypoints.`,
      })),
  ];
  const identityBlockers = [
    ...(packageJson.name !== EXPECTED_PACKAGE_NAME ? [{
      code: 'package_surface_name_unstable',
      field: 'name',
      notes: `package name must remain ${EXPECTED_PACKAGE_NAME}.`,
    }] : []),
    ...(packageJson.private !== true ? [{
      code: 'package_surface_private_flag_missing',
      field: 'private',
      notes: 'package.json private must remain true so registry publication is structurally blocked.',
    }] : []),
    ...(packageJson.type !== 'module' ? [{
      code: 'package_surface_type_not_module',
      field: 'type',
      notes: 'package.json type must remain module for stable ESM package imports.',
    }] : []),
    ...(packageJson.main !== rootExportTarget ? [{
      code: 'package_surface_main_export_mismatch',
      field: 'main',
      notes: 'package.json main must match the root exports target.',
    }] : []),
  ];
  blockers.unshift(...identityBlockers);
  const summary = {
    packageManifestPolicyOk: blockers.length === 0,
    packageIdentityPolicyOk: identityBlockers.length === 0,
    packageNameStable: packageJson.name === EXPECTED_PACKAGE_NAME,
    packagePrivate: packageJson.private === true,
    packageTypeModule: packageJson.type === 'module',
    packageMain: packageJson.main || null,
    packageRootExport: rootExportTarget,
    packageMainMatchesRootExport: packageJson.main === rootExportTarget,
    forbiddenDependencyFieldCount: dependencyFields.length,
    presentDependencyFieldCount: dependencyFields.filter((record) => record.present).length,
    forbiddenDistributionFieldCount: distributionFields.length,
    presentDistributionFieldCount: distributionFields.filter((record) => record.present).length,
  };
  return {
    ok: summary.packageManifestPolicyOk,
    status: summary.packageManifestPolicyOk ? 'pass_package_manifest_policy' : 'blocked_package_manifest_policy',
    summary,
    dependencyFields,
    distributionFields,
    blockers,
  };
}

function runPackageManifestPolicyScenarios(packageJson) {
  return PACKAGE_MANIFEST_POLICY_SCENARIOS.map((scenario) => {
    const mutatedPackageJson = {
      ...packageJson,
      scripts: { ...(packageJson.scripts || {}) },
      exports: { ...(packageJson.exports || {}) },
    };
    scenario.mutate(mutatedPackageJson);
    const result = summarizePackageManifestSurface(mutatedPackageJson);
    const observedBlockerCodes = result.blockers.map((item) => item.code);
    const passed = result.ok === false && observedBlockerCodes.includes(scenario.expectedBlockerCode);
    return {
      scenarioId: scenario.scenarioId,
      status: passed ? 'pass_package_manifest_policy_scenario' : 'blocked_package_manifest_policy_scenario',
      expectedBlockerCode: scenario.expectedBlockerCode,
      observedBlockerCodes,
    };
  });
}

async function captureImport(specifier) {
  try {
    const module = await import(specifier);
    return {
      specifier,
      ok: true,
      errorCode: null,
      errorMessage: null,
      exportedKeys: Object.keys(module).sort((left, right) => left.localeCompare(right)),
      publicModuleCount: Array.isArray(module.CORE_PUBLIC_MODULES) ? module.CORE_PUBLIC_MODULES.length : null,
      compatibilityModuleCount: Array.isArray(module.CORE_COMPATIBILITY_MODULES)
        ? module.CORE_COMPATIBILITY_MODULES.length
        : null,
      zeroCompatibilityInvariant: module.publicApiSummary?.().stability?.zeroCompatibilityInvariant === true,
    };
  } catch (error) {
    return {
      specifier,
      ok: false,
      errorCode: error?.code || null,
      errorMessage: error?.message || String(error),
      exportedKeys: [],
      publicModuleCount: null,
      compatibilityModuleCount: null,
      zeroCompatibilityInvariant: false,
    };
  }
}

export async function buildPackageSurfaceReport({ generatedAt = new Date().toISOString() } = {}) {
  const packageJson = readPackageJson();
  const packageExportSurface = summarizePackageExportSurface(packageJson.exports || {});
  const packageManifestPolicy = summarizePackageManifestSurface(packageJson);
  const packageManifestPolicyScenarios = runPackageManifestPolicyScenarios(packageJson);
  const packageScriptPolicy = summarizePackageScripts(packageJson.scripts || {});
  const packageScriptPolicyScenarios = runPackageScriptPolicyScenarios(packageJson.scripts || {});
  const rootImport = await captureImport(packageJson.name);
  const deepImport = await captureImport(`${packageJson.name}/src/index.mjs`);
  const blockers = [
    ...(!packageExportSurface.packageStableOnly ? [{
      code: 'package_surface_export_map_not_stable_only',
      notes: 'package.json exports must expose only the package root and ./package.json metadata.',
    }] : []),
    ...(!rootImport.ok ? [{
      code: 'package_surface_root_import_failed',
      notes: `${packageJson.name} root import failed: ${rootImport.errorCode || rootImport.errorMessage}`,
    }] : []),
    ...(rootImport.ok && rootImport.compatibilityModuleCount !== 0 ? [{
      code: 'package_surface_root_import_has_compatibility_modules',
      notes: `${packageJson.name} root import reported ${rootImport.compatibilityModuleCount} compatibility modules.`,
    }] : []),
    ...(rootImport.ok && rootImport.zeroCompatibilityInvariant !== true ? [{
      code: 'package_surface_root_import_zero_invariant_missing',
      notes: `${packageJson.name} root import did not expose zeroCompatibilityInvariant=true.`,
    }] : []),
    ...(deepImport.errorCode !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' ? [{
      code: 'package_surface_deep_src_import_not_blocked',
      notes: `${packageJson.name}/src/index.mjs should fail with ERR_PACKAGE_PATH_NOT_EXPORTED, got ${deepImport.ok ? 'import_ok' : deepImport.errorCode || 'unknown_error'}.`,
    }] : []),
    ...packageManifestPolicy.blockers,
    ...packageManifestPolicyScenarios
      .filter((scenario) => scenario.status !== 'pass_package_manifest_policy_scenario')
      .map((scenario) => ({
        code: 'package_surface_package_manifest_policy_scenario_failed',
        scenarioId: scenario.scenarioId,
        notes: `${scenario.scenarioId} must observe ${scenario.expectedBlockerCode}.`,
      })),
    ...packageScriptPolicy.blockers,
    ...packageScriptPolicyScenarios
      .filter((scenario) => scenario.status !== 'pass_package_script_policy_scenario')
      .map((scenario) => ({
        code: 'package_surface_package_script_policy_scenario_failed',
        scenarioId: scenario.scenarioId,
        notes: `${scenario.scenarioId} must observe ${scenario.expectedBlockerCode}.`,
      })),
  ];
  const report = {
    version: PACKAGE_SURFACE_REPORT_VERSION,
    kind: 'PackageSurfaceReport',
    status: blockers.length ? 'blocked_package_surface' : 'pass_package_surface',
    ok: blockers.length === 0,
    generatedAt,
    packageName: packageJson.name,
    packageRoot: relativeToWorkspace(packageRoot),
    packageExportSurface,
    packageManifestPolicy: {
      expectedPackageName: EXPECTED_PACKAGE_NAME,
      dependencyFields: packageManifestPolicy.dependencyFields,
      distributionFields: packageManifestPolicy.distributionFields,
    },
    packageManifestPolicyScenarios,
    packageScripts: packageScriptPolicy.records,
    packageScriptPolicyScenarios,
    rootImport,
    deepImport,
    summary: {
      packageStableOnly: packageExportSurface.packageStableOnly,
      packageRootExport: packageExportSurface.rootExportTarget,
      packageDeepSrcExportCount: packageExportSurface.packageDeepSrcExportCount,
      packageExtraExportCount: packageExportSurface.packageExtraExportCount,
      rootImportOk: rootImport.ok,
      rootPublicModuleCount: rootImport.publicModuleCount,
      rootCompatibilityModuleCount: rootImport.compatibilityModuleCount,
      rootZeroCompatibilityInvariant: rootImport.zeroCompatibilityInvariant,
      deepImportBlocked: deepImport.errorCode === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      ...packageManifestPolicy.summary,
      passedPackageManifestPolicyScenarioCount: packageManifestPolicyScenarios
        .filter((scenario) => scenario.status === 'pass_package_manifest_policy_scenario').length,
      packageManifestPolicyScenarioCount: packageManifestPolicyScenarios.length,
      ...packageScriptPolicy.summary,
      passedPackageScriptPolicyScenarioCount: packageScriptPolicyScenarios
        .filter((scenario) => scenario.status === 'pass_package_script_policy_scenario').length,
      packageScriptPolicyScenarioCount: packageScriptPolicyScenarios.length,
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
  const surfaceHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    packageName: report.packageName,
    packageExportSurface: report.packageExportSurface,
    packageManifestPolicy: report.packageManifestPolicy,
    packageManifestPolicyScenarios: report.packageManifestPolicyScenarios,
    packageScripts: report.packageScripts,
    packageScriptPolicyScenarios: report.packageScriptPolicyScenarios,
    rootImport: {
      ok: report.rootImport.ok,
      publicModuleCount: report.rootImport.publicModuleCount,
      compatibilityModuleCount: report.rootImport.compatibilityModuleCount,
      zeroCompatibilityInvariant: report.rootImport.zeroCompatibilityInvariant,
    },
    deepImport: {
      ok: report.deepImport.ok,
      errorCode: report.deepImport.errorCode,
    },
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    surfaceHash,
    hash: surfaceHash,
  };
}

function markdownFor(report) {
  const lines = [
    '# Package Surface',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.surfaceHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Package stable only: ${report.summary.packageStableOnly}`,
    `- Package root export: ${report.summary.packageRootExport || 'null'}`,
    `- Package deep src exports: ${report.summary.packageDeepSrcExportCount}`,
    `- Package extra exports: ${report.summary.packageExtraExportCount}`,
    `- Root import ok: ${report.summary.rootImportOk}`,
    `- Root public modules: ${report.summary.rootPublicModuleCount}`,
    `- Root compatibility modules: ${report.summary.rootCompatibilityModuleCount}`,
    `- Root zero compatibility invariant: ${report.summary.rootZeroCompatibilityInvariant}`,
    `- Deep import blocked: ${report.summary.deepImportBlocked}`,
    `- Package manifest policy ok: ${report.summary.packageManifestPolicyOk}`,
    `- Package identity policy ok: ${report.summary.packageIdentityPolicyOk}`,
    `- Package private/module/main: private=${report.summary.packagePrivate}; typeModule=${report.summary.packageTypeModule}; main=${report.summary.packageMain || 'null'}; rootExport=${report.summary.packageRootExport || 'null'}; mainMatchesRootExport=${report.summary.packageMainMatchesRootExport}`,
    `- Package dependency fields: ${report.summary.presentDependencyFieldCount}/${report.summary.forbiddenDependencyFieldCount} present`,
    `- Package distribution fields: ${report.summary.presentDistributionFieldCount}/${report.summary.forbiddenDistributionFieldCount} present`,
    `- Package manifest policy scenarios: ${report.summary.passedPackageManifestPolicyScenarioCount}/${report.summary.packageManifestPolicyScenarioCount}`,
    `- Package script policy ok: ${report.summary.packageScriptPolicyOk}`,
    `- Package scripts: ${report.summary.localNodePackageScriptCount}/${report.summary.packageScriptCount} local node; existing targets ${report.summary.existingTargetPackageScriptCount}; disallowed ${report.summary.disallowedPackageScriptCount}; invalid ids ${report.summary.invalidPackageScriptIdCount}; lifecycle ${report.summary.forbiddenLifecyclePackageScriptCount}; missing targets ${report.summary.missingPackageScriptTargetCount}`,
    `- Package script policy scenarios: ${report.summary.passedPackageScriptPolicyScenarioCount}/${report.summary.packageScriptPolicyScenarioCount}`,
    `- Blockers: ${report.summary.blockerCount}`,
    '',
    '## Imports',
    '',
    `- Root: ${report.rootImport.specifier} -> ${report.rootImport.ok ? 'ok' : report.rootImport.errorCode || 'error'}`,
    `- Deep src: ${report.deepImport.specifier} -> ${report.deepImport.ok ? 'ok' : report.deepImport.errorCode || 'error'}`,
    '',
    '## Package Manifest Policy',
    '',
    '| Field | Group | Present |',
    '| --- | --- | --- |',
    ...report.packageManifestPolicy.dependencyFields.map((item) => `| ${item.field} | dependency | ${item.present} |`),
    ...report.packageManifestPolicy.distributionFields.map((item) => `| ${item.field} | distribution | ${item.present} |`),
    '',
    '## Manifest Policy Scenarios',
    '',
    '| Scenario | Status | Expected blocker | Observed blockers |',
    '| --- | --- | --- | --- |',
    ...report.packageManifestPolicyScenarios.map((item) => `| ${item.scenarioId} | ${item.status} | ${item.expectedBlockerCode} | ${item.observedBlockerCodes.join('<br>') || 'none'} |`),
    '',
    '## Package Scripts',
    '',
    '| Script | Status | Target | Flags |',
    '| --- | --- | --- | --- |',
    ...report.packageScripts.map((item) => `| ${item.scriptId} | ${item.status} | ${item.targetFile || 'not-local-node'} | ${item.flags.join(' ') || 'none'} |`),
    '',
    '## Script Policy Scenarios',
    '',
    '| Scenario | Status | Expected blocker | Observed blockers |',
    '| --- | --- | --- | --- |',
    ...report.packageScriptPolicyScenarios.map((item) => `| ${item.scenarioId} | ${item.status} | ${item.expectedBlockerCode} | ${item.observedBlockerCodes.join('<br>') || 'none'} |`),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code} ${item.field || item.scriptId || item.scenarioId || ''}: ${item.notes}`.trim())
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Local package import smoke test only.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, channel-state fetch, or state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'package-surface-latest.json',
    markdown: markdownFor(report),
  });
}

async function main() {
  const strict = process.argv.includes('--strict');
  const report = await buildPackageSurfaceReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    surfaceHash: report.surfaceHash,
    summary: report.summary,
    blockers: report.blockers.map((item) => item.code),
    reportFiles: {
      json: relativeToWorkspace(reportFiles.latestJson),
      md: relativeToWorkspace(reportFiles.latestMd),
    },
  }, null, 2)}\n`);
  if (strict && !report.ok) process.exitCode = 1;
}

if (isCliEntrypoint(import.meta.url)) main();

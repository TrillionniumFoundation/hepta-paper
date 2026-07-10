import { digest } from './hash-utils.mjs';

export const INTEGRATION_GATE_TOOLING_VERSION = 81;

export const INTEGRATION_GATE_TOOLING_STABLE_MODULE_ID = 'integration-gate-tooling';

export const INTEGRATION_GATE_TOOLING_CLI_ONLY_MODULE_IDS = Object.freeze([
  'integration-dependency-audit',
]);

export const INTEGRATION_GATE_TOOLING_REQUIRED_SCRIPT_IDS = Object.freeze([
  'audit:integration',
  'audit:integration:strict',
  'gate:integration',
  'gate:integration:strict',
  'checkpoint:architecture',
  'compatibility:policy',
  'readonly:report-chain',
  'reports:freshness',
  'reports:freshness-regression',
  'reports:gate-sequence-regression',
  'reports:inventory-consistency',
  'reports:schema-contract',
  'reports:lineage-topology',
  'reports:hash-stability-regression',
  'reports:output-pairing',
  'reports:artifact-reproducibility',
  'reports:self-reference-boundary-regression',
  'reports:contract-manifest',
  'reports:contract-required-coverage-regression',
  'reports:contract-doc-coverage-regression',
  'reports:contract-syntax-coverage-regression',
  'reports:contract-source-derivation-regression',
  'reports:contract-summary-key-regression',
  'reports:contract-audit-forwarding-regression',
  'reports:contract-checkpoint-binding-shape-regression',
  'reports:contract-gate-summary-shape-regression',
  'reports:contract-exporter-stdout-shape-regression',
  'reports:contract-safety-flag-regression',
  'reports:contract-artifact-binding-regression',
  'reports:contract-doc-index-anchor-regression',
  'reports:contract-doc-page-latest-detail-regression',
  'reports:contract-doc-page-command-section-regression',
  'reports:contract-doc-page-safety-section-detail-regression',
  'reports:contract-doc-page-strict-gate-section-regression',
  'reports:contract-doc-page-output-section-regression',
  'reports:contract-doc-page-cross-report-section-regression',
  'reports:contract-doc-page-closeout-section-regression',
  'reports:contract-doc-page-post-gate-writer-section-regression',
  'reports:contract-doc-page-retention-section-regression',
  'reports:contract-doc-page-freshness-hash-section-regression',
  'reports:contract-doc-page-checkpoint-hash-section-regression',
  'reports:contract-doc-page-bootstrap-seed-section-regression',
  'reports:contract-doc-page-clean-rerun-section-regression',
  'reports:contract-doc-page-final-settlement-section-regression',
  'reports:contract-doc-page-closeout-index-section-regression',
  'reports:contract-doc-page-closeout-evidence-section-regression',
  'reports:contract-doc-page-closeout-ledger-section-regression',
  'reports:contract-doc-page-closeout-retention-proof-section-regression',
  'reports:contract-doc-page-closeout-probe-bundle-section-regression',
  'reports:contract-doc-page-closeout-signoff-section-regression',
  'reports:contract-doc-page-closeout-release-manifest-section-regression',
  'reports:contract-doc-page-release-archive-index-section-regression',
  'reports:contract-doc-page-release-handoff-ledger-section-regression',
  'reports:contract-doc-page-release-delivery-readiness-section-regression',
  'reports:contract-doc-page-release-execution-denial-section-regression',
  'reports:contract-doc-page-release-operator-approval-section-regression',
  'reports:contract-doc-page-release-approval-ledger-section-regression',
  'reports:contract-doc-page-release-action-queue-section-regression',
  'reports:contract-doc-page-release-runner-dispatch-denial-section-regression',
  'reports:contract-doc-page-release-live-action-preflight-section-regression',
  'reports:contract-doc-page-release-execution-intent-capture-section-regression',
  'reports:contract-doc-page-release-execution-approval-boundary-section-regression',
  'reports:contract-doc-page-release-runner-execution-gate-section-regression',
  'reports:contract-doc-page-release-dispatch-implementation-denial-section-regression',
  'reports:contract-doc-page-release-platform-state-snapshot-denial-section-regression',
  'reports:contract-doc-page-release-dry-run-replay-denial-section-regression',
  'reports:contract-doc-page-release-proof-bundle-denial-section-regression',
  'reports:contract-doc-page-release-ledger-denial-section-regression',
  'reports:contract-doc-page-release-audit-evidence-denial-section-regression',
  'reports:contract-doc-page-release-receipt-evidence-denial-section-regression',
  'reports:contract-doc-page-release-post-action-receipt-denial-section-regression',
  'reports:contract-doc-page-release-post-action-audit-denial-section-regression',
  'reports:contract-doc-page-release-post-action-reconciliation-denial-section-regression',
  'reports:contract-doc-page-release-post-action-settlement-denial-section-regression',
  'reports:contract-doc-page-release-post-action-acceptance-denial-section-regression',
  'reports:contract-doc-page-release-post-action-payment-denial-section-regression',
  'reports:contract-doc-page-release-post-action-deployment-denial-section-regression',
  'reports:contract-doc-page-release-post-action-provider-spend-denial-section-regression',
  'reports:contract-doc-page-release-post-action-state-transition-denial-section-regression',
  'reports:contract-doc-page-release-post-action-queue-consumption-denial-section-regression',
  'reports:contract-doc-page-release-post-action-background-runner-denial-section-regression',
  'reports:contract-doc-page-release-post-action-dispatch-completion-denial-section-regression',
  'reports:manifest-drift-regression',
  'reports:latest-recovery-regression',
  'reports:bootstrap-seed-regression',
  'reports:gate-clean-rerun-regression',
  'reports:clean-gate-idempotence-regression',
  'reports:final-settlement-regression',
  'reports:post-final-drift-regression',
  'reports:closeout-drift-classification-regression',
  'reports:closeout-command-inventory-regression',
  'reports:runner-contract-regression',
  'runtime:dry-run-harness',
  'runtime:channel-runner-coverage-matrix',
  'runtime:post-action-evidence-matrix',
  'runtime:post-action-audit-bundle-matrix',
  'runtime:post-action-audit-archive-matrix',
  'runtime:post-action-replay-guard-matrix',
  'runtime:post-action-dispatch-envelope-matrix',
  'runtime:post-action-dispatch-completion-matrix',
  'runtime:post-action-reconciliation-matrix',
  'runtime:post-action-runtime-status',
  'reports:retention-regression',
  'package:surface',
  'channel:imports',
  'package-root:resolver',
  'package-root:migration',
  'package-root:regression',
  'package-root:symbols',
  'package-root:symbol-regression',
  'package-root:symbol-minimize',
  'schema:contracts',
  'selftest',
  'selftest:lanes',
  'reports:prune',
  'reports:prune:dry-run',
]);

export const INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS = Object.freeze([
  'integration-dependency-audit-latest.json',
  'compatibility-export-policy-latest.json',
  'read-only-report-chain-latest.json',
  'report-freshness-latest.json',
  'report-freshness-regression-latest.json',
  'integration-gate-sequence-regression-latest.json',
  'report-inventory-consistency-latest.json',
  'report-schema-contract-latest.json',
  'report-lineage-topology-latest.json',
  'report-hash-stability-regression-latest.json',
  'report-output-pairing-latest.json',
  'report-artifact-reproducibility-latest.json',
  'report-self-reference-boundary-regression-latest.json',
  'report-contract-manifest-latest.json',
  'report-contract-required-coverage-regression-latest.json',
  'report-contract-doc-coverage-regression-latest.json',
  'report-contract-syntax-coverage-regression-latest.json',
  'report-contract-source-derivation-regression-latest.json',
  'report-contract-summary-key-regression-latest.json',
  'report-contract-audit-forwarding-regression-latest.json',
  'report-contract-checkpoint-binding-shape-regression-latest.json',
  'report-contract-gate-summary-shape-regression-latest.json',
  'report-contract-exporter-stdout-shape-regression-latest.json',
  'report-contract-safety-flag-regression-latest.json',
  'report-contract-artifact-binding-regression-latest.json',
  'report-contract-doc-index-anchor-regression-latest.json',
  'report-contract-doc-page-latest-detail-regression-latest.json',
  'report-contract-doc-page-command-section-regression-latest.json',
  'report-contract-doc-page-safety-section-detail-regression-latest.json',
  'report-contract-doc-page-strict-gate-section-regression-latest.json',
  'report-contract-doc-page-output-section-regression-latest.json',
  'report-contract-doc-page-cross-report-section-regression-latest.json',
  'report-contract-doc-page-closeout-section-regression-latest.json',
  'report-contract-doc-page-post-gate-writer-section-regression-latest.json',
  'report-contract-doc-page-retention-section-regression-latest.json',
  'report-contract-doc-page-freshness-hash-section-regression-latest.json',
  'report-contract-doc-page-checkpoint-hash-section-regression-latest.json',
  'report-contract-doc-page-bootstrap-seed-section-regression-latest.json',
  'report-contract-doc-page-clean-rerun-section-regression-latest.json',
  'report-contract-doc-page-final-settlement-section-regression-latest.json',
  'report-contract-doc-page-closeout-index-section-regression-latest.json',
  'report-contract-doc-page-closeout-evidence-section-regression-latest.json',
  'report-contract-doc-page-closeout-ledger-section-regression-latest.json',
  'report-contract-doc-page-closeout-retention-proof-section-regression-latest.json',
  'report-contract-doc-page-closeout-probe-bundle-section-regression-latest.json',
  'report-contract-doc-page-closeout-signoff-section-regression-latest.json',
  'report-contract-doc-page-closeout-release-manifest-section-regression-latest.json',
  'report-contract-doc-page-release-archive-index-section-regression-latest.json',
  'report-contract-doc-page-release-handoff-ledger-section-regression-latest.json',
  'report-contract-doc-page-release-delivery-readiness-section-regression-latest.json',
  'report-contract-doc-page-release-execution-denial-section-regression-latest.json',
  'report-contract-doc-page-release-operator-approval-section-regression-latest.json',
  'report-contract-doc-page-release-approval-ledger-section-regression-latest.json',
  'report-contract-doc-page-release-action-queue-section-regression-latest.json',
  'report-contract-doc-page-release-runner-dispatch-denial-section-regression-latest.json',
  'report-contract-doc-page-release-live-action-preflight-section-regression-latest.json',
  'report-contract-doc-page-release-execution-intent-capture-section-regression-latest.json',
  'report-contract-doc-page-release-execution-approval-boundary-section-regression-latest.json',
  'report-contract-doc-page-release-runner-execution-gate-section-regression-latest.json',
  'report-contract-doc-page-release-dispatch-implementation-denial-section-regression-latest.json',
  'report-contract-doc-page-release-platform-state-snapshot-denial-section-regression-latest.json',
  'report-contract-doc-page-release-dry-run-replay-denial-section-regression-latest.json',
  'report-contract-doc-page-release-proof-bundle-denial-section-regression-latest.json',
  'report-contract-doc-page-release-ledger-denial-section-regression-latest.json',
  'report-contract-doc-page-release-audit-evidence-denial-section-regression-latest.json',
  'report-contract-doc-page-release-receipt-evidence-denial-section-regression-latest.json',
  'report-contract-doc-page-release-post-action-receipt-denial-section-regression-latest.json',
  'report-contract-doc-page-release-post-action-audit-denial-section-regression-latest.json',
  'report-contract-doc-page-release-post-action-reconciliation-denial-section-regression-latest.json',
  'report-contract-doc-page-release-post-action-settlement-denial-section-regression-latest.json',
  'report-contract-doc-page-release-post-action-acceptance-denial-section-regression-latest.json',
  'report-contract-doc-page-release-post-action-payment-denial-section-regression-latest.json',
  'report-contract-doc-page-release-post-action-deployment-denial-section-regression-latest.json',
  'report-contract-doc-page-release-post-action-provider-spend-denial-section-regression-latest.json',
  'report-contract-doc-page-release-post-action-state-transition-denial-section-regression-latest.json',
  'report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression-latest.json',
  'report-contract-doc-page-release-post-action-background-runner-denial-section-regression-latest.json',
  'report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression-latest.json',
  'report-manifest-drift-regression-latest.json',
  'report-latest-recovery-regression-latest.json',
  'report-bootstrap-seed-regression-latest.json',
  'report-gate-clean-rerun-regression-latest.json',
  'report-clean-gate-idempotence-regression-latest.json',
  'report-final-settlement-regression-latest.json',
  'report-post-final-drift-regression-latest.json',
  'report-closeout-drift-classification-regression-latest.json',
  'report-closeout-command-inventory-regression-latest.json',
  'report-runner-contract-regression-latest.json',
  'runtime-dry-run-harness-latest.json',
  'channel-runner-coverage-matrix-latest.json',
  'post-action-evidence-matrix-latest.json',
  'post-action-audit-bundle-matrix-latest.json',
  'post-action-audit-archive-matrix-latest.json',
  'post-action-replay-guard-matrix-latest.json',
  'post-action-dispatch-envelope-matrix-latest.json',
  'post-action-dispatch-completion-matrix-latest.json',
  'post-action-reconciliation-matrix-latest.json',
  'post-action-runtime-status-latest.json',
  'report-retention-regression-latest.json',
  'package-surface-latest.json',
  'channel-import-allowlist-latest.json',
  'package-root-resolver-latest.json',
  'package-root-import-migration-latest.json',
  'package-root-import-regression-latest.json',
  'package-root-symbol-manifest-latest.json',
  'package-root-symbol-regression-latest.json',
  'package-root-symbol-minimization-latest.json',
  'contract-schemas-latest.json',
  'selftest-lanes-latest.json',
  'report-retention-latest.json',
]);

export const INTEGRATION_GATE_TOOLING_PACKAGE_EXPORTS = Object.freeze({
  '.': './src/index.mjs',
  './package.json': './package.json',
});

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values || []) {
    const key = keyFn(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function compactReportBinding(fileId, binding = {}) {
  return {
    fileId,
    exists: binding.exists === true,
    ok: binding.ok === true,
    status: binding.status || null,
    hash: binding.hash || null,
    blockerCount: Number(binding.blockerCount || 0),
  };
}

function normalizePackageExports(exportsField = {}) {
  if (typeof exportsField === 'string') return { '.': exportsField };
  if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) return {};
  const entries = Object.entries(exportsField);
  if (!entries.length) return {};
  const hasSubpathKeys = entries.some(([key]) => key.startsWith('.'));
  if (!hasSubpathKeys) return { '.': exportsField };
  return Object.fromEntries(entries);
}

function packageExportTarget(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of ['default', 'import', 'node', 'require']) {
    if (typeof value[key] === 'string') return value[key];
  }
  return Object.values(value).find((item) => typeof item === 'string') || null;
}

export function summarizePackageExportSurface(packageExports = {}) {
  const normalizedExports = normalizePackageExports(packageExports);
  const exportKeys = Object.keys(normalizedExports).sort((left, right) => left.localeCompare(right));
  const allowedKeys = Object.keys(INTEGRATION_GATE_TOOLING_PACKAGE_EXPORTS);
  const rootExportTarget = packageExportTarget(normalizedExports['.']);
  const packageJsonExportTarget = packageExportTarget(normalizedExports['./package.json']);
  const packageDeepSrcExportKeys = exportKeys.filter((key) => (
    key.startsWith('./src')
      || (key !== '.' && String(packageExportTarget(normalizedExports[key]) || '').startsWith('./src/'))
  ));
  const packageExtraExportKeys = exportKeys.filter((key) => !allowedKeys.includes(key));
  return {
    requiredExports: { ...INTEGRATION_GATE_TOOLING_PACKAGE_EXPORTS },
    normalizedExports: Object.fromEntries(exportKeys.map((key) => [
      key,
      packageExportTarget(normalizedExports[key]),
    ])),
    exportKeys,
    rootExportTarget,
    packageJsonExportTarget,
    packageJsonExportPresent: packageJsonExportTarget === INTEGRATION_GATE_TOOLING_PACKAGE_EXPORTS['./package.json'],
    packageDeepSrcExportKeys,
    packageExtraExportKeys,
    packageDeepSrcExportCount: packageDeepSrcExportKeys.length,
    packageExtraExportCount: packageExtraExportKeys.length,
    packageStableOnly: rootExportTarget === INTEGRATION_GATE_TOOLING_PACKAGE_EXPORTS['.']
      && packageJsonExportTarget === INTEGRATION_GATE_TOOLING_PACKAGE_EXPORTS['./package.json']
      && packageDeepSrcExportKeys.length === 0
      && packageExtraExportKeys.length === 0,
  };
}

export function buildIntegrationGateTooling({
  publicModules = [],
  compatibilityModules = [],
  scriptIds = [],
  reportBindings = {},
  indexSource = '',
  packageExports = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const publicSet = new Set(publicModules);
  const compatibilitySet = new Set(compatibilityModules);
  const scriptSet = new Set(scriptIds);
  const reports = INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS.map((fileId) => compactReportBinding(
    fileId,
    reportBindings[fileId],
  ));
  const rootAuditExportPresent = /export\s+\*\s+from\s+['"]\.\/integration-dependency-audit\.mjs['"]/.test(indexSource);
  const packageExportSurface = summarizePackageExportSurface(packageExports);
  const blockers = [
    ...(!publicSet.has(INTEGRATION_GATE_TOOLING_STABLE_MODULE_ID) ? [{
      code: 'integration_gate_tooling_stable_module_missing',
      notes: `${INTEGRATION_GATE_TOOLING_STABLE_MODULE_ID} must be in CORE_PUBLIC_MODULES.`,
    }] : []),
    ...INTEGRATION_GATE_TOOLING_CLI_ONLY_MODULE_IDS
      .filter((moduleId) => compatibilitySet.has(moduleId))
      .map((moduleId) => ({
        code: 'integration_gate_tooling_cli_module_still_compatibility_export',
        moduleId,
        notes: `${moduleId} is CLI-only gate tooling and must not stay in CORE_COMPATIBILITY_MODULES.`,
      })),
    ...(rootAuditExportPresent ? [{
      code: 'integration_gate_tooling_cli_module_still_root_exported',
      moduleId: 'integration-dependency-audit',
      notes: 'integration-dependency-audit.mjs must be invoked by npm scripts, not exported from src/index.mjs.',
    }] : []),
    ...(packageExportSurface.rootExportTarget !== INTEGRATION_GATE_TOOLING_PACKAGE_EXPORTS['.'] ? [{
      code: 'integration_gate_tooling_package_root_export_missing',
      exportKey: '.',
      notes: `package.json exports["."] must point at ${INTEGRATION_GATE_TOOLING_PACKAGE_EXPORTS['.']} so package-name imports land on the stable public surface.`,
    }] : []),
    ...(!packageExportSurface.packageJsonExportPresent ? [{
      code: 'integration_gate_tooling_package_json_export_missing',
      exportKey: './package.json',
      notes: 'package.json exports must keep ./package.json available for local tooling metadata reads.',
    }] : []),
    ...packageExportSurface.packageDeepSrcExportKeys.map((exportKey) => ({
      code: 'integration_gate_tooling_package_deep_src_export_present',
      exportKey,
      notes: `package export ${exportKey} re-opens src/ implementation files as package subpaths.`,
    })),
    ...packageExportSurface.packageExtraExportKeys.map((exportKey) => ({
      code: 'integration_gate_tooling_package_extra_public_export',
      exportKey,
      notes: `package export ${exportKey} is outside the stable package surface; add to src/index.mjs instead of opening a deep subpath.`,
    })),
    ...INTEGRATION_GATE_TOOLING_REQUIRED_SCRIPT_IDS
      .filter((scriptId) => !scriptSet.has(scriptId))
      .map((scriptId) => ({
        code: 'integration_gate_tooling_required_script_missing',
        scriptId,
        notes: `${scriptId} is required for the local architecture gate toolchain.`,
      })),
    ...reports
      .filter((report) => !report.exists)
      .map((report) => ({
        code: 'integration_gate_tooling_report_missing',
        fileId: report.fileId,
        notes: `${report.fileId} must exist as a latest report before the architecture checkpoint can trust the toolchain.`,
      })),
    ...reports
      .filter((report) => report.exists && report.ok === false)
      .map((report) => ({
        code: 'integration_gate_tooling_report_not_ok',
        fileId: report.fileId,
        notes: `${report.fileId} is not ok: ${report.status || 'unknown'}.`,
      })),
  ];
  const tooling = {
    version: INTEGRATION_GATE_TOOLING_VERSION,
    kind: 'IntegrationGateTooling',
    status: blockers.length ? 'blocked_integration_gate_tooling' : 'pass_integration_gate_tooling',
    ok: blockers.length === 0,
    generatedAt,
    stableModuleId: INTEGRATION_GATE_TOOLING_STABLE_MODULE_ID,
    cliOnlyModuleIds: [...INTEGRATION_GATE_TOOLING_CLI_ONLY_MODULE_IDS],
    packageExportSurface,
    requiredScriptIds: [...INTEGRATION_GATE_TOOLING_REQUIRED_SCRIPT_IDS],
    reports,
    summary: {
      stableModulePresent: publicSet.has(INTEGRATION_GATE_TOOLING_STABLE_MODULE_ID),
      cliOnlyModuleCount: INTEGRATION_GATE_TOOLING_CLI_ONLY_MODULE_IDS.length,
      cliOnlyModulesStillCompatibilityExports: INTEGRATION_GATE_TOOLING_CLI_ONLY_MODULE_IDS
        .filter((moduleId) => compatibilitySet.has(moduleId)),
      rootAuditExportPresent,
      packageRootExport: packageExportSurface.rootExportTarget,
      packageJsonExportPresent: packageExportSurface.packageJsonExportPresent,
      packageDeepSrcExportCount: packageExportSurface.packageDeepSrcExportCount,
      packageExtraExportCount: packageExportSurface.packageExtraExportCount,
      packageStableOnly: packageExportSurface.packageStableOnly,
      requiredScriptCount: INTEGRATION_GATE_TOOLING_REQUIRED_SCRIPT_IDS.length,
      presentRequiredScriptCount: INTEGRATION_GATE_TOOLING_REQUIRED_SCRIPT_IDS
        .filter((scriptId) => scriptSet.has(scriptId)).length,
      reportFileCount: reports.length,
      okReportFileCount: reports.filter((report) => report.ok).length,
      byReportStatus: countBy(reports, (report) => report.status || 'missing_report'),
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
  const toolingHash = digest({
    version: tooling.version,
    kind: tooling.kind,
    status: tooling.status,
    stableModuleId: tooling.stableModuleId,
    cliOnlyModuleIds: tooling.cliOnlyModuleIds,
    packageExportSurface: tooling.packageExportSurface,
    requiredScriptIds: tooling.requiredScriptIds,
    reports: tooling.reports,
    summary: tooling.summary,
    blockers: tooling.blockers,
    safety: tooling.safety,
  });
  return {
    ...tooling,
    toolingHash,
    hash: toolingHash,
  };
}

export function summarizeIntegrationGateTooling(tooling) {
  return {
    version: tooling?.version || null,
    status: tooling?.status || 'missing_integration_gate_tooling',
    ok: tooling?.ok === true,
    toolingHash: tooling?.toolingHash || null,
    requiredScriptCount: tooling?.summary?.requiredScriptCount || 0,
    reportFileCount: tooling?.summary?.reportFileCount || 0,
    packageStableOnly: tooling?.summary?.packageStableOnly === true,
    blockerCount: tooling?.summary?.blockerCount || 0,
    safety: {
      localOnly: tooling?.safety?.localOnly === true,
      readOnly: tooling?.safety?.readOnly === true,
      executesExternalAction: tooling?.safety?.executesExternalAction === true,
    },
  };
}

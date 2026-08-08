// Architecture reachability must start from executable surfaces, not from
// convenient composition modules. Entrypoint categories stay path-only;
// external runtime imports are declared separately as exact, auditable edges.
export const ARCHITECTURE_ENTRYPOINT_MANIFEST = Object.freeze({
  version: 3,
  kind: 'ArchitectureEntrypointManifest',
  production: Object.freeze([
    'paper-core/bin/hepta-paper.mjs',
    'paper-core/bin/workspace-status.mjs',
    'paper-core/bin/hepta-store.mjs',
    'paper-core/bin/automation-status.mjs',
    'paper-core/bin/production-external-authority-intake.mjs',
    // Production process boundaries invoked by systemd or a pinned executable
    // path (including the reviewed /usr/libexec launchers) cannot be discovered
    // through ordinary static imports.
    'paper-core/bin/codex-openclaw-managed.mjs',
    'paper-core/bin/hepta-paper-release-attestor-client.mjs',
    'paper-core/bin/hepta-paper-release-attestor-daemon.mjs',
    'paper-core/bin/hepta-paper-state-authority-client.mjs',
    'paper-core/bin/hepta-paper-state-authority-daemon.mjs',
    'paper-core/bin/research-capability-matrix.mjs',
    'paper-core/bin/journal-connector-coverage.mjs',
    'paper-core/bin/automation-runtime-image-bundle-loader.mjs',
    'paper-core/bin/runtime-image-reproducibility.mjs',
    'paper-core/bin/runtime-r-source-cas.mjs',
    'paper-core/bin/autonomous-research-readiness.mjs',
    'paper-core/bin/autonomous-research-one-shot-campaign-attempt.mjs',
    'paper-core/bin/local-golden-dataset-provision.mjs',
    'paper-core/bin/formal-domain-qualification.mjs',
    'paper-core/bin/generic-domain-capability-evidence.mjs',
    'paper-core/bin/strict-full-auto-acceptance.mjs',
    'paper-core/bin/autonomous-empirical-plugin-release.mjs',
    'paper-core/bin/advanced-numerical-plugin.mjs',
    'paper-core/bin/autonomous-research-supervisor.mjs',
    'paper-core/bin/autonomous-research-supervisor-health.mjs',
    'paper-core/bin/nested-runtime-platform-qualification.mjs',
    'paper-core/bin/autonomous-research-state-backup.mjs',
    'paper-core/bin/autonomous-submission-dispatcher.mjs',
    'paper-core/bin/autonomous-submission-dispatcher-challenge.mjs',
    'paper-core/bin/autonomous-research-machine-intake-authority-rotation.mjs',
    'paper-core/bin/automation-reconcile.mjs',
    'paper-core/bin/paper-campaign.mjs',
    'paper-core/bin/paper-campaign-dispatcher.mjs',
    'paper-core/bin/paper-production-core.mjs',
    'paper-core/bin/paper-submission-handoff.mjs',
    // Spawned by file URL from the process-isolated numeric assurance adapter.
    // It is an internal executable boundary and therefore has no static importer.
    'paper-adapters/research-verify/independent-system-benchmark-recomputation-worker.mjs',
    'paper-adapters/research-verify/independent-typed-numeric-oracle-recomputation-worker.mjs',
  ]),
  compatibility: Object.freeze([
    'paper-core/bin/paper-compat-workflow-projection.mjs',
    'paper-composition/bootstrap/capability-scoped-bootstrap.mjs',
    'paper-composition/compat/legacy-context-bootstrap.mjs',
  ]),
  experimental: Object.freeze([
    'paper-core/bin/run-real-paper-provider-sandbox.mjs',
    'paper-core/experimental/inspect-autonomous-research-public-deployment-identity.mjs',
    'paper-composition/pilots/real-paper-pilot.mjs',
    'paper-application/experimental/taskflow/reviewed-submit-taskflow.mjs',
  ]),
  verification: Object.freeze([
    'paper-core/verification/selftest.mjs',
    'paper-core/verification/remediation-selftest.mjs',
    'paper-core/verification/authority-pipeline-selftest.mjs',
    'paper-core/bin/run-isolated-command.mjs',
    'paper-core/bin/run-isolated-verification.mjs',
    'paper-core/bin/check-mjs-syntax.mjs',
    'paper-core/bin/run-impacted-tests.mjs',
    'paper-core/bin/prepare-ci-mathlib-cache.mjs',
    'paper-core/bin/release-state-check.mjs',
    'paper-core/bin/release-trust-gate.mjs',
    'paper-core/bin/critical-module-coverage.mjs',
    'paper-core/bin/academic-docker-operational.mjs',
    'paper-core/bin/dynamic-formal-kernel-operational.mjs',
    'paper-core/tests/autonomous-research-topic-producer.test.mjs',
    'paper-core/tests/autonomous-research-supervisor-external-action-journal.test.mjs',
    'paper-core/tests/legacy-history-snapshot.test.mjs',
    'paper-core/tests/hotcrp-api-connector.test.mjs',
    'paper-core/tests/journal-connector-coverage.test.mjs',
    'paper-core/tests/ojs-api-connector.test.mjs',
    'paper-core/tests/openreview-api-connector.test.mjs',
    'paper-core/tests/openreview-submission-connector.test.mjs',
    'paper-core/tests/playwright-assisted-submission-connector.test.mjs',
    'paper-core/tests/universal-submission-contract.test.mjs',
  ]),
  maintenance: Object.freeze([
    'paper-core/bin/autonomous-research-state-provision.mjs',
    'paper-core/bin/autonomous-research-state-partial-root-maintenance.mjs',
    'paper-core/bin/autonomous-research-online-schema-transition.mjs',
    'paper-core/bin/runtime-hygiene.mjs',
    'paper-core/bin/runtime-permissions.mjs',
    'paper-core/bin/release-integrity-key.mjs',
    'paper-core/bin/release-evidence.mjs',
    'paper-core/bin/quarantine-stale-latest.mjs',
    'paper-core/bin/workspace-lineage-backfill.mjs',
    'paper-core/bin/repair-receipt-ledger-integrity.mjs',
    'paper-core/bin/generate-external-intake.mjs',
    'paper-core/bin/verify-external-intake.mjs',
  ]),
  migrationSupport: Object.freeze([
    'migration/bin/verify-capabilities.mjs',
    'migration/tests/capability-matrix-v3.mjs',
    'migration/tests/matrix-integrity.mjs',
    'migration/bin/verify-retirement-source-snapshot.mjs',
    'migration/bin/verify-legacy-salvage-replacements.mjs',
    'paper-core/bin/legacy-immutable-snapshot.mjs',
    'paper-core/bin/retire-legacy-archive.mjs',
  ]),
  externalRuntimeImports: Object.freeze([
    Object.freeze({
      importer: 'paper-adapters/automation/codex-openclaw-managed-configuration.mjs',
      expression: 'pathToFileURL(located.agentCommandRuntimePath).href',
      locationProperty: 'agentCommandRuntimePath',
      packageName: 'openclaw',
      packageExport: './plugin-sdk/agent-runtime',
      requiredExports: Object.freeze(['agentCommand', 'ensureAuthProfileStore']),
    }),
    Object.freeze({
      importer: 'paper-adapters/automation/codex-openclaw-managed-configuration.mjs',
      expression: 'pathToFileURL(located.configRuntimePath).href',
      locationProperty: 'configRuntimePath',
      packageName: 'openclaw',
      packageExport: './plugin-sdk/config-runtime',
      requiredExports: Object.freeze(['loadConfig']),
    }),
    Object.freeze({
      importer: 'paper-adapters/automation/codex-openclaw-managed-configuration.mjs',
      expression: 'pathToFileURL(located.agentHarnessRuntimePath).href',
      locationProperty: 'agentHarnessRuntimePath',
      packageName: 'openclaw',
      packageExport: './plugin-sdk/agent-harness-runtime',
      requiredExports: Object.freeze([
        'resolveAgentDir',
        'disposeRegisteredAgentHarnesses',
      ]),
    }),
    Object.freeze({
      importer: 'paper-adapters/automation/codex-openclaw-managed-configuration.mjs',
      expression: 'pathToFileURL(located.sessionStoreRuntimePath).href',
      locationProperty: 'sessionStoreRuntimePath',
      packageName: 'openclaw',
      packageExport: './plugin-sdk/session-store-runtime',
      requiredExports: Object.freeze([
        'resolveStorePath',
        'resolveSessionFilePath',
        'upsertSessionEntry',
        'updateSessionStore',
        'getSessionEntry',
      ]),
    }),
    Object.freeze({
      importer: 'paper-adapters/automation/codex-openclaw-managed-configuration.mjs',
      expression: 'pathToFileURL(located.gatewayRuntimePath).href',
      locationProperty: 'gatewayRuntimePath',
      packageName: 'openclaw',
      packageExport: './plugin-sdk/gateway-runtime',
      requiredExports: Object.freeze(['callGatewayFromCli']),
    }),
  ]),
});

export function assertArchitectureEntrypointManifest(manifest = ARCHITECTURE_ENTRYPOINT_MANIFEST) {
  if (manifest?.version !== 3 || manifest?.kind !== 'ArchitectureEntrypointManifest') {
    throw new Error('architecture_entrypoint_manifest_identity_invalid');
  }
  const categories = [
    'production',
    'compatibility',
    'experimental',
    'verification',
    'maintenance',
    'migrationSupport',
  ];
  const seen = new Map();
  for (const category of categories) {
    if (!Array.isArray(manifest?.[category]) || manifest[category].length === 0) {
      throw new Error(`architecture_entrypoint_category_empty:${category}`);
    }
    for (const entry of manifest[category]) {
      if (seen.has(entry)) throw new Error(`architecture_entrypoint_duplicate:${entry}`);
      seen.set(entry, category);
    }
  }
  if (!Array.isArray(manifest.externalRuntimeImports)
    || manifest.externalRuntimeImports.length === 0) {
    throw new Error('architecture_external_runtime_imports_empty');
  }
  const externalRuntimeImportKeys = new Set();
  for (const declaration of manifest.externalRuntimeImports) {
    const expectedKeys = [
      'expression',
      'importer',
      'locationProperty',
      'packageExport',
      'packageName',
      'requiredExports',
    ];
    if (JSON.stringify(Object.keys(declaration || {}).sort())
      !== JSON.stringify(expectedKeys)
      || typeof declaration.importer !== 'string'
      || !declaration.importer.endsWith('.mjs')
      || pathLikeEscape(declaration.importer)
      || typeof declaration.locationProperty !== 'string'
      || declaration.expression
        !== `pathToFileURL(located.${declaration.locationProperty}).href`
      || !/^[a-z0-9][a-z0-9._-]*$/.test(declaration.packageName || '')
      || !/^\.\/[a-z0-9][a-z0-9._/-]*$/.test(declaration.packageExport || '')
      || !Array.isArray(declaration.requiredExports)
      || declaration.requiredExports.length === 0
      || new Set(declaration.requiredExports).size !== declaration.requiredExports.length
      || declaration.requiredExports.some((name) => (
        !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
      ))) {
      throw new Error('architecture_external_runtime_import_invalid');
    }
    const key = `${declaration.importer}\0${declaration.expression}`;
    if (externalRuntimeImportKeys.has(key)) {
      throw new Error(`architecture_external_runtime_import_duplicate:${key}`);
    }
    externalRuntimeImportKeys.add(key);
  }
  return manifest;
}

function pathLikeEscape(candidate) {
  return candidate.startsWith('/')
    || candidate.split('/').some((segment) => segment === '..' || segment === '');
}

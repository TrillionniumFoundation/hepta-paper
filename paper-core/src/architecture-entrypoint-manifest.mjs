// Architecture reachability must start from executable surfaces, not from
// convenient composition modules. Keep this manifest path-only so the
// architecture checker can consume it without importing production code.
export const ARCHITECTURE_ENTRYPOINT_MANIFEST = Object.freeze({
  version: 2,
  kind: 'ArchitectureEntrypointManifest',
  production: Object.freeze([
    'paper-core/bin/hepta-paper.mjs',
    'paper-core/bin/workspace-status.mjs',
    'paper-core/bin/hepta-store.mjs',
    'paper-core/bin/automation-status.mjs',
    'paper-core/bin/runtime-image-reproducibility.mjs',
    'paper-core/bin/runtime-r-source-cas.mjs',
    'paper-core/bin/autonomous-research-readiness.mjs',
    'paper-core/bin/autonomous-research-supervisor.mjs',
    'paper-core/bin/autonomous-research-supervisor-health.mjs',
    'paper-core/bin/autonomous-research-machine-intake-authority-rotation.mjs',
    'paper-core/bin/automation-reconcile.mjs',
    'paper-core/bin/paper-campaign.mjs',
    'paper-core/bin/paper-campaign-dispatcher.mjs',
    'paper-core/bin/paper-production-core.mjs',
    'paper-core/bin/paper-submission-handoff.mjs',
  ]),
  compatibility: Object.freeze([
    'paper-core/bin/paper-compat-workflow-projection.mjs',
    'paper-composition/bootstrap/capability-scoped-bootstrap.mjs',
  ]),
  experimental: Object.freeze([
    'paper-core/bin/run-real-paper-provider-sandbox.mjs',
    'paper-composition/pilots/real-paper-pilot.mjs',
    'paper-application/experimental/taskflow/reviewed-submit-taskflow.mjs',
  ]),
  verification: Object.freeze([
    'paper-core/verification/selftest.mjs',
    'paper-core/verification/remediation-selftest.mjs',
    'paper-core/verification/authority-pipeline-selftest.mjs',
    'paper-core/bin/check-mjs-syntax.mjs',
    'paper-core/bin/release-state-check.mjs',
    'paper-core/bin/release-trust-gate.mjs',
    'paper-core/bin/critical-module-coverage.mjs',
    'paper-core/bin/academic-docker-operational.mjs',
    'paper-core/tests/autonomous-research-topic-producer.test.mjs',
    'paper-core/tests/autonomous-research-supervisor-external-action-journal.test.mjs',
    'paper-core/tests/legacy-history-snapshot.test.mjs',
  ]),
  maintenance: Object.freeze([
    'paper-core/bin/runtime-hygiene.mjs',
    'paper-core/bin/runtime-permissions.mjs',
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
});

export function assertArchitectureEntrypointManifest(manifest = ARCHITECTURE_ENTRYPOINT_MANIFEST) {
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
  return manifest;
}

export const ROUTED_NPM_SCRIPT_CLASSIFICATION = Object.freeze({
  operator: 'operator',
  maintenance: 'maintenance',
  verify: 'verification',
  retirement: 'retirement',
});

export const EXPLICIT_NPM_SCRIPTS = Object.freeze({
  operator: Object.freeze([
    'hepta-paper',
  ]),
  verification: Object.freeze([
    'assets:cold-volume-cas-release-gate',
    'assets:cold-volume-cas-restore-drill',
    'assets:cold-volume-cas-status',
    'assets:cold-volume-release-gate',
    'assets:cold-volume-status',
    'audit:local-accepts',
    'authority:status',
    'automation:agent-smoke',
    'automation:campaign-smoke',
    'automation:dashboard',
    'automation:openclaw-multipaper-smoke',
    'automation:runtime-smoke',
    'automation:selftest',
    'automation:strict-rereview-smoke',
    'ci:selftest',
    'check:syntax',
    'coverage:architecture',
    'coverage:repository',
    'coverage:system',
    'external:intake-verify',
    'formal:receipt',
    'lint',
    'offhost:worm-restore-drill',
    'offhost:worm-status',
    'paper:authority-selftest',
    'paper:capability-conformance',
    'paper:capability-tests',
    'paper:governance-contracts',
    'paper:remediation-selftest',
    'paper:salvage-hardening-selftest',
    'paper:selftest',
    'provider:sandbox-selftest',
    'reference:integrity',
    'reference:runtime-dry-run',
    'reference:selftest',
    'reference:selftest:workspace',
    'release:state-check',
    'release:plan',
    'safety:all',
    'safety:p0',
    'safety:p1',
    'safety:p2',
    'security:npm-audit',
    'security:source-gate',
    'scripts:check',
    'store:trust-status',
    'store:restore-drill',
    'static:check',
    'test:academic-docker-operational',
    'test:dynamic-formal-kernel-operational',
    'test:impacted',
    'test:impacted:plan',
    'test:legacy-deletion-drill-operational',
    'test:migration-differential',
    'test:typed-numeric-process-operational',
    'workspace:verify-decoupled',
  ]),
  maintenance: Object.freeze([
    'assets:cold-volume-cas-import',
    'automation:runtime-build',
    'automation:runtime-bootstrap:python',
    'automation:runtime-bootstrap:r',
    'automation:runtime-image-bundle-load',
    'automation:workspace-backfill',
    'automation:workspace-backfill:execute',
    'conformance:replay',
    'external:intake',
    'migration:matrix-refresh-hashes',
    'migration:salvage-verification-receipt',
    'offhost:worm-snapshot',
    'owner:refresh-local-admin',
    'reference:baseline:accept',
    'release:env',
    'reports:quarantine-stale',
    'runtime:hygiene',
    'runtime:permissions',
    'security:sbom:write',
    'store:init',
    'store:repair-ledger-integrity',
  ]),
  retirement: Object.freeze([
    'legacy:fixture-verify',
    'legacy:matrix-reference-status',
    'migration:matrix-integrity',
    'migration:p0-selftest',
    'migration:p1-build-package-selftest',
    'migration:p1-plugin-selftest',
    'migration:p1-referee-selftest',
    'migration:p1-research-selftest',
    'migration:p1-submission-selftest',
    'migration:p1-venue-selftest',
    'migration:salvage-manifest',
    'migration:salvage-selftest',
  ]),
  compatibility: Object.freeze([
    'compat:legacy-workflow-projection',
  ]),
  experimental: Object.freeze([
    'experimental:real-paper-pilot',
    'experimental:taskflow-selftest',
    'paper:real-provider-sandbox',
  ]),
  internal: Object.freeze([
    'ci:mathlib-cache',
    'ci:inner',
    'automation:selftest:deduplicated',
    'coverage:architecture-inner',
    'coverage:repository-inner',
    'coverage:system-inner',
    'migration:p0-inner',
    'migration:p1-referee-inner',
    'paper:campaign-worker',
    'paper:salvage-hardening-selftest:deduplicated',
    'release:inner',
    'safety:p0:inner',
    'safety:p1:inner',
    'safety:p2:inner',
    'scripts:surface',
    'test:inner',
  ]),
});

export const NPM_COMMAND_GROUPS = Object.freeze([
  'operator',
  'verification',
  'maintenance',
  'retirement',
  'compatibility',
  'experimental',
  'internal',
]);

export const HEPTA_PAPER_CI_COMMAND_MATRIX = Object.freeze({
  pullRequest: Object.freeze([
    Object.freeze({
      id: 'static-contracts',
      npmScripts: Object.freeze(['static:check', 'security:npm-audit']),
    }),
    Object.freeze({
      id: 'impacted-tests',
      npmScripts: Object.freeze(['test:impacted']),
      shardCount: 4,
      targetDurationMinutes: 5,
    }),
  ]),
  nightly: Object.freeze([
    Object.freeze({
      id: 'full-portable',
      npmScripts: Object.freeze([
        'security:npm-audit',
        'ci:selftest',
        'coverage:architecture',
        'coverage:repository',
      ]),
    }),
    Object.freeze({
      id: 'formal-cache',
      npmScripts: Object.freeze(['ci:mathlib-cache']),
    }),
    Object.freeze({
      id: 'academic-empirical',
      npmScripts: Object.freeze(['test:academic-docker-operational']),
    }),
    Object.freeze({
      id: 'typed-numeric',
      npmScripts: Object.freeze(['test:typed-numeric-process-operational']),
    }),
    Object.freeze({
      id: 'dynamic-formal',
      npmScripts: Object.freeze(['test:dynamic-formal-kernel-operational']),
    }),
  ]),
});

export function defineCommandRoute({
  group,
  name,
  argv,
  npmScript = null,
  npmCommand = null,
  mutability = 'read-only',
  effects = {},
  unsupportedModes = [],
  forwardingPolicy = 'none',
  forwardedArgumentSchema = null,
}) {
  return Object.freeze({
    group,
    name,
    argv: Object.freeze([...argv]),
    npmScript,
    npmCommand,
    mutability,
    effects: Object.freeze({
      localMutation: effects.localMutation || mutability,
      externalAction: effects.externalAction || 'none',
      networkUse: effects.networkUse || 'none',
      credentialUse: effects.credentialUse || 'none',
      providerCost: effects.providerCost || 'none',
    }),
    unsupportedModes: Object.freeze([...unsupportedModes]),
    forwardingPolicy,
    forwardedArgumentSchema: forwardedArgumentSchema ? Object.freeze({
      ...forwardedArgumentSchema,
      booleanFlags: Object.freeze([...(forwardedArgumentSchema.booleanFlags || [])]),
      valueFlags: Object.freeze([...(forwardedArgumentSchema.valueFlags || [])]),
      repeatableValueFlags: Object.freeze([
        ...(forwardedArgumentSchema.repeatableValueFlags || []),
      ]),
    }) : null,
  });
}

export function buildNpmCommandClassification(routes) {
  const classification = new Map();
  const register = (name, group) => {
    if (classification.has(name)) throw new Error(`duplicate_npm_command_classification:${name}`);
    classification.set(name, group);
  };
  for (const entry of routes) {
    if (!entry.npmScript) continue;
    const group = ROUTED_NPM_SCRIPT_CLASSIFICATION[entry.group];
    if (!group) throw new Error(`unclassified_routed_npm_command_group:${entry.group}`);
    register(entry.npmScript, group);
  }
  for (const [group, names] of Object.entries(EXPLICIT_NPM_SCRIPTS)) {
    for (const name of names) register(name, group);
  }
  return classification;
}

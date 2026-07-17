import { EXPLICIT_NPM_SCRIPTS } from './npm-command-surface-manifest.mjs';
const route = ({
  group,
  name,
  argv,
  npmScript = null,
  mutability = 'read-only',
  effects = {},
  unsupportedModes = [],
  forwardingPolicy = 'none',
  forwardedArgumentSchema = null,
}) => Object.freeze({
  group,
  name,
  argv: Object.freeze([...argv]),
  npmScript,
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
    repeatableValueFlags: Object.freeze([...(forwardedArgumentSchema.repeatableValueFlags || [])]),
  }) : null,
});

const ROUTES = Object.freeze([
  route({ group: 'operator', name: 'workspace', argv: ['node', 'paper-core/bin/workspace-status.mjs'], npmScript: 'workspace:status', forwardingPolicy: 'registry', forwardedArgumentSchema: { booleanFlags: ['require-decoupled'], positional: false } }),
  route({ group: 'operator', name: 'store', argv: ['node', 'paper-core/bin/hepta-store.mjs', 'status'], npmScript: 'store:status', forwardingPolicy: 'registry', forwardedArgumentSchema: { booleanFlags: ['allow-isolated-verification-evidence', 'require-trust-clean'], positional: false } }),
  route({ group: 'operator', name: 'store-migrate', argv: ['node', 'paper-core/bin/hepta-store.mjs', 'migrate'], npmScript: 'store:migrate', mutability: 'local-write' }),
  route({ group: 'operator', name: 'store-backup', argv: ['node', 'paper-core/bin/hepta-store.mjs', 'backup'], npmScript: 'store:backup', mutability: 'local-write' }),
  route({
    group: 'operator',
    name: 'automation',
    argv: ['node', 'paper-core/bin/automation-status.mjs'],
    npmScript: 'automation:status',
    effects: {
      externalAction: 'argument-dependent',
      networkUse: 'argument-dependent',
      credentialUse: 'argument-dependent',
    },
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: [
        'help',
        'live-provider-canary',
        'require-full-research',
        'require-fully-autonomous',
      ],
      valueFlags: ['root', 'runtime-root'],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'autonomous-supervisor-health',
    argv: ['node', 'paper-core/bin/autonomous-research-supervisor-health.mjs'],
    npmScript: 'automation:autonomous-research-supervisor-health',
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: [
        'help',
        'require-startup-reconciliation',
        'require-machine-intake-reconciliation',
        'require-current-machine-intake',
        'require-fully-autonomous',
      ],
      valueFlags: ['external-qualification-config', 'runtime-root'],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'autonomous-intake-authority-rotation',
    argv: [
      'node',
      'paper-core/bin/autonomous-research-machine-intake-authority-rotation.mjs',
    ],
    npmScript: 'automation:autonomous-research-intake-authority-rotation',
    mutability: 'argument-dependent',
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['execute', 'help'],
      valueFlags: [
        'action', 'runtime-root', 'next-machine-intake-config',
        'topic-producer-profile', 'rotation-intent',
        'plan-hash', 'expected-authority-generation',
      ],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'runtime-image-reproducibility',
    argv: ['node', 'paper-core/bin/runtime-image-reproducibility.mjs'],
    npmScript: 'automation:runtime-reproducibility',
    mutability: 'argument-dependent',
    effects: {
      externalAction: 'argument-dependent',
      networkUse: 'argument-dependent',
      credentialUse: 'argument-dependent',
    },
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['help'],
      valueFlags: ['action', 'config', 'receipt', 'runtime-root', 'root'],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'runtime-r-source-cas',
    argv: ['node', 'paper-core/bin/runtime-r-source-cas.mjs'],
    npmScript: 'automation:runtime-r-source-cas',
    mutability: 'argument-dependent',
    effects: { networkUse: 'argument-dependent' },
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['help'],
      valueFlags: ['action', 'seed', 'concurrency', 'root'],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'research-readiness',
    argv: ['node', 'paper-core/bin/automation-status.mjs', '--require-full-research', '--live-provider-canary'],
    npmScript: 'automation:research-status',
    effects: {
      externalAction: 'required',
      networkUse: 'required',
      credentialUse: 'required',
      providerCost: 'possible',
    },
  }),
  route({
    group: 'operator',
    name: 'autonomous-research',
    argv: ['node', 'paper-core/bin/autonomous-research-readiness.mjs'],
    npmScript: 'automation:autonomous-research-readiness',
    mutability: 'argument-dependent',
    effects: {
      externalAction: 'argument-dependent',
      networkUse: 'argument-dependent',
      credentialUse: 'argument-dependent',
      providerCost: 'argument-dependent',
    },
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['help', 'human-subjects', 'private-data', 'require-launch-ready', 'require-full-ready'],
      valueFlags: [
        'action', 'launch-mode', 'paper-id', 'campaign-id', 'objective', 'protocol-family', 'revision-rounds',
        'referee-count', 'root', 'runtime-root', 'dataset-mount-file', 'concurrency', 'agent-slots',
        'cpu-slots', 'gpu-slots', 'memory-mib', 'max-wall-ms', 'max-agent-calls', 'max-cpu-jobs',
        'max-gpu-jobs', 'max-tokens', 'max-cost-usd', 'agent-provider', 'model',
        'formal-review-provider', 'formal-review-model', 'formal-review-codex-binary',
        'formal-review-codex-home', 'codex-home', 'codex-binary',
        'external-qualification-config',
        'qualification-maximum-attempts', 'qualification-maximum-epochs',
        'qualification-maximum-total-attempts', 'qualification-initial-backoff-ms',
        'qualification-maximum-backoff-ms', 'qualification-deadline-ms',
        'qualification-epoch-cooldown-ms', 'qualification-global-deadline-ms',
        'qualification-exhausted-cooldown-ms', 'qualification-attempt-lease-ms',
        'qualification-maximum-total-cost-usd', 'qualification-attempt-reservation-cost-usd',
        'qualification-renewal-lead-ms',
      ],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'autonomous-supervisor',
    argv: ['node', 'paper-core/bin/autonomous-research-supervisor.mjs'],
    npmScript: 'automation:autonomous-research-supervisor',
    mutability: 'local-write',
    effects: {
      externalAction: 'required',
      networkUse: 'required',
      credentialUse: 'required',
      providerCost: 'bounded',
    },
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['help', 'once', 'require-fully-autonomous'],
      valueFlags: [
        'root', 'runtime-root', 'poll-ms', 'maximum-campaigns-per-cycle',
        'external-qualification-config', 'machine-intake-config', 'topic-producer-profile',
        'concurrency', 'agent-slots', 'cpu-slots',
        'gpu-slots', 'memory-mib', 'agent-provider', 'model', 'formal-review-provider',
        'formal-review-model', 'formal-review-codex-binary', 'formal-review-codex-home',
        'codex-home', 'codex-binary', 'maximum-dispatches', 'maximum-provider-canaries',
        'maximum-consecutive-failures', 'maximum-lifecycle-cost-usd',
        'maximum-lifetime-ms', 'lease-ms', 'resident-instance-lease-ms',
        'resident-instance-heartbeat-ms', 'base-cooldown-ms', 'maximum-cooldown-ms',
        'provider-canary-interval-ms', 'provider-canary-reservation-cost-usd',
        'qualification-maximum-total-attempts', 'qualification-maximum-total-cost-usd',
        'qualification-attempt-reservation-cost-usd', 'qualification-renewal-lead-ms',
        'qualification-action-safety-margin-ms',
        'qualification-maximum-attempts', 'qualification-maximum-epochs',
        'qualification-initial-backoff-ms', 'qualification-maximum-backoff-ms',
        'qualification-deadline-ms', 'qualification-epoch-cooldown-ms',
        'qualification-exhausted-cooldown-ms', 'qualification-attempt-lease-ms',
        'runtime-reproducibility-maximum-attempts-per-epoch',
        'runtime-reproducibility-maximum-cost-usd-per-epoch',
        'runtime-reproducibility-budget-epoch-ms', 'runtime-reproducibility-lease-ms',
        'runtime-reproducibility-base-backoff-ms',
        'runtime-reproducibility-maximum-backoff-ms',
        'runtime-reproducibility-renewal-lead-ms',
        'runtime-reproducibility-action-safety-margin-ms',
      ],
      positional: false,
    },
  }),
  route({ group: 'operator', name: 'reconcile', argv: ['node', 'paper-core/bin/automation-reconcile.mjs'], npmScript: 'automation:reconcile', mutability: 'argument-dependent' }),
  route({ group: 'operator', name: 'reconcile-apply', argv: ['node', 'paper-core/bin/automation-reconcile.mjs', '--execute'], npmScript: 'automation:reconcile:execute', mutability: 'local-write' }),
  route({
    group: 'operator',
    name: 'campaign',
    argv: ['node', 'paper-core/bin/paper-campaign.mjs'],
    npmScript: 'paper:campaign',
    mutability: 'argument-dependent',
    effects: {
      externalAction: 'argument-dependent',
      networkUse: 'argument-dependent',
      credentialUse: 'argument-dependent',
      providerCost: 'argument-dependent',
    },
    forwardingPolicy: 'strict-child',
  }),
  route({
    group: 'operator',
    name: 'batch',
    argv: ['node', 'paper-core/bin/paper-production-core.mjs', 'batch-run'],
    npmScript: 'paper:batch',
    mutability: 'argument-dependent',
    effects: {
      externalAction: 'argument-dependent',
      networkUse: 'argument-dependent',
      credentialUse: 'argument-dependent',
      providerCost: 'argument-dependent',
    },
    unsupportedModes: ['journal-manage', 'venue-resolve', 'source-adapt'],
    forwardingPolicy: 'strict-child',
  }),
  route({ group: 'operator', name: 'submission-handoff', argv: ['node', 'paper-core/bin/paper-submission-handoff.mjs'], npmScript: 'paper:submission-handoff', forwardingPolicy: 'strict-child' }),
  route({ group: 'operator', name: 'gc', argv: ['node', 'paper-core/bin/paper-campaign.mjs', '--action', 'gc'], mutability: 'argument-dependent', forwardingPolicy: 'strict-child' }),
  route({ group: 'operator', name: 'gc-apply', argv: ['node', 'paper-core/bin/paper-campaign.mjs', '--action', 'gc', '--apply'], mutability: 'local-delete', forwardingPolicy: 'strict-child' }),

  route({ group: 'verify', name: 'architecture', argv: ['node', '--test', 'paper-core/tests/architecture-conformance.test.mjs'], npmScript: 'paper:architecture-selftest' }),
  route({ group: 'verify', name: 'critical', argv: ['npm', 'run', 'coverage:critical-modules'], npmScript: 'coverage:critical-modules' }),
  route({ group: 'verify', name: 'store', argv: ['node', 'paper-core/bin/hepta-store-logical-integrity.mjs'], npmScript: 'store:logical-integrity', forwardingPolicy: 'registry', forwardedArgumentSchema: { positional: true, maximumPositionals: 1 } }),
  route({ group: 'verify', name: 'release', argv: ['npm', 'run', 'release:verify'], npmScript: 'release:verify' }),
  route({ group: 'verify', name: 'trust', argv: ['node', 'paper-core/bin/release-trust-gate.mjs'], npmScript: 'release:trust-gate' }),
  route({ group: 'verify', name: 'operational', argv: ['node', 'paper-core/bin/operational-proof-status.mjs'], npmScript: 'operational:status' }),
  route({ group: 'verify', name: 'owner', argv: ['node', 'paper-core/bin/owner-acceptance-status.mjs'], npmScript: 'owner:status' }),
  route({ group: 'verify', name: 'full', argv: ['npm', 'test'], npmScript: 'test' }),

  route({ group: 'retirement', name: 'status', argv: ['npm', 'run', 'migration:retirement-status'], npmScript: 'migration:retirement-status' }),
  route({ group: 'retirement', name: 'reference', argv: ['node', 'migration/bin/verify-retirement-source-snapshot.mjs'], npmScript: 'legacy:reference-verify' }),
  route({ group: 'retirement', name: 'matrix', argv: ['npm', 'run', 'migration:capability-matrix-v3'], npmScript: 'migration:capability-matrix-v3' }),
  route({ group: 'retirement', name: 'drill', argv: ['node', 'paper-core/bin/legacy-deletion-drill.mjs'], npmScript: 'legacy:deletion-drill' }),
]);

const ROUTE_GROUPS = Object.freeze(['operator', 'verify', 'retirement']);
const NPM_GROUPS = Object.freeze([
  'operator',
  'verification',
  'maintenance',
  'retirement',
  'compatibility',
  'experimental',
  'internal',
]);

export const HEPTA_PAPER_COMMAND_REGISTRY = Object.freeze(Object.fromEntries(ROUTE_GROUPS.map((group) => [
  group,
  Object.freeze(Object.fromEntries(ROUTES
    .filter((entry) => entry.group === group)
    .map((entry) => [entry.name, entry]))),
])));

function buildNpmClassification() {
  const classification = new Map();
  const register = (name, group) => {
    if (classification.has(name)) throw new Error(`duplicate_npm_command_classification:${name}`);
    classification.set(name, group);
  };
  for (const entry of ROUTES) {
    if (!entry.npmScript) continue;
    register(entry.npmScript, entry.group === 'verify' ? 'verification' : entry.group);
  }
  for (const [group, names] of Object.entries(EXPLICIT_NPM_SCRIPTS)) {
    for (const name of names) register(name, group);
  }
  return classification;
}

const NPM_CLASSIFICATION = buildNpmClassification();

export function resolveHeptaPaperCommand(group, name) {
  return HEPTA_PAPER_COMMAND_REGISTRY[group]?.[name] || null;
}

export function heptaPaperCommandUsage() {
  return Object.freeze({
    version: 3,
    kind: 'HeptaPaperCommandSurface',
    usage: 'hepta-paper <operator|verify|retirement> <command> [-- command-args]',
    groups: Object.freeze(Object.fromEntries(ROUTE_GROUPS.map((group) => [
      group,
      Object.freeze(Object.keys(HEPTA_PAPER_COMMAND_REGISTRY[group])),
    ]))),
    commands: Object.freeze(Object.fromEntries(ROUTE_GROUPS.map((group) => [
      group,
      Object.freeze(Object.fromEntries(Object.entries(HEPTA_PAPER_COMMAND_REGISTRY[group])
        .map(([name, entry]) => [name, Object.freeze({
          argv: entry.argv,
          npmScript: entry.npmScript,
          mutability: entry.mutability,
          effects: entry.effects,
        })]))),
    ]))),
    constraints: Object.freeze(ROUTES
      .filter((entry) => entry.unsupportedModes.length)
      .map((entry) => Object.freeze({
        group: entry.group,
        command: entry.name,
        unsupportedModes: entry.unsupportedModes,
        behavior: 'production_batch_fails_closed_use_explicit_compatibility_entrypoint',
      }))),
    compatibility: 'this CLI is the supported operator surface; npm scripts are classified build, verification, maintenance, compatibility, retirement, or experimental plumbing',
  });
}

export function classifyNpmScriptSurface(scriptNames) {
  const groups = Object.fromEntries(NPM_GROUPS.map((group) => [group, []]));
  const blocked = [];
  for (const name of [...scriptNames].sort()) {
    const group = NPM_CLASSIFICATION.get(name);
    if (group) groups[group].push(name);
    else {
      groups.internal.push(name);
      blocked.push(name);
    }
  }
  return Object.freeze({
    version: 4,
    kind: 'NpmCommandSurface',
    policy: 'unregistered scripts default to internal and are blocked from the supported operator surface',
    groups: Object.freeze(Object.fromEntries(Object.entries(groups).map(([group, names]) => [group, Object.freeze(names)]))),
    blocked: Object.freeze(blocked),
  });
}

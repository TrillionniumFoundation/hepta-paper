import {
  HEPTA_PAPER_CI_COMMAND_MATRIX,
  NPM_COMMAND_GROUPS,
  buildNpmCommandClassification,
  defineCommandRoute as route,
} from './command-registry-catalog.mjs';
import { COMMAND_REGISTRY_SUPPORT_ROUTES } from './command-registry-support-routes.mjs';

export const AUTONOMOUS_RESEARCH_CLI_ARGUMENT_SCHEMA = Object.freeze({
  booleanFlags: Object.freeze([
    'help', 'human-subjects', 'private-data', 'require-launch-ready',
    'require-full-ready', 'require-bounded-golden-ready',
    'unlimited-tokens', 'unlimited-cost',
  ]),
  valueFlags: Object.freeze([
    'action', 'launch-mode', 'paper-id', 'campaign-id', 'objective', 'protocol-family',
    'revision-rounds', 'referee-count', 'root', 'runtime-root', 'dataset-mount-file',
    'concurrency', 'agent-slots', 'cpu-slots', 'gpu-slots', 'memory-mib',
    'max-wall-ms', 'max-agent-calls', 'max-cpu-jobs', 'max-gpu-jobs', 'max-tokens',
    'max-cost-usd', 'agent-provider', 'model', 'formal-review-provider',
    'formal-review-model', 'formal-review-codex-binary', 'formal-review-codex-home',
    'codex-home', 'codex-binary', 'external-qualification-config',
    'qualification-maximum-attempts', 'qualification-maximum-epochs',
    'qualification-maximum-total-attempts', 'qualification-initial-backoff-ms',
    'qualification-maximum-backoff-ms', 'qualification-deadline-ms',
    'qualification-epoch-cooldown-ms', 'qualification-global-deadline-ms',
    'qualification-exhausted-cooldown-ms', 'qualification-attempt-lease-ms',
    'qualification-maximum-total-cost-usd', 'qualification-attempt-reservation-cost-usd',
    'qualification-renewal-lead-ms',
  ]),
  positional: false,
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
        'handoff',
        'json',
        'live-provider-canary',
        'live-release-attestor',
        'require-full-research',
        'require-fully-autonomous',
      ],
      valueFlags: ['deployment-environment-file', 'root', 'runtime-root'],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'external-authority-intake',
    argv: ['node', 'paper-core/bin/production-external-authority-intake.mjs'],
    npmScript: 'automation:external-authority-intake',
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['help', 'require-ready'],
      valueFlags: [
        'author-config',
        'author-config-hash',
        'release-attestor-config',
        'release-attestor-config-hash',
      ],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'research-capability-matrix',
    argv: ['node', 'paper-core/bin/research-capability-matrix.mjs'],
    npmScript: 'automation:capability-matrix',
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['help', 'require-production-ready'],
      valueFlags: ['deployment-environment-file', 'root', 'runtime-root'],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'journal-connector-coverage',
    argv: ['node', 'paper-core/bin/journal-connector-coverage.mjs'],
    npmScript: 'automation:journal-connector-coverage',
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: [
        'help',
        'summary',
        'require-family-prototype',
        'require-profile-resolved',
        'require-adapter-implemented',
        'require-sandbox-qualified',
        'require-production-qualified',
        'require-live-ready',
      ],
      valueFlags: [
        'kind',
        'qualification-registry',
        'qualification-registry-hash',
        'qualification-trust-store',
        'qualification-trust-store-hash',
        'venue',
      ],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'portal-target-qualification',
    argv: ['node', 'paper-core/bin/portal-target-qualification.mjs'],
    npmScript: 'automation:portal-target-qualification',
    mutability: 'argument-dependent',
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['execute', 'help', 'require-ready'],
      valueFlags: [
        'action',
        'candidate',
        'candidate-hash',
        'plan-hash',
        'registry',
        'registry-hash',
        'trust-store',
        'trust-store-hash',
      ],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'generic-domain-capability-evidence',
    argv: ['node', 'paper-core/bin/generic-domain-capability-evidence.mjs'],
    npmScript: 'automation:generic-domain-capability-evidence',
    mutability: 'argument-dependent',
    effects: {
      externalAction: 'argument-dependent',
      networkUse: 'argument-dependent',
      credentialUse: 'argument-dependent',
      providerCost: 'argument-dependent',
    },
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['help'],
      valueFlags: ['action', 'paper-id', 'root', 'runtime-root'],
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
        'require-strict-machine-intake-reconciliation',
        'require-fully-autonomous',
      ],
      valueFlags: ['external-qualification-config', 'runtime-root'],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'nested-runtime-platform-qualification',
    argv: ['node', 'paper-core/bin/nested-runtime-platform-qualification.mjs'],
    npmScript: 'automation:nested-runtime-platform-qualification',
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['help'],
      valueFlags: [
        'config', 'config-content-hash', 'qualification-content-hash',
        'conformance-content-hash', 'pod-uid', 'plan-hash', 'profile-id',
        'runtime-class-name', 'parent-pod-cpu-millis', 'parent-pod-memory-bytes',
        'parent-pod-pids', 'qualification-key-id', 'qualification-subject-id',
        'qualification-public-key-spki-hash', 'conformance-key-id',
        'conformance-subject-id', 'conformance-public-key-spki-hash',
      ],
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
    name: 'autonomous-state-backup',
    argv: ['node', 'paper-core/bin/autonomous-research-state-backup.mjs'],
    npmScript: 'automation:autonomous-research-state-backup',
    mutability: 'argument-dependent',
    effects: {
      externalAction: 'argument-dependent',
      networkUse: 'argument-dependent',
      credentialUse: 'argument-dependent',
    },
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['help'],
      valueFlags: [
        'action', 'runtime-root', 'authority-config',
        'online-authority-process-config', 'bundle',
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
    argv: [
      'node',
      'paper-core/bin/automation-status.mjs',
      '--require-full-research',
      '--live-provider-canary',
      '--live-release-attestor',
    ],
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
    forwardedArgumentSchema: AUTONOMOUS_RESEARCH_CLI_ARGUMENT_SCHEMA,
  }),
  route({
    group: 'operator',
    name: 'autonomous-research-one-shot-campaign-attempt',
    argv: ['node', 'paper-core/bin/autonomous-research-one-shot-campaign-attempt.mjs'],
    npmScript: 'automation:autonomous-research-one-shot-campaign-attempt',
    mutability: 'argument-dependent',
    effects: {
      externalAction: 'argument-dependent',
      networkUse: 'argument-dependent',
      credentialUse: 'argument-dependent',
      providerCost: 'argument-dependent',
    },
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['help'],
      valueFlags: [
        'action', 'root', 'runtime-root', 'control-root',
        'dataset-mount-file', 'attempt-id',
      ],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'local-golden-dataset-provision',
    argv: ['node', 'paper-core/bin/local-golden-dataset-provision.mjs'],
    npmScript: 'automation:local-golden-dataset-provision',
    mutability: 'argument-dependent',
    effects: {
      externalAction: 'none',
      networkUse: 'none',
      credentialUse: 'argument-dependent',
      providerCost: 'none',
    },
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['execute', 'help'],
      valueFlags: [
        'action', 'plan-id', 'runtime-root', 'control-root', 'isolation-id',
        'dataset-name', 'dataset-root', 'dataset-license-id', 'split-assignments',
        'harness-definition', 'analysis-protocol', 'research-semantics',
        'authority-trust-store', 'authority-private-key', 'authority-key-id',
        'signed-at', 'expires-at', 'mount-output',
      ],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'strict-full-auto-acceptance',
    argv: ['node', 'paper-core/bin/strict-full-auto-acceptance.mjs'],
    npmScript: 'automation:strict-full-auto-acceptance',
    mutability: 'argument-dependent',
    effects: {
      externalAction: 'argument-dependent',
      networkUse: 'argument-dependent',
      credentialUse: 'argument-dependent',
      providerCost: 'argument-dependent',
    },
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['execute', 'help', 'require-accepted'],
      valueFlags: ['action', 'configuration', 'plan-hash'],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'autonomous-empirical-plugin-release',
    argv: ['node', 'paper-core/bin/autonomous-empirical-plugin-release.mjs'],
    npmScript: 'automation:autonomous-empirical-plugin-release',
    mutability: 'argument-dependent',
    effects: {
      externalAction: 'argument-dependent',
      networkUse: 'argument-dependent',
      credentialUse: 'argument-dependent',
    },
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['help'],
      valueFlags: [
        'action', 'activation', 'install-root', 'package-id', 'package-version',
        'signing-config', 'template',
      ],
      repeatableValueFlags: ['benchmark-family'],
      positional: false,
    },
  }),
  route({ group: 'operator', name: 'advanced-numerical-plugin', argv: ['node', 'paper-core/bin/advanced-numerical-plugin.mjs'], npmScript: 'automation:advanced-numerical-plugin', mutability: 'argument-dependent', forwardingPolicy: 'registry', forwardedArgumentSchema: { booleanFlags: ['help', 'require-runner-ready'], valueFlags: ['action', 'config', 'output-directory', 'request'], positional: false } }),
  route({
    group: 'operator',
    name: 'autonomous-submission-dispatcher',
    argv: ['node', 'paper-core/bin/autonomous-submission-dispatcher.mjs'],
    npmScript: 'automation:autonomous-submission-dispatcher',
    mutability: 'local-write',
    effects: {
      externalAction: 'required',
      networkUse: 'required',
      credentialUse: 'required',
    },
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['help', 'resident'],
      valueFlags: ['campaign-id', 'limit', 'poll-ms', 'root', 'runtime-root'],
      positional: false,
    },
  }),
  route({
    group: 'operator',
    name: 'autonomous-submission-dispatcher-challenge',
    argv: ['node', 'paper-core/bin/autonomous-submission-dispatcher-challenge.mjs'],
    npmScript: 'automation:autonomous-submission-dispatcher-challenge',
    mutability: 'argument-dependent',
    effects: {
      externalAction: 'none',
      networkUse: 'none',
      credentialUse: 'none',
    },
    forwardingPolicy: 'registry',
    forwardedArgumentSchema: {
      booleanFlags: ['help'],
      valueFlags: [
        'action', 'plan-hash', 'idempotency-key', 'portal-id',
        'portal-configuration-hash', 'portal-descriptor-hash',
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
      booleanFlags: [
        'help', 'once', 'publish-strict-machine-intake-reconciliation',
        'require-fully-autonomous',
      ],
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
  route({ group: 'operator', name: 'reconcile', argv: ['node', 'paper-core/bin/automation-reconcile.mjs'], npmScript: 'automation:reconcile', mutability: 'argument-dependent', forwardingPolicy: 'registry', forwardedArgumentSchema: { booleanFlags: ['legacy-terminal-active-residue'], valueFlags: ['campaign-id'], positional: false } }),
  route({ group: 'operator', name: 'reconcile-apply', argv: ['node', 'paper-core/bin/automation-reconcile.mjs', '--execute'], npmScript: 'automation:reconcile:execute', mutability: 'local-write', forwardingPolicy: 'registry', forwardedArgumentSchema: { booleanFlags: ['legacy-terminal-active-residue'], valueFlags: ['campaign-id'], positional: false } }),
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
  ...COMMAND_REGISTRY_SUPPORT_ROUTES,
]);

const ROUTE_GROUPS = Object.freeze(['operator', 'maintenance', 'verify', 'retirement']);
export const HEPTA_PAPER_COMMAND_REGISTRY = Object.freeze(Object.fromEntries(ROUTE_GROUPS.map((group) => [
  group,
  Object.freeze(Object.fromEntries(ROUTES
    .filter((entry) => entry.group === group)
    .map((entry) => [entry.name, entry]))),
])));

const NPM_CLASSIFICATION = buildNpmCommandClassification(ROUTES);

export function resolveHeptaPaperCommand(group, name) {
  return HEPTA_PAPER_COMMAND_REGISTRY[group]?.[name] || null;
}

export function heptaPaperCommandUsage() {
  return Object.freeze({
    version: 4,
    kind: 'HeptaPaperCommandSurface',
    usage: 'hepta-paper <operator|maintenance|verify|retirement> <command> [-- command-args]',
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
    compatibility: 'this CLI is the supported command surface; npm scripts are classified operator, verification, maintenance, compatibility, retirement, experimental, or internal plumbing',
  });
}

export function generatedNpmRouteScripts() {
  return Object.freeze(Object.fromEntries(ROUTES
    .filter((entry) => entry.npmScript)
    .map((entry) => [entry.npmScript, entry.npmCommand || entry.argv.join(' ')])));
}

export function inspectNpmScriptRegistry(packageScripts = {}) {
  const generatedAliases = generatedNpmRouteScripts();
  const aliasMismatches = Object.freeze(Object.entries(generatedAliases).flatMap(
    ([name, command]) => packageScripts[name] === command
      ? [] : [Object.freeze({
        name,
        expected: command,
        actual: packageScripts[name] || null,
      })],
  ));
  const surface = classifyNpmScriptSurface(Object.keys(packageScripts));
  return Object.freeze({
    version: 1,
    kind: 'NpmScriptRegistryInspection',
    ready: aliasMismatches.length === 0 && surface.blocked.length === 0,
    generatedAliases,
    aliasMismatches,
    blocked: surface.blocked,
  });
}

export function heptaPaperCiCommandMatrix() {
  for (const entries of Object.values(HEPTA_PAPER_CI_COMMAND_MATRIX)) {
    for (const entry of entries) {
      for (const npmScript of entry.npmScripts) {
        if (!NPM_CLASSIFICATION.has(npmScript)) {
          throw new Error(`ci_matrix_npm_script_unregistered:${npmScript}`);
        }
      }
    }
  }
  return HEPTA_PAPER_CI_COMMAND_MATRIX;
}

export function classifyNpmScriptSurface(scriptNames) {
  const groups = Object.fromEntries(NPM_COMMAND_GROUPS.map((group) => [group, []]));
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

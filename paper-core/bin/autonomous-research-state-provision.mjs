#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function isMainModule() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(modulePath);
  }
}

const invokedAsEntrypoint = isMainModule();

let defaultComposeService = null;
if (!invokedAsEntrypoint) {
  ({
    composeConfiguredAutonomousResearchStateProvisioningService: defaultComposeService,
  } = await import(
    '../../paper-composition/bootstrap/autonomous-research-state-provisioning-input-composition.mjs'
  ));
}

export function autonomousResearchStateProvisioningUsage() {
  return [
    'Usage: autonomous-research-state-provision --action plan|execute [options]',
    '',
    '  plan (default)                 Validate immutable inputs and emit a stable plan ID.',
    '  execute --execute              Atomically install all ten canonical business schemas.',
    '  --plan-id sha256:...           Exact plan ID required by execute.',
    '  --runtime-root PATH            Fresh, nonexistent runtime target.',
    '  --machine-intake-config PATH   Valid version-2 intake configuration.',
    '  --topic-producer-profile PATH  Bound topic-producer profile.',
    '  --dataset-root PATH            Immutable registered-dataset root.',
    '  --runtime-reproducibility-maximum-attempts-per-epoch N',
    '  --runtime-reproducibility-maximum-cost-usd-per-epoch N',
    '',
    'Execute requires the external machine-intake genesis authority documents.',
    'It stages on the target filesystem, validates all ten roles, then atomically renames.',
    'The external online schema transition and signed backup/restore renewal remain required.',
  ].join('\n');
}

function finiteNumber(value, name, { minimum = 0, required = false } = {}) {
  if (value === undefined && !required) return undefined;
  const selected = Number(value);
  if (!Number.isFinite(selected) || selected < minimum) {
    throw new Error(`autonomous_research_state_provisioning_${name}_invalid`);
  }
  return selected;
}

function positiveInteger(value, name, { required = false } = {}) {
  if (value === undefined && !required) return undefined;
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new Error(`autonomous_research_state_provisioning_${name}_invalid`);
  }
  return selected;
}

function selectedPolicy(args) {
  const policy = {
    maximumAttemptsPerEpoch: positiveInteger(
      args['runtime-reproducibility-maximum-attempts-per-epoch'],
      'runtime_reproducibility_maximum_attempts_per_epoch',
      { required: true },
    ),
    maximumCostUsdPerEpoch: finiteNumber(
      args['runtime-reproducibility-maximum-cost-usd-per-epoch'],
      'runtime_reproducibility_maximum_cost_usd_per_epoch',
      { required: true },
    ),
  };
  for (const [field, option] of [
    ['budgetEpochMs', 'runtime-reproducibility-budget-epoch-ms'],
    ['leaseMs', 'runtime-reproducibility-lease-ms'],
    ['baseBackoffMs', 'runtime-reproducibility-base-backoff-ms'],
    ['maximumBackoffMs', 'runtime-reproducibility-maximum-backoff-ms'],
    ['renewalLeadMs', 'runtime-reproducibility-renewal-lead-ms'],
    ['actionSafetyMarginMs', 'runtime-reproducibility-action-safety-margin-ms'],
  ]) {
    const value = positiveInteger(args[option], option.replaceAll('-', '_'));
    if (value !== undefined) policy[field] = value;
  }
  return Object.freeze(policy);
}

export function parseAutonomousResearchStateProvisioningArguments(argv = []) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['execute', 'help'],
    valueFlags: [
      'action', 'plan-id', 'runtime-root', 'machine-intake-config',
      'topic-producer-profile', 'dataset-root',
      'runtime-reproducibility-maximum-attempts-per-epoch',
      'runtime-reproducibility-maximum-cost-usd-per-epoch',
      'runtime-reproducibility-budget-epoch-ms',
      'runtime-reproducibility-lease-ms',
      'runtime-reproducibility-base-backoff-ms',
      'runtime-reproducibility-maximum-backoff-ms',
      'runtime-reproducibility-renewal-lead-ms',
      'runtime-reproducibility-action-safety-margin-ms',
      'agent-provider', 'model', 'codex-home', 'codex-binary',
      'formal-review-provider', 'formal-review-model',
      'formal-review-codex-home', 'formal-review-codex-binary',
    ],
    positional: false,
  });
  if (args.help) return Object.freeze({ help: true });
  const action = args.action || 'plan';
  if (!['plan', 'execute'].includes(action)) {
    throw new Error(`autonomous_research_state_provisioning_action_invalid:${action}`);
  }
  if (!args['machine-intake-config'] || !args['topic-producer-profile']
    || !args['dataset-root']) {
    throw new Error('autonomous_research_state_provisioning_input_paths_required');
  }
  if (action === 'plan' && (args.execute || args['plan-id'])) {
    throw new Error('autonomous_research_state_provisioning_execute_options_forbidden');
  }
  if (action === 'execute' && args.execute !== true) {
    throw new Error('autonomous_research_state_provisioning_execute_confirmation_required');
  }
  if (action === 'execute' && !SHA256.test(String(args['plan-id'] || ''))) {
    throw new Error('autonomous_research_state_provisioning_plan_id_required');
  }
  return Object.freeze({
    help: false,
    action,
    execute: args.execute === true,
    expectedProvisioningPlanId: action === 'execute' ? args['plan-id'] : null,
    runtimeRoot: path.resolve(args['runtime-root'] || defaultPaperRuntimeRoot()),
    machineIntakeConfigPath: path.resolve(args['machine-intake-config']),
    topicProducerProfilePath: path.resolve(args['topic-producer-profile']),
    datasetRoot: path.resolve(args['dataset-root']),
    runtimeReproducibilityPolicy: selectedPolicy(args),
    providerOptions: Object.freeze(Object.fromEntries([
      'agent-provider', 'model', 'codex-home', 'codex-binary',
      'formal-review-provider', 'formal-review-model',
      'formal-review-codex-home', 'formal-review-codex-binary',
    ].filter((key) => args[key] !== undefined).map((key) => [key, args[key]]))),
  });
}

export function runAutonomousResearchStateProvisioning({
  argv = process.argv.slice(2),
  root = workspaceRoot,
  environment = process.env,
  composeService = defaultComposeService,
} = {}) {
  const options = parseAutonomousResearchStateProvisioningArguments(argv);
  if (options.help) return autonomousResearchStateProvisioningUsage();
  if (typeof composeService !== 'function') {
    throw new Error('autonomous_research_state_provisioning_composition_required');
  }
  const service = composeService({
    workspaceRoot: root,
    runtimeRoot: options.runtimeRoot,
    machineIntakeConfigPath: options.machineIntakeConfigPath,
    topicProducerProfilePath: options.topicProducerProfilePath,
    datasetRoot: options.datasetRoot,
    runtimeReproducibilityPolicy: options.runtimeReproducibilityPolicy,
    providerOptions: options.providerOptions,
    environment,
  });
  return options.action === 'plan'
    ? service.plan()
    : service.execute({
      expectedProvisioningPlanId: options.expectedProvisioningPlanId,
    });
}

if (invokedAsEntrypoint) {
  Promise.resolve().then(async () => {
    const options = parseAutonomousResearchStateProvisioningArguments(process.argv.slice(2));
    if (options.help) return autonomousResearchStateProvisioningUsage();
    const {
      composeConfiguredAutonomousResearchStateProvisioningService,
    } = await import(
      '../../paper-composition/bootstrap/autonomous-research-state-provisioning-input-composition.mjs'
    );
    return runAutonomousResearchStateProvisioning({
      composeService: composeConfiguredAutonomousResearchStateProvisioningService,
    });
  }).then((report) => {
    process.stdout.write(`${typeof report === 'string'
      ? report : JSON.stringify(report, null, 2)}\n`);
    if (typeof report !== 'string' && report.ready !== true) process.exitCode = 2;
  }).catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}

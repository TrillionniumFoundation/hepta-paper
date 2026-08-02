#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeConfiguredAutonomousResearchStatePartialRootMaintenanceService,
} from '../../paper-composition/bootstrap/autonomous-research-state-partial-root-maintenance-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function autonomousResearchStatePartialRootMaintenanceUsage() {
  return [
    'Usage: hepta-paper maintenance autonomous-state-partial-root-maintenance -- [options]',
    '',
    '  --action plan (default)        Read-only validation and stable plan ID.',
    '  --action execute --execute     Perform the offline pre-transition repair.',
    '  --maintenance-plan-id sha256:... Exact current plan ID required by execute.',
    '  --runtime-root PATH            Historical partial native runtime root.',
    '  --rescue-root PATH             Existing same-filesystem rescue destination.',
    '  --writer-quiescence-receipt PATH',
    '                                 Current bounded writer-fencing evidence.',
    '  --machine-intake-config PATH   Valid version-2 intake configuration.',
    '  --topic-producer-profile PATH  Bound topic-producer profile.',
    '  --dataset-root PATH            Immutable registered-dataset root.',
    '  --runtime-reproducibility-maximum-attempts-per-epoch N',
    '  --runtime-reproducibility-maximum-cost-usd-per-epoch N',
    '',
    'This command is not the fresh-root provisioner and does not invoke or reset',
    'state authority. It accepts only the manifest-bound historical 5+5 closure,',
    'creates and restore-verifies a rescue bundle before mutation, and stops with',
    'the independent externally authorized online schema transition still required.',
  ].join('\n');
}

function finiteNumber(value, name, { minimum = 0, required = false } = {}) {
  if (value === undefined && !required) return undefined;
  const selected = Number(value);
  if (!Number.isFinite(selected) || selected < minimum) {
    throw new Error(`autonomous_research_state_partial_root_${name}_invalid`);
  }
  return selected;
}

function positiveInteger(value, name, { required = false } = {}) {
  if (value === undefined && !required) return undefined;
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new Error(`autonomous_research_state_partial_root_${name}_invalid`);
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

export function parseAutonomousResearchStatePartialRootMaintenanceArguments(argv = []) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['execute', 'help'],
    valueFlags: [
      'action', 'maintenance-plan-id', 'runtime-root', 'rescue-root',
      'writer-quiescence-receipt', 'machine-intake-config',
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
    throw new Error(`autonomous_research_state_partial_root_action_invalid:${action}`);
  }
  const required = [
    'rescue-root', 'writer-quiescence-receipt', 'machine-intake-config',
    'topic-producer-profile', 'dataset-root',
  ];
  if (required.some((key) => !args[key])) {
    throw new Error('autonomous_research_state_partial_root_input_paths_required');
  }
  if (action === 'plan' && (args.execute || args['maintenance-plan-id'])) {
    throw new Error('autonomous_research_state_partial_root_execute_options_forbidden');
  }
  if (action === 'execute' && args.execute !== true) {
    throw new Error('autonomous_research_state_partial_root_execute_confirmation_required');
  }
  if (action === 'execute' && !SHA256.test(String(args['maintenance-plan-id'] || ''))) {
    throw new Error('autonomous_research_state_partial_root_plan_id_required');
  }
  return Object.freeze({
    help: false,
    action,
    runtimeRoot: path.resolve(args['runtime-root'] || defaultPaperRuntimeRoot()),
    rescueRoot: path.resolve(args['rescue-root']),
    writerQuiescenceReceiptPath: path.resolve(args['writer-quiescence-receipt']),
    machineIntakeConfigPath: path.resolve(args['machine-intake-config']),
    topicProducerProfilePath: path.resolve(args['topic-producer-profile']),
    datasetRoot: path.resolve(args['dataset-root']),
    runtimeReproducibilityPolicy: selectedPolicy(args),
    expectedMaintenancePlanId: action === 'execute' ? args['maintenance-plan-id'] : null,
    providerOptions: Object.freeze(Object.fromEntries([
      'agent-provider', 'model', 'codex-home', 'codex-binary',
      'formal-review-provider', 'formal-review-model',
      'formal-review-codex-home', 'formal-review-codex-binary',
    ].filter((key) => args[key] !== undefined).map((key) => [key, args[key]]))),
  });
}

export function runAutonomousResearchStatePartialRootMaintenance({
  argv = process.argv.slice(2),
  root = workspaceRoot,
  environment = process.env,
  composeService = composeConfiguredAutonomousResearchStatePartialRootMaintenanceService,
} = {}) {
  const options = parseAutonomousResearchStatePartialRootMaintenanceArguments(argv);
  if (options.help) return autonomousResearchStatePartialRootMaintenanceUsage();
  const service = composeService({
    workspaceRoot: root,
    runtimeRoot: options.runtimeRoot,
    rescueRoot: options.rescueRoot,
    writerQuiescenceReceiptPath: options.writerQuiescenceReceiptPath,
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
      expectedMaintenancePlanId: options.expectedMaintenancePlanId,
    });
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  try {
    const report = runAutonomousResearchStatePartialRootMaintenance();
    process.stdout.write(`${typeof report === 'string'
      ? report : JSON.stringify(report, null, 2)}\n`);
    if (typeof report !== 'string' && report.ready !== true) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}

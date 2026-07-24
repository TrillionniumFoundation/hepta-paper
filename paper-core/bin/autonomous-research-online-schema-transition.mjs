#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeAutonomousResearchOnlineSchemaTransitionService,
} from '../../paper-composition/automation/autonomous-research-online-schema-transition-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function autonomousResearchOnlineSchemaTransitionUsage() {
  return [
    'Usage: hepta-paper maintenance autonomous-online-schema-transition -- --action plan|execute [options]',
    '',
    '  plan (default)                 Read-only simulation; emits the stable transition ID.',
    '  execute                        Perform the quiesced offline transition.',
    '  --execute                      Mandatory second confirmation for action=execute.',
    '  --transition-id sha256:...     Exact transition ID emitted by the current plan.',
    '  --runtime-root PATH            Runtime root containing the closed database inventory.',
    '  --authority-process-config PATH',
    '                                 Pinned external authority process configuration.',
    '  --requested-lease-ms N         Reservation lease request (default 120000).',
    '  --required-execution-window-ms N',
    '                                 Required execution window (default 30000).',
    '  --commit-safety-margin-ms N    Per-commit lease margin (default 1000).',
    '',
    'Plan never creates transition control state or mutates a database. Execute fails',
    'closed unless both confirmations bind the current plan and pinned authority.',
  ].join('\n');
}

function positiveInteger(value, fallback, name, minimum = 1) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`autonomous_research_online_schema_transition_${name}_invalid`);
  }
  return parsed;
}

export function parseAutonomousResearchOnlineSchemaTransitionArguments(argv = []) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['execute', 'help'],
    valueFlags: [
      'action', 'runtime-root', 'authority-process-config', 'transition-id',
      'requested-lease-ms', 'required-execution-window-ms',
      'commit-safety-margin-ms',
    ],
    positional: false,
  });
  if (args.help) return Object.freeze({ help: true });
  const action = args.action || 'plan';
  if (!['plan', 'execute'].includes(action)) {
    throw new Error(`autonomous_research_online_schema_transition_action_invalid:${action}`);
  }
  if (!args['authority-process-config']) {
    throw new Error(
      'autonomous_research_online_schema_transition_authority_process_config_required',
    );
  }
  if (action === 'plan' && args.execute) {
    throw new Error('autonomous_research_online_schema_transition_execute_action_required');
  }
  if (action === 'execute' && args.execute !== true) {
    throw new Error('autonomous_research_online_schema_transition_execute_confirmation_required');
  }
  if (action === 'execute' && !SHA256.test(String(args['transition-id'] || ''))) {
    throw new Error('autonomous_research_online_schema_transition_transition_id_required');
  }
  if (action === 'plan' && (args['transition-id'] || args['commit-safety-margin-ms'])) {
    throw new Error('autonomous_research_online_schema_transition_execute_option_forbidden_in_plan');
  }
  const requestedLeaseMs = positiveInteger(
    args['requested-lease-ms'], 120000, 'requested_lease_ms', 1000,
  );
  const requiredExecutionWindowMs = positiveInteger(
    args['required-execution-window-ms'], 30000, 'required_execution_window_ms', 1000,
  );
  const commitSafetyMarginMs = positiveInteger(
    args['commit-safety-margin-ms'], 1000, 'commit_safety_margin_ms', 1,
  );
  if (requiredExecutionWindowMs > requestedLeaseMs) {
    throw new Error('autonomous_research_online_schema_transition_execution_window_invalid');
  }
  if (commitSafetyMarginMs >= requiredExecutionWindowMs) {
    throw new Error('autonomous_research_online_schema_transition_safety_margin_invalid');
  }
  return Object.freeze({
    help: false,
    action,
    execute: args.execute === true,
    runtimeRoot: path.resolve(args['runtime-root'] || defaultPaperRuntimeRoot()),
    authorityProcessConfigurationPath: path.resolve(args['authority-process-config']),
    expectedTransitionId: action === 'execute' ? args['transition-id'] : null,
    requestedLeaseMs,
    requiredExecutionWindowMs,
    commitSafetyMarginMs,
  });
}

export function runAutonomousResearchOnlineSchemaTransition({
  argv = process.argv.slice(2),
  root = workspaceRoot,
  composeService = composeAutonomousResearchOnlineSchemaTransitionService,
} = {}) {
  const options = parseAutonomousResearchOnlineSchemaTransitionArguments(argv);
  if (options.help) return autonomousResearchOnlineSchemaTransitionUsage();
  const service = composeService({
    workspaceRoot: root,
    runtimeRoot: options.runtimeRoot,
    authorityProcessConfigurationPath: options.authorityProcessConfigurationPath,
  });
  return options.action === 'plan'
    ? service.plan({
      requestedLeaseMs: options.requestedLeaseMs,
      requiredExecutionWindowMs: options.requiredExecutionWindowMs,
    })
    : service.execute({
      expectedTransitionId: options.expectedTransitionId,
      requestedLeaseMs: options.requestedLeaseMs,
      requiredExecutionWindowMs: options.requiredExecutionWindowMs,
      commitSafetyMarginMs: options.commitSafetyMarginMs,
    });
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  try {
    const report = runAutonomousResearchOnlineSchemaTransition();
    process.stdout.write(`${typeof report === 'string'
      ? report : JSON.stringify(report, null, 2)}\n`);
    if (typeof report !== 'string' && report.ready !== true) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeStrictFullAutoAcceptance } from '../../paper-composition/automation/strict-full-auto-acceptance-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function strictFullAutoAcceptanceUsage() {
  return Object.freeze({
    version: 1,
    kind: 'StrictFullAutoAcceptanceUsage',
    usage: 'hepta-paper operator strict-full-auto-acceptance -- --action plan|status|execute|converge --configuration PATH [--plan-hash sha256:... --execute]',
    actions: Object.freeze({
      plan: 'preflight every public/opaque external reference and emit an immutable plan hash without mutation',
      status: 'revalidate configuration/reference identity and live-verify all external readiness gates; local checkpoint files are never acceptance authority',
      execute: 'requires --execute plus the exact plan hash; converges the fixed dependency order and resumes crash checkpoints',
      converge: 'requires --execute; atomically preflights the complete plan, binds its exact hash, executes it and performs fresh live verification without a human hash handoff',
    }),
    guarantees: Object.freeze({
      missingReferenceHasZeroSideEffects: true,
      opaqueSecretFilesRead: false,
      privateKeysGenerated: false,
      externalAuthoritiesSelfSigned: false,
      completedStepsReexecuted: false,
      skippedOperationalChecksAllowed: false,
      localCheckpointCanAuthorizeAcceptance: false,
      completedAcceptanceRequiresLiveVerification: true,
      unattendedPlanHashBinding: true,
    }),
  });
}

export function parseStrictFullAutoAcceptanceArguments(argv = []) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['execute', 'help', 'require-accepted'],
    valueFlags: ['action', 'configuration', 'plan-hash'],
    positional: false,
  });
  if (args.help) return Object.freeze({ help: true });
  const action = String(args.action || 'plan');
  if (!['plan', 'status', 'execute', 'converge'].includes(action)) {
    throw new Error(`strict_full_auto_acceptance_action_invalid:${action}`);
  }
  if (!args.configuration) throw new Error('strict_full_auto_acceptance_configuration_required');
  if (!['execute', 'converge'].includes(action) && (args.execute || args['plan-hash'])) {
    throw new Error('strict_full_auto_acceptance_execute_options_forbidden');
  }
  if (action === 'execute' && (args.execute !== true
    || !SHA256.test(String(args['plan-hash'] || '')))) {
    throw new Error('strict_full_auto_acceptance_execute_confirmation_and_plan_hash_required');
  }
  if (action === 'converge' && (args.execute !== true || args['plan-hash'])) {
    throw new Error('strict_full_auto_acceptance_converge_confirmation_required');
  }
  return Object.freeze({
    help: false,
    action,
    configurationPath: path.resolve(args.configuration),
    expectedPlanHash: action === 'execute' ? args['plan-hash'] : null,
    requireAccepted: args['require-accepted'] === true,
  });
}

export async function runStrictFullAutoAcceptance({
  argv = process.argv.slice(2),
  root = workspaceRoot,
  environment = process.env,
  compose = composeStrictFullAutoAcceptance,
} = {}) {
  const options = parseStrictFullAutoAcceptanceArguments(argv);
  if (options.help) return strictFullAutoAcceptanceUsage();
  const orchestrator = compose({
    workspaceRoot: root,
    configurationPath: options.configurationPath,
    environment,
  });
  let report;
  if (options.action === 'plan') report = orchestrator.plan();
  else if (options.action === 'status') report = await orchestrator.status();
  else if (options.action === 'converge') {
    const plan = orchestrator.plan();
    report = await orchestrator.execute({ expectedPlanHash: plan.planHash });
  } else {
    report = await orchestrator.execute({ expectedPlanHash: options.expectedPlanHash });
  }
  return Object.freeze({ report, requireAccepted: options.requireAccepted });
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  try {
    const result = await runStrictFullAutoAcceptance();
    if (result?.kind === 'StrictFullAutoAcceptanceUsage') {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
      if (result.requireAccepted && result.report?.strictFullAutoAccepted !== true) {
        process.exitCode = 2;
      }
    }
  } catch (error) {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}

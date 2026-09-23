#!/usr/bin/env node
import path from 'node:path';

import {
  applyAutonomousResearchMachineIntakeAuthorityRotation,
  planAutonomousResearchMachineIntakeAuthorityRotation,
} from '../../paper-composition/automation/autonomous-research-machine-intake-authority-rotation-composition.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

function usage() {
  return [
    'Usage: hepta-paper operator autonomous-intake-authority-rotation -- --action plan|apply [options]',
    '',
    'Required target authority:',
    '  --next-machine-intake-config PATH  Hash-valid v2 machine-intake configuration.',
    '  --topic-producer-profile PATH      Bound producer profile and implementation identity.',
    '  Authorization bundle              Fixed root-owned /etc/hepta-paper/authority-rotation/.',
    '',
    'Apply confirmation:',
    '  --plan-hash sha256:...             Exact hash emitted by the current read-only plan.',
    '  --expected-authority-generation N  Exact generation emitted by that plan.',
    '  --rotation-intent PATH              Exact signed intent for this plan and generation.',
    '  --execute                          Required for apply; plan never writes.',
    '',
    'The resident supervisor must be stopped. Active resident/intake/producer leases,',
    'outstanding planned or authorized topic generations, and target identity conflicts',
    'all fail closed. This command performs no network or provider action.',
  ].join('\n');
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`autonomous_research_machine_intake_authority_rotation_${name}_invalid`);
  }
  return parsed;
}

function main() {
  const args = parseStrictCliArguments(process.argv.slice(2), {
    booleanFlags: ['execute', 'help'],
    valueFlags: [
      'action', 'runtime-root', 'next-machine-intake-config', 'topic-producer-profile',
      'rotation-intent', 'plan-hash',
      'expected-authority-generation',
    ],
    positional: false,
  });
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const action = args.action || 'plan';
  if (!['plan', 'apply'].includes(action)) {
    throw new Error(`autonomous_research_machine_intake_authority_rotation_action_invalid:${action}`);
  }
  if (!args['next-machine-intake-config'] || !args['topic-producer-profile']) {
    throw new Error('autonomous_research_machine_intake_authority_rotation_target_files_required');
  }
  const options = {
    runtimeRoot: path.resolve(args['runtime-root'] || defaultPaperRuntimeRoot()),
    nextConfigurationPath: path.resolve(args['next-machine-intake-config']),
    topicProducerProfilePath: path.resolve(args['topic-producer-profile']),
  };
  const report = action === 'plan'
    ? planAutonomousResearchMachineIntakeAuthorityRotation(options)
    : applyAutonomousResearchMachineIntakeAuthorityRotation({
      ...options,
      planHash: args['plan-hash'],
      rotationIntentPath: args['rotation-intent']
        ? path.resolve(args['rotation-intent']) : null,
      expectedAuthorityGeneration: positiveInteger(
        args['expected-authority-generation'],
        'expected_generation',
      ),
      execute: args.execute === true,
    });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.ready !== true) process.exitCode = 2;
}

try { main(); }
catch (error) {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
}

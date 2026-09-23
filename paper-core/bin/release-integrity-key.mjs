#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import {
  inspectLocalReleaseIntegrityKey,
  provisionLocalReleaseIntegrityKey,
} from './release-integrity-key-management.mjs';

export function releaseIntegrityKeyUsage() {
  return [
    'Usage: release-integrity-key --action status|provision [options]',
    '',
    '  --action status        Read-only validation of the existing local key pair (default).',
    '  --action provision     Create the pair once; requires --execute.',
    '  --execute              Explicit confirmation required only by provision.',
    '  --runtime-root PATH    Physically decoupled existing runtime root.',
    '',
    'Provision never rotates, repairs, or overwrites an existing or partial pair.',
    'This host-resident exportable key authenticates build/archive integrity only.',
    'It is not owner, academic, referee, submission, external KMS/HSM, or full-production authority.',
  ].join('\n');
}

export function parseReleaseIntegrityKeyArguments(argv = []) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['execute', 'help'],
    valueFlags: ['action', 'runtime-root'],
    positional: false,
  });
  if (args.help) return Object.freeze({ help: true });
  const action = args.action || 'status';
  if (!['status', 'provision'].includes(action)) {
    throw new Error(`release_integrity_key_action_invalid:${action}`);
  }
  if (action === 'status' && args.execute) {
    throw new Error('release_integrity_key_status_execute_forbidden');
  }
  if (action === 'provision' && args.execute !== true) {
    throw new Error('release_integrity_key_provision_execute_required');
  }
  return Object.freeze({
    help: false,
    action,
    execute: args.execute === true,
    runtimeRoot: args['runtime-root'] ? path.resolve(args['runtime-root']) : null,
  });
}

export function runReleaseIntegrityKeyCommand({
  argv = process.argv.slice(2),
  environment = process.env,
  inspect = inspectLocalReleaseIntegrityKey,
  provision = ({ runtimeRoot, environment }) => provisionLocalReleaseIntegrityKey({
    runtimeRoot,
    environment,
    execute: true,
  }),
} = {}) {
  const options = parseReleaseIntegrityKeyArguments(argv);
  if (options.help) return releaseIntegrityKeyUsage();
  if (environment.HEPTA_PAPER_RUNTIME_ISOLATED === '1') {
    throw new Error('release_integrity_key_access_forbidden_in_isolated_runtime');
  }
  const runtimeRoot = options.runtimeRoot
    || (environment.HEPTA_PAPER_RUNTIME_ROOT
      ? path.resolve(environment.HEPTA_PAPER_RUNTIME_ROOT)
      : defaultPaperRuntimeRoot());
  return options.action === 'status'
    ? inspect({ runtimeRoot, environment })
    : provision({ runtimeRoot, environment });
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  try {
    const report = runReleaseIntegrityKeyCommand();
    process.stdout.write(`${typeof report === 'string'
      ? report : JSON.stringify(report, null, 2)}\n`);
    if (typeof report !== 'string' && report.ready !== true) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}

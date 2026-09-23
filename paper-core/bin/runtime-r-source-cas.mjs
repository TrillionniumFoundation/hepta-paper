#!/usr/bin/env node
import path from 'node:path';

import {
  composeRRuntimeSourceCasAcquisition,
  inspectRRuntimeSourceCas,
} from '../../paper-composition/automation/r-runtime-source-cas-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

function usage() {
  return [
    'Usage: hepta-paper operator runtime-r-source-cas -- --action status|acquire [options]',
    '',
    '  status             Read-only exact-closure and SHA-256 verification (default).',
    '  acquire            Atomically acquire every renv.lock source archive.',
    '  --seed PATH        Reuse a read-only directory of previously downloaded tarballs.',
    '  --concurrency N    Maximum concurrent network downloads for missing archives.',
    '  --root PATH        Repository root.',
  ].join('\n');
}

async function main() {
  const args = parseStrictCliArguments(process.argv.slice(2), {
    booleanFlags: ['help'],
    valueFlags: ['action', 'seed', 'concurrency', 'root'],
    positional: false,
  });
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const action = args.action || 'status';
  if (!['status', 'acquire'].includes(action)) {
    throw new Error(`r_runtime_source_cas_action_invalid:${action}`);
  }
  const options = {
    repositoryRoot: path.resolve(args.root || process.cwd()),
    seedSourceDirectory: args.seed || null,
    concurrency: Number(args.concurrency || 6),
  };
  const report = action === 'status'
    ? inspectRRuntimeSourceCas(options)
    : await composeRRuntimeSourceCasAcquisition(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.ready !== true) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});

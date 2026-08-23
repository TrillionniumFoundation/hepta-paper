#!/usr/bin/env node
import path from 'node:path';

import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import { buildReleaseReadinessPlan } from '../verification/release-readiness-plan.mjs';

export function parseReleaseReadinessPlanArguments(argv) {
  return parseStrictCliArguments(argv, {
    booleanFlags: ['help', 'require-ready'],
    valueFlags: ['root', 'runtime-root'],
    positional: false,
  });
}
function usage() {
  return Object.freeze({
    version: 1,
    kind: 'ReleaseReadinessPlanUsage',
    usage: 'release-readiness-plan [--root PATH] [--runtime-root PATH] [--require-ready]',
    effects: 'read-only; no credentials, network, authority minting, or external actions',
    exitCodes: Object.freeze({ ready: 0, blocked: 2, invalid: 1 }),
  });
}

export function runReleaseReadinessPlan({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  environment = process.env,
  build = buildReleaseReadinessPlan,
} = {}) {
  const args = parseReleaseReadinessPlanArguments(argv);
  if (args.help) {
    stdout.write(`${JSON.stringify(usage(), null, 2)}\n`);
    return Object.freeze({ output: usage(), exitCode: 0 });
  }
  const output = build({
    workspaceRoot: path.resolve(args.root || process.cwd()),
    runtimeRoot: args['runtime-root'] ? path.resolve(args['runtime-root']) : null,
    environment,
  });
  stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return Object.freeze({
    output,
    exitCode: args['require-ready'] && output.status !== 'release_readiness_ready' ? 2 : 0,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const result = runReleaseReadinessPlan();
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}

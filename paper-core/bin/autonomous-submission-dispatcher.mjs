#!/usr/bin/env node
import path from 'node:path';
import {
  dispatchAutonomousSubmissionHandoffs,
} from '../../paper-composition/automation/autonomous-submission-dispatcher-composition.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: ['help', 'resident'],
  valueFlags: ['campaign-id', 'limit', 'poll-ms', 'root', 'runtime-root'],
  positional: false,
});

function usage() {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionDispatcherUsage',
    usage: 'hepta-paper operator autonomous-submission-dispatcher -- [--resident] [--campaign-id ID]',
    securityBoundary: 'only this executable reads portal credentials and performs portal network actions',
  });
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`autonomous_submission_dispatcher_${field}_invalid`);
  }
  return number;
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function main() {
  if (args.help) {
    process.stdout.write(`${JSON.stringify(usage(), null, 2)}\n`);
    return;
  }
  const root = path.resolve(args.root || defaultPaperAssetRoot());
  const runtimeRoot = path.resolve(args['runtime-root'] || defaultPaperRuntimeRoot());
  const limit = boundedInteger(args.limit, 100, 1, 1000, 'limit');
  const pollMs = boundedInteger(args['poll-ms'], 30_000, 1_000, 300_000, 'poll_ms');
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  do {
    const report = await dispatchAutonomousSubmissionHandoffs({
      root,
      runtimeRoot,
      campaignId: args['campaign-id'] || null,
      limit,
      environment: process.env,
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!args.resident || controller.signal.aborted) break;
    await wait(pollMs, controller.signal);
  } while (!controller.signal.aborted);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});

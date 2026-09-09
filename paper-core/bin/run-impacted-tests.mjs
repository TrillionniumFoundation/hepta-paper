#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import {
  buildTestImpactGraph,
  selectImpactedTests,
  shardImpactedTests,
} from '../src/test-impact-graph.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const options = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: ['dry-run', 'help', 'json'],
  valueFlags: ['base-ref', 'head-ref', 'shard-count', 'shard-index', 'test-concurrency'],
  repeatableValueFlags: ['changed-file'],
  positional: false,
});

function usage() {
  return Object.freeze({
    version: 1,
    kind: 'ImpactedTestRunnerUsage',
    usage: 'run-impacted-tests [--base-ref REF] [--head-ref REF] [--changed-file PATH] [--shard-count 1..8] [--shard-index INDEX] [--test-concurrency N] [--dry-run] [--json]',
    selection: 'transitive-relative-imports-and-explicit-test-path-references',
    safety: 'global-or-unmapped-changes-fall-back-to-all-portable-tests',
    mutation: 'test-process-effects-only',
  });
}

if (options.help) {
  process.stdout.write(`${JSON.stringify(usage(), null, 2)}\n`);
  process.exit(0);
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`test_impact_git_command_failed:${args[0]}:${String(
      result.stderr || result.error?.message || '',
    ).trim()}`);
  }
  return result.stdout;
}

function zeroDelimited(buffer) {
  return String(buffer || '').split('\0').filter(Boolean);
}

function discoveredFiles() {
  return zeroDelimited(git([
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ]));
}

function changedFiles() {
  if (options['changed-file']?.length) return options['changed-file'];
  const baseRef = options['base-ref'] || process.env.GITHUB_BASE_SHA || 'HEAD^';
  const headRef = options['head-ref'] || 'HEAD';
  const committed = zeroDelimited(git([
    'diff',
    '--name-only',
    '-z',
    '--diff-filter=ACDMRTUXB',
    `${baseRef}...${headRef}`,
  ]));
  if (headRef !== 'HEAD') return committed;
  return [...new Set([
    ...committed,
    ...zeroDelimited(git(['diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB'])),
    ...zeroDelimited(git([
      'diff',
      '--cached',
      '--name-only',
      '-z',
      '--diff-filter=ACDMRTUXB',
    ])),
  ])];
}

function positiveInteger(value, fallback, code) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(code);
  return number;
}

const shardCount = positiveInteger(
  options['shard-count'] || process.env.HEPTA_TEST_SHARD_COUNT,
  1,
  'test_impact_shard_count_invalid',
);
const shardIndex = Number(
  options['shard-index'] || process.env.HEPTA_TEST_SHARD_INDEX || 0,
);
const testConcurrency = positiveInteger(
  options['test-concurrency'] || process.env.HEPTA_TEST_CONCURRENCY,
  1,
  'test_impact_test_concurrency_invalid',
);
const graph = buildTestImpactGraph({
  files: discoveredFiles(),
  readSource(relative) {
    const absolute = path.join(workspaceRoot, relative);
    return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
  },
});
const selection = selectImpactedTests({ graph, changedFiles: changedFiles() });
const shardTests = shardImpactedTests(selection.selectedTests, {
  shardCount,
  shardIndex,
});
const report = Object.freeze({
  version: 1,
  kind: 'ImpactedTestExecutionPlan',
  status: shardTests.length
    ? 'impacted_test_execution_planned'
    : 'impacted_test_execution_empty_shard',
  baseRef: options['base-ref'] || process.env.GITHUB_BASE_SHA || 'HEAD^',
  headRef: options['head-ref'] || 'HEAD',
  testImpactGraphHash: graph.testImpactGraphHash,
  testImpactSelectionHash: selection.testImpactSelectionHash,
  selectionStatus: selection.status,
  changedFiles: selection.changedFiles,
  fallbackFiles: selection.fallbackFiles,
  selectedTestCount: selection.selectedTestCount,
  totalTestCount: selection.totalTestCount,
  shardCount,
  shardIndex,
  shardTestCount: shardTests.length,
  shardTests,
});

if (options.json || options['dry-run']) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    `Impacted tests ${selection.selectedTestCount}/${selection.totalTestCount}; `
      + `shard ${shardIndex + 1}/${shardCount}: ${shardTests.length}\n`,
  );
}
if (options['dry-run'] || !shardTests.length) process.exit(0);

const result = spawnSync(process.execPath, [
  `--test-concurrency=${testConcurrency}`,
  '--test',
  ...shardTests,
], {
  cwd: workspaceRoot,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

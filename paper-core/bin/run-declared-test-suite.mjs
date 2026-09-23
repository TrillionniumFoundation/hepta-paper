#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { declaredTestSuite } from '../src/test-suite-manifest.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [suiteName, profile = 'full'] = process.argv.slice(2);
if (!suiteName) throw new Error('Usage: run-declared-test-suite.mjs <suite> [full|deduplicated]');
const suite = declaredTestSuite(suiteName, profile);
if (!suite.tests.length) throw new Error(`declared_test_suite_empty:${suiteName}:${profile}`);

const isolatedRunner = path.join(workspaceRoot, 'paper-core', 'bin', 'run-isolated-command.mjs');
const command = process.execPath;
const testArguments = [...suite.nodeArguments, ...suite.tests];
const args = suite.isolated
  ? [isolatedRunner, process.execPath, ...testArguments]
  : testArguments;
const result = spawnSync(command, args, {
  cwd: workspaceRoot,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

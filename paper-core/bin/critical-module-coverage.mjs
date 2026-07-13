#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const coverageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-critical-coverage-'));
const tests = [
  'paper-core/tests/paper-contracts-facade.test.mjs',
  'paper-core/tests/architecture-conformance.test.mjs',
  'paper-core/tests/automation-executors.test.mjs',
  'paper-core/tests/automation-runtime-reconciler.test.mjs',
  'paper-core/tests/formal-claim-binding-policy.test.mjs',
  'paper-core/tests/manuscript-promotion-boundaries.test.mjs',
  'paper-core/tests/legacy-provenance-delivery-hardening.test.mjs',
  'paper-core/tests/submission-live-delivery.test.mjs',
  'paper-core/tests/typed-research-gap-plan.test.mjs',
  'migration/tests/operational-proof-intake.test.mjs',
];
const targets = [
  ...fs.readdirSync(path.join(workspaceRoot, 'paper-domain', 'contracts'))
    .filter((name) => name.endsWith('.mjs') && name !== 'index.mjs')
    .map((name) => `paper-domain/contracts/${name}`),
  'paper-adapters/automation/automation-runtime-reconciler.mjs',
  'paper-adapters/automation/bounded-child-process.mjs',
  'paper-adapters/automation/workspace-change-tracker.mjs',
  'paper-adapters/persistence/receipt-issuer-policy.mjs',
  'paper-adapters/persistence/sqlite-receipt-ledger.mjs',
  'paper-adapters/referee-revise/planning-service.mjs',
  'paper-adapters/submission/live-authorization.mjs',
];

function coverageEntries() {
  return fs.readdirSync(coverageRoot)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => JSON.parse(fs.readFileSync(path.join(coverageRoot, name), 'utf8')).result || []);
}

function countAt(functions, offset) {
  let bestLength = Infinity;
  let count = 0;
  for (const fn of functions) {
    for (const range of fn.ranges || []) {
      if (range.startOffset <= offset && offset < range.endOffset) {
        const length = range.endOffset - range.startOffset;
        if (length < bestLength) {
          bestLength = length;
          count = range.count;
        } else if (length === bestLength) count = Math.max(count, range.count);
      }
    }
  }
  return count;
}

function moduleCoverage(relative, entries) {
  const absolute = path.join(workspaceRoot, relative);
  const url = pathToFileURL(absolute).href;
  const matching = entries.filter((entry) => entry.url === url);
  if (!matching.length) return { relative, lines: 0, functions: 0, missing: true };
  const source = fs.readFileSync(absolute, 'utf8');
  let offset = 0;
  let executable = 0;
  let covered = 0;
  for (const line of source.split(/\n/)) {
    const first = line.search(/\S/);
    if (first >= 0 && !/^\s*(?:\/\/|\*|\/\*)/.test(line)) {
      executable += 1;
      if (matching.some((entry) => countAt(entry.functions || [], offset + first) > 0)) covered += 1;
    }
    offset += line.length + 1;
  }
  const functions = new Map();
  for (const entry of matching) {
    for (const fn of entry.functions || []) {
      const first = fn.ranges?.[0];
      if (!first || (!fn.functionName && first.startOffset === 0 && first.endOffset >= source.length)) continue;
      const key = `${fn.functionName}:${first.startOffset}:${first.endOffset}`;
      functions.set(key, Math.max(functions.get(key) || 0, first.count || 0));
    }
  }
  const functionTotal = functions.size;
  const functionCovered = [...functions.values()].filter((count) => count > 0).length;
  return {
    relative,
    lines: executable ? Number((covered * 100 / executable).toFixed(2)) : 100,
    functions: functionTotal ? Number((functionCovered * 100 / functionTotal).toFixed(2)) : 100,
    coveredLines: covered,
    executableLines: executable,
    coveredFunctions: functionCovered,
    functionTotal,
    missing: false,
  };
}

try {
  const commands = [
    ['--test', '--test-concurrency=1', ...tests],
    ['paper-core/src/selftest.mjs'],
    ['paper-core/src/remediation-selftest.mjs'],
    ['migration/tests/p1-referee-revise-retirements.mjs'],
  ];
  const failed = commands.map((args) => spawnSync(process.execPath, args, {
    cwd: workspaceRoot,
    env: { ...process.env, NODE_V8_COVERAGE: coverageRoot },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })).find((run) => run.status !== 0);
  if (failed) {
    process.stdout.write(failed.stdout || '');
    process.stderr.write(failed.stderr || '');
    process.exitCode = failed.status || 1;
  } else {
    const entries = coverageEntries();
    const report = targets.map((target) => moduleCoverage(target, entries));
    const failures = report.filter((row) => row.missing || row.lines < 35 || row.functions < 20);
    process.stdout.write(`${JSON.stringify({
      ok: failures.length === 0,
      kind: 'CriticalModuleCoverageReport',
      thresholds: { lines: 35, functions: 20 },
      modules: report,
      failures: failures.map((row) => row.relative),
    }, null, 2)}\n`);
    if (failures.length) process.exitCode = 1;
  }
} finally {
  fs.rmSync(coverageRoot, { recursive: true, force: true });
}

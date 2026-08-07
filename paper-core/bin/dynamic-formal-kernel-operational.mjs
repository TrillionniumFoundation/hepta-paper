#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const testFiles = Object.freeze([
  'paper-core/tests/dynamic-formal-claim-kernel-e2e.test.mjs',
  'paper-core/tests/formal-campaign-release.test.mjs',
  'paper-core/tests/formal-proof-search-operations.test.mjs',
  'paper-core/tests/typed-theorem-dependency-graph.test.mjs',
]);
const expected = Object.freeze({
  tests: 22,
  suites: 0,
  pass: 22,
  fail: 0,
  cancelled: 0,
  skipped: 0,
  todo: 0,
});

export function parseFormalOperationalTapSummary(output) {
  const normalized = String(output || '').replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) return Object.freeze({ valid: false });
  const withoutFinalNewline = normalized.endsWith('\n')
    ? normalized.slice(0, -1) : normalized;
  const lines = withoutFinalNewline.split('\n');
  const names = Object.keys(expected);
  const summaryPrefix = new RegExp(`^# (?:${names.join('|')})\\b`);
  const summaryLines = lines.filter((line) => summaryPrefix.test(line));
  const planLines = lines.filter((line) => /^1\.\./.test(line));
  const durationLines = lines.filter((line) => /^# duration_ms\b/.test(line));
  if (summaryLines.length !== names.length
    || planLines.length !== 1
    || durationLines.length !== 1) {
    return Object.freeze({ valid: false });
  }
  const terminal = lines.slice(-(names.length + 2));
  if (terminal.length !== names.length + 2 || terminal[0] !== '1..22') {
    return Object.freeze({ valid: false });
  }
  const summary = {};
  for (const [index, name] of names.entries()) {
    const match = terminal[index + 1].match(new RegExp(`^# ${name} (\\d+)$`));
    if (!match) return Object.freeze({ valid: false });
    summary[name] = Number(match[1]);
  }
  const durationMatch = terminal.at(-1).match(
    /^# duration_ms (?:0|[1-9]\d*)(?:\.\d+)?$/,
  );
  if (!durationMatch) return Object.freeze({ valid: false });
  const valid = Object.entries(expected).every(([name, value]) => (
    summary[name] === value
  ));
  return Object.freeze({
    valid,
    summary: Object.freeze(summary),
  });
}

function main() {
  const result = spawnSync(process.execPath, [
    '--test',
    '--test-concurrency=1',
    ...testFiles,
  ], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HEPTA_FORMAL_OPERATIONAL_MODE: 'strict',
      HEPTA_DYNAMIC_FORMAL_KERNEL_OPERATIONAL_MODE: 'strict',
    },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
    windowsHide: true,
  });

  if (result.error) throw result.error;
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  const parsed = parseFormalOperationalTapSummary(result.stdout);
  if (result.status !== 0 || !parsed.valid) {
    process.stderr.write('formal_operational_tap_summary_invalid\n');
    process.exitCode = result.status || 1;
  } else {
    process.stdout.write(`formal_operational_summary=${JSON.stringify({
      version: 1,
      kind: 'FormalOperationalTestSummary',
      testFiles,
      ...parsed.summary,
    })}\n`);
    process.exitCode = 0;
  }
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

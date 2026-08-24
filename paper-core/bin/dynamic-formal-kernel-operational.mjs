#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  resolvePinnedLakeExecutable,
} from '../../paper-adapters/research-verify/pinned-lake-executable-resolver.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const testFiles = Object.freeze([
  'paper-core/tests/dynamic-formal-claim-kernel-e2e.test.mjs',
  'paper-core/tests/formal-campaign-release.test.mjs',
  'paper-core/tests/formal-proof-search-operations.test.mjs',
  'paper-core/tests/typed-theorem-dependency-graph.test.mjs',
]);
const expected = Object.freeze({
  tests: 23,
  suites: 0,
  pass: 23,
  fail: 0,
  cancelled: 0,
  skipped: 0,
  todo: 0,
});

const FORMAL_OPERATIONAL_RECEIPT_KEYS = Object.freeze([
  'cancelled', 'codeProvenance', 'fail', 'formalOperationalReceiptHash',
  'kind', 'pass', 'suites', 'testFiles', 'tests', 'todo', 'version', 'skipped',
]);

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify([...keys].sort());
}

/**
 * Bind the terminal TAP summary to the exact source identity observed around
 * the run.  A passing TAP stream without this binding is not release evidence:
 * it could have been produced by a different checkout or a changed index.
 */
export function buildFormalOperationalReceipt({ summary, codeProvenance } = {}) {
  if (!summary?.valid || !codeProvenance || typeof codeProvenance !== 'object') {
    throw new Error('formal_operational_receipt_inputs_invalid');
  }
  const payload = {
    version: 2,
    kind: 'FormalOperationalTestReceipt',
    testFiles,
    ...summary.summary,
    codeProvenance,
  };
  return Object.freeze({
    ...payload,
    formalOperationalReceiptHash: hashRecord('FormalOperationalTestReceipt', payload),
  });
}

export function verifyFormalOperationalReceipt(receipt, { expectedCodeProvenance = null } = {}) {
  if (!exactKeys(receipt, FORMAL_OPERATIONAL_RECEIPT_KEYS)
    || receipt.version !== 2
    || receipt.kind !== 'FormalOperationalTestReceipt'
    || JSON.stringify(receipt.testFiles) !== JSON.stringify(testFiles)
    || Object.entries(expected).some(([key, value]) => receipt[key] !== value)
    || !receipt.codeProvenance
    || typeof receipt.codeProvenance !== 'object') return false;
  const { formalOperationalReceiptHash: _hash, ...payload } = receipt;
  if (hashRecord('FormalOperationalTestReceipt', payload)
      !== receipt.formalOperationalReceiptHash) return false;
  if (expectedCodeProvenance !== null
    && hashRecord('ExactCodeProvenance', receipt.codeProvenance)
      !== hashRecord('ExactCodeProvenance', expectedCodeProvenance)) return false;
  return true;
}

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
  if (terminal.length !== names.length + 2 || terminal[0] !== '1..23') {
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
  const pinned = resolvePinnedLakeExecutable({
    environment: process.env,
    forceContentRehash: false,
  });
  if (pinned.status !== 'formal_pinned_lake_resolved') {
    process.stderr.write(`formal_operational_prerequisite_failed:${pinned.blockers.join(',')}\n`);
    process.exitCode = 1;
    return;
  }
  let preflightCodeProvenance;
  try {
    preflightCodeProvenance = currentCodeProvenance({
      workspaceRoot,
      allowReleaseCommitEnvironment: false,
    });
  } catch (error) {
    process.stderr.write(`formal_operational_provenance_preflight_failed:${String(
      error?.code || error?.message || 'unknown',
    ).replace(/[^A-Za-z0-9_.:-]/gu, '_')}\n`);
    process.exitCode = 1;
    return;
  }
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
    let postflightCodeProvenance;
    try {
      postflightCodeProvenance = currentCodeProvenance({
        workspaceRoot,
        allowReleaseCommitEnvironment: false,
      });
    } catch (error) {
      process.stderr.write(`formal_operational_provenance_postflight_failed:${String(
        error?.code || error?.message || 'unknown',
      ).replace(/[^A-Za-z0-9_.:-]/gu, '_')}\n`);
      process.exitCode = 1;
      return;
    }
    if (hashRecord('ExactCodeProvenance', preflightCodeProvenance)
      !== hashRecord('ExactCodeProvenance', postflightCodeProvenance)) {
      process.stderr.write('formal_operational_code_provenance_changed\n');
      process.exitCode = 1;
      return;
    }
    const receipt = buildFormalOperationalReceipt({
      summary: parsed,
      codeProvenance: postflightCodeProvenance,
    });
    process.stdout.write(`formal_operational_summary=${JSON.stringify(receipt)}\n`);
    process.exitCode = 0;
  }
}

// `npm run` invokes this file with a relative argv[1], while import.meta.url
// resolves to an absolute path.  Compare canonical absolute paths (including
// symlink resolution where available) so the operational gate cannot silently
// no-op and return success without running the 23-test zero-skip suite.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
const invokedAsScript = invokedPath && (() => {
  try {
    return path.resolve(invokedPath) === path.resolve(modulePath)
      || fs.realpathSync(invokedPath) === fs.realpathSync(modulePath);
  } catch {
    return invokedPath === path.resolve(modulePath);
  }
})();
if (invokedAsScript) {
  main();
}

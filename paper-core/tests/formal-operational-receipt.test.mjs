import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildFormalOperationalReceipt,
} from '../bin/dynamic-formal-kernel-operational.mjs';
import {
  captureFormalOperationalReceipt,
  parseFormalOperationalReceiptOutput,
  writeFormalReceipt,
} from '../bin/formal-operational-receipt.mjs';

const cleanProvenance = Object.freeze({
  version: 2,
  kind: 'CodeProvenance',
  packageVersion: '0.21.0',
  commit: 'a'.repeat(40),
  commitTree: 'b'.repeat(40),
  tags: [],
  treeDirty: false,
  indexStateHash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  repositoryEntryCount: 1,
  repositoryContentHash: `sha256:${'c'.repeat(64)}`,
  worktreeStateHash: `sha256:${'d'.repeat(64)}`,
  evidenceEnvironment: 'test',
  evidenceClass: 'test',
});

const summary = Object.freeze({
  valid: true,
  summary: Object.freeze({
    tests: 23,
    suites: 0,
    pass: 23,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  }),
});

function fakeRunnerOutput() {
  const receipt = buildFormalOperationalReceipt({
    summary,
    codeProvenance: cleanProvenance,
  });
  return `1..23\nformal_operational_summary=${JSON.stringify(receipt)}\n`;
}

test('formal receipt parser requires the machine-readable terminal summary', () => {
  assert.throws(
    () => parseFormalOperationalReceiptOutput('1..23\n'),
    /summary_missing/u,
  );
  const parsed = parseFormalOperationalReceiptOutput(fakeRunnerOutput());
  assert.equal(parsed.kind, 'FormalOperationalTestReceipt');
  assert.equal(parsed.skipped, 0);
});

test('capture binds a zero-skip receipt to an exact clean provenance snapshot', () => {
  const provenanceCalls = [];
  const receipt = captureFormalOperationalReceipt({
    root: '/tmp/formal-receipt-test-root',
    environment: { ELAN_HOME: '/root/elan' },
    lakeResolver: () => ({ status: 'formal_pinned_lake_resolved', blockers: [] }),
    provenance: () => {
      provenanceCalls.push(true);
      return cleanProvenance;
    },
    run: () => ({ status: 0, error: null, stdout: fakeRunnerOutput(), stderr: '' }),
  });
  assert.equal(receipt.tests, 23);
  assert.equal(receipt.codeProvenance.treeDirty, false);
  assert.equal(provenanceCalls.length, 2);
});

test('capture rejects dirty or staged provenance before running formal tests', () => {
  let invoked = false;
  assert.throws(() => captureFormalOperationalReceipt({
    root: '/tmp/formal-receipt-test-root',
    provenance: () => ({ ...cleanProvenance, treeDirty: true }),
    lakeResolver: () => ({ status: 'formal_pinned_lake_resolved', blockers: [] }),
    run: () => { invoked = true; return { status: 0, stdout: fakeRunnerOutput() }; },
  }), /clean_commit_required/u);
  assert.equal(invoked, false);
});

test('receipt publication is atomic, owner-readable, and rejects traversal', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receipt = buildFormalOperationalReceipt({ summary, codeProvenance: cleanProvenance });
  const publication = writeFormalReceipt({ receipt, runtimeRoot: root });
  assert.equal(fs.existsSync(publication.path), true);
  assert.equal(JSON.parse(fs.readFileSync(publication.path, 'utf8')).formalOperationalReceiptHash,
    receipt.formalOperationalReceiptHash);
  assert.equal(fs.lstatSync(publication.path).nlink, 1);
  assert.throws(() => writeFormalReceipt({
    receipt,
    runtimeRoot: root,
    receiptPath: path.join(root, '..', 'escape.json'),
  }), /outside_runtime/u);
});

test('receipt publication rejects symlinked runtime and receipt-parent paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-receipt-links-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-receipt-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const receipt = buildFormalOperationalReceipt({ summary, codeProvenance: cleanProvenance });
  const runtimeLink = path.join(root, 'runtime-link');
  fs.symlinkSync(outside, runtimeLink, 'dir');
  assert.throws(
    () => writeFormalReceipt({ receipt, runtimeRoot: runtimeLink }),
    /runtime_directory_unsafe/u,
  );

  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(runtime, 'formal-operational'), 'dir');
  assert.throws(
    () => writeFormalReceipt({ receipt, runtimeRoot: runtime }),
    /runtime_directory_unsafe/u,
  );
});

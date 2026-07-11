import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { selectCurrentReleaseVerificationReceipt } from '../bin/release-evidence-lib.mjs';

test('release evidence selects the latest passed receipt for the exact current commit', (t) => {
  const verificationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-receipt-'));
  t.after(() => fs.rmSync(verificationRoot, { recursive: true, force: true }));
  const codeProvenance = { packageVersion: '0.15.0', commit: 'current-commit' };
  const write = (name, overrides = {}) => fs.writeFileSync(path.join(verificationRoot, name), JSON.stringify({
    version: 1,
    kind: 'IsolatedVerificationReceipt',
    status: 'isolated_verification_passed',
    mode: 'release',
    completedAt: '2026-07-11T00:00:00.000Z',
    codeProvenance: { ...codeProvenance, treeDirty: false },
    marker: name,
    ...overrides,
  }));
  write('zz-lexically-last-old-commit.json', { codeProvenance: { packageVersion: '0.15.0', commit: 'old-commit', treeDirty: false }, completedAt: '2026-07-11T23:59:00.000Z' });
  write('current-earlier.json', { completedAt: '2026-07-11T01:00:00.000Z' });
  write('current-latest.json', { completedAt: '2026-07-11T02:00:00.000Z' });
  write('current-blocked.json', { status: 'isolated_verification_blocked', completedAt: '2026-07-11T03:00:00.000Z' });
  fs.writeFileSync(path.join(verificationRoot, 'malformed.json'), '{');
  const selected = selectCurrentReleaseVerificationReceipt({ verificationRoot, codeProvenance });
  assert.equal(selected.marker, 'current-latest.json');
  assert.equal(selected.codeProvenance.commit, 'current-commit');
});

test('release evidence selection fails closed without an exact current receipt', (t) => {
  const verificationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-receipt-empty-'));
  t.after(() => fs.rmSync(verificationRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(verificationRoot, 'old.json'), JSON.stringify({
    kind: 'IsolatedVerificationReceipt',
    status: 'isolated_verification_passed',
    mode: 'release',
    codeProvenance: { packageVersion: '0.14.0', commit: 'old-commit', treeDirty: false },
  }));
  assert.equal(selectCurrentReleaseVerificationReceipt({
    verificationRoot,
    codeProvenance: { packageVersion: '0.15.0', commit: 'current-commit' },
  }), null);
});

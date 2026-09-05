import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runLegacyDeletionDrillCommand } from '../bin/legacy-deletion-drill.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const operational = 'migration/tests/legacy-deletion-drill.operational.mjs';

test('default drill mode delegates only to verification, never attestation', async () => {
  let verified = 0;
  const receipt = Object.freeze({ kind: 'TestOnlyDrillResult', productionAuthorized: false });
  const result = await runLegacyDeletionDrillCommand({
    argv: [], environment: {},
    verifyDrill() { verified += 1; return receipt; },
    attestDrill() { assert.fail('pure verification must not use a signer'); },
  });
  assert.equal(verified, 1);
  assert.equal(result, receipt);
});

test('full private-archive positive remains a mandatory, non-skippable release gate', (t) => {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['test:legacy-deletion-drill-operational'],
    `node --test --test-concurrency=1 ${operational}`);
  assert.ok(scripts['release:inner'].includes(
    'npm run legacy:deletion-drill && npm run test:legacy-deletion-drill-operational &&',
  ));
  const source = fs.readFileSync(path.join(root, operational), 'utf8');
  assert.doesNotMatch(source, /\b(?:skip|todo)\s*[:(]/u);
  for (const assertion of [
    "assert.equal(result.status, 0, result.stderr)",
    "assert.equal(report.status, 'legacy_reference_restore_drill_verification_passed')",
    'assert.equal(report.signingKeyRead, false)',
    'assert.equal(report.runtimeEvidenceWritten, false)',
  ]) assert.ok(source.includes(assertion), assertion);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-operational-denial-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const environment = { ...process.env, HEPTA_LEGACY_REFERENCE_ARCHIVE: path.join(temporary, 'absent.tar.gz') };
  // A nested test runner must not inherit the parent's child-v8 IPC mode.
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', operational], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: environment,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /# fail 1\n/u);
  assert.match(result.stdout, /# skipped 0\n/u);
  assert.match(result.stdout, /ENOENT/u);
});

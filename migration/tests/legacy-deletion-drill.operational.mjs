// Host-only positive verification. Never inject the private archive into public PR jobs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveImmutableLegacyMatrixArchive } from '../legacy-matrix-reference.mjs';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

test('pure deletion drill passes in a fresh isolated runtime without reading or writing a key', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-pure-deletion-drill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  const result = spawnSync(process.execPath, ['paper-core/bin/legacy-deletion-drill.mjs'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: 240_000,
    env: {
      ...process.env,
      HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot,
      HEPTA_PAPER_RUNTIME_ISOLATED: '1',
      HEPTA_LEGACY_REFERENCE_ARCHIVE: resolveImmutableLegacyMatrixArchive(),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'legacy_reference_restore_drill_verification_passed');
  assert.equal(report.signingKeyRead, false);
  assert.equal(report.runtimeEvidenceWritten, false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'release-signing')), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'legacy-retirement', 'deletion-drills')), false);
});

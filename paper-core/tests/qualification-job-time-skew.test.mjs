import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('bounded skipped-job timestamp compatibility executes independently', () => {
  const result = spawnSync('python3', ['docs/rust/tools/test_qualification_job_time_skew.py'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 3 tests/u);
  assert.match(result.stderr, /OK/u);
});

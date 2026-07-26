import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const executable = 'paper-core/bin/prepare-ci-mathlib-cache.mjs';

test('CI Mathlib cache help discloses source authority and qualification boundary', () => {
  const result = spawnSync(process.execPath, [executable, '--help'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    kind: 'CiMathlibCacheUsage',
    usage: 'prepare-ci-mathlib-cache [--root PATH] [--prepare]',
    sourceAuthority: 'official_pinned_mathlib_commit_and_tree',
    productionAuthorityGranted: false,
  });
});

test('CI Mathlib cache status fails closed when no verified cache exists', (t) => {
  const cache = path.join(root, '.ci-cache', `missing-mathlib-${process.pid}`);
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [executable, '--root', cache], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'ci_mathlib_cache_blocked');
  assert.equal(receipt.productionAuthorityGranted, false);
  assert.ok(receipt.blockers.length > 0);
});

test('CI Mathlib cache refuses deletion targets outside the workspace cache root', () => {
  const result = spawnSync(process.execPath, [
    executable,
    '--root',
    path.join(root, 'paper-core'),
    '--prepare',
  ], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ci_mathlib_cache_root_outside_workspace_cache/);
});

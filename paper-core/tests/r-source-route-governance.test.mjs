import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));

const controlledEnvironment = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  PYTHONDONTWRITEBYTECODE: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
});

function runAt(repositoryRoot, file, args = [], timeout = 90_000) {
  const tools = path.join(repositoryRoot, 'docs/rust/tools');
  return spawnSync('python3', [path.join(tools, file), ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: controlledEnvironment,
  });
}

function run(file, args = [], timeout = 90_000) {
  return runAt(root, file, args, timeout);
}

function git(args, { check = true } = {}) {
  const result = spawnSync(
    '/usr/bin/git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: controlledEnvironment,
    },
  );
  if (check) {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function withDetachedHeadWorktree(callback) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hepta-r-source-route-governance-'),
  );
  const checkout = path.join(temporaryRoot, 'checkout');
  try {
    git(['worktree', 'add', '--detach', checkout, 'HEAD']);
    return callback(checkout);
  } finally {
    git(['worktree', 'remove', '--force', checkout], { check: false });
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test('public historical R source route hostile controls execute', () => {
  const result = run('test_r_source_route.py');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 7 tests/u);
  assert.match(result.stderr, /OK/u);
});

test('route verifier emits content evidence with every authority boundary false', () => {
  const result = withDetachedHeadWorktree((checkout) =>
    runAt(checkout, 'verify-r-source-route.py'),
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const value = JSON.parse(result.stdout);
  assert.equal(value.status, 'public_historical_source_content_verified_nonactivating');
  assert.equal(value.historical.fileCount, 107);
  assert.equal(value.historical.packageCount, 104);
  assert.equal(value.originalGitlink.commitObjectFetchedAndVerified, false);
  assert.equal(value.originalGitlink.equivalenceClaimed, false);
  assert.equal(value.currentBuildClosureVerified, false);
  assert.equal(value.independentAcceptance, false);
  assert.equal(value.targetHostQualified, false);
  assert.equal(value.productionAuthorized, false);
  assert.equal(value.externalAuthorityClaimed, false);
});

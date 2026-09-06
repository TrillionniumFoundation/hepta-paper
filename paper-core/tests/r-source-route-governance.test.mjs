import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tools = path.join(root, 'docs/rust/tools');

function run(file, args = [], timeout = 90_000) {
  return spawnSync('python3', [path.join(tools, file), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/nonexistent',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PYTHONDONTWRITEBYTECODE: '1',
    },
  });
}

test('public historical R source route hostile controls execute', () => {
  const result = run('test_r_source_route.py');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 7 tests/u);
  assert.match(result.stderr, /OK/u);
});

test('route verifier emits content evidence with every authority boundary false', () => {
  const result = run('verify-r-source-route.py');
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

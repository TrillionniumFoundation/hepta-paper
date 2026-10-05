import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { lockedParentOracleRuntimePaths, assertLockedParentOracleNodeCopy,
  createLockedParentOracleJobBudget, parseLockedParentNodeOracleArguments, withLockedParentNodeOracle } from '../bin/with-locked-parent-node-oracle.mjs';
const approved = '/opt/hostedtoolcache/node/22.23.1/x64/lib/node_modules/npm/bin/npm-cli.js';
const input = { execPath: '/usr/bin/node', nodeVersion: '22.23.1', architecture: 'x64', npmExecPath: approved };
test('explicit CI runtime selects only the exact official pair, never PATH', () => {
  assert.deepEqual(lockedParentOracleRuntimePaths(input), { node: '/opt/hostedtoolcache/node/22.23.1/x64/bin/node', npm: approved, copiedSystemNode: true });
  for (const changed of [{ npmExecPath: '/tmp/npm-cli.js' }, { npmExecPath: 'npm' }, { npmExecPath: '' }, { execPath: '/tmp/node' }, { nodeVersion: '22.23.2' }, { architecture: 'unknown' }]) {
    assert.throws(() => lockedParentOracleRuntimePaths({ ...input, ...changed }), /not_approved/);
  }
});
test('same-installation original path stays explicit when no override was supplied', () => {
  const selected = lockedParentOracleRuntimePaths({ execPath: '/opt/node/bin/node', nodeVersion: '22.23.1', architecture: 'x64' });
  assert.equal(selected.npm, '/opt/node/lib/node_modules/npm/bin/npm-cli.js');
  assert.equal(selected.copiedSystemNode, false);
});
test('copied system Node requires exact bytes, root owner and nonwritable permissions', () => {
  const system = { path: '/usr/bin/node', identity: ['1', '2', String(0o100555), '0', '0'], sha256: 'exact-source-bytes' };
  const installation = { sha256: system.sha256 };
  assert.doesNotThrow(() => assertLockedParentOracleNodeCopy(system, installation));
  for (const changed of [{ path: '/tmp/node' }, { sha256: 'different' }, { identity: ['1', '2', String(0o100575), '0', '0'] }, { identity: ['1', '2', String(0o100555), '1000', '0'] }, { identity: ['1', '2', String(0o100555), '0', '1000'] }]) {
    assert.throws(() => assertLockedParentOracleNodeCopy({ ...system, ...changed }, installation), /system_node_copy_not_bound/);
  }
});


test('qualification job budget defaults to thirty minutes and admits only the explicit ninety minute alternative', () => {
  assert.deepEqual(parseLockedParentNodeOracleArguments(['--receipt', '/receipt', '--', 'node', 'verify.mjs']),
    { receipt: '/receipt', command: ['node', 'verify.mjs'], jobTimeoutMinutes: 30 });
  for (const minutes of ['30', '90']) {
    assert.deepEqual(parseLockedParentNodeOracleArguments(['--receipt', '/receipt', '--job-timeout-minutes', minutes, '--', 'node', 'verify.mjs']),
      { receipt: '/receipt', command: ['node', 'verify.mjs'], jobTimeoutMinutes: Number(minutes) });
  }
  for (const value of ['', '0', '1', '89', '91', '-90', '90.0', '090', '90e0', 'Infinity', ' 90', '90 ']) {
    assert.throws(() => parseLockedParentNodeOracleArguments(['--receipt', '/receipt', '--job-timeout-minutes', value, '--', 'node']),
      /job_timeout_minutes_invalid/u);
  }
  for (const args of [[], ['--receipt', '/receipt', '--'],
    ['--receipt', '/receipt', '--job-timeout-minutes', '90', '--'],
    ['--receipt', '/receipt', '--job-timeout-minutes', '90', '--job-timeout-minutes', '90', '--', 'node'],
    ['--receipt', '/receipt', '--unknown', '90', '--', 'node']]) {
    assert.throws(() => parseLockedParentNodeOracleArguments(args), /arguments/u);
  }
});

test('one actual job deadline remains shared across installation and verification without renewal', () => {
  // Exercise the actual helper with a controlled monotonic clock, without
  // waiting ninety minutes or altering the production clock or child limits.
  for (const minutes of [undefined, 30, 90]) {
    let now = 1234;
    const create = vm.runInNewContext(`(${createLockedParentOracleJobBudget.toString()})`, {
      performance: { now: () => now }, fail: code => { throw new Error(`parent_node_oracle_${code}`); },
    });
    const remaining = create(minutes), budget = (minutes ?? 30) * 60 * 1000;
    assert.equal(remaining(), budget);
    now += 7; assert.equal(remaining(), budget - 7, 'npm qualification consumes the same budget');
    now += 60000; assert.equal(remaining(), budget - 60007, 'installation does not reset verification time');
    now = 1234 + budget - 1; assert.equal(remaining(), 1);
    now += 1; assert.throws(remaining, /job_timeout$/u);
    now += 60000; assert.throws(remaining, /job_timeout$/u);
  }
  const source = withLockedParentNodeOracle.toString();
  assert.equal(source.split('createLockedParentOracleJobBudget(jobTimeoutMinutes)').length - 1, 1);
  assert.equal(source.split('timeout: remaining()').length - 1, 3);
  assert.ok(!source.includes('process.env.HEPTA_JOB_TIMEOUT'));
});

test('invalid programmatic job budgets fail before any source or installation access', () => {
  for (const minutes of [null, '90', 0, -1, 1, 89, 91, 90.5, Infinity, NaN, {}, []]) {
    assert.throws(() => createLockedParentOracleJobBudget(minutes), /job_timeout_minutes_invalid/u);
    assert.throws(() => withLockedParentNodeOracle({ root: '/nonexistent', receipt: '/nonexistent/receipt',
      command: [process.execPath, '--version'], jobTimeoutMinutes: minutes }), /job_timeout_minutes_invalid/u);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { lockedParentOracleRuntimePaths, assertLockedParentOracleNodeCopy } from '../bin/with-locked-parent-node-oracle.mjs';
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

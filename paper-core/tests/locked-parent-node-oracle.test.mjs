import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { withLockedParentNodeOracle } from '../bin/with-locked-parent-node-oracle.mjs';

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-locked-parent-oracle-'));
  const root = path.join(parent, 'candidate'); fs.mkdirSync(root);
  const original = fileURLToPath(new URL('../../', import.meta.url));
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(original, name), path.join(root, name));
  return { parent, root, receipt: path.join(parent, 'actual-oracle-receipt.json') };
}

test('locked_parent_oracle_refuses_existing_candidate_or_parent_inputs_without_removing_them', () => {
  for (const scope of ['candidate', 'parent', 'project-config']) {
    const input = fixture();
    try {
      const selected = path.join(scope === 'candidate' ? input.root : input.parent, 'node_modules');
      if (scope !== 'project-config') fs.mkdirSync(selected);
      const marker = scope === 'project-config' ? path.join(input.parent, '.npmrc') : path.join(selected, 'owned-marker');
      fs.writeFileSync(marker, 'original bytes', { flag: 'wx' });
      assert.throws(() => withLockedParentNodeOracle({ ...input, command: [process.execPath, '--version'] }),
        /exclusive_parent_required|parent_input_collision/u);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'original bytes');
      assert.equal(fs.existsSync(input.receipt), false);
    } finally { fs.rmSync(input.parent, { recursive: true, force: true }); }
  }
});

for (const jobTimeoutMinutes of [undefined, 90]) test(
  'locked_parent_oracle_installs_actual_exact_lock_outside_candidate_and_observes_whole_dependencies'
    + (jobTimeoutMinutes === undefined ? '' : '_explicit_ninety_minute_job_budget'), () => {
  const input = fixture(), previous = process.env.npm_config_offline;
  // The normal source CI installer uses the exact locked registry/integrity
  // graph. An explicitly requested offline run remains fail-closed on misses.
  process.env.npm_config_offline = String(process.env.HEPTA_LOCKED_NODE_ORACLE_OFFLINE_TEST === '1');
  try {
    fs.writeFileSync(path.join(input.root, 'oracle.mjs'),
      "import assert from 'node:assert/strict'; import * as espree from 'espree'; assert.equal(espree.parse('const x=1;', {ecmaVersion:2022}).type,'Program');\n",
      { flag: 'wx' });
    const status = withLockedParentNodeOracle({ ...input, jobTimeoutMinutes,
      ...(process.execPath === '/usr/bin/node' && process.env.GITHUB_ACTIONS === 'true' ? { npmExecPath: process.env.npm_execpath } : {}),
      command: [process.execPath, path.join(input.root, 'oracle.mjs')] });
    assert.equal(status, 0);
    assert.equal(fs.existsSync(path.join(input.root, 'node_modules')), false);
    const receipt = JSON.parse(fs.readFileSync(input.receipt));
    assert.equal(receipt.actualExitCode, 0);
    assert.equal(receipt.candidateDependenciesInstalled, false);
    assert.equal(receipt.lifecycleScriptsExecuted, false);
    assert.equal(receipt.sourceQualificationClaimed, false);
    assert.ok(receipt.dependencyBefore.rows.length > 64);
    assert.deepEqual(receipt.dependencyBefore, receipt.dependencyAfter);
    assert.deepEqual(receipt.npmBefore, receipt.npmAfter);
    assert.ok(receipt.dependencyBefore.rows.some(row => row.path === 'espree/package.json'));
    const retained = process.env.HEPTA_LOCKED_NODE_ORACLE_OBSERVATION_PATH;
    if (retained && jobTimeoutMinutes === undefined) {
      assert.equal(path.resolve(retained), retained);
      const fd = fs.openSync(retained, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, fs.readFileSync(input.receipt)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
  } finally {
    if (previous === undefined) delete process.env.npm_config_offline; else process.env.npm_config_offline = previous;
    fs.rmSync(input.parent, { recursive: true, force: true });
  }
});

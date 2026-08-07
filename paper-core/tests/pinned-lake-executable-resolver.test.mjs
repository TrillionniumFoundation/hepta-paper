import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolvePinnedLakeExecutable,
} from '../../paper-adapters/research-verify/pinned-lake-executable-resolver.mjs';

test('pinned Lake resolution never executes an environment-provided elan launcher', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-malicious-elan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const elanHome = path.join(root, 'elan');
  const sentinel = path.join(root, 'launcher-executed');
  fs.mkdirSync(path.join(elanHome, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(elanHome, 'bin', 'elan'), [
    '#!/bin/sh',
    `: > ${JSON.stringify(sentinel)}`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });

  const result = resolvePinnedLakeExecutable({
    environment: { ELAN_HOME: elanHome },
  });
  assert.equal(result.status, 'formal_pinned_lake_resolution_blocked');
  assert.equal(result.executable, null);
  assert.equal(result.lakeExecutable, null);
  assert.equal(result.leanExecutable, null);
  assert.equal(result.toolchainRoot, null);
  assert.equal(fs.existsSync(sentinel), false);
  assert.ok(result.blockers.some((blocker) => (
    blocker.startsWith('formal_pinned_runtime_root_ownership_required:')
      || blocker.startsWith('formal_pinned_runtime_path_unreadable:')
  )));
});

test('pinned Lake resolution rejects caller-selected toolchains before path use', () => {
  const result = resolvePinnedLakeExecutable({
    toolchain: 'attacker/toolchain:v1',
    environment: { ELAN_HOME: '/opt/hepta-paper/elan' },
  });
  assert.equal(result.status, 'formal_pinned_lake_resolution_blocked');
  assert.ok(result.blockers.includes('formal_pinned_toolchain_not_code_authorized'));
  assert.equal(result.executable, null);
});

test('pinned Lake resolution blocks prototype property names without throwing', () => {
  for (const toolchain of ['__proto__', 'constructor', 'toString']) {
    const result = resolvePinnedLakeExecutable({
      toolchain,
      environment: { ELAN_HOME: '/opt/hepta-paper/elan' },
    });
    assert.equal(result.status, 'formal_pinned_lake_resolution_blocked');
    assert.ok(result.blockers.includes('formal_pinned_toolchain_not_code_authorized'));
    assert.equal(result.executable, null);
    assert.equal(result.toolchainRoot, null);
  }
});

test('pinned Lake resolution requires an explicit absolute ELAN_HOME', () => {
  const missing = resolvePinnedLakeExecutable({ environment: { HOME: '/tmp/untrusted' } });
  assert.equal(missing.status, 'formal_pinned_lake_resolution_blocked');
  assert.ok(missing.blockers.includes('formal_pinned_elan_home_absolute_required'));

  const relative = resolvePinnedLakeExecutable({ environment: { ELAN_HOME: 'relative/elan' } });
  assert.equal(relative.status, 'formal_pinned_lake_resolution_blocked');
  assert.ok(relative.blockers.includes('formal_pinned_elan_home_absolute_required'));
});

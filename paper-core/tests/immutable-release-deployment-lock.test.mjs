import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  acquireExclusiveImmutableReleaseDeploymentLock,
  adoptInheritedExclusiveImmutableReleaseDeploymentLock,
  inspectImmutableReleaseDeploymentLock,
} from '../../paper-adapters/runtime/immutable-release-deployment-lock-repository.mjs';

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-lock-'));
  fs.chmodSync(parent, 0o711);
  const lockPath = path.join(parent, 'deployment.lock');
  fs.writeFileSync(lockPath, '', { mode: 0o600 });
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return lockPath;
}

test('deployment transaction holds the inspected lock inode exclusively until release', (t) => {
  const lockPath = fixture(t);
  const options = {
    lockPath,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
  };
  const inspection = inspectImmutableReleaseDeploymentLock(options);
  const lock = acquireExclusiveImmutableReleaseDeploymentLock({
    ...options,
    expectedIdentityHash: inspection.identityHash,
  });
  assert.equal(lock.assertHeld(), true);
  const blocked = spawnSync('/usr/bin/flock', [
    '--exclusive', '--nonblock', lockPath, '/usr/bin/true',
  ]);
  assert.equal(blocked.status, 1);
  assert.equal(lock.release(), true);
  assert.equal(lock.release(), false);
  const available = spawnSync('/usr/bin/flock', [
    '--exclusive', '--nonblock', lockPath, '/usr/bin/true',
  ]);
  assert.equal(available.status, 0);
});

test('sealed launcher exclusive descriptor is adopted without reopening the lock', (t) => {
  const lockPath = fixture(t);
  const options = {
    lockPath,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
  };
  const inspection = inspectImmutableReleaseDeploymentLock(options);
  const descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY);
  const acquired = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
    stdio: ['ignore', 'pipe', 'pipe', descriptor],
  });
  assert.equal(acquired.status, 0);
  const lock = adoptInheritedExclusiveImmutableReleaseDeploymentLock({
    ...options,
    expectedIdentityHash: inspection.identityHash,
    descriptor,
  });
  assert.equal(lock.assertHeld(), true);
  assert.equal(lock.release(), true);
});

test('volatile lock inode may be rebound after reboot but remains pinned while held', (t) => {
  const lockPath = fixture(t);
  const options = {
    lockPath,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
  };
  const inspection = inspectImmutableReleaseDeploymentLock(options);
  fs.renameSync(lockPath, `${lockPath}.old`);
  fs.writeFileSync(lockPath, '', { mode: 0o600 });
  const rebound = inspectImmutableReleaseDeploymentLock(options);
  assert.equal(rebound.identityHash, inspection.identityHash);
  const lock = acquireExclusiveImmutableReleaseDeploymentLock({
    ...options,
    expectedIdentityHash: inspection.identityHash,
  });
  assert.equal(lock.assertHeld(), true);
  fs.renameSync(lockPath, `${lockPath}.rebooted`);
  fs.writeFileSync(lockPath, '', { mode: 0o600 });
  assert.throws(() => lock.assertHeld(),
    /immutable_release_deployment_lock_identity_changed/u);
  lock.release();
});

test('unsafe recreated lock metadata fails closed even with the stable policy hash', (t) => {
  const lockPath = fixture(t);
  const options = {
    lockPath,
    expectedUid: process.getuid(),
    expectedGid: process.getgid(),
  };
  fs.chmodSync(lockPath, 0o666);
  assert.throws(() => inspectImmutableReleaseDeploymentLock(options),
    /immutable_release_deployment_lock_invalid/u);
  fs.chmodSync(lockPath, 0o600);
  assert.throws(() => inspectImmutableReleaseDeploymentLock({
    ...options,
    expectedUid: process.getuid() + 1,
  }), /immutable_release_deployment_lock_root_invalid/u);

  const otherPath = path.join(path.dirname(lockPath), 'other.lock');
  fs.writeFileSync(otherPath, '', { mode: 0o600 });
  const policy = inspectImmutableReleaseDeploymentLock(options);
  assert.throws(() => acquireExclusiveImmutableReleaseDeploymentLock({
    ...options,
    lockPath: otherPath,
    expectedIdentityHash: policy.identityHash,
  }), /immutable_release_deployment_lock_identity_mismatch/u);
});

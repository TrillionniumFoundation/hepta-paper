import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  acquireAgentProductionCacheRequestLock,
  assertAgentProductionCacheRequestLock,
  prepareAgentProductionCacheRoot,
  publishAgentProductionCacheEntryNoClobber,
  readAgentProductionCache,
  refreshAgentProductionCacheRequestLock,
  releaseAgentProductionCacheRequestLock,
  withAgentProductionCacheRequestLock,
} from '../../paper-adapters/automation/agent-production-cache-safety.mjs';

const REQUEST_HASH = `sha256:${'a'.repeat(64)}`;
const CACHE_MODULE_URL = pathToFileURL(path.resolve(
  'paper-adapters/automation/agent-production-cache-safety.mjs',
)).href;

function fixture(t, name) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-agent-cache-${name}-`));
  const cacheRoot = path.join(parent, 'cache');
  const prepared = prepareAgentProductionCacheRoot(cacheRoot);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, cacheRoot, prepared };
}

function futureClock(offsetMs = 60_000) {
  return Object.freeze({ now: () => new Date(Date.now() + offsetMs) });
}

test('request lock rejects active same-process and cross-process contenders', (t) => {
  const { cacheRoot, prepared } = fixture(t, 'contention');
  const lock = acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
    staleAfterMs: 1,
  });
  assert.equal(assertAgentProductionCacheRequestLock(lock), lock);
  assert.throws(() => acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
    staleAfterMs: 1,
    clock: futureClock(),
  }), /agent_production_cache_request_lock_contended/);

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const cache = await import(${JSON.stringify(CACHE_MODULE_URL)});
    const prepared = cache.prepareAgentProductionCacheRoot(${JSON.stringify(cacheRoot)});
    try {
      cache.acquireAgentProductionCacheRequestLock({
        cacheRoot: prepared.root,
        cacheRootIdentity: prepared.identity,
        requestHash: ${JSON.stringify(REQUEST_HASH)},
        staleAfterMs: 1,
        clock: { now: () => new Date(Date.now() + 60000) },
      });
      process.exitCode = 2;
    } catch (error) {
      process.stdout.write(String(error.message));
      process.exitCode = error.message === 'agent_production_cache_request_lock_contended'
        ? 0 : 3;
    }
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'agent_production_cache_request_lock_contended');
  assert.deepEqual(releaseAgentProductionCacheRequestLock(lock), {
    released: true,
    alreadyReleased: false,
  });
  assert.deepEqual(releaseAgentProductionCacheRequestLock(lock), {
    released: false,
    alreadyReleased: true,
  });
});

test('request lock rejects an abandoned TTL shorter than three heartbeats', (t) => {
  const { cacheRoot, prepared } = fixture(t, 'timing-policy');
  assert.throws(() => acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
    staleAfterMs: 1,
    abandonedAfterMs: 60_001,
    heartbeatIntervalMs: 30_000,
  }), /agent_production_cache_request_lock_policy_invalid/);
});

test('stale recovery requires an expired lock whose exact local owner is dead', (t) => {
  const { cacheRoot, prepared } = fixture(t, 'stale');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const cache = await import(${JSON.stringify(CACHE_MODULE_URL)});
    const prepared = cache.prepareAgentProductionCacheRoot(${JSON.stringify(cacheRoot)});
    cache.acquireAgentProductionCacheRequestLock({
      cacheRoot: prepared.root,
      cacheRootIdentity: prepared.identity,
      requestHash: ${JSON.stringify(REQUEST_HASH)},
      staleAfterMs: 1,
    });
    process.stdout.write('acquired');
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'acquired');
  const recovered = acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
    staleAfterMs: 1,
    clock: futureClock(),
  });
  assert.equal(assertAgentProductionCacheRequestLock(recovered), recovered);
  const lockRoot = path.join(cacheRoot, '.agent-production-cache-locks');
  assert.deepEqual(fs.readdirSync(lockRoot), [path.basename(recovered.lockPath)]);
  releaseAgentProductionCacheRequestLock(recovered);
  assert.deepEqual(fs.readdirSync(lockRoot), []);
});

test('atomic lock publication repairs its bound staging link and ignores orphan staging', (t) => {
  const { cacheRoot, prepared } = fixture(t, 'atomic-publication');
  const lock = acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
  });
  const lockRoot = path.dirname(lock.lockPath);
  const lockStat = fs.lstatSync(lock.lockPath);
  assert.equal(lockStat.isFile(), true);
  assert.equal(lockStat.nlink, 1);
  assert.equal(lockStat.mode & 0o7777, 0o600);
  const owner = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
  const publishingStage = path.join(lockRoot, owner.stagingName);
  fs.linkSync(lock.lockPath, publishingStage);
  assert.equal(fs.lstatSync(lock.lockPath).nlink, 2);
  assert.throws(() => acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
  }), /agent_production_cache_request_lock_contended/);
  assert.equal(fs.existsSync(publishingStage), false);
  assert.equal(fs.lstatSync(lock.lockPath).nlink, 1);
  assert.equal(assertAgentProductionCacheRequestLock(lock), lock);
  releaseAgentProductionCacheRequestLock(lock);

  const orphan = path.join(
    lockRoot,
    `.pending-${'a'.repeat(64)}-interrupted-before-publication`,
  );
  fs.writeFileSync(orphan, '{"incomplete":true}\n', { flag: 'wx', mode: 0o600 });
  const replacement = acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
  });
  assert.equal(assertAgentProductionCacheRequestLock(replacement), replacement);
  releaseAgentProductionCacheRequestLock(replacement);
  assert.equal(fs.existsSync(orphan), true);
});

test('cross-host owner remains fail-closed without an external fencing authority', (t) => {
  const { cacheRoot, prepared } = fixture(t, 'remote-abandoned');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const cache = await import(${JSON.stringify(CACHE_MODULE_URL)});
    const prepared = cache.prepareAgentProductionCacheRoot(${JSON.stringify(cacheRoot)});
    cache.acquireAgentProductionCacheRequestLock({
      cacheRoot: prepared.root,
      cacheRootIdentity: prepared.identity,
      requestHash: ${JSON.stringify(REQUEST_HASH)},
      staleAfterMs: 1,
      abandonedAfterMs: 60001,
    });
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  const lockPath = path.join(
    cacheRoot,
    '.agent-production-cache-locks',
    `${'a'.repeat(64)}.lock`,
  );
  const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  fs.writeFileSync(lockPath, `${JSON.stringify({ ...owner, hostname: 'remote-owner' })}\n`);
  fs.chmodSync(lockPath, 0o600);
  assert.throws(() => acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
    staleAfterMs: 1,
    clock: futureClock(30_000),
  }), /agent_production_cache_request_lock_contended/);
  assert.throws(() => acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
    staleAfterMs: 1,
    clock: futureClock(120_000),
  }), /agent_production_cache_request_lock_contended/);
});

test('lock validation rejects hardlink, mode, inode, and lock-root symlink drift', (t) => {
  const { cacheRoot, prepared, parent } = fixture(t, 'drift');
  const lock = acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
  });
  const ownerAlias = path.join(path.dirname(lock.lockPath), 'owner-alias.json');
  fs.linkSync(lock.lockPath, ownerAlias);
  assert.throws(
    () => assertAgentProductionCacheRequestLock(lock),
    /agent_production_cache_request_lock_owner_invalid/,
  );
  fs.unlinkSync(ownerAlias);
  fs.chmodSync(lock.lockPath, 0o644);
  assert.throws(
    () => assertAgentProductionCacheRequestLock(lock),
    /agent_production_cache_request_lock_owner_invalid/,
  );
  fs.chmodSync(lock.lockPath, 0o600);
  const originalOwner = path.join(
    path.dirname(lock.lockPath),
    `.owner-original-${process.pid}.json`,
  );
  fs.renameSync(lock.lockPath, originalOwner);
  fs.symlinkSync(originalOwner, lock.lockPath);
  assert.throws(
    () => assertAgentProductionCacheRequestLock(lock),
    /agent_production_cache_request_lock_owner_invalid/,
  );
  fs.unlinkSync(lock.lockPath);
  fs.copyFileSync(originalOwner, lock.lockPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(lock.lockPath, 0o600);
  assert.throws(
    () => assertAgentProductionCacheRequestLock(lock),
    /agent_production_cache_request_lock_owner_invalid/,
  );
  fs.unlinkSync(lock.lockPath);
  fs.renameSync(originalOwner, lock.lockPath);
  assert.equal(assertAgentProductionCacheRequestLock(lock), lock);
  const heartbeat = refreshAgentProductionCacheRequestLock(lock);
  assert.equal(heartbeat.refreshed, true);
  assert.equal(Number.isFinite(Date.parse(heartbeat.heartbeatAt)), true);
  releaseAgentProductionCacheRequestLock(lock);

  const lockRoot = path.join(cacheRoot, '.agent-production-cache-locks');
  const movedLockRoot = path.join(parent, 'moved-lock-root');
  fs.renameSync(lockRoot, movedLockRoot);
  fs.symlinkSync(movedLockRoot, lockRoot, 'dir');
  assert.throws(() => acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
  }), /agent_production_cache_lock_root_invalid/);
});

test('no-clobber publish preserves the first durable value and requires its request lock', (t) => {
  const { cacheRoot, prepared } = fixture(t, 'publish');
  const lock = acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
  });
  const candidate = path.join(cacheRoot, `${'a'.repeat(64)}.json`);
  const first = Object.freeze({ request: { requestHash: REQUEST_HASH }, value: 'first' });
  const second = Object.freeze({ request: { requestHash: REQUEST_HASH }, value: 'second' });
  assert.equal(publishAgentProductionCacheEntryNoClobber({
    lock,
    candidate,
    value: first,
    maximumBytes: 4096,
  }).published, true);
  assert.deepEqual(publishAgentProductionCacheEntryNoClobber({
    lock,
    candidate,
    value: second,
    maximumBytes: 4096,
  }), { published: false, existing: true });
  assert.deepEqual(readAgentProductionCache({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    candidate,
    maximumBytes: 4096,
  }), first);
  releaseAgentProductionCacheRequestLock(lock);
  assert.throws(() => publishAgentProductionCacheEntryNoClobber({
    lock,
    candidate,
    value: second,
    maximumBytes: 4096,
  }), /agent_production_cache_request_lock_not_held/);
});

test('no-clobber publish rejects an existing cache entry hardlink', (t) => {
  const { cacheRoot, prepared } = fixture(t, 'publish-hardlink');
  const lock = acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
  });
  const candidate = path.join(cacheRoot, `${'a'.repeat(64)}.json`);
  publishAgentProductionCacheEntryNoClobber({
    lock,
    candidate,
    value: { request: { requestHash: REQUEST_HASH } },
    maximumBytes: 4096,
  });
  const alias = path.join(cacheRoot, 'cache-entry-hardlink');
  fs.linkSync(candidate, alias);
  assert.equal(readAgentProductionCache({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    candidate,
    maximumBytes: 4096,
  }), null);
  assert.throws(() => publishAgentProductionCacheEntryNoClobber({
    lock,
    candidate,
    value: { request: { requestHash: REQUEST_HASH }, changed: true },
    maximumBytes: 4096,
  }), /agent_production_cache_publish_existing_invalid/);
  fs.unlinkSync(alias);
  releaseAgentProductionCacheRequestLock(lock);
});

test('async lock wrapper releases in finally after an operation failure', async (t) => {
  const { cacheRoot, prepared } = fixture(t, 'finally');
  await assert.rejects(withAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
  }, async (lock) => {
    assert.equal(assertAgentProductionCacheRequestLock(lock), lock);
    throw new Error('fixture_operation_failed');
  }), /fixture_operation_failed/);
  const replacement = acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
  });
  releaseAgentProductionCacheRequestLock(replacement);
});

test('async lock wrapper waits without blocking and re-enters after release', async (t) => {
  const { cacheRoot, prepared } = fixture(t, 'async-wait');
  const first = acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
  });
  let entered = false;
  const waiting = withAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
    contentionWaitMs: 2_000,
    contentionPollMs: 10,
  }, async (lock) => {
    entered = true;
    assert.equal(assertAgentProductionCacheRequestLock(lock), lock);
    return 'second-owner';
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(entered, false);
  releaseAgentProductionCacheRequestLock(first);
  assert.equal(await waiting, 'second-owner');
  assert.equal(entered, true);
});

test('async lock wrapper has finite timeout and AbortSignal cancellation', async (t) => {
  const { cacheRoot, prepared } = fixture(t, 'async-stop');
  const first = acquireAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
  });
  await assert.rejects(withAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
    contentionWaitMs: 25,
    contentionPollMs: 5,
  }, async () => null), /agent_production_cache_request_lock_wait_timeout/);
  const controller = new AbortController();
  const waiting = withAgentProductionCacheRequestLock({
    cacheRoot,
    cacheRootIdentity: prepared.identity,
    requestHash: REQUEST_HASH,
    contentionWaitMs: 2_000,
    contentionPollMs: 10,
    signal: controller.signal,
  }, async () => null);
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(waiting, /agent_production_cache_request_lock_wait_aborted/);
  releaseAgentProductionCacheRequestLock(first);
});

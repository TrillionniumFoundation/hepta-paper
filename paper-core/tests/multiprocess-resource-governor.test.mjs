import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createSqliteResourceGovernor } from '../../paper-adapters/automation/sqlite-resource-governor.mjs';
import { createSqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { currentProcessIdentity } from '../../workflow-kernel/runtime/process-identity.mjs';

test('SQLite resource leases enforce one global quota across independent connections', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-db-governor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstStore = createDefaultPaperStore({ root, runtimeRoot: root });
  const configured = firstStore.execute("UPDATE automation_resource_limits SET agent_limit=1,cpu_limit=1,gpu_limit=1,memory_mib_limit=1024 WHERE scope='global';");
  assert.equal(configured.ok, true);
  const secondStore = createSqliteStore({ dbPath: firstStore.dbPath });
  t.after(() => { firstStore.close(); secondStore.close(); });
  const limits = { agent: 1, cpu: 1, gpu: 1, memoryMiB: 1024 };
  const first = createSqliteResourceGovernor({ store: firstStore, limits, ownerId: 'process-a', pollMs: 5 });
  const second = createSqliteResourceGovernor({ store: secondStore, limits, ownerId: 'process-b', pollMs: 5 });

  const releaseFirst = await first.acquire({ agent: 1, memoryMiB: 512 }, { campaignId: 'a', nodeId: 'a:writer' });
  let secondAcquired = false;
  const waiting = second.acquire({ agent: 1, memoryMiB: 512 }, { campaignId: 'b', nodeId: 'b:writer' }).then((release) => {
    secondAcquired = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(secondAcquired, false);
  assert.equal(first.snapshot().used.agent, 1);
  assert.equal(first.snapshot().activeLeases, 1);
  assert.equal(firstStore.execute("DELETE FROM automation_resource_waiters WHERE scope='global';").ok, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(firstStore.query("SELECT count(*) AS count FROM automation_resource_waiters WHERE scope='global';").rows[0].count, 1);

  let firstReacquired = false;
  const reacquiring = first.acquire({ agent: 1, memoryMiB: 512 }, { campaignId: 'a', nodeId: 'a:next-writer' }).then((release) => {
    firstReacquired = true;
    return release;
  });
  releaseFirst();
  const releaseSecond = await waiting;
  assert.equal(secondAcquired, true);
  assert.equal(second.snapshot().used.agent, 1);
  assert.equal(second.snapshot().peak.agent, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(firstReacquired, false);
  releaseSecond();
  const releaseReacquired = await reacquiring;
  assert.equal(firstReacquired, true);
  releaseReacquired();
  assert.equal(first.snapshot().used.agent, 0);
  assert.equal(first.snapshot().activeLeases, 0);
});

test('SQLite resource waiters are abortable and cleaned without acquiring later', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-db-governor-abort-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  t.after(() => store.close());
  assert.equal(store.execute("UPDATE automation_resource_limits SET agent_limit=1,cpu_limit=1,gpu_limit=1,memory_mib_limit=1024 WHERE scope='global';").ok, true);
  const governor = createSqliteResourceGovernor({ store, limits: { agent: 1, cpu: 1, gpu: 1, memoryMiB: 1024 }, ownerId: 'abort-owner', pollMs: 5 });
  const release = await governor.acquire({ agent: 1 });
  const controller = new AbortController();
  const waiting = governor.acquire({ agent: 1 }, { campaignId: 'aborted', nodeId: 'aborted:writer', signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort('campaign_cancelled');
  await assert.rejects(waiting, (error) => error?.code === 'resource_acquire_aborted');
  assert.equal(store.query("SELECT count(*) AS count FROM automation_resource_waiters WHERE campaign_id='aborted';").rows[0].count, 0);
  release();
  assert.equal(governor.snapshot().activeLeases, 0);
});

test('SQLite resource governor reclaims a PID-reused default owner before lease expiry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-db-governor-pid-reuse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  t.after(() => store.close());
  const identity = currentProcessIdentity();
  const staleStart = identity.pidStartTime === '1' ? '2' : '1';
  const staleOwner = `resource-owner:fixture:process:${identity.pid}:${staleStart}`;
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  assert.equal(store.execute(`INSERT INTO automation_resource_leases(lease_id,scope,owner_id,agent,cpu,gpu,memory_mib,acquired_at,renewed_at,expires_at) VALUES('pid-reused','global','${staleOwner}',4,0,0,0,'${now.toISOString()}','${now.toISOString()}','${expires}');`).ok, true);
  const governor = createSqliteResourceGovernor({ store, limits: { agent: 4, cpu: 4, gpu: 1, memoryMiB: 8192 } });
  const snapshot = governor.snapshot();
  assert.equal(snapshot.activeLeases, 0);
  assert.equal(snapshot.used.agent, 0);
});

test('SQLite resource lease exposes a fencing token and signals ownership loss', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-db-governor-fence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  t.after(() => store.close());
  const governor = createSqliteResourceGovernor({
    store,
    limits: { agent: 4, cpu: 4, gpu: 1, memoryMiB: 8192 },
    ownerId: 'fenced-owner',
    leaseSeconds: 1,
    pollMs: 5,
  });
  const lease = await governor.acquire({ agent: 1 });
  assert.equal(lease.fencingToken, lease.leaseId);
  assert.equal(lease.lostSignal.aborted, false);
  assert.equal(store.execute(`DELETE FROM automation_resource_leases WHERE lease_id='${lease.leaseId}';`).ok, true);
  assert.equal(lease(), false);
  assert.equal(lease.lostSignal.aborted, true);
  assert.equal(lease.lostSignal.reason, 'resource_lease_release_fence_lost');
});

test('SQLite resource heartbeat detects a lost lease and raises lostSignal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-db-governor-heartbeat-fence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  t.after(() => store.close());
  const governor = createSqliteResourceGovernor({
    store,
    limits: { agent: 4, cpu: 4, gpu: 1, memoryMiB: 8192 },
    ownerId: 'heartbeat-fenced-owner',
    leaseSeconds: 1,
    pollMs: 5,
  });
  const lease = await governor.acquire({ cpu: 1 });
  const lost = new Promise((resolve) => lease.lostSignal.addEventListener('abort', resolve, { once: true }));
  assert.equal(store.execute(`DELETE FROM automation_resource_leases WHERE lease_id='${lease.leaseId}';`).ok, true);
  await Promise.race([lost, new Promise((_, reject) => setTimeout(() => reject(new Error('resource lease heartbeat did not signal loss')), 1500))]);
  assert.equal(lease.lostSignal.aborted, true);
  assert.equal(lease.lostSignal.reason, 'resource_lease_heartbeat_fence_lost');
  assert.equal(lease(), false);
});

function runProcess(dbPath, ownerId, holdMs = 120, mode = 'release') {
  const fixture = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'resource-governor-process.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, dbPath, ownerId, String(holdMs), mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `resource governor child exited ${code}`));
      else resolve(stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));
    });
  });
}

test('three OS processes serialize one shared agent slot and recover a crashed lease', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-db-governor-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  assert.equal(store.execute("UPDATE automation_resource_limits SET agent_limit=1,cpu_limit=1,gpu_limit=1,memory_mib_limit=1024 WHERE scope='global';").ok, true);
  const dbPath = store.dbPath;
  store.close();

  const waves = await Promise.all(['process-1', 'process-2', 'process-3'].map((owner) => runProcess(dbPath, owner)));
  const intervals = waves.map((events) => ({ start: events.find((event) => event.event === 'acquired').at, end: events.find((event) => event.event === 'released').at })).sort((left, right) => left.start - right.start);
  for (let index = 1; index < intervals.length; index += 1) assert.ok(intervals[index].start >= intervals[index - 1].end);

  const crashed = await runProcess(dbPath, 'crashed-process', 0, 'crash');
  assert.equal(crashed[0].event, 'acquired');
  const recoveryStarted = Date.now();
  const recovered = await runProcess(dbPath, 'recovery-process', 10, 'release');
  assert.equal(recovered[0].event, 'acquired');
  assert.ok(recovered[0].at - recoveryStarted >= 500);
  assert.ok(recovered[0].at - recoveryStarted < 3000);
});

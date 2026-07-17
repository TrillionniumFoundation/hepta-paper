import crypto from 'node:crypto';
import { failClosedStoreQueries, sqlText } from '../../paper-ports/store-port.mjs';
import { currentProcessIdentity, formatProcessIdentitySuffix, parseProcessIdentitySuffix, processIdentityIsStale } from '../../workflow-kernel/runtime/process-identity.mjs';

const KEYS = Object.freeze(['agent', 'cpu', 'gpu', 'memoryMiB']);
const LIMIT_COLUMNS = Object.freeze({ agent: 'agent_limit', cpu: 'cpu_limit', gpu: 'gpu_limit', memoryMiB: 'memory_mib_limit' });

function normalizedResources(value = {}) {
  return Object.fromEntries(KEYS.map((key) => [key, Math.max(0, Math.floor(Number(value[key] || 0)))]));
}

function acquisitionAborted(signal) {
  const error = new Error(`resource_acquire_aborted:${String(signal?.reason || 'aborted')}`);
  error.name = 'AbortError';
  error.code = 'resource_acquire_aborted';
  return error;
}

function sleep(ms, signal = null) {
  if (signal?.aborted) return Promise.reject(acquisitionAborted(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(acquisitionAborted(signal));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function legacyOwnerProcessIdentity(ownerId) {
  const match = String(ownerId || '').match(/^resource-owner:(\d+):/);
  return match ? Object.freeze({ pid: Number(match[1]), pidStartTime: null }) : null;
}

function ownerProcessIdentity(ownerId) {
  return parseProcessIdentitySuffix(ownerId) || legacyOwnerProcessIdentity(ownerId);
}

function defaultOwnerId() {
  return `resource-owner:${crypto.randomUUID()}:${formatProcessIdentitySuffix(currentProcessIdentity())}`;
}

export function createSqliteResourceGovernor({
  store: suppliedStore,
  limits = { agent: 4, cpu: 4, gpu: 1, memoryMiB: 8192 },
  scope = 'global',
  ownerId = defaultOwnerId(),
  leaseSeconds = 1800,
  pollMs = 50,
  clock = { now: () => new Date(), nowIso: () => new Date().toISOString() },
} = {}) {
  if (!suppliedStore) throw new Error('StorePort is required for the SQLite resource governor');
  const store = failClosedStoreQueries(suppliedStore);
  const maximum = normalizedResources(limits);
  const existing = store.query(`SELECT * FROM automation_resource_limits WHERE scope=${sqlText(scope)} LIMIT 1;`).rows[0];
  if (!existing) {
    const now = clock.nowIso();
    const created = store.execute(`BEGIN IMMEDIATE;
INSERT OR IGNORE INTO automation_resource_limits(scope,agent_limit,cpu_limit,gpu_limit,memory_mib_limit,created_at,updated_at)
VALUES(${sqlText(scope)},${maximum.agent},${maximum.cpu},${maximum.gpu},${maximum.memoryMiB},${sqlText(now)},${sqlText(now)});
INSERT OR IGNORE INTO automation_resource_peaks(scope,updated_at) VALUES(${sqlText(scope)},${sqlText(now)});
COMMIT;`);
    if (!created.ok) throw new Error(created.error || 'resource_governor_configuration_failed');
  }
  const configured = store.query(`SELECT * FROM automation_resource_limits WHERE scope=${sqlText(scope)} LIMIT 1;`).rows[0];
  for (const key of KEYS) {
    if (Number(configured?.[LIMIT_COLUMNS[key]]) !== maximum[key]) {
      throw new Error(`resource_limit_configuration_mismatch:${key}`);
    }
  }

  const reapDeadOwners = () => {
    const now = clock.nowIso();
    const rows = store.query(`SELECT DISTINCT owner_id FROM automation_resource_leases WHERE scope=${sqlText(scope)} AND expires_at>${sqlText(now)} UNION SELECT DISTINCT owner_id FROM automation_resource_waiters WHERE scope=${sqlText(scope)} AND expires_at>${sqlText(now)};`).rows;
    const dead = rows.map((row) => row.owner_id).filter((value) => {
      const identity = ownerProcessIdentity(value);
      return identity && processIdentityIsStale(identity);
    });
    if (!dead.length) return 0;
    const removed = store.execute(`BEGIN IMMEDIATE; DELETE FROM automation_resource_leases WHERE scope=${sqlText(scope)} AND owner_id IN (${dead.map(sqlText).join(',')}); DELETE FROM automation_resource_waiters WHERE scope=${sqlText(scope)} AND owner_id IN (${dead.map(sqlText).join(',')}); COMMIT;`);
    if (!removed.ok) throw new Error(removed.error || 'resource_dead_owner_reap_failed');
    return dead.length;
  };

  const snapshot = () => {
    reapDeadOwners();
    const now = clock.nowIso();
    const row = store.query(`SELECT
      l.agent_limit,l.cpu_limit,l.gpu_limit,l.memory_mib_limit,
      coalesce(sum(CASE WHEN r.expires_at>${sqlText(now)} THEN r.agent ELSE 0 END),0) AS agent_used,
      coalesce(sum(CASE WHEN r.expires_at>${sqlText(now)} THEN r.cpu ELSE 0 END),0) AS cpu_used,
      coalesce(sum(CASE WHEN r.expires_at>${sqlText(now)} THEN r.gpu ELSE 0 END),0) AS gpu_used,
      coalesce(sum(CASE WHEN r.expires_at>${sqlText(now)} THEN r.memory_mib ELSE 0 END),0) AS memory_mib_used,
      coalesce(p.agent_peak,0) AS agent_peak,coalesce(p.cpu_peak,0) AS cpu_peak,
      coalesce(p.gpu_peak,0) AS gpu_peak,coalesce(p.memory_mib_peak,0) AS memory_mib_peak,
      count(CASE WHEN r.expires_at>${sqlText(now)} THEN 1 END) AS active_leases
    FROM automation_resource_limits l
    LEFT JOIN automation_resource_leases r ON r.scope=l.scope
    LEFT JOIN automation_resource_peaks p ON p.scope=l.scope
    WHERE l.scope=${sqlText(scope)} GROUP BY l.scope;`).rows[0] || {};
    const waiting = store.query(`SELECT count(*) AS waiting FROM automation_resource_waiters WHERE scope=${sqlText(scope)} AND expires_at>${sqlText(now)};`).rows[0];
    return Object.freeze({
      scope,
      ownerId,
      limits: Object.fromEntries(KEYS.map((key) => [key, Number(row[LIMIT_COLUMNS[key]] || 0)])),
      used: { agent: Number(row.agent_used || 0), cpu: Number(row.cpu_used || 0), gpu: Number(row.gpu_used || 0), memoryMiB: Number(row.memory_mib_used || 0) },
      peak: { agent: Number(row.agent_peak || 0), cpu: Number(row.cpu_peak || 0), gpu: Number(row.gpu_peak || 0), memoryMiB: Number(row.memory_mib_peak || 0) },
      activeLeases: Number(row.active_leases || 0),
      waiting: Number(waiting?.waiting || 0),
      persistence: 'sqlite',
    });
  };

  return Object.freeze({
    version: 1,
    kind: 'SqliteGlobalResourceGovernor',
    limits: Object.freeze({ ...maximum }),
    snapshot,
    async acquire(request = {}, context = {}) {
      const resources = normalizedResources(request);
      for (const key of KEYS) if (resources[key] > maximum[key]) throw new Error(`resource_request_exceeds_limit:${key}`);
      const signal = context.signal || null;
      if (signal?.aborted) throw acquisitionAborted(signal);
      const leaseId = `${ownerId}:${crypto.randomUUID()}`;
      const waiterId = `resource-waiter:${process.pid}:${crypto.randomUUID()}`;
      const requestedAt = clock.nowIso();
      let contentionCount = 0;
      const waiterExpiry = new Date(clock.now().getTime() + 30_000).toISOString();
      const queued = store.execute(`INSERT INTO automation_resource_waiters(waiter_id,scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,requested_at,renewed_at,expires_at) VALUES(${sqlText(waiterId)},${sqlText(scope)},${sqlText(ownerId)},${context.campaignId ? sqlText(context.campaignId) : 'NULL'},${context.nodeId ? sqlText(context.nodeId) : 'NULL'},${resources.agent},${resources.cpu},${resources.gpu},${resources.memoryMiB},${sqlText(requestedAt)},${sqlText(requestedAt)},${sqlText(waiterExpiry)});`);
      if (!queued.ok) throw new Error(queued.error || 'resource_waiter_enqueue_failed');
      let acquiredLease = false;
      try {
        while (true) {
        if (signal?.aborted) throw acquisitionAborted(signal);
        reapDeadOwners();
        const now = clock.now();
        const nowIso = now.toISOString();
        const expiresAt = new Date(now.getTime() + Math.max(1, Number(leaseSeconds)) * 1000).toISOString();
        const insert = store.execute(`BEGIN IMMEDIATE;
DELETE FROM automation_resource_leases WHERE scope=${sqlText(scope)} AND expires_at<=${sqlText(nowIso)};
DELETE FROM automation_resource_waiters WHERE scope=${sqlText(scope)} AND expires_at<=${sqlText(nowIso)};
INSERT OR IGNORE INTO automation_resource_waiters(waiter_id,scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,requested_at,renewed_at,expires_at) VALUES(${sqlText(waiterId)},${sqlText(scope)},${sqlText(ownerId)},${context.campaignId ? sqlText(context.campaignId) : 'NULL'},${context.nodeId ? sqlText(context.nodeId) : 'NULL'},${resources.agent},${resources.cpu},${resources.gpu},${resources.memoryMiB},${sqlText(requestedAt)},${sqlText(nowIso)},${sqlText(new Date(now.getTime() + 30_000).toISOString())});
UPDATE automation_resource_waiters SET renewed_at=${sqlText(nowIso)},expires_at=${sqlText(new Date(now.getTime() + 30_000).toISOString())} WHERE waiter_id=${sqlText(waiterId)} AND owner_id=${sqlText(ownerId)};
INSERT INTO automation_resource_leases(lease_id,scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,acquired_at,renewed_at,expires_at)
SELECT ${sqlText(leaseId)},${sqlText(scope)},${sqlText(ownerId)},${context.campaignId ? sqlText(context.campaignId) : 'NULL'},${context.nodeId ? sqlText(context.nodeId) : 'NULL'},
  ${resources.agent},${resources.cpu},${resources.gpu},${resources.memoryMiB},${sqlText(nowIso)},${sqlText(nowIso)},${sqlText(expiresAt)}
WHERE ${resources.agent} <= (SELECT agent_limit-coalesce(sum(agent),0) FROM automation_resource_limits l LEFT JOIN automation_resource_leases r ON r.scope=l.scope AND r.expires_at>${sqlText(nowIso)} WHERE l.scope=${sqlText(scope)})
  AND ${resources.cpu} <= (SELECT cpu_limit-coalesce(sum(cpu),0) FROM automation_resource_limits l LEFT JOIN automation_resource_leases r ON r.scope=l.scope AND r.expires_at>${sqlText(nowIso)} WHERE l.scope=${sqlText(scope)})
  AND ${resources.gpu} <= (SELECT gpu_limit-coalesce(sum(gpu),0) FROM automation_resource_limits l LEFT JOIN automation_resource_leases r ON r.scope=l.scope AND r.expires_at>${sqlText(nowIso)} WHERE l.scope=${sqlText(scope)})
  AND ${resources.memoryMiB} <= (SELECT memory_mib_limit-coalesce(sum(memory_mib),0) FROM automation_resource_limits l LEFT JOIN automation_resource_leases r ON r.scope=l.scope AND r.expires_at>${sqlText(nowIso)} WHERE l.scope=${sqlText(scope)})
  AND ${sqlText(waiterId)} = (SELECT w.waiter_id FROM automation_resource_waiters w WHERE w.scope=${sqlText(scope)} AND w.expires_at>${sqlText(nowIso)}
    AND w.agent <= (SELECT agent_limit-coalesce(sum(agent),0) FROM automation_resource_limits l LEFT JOIN automation_resource_leases r ON r.scope=l.scope AND r.expires_at>${sqlText(nowIso)} WHERE l.scope=${sqlText(scope)})
    AND w.cpu <= (SELECT cpu_limit-coalesce(sum(cpu),0) FROM automation_resource_limits l LEFT JOIN automation_resource_leases r ON r.scope=l.scope AND r.expires_at>${sqlText(nowIso)} WHERE l.scope=${sqlText(scope)})
    AND w.gpu <= (SELECT gpu_limit-coalesce(sum(gpu),0) FROM automation_resource_limits l LEFT JOIN automation_resource_leases r ON r.scope=l.scope AND r.expires_at>${sqlText(nowIso)} WHERE l.scope=${sqlText(scope)})
    AND w.memory_mib <= (SELECT memory_mib_limit-coalesce(sum(memory_mib),0) FROM automation_resource_limits l LEFT JOIN automation_resource_leases r ON r.scope=l.scope AND r.expires_at>${sqlText(nowIso)} WHERE l.scope=${sqlText(scope)})
    ORDER BY w.requested_at,w.waiter_id LIMIT 1);
DELETE FROM automation_resource_waiters WHERE waiter_id=${sqlText(waiterId)} AND EXISTS(SELECT 1 FROM automation_resource_leases WHERE lease_id=${sqlText(leaseId)});
UPDATE automation_resource_peaks SET
  agent_peak=max(agent_peak,(SELECT coalesce(sum(agent),0) FROM automation_resource_leases WHERE scope=${sqlText(scope)} AND expires_at>${sqlText(nowIso)})),
  cpu_peak=max(cpu_peak,(SELECT coalesce(sum(cpu),0) FROM automation_resource_leases WHERE scope=${sqlText(scope)} AND expires_at>${sqlText(nowIso)})),
  gpu_peak=max(gpu_peak,(SELECT coalesce(sum(gpu),0) FROM automation_resource_leases WHERE scope=${sqlText(scope)} AND expires_at>${sqlText(nowIso)})),
  memory_mib_peak=max(memory_mib_peak,(SELECT coalesce(sum(memory_mib),0) FROM automation_resource_leases WHERE scope=${sqlText(scope)} AND expires_at>${sqlText(nowIso)})),
  updated_at=${sqlText(nowIso)} WHERE scope=${sqlText(scope)};
COMMIT;`);
        if (!insert.ok) throw new Error(insert.error || 'resource_lease_acquire_failed');
        const acquiredLookup = store.query(`SELECT lease_id FROM automation_resource_leases WHERE lease_id=${sqlText(leaseId)} LIMIT 1;`);
        if (!acquiredLookup.ok) throw new Error(acquiredLookup.error || 'resource_lease_lookup_failed');
        const acquired = acquiredLookup.rows.length === 1;
        if (acquired) {
          acquiredLease = true;
          const acquiredAt = nowIso;
          let released = false;
          const lostController = new AbortController();
          const markLost = (reason) => {
            if (!lostController.signal.aborted) lostController.abort(reason);
          };
          const heartbeat = setInterval(() => {
            if (released) return;
            const renewedAt = clock.now();
            const renewedExpiry = new Date(renewedAt.getTime() + Math.max(1, Number(leaseSeconds)) * 1000).toISOString();
            try {
              const renewed = store.query(`UPDATE automation_resource_leases SET renewed_at=${sqlText(renewedAt.toISOString())},expires_at=${sqlText(renewedExpiry)} WHERE lease_id=${sqlText(leaseId)} AND owner_id=${sqlText(ownerId)} AND expires_at>${sqlText(renewedAt.toISOString())} RETURNING lease_id;`);
              if (renewed.rows.length === 1) return;
              clearInterval(heartbeat);
              markLost('resource_lease_heartbeat_fence_lost');
            } catch (error) {
              clearInterval(heartbeat);
              markLost(error?.message || 'resource_lease_heartbeat_failed');
            }
          }, Math.max(250, Math.floor(Math.max(1, Number(leaseSeconds)) * 1000 / 3)));
          heartbeat.unref();
          const release = () => {
            if (released) return false;
            released = true;
            clearInterval(heartbeat);
            const releasedAt = clock.nowIso();
            let removed;
            try {
              removed = store.query(`DELETE FROM automation_resource_leases WHERE lease_id=${sqlText(leaseId)} AND owner_id=${sqlText(ownerId)} AND expires_at>${sqlText(releasedAt)} RETURNING lease_id;`);
            } catch (error) {
              markLost(error?.message || 'resource_lease_release_failed');
              throw error;
            }
            if (removed.rows.length !== 1) {
              markLost('resource_lease_release_fence_lost');
              return false;
            }
            return true;
          };
          release.telemetry = Object.freeze({ requestedAt, acquiredAt, lockWaitMs: Math.max(0, Date.parse(acquiredAt) - Date.parse(requestedAt)), queueContentionCount: contentionCount });
          release.leaseId = leaseId;
          release.fencingToken = leaseId;
          release.lostSignal = lostController.signal;
          return release;
        }
        contentionCount += 1;
        await sleep(Math.max(5, Number(pollMs || 50)), signal);
        }
      } finally {
        if (!acquiredLease) {
          const removed = store.execute(`DELETE FROM automation_resource_waiters WHERE waiter_id=${sqlText(waiterId)} AND owner_id=${sqlText(ownerId)};`);
          if (!removed.ok) throw new Error(removed.error || 'resource_waiter_cleanup_failed');
        }
      }
    },
  });
}

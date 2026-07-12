import crypto from 'node:crypto';
import { sqlText } from '../../paper-ports/store-port.mjs';

const KEYS = Object.freeze(['agent', 'cpu', 'gpu', 'memoryMiB']);
const COLUMNS = Object.freeze({ agent: 'agent', cpu: 'cpu', gpu: 'gpu', memoryMiB: 'memory_mib' });
const LIMIT_COLUMNS = Object.freeze({ agent: 'agent_limit', cpu: 'cpu_limit', gpu: 'gpu_limit', memoryMiB: 'memory_mib_limit' });
const PEAK_COLUMNS = Object.freeze({ agent: 'agent_peak', cpu: 'cpu_peak', gpu: 'gpu_peak', memoryMiB: 'memory_mib_peak' });

function normalizedResources(value = {}) {
  return Object.fromEntries(KEYS.map((key) => [key, Math.max(0, Math.floor(Number(value[key] || 0)))]));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function createSqliteResourceGovernor({
  store,
  limits = { agent: 4, cpu: 4, gpu: 1, memoryMiB: 8192 },
  scope = 'global',
  ownerId = `resource-owner:${process.pid}:${crypto.randomUUID()}`,
  leaseSeconds = 120,
  pollMs = 50,
  clock = { now: () => new Date(), nowIso: () => new Date().toISOString() },
} = {}) {
  if (!store) throw new Error('StorePort is required for the SQLite resource governor');
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

  const snapshot = () => {
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
    return Object.freeze({
      scope,
      ownerId,
      limits: Object.fromEntries(KEYS.map((key) => [key, Number(row[LIMIT_COLUMNS[key]] || 0)])),
      used: { agent: Number(row.agent_used || 0), cpu: Number(row.cpu_used || 0), gpu: Number(row.gpu_used || 0), memoryMiB: Number(row.memory_mib_used || 0) },
      peak: { agent: Number(row.agent_peak || 0), cpu: Number(row.cpu_peak || 0), gpu: Number(row.gpu_peak || 0), memoryMiB: Number(row.memory_mib_peak || 0) },
      activeLeases: Number(row.active_leases || 0),
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
      const leaseId = `${ownerId}:${crypto.randomUUID()}`;
      while (true) {
        const now = clock.now();
        const nowIso = now.toISOString();
        const expiresAt = new Date(now.getTime() + Math.max(1, Number(leaseSeconds)) * 1000).toISOString();
        const insert = store.execute(`BEGIN IMMEDIATE;
DELETE FROM automation_resource_leases WHERE scope=${sqlText(scope)} AND expires_at<=${sqlText(nowIso)};
INSERT INTO automation_resource_leases(lease_id,scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,acquired_at,renewed_at,expires_at)
SELECT ${sqlText(leaseId)},${sqlText(scope)},${sqlText(ownerId)},${context.campaignId ? sqlText(context.campaignId) : 'NULL'},${context.nodeId ? sqlText(context.nodeId) : 'NULL'},
  ${resources.agent},${resources.cpu},${resources.gpu},${resources.memoryMiB},${sqlText(nowIso)},${sqlText(nowIso)},${sqlText(expiresAt)}
WHERE ${resources.agent} <= (SELECT agent_limit-coalesce(sum(agent),0) FROM automation_resource_limits l LEFT JOIN automation_resource_leases r ON r.scope=l.scope AND r.expires_at>${sqlText(nowIso)} WHERE l.scope=${sqlText(scope)})
  AND ${resources.cpu} <= (SELECT cpu_limit-coalesce(sum(cpu),0) FROM automation_resource_limits l LEFT JOIN automation_resource_leases r ON r.scope=l.scope AND r.expires_at>${sqlText(nowIso)} WHERE l.scope=${sqlText(scope)})
  AND ${resources.gpu} <= (SELECT gpu_limit-coalesce(sum(gpu),0) FROM automation_resource_limits l LEFT JOIN automation_resource_leases r ON r.scope=l.scope AND r.expires_at>${sqlText(nowIso)} WHERE l.scope=${sqlText(scope)})
  AND ${resources.memoryMiB} <= (SELECT memory_mib_limit-coalesce(sum(memory_mib),0) FROM automation_resource_limits l LEFT JOIN automation_resource_leases r ON r.scope=l.scope AND r.expires_at>${sqlText(nowIso)} WHERE l.scope=${sqlText(scope)});
UPDATE automation_resource_peaks SET
  agent_peak=max(agent_peak,(SELECT coalesce(sum(agent),0) FROM automation_resource_leases WHERE scope=${sqlText(scope)} AND expires_at>${sqlText(nowIso)})),
  cpu_peak=max(cpu_peak,(SELECT coalesce(sum(cpu),0) FROM automation_resource_leases WHERE scope=${sqlText(scope)} AND expires_at>${sqlText(nowIso)})),
  gpu_peak=max(gpu_peak,(SELECT coalesce(sum(gpu),0) FROM automation_resource_leases WHERE scope=${sqlText(scope)} AND expires_at>${sqlText(nowIso)})),
  memory_mib_peak=max(memory_mib_peak,(SELECT coalesce(sum(memory_mib),0) FROM automation_resource_leases WHERE scope=${sqlText(scope)} AND expires_at>${sqlText(nowIso)})),
  updated_at=${sqlText(nowIso)} WHERE scope=${sqlText(scope)};
COMMIT;`);
        if (!insert.ok) throw new Error(insert.error || 'resource_lease_acquire_failed');
        const acquired = store.query(`SELECT lease_id FROM automation_resource_leases WHERE lease_id=${sqlText(leaseId)} LIMIT 1;`).rows.length === 1;
        if (acquired) {
          let released = false;
          const heartbeat = setInterval(() => {
            if (released) return;
            const renewedAt = clock.now();
            const renewedExpiry = new Date(renewedAt.getTime() + Math.max(1, Number(leaseSeconds)) * 1000).toISOString();
            store.execute(`UPDATE automation_resource_leases SET renewed_at=${sqlText(renewedAt.toISOString())},expires_at=${sqlText(renewedExpiry)} WHERE lease_id=${sqlText(leaseId)} AND owner_id=${sqlText(ownerId)};`);
          }, Math.max(250, Math.floor(Math.max(1, Number(leaseSeconds)) * 1000 / 3)));
          heartbeat.unref();
          return () => {
            if (released) return;
            released = true;
            clearInterval(heartbeat);
            const removed = store.execute(`DELETE FROM automation_resource_leases WHERE lease_id=${sqlText(leaseId)} AND owner_id=${sqlText(ownerId)};`);
            if (!removed.ok) throw new Error(removed.error || 'resource_lease_release_failed');
          };
        }
        await sleep(Math.max(5, Number(pollMs || 50)));
      }
    },
  });
}

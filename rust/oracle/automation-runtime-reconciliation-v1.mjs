#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { planAutomationRuntimeReconciliation } from '../../paper-adapters/automation/automation-runtime-reconciler.mjs';

const args = process.argv.slice(2);
const value = (name, fallback = null) => {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1] || fallback;
  const prefix = `${name}=`;
  const inline = args.find((argument) => argument.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
};
const databasePath = value('--database');
const now = value('--at', '2026-07-13T08:00:00.000Z');
const campaignId = value('--campaign-id');
const noProgressSeconds = Number(value('--no-progress-seconds', '1800'));
if (!databasePath) throw new Error('--database is required');
fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
const root = path.dirname(databasePath);
const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: databasePath });
const clock = { now: () => new Date(now), nowIso: () => now };
try {
  if (args.includes('--prepare')) {
    const campaigns = createSqliteCampaignStore({ store, clock });
    for (const ordinal of [1, 2, 3, 4, 5, 6]) campaigns.createCampaign({
      campaignId: `campaign-${ordinal}`,
      paperId: `paper-${ordinal}`,
      ...([3, 4, 5].includes(ordinal) ? { terminalSiblingSettlementPolicyVersion: 1 } : {}),
      nodes: [{ nodeId: `node-${ordinal}`, kind: 'agent', dependencies: [] }],
    });
    store.execute("UPDATE paper_campaigns SET status='failed',stop_reason='historical_failure' WHERE campaign_id='campaign-3';");
    store.execute("UPDATE paper_campaigns SET status='failed',stop_reason='historical_parallel_failure' WHERE campaign_id='campaign-4';");
    store.execute("UPDATE paper_campaigns SET status='failed',stop_reason='historical_integration_failure' WHERE campaign_id='campaign-5';");
    store.execute("UPDATE paper_campaigns SET status='failed',stop_reason='pre_cutover_frozen_failure' WHERE campaign_id='campaign-6';");
    store.execute("UPDATE paper_campaigns SET updated_at='2026-07-13T06:00:00.000Z' WHERE campaign_id='campaign-2';");
    store.execute("UPDATE campaign_nodes SET status='running',lease_owner='dead-worker',lease_expires_at='2026-07-13T07:00:00.000Z' WHERE node_id='node-1';");
    store.execute("UPDATE campaign_nodes SET status='running',lease_owner='terminal-dead-worker',lease_expires_at='2026-07-13T07:00:00.000Z',attempt_id='terminal-attempt-4',lease_generation=4,node_revision=7 WHERE node_id='node-4';");
    store.execute("UPDATE campaign_nodes SET status='running',lease_owner='integration-dead-worker',lease_expires_at='2026-07-13T07:00:00.000Z',attempt_id='terminal-attempt-5',lease_generation=5,node_revision=8,prepared_integration_status='integrating' WHERE node_id='node-5';");
    store.execute("UPDATE campaign_nodes SET status='running',lease_owner='legacy-dead-worker',lease_expires_at='2026-07-13T07:00:00.000Z',attempt_id='legacy-attempt-6',lease_generation=6,node_revision=9 WHERE node_id='node-6';");
    store.execute("INSERT OR IGNORE INTO automation_resource_limits(scope,agent_limit,cpu_limit,gpu_limit,memory_mib_limit,created_at,updated_at) VALUES('global',4,4,1,8192,'2026-07-13T00:00:00.000Z','2026-07-13T00:00:00.000Z');");
    store.execute("INSERT INTO automation_resource_leases(lease_id,scope,owner_id,agent,cpu,gpu,memory_mib,acquired_at,renewed_at,expires_at) VALUES('expired-lease','global','dead',1,0,0,0,'2026-07-13T06:00:00.000Z','2026-07-13T06:00:00.000Z','2026-07-13T07:00:00.000Z'),('active-lease','global','live',1,0,0,0,'2026-07-13T07:30:00.000Z','2026-07-13T07:30:00.000Z','2026-07-13T09:00:00.000Z');");
    store.execute("INSERT INTO automation_resource_waiters(waiter_id,scope,owner_id,agent,cpu,gpu,memory_mib,requested_at,renewed_at,expires_at) VALUES('expired-waiter','global','dead',1,0,0,0,'2026-07-13T06:00:00.000Z','2026-07-13T06:00:00.000Z','2026-07-13T07:00:00.000Z'),('active-waiter','global','live',1,0,0,0,'2026-07-13T07:30:00.000Z','2026-07-13T07:30:00.000Z','2026-07-13T09:00:00.000Z');");
  }
  process.stdout.write(`${JSON.stringify(planAutomationRuntimeReconciliation({ store, clock, campaignId, noProgressSeconds }))}\n`);
} finally {
  store.close();
}

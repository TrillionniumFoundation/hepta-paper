import { assertCampaignStorePort } from '../../paper-ports/campaign-store-port.mjs';
import { failClosedStoreQueries, sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { mapCampaignNodeRow as parseNode, mapCampaignRow as parseCampaign } from './sqlite-campaign-row-mappers.mjs';
import { createCampaignLeaseOperations } from './sqlite-campaign-lease-operations.mjs';
import { createCampaignLifecycleOperations } from './sqlite-campaign-lifecycle-operations.mjs';
import { createCampaignPreparedIntegrationOperations } from './sqlite-campaign-prepared-integration-operations.mjs';
import { createCampaignQueryOperations } from './sqlite-campaign-query-operations.mjs';
import { createCampaignTelemetryOperations } from './sqlite-campaign-telemetry-operations.mjs';
import crypto from 'node:crypto';

export function createSqliteCampaignStore({ store: suppliedStore, clock, experimentRegistryAuthorityVerifier = null } = {}) {
  if (!suppliedStore || !clock) throw new Error('Campaign store requires StorePort and ClockPort');
  const store = failClosedStoreQueries(suppliedStore);

  const CAS_GUARD = 'campaign_cas_guard';

  function guarded(statement) {
    return `DELETE FROM ${CAS_GUARD}; ${statement} INSERT INTO ${CAS_GUARD}(changed) VALUES(changes());`;
  }

  function transaction(statements, fallback) {
    const sql = `BEGIN IMMEDIATE; CREATE TEMP TABLE IF NOT EXISTS ${CAS_GUARD}(changed INTEGER NOT NULL CHECK(changed=1)); ${statements.join(' ')} COMMIT;`;
    const result = store.execute(sql);
    if (!result.ok) {
      const error = new Error(`${fallback}:${result.error || result.stderr || 'transaction_failed'}`);
      error.code = fallback;
      throw error;
    }
    return result;
  }

  function assertLiveNodeAttempt({ nodeId, workerId, attemptId, leaseGeneration, now, extraCondition = '' } = {}) {
    try {
      transaction([
        guarded(`UPDATE campaign_nodes SET node_revision=node_revision WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) ${extraCondition} AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
      ], 'campaign_node_attempt_fence_check_failed');
    } catch {
      throw new Error('campaign_node_lease_lost');
    }
    return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
  }

  function buildEvent(campaignId, nodeId, kind, detail = {}, createdAt = clock.nowIso()) {
    const payload = { version: 1, kind, campaignId, nodeId: nodeId || null, detail, createdAt };
    const eventHash = hashRecord('PaperCampaignEvent', payload);
    const eventId = `${campaignId}:${createdAt}:${eventHash.slice(-16)}:${crypto.randomUUID().slice(0, 8)}`;
    return { createdAt, payload, eventHash, eventId };
  }

  function eventStatement(campaignId, nodeId, kind, detail = {}, createdAt = clock.nowIso()) {
    const built = buildEvent(campaignId, nodeId, kind, detail, createdAt);
    return {
      ...built,
      sql: `INSERT INTO campaign_events(event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at) VALUES(${sqlText(built.eventId)},${sqlText(campaignId)},${nodeId ? sqlText(nodeId) : 'NULL'},${sqlText(kind)},${sqlJson(built.payload)},${sqlText(built.eventHash)},${sqlText(createdAt)});`,
    };
  }

  function usageSql(delta = {}) {
    const costProvided = Object.prototype.hasOwnProperty.call(delta, 'costUsd') && Number.isFinite(Number(delta.costUsd));
    const agent = Math.max(0, Number(delta.agentCalls || 0));
    const cpu = Math.max(0, Number(delta.cpuJobs || 0));
    const gpu = Math.max(0, Number(delta.gpuJobs || 0));
    const tokens = Math.max(0, Number(delta.tokens || 0));
    const cost = costProvided ? Math.max(0, Number(delta.costUsd)) : 0;
    const pricedCalls = costProvided ? Math.max(0, Number(delta.pricedAgentCalls ?? 1)) : 0;
    return `agent_call_count=agent_call_count+${agent},cpu_job_count=cpu_job_count+${cpu},gpu_job_count=gpu_job_count+${gpu},token_count=token_count+${tokens},cost_usd=cost_usd+${cost},priced_agent_call_count=priced_agent_call_count+${pricedCalls},cost_known=CASE WHEN agent_call_count+${agent}=priced_agent_call_count+${pricedCalls} THEN 1 ELSE 0 END`;
  }

  function usageBudgetCondition(delta = {}) {
    const costProvided = Object.prototype.hasOwnProperty.call(delta, 'costUsd')
      && Number.isFinite(Number(delta.costUsd));
    const agent = Math.max(0, Number(delta.agentCalls || 0));
    const cpu = Math.max(0, Number(delta.cpuJobs || 0));
    const gpu = Math.max(0, Number(delta.gpuJobs || 0));
    const tokens = Math.max(0, Number(delta.tokens || 0));
    const cost = costProvided ? Math.max(0, Number(delta.costUsd)) : 0;
    return [
      `agent_call_count+${agent}<=coalesce(json_extract(spec_json,'$.budgets.maxAgentCalls'),9e15)`,
      `cpu_job_count+${cpu}<=coalesce(json_extract(spec_json,'$.budgets.maxCpuJobs'),9e15)`,
      `gpu_job_count+${gpu}<=coalesce(json_extract(spec_json,'$.budgets.maxGpuJobs'),9e15)`,
      `token_count+${tokens}<=coalesce(json_extract(spec_json,'$.budgets.maxTokenCount'),9e15)`,
      ...(costProvided
        ? [`cost_usd+${cost}<=coalesce(json_extract(spec_json,'$.budgets.maxCostUsd'),9e15)`]
        : []),
    ].join(' AND ');
  }

  function readCampaignDefinitionSnapshot(campaignId) {
    const read = (snapshotStore) => {
      const campaignResult = snapshotStore.query(`SELECT * FROM paper_campaigns WHERE campaign_id=${sqlText(campaignId)} LIMIT 1;`);
      if (!campaignResult.ok) throw new Error('campaign_definition_snapshot_failed');
      const campaign = parseCampaign(campaignResult.rows[0]);
      if (!campaign) return { campaign: null, nodes: [] };
      const nodesResult = snapshotStore.query(`SELECT * FROM campaign_nodes WHERE campaign_id=${sqlText(campaignId)} ORDER BY priority,created_at,node_id;`);
      if (!nodesResult.ok) throw new Error('campaign_definition_snapshot_failed');
      return { campaign, nodes: nodesResult.rows.map(parseNode) };
    };
    return typeof store.transaction === 'function'
      ? store.transaction(read, { readOnly: true })
      : read(store);
  }

  const api = {
    version: 2,
    kind: 'SqliteCampaignStore',
    nowEpochMs: () => clock.now().getTime(),
    ...createCampaignQueryOperations({ store }),
    ...createCampaignTelemetryOperations({ store, clock }),
    ...createCampaignLifecycleOperations({ store, clock, transaction, guarded, eventStatement, usageSql, usageBudgetCondition, readCampaignDefinitionSnapshot, getApi: () => api }),
    ...createCampaignLeaseOperations({ store, clock, transaction, guarded, eventStatement, usageSql, usageBudgetCondition, getApi: () => api }),
    ...createCampaignPreparedIntegrationOperations({ store, clock, transaction, guarded, eventStatement, usageSql, assertLiveNodeAttempt, getApi: () => api, experimentRegistryAuthorityVerifier }),
  };
  return assertCampaignStorePort(api);
}

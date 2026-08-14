import { assertCampaignStorePort } from '../../paper-ports/campaign-store-port.mjs';
import { failClosedStoreQueries, sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { mapCampaignNodeRow as parseNode, mapCampaignRow as parseCampaign } from './sqlite-campaign-row-mappers.mjs';
import { createCampaignLeaseOperations } from './sqlite-campaign-lease-operations.mjs';
import { createCampaignNodeAttemptOperations } from './sqlite-campaign-node-attempt-operations.mjs';
import { createCampaignNodeInfrastructureOperations } from './sqlite-campaign-node-infrastructure-operations.mjs';
import { createCampaignLifecycleOperations } from './sqlite-campaign-lifecycle-operations.mjs';
import { createCampaignPreparedIntegrationOperations } from './sqlite-campaign-prepared-integration-operations.mjs';
import { createCampaignQueryOperations } from './sqlite-campaign-query-operations.mjs';
import { createCampaignTelemetryOperations } from './sqlite-campaign-telemetry-operations.mjs';
import { createSqliteCampaignMutationBoundary } from './sqlite-campaign-mutation-boundary.mjs';
import {
  nativeStoreCampaignEventParameters,
} from './native-store-campaign-mutation-plan.mjs';
import {
  campaignUsageBudgetCondition,
  campaignUsageSql,
} from './sqlite-campaign-usage-budget-sql.mjs';
import crypto from 'node:crypto';

export function createSqliteCampaignStore({
  store: suppliedStore,
  clock,
  experimentRegistryAuthorityVerifier = null,
  gpuScientificPromotionAuthorityVerifier = null,
} = {}) {
  if (!suppliedStore || !clock) throw new Error('Campaign store requires StorePort and ClockPort');
  const store = failClosedStoreQueries(suppliedStore);
  const { guarded, mutation } = createSqliteCampaignMutationBoundary({ store });

  function assertLiveNodeAttempt({
    nodeId,
    workerId,
    attemptId,
    leaseGeneration,
    now,
    integrationState,
    integrationKey,
    integrationReceiptHash = null,
  } = {}) {
    const integrated = integrationState === 'integrated';
    const extraCondition = integrated
      ? `AND prepared_requires_integration=1 AND prepared_integration_status='integrated' AND prepared_integration_key=${sqlText(integrationKey)} AND prepared_integration_receipt_sha256=${sqlText(integrationReceiptHash)}`
      : `AND prepared_requires_integration=1 AND prepared_integration_status IN ('integrating','integrated') AND prepared_integration_key=${sqlText(integrationKey)} AND prepared_result_sha256 IS NOT NULL`;
    try {
      mutation({
        databaseRole: 'native-store',
        operationId: 'native-store.campaign-store.assertLiveNodeAttempt.v1',
        statements: [
          guarded(`UPDATE campaign_nodes SET node_revision=node_revision WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)} AND attempt_id=${sqlText(attemptId)} AND lease_generation=${Number(leaseGeneration)} AND julianday(lease_expires_at)>=julianday(${sqlText(now)}) ${extraCondition} AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running');`),
        ],
        fallback: 'campaign_node_attempt_fence_check_failed',
        input: {
          nodeId,
          workerId,
          attemptId,
          leaseGeneration,
          now,
          integrationState,
          integrationKey,
          integrationReceiptHash,
        },
      });
    } catch (error) {
      if (error?.committed) throw error;
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
      parameters: nativeStoreCampaignEventParameters(built),
      sql: `INSERT INTO campaign_events(event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at) VALUES(${sqlText(built.eventId)},${sqlText(campaignId)},${nodeId ? sqlText(nodeId) : 'NULL'},${sqlText(kind)},${sqlJson(built.payload)},${sqlText(built.eventHash)},${sqlText(createdAt)});`,
    };
  }

  const usageSql = campaignUsageSql;
  const usageBudgetCondition = campaignUsageBudgetCondition;

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
    ...createCampaignLifecycleOperations({ store, clock, mutation, guarded, eventStatement, usageSql, usageBudgetCondition, readCampaignDefinitionSnapshot, getApi: () => api }),
    ...createCampaignLeaseOperations({ store, clock, mutation, guarded, eventStatement, getApi: () => api }),
    ...createCampaignNodeAttemptOperations({ store, clock, mutation, guarded, eventStatement, usageSql, usageBudgetCondition, getApi: () => api }),
    ...createCampaignNodeInfrastructureOperations({ store, clock, mutation, guarded, eventStatement, usageSql, usageBudgetCondition }),
    ...createCampaignPreparedIntegrationOperations({
      store,
      clock,
      mutation,
      guarded,
      eventStatement,
      usageSql,
      assertLiveNodeAttempt,
      getApi: () => api,
      experimentRegistryAuthorityVerifier,
      gpuScientificPromotionAuthorityVerifier,
    }),
  };
  return assertCampaignStorePort(api);
}

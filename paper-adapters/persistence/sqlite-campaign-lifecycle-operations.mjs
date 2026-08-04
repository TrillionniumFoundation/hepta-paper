import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { evolveCampaignForResume, validateCampaignRoundExtension } from '../../paper-domain/automation/campaign-evolution-policy.mjs';
import { decideCampaignCommand, selectFutureRoundNodeIds } from '../../paper-domain/automation/campaign-state-policy.mjs';
import { assertCampaignDefinition } from './campaign-definition-codec.mjs';
import { buildSqliteCampaignProjectionStatement } from './sqlite-campaign-projection.mjs';
import { createCampaignCreationOperations } from './sqlite-campaign-creation-operations.mjs';
import {
  createCampaignLifecycleTerminalOperations,
} from './sqlite-campaign-lifecycle-terminal-operations.mjs';

export function createCampaignLifecycleOperations({ store, clock, mutation, guarded, eventStatement, usageSql, usageBudgetCondition, readCampaignDefinitionSnapshot, getApi } = {}) {
  return {
    ...createCampaignCreationOperations({
      clock, mutation, eventStatement, readCampaignDefinitionSnapshot, getApi,
    }),
    skipFutureRounds({ campaignId, afterRound, reason = 'convergence_reached' } = {}) {
      const now = clock.nowIso();
      const futureNodeIds = selectFutureRoundNodeIds(getApi().listNodes(campaignId), { afterRound });
      const updateFutureNodes = futureNodeIds.length
        ? `UPDATE campaign_nodes SET status='skipped',failure_class=${sqlText(reason)},lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id IN (${futureNodeIds.map(sqlText).join(',')}) AND campaign_id=${sqlText(campaignId)} AND status='queued';`
        : '';
      const eventRow = eventStatement(campaignId, null, 'campaign_future_rounds_skipped', { afterRound, reason }, now);
      mutation({
        databaseRole: 'native-store',
        operationId: 'native-store.campaign-lifecycle.skipFutureRounds.v1',
        statements: [
        updateFutureNodes,
        eventRow.sql,
        buildSqliteCampaignProjectionStatement({ campaignId, now }),
        ],
        fallback: 'campaign_future_round_skip_failed',
        input: { futureNodeIds, reason, now, campaignId, eventRow },
      });
      return getApi().getCampaign(campaignId);
    },
    pauseCampaign(campaignId, reason = 'operator_paused') {
      const campaign = getApi().getCampaign(campaignId);
      if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
      if (!decideCampaignCommand(campaign, 'pause').apply) return campaign;
      const now = clock.nowIso();
      const eventRow = eventStatement(campaignId, null, 'campaign_paused', { reason }, now);
      mutation({
        databaseRole: 'native-store',
        operationId: 'native-store.campaign-lifecycle.pauseCampaign.v1',
        statements: [
        guarded(`UPDATE paper_campaigns SET status='paused',stop_reason=${sqlText(reason)},accumulated_run_ms=accumulated_run_ms+max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)),last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status='running' AND revision=${campaign.revision} AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status<>'completed' AND n.prepared_integration_status IN ('integrating','integrated'));`),
        `UPDATE campaign_nodes SET status='queued',lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status IN ('leased','running');`,
        eventRow.sql,
        ],
        fallback: 'campaign_pause_failed',
        input: { reason, now, campaignId, campaign, eventRow },
      });
      return getApi().getCampaign(campaignId);
    },
    resumeCampaign(campaignId, { budgetOverrides = {} } = {}) {
      const campaign = getApi().getCampaign(campaignId);
      if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
      if (!decideCampaignCommand(campaign, 'resume').apply) return campaign;
      const {
        nextSpec, overrides, stoppedForBudget, reopenStoppedNodes, previousCampaignPlanHash,
      } = evolveCampaignForResume({ campaign, budgetOverrides });
      const now = clock.nowIso();
      const reopenSql = reopenStoppedNodes
        ? `UPDATE campaign_nodes SET status='queued',failure_class=NULL,failure_json=NULL,failure_sha256=NULL,lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status='skipped' AND failure_class=${sqlText(campaign.stopReason)};`
        : '';
      const detail = {
        previousStatus: campaign.status,
        budgetOverrides: overrides,
        reopenedBudgetStoppedNodes: Boolean(stoppedForBudget),
        reopenedSupervisorStoppedNodes: Boolean(reopenStoppedNodes && !stoppedForBudget),
        previousCampaignPlanHash,
        campaignPlanHash: nextSpec.campaignPlanHash,
      };
      const eventRow = eventStatement(campaignId, null, 'campaign_resumed', detail, now);
      mutation({
        databaseRole: 'native-store',
        operationId: 'native-store.campaign-lifecycle.resumeCampaign.v1',
        statements: [
        guarded(`UPDATE paper_campaigns SET status='running',current_phase=CASE WHEN current_phase='admitted-not-authorized' THEN 'dispatching' ELSE current_phase END,stop_reason=NULL,last_resumed_at=${sqlText(now)},spec_json=${sqlJson(nextSpec)},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status=${sqlText(campaign.status)} AND revision=${campaign.revision};`),
        reopenSql,
        eventRow.sql,
        ],
        fallback: 'campaign_resume_failed',
        input: {
          now,
          nextSpec,
          campaignId,
          campaign,
          reopenStoppedNodes,
          eventRow,
        },
      });
      return getApi().getCampaign(campaignId);
    },
    extendCampaign(spec = {}) {
      const campaign = getApi().getCampaign(spec.campaignId);
      if (!campaign) throw new Error(`campaign not found: ${spec.campaignId}`);
      assertCampaignDefinition(spec);
      const existingNodes = getApi().listNodes(spec.campaignId);
      const { additions } = validateCampaignRoundExtension({ campaign, spec, existingNodes });
      const now = clock.nowIso();
      const statements = [
        `UPDATE campaign_nodes SET failure_class='campaign_round_extension_superseded',updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(spec.campaignId)} AND kind='package' AND status='skipped' AND failure_class='referee_convergence_not_reached_within_budget';`,
      ];
      for (const item of additions) {
        statements.push(`INSERT INTO campaign_nodes(node_id,campaign_id,kind,round_index,status,priority,dependencies_json,spec_json,max_attempts,created_at,updated_at) VALUES(${sqlText(item.nodeId)},${sqlText(spec.campaignId)},${sqlText(item.kind)},${Number(item.roundIndex || 0)},'queued',${Number(item.priority || 100)},${sqlJson(item.dependencies || [])},${sqlJson(item)},${Math.max(1, Number(item.maxAttempts || 3))},${sqlText(now)},${sqlText(now)});`);
      }
      const detail = {
        previousMaxRounds: campaign.maxRounds,
        maxRounds: Number(spec.maxRounds),
        addedNodeIds: additions.map((item) => item.nodeId).sort(),
        previousCampaignPlanHash: campaign.spec?.campaignPlanHash || null,
        campaignPlanHash: spec.campaignPlanHash || null,
      };
      statements.push(guarded(`UPDATE paper_campaigns SET status='running',stop_reason=NULL,max_rounds=${Number(spec.maxRounds)},spec_json=${sqlJson(spec)},last_resumed_at=${sqlText(now)},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(spec.campaignId)} AND status=${sqlText(campaign.status)} AND revision=${campaign.revision};`));
      const eventRow = eventStatement(spec.campaignId, null, 'campaign_extended', detail, now);
      statements.push(eventRow.sql);
      mutation({
        databaseRole: 'native-store',
        operationId: 'native-store.campaign-lifecycle.extendCampaign.v1',
        statements,
        fallback: 'campaign_extension_failed',
        input: { spec, additions, campaign, now, eventRow },
      });
      return getApi().getCampaign(spec.campaignId);
    },
    cancelCampaign(campaignId, reason = 'operator_cancelled') {
      const campaign = getApi().getCampaign(campaignId);
      if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
      if (!decideCampaignCommand(campaign, 'cancel').apply) return campaign;
      const now = clock.nowIso();
      const elapsedSql = campaign.lastResumedAt ? `accumulated_run_ms=accumulated_run_ms+max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)),` : '';
      const eventRow = eventStatement(campaignId, null, 'campaign_cancelled', { reason }, now);
      mutation({
        databaseRole: 'native-store',
        operationId: 'native-store.campaign-lifecycle.cancelCampaign.v1',
        statements: [
        guarded(`UPDATE paper_campaigns SET ${elapsedSql}status='cancelled',stop_reason=${sqlText(reason)},last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status=${sqlText(campaign.status)} AND revision=${campaign.revision} AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status<>'completed' AND n.prepared_integration_status IN ('integrating','integrated'));`),
        `UPDATE campaign_nodes SET status='skipped',failure_class=${sqlText(reason)},lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status IN ('queued','leased','running');`,
        eventRow.sql,
        ],
        fallback: 'campaign_cancel_failed',
        input: { campaign, now, reason, campaignId, eventRow },
      });
      return getApi().getCampaign(campaignId);
    },
    ...createCampaignLifecycleTerminalOperations({
      store,
      clock,
      mutation,
      guarded,
      eventStatement,
      usageSql,
      usageBudgetCondition,
      getApi,
    }),
  };
}

import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { evolveCampaignForResume, validateCampaignRoundExtension } from '../../paper-domain/automation/campaign-evolution-policy.mjs';
import { CAMPAIGN_NODE_DONE_STATUSES, cascadeCancelledNodeIds, decideCampaignCommand, decideManualNodeRetry, selectFutureRoundNodeIds } from '../../paper-domain/automation/campaign-state-policy.mjs';
import { assertCampaignDefinition, assertCampaignDefinitionReplay, campaignDefinitionHash } from './campaign-definition-codec.mjs';
import { buildSqliteCampaignProjectionStatement } from './sqlite-campaign-projection.mjs';
import { mapCampaignNodeRow as parseNode } from './sqlite-campaign-row-mappers.mjs';
import {
  inspectAutonomousResearchCampaignExecutionAdmission,
} from '../../paper-domain/automation/autonomous-research-campaign-execution-admission.mjs';

const DONE = new Set(CAMPAIGN_NODE_DONE_STATUSES);

function campaignInitialExecutionState(spec) {
  const inspection = inspectAutonomousResearchCampaignExecutionAdmission(spec);
  if (!inspection.present) {
    return Object.freeze({
      status: 'running',
      phase: 'dispatching',
      admissionHash: null,
    });
  }
  if (!inspection.valid) {
    throw new Error('campaign_execution_admission_invalid');
  }
  return Object.freeze({
    status: 'paused',
    phase: 'admitted-not-authorized',
    admissionHash: inspection.binding.executionAdmissionHash,
  });
}

export function createCampaignLifecycleOperations({ store, clock, transaction, guarded, eventStatement, usageSql, usageBudgetCondition, readCampaignDefinitionSnapshot, getApi } = {}) {
  return {
    createCampaign(spec = {}) {
      assertCampaignDefinition(spec);
      const initialExecutionState = campaignInitialExecutionState(spec);
      const requestedDefinitionHash = campaignDefinitionHash(spec);
      const existing = readCampaignDefinitionSnapshot(spec.campaignId);
      if (existing.campaign) {
        assertCampaignDefinitionReplay(spec, existing.campaign, existing.nodes);
        return existing.campaign;
      }
      const now = clock.nowIso();
      const admitted = initialExecutionState.status === 'paused';
      const statements = [`INSERT INTO paper_campaigns(campaign_id,paper_id,status,max_rounds,spec_json,created_at,updated_at,last_resumed_at,parent_campaign_id,supersedes_campaign_id,recovery_of_campaign_id,current_phase) VALUES(${sqlText(spec.campaignId)},${sqlText(spec.paperId)},${sqlText(admitted ? 'paused' : 'queued')},${Math.max(1, Number(spec.maxRounds || 1))},${sqlJson(spec)},${sqlText(now)},${sqlText(now)},${admitted ? 'NULL' : sqlText(now)},${spec.parentCampaignId ? sqlText(spec.parentCampaignId) : 'NULL'},${spec.supersedesCampaignId ? sqlText(spec.supersedesCampaignId) : 'NULL'},${spec.recoveryOfCampaignId ? sqlText(spec.recoveryOfCampaignId) : 'NULL'},${sqlText(admitted ? initialExecutionState.phase : 'queued')});`];
      for (const node of spec.nodes) {
        statements.push(`INSERT INTO campaign_nodes(node_id,campaign_id,kind,round_index,status,priority,dependencies_json,spec_json,max_attempts,created_at,updated_at,role) VALUES(${sqlText(node.nodeId)},${sqlText(spec.campaignId)},${sqlText(node.kind)},${Number(node.roundIndex || 0)},'queued',${Number(node.priority || 100)},${sqlJson(node.dependencies || [])},${sqlJson(node)},${Math.max(1, Number(node.maxAttempts || 3))},${sqlText(now)},${sqlText(now)},${node.role ? sqlText(node.role) : 'NULL'});`);
      }
      if (!admitted) {
        statements.push(`UPDATE paper_campaigns SET status='running',current_phase='dispatching',updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(spec.campaignId)} AND status='queued';`);
      }
      statements.push(eventStatement(spec.campaignId, null, 'campaign_created', {
        nodeCount: spec.nodes.length,
        campaignDefinitionHash: requestedDefinitionHash,
        executionAdmissionHash: initialExecutionState.admissionHash,
        initialStatus: initialExecutionState.status,
      }, now).sql);
      try {
        transaction(statements, 'campaign_create_failed');
      } catch (error) {
        // Another creator may have won the campaign-id race. Re-read only
        // after the failed transaction has rolled back, and accept it solely
        // when the complete persisted campaign/DAG definition is identical.
        const raced = readCampaignDefinitionSnapshot(spec.campaignId);
        if (!raced.campaign) throw error;
        assertCampaignDefinitionReplay(spec, raced.campaign, raced.nodes);
        return raced.campaign;
      }
      return getApi().getCampaign(spec.campaignId);
    },
    skipFutureRounds({ campaignId, afterRound, reason = 'convergence_reached' } = {}) {
      const now = clock.nowIso();
      const futureNodeIds = selectFutureRoundNodeIds(getApi().listNodes(campaignId), { afterRound });
      const updateFutureNodes = futureNodeIds.length
        ? `UPDATE campaign_nodes SET status='skipped',failure_class=${sqlText(reason)},lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id IN (${futureNodeIds.map(sqlText).join(',')}) AND campaign_id=${sqlText(campaignId)} AND status='queued';`
        : '';
      transaction([
        updateFutureNodes,
        eventStatement(campaignId, null, 'campaign_future_rounds_skipped', { afterRound, reason }, now).sql,
        buildSqliteCampaignProjectionStatement({ campaignId, now }),
      ], 'campaign_future_round_skip_failed');
      return getApi().getCampaign(campaignId);
    },
    pauseCampaign(campaignId, reason = 'operator_paused') {
      const campaign = getApi().getCampaign(campaignId);
      if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
      if (!decideCampaignCommand(campaign, 'pause').apply) return campaign;
      const now = clock.nowIso();
      transaction([
        guarded(`UPDATE paper_campaigns SET status='paused',stop_reason=${sqlText(reason)},accumulated_run_ms=accumulated_run_ms+max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)),last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status='running' AND revision=${campaign.revision} AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status<>'completed' AND n.prepared_integration_status IN ('integrating','integrated'));`),
        `UPDATE campaign_nodes SET status='queued',lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status IN ('leased','running');`,
        eventStatement(campaignId, null, 'campaign_paused', { reason }, now).sql,
      ], 'campaign_pause_failed');
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
      transaction([
        guarded(`UPDATE paper_campaigns SET status='running',current_phase=CASE WHEN current_phase='admitted-not-authorized' THEN 'dispatching' ELSE current_phase END,stop_reason=NULL,last_resumed_at=${sqlText(now)},spec_json=${sqlJson(nextSpec)},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status=${sqlText(campaign.status)} AND revision=${campaign.revision};`),
        reopenSql,
        eventStatement(campaignId, null, 'campaign_resumed', detail, now).sql,
      ], 'campaign_resume_failed');
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
      statements.push(eventStatement(spec.campaignId, null, 'campaign_extended', detail, now).sql);
      transaction(statements, 'campaign_extension_failed');
      return getApi().getCampaign(spec.campaignId);
    },
    cancelCampaign(campaignId, reason = 'operator_cancelled') {
      const campaign = getApi().getCampaign(campaignId);
      if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
      if (!decideCampaignCommand(campaign, 'cancel').apply) return campaign;
      const now = clock.nowIso();
      const elapsedSql = campaign.lastResumedAt ? `accumulated_run_ms=accumulated_run_ms+max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)),` : '';
      transaction([
        guarded(`UPDATE paper_campaigns SET ${elapsedSql}status='cancelled',stop_reason=${sqlText(reason)},last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status=${sqlText(campaign.status)} AND revision=${campaign.revision} AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status<>'completed' AND n.prepared_integration_status IN ('integrating','integrated'));`),
        `UPDATE campaign_nodes SET status='skipped',failure_class=${sqlText(reason)},lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status IN ('queued','leased','running');`,
        eventStatement(campaignId, null, 'campaign_cancelled', { reason }, now).sql,
      ], 'campaign_cancel_failed');
      return getApi().getCampaign(campaignId);
    },
    cancelNode(nodeId, reason = 'operator_node_cancelled') {
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      if (!node) throw new Error(`campaign node not found: ${nodeId}`);
      if (DONE.has(node.status) || node.status === 'failed_terminal') return node;
      const nodes = getApi().listNodes(node.campaignId);
      const cancelled = new Set(cascadeCancelledNodeIds(nodes, nodeId));
      const now = clock.nowIso();
      const ids = [...cancelled].map(sqlText).join(',');
      const failureDetail = { reason, rootNodeId: nodeId };
      const failureHash = hashRecord('PaperCampaignNodeFailure', failureDetail);
      const packageNode = nodes.find((candidate) => candidate.kind === 'package');
      const campaign = getApi().getCampaign(node.campaignId);
      const statements = [
        guarded(`UPDATE paper_campaigns SET revision=revision WHERE campaign_id=${sqlText(node.campaignId)} AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.node_id IN (${ids}) AND n.status<>'completed' AND n.prepared_integration_status IN ('integrating','integrated'));`),
        `UPDATE campaign_nodes SET status='skipped',failure_class=${sqlText(reason)},failure_json=${sqlJson(failureDetail)},failure_sha256=${sqlText(failureHash)},lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id IN (${ids}) AND status IN ('queued','leased','running');`,
        eventStatement(node.campaignId, nodeId, 'campaign_node_cancelled', { reason, skippedNodeIds: [...cancelled].sort() }, now).sql,
      ];
      if (packageNode && cancelled.has(packageNode.nodeId) && campaign?.status === 'running') {
        statements.push(guarded(`UPDATE paper_campaigns SET status='stopped',stop_reason='operator_node_cancelled_required_path',accumulated_run_ms=accumulated_run_ms+CASE WHEN last_resumed_at IS NULL THEN 0 ELSE max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)) END,last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(node.campaignId)} AND status='running' AND revision=${campaign.revision};`));
        statements.push(eventStatement(node.campaignId, null, 'campaign_stopped', { reason: 'operator_node_cancelled_required_path' }, now).sql);
      } else {
        statements.push(buildSqliteCampaignProjectionStatement({ campaignId: node.campaignId, now }));
      }
      transaction(statements, 'campaign_node_cancel_failed');
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
    retryNode(nodeId) {
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      if (!node) throw new Error(`campaign node not found: ${nodeId}`);
      if (!decideManualNodeRetry(node).apply) return node;
      const now = clock.nowIso();
      const campaign = getApi().getCampaign(node.campaignId);
      transaction([
        guarded(`UPDATE campaign_nodes SET status='queued',attempt_count=0,failure_class=NULL,failure_json=NULL,failure_sha256=NULL,lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,prepared_result_json=CASE WHEN prepared_integration_status='integrated' THEN prepared_result_json ELSE NULL END,prepared_result_sha256=CASE WHEN prepared_integration_status='integrated' THEN prepared_result_sha256 ELSE NULL END,prepared_attempt_id=CASE WHEN prepared_integration_status='integrated' THEN prepared_attempt_id ELSE NULL END,prepared_at=CASE WHEN prepared_integration_status='integrated' THEN prepared_at ELSE NULL END,prepared_requires_integration=CASE WHEN prepared_integration_status='integrated' THEN prepared_requires_integration ELSE 0 END,prepared_integration_key=CASE WHEN prepared_integration_status='integrated' THEN prepared_integration_key ELSE NULL END,prepared_integration_status=CASE WHEN prepared_integration_status='integrated' THEN 'integrated' ELSE 'none' END,prepared_integration_started_at=CASE WHEN prepared_integration_status='integrated' THEN prepared_integration_started_at ELSE NULL END,prepared_integration_receipt_json=CASE WHEN prepared_integration_status='integrated' THEN prepared_integration_receipt_json ELSE NULL END,prepared_integration_receipt_sha256=CASE WHEN prepared_integration_status='integrated' THEN prepared_integration_receipt_sha256 ELSE NULL END,prepared_integrated_at=CASE WHEN prepared_integration_status='integrated' THEN prepared_integrated_at ELSE NULL END,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='failed_terminal' AND node_revision=${node.nodeRevision};`),
        guarded(`UPDATE paper_campaigns SET status='running',current_phase=${sqlText(node.kind)},current_review_round=max(current_review_round,${Math.max(0, Number(node.roundIndex || 0))}),stop_reason=NULL,last_resumed_at=coalesce(last_resumed_at,${sqlText(now)}),revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(node.campaignId)} AND status=${sqlText(campaign.status)} AND revision=${campaign.revision};`),
        eventStatement(node.campaignId, nodeId, 'campaign_node_manually_retried', {}, now).sql,
      ], 'campaign_node_retry_failed');
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
    recordUsage(campaignId, delta = {}, { enforceBudget = false } = {}) {
      const now = clock.nowIso();
      if (enforceBudget) {
        try {
          transaction([
            guarded(`UPDATE paper_campaigns SET ${usageSql(delta)},updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status='running' AND ${usageBudgetCondition(delta)};`),
          ], 'campaign_usage_budget_reservation_failed');
        } catch {
          throw new Error('campaign_usage_budget_reservation_failed');
        }
        return getApi().getCampaign(campaignId);
      }
      const write = store.execute(`UPDATE paper_campaigns SET ${usageSql(delta)},updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status='running';`);
      if (!write.ok) throw new Error(write.error || 'campaign_usage_write_failed');
      return getApi().getCampaign(campaignId);
    },
    failCampaign(campaignId, reason = 'campaign_failed') {
      const campaign = getApi().getCampaign(campaignId);
      if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
      if (!decideCampaignCommand(campaign, 'fail').apply) return campaign;
      const now = clock.nowIso();
      const elapsedSql = campaign.lastResumedAt ? `accumulated_run_ms=accumulated_run_ms+max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)),` : '';
      transaction([
        guarded(`UPDATE paper_campaigns SET ${elapsedSql}status='failed',stop_reason=${sqlText(reason)},last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status=${sqlText(campaign.status)} AND revision=${campaign.revision} AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status<>'completed' AND n.prepared_integration_status IN ('integrating','integrated'));`),
        `UPDATE campaign_nodes SET status='failed_terminal',failure_class=${sqlText(reason)},lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status IN ('queued','leased','running');`,
        eventStatement(campaignId, null, 'campaign_failed', { reason }, now).sql,
      ], 'campaign_fail_failed');
      return getApi().getCampaign(campaignId);
    },
    stopCampaign(campaignId, reason = 'campaign_stopped') {
      const campaign = getApi().getCampaign(campaignId);
      if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
      if (!decideCampaignCommand(campaign, 'stop').apply) return campaign;
      const now = clock.nowIso();
      const elapsedSql = campaign.lastResumedAt ? `accumulated_run_ms=accumulated_run_ms+max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)),` : '';
      transaction([
        guarded(`UPDATE paper_campaigns SET ${elapsedSql}status='stopped',stop_reason=${sqlText(reason)},last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status=${sqlText(campaign.status)} AND revision=${campaign.revision} AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status<>'completed' AND n.prepared_integration_status IN ('integrating','integrated'));`),
        `UPDATE campaign_nodes SET status='skipped',failure_class=${sqlText(reason)},lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status IN ('queued','leased','running');`,
        eventStatement(campaignId, null, 'campaign_stopped', { reason }, now).sql,
      ], 'campaign_stop_failed');
      return getApi().getCampaign(campaignId);
    },
  };
}

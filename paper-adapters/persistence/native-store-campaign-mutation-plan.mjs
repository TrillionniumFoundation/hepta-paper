import {
  compileExternallyFencedSqliteMutationOperation as operation,
  defineExternallyFencedSqliteMutationStatement as statement,
  externallyFencedSqliteWriterPlanHash,
} from '../automation/externally-fenced-sqlite-mutation-plan.mjs';
import {
  assertNativeStoreCampaignMutationChanged,
  nativeStoreCampaignEventParameters,
  nativeStoreCampaignProjectionParameters,
  nativeStoreCampaignUsageParameters,
} from './native-store-campaign-parameter-projection.mjs';
export {
  assertNativeStoreNodeInfrastructureReservation,
  buildNativeStoreNodeInfrastructureReservation,
  normalizeNativeStoreNodeInfrastructureUsage,
} from './native-store-campaign-infrastructure-reservation.mjs';

export {
  assertNativeStoreCampaignMutationChanged,
  nativeStoreCampaignEventParameters,
  nativeStoreCampaignProjectionParameters,
  nativeStoreCampaignUsageParameters,
};
export const NATIVE_STORE_CAMPAIGN_WRITER_ID =
  'writer:native-store:campaign-persistence:v1';

export const NATIVE_STORE_CAMPAIGN_OPERATION_IDS = Object.freeze({
  assertLiveNodeAttempt: 'native-store.campaign-store.assertLiveNodeAttempt.v1',
  beginNodeResultIntegration:
    'native-store.campaign-prepared-integration.beginNodeResultIntegration.v1',
  cancelCampaign: 'native-store.campaign-lifecycle.cancelCampaign.v1',
  cancelNode: 'native-store.campaign-lifecycle.cancelNode.v1',
  cancelNodeInfrastructureDeferred:
    'native-store.campaign-lease.cancelNodeInfrastructureDeferred.v1',
  claimReady: 'native-store.campaign-lease.claimReady.v1',
  completeNodeExternalAction:
    'native-store.campaign-lease.completeNodeExternalAction.v1',
  completeNode: 'native-store.campaign-prepared-integration.completeNode.v1',
  createCampaign: 'native-store.campaign-lifecycle.createCampaign.v1',
  extendCampaign: 'native-store.campaign-lifecycle.extendCampaign.v1',
  failCampaign: 'native-store.campaign-lifecycle.failCampaign.v1',
  failNode: 'native-store.campaign-lease.failNode.v1',
  markNodeResultIntegrated:
    'native-store.campaign-prepared-integration.markNodeResultIntegrated.v1',
  markNodeExternalActionStarted:
    'native-store.campaign-lease.markNodeExternalActionStarted.v1',
  pauseCampaign: 'native-store.campaign-lifecycle.pauseCampaign.v1',
  prepareNodeResult:
    'native-store.campaign-prepared-integration.prepareNodeResult.v1',
  recordUsage: 'native-store.campaign-lifecycle.recordUsage.v1',
  reserveNodeInfrastructureUsage:
    'native-store.campaign-lease.reserveNodeInfrastructureUsage.v1',
  recoverExpiredLeases: 'native-store.campaign-lease.recoverExpiredLeases.v1',
  renewNodeLease: 'native-store.campaign-lease.renewNodeLease.v1',
  resumeCampaign: 'native-store.campaign-lifecycle.resumeCampaign.v1',
  retryNode: 'native-store.campaign-lifecycle.retryNode.v1',
  skipFutureRounds: 'native-store.campaign-lifecycle.skipFutureRounds.v1',
  startNode: 'native-store.campaign-lease.startNode.v1',
  stopCampaign: 'native-store.campaign-lifecycle.stopCampaign.v1',
});

export const NATIVE_STORE_CAMPAIGN_STATEMENT_IDS = Object.freeze({
  assertIntegratedAttempt: 'campaign.attempt.assert-integrated.v1',
  assertIntegratingAttempt: 'campaign.attempt.assert-integrating.v1',
  beginIntegrationNode: 'campaign.integration.begin-node.v1',
  cancelCampaign: 'campaign.lifecycle.cancel-campaign.v1',
  cancelCampaignNodes: 'campaign.lifecycle.cancel-campaign-nodes.v1',
  cancelNodeGuard: 'campaign.lifecycle.cancel-node-guard.v1',
  cancelNodeInspect: 'campaign.lifecycle.cancel-node-inspect.v1',
  cancelNodeProjection: 'campaign.lifecycle.cancel-node-projection.v1',
  cancelNodeStopCampaign: 'campaign.lifecycle.cancel-node-stop-campaign.v1',
  cancelOneNode: 'campaign.lifecycle.cancel-one-node.v1',
  cancelInfrastructureNode: 'campaign.lease.cancel-infrastructure-node.v1',
  cancelInfrastructureUsage: 'campaign.lease.cancel-infrastructure-usage.v1',
  infrastructureReservationEvents:
    'campaign.lease.infrastructure-reservation-events.v1',
  externalActionEvents: 'campaign.lease.external-action-events.v1',
  markInfrastructureStartedNode:
    'campaign.lease.mark-infrastructure-started-node.v1',
  markInfrastructureCompletedNode:
    'campaign.lease.mark-infrastructure-completed-node.v1',
  reserveInfrastructureNode:
    'campaign.lease.reserve-infrastructure-node.v1',
  reserveInfrastructureUsage:
    'campaign.lease.reserve-infrastructure-usage.v1',
  claimNode: 'campaign.lease.claim-node.v1',
  completeNode: 'campaign.integration.complete-node.v1',
  createCampaignPaper: 'campaign.lifecycle.create-paper.v1',
  createCampaign: 'campaign.lifecycle.create-campaign.v1',
  createCampaignNode: 'campaign.lifecycle.create-node.v1',
  createCampaignStart: 'campaign.lifecycle.create-start.v1',
  eventInsert: 'campaign.event.insert.v1',
  extendCampaign: 'campaign.lifecycle.extend-campaign.v1',
  extendCampaignNode: 'campaign.lifecycle.extend-node.v1',
  extendSupersedePackage: 'campaign.lifecycle.extend-supersede-package.v1',
  failCampaign: 'campaign.lifecycle.fail-campaign.v1',
  failCampaignNodes: 'campaign.lifecycle.fail-campaign-nodes.v1',
  failNodeAbandonPrepared: 'campaign.lease.fail-node-abandon-prepared.v1',
  failNodePreservePrepared: 'campaign.lease.fail-node-preserve-prepared.v1',
  inspectTerminalSiblingNodes:
    'campaign.lease.inspect-terminal-sibling-nodes.v1',
  settleTerminalSiblingNodes:
    'campaign.lease.settle-terminal-sibling-nodes.v1',
  markIntegratedNode: 'campaign.integration.mark-integrated-node.v1',
  pauseCampaign: 'campaign.lifecycle.pause-campaign.v1',
  pauseCampaignNodes: 'campaign.lifecycle.pause-campaign-nodes.v1',
  prepareNode: 'campaign.integration.prepare-node.v1',
  projectCampaign: 'campaign.projection.update.v1',
  publishCurrentRelease: 'campaign.release.publish-current.v1',
  recordUsage: 'campaign.lifecycle.record-usage.v1',
  recoverLease: 'campaign.lease.recover-node.v1',
  recoverLeaseUncertain: 'campaign.lease.recover-node-uncertain.v1',
  recoverLeaseUsage: 'campaign.lease.recover-node-usage.v1',
  renewLease: 'campaign.lease.renew-node.v1',
  resumeCampaign: 'campaign.lifecycle.resume-campaign.v1',
  resumeNodes: 'campaign.lifecycle.resume-nodes.v1',
  retryCampaign: 'campaign.lifecycle.retry-campaign.v1',
  retryNode: 'campaign.lifecycle.retry-node.v1',
  skipFutureNode: 'campaign.lifecycle.skip-future-node.v1',
  startNode: 'campaign.lease.start-node.v1',
  startNodeCampaign: 'campaign.lease.start-node-campaign.v1',
  stopCampaign: 'campaign.lifecycle.stop-campaign.v1',
  stopCampaignNodes: 'campaign.lifecycle.stop-campaign-nodes.v1',
  updateCampaignUsage: 'campaign.usage.update.v1',
});

const S = NATIVE_STORE_CAMPAIGN_STATEMENT_IDS;

const EVENT_INSERT_SQL = `INSERT INTO campaign_events(
  event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at
) VALUES(?,?,?,?,?,?,?)`;

const PROJECTION_SQL = `UPDATE paper_campaigns SET
  accumulated_run_ms=accumulated_run_ms+iif((
    EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status='failed_terminal')
    OR (EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id)
      AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status NOT IN ('completed','skipped')))
  ) AND last_resumed_at IS NOT NULL,
    max(0,CAST((julianday(?)-julianday(last_resumed_at))*86400000 AS INTEGER)),0),
  last_resumed_at=iif((
    EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status='failed_terminal')
    OR (EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id)
      AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status NOT IN ('completed','skipped')))
  ),NULL,last_resumed_at),
  status=iif(
    EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status='failed_terminal'),'failed',
    iif(EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id)
      AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status NOT IN ('completed','skipped')),
      'completed','running')),
  current_round=coalesce((SELECT max(n.round_index) FROM campaign_nodes n
    WHERE n.campaign_id=paper_campaigns.campaign_id AND n.round_index>0
      AND n.kind NOT IN (?,?)
      AND n.status IN ('leased','running','completed','failed_terminal')),0),
  current_review_round=coalesce((SELECT max(n.round_index) FROM campaign_nodes n
    WHERE n.campaign_id=paper_campaigns.campaign_id AND n.round_index>0
      AND n.kind NOT IN (?,?)
      AND n.status IN ('leased','running','completed','failed_terminal')),0),
  current_phase=iif(
    EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status='failed_terminal'),'failed',
    iif(EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id)
      AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status NOT IN ('completed','skipped')),
      'completed',coalesce(
      (SELECT n.kind FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id
        AND n.status IN ('running','leased') ORDER BY n.priority,n.created_at,n.node_id LIMIT 1),
      (SELECT n.kind FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id
        AND n.status NOT IN ('completed','skipped','failed_terminal') ORDER BY n.priority,n.created_at,n.node_id LIMIT 1),
      'running'))),
  revision=revision+1,updated_at=?
WHERE campaign_id=? AND status='running'`;

const USAGE_SET = `agent_call_count=agent_call_count+?,
  cpu_job_count=cpu_job_count+?,gpu_job_count=gpu_job_count+?,
  token_count=token_count+?,cost_usd=cost_usd+?,
  priced_agent_call_count=priced_agent_call_count+?,
  cost_known=iif(agent_call_count+?=priced_agent_call_count+?,1,0)`;

const USAGE_BUDGET = `agent_call_count+?<=coalesce(json_extract(spec_json,'$.budgets.maxAgentCalls'),9e15)
  AND cpu_job_count+?<=coalesce(json_extract(spec_json,'$.budgets.maxCpuJobs'),9e15)
  AND gpu_job_count+?<=coalesce(json_extract(spec_json,'$.budgets.maxGpuJobs'),9e15)
  AND token_count+?<=coalesce(json_extract(spec_json,'$.budgets.maxTokenCount'),9e15)
  AND (?=0 OR cost_usd+?<=coalesce(json_extract(spec_json,'$.budgets.maxCostUsd'),9e15))`;

const event = () => statement(S.eventInsert, EVENT_INSERT_SQL);
const projection = () => statement(S.projectCampaign, PROJECTION_SQL);

const plans = [
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.assertLiveNodeAttempt, [
    statement(S.assertIntegratedAttempt, `UPDATE campaign_nodes SET node_revision=node_revision
      WHERE node_id=? AND status='running' AND lease_owner=? AND attempt_id=?
        AND lease_generation=? AND julianday(lease_expires_at)>=julianday(?)
        AND prepared_requires_integration=1 AND prepared_integration_status='integrated'
        AND prepared_integration_key=? AND prepared_integration_receipt_sha256=?
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
    statement(S.assertIntegratingAttempt, `UPDATE campaign_nodes SET node_revision=node_revision
      WHERE node_id=? AND status='running' AND lease_owner=? AND attempt_id=?
        AND lease_generation=? AND julianday(lease_expires_at)>=julianday(?)
        AND prepared_requires_integration=1
        AND prepared_integration_status IN ('integrating','integrated')
        AND prepared_integration_key=? AND prepared_result_sha256 IS NOT NULL
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.createCampaign, [
    statement(S.createCampaignPaper, `INSERT OR IGNORE INTO papers(
      slug,title,status,venue_target,paper_type,canonical_dir,source_dir,
      submission_dir,metadata_json,created_at,updated_at
    ) VALUES(?,?,'draft',?,'campaign',?,?,'submission',?,?,?)`),
    statement(S.createCampaign, `INSERT INTO paper_campaigns(
      campaign_id,paper_id,status,max_rounds,spec_json,created_at,updated_at,
      last_resumed_at,parent_campaign_id,supersedes_campaign_id,recovery_of_campaign_id,current_phase
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`),
    statement(S.createCampaignNode, `INSERT INTO campaign_nodes(
      node_id,campaign_id,kind,round_index,status,priority,dependencies_json,
      spec_json,max_attempts,created_at,updated_at,role
    ) VALUES(?,?,?,?,'queued',?,?,?,?,?,?,?)`),
    statement(S.createCampaignStart, `UPDATE paper_campaigns SET
      status='running',current_phase='dispatching',updated_at=?
      WHERE campaign_id=? AND status='queued'`),
    event(),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.cancelNodeInfrastructureDeferred, [
    event(),
    statement(S.infrastructureReservationEvents, `SELECT event_json,event_sha256
      FROM campaign_events WHERE campaign_id=? AND node_id=?
        AND kind IN ('campaign_node_started',
          'campaign_node_infrastructure_subreservation',
          'campaign_node_external_action_started')
        AND json_extract(event_json,'$.detail.attemptId')=?
        AND CAST(json_extract(event_json,'$.detail.leaseGeneration') AS INTEGER)=?
      ORDER BY created_at,event_id`, 'all'),
    statement(S.cancelInfrastructureNode, `UPDATE campaign_nodes SET
      status='queued',attempt_count=attempt_count-1,lease_owner=NULL,
      lease_expires_at=NULL,attempt_id=NULL,failure_class=NULL,failure_json=NULL,
      failure_sha256=NULL,node_revision=node_revision+1,updated_at=?
      WHERE node_id=? AND status='running' AND lease_owner=? AND attempt_id=?
        AND lease_generation=? AND attempt_count=? AND attempt_count>0
        AND prepared_result_sha256 IS NULL
        AND NOT EXISTS(SELECT 1 FROM campaign_events e
          WHERE e.campaign_id=campaign_nodes.campaign_id
            AND e.node_id=campaign_nodes.node_id
            AND e.kind='campaign_node_external_action_started'
            AND json_extract(e.event_json,'$.detail.attemptId')=campaign_nodes.attempt_id
            AND CAST(json_extract(e.event_json,'$.detail.leaseGeneration') AS INTEGER)=campaign_nodes.lease_generation)
        AND julianday(lease_expires_at)>=julianday(?)
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
    statement(S.cancelInfrastructureUsage, `UPDATE paper_campaigns SET
      agent_call_count=agent_call_count-?,
      cpu_job_count=cpu_job_count-?,
      gpu_job_count=gpu_job_count-?,revision=revision+1,updated_at=?
      WHERE campaign_id=? AND status='running'
        AND agent_call_count>=? AND cpu_job_count>=? AND gpu_job_count>=?`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.reserveNodeInfrastructureUsage, [
    event(),
    statement(S.reserveInfrastructureNode, `UPDATE campaign_nodes SET
      node_revision=node_revision WHERE node_id=? AND status='running'
        AND lease_owner=? AND attempt_id=? AND lease_generation=?
        AND prepared_result_sha256 IS NULL
        AND julianday(lease_expires_at)>=julianday(?)
        AND NOT EXISTS(SELECT 1 FROM campaign_events e
          WHERE e.campaign_id=campaign_nodes.campaign_id
            AND e.node_id=campaign_nodes.node_id
            AND e.kind='campaign_node_external_action_started'
            AND json_extract(e.event_json,'$.detail.attemptId')=campaign_nodes.attempt_id
            AND CAST(json_extract(e.event_json,'$.detail.leaseGeneration') AS INTEGER)=campaign_nodes.lease_generation)
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
    statement(S.reserveInfrastructureUsage, `UPDATE paper_campaigns SET
      ${USAGE_SET},revision=revision+1,updated_at=?
      WHERE campaign_id=? AND status='running' AND ${USAGE_BUDGET}`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.markNodeExternalActionStarted, [
    event(),
    statement(S.externalActionEvents, `SELECT event_json,event_sha256
      FROM campaign_events WHERE campaign_id=? AND node_id=?
        AND kind IN ('campaign_node_external_action_started',
          'campaign_node_external_action_completed')
        AND json_extract(event_json,'$.detail.externalActionId')=?
      ORDER BY created_at,event_id`, 'all'),
    statement(S.markInfrastructureStartedNode, `UPDATE campaign_nodes SET
      node_revision=node_revision+1 WHERE node_id=? AND status='running'
        AND lease_owner=? AND attempt_id=? AND lease_generation=?
        AND node_revision=?
        AND julianday(lease_expires_at)>=julianday(?)
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.completeNodeExternalAction, [
    event(),
    statement(S.externalActionEvents, `SELECT event_json,event_sha256
      FROM campaign_events WHERE campaign_id=? AND node_id=?
        AND kind IN ('campaign_node_external_action_started',
          'campaign_node_external_action_completed')
        AND json_extract(event_json,'$.detail.externalActionId')=?
      ORDER BY created_at,event_id`, 'all'),
    statement(S.markInfrastructureCompletedNode, `UPDATE campaign_nodes SET
      node_revision=node_revision+1 WHERE node_id=? AND status='running'
        AND lease_owner=? AND attempt_id=? AND lease_generation=?
        AND node_revision=?
        AND julianday(lease_expires_at)>=julianday(?)
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
    statement(S.updateCampaignUsage, `UPDATE paper_campaigns SET
      ${USAGE_SET},updated_at=? WHERE campaign_id=? AND status='running'`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.skipFutureRounds, [
    event(), projection(),
    statement(S.skipFutureNode, `UPDATE campaign_nodes SET status='skipped',failure_class=?,
      lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,
      node_revision=node_revision+1,updated_at=?
      WHERE node_id=? AND campaign_id=? AND status='queued'`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.pauseCampaign, [
    event(),
    statement(S.pauseCampaign, `UPDATE paper_campaigns SET status='paused',stop_reason=?,
      accumulated_run_ms=accumulated_run_ms+max(0,CAST((julianday(?)-julianday(last_resumed_at))*86400000 AS INTEGER)),
      last_resumed_at=NULL,revision=revision+1,updated_at=?
      WHERE campaign_id=? AND status='running' AND revision=?
        AND NOT EXISTS(SELECT 1 FROM campaign_nodes n
          WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status<>'completed'
            AND n.prepared_integration_status IN ('integrating','integrated'))`),
    statement(S.pauseCampaignNodes, `UPDATE campaign_nodes SET status='queued',
      lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,
      node_revision=node_revision+1,updated_at=?
      WHERE campaign_id=? AND status IN ('leased','running')`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.resumeCampaign, [
    event(),
    statement(S.resumeCampaign, `UPDATE paper_campaigns SET status='running',
      current_phase=iif(current_phase='admitted-not-authorized','dispatching',current_phase),
      stop_reason=NULL,last_resumed_at=?,spec_json=?,revision=revision+1,updated_at=?
      WHERE campaign_id=? AND status=? AND revision=?`),
    statement(S.resumeNodes, `UPDATE campaign_nodes SET status='queued',failure_class=NULL,
      failure_json=NULL,failure_sha256=NULL,lease_owner=NULL,lease_expires_at=NULL,
      attempt_id=NULL,node_revision=node_revision+1,updated_at=?
      WHERE campaign_id=? AND status='skipped' AND failure_class=?`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.extendCampaign, [
    event(),
    statement(S.extendCampaign, `UPDATE paper_campaigns SET status='running',stop_reason=NULL,
      max_rounds=?,spec_json=?,last_resumed_at=?,revision=revision+1,updated_at=?
      WHERE campaign_id=? AND status=? AND revision=?`),
    statement(S.extendCampaignNode, `INSERT INTO campaign_nodes(
      node_id,campaign_id,kind,round_index,status,priority,dependencies_json,
      spec_json,max_attempts,created_at,updated_at
    ) VALUES(?,?,?,?,'queued',?,?,?,?,?,?)`),
    statement(S.extendSupersedePackage, `UPDATE campaign_nodes SET
      failure_class='campaign_round_extension_superseded',updated_at=?
      WHERE campaign_id=? AND kind='package' AND status='skipped'
        AND failure_class='referee_convergence_not_reached_within_budget'`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.cancelCampaign, [
    event(),
    statement(S.cancelCampaign, `UPDATE paper_campaigns SET
      accumulated_run_ms=accumulated_run_ms+iif(?=1,
        max(0,CAST((julianday(?)-julianday(last_resumed_at))*86400000 AS INTEGER)),0),
      status='cancelled',stop_reason=?,last_resumed_at=NULL,revision=revision+1,updated_at=?
      WHERE campaign_id=? AND status=? AND revision=?
        AND NOT EXISTS(SELECT 1 FROM campaign_nodes n
          WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status<>'completed'
            AND n.prepared_integration_status IN ('integrating','integrated'))`),
    statement(S.cancelCampaignNodes, `UPDATE campaign_nodes SET status='skipped',
      failure_class=?,lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,
      node_revision=node_revision+1,updated_at=?
      WHERE campaign_id=? AND status IN ('queued','leased','running')`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.cancelNode, [
    event(),
    statement(S.cancelNodeGuard, `UPDATE paper_campaigns SET revision=revision
      WHERE campaign_id=?`),
    statement(S.cancelNodeInspect, `SELECT status,prepared_integration_status
      FROM campaign_nodes WHERE node_id=? AND campaign_id=?`, 'get'),
    projection(),
    statement(S.cancelNodeStopCampaign, `UPDATE paper_campaigns SET status='stopped',
      stop_reason='operator_node_cancelled_required_path',
      accumulated_run_ms=accumulated_run_ms+iif(last_resumed_at IS NULL,0,
        max(0,CAST((julianday(?)-julianday(last_resumed_at))*86400000 AS INTEGER))),
      last_resumed_at=NULL,revision=revision+1,updated_at=?
      WHERE campaign_id=? AND status='running' AND revision=?`),
    statement(S.cancelOneNode, `UPDATE campaign_nodes SET status='skipped',failure_class=?,
      failure_json=?,failure_sha256=?,lease_owner=NULL,lease_expires_at=NULL,
      attempt_id=NULL,node_revision=node_revision+1,updated_at=?
      WHERE node_id=? AND status IN ('queued','leased','running')`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.retryNode, [
    event(),
    statement(S.retryCampaign, `UPDATE paper_campaigns SET status='running',current_phase=?,
      current_review_round=max(current_review_round,?),stop_reason=NULL,
      last_resumed_at=coalesce(last_resumed_at,?),revision=revision+1,updated_at=?
      WHERE campaign_id=? AND status=? AND revision=?`),
    statement(S.retryNode, `UPDATE campaign_nodes SET status='queued',attempt_count=0,
      failure_class=NULL,failure_json=NULL,failure_sha256=NULL,lease_owner=NULL,
      lease_expires_at=NULL,attempt_id=NULL,
      prepared_result_json=iif(prepared_integration_status='integrated',prepared_result_json,NULL),
      prepared_result_sha256=iif(prepared_integration_status='integrated',prepared_result_sha256,NULL),
      prepared_attempt_id=iif(prepared_integration_status='integrated',prepared_attempt_id,NULL),
      prepared_at=iif(prepared_integration_status='integrated',prepared_at,NULL),
      prepared_requires_integration=iif(prepared_integration_status='integrated',prepared_requires_integration,0),
      prepared_integration_key=iif(prepared_integration_status='integrated',prepared_integration_key,NULL),
      prepared_integration_status=iif(prepared_integration_status='integrated','integrated','none'),
      prepared_integration_started_at=iif(prepared_integration_status='integrated',prepared_integration_started_at,NULL),
      prepared_integration_receipt_json=iif(prepared_integration_status='integrated',prepared_integration_receipt_json,NULL),
      prepared_integration_receipt_sha256=iif(prepared_integration_status='integrated',prepared_integration_receipt_sha256,NULL),
      prepared_integrated_at=iif(prepared_integration_status='integrated',prepared_integrated_at,NULL),
      node_revision=node_revision+1,updated_at=?
      WHERE node_id=? AND status='failed_terminal' AND node_revision=?`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.recordUsage, [
    statement(S.recordUsage, `UPDATE paper_campaigns SET ${USAGE_SET},updated_at=?
      WHERE campaign_id=? AND status='running'
        AND (?=0 OR (${USAGE_BUDGET}))`),
  ]),
  ...['failCampaign', 'stopCampaign'].map((key) => operation(
    NATIVE_STORE_CAMPAIGN_OPERATION_IDS[key],
    [event(), statement(S[`${key}Nodes`], `UPDATE campaign_nodes SET
      status=${key === 'failCampaign' ? "'failed_terminal'" : "'skipped'"},failure_class=?,
      lease_owner=NULL,lease_expires_at=NULL,attempt_id=NULL,
      node_revision=node_revision+1,updated_at=?
      WHERE campaign_id=? AND status IN ('queued','leased','running')`),
    statement(S[key], `UPDATE paper_campaigns SET
      accumulated_run_ms=accumulated_run_ms+iif(?=1,
        max(0,CAST((julianday(?)-julianday(last_resumed_at))*86400000 AS INTEGER)),0),
      status=${key === 'failCampaign' ? "'failed'" : "'stopped'"},stop_reason=?,
      last_resumed_at=NULL,revision=revision+1,updated_at=?
      WHERE campaign_id=? AND status=? AND revision=?
        AND NOT EXISTS(SELECT 1 FROM campaign_nodes n
          WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status<>'completed'
            AND n.prepared_integration_status IN ('integrating','integrated'))`)],
  )),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.recoverExpiredLeases, [
    event(),
    statement(S.infrastructureReservationEvents, `SELECT event_json,event_sha256
      FROM campaign_events WHERE campaign_id=? AND node_id=?
        AND kind IN ('campaign_node_started',
          'campaign_node_infrastructure_subreservation',
          'campaign_node_external_action_started',
          'campaign_node_external_action_completed')
        AND json_extract(event_json,'$.detail.attemptId')=?
        AND CAST(json_extract(event_json,'$.detail.leaseGeneration') AS INTEGER)=?
      ORDER BY created_at,event_id`, 'all'),
    statement(S.recoverLease, `UPDATE campaign_nodes SET status='queued',
      attempt_count=attempt_count-?,lease_owner=NULL,
      lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,
      failure_class='lease_expired_recovered',
      prepared_integration_status=iif(prepared_integration_status='integrating','pending',prepared_integration_status),
      prepared_integration_started_at=iif(prepared_integration_status='integrating',NULL,prepared_integration_started_at),updated_at=?
      WHERE node_id=? AND campaign_id=? AND status=? AND lease_owner=?
        AND ((? IS NULL AND attempt_id IS NULL) OR attempt_id=?) AND lease_generation=?
        AND attempt_count>=?
        AND ((?=1 AND lease_expires_at IS NOT NULL AND julianday(lease_expires_at)<julianday(?))
          OR (?=0 AND lease_owner=?))
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=? AND c.status='running')`),
    statement(S.recoverLeaseUncertain, `UPDATE campaign_nodes SET
      status='external_outcome_uncertain',lease_owner=NULL,lease_expires_at=NULL,
      failure_class='external_outcome_uncertain',failure_json=?,failure_sha256=?,
      node_revision=node_revision+1,updated_at=?
      WHERE node_id=? AND campaign_id=? AND status='running' AND lease_owner=?
        AND attempt_id=? AND lease_generation=? AND prepared_result_sha256 IS NULL
        AND ((?=1 AND lease_expires_at IS NOT NULL AND julianday(lease_expires_at)<julianday(?))
          OR (?=0 AND lease_owner=?))
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=? AND c.status='running')`),
    statement(S.recoverLeaseUsage, `UPDATE paper_campaigns SET
      agent_call_count=agent_call_count-?,cpu_job_count=cpu_job_count-?,
      gpu_job_count=gpu_job_count-?,revision=revision+1,updated_at=?
      WHERE campaign_id=? AND status='running' AND agent_call_count>=?
        AND cpu_job_count>=? AND gpu_job_count>=?`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.renewNodeLease, [
    statement(S.renewLease, `UPDATE campaign_nodes SET lease_expires_at=?,updated_at=?
      WHERE node_id=? AND status='running' AND lease_owner=? AND attempt_id=?
        AND lease_generation=? AND julianday(lease_expires_at)>=julianday(?)
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.claimReady, [
    statement(S.claimNode, `UPDATE campaign_nodes SET status='leased',lease_owner=?,
      lease_expires_at=?,attempt_id=?,lease_generation=lease_generation+1,
      node_revision=node_revision+1,updated_at=?
      WHERE node_id=? AND campaign_id=? AND status='queued' AND node_revision=?
        AND EXISTS(SELECT 1 FROM paper_campaigns c WHERE c.campaign_id=? AND c.status='running')
        AND NOT EXISTS(SELECT 1 FROM json_each(campaign_nodes.dependencies_json) d
          LEFT JOIN campaign_nodes dependency ON dependency.node_id=d.value
          WHERE dependency.status NOT IN ('completed','skipped') OR dependency.node_id IS NULL)`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.startNode, [
    event(),
    statement(S.startNode, `UPDATE campaign_nodes SET status='running',
      attempt_count=attempt_count+1,node_revision=node_revision+1,updated_at=?
      WHERE node_id=? AND status='leased' AND lease_owner=? AND attempt_id=?
        AND lease_generation=? AND julianday(lease_expires_at)>=julianday(?)
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
    statement(S.startNodeCampaign, `UPDATE paper_campaigns SET current_phase=?,
      current_review_round=max(current_review_round,?),${USAGE_SET},
      revision=revision+1,updated_at=?
      WHERE campaign_id=? AND status='running' AND ${USAGE_BUDGET}`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.failNode, [
    event(), projection(),
    statement(S.failNodeAbandonPrepared, `UPDATE campaign_nodes SET status=?,failure_class=?,
      failure_json=?,failure_sha256=?,lease_owner=NULL,lease_expires_at=NULL,
      node_revision=node_revision+1,prepared_result_json=NULL,prepared_result_sha256=NULL,
      prepared_attempt_id=NULL,prepared_at=NULL,prepared_requires_integration=0,
      prepared_integration_key=NULL,prepared_integration_status='none',
      prepared_integration_started_at=NULL,prepared_integration_receipt_json=NULL,
      prepared_integration_receipt_sha256=NULL,prepared_integrated_at=NULL,updated_at=?
      WHERE node_id=? AND status='running' AND lease_owner=? AND attempt_id=?
        AND lease_generation=? AND julianday(lease_expires_at)>=julianday(?)
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
    statement(S.failNodePreservePrepared, `UPDATE campaign_nodes SET status=?,failure_class=?,
      failure_json=?,failure_sha256=?,lease_owner=NULL,lease_expires_at=NULL,
      node_revision=node_revision+1,
      prepared_integration_status=iif(prepared_integration_status='integrating','pending',prepared_integration_status),
      prepared_integration_started_at=iif(prepared_integration_status='integrating',NULL,prepared_integration_started_at),updated_at=?
      WHERE node_id=? AND status='running' AND lease_owner=? AND attempt_id=?
        AND lease_generation=? AND julianday(lease_expires_at)>=julianday(?)
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
    statement(S.inspectTerminalSiblingNodes, `SELECT node_id,campaign_id,status,
      lease_owner,attempt_id,lease_generation,node_revision,
      prepared_integration_status
      FROM campaign_nodes WHERE campaign_id=? AND node_id<>?
        AND (status IN ('leased','running') OR (status='queued'
          AND EXISTS(SELECT 1 FROM paper_campaigns policy
            WHERE policy.campaign_id=campaign_nodes.campaign_id
              AND json_type(policy.spec_json,
                '$.terminalSiblingSettlementPolicyVersion')='integer'
              AND json_extract(policy.spec_json,
                '$.terminalSiblingSettlementPolicyVersion')=1)))
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')
      ORDER BY node_id`, 'all'),
    statement(S.settleTerminalSiblingNodes, `UPDATE campaign_nodes SET
      status=?,failure_class=?,failure_json=?,failure_sha256=?,lease_owner=NULL,
      lease_expires_at=NULL,attempt_id=NULL,node_revision=node_revision+1,updated_at=?
      WHERE node_id=? AND campaign_id=? AND status=?
        AND ((? IS NULL AND lease_owner IS NULL) OR lease_owner=?)
        AND ((? IS NULL AND attempt_id IS NULL) OR attempt_id=?)
        AND lease_generation=? AND node_revision=?
        AND prepared_integration_status=?
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')
        AND (status<>'queued' OR EXISTS(SELECT 1 FROM paper_campaigns policy
          WHERE policy.campaign_id=campaign_nodes.campaign_id
            AND json_type(policy.spec_json,
              '$.terminalSiblingSettlementPolicyVersion')='integer'
            AND json_extract(policy.spec_json,
              '$.terminalSiblingSettlementPolicyVersion')=1))`),
    statement(S.updateCampaignUsage, `UPDATE paper_campaigns SET ${USAGE_SET},updated_at=?
      WHERE campaign_id=? AND status='running'`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.prepareNodeResult, [
    event(),
    statement(S.prepareNode, `UPDATE campaign_nodes SET prepared_result_json=?,
      prepared_result_sha256=?,prepared_attempt_id=?,prepared_at=?,
      prepared_requires_integration=?,prepared_integration_key=?,
      prepared_integration_status=?,prepared_integration_started_at=NULL,
      prepared_integration_receipt_json=NULL,prepared_integration_receipt_sha256=NULL,
      prepared_integrated_at=NULL,node_revision=node_revision+1,updated_at=?
      WHERE node_id=? AND status='running' AND lease_owner=? AND attempt_id=?
        AND lease_generation=? AND julianday(lease_expires_at)>=julianday(?)
        AND prepared_result_sha256 IS NULL
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.beginNodeResultIntegration, [
    event(),
    statement(S.beginIntegrationNode, `UPDATE campaign_nodes SET
      prepared_integration_status='integrating',prepared_integration_started_at=?,
      lease_expires_at=iif(julianday(lease_expires_at)<julianday(?),?,lease_expires_at),
      node_revision=node_revision+1,updated_at=?
      WHERE node_id=? AND status='running' AND lease_owner=? AND attempt_id=?
        AND lease_generation=? AND julianday(lease_expires_at)>=julianday(?)
        AND prepared_requires_integration=1 AND prepared_integration_status='pending'
        AND prepared_integration_key=? AND prepared_result_sha256 IS NOT NULL
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.markNodeResultIntegrated, [
    event(),
    statement(S.markIntegratedNode, `UPDATE campaign_nodes SET
      prepared_integration_status='integrated',prepared_integration_receipt_json=?,
      prepared_integration_receipt_sha256=?,prepared_integrated_at=?,
      node_revision=node_revision+1,updated_at=?
      WHERE node_id=? AND status='running' AND lease_owner=? AND attempt_id=?
        AND lease_generation=? AND julianday(lease_expires_at)>=julianday(?)
        AND prepared_requires_integration=1 AND prepared_integration_status='integrating'
        AND prepared_integration_key=? AND prepared_result_sha256 IS NOT NULL
        AND prepared_integrated_at IS NULL
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
  ]),
  operation(NATIVE_STORE_CAMPAIGN_OPERATION_IDS.completeNode, [
    event(), projection(),
    statement(S.completeNode, `UPDATE campaign_nodes SET status='completed',
      result_json=prepared_result_json,result_sha256=prepared_result_sha256,
      lease_owner=NULL,lease_expires_at=NULL,failure_class=NULL,integrated_at=?,
      node_revision=node_revision+1,updated_at=?,role=coalesce(?,role),reviewer_id=?,child_session_id=?,
      review_hash=?,prompt_hash=?,resolved_model=?
      WHERE node_id=? AND status='running' AND lease_owner=? AND attempt_id=?
        AND lease_generation=? AND julianday(lease_expires_at)>=julianday(?)
        AND prepared_result_sha256=? AND (prepared_requires_integration=0 OR
          (prepared_integration_status='integrated'
            AND prepared_integration_receipt_sha256 IS NOT NULL))
        AND EXISTS(SELECT 1 FROM paper_campaigns c
          WHERE c.campaign_id=campaign_nodes.campaign_id AND c.status='running')`),
    statement(S.publishCurrentRelease, `INSERT INTO campaign_current_releases(
      campaign_id,paper_id,campaign_plan_hash,package_node_id,package_attempt_id,
      lease_generation,package_result_hash,integration_descriptor_hash,
      integration_receipt_hash,campaign_release_bundle_hash,materialization_receipt_hash,
      release_bundle_json,promotion_receipt_json,promotion_receipt_hash,
      package_node_status,campaign_status,package_completed_at,promoted_at,status
    ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'completed','completed',?,?,'current_completed_release'
      WHERE EXISTS(SELECT 1 FROM campaign_nodes n JOIN paper_campaigns c
        ON c.campaign_id=n.campaign_id WHERE n.node_id=? AND n.campaign_id=?
          AND n.kind='package' AND n.status='completed' AND n.attempt_id=?
          AND n.lease_generation=? AND n.result_sha256=?
          AND n.prepared_integration_status='integrated'
          AND n.prepared_integration_key=?
          AND n.prepared_integration_receipt_sha256=?
          AND json_extract(n.result_json,'$.campaignReleaseBundleHash')=?
          AND json_extract(n.result_json,'$.campaignReleaseBundleMaterializationReceiptHash')=?
          AND c.status='completed' AND c.paper_id=?
          AND json_extract(c.spec_json,'$.campaignPlanHash')=?)`),
    statement(S.updateCampaignUsage, `UPDATE paper_campaigns SET ${USAGE_SET},updated_at=?
      WHERE campaign_id=? AND status='running'`),
  ]),
];

export const NATIVE_STORE_CAMPAIGN_MUTATION_PLANS = Object.freeze(Object.fromEntries(
  plans.map((entry) => [entry.operationId, entry]),
));

export const NATIVE_STORE_CAMPAIGN_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: NATIVE_STORE_CAMPAIGN_WRITER_ID,
    operationPlans: plans,
  });

export function runRequiredNativeStoreCampaignStatement(
  transaction,
  statementId,
  parameters,
  code,
) {
  return assertNativeStoreCampaignMutationChanged(
    transaction.run(statementId, ...parameters),
    code,
  );
}

export function insertNativeStoreCampaignEvent(transaction, event) {
  return runRequiredNativeStoreCampaignStatement(
    transaction,
    NATIVE_STORE_CAMPAIGN_STATEMENT_IDS.eventInsert,
    nativeStoreCampaignEventParameters(event),
    'campaign_event_insert_failed',
  );
}

export function projectNativeStoreCampaign(transaction, { campaignId, now } = {}) {
  return transaction.run(
    NATIVE_STORE_CAMPAIGN_STATEMENT_IDS.projectCampaign,
    ...nativeStoreCampaignProjectionParameters({ campaignId, now }),
  );
}

export function runNativeStoreCampaignUsage(
  transaction,
  statementId,
  { campaignId, delta, now, enforceBudget = false, required = false } = {},
) {
  const parameters = nativeStoreCampaignUsageParameters(delta);
  const result = transaction.run(
    statementId,
    ...parameters.set,
    now,
    campaignId,
    ...(statementId === NATIVE_STORE_CAMPAIGN_STATEMENT_IDS.recordUsage
      ? [enforceBudget ? 1 : 0, ...parameters.budget]
      : []),
  );
  if (required) assertNativeStoreCampaignMutationChanged(
    result,
    enforceBudget
      ? 'campaign_usage_budget_reservation_failed'
      : 'campaign_usage_write_failed',
  );
  return result;
}

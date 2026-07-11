import { assertTaskFlowPort } from '../../paper-ports/task-flow-port.mjs';

export const PAPER_CAMPAIGN_TASKFLOW_CONTROLLER = 'hepta-paper/automation-campaign';

function coordinationState(snapshot) {
  return Object.freeze({
    campaignId: snapshot.campaignId,
    paperId: snapshot.paperId,
    campaignPlanHash: snapshot.campaignPlanHash,
    campaignStatus: snapshot.status,
    completedNodes: Number(snapshot.completedNodes || 0),
    totalNodes: Number(snapshot.totalNodes || 0),
    failedNodes: Number(snapshot.failedNodes || 0),
  });
}

export function startPaperCampaignTaskFlow({ taskFlow, snapshot, enabled = false, childTask = null, now = Date.now() } = {}) {
  if (!enabled) return Object.freeze({ status: 'campaign_taskflow_disabled', flowCreated: false });
  assertTaskFlowPort(taskFlow);
  if (!snapshot?.campaignId || !snapshot?.paperId || !snapshot?.campaignPlanHash) throw new Error('campaign snapshot identity is required');
  const created = taskFlow.createManaged({ controllerId: PAPER_CAMPAIGN_TASKFLOW_CONTROLLER, goal: `coordinate ${snapshot.paperId}`, currentStep: 'native_campaign_running', stateJson: coordinationState(snapshot) });
  if (!created?.flowId) throw new Error('campaign TaskFlow creation failed');
  if (childTask) {
    const linked = taskFlow.runTask({ flowId: created.flowId, runtime: childTask.runtime || 'acp', childSessionKey: childTask.childSessionKey, runId: childTask.runId, task: childTask.task, status: 'running', startedAt: now, lastEventAt: now });
    if (!linked?.created) throw new Error(linked?.reason || 'campaign child link failed');
  }
  const waiting = taskFlow.setWaiting({ flowId: created.flowId, expectedRevision: created.revision, currentStep: 'await_native_campaign_checkpoint', stateJson: coordinationState(snapshot), waitJson: { kind: 'native_campaign_checkpoint', campaignId: snapshot.campaignId } });
  if (!waiting?.applied) throw new Error(waiting?.code || 'campaign TaskFlow waiting failed');
  return Object.freeze({ status: 'campaign_taskflow_waiting', flowCreated: true, flow: waiting.flow });
}

export function advancePaperCampaignTaskFlow({ taskFlow, currentFlow, snapshot } = {}) {
  assertTaskFlowPort(taskFlow);
  const prior = currentFlow?.stateJson;
  if (!prior || prior.campaignId !== snapshot?.campaignId || prior.paperId !== snapshot?.paperId || prior.campaignPlanHash !== snapshot?.campaignPlanHash) {
    throw new Error('campaign TaskFlow identity must remain fixed');
  }
  const resumed = taskFlow.resume({ flowId: currentFlow.flowId, expectedRevision: currentFlow.revision, status: 'running', currentStep: 'revalidate_native_campaign', stateJson: coordinationState(snapshot) });
  if (!resumed?.applied) throw new Error(resumed?.code || 'campaign TaskFlow resume failed');
  if (snapshot.status === 'completed') {
    const finished = taskFlow.finish({ flowId: resumed.flow.flowId, expectedRevision: resumed.flow.revision, stateJson: coordinationState(snapshot) });
    if (!finished?.applied) throw new Error(finished?.code || 'campaign TaskFlow finish failed');
    return Object.freeze({ status: 'campaign_taskflow_finished', flow: finished.flow });
  }
  if (snapshot.status === 'failed') {
    const failed = taskFlow.fail({ flowId: resumed.flow.flowId, expectedRevision: resumed.flow.revision, stateJson: coordinationState(snapshot), error: 'native_campaign_failed' });
    if (!failed?.applied) throw new Error(failed?.code || 'campaign TaskFlow fail failed');
    return Object.freeze({ status: 'campaign_taskflow_failed', flow: failed.flow });
  }
  const waiting = taskFlow.setWaiting({ flowId: resumed.flow.flowId, expectedRevision: resumed.flow.revision, currentStep: 'await_native_campaign_checkpoint', stateJson: coordinationState(snapshot), waitJson: { kind: 'native_campaign_checkpoint', campaignId: snapshot.campaignId } });
  if (!waiting?.applied) throw new Error(waiting?.code || 'campaign TaskFlow waiting failed');
  return Object.freeze({ status: 'campaign_taskflow_waiting', flow: waiting.flow });
}

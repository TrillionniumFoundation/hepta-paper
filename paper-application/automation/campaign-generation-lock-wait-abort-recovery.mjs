import {
  cancelCampaignNodeInfrastructureReservation,
} from './campaign-node-infrastructure-control.mjs';

export function recoverCampaignGenerationLockWaitAbort({
  error,
  controllerSignal,
  supervisorSignal,
  externalActionStarted,
  campaignStore,
  campaignId,
  node,
  workerId,
  observedAtEpochMs,
} = {}) {
  if (error?.campaignGenerationLockWaitAborted !== true
    || !controllerSignal?.aborted
    || externalActionStarted) return false;
  const latestNode = campaignStore.listNodes(campaignId)
    .find((item) => item.nodeId === node.nodeId);
  const campaignStatus = campaignStore.getCampaign(campaignId)?.status;
  const leaseCurrent = latestNode?.status === 'running'
    && latestNode?.attemptId === node.attemptId
    && latestNode?.leaseGeneration === node.leaseGeneration
    && Date.parse(latestNode?.leaseExpiresAt || '') >= observedAtEpochMs;
  const controlRequeuedAttempt = ['paused', 'running'].includes(campaignStatus)
    && latestNode?.status === 'queued'
    && latestNode?.attemptId === null
    && latestNode?.leaseOwner === null
    && latestNode?.leaseGeneration === node.leaseGeneration
    && latestNode?.attemptCount === node.attemptCount;
  if ((!leaseCurrent || campaignStatus !== 'running')
    && !controlRequeuedAttempt) return true;
  error.stateRecoverabilityDeferred = true;
  cancelCampaignNodeInfrastructureReservation({
    campaignStore,
    node,
    workerId,
    error,
    externalActionStarted: false,
  });
  if (supervisorSignal?.aborted || campaignStatus !== 'running'
    || controlRequeuedAttempt) return true;
  throw error;
}

import { addAbortListener as subscribeAbort } from 'node:events';
import {
  campaignInfrastructureControlError,
} from './campaign-node-infrastructure-control.mjs';
import {
  meteredCampaignResultUsage as meteredResultUsage,
} from './campaign-execution-budget-policy.mjs';

export function abortCampaignExecution(controller, reason = 'resource_lease_lost') {
  if (!controller.signal.aborted) controller.abort(reason);
}

export function campaignExecutionAbortError(
  signal,
  fallback = 'campaign_execution_aborted',
) {
  const error = new Error(String(signal?.reason || fallback));
  error.retryable = true;
  return error;
}

export function bindCampaignResourceLeaseLoss(release, controller) {
  const lostSignal = release?.lostSignal;
  if (!lostSignal) return () => {};
  const onLost = () => abortCampaignExecution(
    controller,
    lostSignal.reason || 'resource_lease_lost',
  );
  let subscription = null;
  if (lostSignal.aborted) onLost();
  else subscription = subscribeAbort(lostSignal, onLost);
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    subscription?.[Symbol.dispose]();
    subscription = null;
  };
}

export function createCampaignNestedAgentRunner({
  campaignId,
  campaignStore,
  node,
  workerId,
  controller,
  governor,
  localGovernor,
  nodeSideEffectGate,
  externalActionStarted,
} = {}) {
  return async function runNestedAgent(operation, actionOptions = {}) {
    const nestedRequest = { agent: 1, cpu: 0, gpu: 0, memoryMiB: 0 };
    const releaseNestedGlobal = await governor.acquire(nestedRequest, {
      campaignId,
      nodeId: `${node.nodeId}:nested-agent`,
      signal: controller.signal,
    });
    let releaseNestedLocal;
    let nestedResult;
    let operationError = null;
    let localReleaseError = null;
    let globalReleaseError = null;
    let detachNestedLeaseLoss = () => {};
    try {
      detachNestedLeaseLoss = bindCampaignResourceLeaseLoss(releaseNestedGlobal, controller);
      if (controller.signal.aborted) {
        throw campaignExecutionAbortError(controller.signal, 'resource_lease_lost');
      }
      releaseNestedLocal = await localGovernor.acquire(nestedRequest, {
        signal: controller.signal,
      });
      let latestForOperation = null;
      const reserveNestedAgent = async () => {
        const latest = campaignStore.getCampaign(campaignId);
        if (latest?.status !== 'running') {
          const error = new Error(`campaign_${latest?.status || 'unavailable'}`);
          error.retryable = false;
          throw error;
        }
        if (latest.agentCallCount
          >= Number(latest.spec?.budgets?.maxAgentCalls ?? Infinity)) {
          campaignStore.stopCampaign(campaignId, 'campaign_agent_call_budget_exhausted');
          const error = new Error('campaign_agent_call_budget_exhausted');
          error.retryable = false;
          throw error;
        }
        if (Number(latest.spec?.budgets?.maxTokenCount ?? Infinity)
          - latest.tokenCount < 128) {
          campaignStore.stopCampaign(campaignId, 'campaign_token_budget_exhausted');
          const error = new Error('campaign_token_budget_exhausted');
          error.retryable = false;
          throw error;
        }
        try {
          if (externalActionStarted()) {
            campaignStore.recordUsage(
              campaignId,
              { agentCalls: 1 },
              { enforceBudget: true },
            );
          } else {
            campaignStore.reserveNodeInfrastructureUsage({
              nodeId: node.nodeId,
              workerId,
              attemptId: node.attemptId,
              leaseGeneration: node.leaseGeneration,
              usageDelta: { agentCalls: 1 },
            });
          }
        } catch (error) {
          if (campaignInfrastructureControlError(error)) throw error;
          campaignStore.stopCampaign(campaignId, 'campaign_agent_call_budget_exhausted');
          error.retryable = false;
          throw error;
        }
        latestForOperation = latest;
      };
      const executeNested = async ({ externalActionId = null } = {}) => {
        if (controller.signal.aborted) throw campaignExecutionAbortError(controller.signal);
        const latest = latestForOperation || campaignStore.getCampaign(campaignId);
        return operation({
          remainingTokenCount: Math.max(
            128,
            Number(latest.spec?.budgets?.maxTokenCount ?? Infinity)
              - latest.tokenCount,
          ),
          signal: controller.signal,
          externalActionId,
          idempotencyKey: externalActionId,
        });
      };
      if (nodeSideEffectGate?.run) {
        const gateRequest = {
          action: `campaign_nested_agent_execute:${node.nodeId}`,
          campaignId,
          nodeId: node.nodeId,
          requestDigest: actionOptions.requestDigest,
          requestBinding: actionOptions.requestBinding || null,
        };
        nestedResult = await nodeSideEffectGate.run(
          gateRequest,
          executeNested,
          {
            beforeStart: reserveNestedAgent,
            usageFromOutcome: (result) => meteredResultUsage(
              result,
              { agentCall: true },
            ),
          },
        );
      } else {
        await reserveNestedAgent();
        if (nodeSideEffectGate) {
          const gateRequest = {
            action: `campaign_nested_agent_execute:${node.nodeId}`,
            campaignId,
            nodeId: node.nodeId,
          };
          await nodeSideEffectGate(gateRequest);
          nodeSideEffectGate.assertCurrent?.(gateRequest);
          await nodeSideEffectGate.markStarted?.(gateRequest);
        }
        nestedResult = await executeNested();
        campaignStore.recordUsage(
          campaignId,
          meteredResultUsage(nestedResult, { agentCall: true }),
        );
      }
      if (controller.signal.aborted) {
        throw campaignExecutionAbortError(controller.signal, 'resource_lease_lost');
      }
    } catch (error) {
      operationError = error;
    } finally {
      try { releaseNestedLocal?.(); } catch (error) { localReleaseError = error; }
      try {
        if (releaseNestedGlobal() === false) {
          abortCampaignExecution(
            controller,
            releaseNestedGlobal.lostSignal?.reason
              || 'resource_lease_release_fence_lost',
          );
          globalReleaseError = campaignExecutionAbortError(
            controller.signal,
            'resource_lease_release_fence_lost',
          );
        }
      } catch (error) {
        abortCampaignExecution(controller, error?.message || 'resource_lease_release_failed');
        globalReleaseError = error;
      } finally {
        detachNestedLeaseLoss();
      }
    }
    if (globalReleaseError) throw globalReleaseError;
    if (releaseNestedGlobal.lostSignal?.aborted) {
      throw campaignExecutionAbortError(
        releaseNestedGlobal.lostSignal,
        'resource_lease_lost',
      );
    }
    if (localReleaseError) throw localReleaseError;
    if (operationError) throw operationError;
    if (controller.signal.aborted) {
      throw campaignExecutionAbortError(controller.signal, 'resource_lease_lost');
    }
    return nestedResult;
  };
}

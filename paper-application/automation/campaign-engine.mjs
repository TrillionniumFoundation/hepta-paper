import { addAbortListener as subscribeAbort } from 'node:events';
import { createResourceGovernor, resourcesForCampaignNode } from './resource-governor.mjs';
import {
  normalizeCampaignResourceEnvelopePolicy,
  assertCampaignResourceEnvelopeSupport,
  acquireCampaignResourceEnvelopeScope,
} from './campaign-resource-envelope-scope.mjs';
import { prepareAndIntegrateCampaignNodeResult } from './campaign-prepared-result-integration.mjs';
import { formatProcessIdentitySuffix } from '../../workflow-kernel/runtime/process-identity.mjs';
import { createCampaignEmpiricalCellRunner } from './campaign-empirical-cell-budget.mjs';
import { buildCampaignConvergenceDecision } from './campaign-convergence-evaluator.mjs';
import { recoverCampaignGenerationLockWaitAbort } from './campaign-generation-lock-wait-abort-recovery.mjs';
import { campaignInfrastructureControlError, cancelCampaignNodeInfrastructureReservation, createCampaignNodeExternalSideEffectGate } from './campaign-node-infrastructure-control.mjs';
import {
  abortCampaignExecution,
  campaignExecutionAbortError,
  createCampaignNestedAgentRunner,
} from './campaign-nested-agent-runner.mjs';
import {
  campaignBudgetBlocker as budgetBlocker,
  campaignNodeUsageDelta as usageDelta,
  elapsedRunMs,
  meteredCampaignFailureUsage as meteredFailureUsage,
  meteredCampaignResultUsage as meteredResultUsage,
  postExecutionCampaignBudgetBlocker as postExecutionBudgetBlocker,
} from './campaign-execution-budget-policy.mjs';
import {
  assertCampaignPackageLifecycleAuthority,
  prepareCampaignPackageLifecycle,
} from './campaign-package-lifecycle.mjs';

function boundedFailureDetail(error, { usageMetering = null } = {}) {
  const receipt = error?.receipt || {};
  return Object.freeze({
    message: String(error?.message || 'campaign_executor_failed').slice(0, 1000),
    receiptKind: receipt.kind || null,
    receiptStatus: receipt.status || null,
    receiptHash: receipt.agentExecutionReceiptHash
      || receipt.multiLanguageEmpiricalReceiptHash
      || receipt.formalProofSearchFailureCertificateHash
      || receipt.receiptHash || null,
    blockers: Array.isArray(receipt.blockers) ? receipt.blockers.slice(0, 20) : [],
    exitCode: receipt.exitCode ?? null,
    stderrTail: String(receipt.stderrTail || '').slice(-4000),
    stdoutTail: String(receipt.stdoutTail || '').slice(-4000),
    receiptDetails: receipt.details || null,
    backendFailures: Array.isArray(error?.failures) ? error.failures.slice(0, 10) : [],
    usageMetering,
  });
}

export async function runPaperCampaign({
  campaignId,
  campaignStore,
  executor,
  concurrency = 4,
  workerPrefix = 'paper-campaign-worker',
  leaseSeconds = 1800,
  pollMs = 5,
  maximumIdlePolls = 20,
  resourceGovernor = null,
  resourceEnvelopePolicy = null,
  clock,
  scheduler,
  idGenerator,
  signal = null,
  assertExternalSideEffectReady = null,
  packageLifecycleAuthority = null,
} = {}) {
  if (!campaignId || !campaignStore || typeof executor?.execute !== 'function') {
    throw new Error('campaignId, CampaignStorePort and executor are required');
  }
  if (typeof clock?.now !== 'function' || typeof scheduler?.sleep !== 'function'
    || typeof scheduler?.setInterval !== 'function' || typeof scheduler?.clearInterval !== 'function'
    || typeof idGenerator?.next !== 'function') {
    throw new Error('ClockPort, SchedulerPort and IdGeneratorPort are required');
  }
  if (assertExternalSideEffectReady !== null
    && typeof assertExternalSideEffectReady !== 'function') {
    throw new Error('campaign_external_side_effect_recoverability_gate_invalid');
  }
  assertCampaignPackageLifecycleAuthority(packageLifecycleAuthority);
  if (assertExternalSideEffectReady
    && (typeof campaignStore.cancelNodeInfrastructureDeferred !== 'function'
      || typeof campaignStore.reserveNodeInfrastructureUsage !== 'function'
      || typeof campaignStore.markNodeExternalActionStarted !== 'function'
      || typeof campaignStore.completeNodeExternalAction !== 'function'
      || typeof campaignStore.getNodeExternalAction !== 'function')) {
    throw new Error('campaign_node_infrastructure_cancel_required');
  }
  const envelopePolicy = normalizeCampaignResourceEnvelopePolicy(resourceEnvelopePolicy);
  const nowEpochMs = () => clock.now().getTime();
  const workerCount = Math.max(1, Math.min(64, Number(concurrency) || 4));
  let idlePolls = 0;
  let maximumObservedConcurrency = 0;
  let active = 0;
  let executedNodeCount = 0;
  let retryCount = 0;
  const dispatcherId = `${workerPrefix}:${idGenerator.next('dispatcher')}:${formatProcessIdentitySuffix()}`;
  const initialCampaign = campaignStore.getCampaign(campaignId);
  const campaignMemoryMiB = Number(initialCampaign?.spec?.budgets?.maxMemoryMiB ?? Math.max(2048, workerCount * 2048));
  const governor = resourceGovernor || createResourceGovernor({ agent: workerCount, cpu: workerCount, gpu: 1, memoryMiB: campaignMemoryMiB });
  const localGovernor = createResourceGovernor({
    agent: workerCount,
    cpu: Number(initialCampaign?.spec?.budgets?.maxCpuJobs ?? workerCount),
    gpu: Number(initialCampaign?.spec?.budgets?.maxGpuJobs ?? 1),
    memoryMiB: campaignMemoryMiB,
  });

  assertCampaignResourceEnvelopeSupport(envelopePolicy, governor);

  await packageLifecycleAuthority?.reconcile();

  while (true) {
    let campaign = campaignStore.getCampaign(campaignId);
    if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
    if (signal?.aborted && campaign.status === 'running') {
      campaign = campaignStore.pauseCampaign(campaignId, 'supervisor_process_shutdown');
    }
    if (['completed', 'failed', 'cancelled', 'paused', 'stopped'].includes(campaign.status)) {
      await packageLifecycleAuthority?.reconcileCampaign({ campaignId });
      return Object.freeze({
        version: 1,
        kind: 'PaperCampaignRunResult',
        campaign,
        nodes: campaignStore.listNodes(campaignId),
        eventCount: campaignStore.listEvents(campaignId).length,
        executedNodeCount,
        retryCount,
        maximumObservedConcurrency,
        resourceUsage: governor.snapshot(),
        ...(envelopePolicy ? { resourceEnvelopePolicyHash: envelopePolicy.policyHash } : {}),
        externalActionPerformed: false,
      });
    }
    const slots = workerCount - active;
    const claimed = slots > 0 ? campaignStore.claimReady({ campaignId, workerId: dispatcherId, leaseSeconds, limit: slots }) : [];
    if (!claimed.length) {
      idlePolls += 1;
      if (idlePolls > maximumIdlePolls) {
        const nodes = campaignStore.listNodes(campaignId);
        if (nodes.some((node) => ['leased', 'running'].includes(node.status))) {
          await scheduler.sleep(pollMs);
          continue;
        }
        throw new Error('campaign_deadlock_or_unsatisfied_dependencies');
      }
      await scheduler.sleep(pollMs);
      continue;
    }
    idlePolls = 0;
    const batch = claimed.map(async (claimedNode, index) => {
      const dispatchStartedMs = nowEpochMs();
      const workerId = dispatcherId;
      const currentCampaign = campaignStore.getCampaign(campaignId);
      const nowMs = nowEpochMs();
      const blocker = budgetBlocker(currentCampaign, claimedNode, nowMs);
      if (blocker) {
        campaignStore.stopCampaign(campaignId, blocker);
        return;
      }
      const requestedResources = resourcesForCampaignNode(currentCampaign, claimedNode);
      const controller = new AbortController();
      const onSupervisorAbort = () => controller.abort(
        signal?.reason || 'supervisor_process_shutdown',
      );
      if (signal?.aborted) onSupervisorAbort();
      const supervisorSubscription = signal && !signal.aborted
        ? subscribeAbort(signal, onSupervisorAbort) : null;
      const controlMonitor = scheduler.setInterval(() => {
        const status = campaignStore.getCampaign(campaignId)?.status;
        if (['paused', 'cancelled', 'failed', 'stopped'].includes(status)) controller.abort(status);
        const latestNode = campaignStore.listNodes(campaignId).find((item) => item.nodeId === claimedNode.nodeId);
        if (latestNode && (!['leased', 'running'].includes(latestNode.status)
          || latestNode.attemptId !== claimedNode.attemptId
          || latestNode.leaseGeneration !== claimedNode.leaseGeneration)) {
          controller.abort(latestNode.failureClass || latestNode.status || 'campaign_node_lease_lost');
        }
      }, 500);
      scheduler.unref?.(controlMonitor);
      let releaseResources;
      let releaseLocalResources;
      let resourceScope = null;
      let detachResourceLoss = () => {};
      let controlsDisposed = false;
      let resourceCleanupStarted = false;
      let heartbeat = null;
      const disposeControls = () => {
        if (controlsDisposed) return;
        controlsDisposed = true;
        supervisorSubscription?.[Symbol.dispose]();
        if (heartbeat) scheduler.clearInterval(heartbeat);
        detachResourceLoss();
        scheduler.clearInterval(controlMonitor);
      };
      try {
        try {
          resourceScope = await acquireCampaignResourceEnvelopeScope({
            policy: envelopePolicy, node: claimedNode, requestedResources,
            governor, localGovernor, signal: controller.signal,
          });
          if (resourceScope) {
            releaseResources = resourceScope.releaseGlobal;
            releaseLocalResources = resourceScope.releaseLocal;
          } else {
            releaseResources = await governor.acquire(requestedResources, { campaignId, nodeId: claimedNode.nodeId, signal: controller.signal });
            const lostSignal = releaseResources.lostSignal;
            if (lostSignal) {
              const onLost = () => controller.abort(lostSignal.reason || 'resource_lease_lost');
              if (lostSignal.aborted) onLost();
              else lostSignal.addEventListener('abort', onLost, { once: true });
              detachResourceLoss = () => lostSignal.removeEventListener?.('abort', onLost);
            }
            releaseLocalResources = await localGovernor.acquire(requestedResources, { signal: controller.signal });
          }
        } catch (error) {
          if (controller.signal.aborted || error?.code === 'resource_acquire_aborted') return;
          throw error;
        }
        const reservedCampaign = campaignStore.getCampaign(campaignId);
        const reservedNode = campaignStore.listNodes(campaignId).find((item) => item.nodeId === claimedNode.nodeId);
        if (controller.signal.aborted || reservedCampaign?.status !== 'running' || reservedNode?.status !== 'leased' || reservedNode?.leaseOwner !== dispatcherId) {
          return;
        }
        const reservationBlocker = budgetBlocker(reservedCampaign, claimedNode, nowEpochMs());
        if (reservationBlocker) {
          campaignStore.stopCampaign(campaignId, reservationBlocker);
          return;
        }
        const replayingPreparedResult = Boolean(claimedNode.preparedResultHash);
        const nodeBudgetReservation = replayingPreparedResult
          ? {} : usageDelta(reservedCampaign, claimedNode);
        const {
          gate: nodeSideEffectGate,
          externalActionStarted: nodeExternalSideEffectStarted,
        } = createCampaignNodeExternalSideEffectGate({
          assertExternalSideEffectReady,
          campaignStore,
          node: claimedNode,
          workerId,
        });
        let node;
        try {
          node = campaignStore.startNode({
            nodeId: claimedNode.nodeId,
            workerId,
            attemptId: claimedNode.attemptId,
            leaseGeneration: claimedNode.leaseGeneration,
            usageDelta: nodeBudgetReservation,
          });
        } catch (error) {
          const latestCampaign = campaignStore.getCampaign(campaignId);
          const latestNode = campaignStore.listNodes(campaignId).find((item) => item.nodeId === claimedNode.nodeId);
          if (error?.message === 'campaign_node_budget_reservation_failed') {
            const blocker = budgetBlocker(latestCampaign, claimedNode, nowEpochMs())
              || 'campaign_agent_call_budget_exhausted';
            campaignStore.stopCampaign(campaignId, blocker);
            return;
          }
          if (latestCampaign?.status !== 'running' || latestNode?.attemptId !== claimedNode.attemptId || latestNode?.leaseGeneration !== claimedNode.leaseGeneration) return;
          throw error;
        }
        heartbeat = typeof campaignStore.renewNodeLease === 'function' ? scheduler.setInterval(() => {
          try {
            campaignStore.renewNodeLease({
              nodeId: node.nodeId,
              workerId,
              attemptId: node.attemptId,
              leaseGeneration: node.leaseGeneration,
              leaseSeconds,
            });
          } catch {
            controller.abort('campaign_node_lease_lost');
          }
        }, Math.max(1000, Math.floor(leaseSeconds * 1000 / 3))) : null;
        scheduler.unref?.(heartbeat);
        active += 1;
        const commandStartedMs = nowEpochMs();
        maximumObservedConcurrency = Math.max(maximumObservedConcurrency, active);
        try {
          const remainingWallTimeMs = Math.max(1, Number(currentCampaign.spec?.budgets?.maxWallTimeMs ?? 6 * 60 * 60 * 1000) - elapsedRunMs(currentCampaign, nowMs));
          const nestedRunner = createCampaignNestedAgentRunner({
            campaignId,
            campaignStore,
            node,
            workerId,
            controller,
            governor: resourceScope?.globalGovernor || governor,
            localGovernor: resourceScope?.localGovernor || localGovernor,
            nodeSideEffectGate,
            externalActionStarted: nodeExternalSideEffectStarted,
          });
          const runNestedAgent = resourceScope ? resourceScope.bindNestedRunner(nestedRunner) : nestedRunner;
          const runEmpiricalCell = createCampaignEmpiricalCellRunner({
            campaignId,
            campaignStore,
            controller,
            nodeAttempt: {
              nodeId: node.nodeId,
              workerId,
              attemptId: node.attemptId,
              leaseGeneration: node.leaseGeneration,
            },
            assertExternalSideEffectReady: nodeSideEffectGate,
            externalActionStarted: nodeExternalSideEffectStarted,
          });
          const remainingTokenCount = Math.max(0, Number(currentCampaign.spec?.budgets?.maxTokenCount ?? Infinity) - currentCampaign.tokenCount);
          if (!node.preparedResult && nodeSideEffectGate) {
            try {
              await nodeSideEffectGate({
                action: `campaign_node_execute:${node.nodeId}`,
                campaignId,
                nodeId: node.nodeId,
              });
              nodeSideEffectGate.assertCurrent?.({
                action: `campaign_node_execute:${node.nodeId}`,
                campaignId,
                nodeId: node.nodeId,
              });
            } catch (error) {
              if (campaignInfrastructureControlError(error)) {
                cancelCampaignNodeInfrastructureReservation({
                  campaignStore,
                  node,
                  workerId,
                  error,
                  externalActionStarted: nodeExternalSideEffectStarted(),
                });
              }
              throw error;
            }
          }
          let result;
          try {
            result = node.preparedResult || await executor.execute({ campaign: currentCampaign, node, allNodes: campaignStore.listNodes(campaignId), workerIndex: index, executionBudget: { remainingWallTimeMs, remainingTokenCount, absoluteDeadlineEpochMs: nowMs + remainingWallTimeMs, acquiredResources: requestedResources, ...(resourceScope ? { resourceEnvelope: resourceScope.reservation } : {}) }, executionSignal: controller.signal, executionResources: { runNestedAgent, runEmpiricalCell, assertExternalSideEffectReady: nodeSideEffectGate }, deferWorkspaceIntegration: true, assertExternalSideEffectReady: nodeSideEffectGate });
          } catch (error) {
            if (resourceScope) {
              abortCampaignExecution(controller, 'campaign_parent_execution_failed');
              // Wait for real child settlement, retaining the original parent error.
              try { await resourceScope.finish({ cancel: true }); } catch { /* Child denial is not parent success. */ }
            }
            throw error;
          }
          // No parent result may be prepared/committed while a registered child
          // can still run. A caught/ignored child failure denies this opt-in scope.
          await resourceScope?.finish();
          if (controller.signal.aborted) {
            const error = new Error(String(controller.signal.reason || 'campaign_execution_fence_lost'));
            error.retryable = true;
            throw error;
          }
          if (!node.preparedResult && node.kind === 'convergence') {
            const nodes = campaignStore.listNodes(campaignId);
            result = buildCampaignConvergenceDecision({
              campaign: currentCampaign,
              node,
              nodes,
              executionResult: result,
              signedReviewerReceiptVerifier:
                typeof executor.verifySignedReviewerReceipt === 'function'
                  ? executor.verifySignedReviewerReceipt : null,
              sessionReviewerReceiptVerifier: typeof executor.verifySessionReviewerReceipt === 'function' ? executor.verifySessionReviewerReceipt : null,
            });
          }
          const prepared = await prepareAndIntegrateCampaignNodeResult({
            campaignId, campaignStore, node, result, workerId, executor,
            campaign: currentCampaign, signal: controller.signal, leaseSeconds, nowEpochMs,
          });
          if (controller.signal.aborted) throw campaignExecutionAbortError(controller.signal, 'campaign_execution_fence_lost');
          const resultUsage = meteredResultUsage(result, { agentCall: requestedResources.agent > 0 });
          prepareCampaignPackageLifecycle({
            authority: packageLifecycleAuthority, campaignId, node, workerId,
            preparedResultHash: prepared.preparedResultHash,
          });
          campaignStore.completeNode({
            nodeId: node.nodeId,
            workerId,
            attemptId: node.attemptId,
            leaseGeneration: node.leaseGeneration,
            preparedResultHash: prepared.preparedResultHash,
            usageDelta: resultUsage,
          });
          if (node.kind === 'package' && packageLifecycleAuthority) {
            packageLifecycleAuthority.reconcileCampaign({ campaignId });
          }
          const postBlocker = postExecutionBudgetBlocker(campaignStore.getCampaign(campaignId));
          if (postBlocker) campaignStore.stopCampaign(campaignId, postBlocker);
          executedNodeCount += 1;
          if (!postBlocker && node.kind === 'convergence' && result.accepted) {
            campaignStore.skipFutureRounds({ campaignId, afterRound: node.roundIndex, reason: 'referee_convergence_reached' });
          } else if (node.kind === 'convergence' && !result.accepted && node.roundIndex >= currentCampaign.maxRounds) {
            campaignStore.stopCampaign(campaignId, 'referee_convergence_not_reached_within_budget');
          }
        } catch (error) {
          if (recoverCampaignGenerationLockWaitAbort({ error, controllerSignal: controller.signal, supervisorSignal: signal, externalActionStarted: nodeExternalSideEffectStarted(), campaignStore, campaignId, node, workerId, observedAtEpochMs: nowEpochMs() })) return;
          if (signal?.aborted) return;
          if (campaignInfrastructureControlError(error)) {
            cancelCampaignNodeInfrastructureReservation({
              campaignStore,
              node,
              workerId,
              error,
              externalActionStarted: nodeExternalSideEffectStarted(),
            });
            throw error;
          }
          const latestNode = campaignStore.listNodes(campaignId).find((item) => item.nodeId === node.nodeId);
          if (latestNode?.status !== 'running' || latestNode?.attemptId !== node.attemptId || latestNode?.leaseGeneration !== node.leaseGeneration) return;
          const campaignStatus = campaignStore.getCampaign(campaignId)?.status;
          if (campaignStatus !== 'running') return;
          const failureMetering = meteredFailureUsage(error, { agentCall: requestedResources.agent > 0 });
          const failed = campaignStore.failNode({
            nodeId: node.nodeId,
            workerId,
            attemptId: node.attemptId,
            leaseGeneration: node.leaseGeneration,
            failureDetail: boundedFailureDetail(error, failureMetering),
            abandonPreparedResult: Boolean(error?.abandonPreparedResult
              || /workspace_attempt_(?:integration_conflict|postimage|source_|descriptor|root_|read_set|manifest|attempt_)/.test(String(error?.code || error?.message || ''))),
            ...failureMetering.nodeFailure,
          });
          if (failed.status === 'queued') retryCount += 1;
        } finally {
          const commandEndedMs = nowEpochMs();
          disposeControls();
          active -= 1;
          const releaseStartedMs = nowEpochMs();
          resourceCleanupStarted = true;
          let localReleaseError = null;
          let globalReleaseError = null;
          try { releaseLocalResources(); } catch (error) { localReleaseError = error; }
          try {
            if (releaseResources() === false) {
              abortCampaignExecution(controller, releaseResources.lostSignal?.reason || 'resource_lease_release_fence_lost');
              globalReleaseError = campaignExecutionAbortError(controller.signal, 'resource_lease_release_fence_lost');
            }
          } catch (error) {
            abortCampaignExecution(controller, error?.message || 'resource_lease_release_failed');
            globalReleaseError = error;
          }
          const releasedMs = nowEpochMs();
          const resourceTelemetry = releaseResources.telemetry || {};
          let telemetryError = null;
          try {
            campaignStore.recordTelemetry?.({
              campaignId,
              nodeId: claimedNode.nodeId,
              phases: {
                dispatch: Math.max(0, commandStartedMs - dispatchStartedMs - Number(resourceTelemetry.lockWaitMs || 0)),
                lockAcquire: Number(resourceTelemetry.lockWaitMs || Math.max(0, commandStartedMs - dispatchStartedMs)),
                command: Math.max(0, commandEndedMs - commandStartedMs),
                lockRelease: Math.max(0, releasedMs - releaseStartedMs),
                total: Math.max(0, releasedMs - dispatchStartedMs),
              },
              lockWaitMs: Number(resourceTelemetry.lockWaitMs || 0),
              queueContentionCount: Number(resourceTelemetry.queueContentionCount || 0),
              requestedAt: resourceTelemetry.requestedAt || new Date(dispatchStartedMs).toISOString(),
              acquiredAt: resourceTelemetry.acquiredAt || new Date(commandStartedMs).toISOString(),
              releasedAt: new Date(releasedMs).toISOString(),
            });
          } catch (error) {
            telemetryError = error;
          }
          if (globalReleaseError) throw globalReleaseError;
          if (releaseResources.lostSignal?.aborted) throw campaignExecutionAbortError(releaseResources.lostSignal, 'resource_lease_lost');
          if (localReleaseError) throw localReleaseError;
          if (telemetryError) throw telemetryError;
        }
      } finally {
        // Also covers exceptions in status reads, reservation checks and start
        // preparation, before the normal execution-finally owns the leases.
        try {
          if (!resourceCleanupStarted) {
            resourceCleanupStarted = true;
            try { releaseLocalResources?.(); } finally { releaseResources?.(); }
          }
        } finally { disposeControls(); }
      }
    });
    if (envelopePolicy) {
      // A failed peer must not make the caller believe the admitted batch has
      // already stopped while another node still owns an envelope.
      const settled = await Promise.allSettled(batch);
      const rejected = settled.find((result) => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    } else {
      await Promise.all(batch);
    }
  }
}

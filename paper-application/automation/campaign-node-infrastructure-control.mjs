import { addAbortListener as subscribeAbort } from 'node:events';

export function campaignInfrastructureControlError(error) {
  return error?.committed === true
    || error?.stateRecoverabilityFatal === true
    || error?.stateRecoverabilityDeferred === true
    || error?.authorityEvidenceRenewalFatal === true
    || error?.authorityEvidenceRenewalDeferred === true
    || error?.residentReactivationRequired === true;
}

function infrastructureCancellationFatal(error, originalError, scope) {
  const fatal = new Error(`${scope}_infrastructure_cancel_failed`, { cause: error });
  fatal.stateRecoverabilityFatal = true;
  fatal.originalInfrastructureControlError = originalError;
  return fatal;
}

export function cancelCampaignNodeInfrastructureReservation({
  campaignStore,
  node,
  workerId,
  error,
  externalActionStarted = false,
  scope = 'campaign_node',
} = {}) {
  if (externalActionStarted
    || error?.campaignNodeInfrastructureReservationCancelled === true) return false;
  try {
    campaignStore.cancelNodeInfrastructureDeferred({
      nodeId: node.nodeId,
      workerId,
      attemptId: node.attemptId,
      leaseGeneration: node.leaseGeneration,
    });
  } catch (cancelError) {
    throw infrastructureCancellationFatal(cancelError, error, scope);
  }
  error.campaignNodeInfrastructureReservationCancelled = true;
  return true;
}

export function createCampaignNodeExternalSideEffectGate({
  assertExternalSideEffectReady,
  campaignStore,
  node,
  workerId,
} = {}) {
  const startedActionIds = new Set();
  const actionOrdinals = new Map();
  if (!assertExternalSideEffectReady) {
    return Object.freeze({ gate: null, externalActionStarted: () => false });
  }
  const resolverKind = (action) => {
    const value = String(action || '');
    if (/(?:attestor|sign|kms)/i.test(value)) return 'deterministic-digest-signer';
    if (/(?:pdf|formal_native_worker|empirical_cell|local_worker)/i.test(value)) {
      return 'local-worker-inspect';
    }
    if (/(?:agent|reviewer|provider|portal|submission)/i.test(value)) {
      return 'remote-provider-lookup';
    }
    return 'unqualified';
  };
  const descriptorFor = (value = {}) => {
    const action = String(value.action || 'unspecified');
    const actionOrdinal = Number(value.actionOrdinal
      || (actionOrdinals.get(action) || 0) + 1);
    actionOrdinals.set(action, actionOrdinal);
    return buildCampaignExternalActionDescriptor({
      campaign: campaignStore.getCampaign(node.campaignId),
      node,
      request: value,
      actionOrdinal,
      resolverKind: value.resolverKind || resolverKind(action),
    });
  };
  const gate = async (value = {}) => assertExternalSideEffectReady(value);
  gate.assertCurrent = (value = {}) => (
    assertExternalSideEffectReady.assertCurrent?.(value)
  );
  const startDescriptor = async (value, descriptor) => {
    let record;
    try {
      record = campaignStore.markNodeExternalActionStarted({
        nodeId: node.nodeId,
        workerId,
        attemptId: node.attemptId,
        leaseGeneration: node.leaseGeneration,
        ...descriptor,
      });
      startedActionIds.add(descriptor.externalActionId);
    } catch (error) {
      if (error?.committed) startedActionIds.add(descriptor.externalActionId);
      throw error;
    }
    if (record?.status === 'completed') return record;
    await assertExternalSideEffectReady(value);
    assertExternalSideEffectReady.assertCurrent?.(value);
    await assertExternalSideEffectReady.markStarted?.({
      ...value,
      externalActionId: descriptor.externalActionId,
      requestDigest: descriptor.requestDigest,
    });
    return record;
  };
  gate.markStarted = async (value = {}) => (
    startDescriptor(value, descriptorFor(value))
  );
  gate.markCompleted = async (record, outcome, { usageDelta = {} } = {}) => {
    if (!record?.externalActionId) {
      throw new Error('campaign_external_action_completion_identity_required');
    }
    const completed = campaignStore.completeNodeExternalAction({
      nodeId: node.nodeId,
      workerId,
      attemptId: node.attemptId,
      leaseGeneration: node.leaseGeneration,
      externalActionId: record.externalActionId,
      outcome,
      usageDelta,
    });
    return completed.outcomePayload;
  };
  gate.run = async (value, operation, {
    beforeStart = null,
    usageFromOutcome = null,
  } = {}) => {
    if (typeof operation !== 'function') {
      throw new Error('campaign_external_action_operation_required');
    }
    await gate(value);
    gate.assertCurrent?.(value);
    const descriptor = descriptorFor(value);
    const existing = campaignStore.getNodeExternalAction(descriptor);
    if (existing?.status === 'completed') return existing.outcomePayload;
    if (!existing && beforeStart) await beforeStart();
    const record = await startDescriptor(value, descriptor);
    if (record?.status === 'completed') return record.outcomePayload;
    const outcome = await operation(Object.freeze({
      externalActionId: record.externalActionId,
      requestDigest: record.requestDigest,
    }));
    return gate.markCompleted(record, outcome, {
      usageDelta: usageFromOutcome ? usageFromOutcome(outcome) : {},
    });
  };
  gate.externalActionStarted = () => startedActionIds.size > 0;
  return Object.freeze({
    gate,
    externalActionStarted: () => startedActionIds.size > 0,
  });
}
import {
  buildCampaignExternalActionDescriptor,
} from '../../paper-domain/automation/campaign-external-action-journal-contract.mjs';

export function boundedCampaignFailureDetail(error, { usageMetering = null } = {}) {
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

// Own one monitor and its supervisor subscription; no resource or writer authority.
export function createCampaignNodeControlMonitor({
  campaignStore, campaignId, claimedNode, controller, signal, scheduler,
}) {
  const onSupervisorAbort = () => controller.abort(signal?.reason || 'supervisor_process_shutdown');
  let subscription = null;
  let monitor;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    subscription?.[Symbol.dispose]();
    subscription = null;
    if (monitor !== undefined) scheduler.clearInterval(monitor);
  };
  try {
    if (signal?.aborted) onSupervisorAbort();
    else if (signal) subscription = subscribeAbort(signal, onSupervisorAbort);
    monitor = scheduler.setInterval(() => {
      const status = campaignStore.getCampaign(campaignId)?.status;
      if (['paused', 'cancelled', 'failed', 'stopped'].includes(status)) controller.abort(status);
      const latestNode = campaignStore.listNodes(campaignId).find((item) => item.nodeId === claimedNode.nodeId);
      if (latestNode && (!['leased', 'running'].includes(latestNode.status)
        || latestNode.attemptId !== claimedNode.attemptId
        || latestNode.leaseGeneration !== claimedNode.leaseGeneration)) {
        controller.abort(latestNode.failureClass || latestNode.status || 'campaign_node_lease_lost');
      }
    }, 500);
    scheduler.unref?.(monitor);
    return close;
  } catch (error) { close(); throw error; }
}

// Construct after admission inside the caller's execution try/finally. On failed
// unref, dispose the newly created handle before propagating the setup error.
export function createCampaignNodeHeartbeat({ campaignStore, scheduler, node, workerId, leaseSeconds, controller }) {
  if (typeof campaignStore.renewNodeLease !== 'function') return null;
  const heartbeat = scheduler.setInterval(() => {
    try {
      campaignStore.renewNodeLease({ nodeId: node.nodeId, workerId, attemptId: node.attemptId,
        leaseGeneration: node.leaseGeneration, leaseSeconds });
    } catch { controller.abort('campaign_node_lease_lost'); }
  }, Math.max(1000, Math.floor(leaseSeconds * 1000 / 3)));
  try { scheduler.unref?.(heartbeat); }
  catch (error) { scheduler.clearInterval(heartbeat); throw error; }
  return heartbeat;
}

// A broken monitor port must not prevent releasing the other owned handles.
// Return the first cleanup error for propagation after all resource releases.
export function closeCampaignNodeMonitors({ heartbeat, clearControl, detachLeaseLoss, scheduler }) {
  let failure = null;
  for (const close of [() => { if (heartbeat !== null) scheduler.clearInterval(heartbeat); },
    detachLeaseLoss, clearControl]) {
    try { close(); } catch (error) { failure ||= error; }
  }
  return failure;
}


// This synchronous admission phase returns ownership only after all state/claim
// checks succeed. The caller disposes its reservation on null or any exception.
export function startAdmittedCampaignNode({ campaignStore, campaignId, claimedNode,
  controller, dispatcherId, workerId, nowEpochMs, budgetBlocker, usageDelta,
  assertExternalSideEffectReady }) {
  const reservedCampaign = campaignStore.getCampaign(campaignId);
  const reservedNode = campaignStore.listNodes(campaignId).find((item) => item.nodeId === claimedNode.nodeId);
  if (controller.signal.aborted || reservedCampaign?.status !== 'running' || reservedNode?.status !== 'leased' || reservedNode?.leaseOwner !== dispatcherId) {
    return null;
  }
  const reservationBlocker = budgetBlocker(reservedCampaign, claimedNode, nowEpochMs());
  if (reservationBlocker) {
    campaignStore.stopCampaign(campaignId, reservationBlocker);
    return null;
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
      return null;
    }
    if (latestCampaign?.status !== 'running' || latestNode?.attemptId !== claimedNode.attemptId || latestNode?.leaseGeneration !== claimedNode.leaseGeneration) return null;
    throw error;
  }
  return { node, nodeSideEffectGate, nodeExternalSideEffectStarted };
}

// Unused admission owns no dispatched work. Attempt every cleanup even when a
// resource port throws; never let its error strand the supervisor subscription.
export function closeCampaignAdmission({ releaseLocalResources, releaseResources, detachLeaseLoss, clearControl }) {
  let failure = null;
  for (const close of [releaseLocalResources, releaseResources, detachLeaseLoss, clearControl]) {
    try { close?.(); } catch (error) { failure ||= error; }
  }
  return failure;
}

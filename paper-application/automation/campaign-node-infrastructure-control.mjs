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

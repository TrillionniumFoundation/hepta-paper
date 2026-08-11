import {
  assertNativeStoreNodeInfrastructureReservation,
  insertNativeStoreCampaignEvent,
  NATIVE_STORE_CAMPAIGN_OPERATION_IDS as O,
  NATIVE_STORE_CAMPAIGN_STATEMENT_IDS as S,
  nativeStoreCampaignUsageParameters,
  projectNativeStoreCampaign,
  runNativeStoreCampaignUsage,
  runRequiredNativeStoreCampaignStatement,
} from './native-store-campaign-mutation-plan.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertCampaignExternalActionDescriptor,
  assertCampaignExternalActionOutcome,
} from '../../paper-domain/automation/campaign-external-action-journal-contract.mjs';

const required = (transaction, statementId, parameters, code) => (
  runRequiredNativeStoreCampaignStatement(transaction, statementId, parameters, code)
);

function applyAssertLiveNodeAttempt(transaction, input) {
  const integrated = input.integrationState === 'integrated';
  return required(transaction, integrated
    ? S.assertIntegratedAttempt : S.assertIntegratingAttempt, [
    input.nodeId,
    input.workerId,
    input.attemptId,
    Number(input.leaseGeneration),
    input.now,
    input.integrationKey,
    ...(integrated ? [input.integrationReceiptHash] : []),
  ], 'campaign_node_attempt_fence_check_failed');
}

function applyCreateCampaign(transaction, input) {
  const { spec, admitted, initialExecutionState, now, eventRow } = input;
  required(transaction, S.createCampaign, [
    spec.campaignId, spec.paperId, admitted ? 'paused' : 'queued',
    Math.max(1, Number(spec.maxRounds || 1)), JSON.stringify(spec), now, now,
    admitted ? null : now, spec.parentCampaignId || null,
    spec.supersedesCampaignId || null, spec.recoveryOfCampaignId || null,
    admitted ? initialExecutionState.phase : 'queued',
  ], 'campaign_create_failed');
  for (const node of spec.nodes) required(transaction, S.createCampaignNode, [
    node.nodeId, spec.campaignId, node.kind, Number(node.roundIndex || 0),
    Number(node.priority || 100), JSON.stringify(node.dependencies || []),
    JSON.stringify(node), Math.max(1, Number(node.maxAttempts || 3)),
    now, now, node.role || null,
  ], 'campaign_create_failed');
  if (!admitted) required(
    transaction, S.createCampaignStart, [now, spec.campaignId], 'campaign_create_failed',
  );
  insertNativeStoreCampaignEvent(transaction, eventRow);
}

function applyLifecycleMutation(transaction, operationId, input) {
  const { campaignId, now, eventRow } = input;
  if (operationId === O.skipFutureRounds) {
    for (const nodeId of input.futureNodeIds) {
      transaction.run(S.skipFutureNode, input.reason, now, nodeId, campaignId);
    }
    insertNativeStoreCampaignEvent(transaction, eventRow);
    return projectNativeStoreCampaign(transaction, { campaignId, now });
  }
  if (operationId === O.pauseCampaign) {
    required(transaction, S.pauseCampaign, [
      input.reason, now, now, campaignId, input.campaign.revision,
    ], 'campaign_pause_failed');
    transaction.run(S.pauseCampaignNodes, now, campaignId);
  } else if (operationId === O.resumeCampaign) {
    required(transaction, S.resumeCampaign, [
      now, JSON.stringify(input.nextSpec), now, campaignId,
      input.campaign.status, input.campaign.revision,
    ], 'campaign_resume_failed');
    if (input.reopenStoppedNodes) {
      transaction.run(S.resumeNodes, now, campaignId, input.campaign.stopReason);
    }
  } else if (operationId === O.cancelCampaign) {
    required(transaction, S.cancelCampaign, [
      input.campaign.lastResumedAt ? 1 : 0, now, input.reason, now,
      campaignId, input.campaign.status, input.campaign.revision,
    ], 'campaign_cancel_failed');
    transaction.run(S.cancelCampaignNodes, input.reason, now, campaignId);
  } else if ([O.failCampaign, O.stopCampaign].includes(operationId)) {
    const failed = operationId === O.failCampaign;
    required(transaction, failed ? S.failCampaign : S.stopCampaign, [
      input.campaign.lastResumedAt ? 1 : 0, now, input.reason, now,
      campaignId, input.campaign.status, input.campaign.revision,
    ], failed ? 'campaign_fail_failed' : 'campaign_stop_failed');
    transaction.run(
      failed ? S.failCampaignNodes : S.stopCampaignNodes,
      input.reason, now, campaignId,
    );
  } else {
    throw new Error('native_store_campaign_lifecycle_operation_invalid');
  }
  return insertNativeStoreCampaignEvent(transaction, eventRow);
}

function applyExtendCampaign(transaction, input) {
  const { spec, additions, campaign, now, eventRow } = input;
  transaction.run(S.extendSupersedePackage, now, spec.campaignId);
  for (const item of additions) required(transaction, S.extendCampaignNode, [
    item.nodeId, spec.campaignId, item.kind, Number(item.roundIndex || 0),
    Number(item.priority || 100), JSON.stringify(item.dependencies || []),
    JSON.stringify(item), Math.max(1, Number(item.maxAttempts || 3)), now, now,
  ], 'campaign_extension_failed');
  required(transaction, S.extendCampaign, [
    Number(spec.maxRounds), JSON.stringify(spec), now, now, spec.campaignId,
    campaign.status, campaign.revision,
  ], 'campaign_extension_failed');
  insertNativeStoreCampaignEvent(transaction, eventRow);
}

function applyCancelNode(transaction, input) {
  const { node, campaign, cancelled, failureDetail, failureHash, now, eventRow } = input;
  for (const nodeId of cancelled) {
    const inspected = transaction.get(S.cancelNodeInspect, nodeId, node.campaignId);
    if (inspected && inspected.status !== 'completed'
      && ['integrating', 'integrated'].includes(inspected.prepared_integration_status)) {
      throw new Error('campaign_node_cancel_integration_in_progress');
    }
  }
  required(transaction, S.cancelNodeGuard, [node.campaignId], 'campaign_node_cancel_failed');
  for (const nodeId of cancelled) transaction.run(
    S.cancelOneNode, input.reason, JSON.stringify(failureDetail), failureHash, now, nodeId,
  );
  insertNativeStoreCampaignEvent(transaction, eventRow);
  if (input.stoppedEvent) {
    required(transaction, S.cancelNodeStopCampaign, [
      now, now, node.campaignId, campaign.revision,
    ], 'campaign_node_cancel_failed');
    return insertNativeStoreCampaignEvent(transaction, input.stoppedEvent);
  }
  return projectNativeStoreCampaign(transaction, { campaignId: node.campaignId, now });
}

function applyRetryNode(transaction, input) {
  const { node, campaign, now, eventRow } = input;
  required(transaction, S.retryNode, [
    now, node.nodeId, node.nodeRevision,
  ], 'campaign_node_retry_failed');
  for (const sibling of input.reopenedSiblingNodes || []) {
    required(transaction, S.retrySiblingNode, [
      now, sibling.nodeId, node.campaignId, node.nodeId,
      sibling.preparedIntegrationStatus, Number(sibling.nodeRevision),
    ], 'campaign_node_retry_failed');
  }
  required(transaction, S.retryCampaign, [
    node.kind, Math.max(0, Number(node.roundIndex || 0)), now, now,
    node.campaignId, campaign.status, campaign.revision,
  ], 'campaign_node_retry_failed');
  insertNativeStoreCampaignEvent(transaction, eventRow);
}

function applyLeaseMutation(transaction, operationId, input) {
  if (operationId === O.recoverExpiredLeases) {
    const {
      node, campaignId, expired, now, eventRow, disposition,
    } = input;
    if (disposition === 'external_outcome_uncertain') {
      const events = infrastructureAttemptEvents(transaction, input);
      const completed = new Set(events.filter((event) => (
        event.kind === 'campaign_node_external_action_completed'
      )).map((event) => String(event.detail?.externalActionId || '')));
      const unresolved = events.filter((event) => (
        event.kind === 'campaign_node_external_action_started'
      )).map((event) => String(event.detail?.externalActionId
        || `legacy:${hashRecord('PaperCampaignEvent', event).slice(7)}`))
        .filter((externalActionId) => !completed.has(externalActionId));
      const expected = (input.unresolvedExternalActions || [])
        .map((entry) => String(entry.externalActionId)).sort();
      if (!unresolved.length
        || [...unresolved].sort().join('\0') !== expected.join('\0')) {
        throw new Error('campaign_node_external_outcome_uncertain_audit_conflict');
      }
      required(transaction, S.recoverLeaseUncertain, [
        JSON.stringify(input.failureDetail), input.failureHash, now,
        node.nodeId, campaignId, node.leaseOwner, node.attemptId,
        Number(node.leaseGeneration), expired ? 1 : 0, now,
        expired ? 1 : 0, node.leaseOwner, campaignId,
      ], 'campaign_lease_recovery_failed');
    } else {
      const decrementAttempt = node.status === 'running' ? 1 : 0;
      required(transaction, S.recoverLease, [
        decrementAttempt, now, node.nodeId, campaignId, node.status,
        node.leaseOwner, node.attemptId, node.attemptId,
        Number(node.leaseGeneration), decrementAttempt,
        expired ? 1 : 0, now, expired ? 1 : 0, node.leaseOwner, campaignId,
      ], 'campaign_lease_recovery_failed');
      if (disposition === 'pre_external_action_refund_requeue') {
        const refund = infrastructureRefundFromEvents(transaction, input);
        if (refund.agentCalls !== Number(input.refund?.agentCalls)
          || refund.cpuJobs !== Number(input.refund?.cpuJobs)
          || refund.gpuJobs !== Number(input.refund?.gpuJobs)) {
          throw new Error('campaign_node_infrastructure_refund_audit_conflict');
        }
        required(transaction, S.recoverLeaseUsage, [
          refund.agentCalls, refund.cpuJobs, refund.gpuJobs, now, campaignId,
          refund.agentCalls, refund.cpuJobs, refund.gpuJobs,
        ], 'campaign_lease_recovery_failed');
      }
    }
    return insertNativeStoreCampaignEvent(transaction, eventRow);
  }
  if (operationId === O.renewNodeLease) return required(transaction, S.renewLease, [
    input.expires, input.now, input.nodeId, input.workerId, input.attemptId,
    Number(input.leaseGeneration), input.now,
  ], 'campaign_node_lease_renew_failed');
  if (operationId === O.claimReady) return required(transaction, S.claimNode, [
    input.workerId, input.expires, input.attemptId, input.now,
    input.node.nodeId, input.campaignId, input.node.nodeRevision, input.campaignId,
  ], 'campaign_node_claim_failed');
  throw new Error('native_store_campaign_lease_operation_invalid');
}

function applyStartNode(transaction, input) {
  const { before, now, nodeId, workerId, attemptId, leaseGeneration } = input;
  const usage = nativeStoreCampaignUsageParameters(input.usageDelta);
  required(transaction, S.startNode, [
    now, nodeId, workerId, attemptId, Number(leaseGeneration), now,
  ], 'campaign_node_start_failed');
  required(transaction, S.startNodeCampaign, [
    before.kind, Math.max(0, Number(before.roundIndex || 0)), ...usage.set,
    now, before.campaignId, ...usage.budget,
  ], 'campaign_node_budget_reservation_failed');
  insertNativeStoreCampaignEvent(transaction, input.eventRow);
}

function infrastructureAttemptEvents(transaction, input) {
  const nodeId = input.nodeId || input.node.nodeId;
  const attemptId = input.attemptId || input.node.attemptId;
  const leaseGeneration = Number(input.leaseGeneration ?? input.node.leaseGeneration);
  const rows = transaction.all(
    S.infrastructureReservationEvents,
    input.node.campaignId,
    nodeId,
    attemptId,
    leaseGeneration,
  );
  const events = rows.map((row) => {
    let event;
    try { event = JSON.parse(row.event_json); }
    catch { throw new Error('campaign_node_infrastructure_event_invalid'); }
    if (hashRecord('PaperCampaignEvent', event) !== row.event_sha256
      || event.campaignId !== input.node.campaignId
      || event.nodeId !== nodeId
      || event.detail?.attemptId !== attemptId
      || Number(event.detail?.leaseGeneration) !== leaseGeneration) {
      throw new Error('campaign_node_infrastructure_event_invalid');
    }
    return event;
  });
  return events;
}

function infrastructureRefundFromEvents(transaction, input) {
  const events = infrastructureAttemptEvents(transaction, input);
  const nodeId = input.nodeId || input.node.nodeId;
  const attemptId = input.attemptId || input.node.attemptId;
  const leaseGeneration = Number(input.leaseGeneration ?? input.node.leaseGeneration);
  if (events.some((event) => event.kind === 'campaign_node_external_action_started')) {
    throw new Error('campaign_node_infrastructure_external_action_may_have_started');
  }
  const reservations = events
    .filter((event) => [
      'campaign_node_started',
      'campaign_node_infrastructure_subreservation',
    ].includes(event.kind))
    .map((event) => assertNativeStoreNodeInfrastructureReservation(
      event.detail?.infrastructureReservation,
      {
        campaignId: input.node.campaignId,
        nodeId,
        attemptId,
        leaseGeneration,
      },
    ));
  if (events.filter((event) => event.kind === 'campaign_node_started').length !== 1
    || new Set(reservations.map((entry) => entry.reservationId)).size
      !== reservations.length) {
    throw new Error('campaign_node_infrastructure_reservation_invalid');
  }
  return Object.freeze({
    agentCalls: reservations.reduce((total, entry) => total + entry.usage.agentCalls, 0),
    cpuJobs: reservations.reduce((total, entry) => total + entry.usage.cpuJobs, 0),
    gpuJobs: reservations.reduce((total, entry) => total + entry.usage.gpuJobs, 0),
  });
}

function applyCancelNodeInfrastructureDeferred(transaction, input) {
  const { node, now, nodeId, workerId, attemptId, leaseGeneration } = input;
  const refund = infrastructureRefundFromEvents(transaction, input);
  if (refund.agentCalls !== Number(input.refund?.agentCalls)
    || refund.cpuJobs !== Number(input.refund?.cpuJobs)
    || refund.gpuJobs !== Number(input.refund?.gpuJobs)
    || input.eventRow?.payload?.detail?.refundedUsage?.agentCalls !== refund.agentCalls
    || input.eventRow?.payload?.detail?.refundedUsage?.cpuJobs !== refund.cpuJobs
    || input.eventRow?.payload?.detail?.refundedUsage?.gpuJobs !== refund.gpuJobs) {
    throw new Error('campaign_node_infrastructure_refund_audit_conflict');
  }
  required(transaction, S.cancelInfrastructureNode, [
    now, nodeId, workerId, attemptId, Number(leaseGeneration),
    Number(node.attemptCount), now,
  ], 'campaign_node_infrastructure_cancel_failed');
  required(transaction, S.cancelInfrastructureUsage, [
    refund.agentCalls,
    refund.cpuJobs,
    refund.gpuJobs,
    now, node.campaignId,
    refund.agentCalls,
    refund.cpuJobs,
    refund.gpuJobs,
  ], 'campaign_node_infrastructure_cancel_failed');
  insertNativeStoreCampaignEvent(transaction, input.eventRow);
}

function applyReserveNodeInfrastructureUsage(transaction, input) {
  required(transaction, S.reserveInfrastructureNode, [
    input.nodeId, input.workerId, input.attemptId,
    Number(input.leaseGeneration), input.now,
  ], 'campaign_node_infrastructure_reservation_failed');
  const usage = nativeStoreCampaignUsageParameters(input.usageDelta);
  required(transaction, S.reserveInfrastructureUsage, [
    ...usage.set,
    input.now,
    input.node.campaignId,
    ...usage.budget,
  ], 'campaign_node_infrastructure_reservation_failed');
  insertNativeStoreCampaignEvent(transaction, input.eventRow);
}

function applyMarkNodeExternalActionStarted(transaction, input) {
  const descriptor = assertCampaignExternalActionDescriptor(input.descriptor, {
    campaignId: input.node.campaignId,
    nodeId: input.nodeId,
  });
  const events = transaction.all(
    S.externalActionEvents,
    input.node.campaignId,
    input.nodeId,
    descriptor.externalActionId,
  ).map((row) => {
    let event;
    try { event = JSON.parse(row.event_json); }
    catch { throw new Error('campaign_external_action_event_invalid'); }
    if (hashRecord('PaperCampaignEvent', event) !== row.event_sha256) {
      throw new Error('campaign_external_action_event_invalid');
    }
    assertCampaignExternalActionDescriptor(event.detail, descriptor);
    return event;
  });
  if (events.some((event) => (
    event.kind === 'campaign_node_external_action_completed'
    || (event.kind === 'campaign_node_external_action_started'
      && event.detail?.attemptId === input.attemptId
      && Number(event.detail?.leaseGeneration) === Number(input.leaseGeneration))
  ))) throw new Error('campaign_external_action_already_recorded');
  required(transaction, S.markInfrastructureStartedNode, [
    input.nodeId, input.workerId, input.attemptId,
    Number(input.leaseGeneration), Number(input.node.nodeRevision), input.now,
  ], 'campaign_node_external_action_started_failed');
  insertNativeStoreCampaignEvent(transaction, input.eventRow);
}

function applyCompleteNodeExternalAction(transaction, input) {
  const descriptor = assertCampaignExternalActionDescriptor(input.descriptor, {
    campaignId: input.node.campaignId,
    nodeId: input.nodeId,
  });
  assertCampaignExternalActionOutcome(
    input.completed?.payload,
    input.completed?.outcomeHash,
  );
  const events = transaction.all(
    S.externalActionEvents,
    input.node.campaignId,
    input.nodeId,
    descriptor.externalActionId,
  ).map((row) => {
    let event;
    try { event = JSON.parse(row.event_json); }
    catch { throw new Error('campaign_external_action_event_invalid'); }
    if (hashRecord('PaperCampaignEvent', event) !== row.event_sha256) {
      throw new Error('campaign_external_action_event_invalid');
    }
    assertCampaignExternalActionDescriptor(event.detail, descriptor);
    return event;
  });
  if (events.some((event) => (
    event.kind === 'campaign_node_external_action_completed'
  ))) throw new Error('campaign_external_action_already_recorded');
  if (!events.some((event) => (
    event.kind === 'campaign_node_external_action_started'
      && event.detail?.attemptId === input.attemptId
      && Number(event.detail?.leaseGeneration) === Number(input.leaseGeneration)
  ))) throw new Error('campaign_external_action_start_missing');
  required(transaction, S.markInfrastructureCompletedNode, [
    input.nodeId, input.workerId, input.attemptId,
    Number(input.leaseGeneration), Number(input.node.nodeRevision), input.now,
  ], 'campaign_external_action_completion_failed');
  runNativeStoreCampaignUsage(transaction, S.updateCampaignUsage, {
    campaignId: input.node.campaignId,
    delta: input.usageDelta,
    now: input.now,
    required: true,
  });
  insertNativeStoreCampaignEvent(transaction, input.eventRow);
}

function terminalSiblingSettlement({ sibling, input }) {
  const integrationStatus = String(sibling.prepared_integration_status || 'none');
  const outcomeUncertain = integrationStatus === 'integrating'
    || (sibling.status !== 'queued' && integrationStatus === 'integrated');
  const status = outcomeUncertain ? 'external_outcome_uncertain' : 'skipped';
  const failureClass = outcomeUncertain
    ? 'campaign_terminal_sibling_outcome_uncertain'
    : 'campaign_terminal_sibling_cancelled';
  const failureDetail = Object.freeze({
    reason: failureClass,
    terminalNodeId: input.nodeId,
    terminalFailureHash: input.failureHash,
    previousStatus: sibling.status,
    previousLeaseOwner: sibling.lease_owner || null,
    previousAttemptId: sibling.attempt_id || null,
    previousLeaseGeneration: Number(sibling.lease_generation || 0),
    previousNodeRevision: Number(sibling.node_revision || 0),
    preparedIntegrationStatus: integrationStatus,
  });
  const failureHash = hashRecord('PaperCampaignNodeFailure', failureDetail);
  const payload = Object.freeze({
    version: 1,
    kind: 'campaign_terminal_sibling_settled',
    campaignId: sibling.campaign_id,
    nodeId: sibling.node_id,
    detail: Object.freeze({
      status,
      failureClass,
      failureHash,
      ...failureDetail,
    }),
    createdAt: input.now,
  });
  const eventHash = hashRecord('PaperCampaignEvent', payload);
  return Object.freeze({
    status,
    failureClass,
    failureDetail,
    failureHash,
    event: Object.freeze({
      eventId: `${sibling.campaign_id}:${input.now}:${eventHash.slice(-16)}`,
      campaignId: sibling.campaign_id,
      nodeId: sibling.node_id,
      kind: payload.kind,
      payload,
      eventHash,
      createdAt: input.now,
    }),
  });
}

function applyFailNode(transaction, input) {
  const { node, now, nodeId, workerId, attemptId, leaseGeneration } = input;
  required(transaction, input.abandonPreparedResult
    ? S.failNodeAbandonPrepared : S.failNodePreservePrepared, [
    input.status, input.failureClass, JSON.stringify(input.failureDetail),
    input.failureHash, now, nodeId, workerId, attemptId,
    Number(leaseGeneration), now,
  ], 'campaign_node_failure_failed');
  if (input.status === 'failed_terminal') {
    const siblings = transaction.all(
      S.inspectTerminalSiblingNodes,
      node.campaignId,
      nodeId,
    );
    for (const sibling of siblings) {
      const settlement = terminalSiblingSettlement({ sibling, input });
      required(transaction, S.settleTerminalSiblingNodes, [
        settlement.status,
        settlement.failureClass,
        JSON.stringify(settlement.failureDetail),
        settlement.failureHash,
        now,
        sibling.node_id,
        node.campaignId,
        sibling.status,
        sibling.lease_owner || null,
        sibling.lease_owner || null,
        sibling.attempt_id || null,
        sibling.attempt_id || null,
        Number(sibling.lease_generation || 0),
        Number(sibling.node_revision || 0),
        String(sibling.prepared_integration_status || 'none'),
      ], 'campaign_terminal_sibling_settlement_failed');
      insertNativeStoreCampaignEvent(transaction, settlement.event);
    }
  }
  runNativeStoreCampaignUsage(transaction, S.updateCampaignUsage, {
    campaignId: node.campaignId, delta: input.usageDelta, now, required: true,
  });
  insertNativeStoreCampaignEvent(transaction, input.eventRow);
  projectNativeStoreCampaign(transaction, { campaignId: node.campaignId, now });
}

function applyPreparedMutation(transaction, operationId, input) {
  const base = [
    input.nodeId, input.workerId, input.attemptId,
    Number(input.leaseGeneration), input.now,
  ];
  if (operationId === O.prepareNodeResult) {
    required(transaction, S.prepareNode, [
      JSON.stringify(input.result), input.resultHash, input.attemptId, input.now,
      input.requiresIntegration ? 1 : 0, input.integrationKey || null,
      input.requiresIntegration ? 'pending' : 'none', input.now, ...base,
    ], 'campaign_node_result_prepare_failed');
  } else if (operationId === O.beginNodeResultIntegration) {
    required(transaction, S.beginIntegrationNode, [
      input.now, input.integrationExpires, input.integrationExpires,
      input.now, ...base, input.integrationKey,
    ], 'campaign_node_result_integration_begin_failed');
  } else if (operationId === O.markNodeResultIntegrated) {
    required(transaction, S.markIntegratedNode, [
      JSON.stringify(input.integrationReceipt), input.receiptHash,
      input.now, input.now, ...base, input.integrationKey,
    ], 'campaign_node_result_integration_mark_failed');
  } else {
    throw new Error('native_store_campaign_prepared_operation_invalid');
  }
  insertNativeStoreCampaignEvent(transaction, input.eventRow);
}

function publishRelease(transaction, input) {
  const r = input.releasePromotionReceipt;
  if (!r) return;
  required(transaction, S.publishCurrentRelease, [
    r.campaignId, r.paperId, r.campaignPlanHash, r.packageNodeId,
    r.packageAttemptId, r.leaseGeneration, r.packageResultHash,
    r.integrationDescriptorHash, r.integrationReceiptHash,
    r.campaignReleaseBundleHash, r.materializationReceiptHash,
    JSON.stringify(input.prepared.releaseBundle), JSON.stringify(r),
    r.campaignReleasePromotionReceiptHash, r.packageCompletedAt, r.promotedAt,
    input.nodeId, input.node.campaignId, input.attemptId,
    Number(input.leaseGeneration), input.node.preparedResultHash,
    r.integrationDescriptorHash, r.integrationReceiptHash,
    r.campaignReleaseBundleHash, r.materializationReceiptHash,
    r.paperId, r.campaignPlanHash,
  ], 'campaign_release_promotion_failed');
}

function applyCompleteNode(transaction, input) {
  const { node, now } = input;
  required(transaction, S.completeNode, [
    now, now, input.role, input.reviewerId, input.childSessionId,
    input.reviewHash, input.promptHash, input.resolvedModel, input.nodeId,
    input.workerId, input.attemptId, Number(input.leaseGeneration),
    now, node.preparedResultHash,
  ], 'campaign_node_complete_failed');
  runNativeStoreCampaignUsage(transaction, S.updateCampaignUsage, {
    campaignId: node.campaignId, delta: input.usageDelta, now, required: true,
  });
  insertNativeStoreCampaignEvent(transaction, input.eventRow);
  projectNativeStoreCampaign(transaction, { campaignId: node.campaignId, now });
  publishRelease(transaction, input);
}

export function applyNativeStoreCampaignMutation(transaction, operationId, input) {
  if (operationId === O.assertLiveNodeAttempt) {
    return applyAssertLiveNodeAttempt(transaction, input);
  }
  if (operationId === O.createCampaign) return applyCreateCampaign(transaction, input);
  if ([
    O.skipFutureRounds, O.pauseCampaign, O.resumeCampaign,
    O.cancelCampaign, O.failCampaign, O.stopCampaign,
  ].includes(operationId)) return applyLifecycleMutation(transaction, operationId, input);
  if (operationId === O.extendCampaign) return applyExtendCampaign(transaction, input);
  if (operationId === O.cancelNode) return applyCancelNode(transaction, input);
  if (operationId === O.retryNode) return applyRetryNode(transaction, input);
  if (operationId === O.recordUsage) return runNativeStoreCampaignUsage(
    transaction, S.recordUsage, input,
  );
  if ([O.recoverExpiredLeases, O.renewNodeLease, O.claimReady].includes(operationId)) {
    return applyLeaseMutation(transaction, operationId, input);
  }
  if (operationId === O.startNode) return applyStartNode(transaction, input);
  if (operationId === O.reserveNodeInfrastructureUsage) {
    return applyReserveNodeInfrastructureUsage(transaction, input);
  }
  if (operationId === O.markNodeExternalActionStarted) {
    return applyMarkNodeExternalActionStarted(transaction, input);
  }
  if (operationId === O.completeNodeExternalAction) {
    return applyCompleteNodeExternalAction(transaction, input);
  }
  if (operationId === O.cancelNodeInfrastructureDeferred) {
    return applyCancelNodeInfrastructureDeferred(transaction, input);
  }
  if (operationId === O.failNode) return applyFailNode(transaction, input);
  if ([
    O.prepareNodeResult, O.beginNodeResultIntegration, O.markNodeResultIntegrated,
  ].includes(operationId)) return applyPreparedMutation(transaction, operationId, input);
  if (operationId === O.completeNode) return applyCompleteNode(transaction, input);
  throw new Error('native_store_campaign_operation_invalid');
}

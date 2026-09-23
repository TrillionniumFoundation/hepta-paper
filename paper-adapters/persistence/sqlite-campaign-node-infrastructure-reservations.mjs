import { sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertCampaignExternalActionDescriptor,
  assertCampaignExternalActionOutcome,
} from '../../paper-domain/automation/campaign-external-action-journal-contract.mjs';
import {
  assertNativeStoreNodeInfrastructureReservation,
} from './native-store-campaign-mutation-plan.mjs';

const RESERVATION_EVENT_KINDS = Object.freeze([
  'campaign_node_started',
  'campaign_node_infrastructure_subreservation',
]);

export function infrastructureControlError(error) {
  return error?.committed === true
    || error?.stateRecoverabilityFatal === true
    || error?.stateRecoverabilityDeferred === true
    || error?.authorityEvidenceRenewalFatal === true
    || error?.authorityEvidenceRenewalDeferred === true
    || error?.residentReactivationRequired === true;
}

export function refundableNodeInfrastructureReservation(store, {
  campaignId, nodeId, attemptId, leaseGeneration,
} = {}) {
  const inspection = inspectNodeInfrastructureAttempt(store, {
    campaignId, nodeId, attemptId, leaseGeneration,
  });
  if (inspection.unresolvedExternalActions.length) {
    throw new Error('campaign_node_infrastructure_external_action_may_have_started');
  }
  return inspection.refundableUsage;
}

export function inspectNodeInfrastructureAttempt(store, {
  campaignId, nodeId, attemptId, leaseGeneration,
} = {}) {
  const result = store.query(
    `SELECT event_json,event_sha256 FROM campaign_events
      WHERE campaign_id=${sqlText(campaignId)} AND node_id=${sqlText(nodeId)}
        AND kind IN ('campaign_node_started',
          'campaign_node_infrastructure_subreservation',
          'campaign_node_external_action_started',
          'campaign_node_external_action_completed')
        AND json_extract(event_json,'$.detail.attemptId')=${sqlText(attemptId)}
        AND CAST(json_extract(event_json,'$.detail.leaseGeneration') AS INTEGER)=${Number(leaseGeneration)}
      ORDER BY created_at,event_id;`,
  );
  const events = result.rows.map((row) => {
    let event;
    try { event = JSON.parse(row.event_json); }
    catch { throw new Error('campaign_node_infrastructure_event_invalid'); }
    if (hashRecord('PaperCampaignEvent', event) !== row.event_sha256
      || event.campaignId !== campaignId || event.nodeId !== nodeId
      || event.detail?.attemptId !== attemptId
      || Number(event.detail?.leaseGeneration) !== Number(leaseGeneration)) {
      throw new Error('campaign_node_infrastructure_event_invalid');
    }
    return event;
  });
  const reservationEvents = events.filter((event) => (
    RESERVATION_EVENT_KINDS.includes(event.kind)
  ));
  if (reservationEvents.filter((event) => event.kind === 'campaign_node_started').length
    !== 1) {
    throw new Error('campaign_node_infrastructure_reservation_invalid');
  }
  const identity = { campaignId, nodeId, attemptId, leaseGeneration };
  const reservations = reservationEvents.map((event) => (
    assertNativeStoreNodeInfrastructureReservation(
      event.detail?.infrastructureReservation,
      identity,
    )
  ));
  if (new Set(reservations.map((entry) => entry.reservationId)).size
    !== reservations.length) {
    throw new Error('campaign_node_infrastructure_reservation_invalid');
  }
  const started = events.filter((event) => (
    event.kind === 'campaign_node_external_action_started'
  )).map((event) => Object.freeze({
    externalActionId: String(event.detail?.externalActionId
      || `legacy:${hashRecord('PaperCampaignEvent', event).slice(7)}`),
    action: String(event.detail?.action || 'unspecified'),
    requestDigest: event.detail?.requestDigest || null,
    resolverKind: event.detail?.resolverKind || 'legacy-unqualified',
    actionOrdinal: Number(event.detail?.actionOrdinal || 0),
    campaignPlanHash: event.detail?.campaignPlanHash || null,
    nodeSemanticSpecHash: event.detail?.nodeSemanticSpecHash || null,
    attemptId,
    leaseGeneration: Number(leaseGeneration),
  }));
  const completedIds = new Set(events.filter((event) => (
    event.kind === 'campaign_node_external_action_completed'
  )).map((event) => String(event.detail?.externalActionId || '')));
  const unresolvedExternalActions = started.filter((entry) => (
    !completedIds.has(entry.externalActionId)
  ));
  const refundableUsage = Object.freeze({
    agentCalls: reservations.reduce((sum, entry) => sum + entry.usage.agentCalls, 0),
    cpuJobs: reservations.reduce((sum, entry) => sum + entry.usage.cpuJobs, 0),
    gpuJobs: reservations.reduce((sum, entry) => sum + entry.usage.gpuJobs, 0),
  });
  return Object.freeze({
    refundableUsage,
    externalActions: Object.freeze(started),
    unresolvedExternalActions: Object.freeze(unresolvedExternalActions),
  });
}

export function readNodeExternalAction(store, {
  campaignId,
  nodeId,
  externalActionId,
} = {}) {
  const result = store.query(
    `SELECT event_json,event_sha256 FROM campaign_events
      WHERE campaign_id=${sqlText(campaignId)} AND node_id=${sqlText(nodeId)}
        AND kind IN ('campaign_node_external_action_started',
          'campaign_node_external_action_completed')
        AND json_extract(event_json,'$.detail.externalActionId')=${sqlText(externalActionId)}
      ORDER BY created_at,event_id;`,
  );
  const events = result.rows.map((row) => {
    let event;
    try { event = JSON.parse(row.event_json); }
    catch { throw new Error('campaign_external_action_event_invalid'); }
    if (hashRecord('PaperCampaignEvent', event) !== row.event_sha256
      || event.campaignId !== campaignId || event.nodeId !== nodeId
      || event.detail?.externalActionId !== externalActionId) {
      throw new Error('campaign_external_action_event_invalid');
    }
    return event;
  });
  if (!events.length) return null;
  const started = events.filter((event) => (
    event.kind === 'campaign_node_external_action_started'
  ));
  if (!started.length) throw new Error('campaign_external_action_start_missing');
  const descriptor = assertCampaignExternalActionDescriptor(
    started[0].detail,
    { campaignId, nodeId },
  );
  for (const event of started.slice(1)) {
    assertCampaignExternalActionDescriptor(event.detail, descriptor);
  }
  const completed = events.filter((event) => (
    event.kind === 'campaign_node_external_action_completed'
  ));
  let outcome = null;
  for (const event of completed) {
    assertCampaignExternalActionDescriptor(event.detail, descriptor);
    const candidate = assertCampaignExternalActionOutcome(
      event.detail?.outcomePayload,
      event.detail?.outcomeHash,
    );
    if (outcome && outcome.outcomeHash !== candidate.outcomeHash) {
      throw new Error('campaign_external_action_outcome_conflict');
    }
    outcome = candidate;
  }
  return Object.freeze({
    ...descriptor,
    status: outcome ? 'completed' : 'started',
    outcomePayload: outcome?.payload ?? null,
    outcomeHash: outcome?.outcomeHash || null,
    startedAttempts: Object.freeze(started.map((event) => Object.freeze({
      attemptId: event.detail.attemptId,
      leaseGeneration: Number(event.detail.leaseGeneration),
      startedAt: event.createdAt,
    }))),
    completedAt: completed.at(-1)?.createdAt || null,
  });
}

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function infrastructureCount(value, field) {
  const count = Number(value || 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`campaign_node_infrastructure_${field}_invalid`);
  }
  return count;
}

export function normalizeNativeStoreNodeInfrastructureUsage(delta = {}) {
  return Object.freeze({
    agentCalls: infrastructureCount(delta.agentCalls, 'agent_calls'),
    cpuJobs: infrastructureCount(delta.cpuJobs, 'cpu_jobs'),
    gpuJobs: infrastructureCount(delta.gpuJobs, 'gpu_jobs'),
  });
}

export function buildNativeStoreNodeInfrastructureReservation({
  reservationId,
  campaignId,
  nodeId,
  attemptId,
  leaseGeneration,
  usageDelta,
} = {}) {
  if (!reservationId || !campaignId || !nodeId || !attemptId
    || !Number.isSafeInteger(Number(leaseGeneration))
    || Number(leaseGeneration) < 1) {
    throw new Error('campaign_node_infrastructure_reservation_identity_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    reservationId: String(reservationId),
    campaignId: String(campaignId),
    nodeId: String(nodeId),
    attemptId: String(attemptId),
    leaseGeneration: Number(leaseGeneration),
    usage: normalizeNativeStoreNodeInfrastructureUsage(usageDelta),
  });
  return Object.freeze({
    ...payload,
    reservationHash: hashRecord('CampaignNodeInfrastructureReservation', payload),
  });
}

export function assertNativeStoreNodeInfrastructureReservation(
  reservation,
  expected = {},
) {
  const rebuilt = buildNativeStoreNodeInfrastructureReservation({
    reservationId: reservation?.reservationId,
    campaignId: reservation?.campaignId,
    nodeId: reservation?.nodeId,
    attemptId: reservation?.attemptId,
    leaseGeneration: reservation?.leaseGeneration,
    usageDelta: reservation?.usage,
  });
  if (rebuilt.reservationHash !== reservation?.reservationHash
    || (expected.campaignId && rebuilt.campaignId !== expected.campaignId)
    || (expected.nodeId && rebuilt.nodeId !== expected.nodeId)
    || (expected.attemptId && rebuilt.attemptId !== expected.attemptId)
    || (expected.leaseGeneration !== undefined
      && rebuilt.leaseGeneration !== Number(expected.leaseGeneration))) {
    throw new Error('campaign_node_infrastructure_reservation_invalid');
  }
  return rebuilt;
}

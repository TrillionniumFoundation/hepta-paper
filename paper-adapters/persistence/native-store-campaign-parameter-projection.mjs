export function nativeStoreCampaignEventParameters(event) {
  return Object.freeze([
    event.eventId,
    event.payload.campaignId,
    event.payload.nodeId,
    event.payload.kind,
    JSON.stringify(event.payload),
    event.eventHash,
    event.createdAt,
  ]);
}

export function nativeStoreCampaignProjectionParameters({ campaignId, now } = {}) {
  return Object.freeze([
    now,
    'package',
    'release-package',
    'package',
    'release-package',
    now,
    campaignId,
  ]);
}

export function nativeStoreCampaignUsageParameters(delta = {}) {
  const costProvided = Object.prototype.hasOwnProperty.call(delta, 'costUsd')
    && Number.isFinite(Number(delta.costUsd));
  const agent = Math.max(0, Number(delta.agentCalls || 0));
  const cpu = Math.max(0, Number(delta.cpuJobs || 0));
  const gpu = Math.max(0, Number(delta.gpuJobs || 0));
  const tokens = Math.max(0, Number(delta.tokens || 0));
  const cost = costProvided ? Math.max(0, Number(delta.costUsd)) : 0;
  const priced = costProvided ? Math.max(0, Number(delta.pricedAgentCalls ?? 1)) : 0;
  return Object.freeze({
    set: Object.freeze([agent, cpu, gpu, tokens, cost, priced, agent, priced]),
    budget: Object.freeze([agent, cpu, gpu, tokens, costProvided ? 1 : 0, cost]),
  });
}

export function assertNativeStoreCampaignMutationChanged(result, code) {
  if (Number(result?.changes || 0) !== 1) throw new Error(code);
  return result;
}

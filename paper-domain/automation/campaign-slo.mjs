import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function statusCounts(items = []) {
  return Object.fromEntries([...items.reduce((counts, item) => {
    const status = String(item.status || 'unknown');
    counts.set(status, (counts.get(status) || 0) + 1);
    return counts;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right)));
}

function histogram(values, bounds) {
  const sorted = [...values].sort((left, right) => left - right);
  return [...bounds.map((bound) => ({ le: bound, count: sorted.filter((value) => value <= bound).length })), { le: '+Inf', count: sorted.length }];
}

export function buildCampaignSloReport({ campaigns = [], nodes = [], events = [], telemetrySamples = [], runtimeBytes = 0, targets = {} } = {}) {
  const configured = {
    minimumTerminalNodeSuccessRate: Number(targets.minimumTerminalNodeSuccessRate ?? 0.95),
    maximumQueueWaitP95Ms: Number(targets.maximumQueueWaitP95Ms ?? 15 * 60 * 1000),
    maximumRecoveryP95Ms: Number(targets.maximumRecoveryP95Ms ?? 5 * 60 * 1000),
    maximumRuntimeBytes: Number(targets.maximumRuntimeBytes ?? 10 * 1024 ** 3),
  };
  const eventsByNode = new Map();
  const completedAtByNode = new Map();
  for (const row of events) {
    const nodeId = row.nodeId || row.event?.nodeId;
    if (!nodeId) continue;
    const values = eventsByNode.get(nodeId) || [];
    values.push({ kind: row.kind || row.event?.kind, at: Date.parse(row.createdAt || row.event?.createdAt), row });
    eventsByNode.set(nodeId, values);
    if ((row.kind || row.event?.kind) === 'campaign_node_completed') completedAtByNode.set(nodeId, Date.parse(row.createdAt || row.event?.createdAt));
  }
  const queueWaits = [];
  const recoveryTimes = [];
  for (const node of nodes) {
    const timeline = (eventsByNode.get(node.nodeId) || []).filter((item) => Number.isFinite(item.at)).sort((left, right) => left.at - right.at);
    const started = timeline.find((item) => item.kind === 'campaign_node_started');
    const dependencyReadyTimes = (node.dependencies || []).map((dependency) => completedAtByNode.get(dependency)).filter(Number.isFinite);
    const createdAt = Date.parse(node.createdAt);
    const readyAt = dependencyReadyTimes.length === (node.dependencies || []).length && dependencyReadyTimes.length
      ? Math.max(...dependencyReadyTimes)
      : createdAt;
    if (started && Number.isFinite(readyAt) && started.at >= readyAt) queueWaits.push(started.at - readyAt);
    for (let index = 0; index < timeline.length; index += 1) {
      if (!['campaign_node_retry_queued', 'campaign_node_manually_retried', 'campaign_node_lease_recovered'].includes(timeline[index].kind)) continue;
      const resumed = timeline.slice(index + 1).find((item) => item.kind === 'campaign_node_started');
      if (resumed) recoveryTimes.push(Math.max(0, resumed.at - timeline[index].at));
    }
  }
  const terminalNodes = nodes.filter((node) => ['completed', 'failed_terminal'].includes(node.status));
  const completedNodes = terminalNodes.filter((node) => node.status === 'completed').length;
  const successRate = terminalNodes.length ? completedNodes / terminalNodes.length : null;
  const unknownCostCampaigns = campaigns.filter((campaign) => campaign.costKnown === false || campaign.costUsd === null).length;
  const phaseNames = ['dispatch', 'lockAcquire', 'command', 'lockRelease', 'total'];
  const phaseTimings = Object.fromEntries(phaseNames.map((phase) => [phase, telemetrySamples.map((sample) => Number(sample?.phases?.[phase])).filter(Number.isFinite)]));
  const lockWaits = telemetrySamples.map((sample) => Number(sample.lockWaitMs)).filter(Number.isFinite);
  const queueContention = telemetrySamples.map((sample) => Number(sample.queueContentionCount)).filter(Number.isFinite);
  const observed = {
    campaignCounts: statusCounts(campaigns),
    nodeCounts: statusCounts(nodes),
    terminalNodeSuccessRate: successRate,
    queueWaitP50Ms: percentile(queueWaits, 0.5),
    queueWaitP95Ms: percentile(queueWaits, 0.95),
    recoveryP50Ms: percentile(recoveryTimes, 0.5),
    recoveryP95Ms: percentile(recoveryTimes, 0.95),
    sampleCounts: { queueWait: queueWaits.length, recovery: recoveryTimes.length, telemetry: telemetrySamples.length, lockWait: lockWaits.length, queueContention: queueContention.length },
    phaseTimingP95Ms: Object.fromEntries(phaseNames.map((phase) => [phase, percentile(phaseTimings[phase], 0.95)])),
    lockWaitP95Ms: percentile(lockWaits, 0.95),
    lockWaitHistogram: histogram(lockWaits, [0, 1, 5, 10, 50, 100, 500, 1000]),
    queueContentionHistogram: histogram(queueContention, [0, 1, 2, 5, 10]),
    retryEventCount: events.filter((row) => ['campaign_node_retry_queued', 'campaign_node_manually_retried'].includes(row.kind || row.event?.kind)).length,
    uniqueChildSessionCount: new Set(nodes.map((node) => node.childSessionId).filter(Boolean)).size,
    totalAgentCalls: campaigns.reduce((total, campaign) => total + Number(campaign.agentCallCount ?? 0), 0),
    totalCpuJobs: campaigns.reduce((total, campaign) => total + Number(campaign.cpuJobCount ?? 0), 0),
    totalGpuJobs: campaigns.reduce((total, campaign) => total + Number(campaign.gpuJobCount ?? 0), 0),
    totalTokens: campaigns.reduce((total, campaign) => total + Number(campaign.tokenCount ?? 0), 0),
    unknownCostCampaignCount: unknownCostCampaigns,
    runtimeBytes: Number(runtimeBytes || 0),
  };
  const objectives = {
    terminalNodeSuccessRate: successRate !== null && successRate >= configured.minimumTerminalNodeSuccessRate,
    queueWaitP95: observed.queueWaitP95Ms !== null && observed.queueWaitP95Ms <= configured.maximumQueueWaitP95Ms,
    recoveryP95: observed.recoveryP95Ms !== null && observed.recoveryP95Ms <= configured.maximumRecoveryP95Ms,
    runtimeQuota: observed.runtimeBytes <= configured.maximumRuntimeBytes,
    costsAuditable: unknownCostCampaigns === 0,
  };
  const objectiveStates = {
    terminalNodeSuccessRate: successRate === null ? 'insufficient_data' : objectives.terminalNodeSuccessRate ? 'met' : 'not_met',
    queueWaitP95: observed.queueWaitP95Ms === null ? 'insufficient_data' : objectives.queueWaitP95 ? 'met' : 'not_met',
    recoveryP95: observed.recoveryP95Ms === null ? 'insufficient_data' : objectives.recoveryP95 ? 'met' : 'not_met',
    runtimeQuota: objectives.runtimeQuota ? 'met' : 'not_met',
    costsAuditable: objectives.costsAuditable ? 'met' : 'not_met',
  };
  const payload = { version: 2, kind: 'CampaignSloReport', status: Object.values(objectives).every(Boolean) ? 'campaign_slos_met' : 'campaign_slos_not_met', targets: configured, observed, objectives, objectiveStates };
  return Object.freeze({ ...payload, campaignSloReportHash: hashRecord('CampaignSloReport', payload) });
}

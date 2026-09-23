function countsBy(items, key) {
  return Object.fromEntries([...items.reduce((counts, item) => {
    const value = String(item?.[key] || 'unknown');
    counts.set(value, (counts.get(value) || 0) + 1);
    return counts;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right)));
}

export function summarizeCampaign(campaign = {}) {
  return Object.freeze({
    campaignId: campaign.campaignId || null,
    paperId: campaign.paperId || null,
    status: campaign.status || null,
    effectiveStatus: campaign.effectiveStatus || campaign.status || null,
    currentPhase: campaign.currentPhase || null,
    currentReviewRound: Number(campaign.currentReviewRound ?? 0),
    maxRounds: Number(campaign.maxRounds ?? 0),
    usage: {
      agentCalls: Number(campaign.agentCallCount ?? 0),
      cpuJobs: Number(campaign.cpuJobCount ?? 0),
      gpuJobs: Number(campaign.gpuJobCount ?? 0),
      tokens: Number(campaign.tokenCount ?? 0),
      costUsd: campaign.costKnown === false ? 'unknown' : (campaign.costUsd ?? 'unknown'),
    },
    stopReason: campaign.stopReason || null,
    lineage: {
      parent: campaign.parentCampaignId || null,
      supersedes: campaign.supersedesCampaignId || null,
      recoveryOf: campaign.recoveryOfCampaignId || null,
    },
    updatedAt: campaign.updatedAt || null,
  });
}

export function summarizeNode(node = {}) {
  return Object.freeze({
    nodeId: node.nodeId || null,
    kind: node.kind || null,
    roundIndex: Number(node.roundIndex ?? 0),
    status: node.status || null,
    attemptCount: Number(node.attemptCount ?? 0),
    maxAttempts: Number(node.maxAttempts ?? 0),
    failureClass: node.failureClass || null,
    reviewerId: node.reviewerId || null,
    childSessionId: node.childSessionId || null,
    reviewHash: node.reviewHash || null,
    resolvedModel: node.resolvedModel || null,
    resultHash: node.resultSha256 || null,
    updatedAt: node.updatedAt || null,
  });
}

export function presentCampaignStatus(campaign, nodes = [], { details = false } = {}) {
  if (details) return Object.freeze({ campaign, nodes });
  const active = nodes.filter((node) => ['leased', 'running'].includes(node.status)).map(summarizeNode);
  const failed = nodes.filter((node) => node.status === 'failed_terminal').map(summarizeNode);
  return Object.freeze({ campaign: summarizeCampaign(campaign), nodeCounts: countsBy(nodes, 'status'), activeNodes: active, failedNodes: failed });
}

export function summarizePlan(plan = {}) {
  return Object.freeze({
    campaignId: plan.campaignId || null,
    paperId: plan.paperId || null,
    sourceWorkspace: plan.sourceWorkspace || null,
    maxRounds: Number(plan.maxRounds || 0),
    refereeCount: Number(plan.refereeCount || 0),
    languages: plan.languages || [],
    requiresGpu: Boolean(plan.requiresGpu),
    datasetCount: (plan.datasetMounts || []).length,
    nodeCount: (plan.nodes || []).length,
    campaignPlanHash: plan.campaignPlanHash || null,
  });
}

export function summarizeRun(result = {}) {
  const nodes = result.nodes || [];
  return Object.freeze({
    campaign: summarizeCampaign(result.campaign || {}),
    nodeCounts: countsBy(nodes, 'status'),
    eventCount: Number(result.eventCount || 0),
    executedNodeCount: Number(result.executedNodeCount || 0),
    retryCount: Number(result.retryCount || 0),
    maximumObservedConcurrency: Number(result.maximumObservedConcurrency || 0),
    resourceUsage: result.resourceUsage || null,
    externalActionPerformed: Boolean(result.externalActionPerformed),
  });
}

export function summarizeEvent(row = {}) {
  const event = row.event || {};
  return Object.freeze({
    eventId: row.eventId || null,
    campaignId: row.campaignId || event.campaignId || null,
    nodeId: row.nodeId || event.nodeId || null,
    kind: row.kind || event.kind || null,
    detail: event.detail || {},
    createdAt: row.createdAt || event.createdAt || null,
    eventHash: row.eventSha256 || null,
  });
}

export function presentNodeLog(node, { details = false } = {}) {
  if (!node) return null;
  if (details) return node;
  const result = node.result || {};
  const failure = node.failureDetail || {};
  return Object.freeze({
    node: summarizeNode(node),
    result: node.result ? {
      kind: result.kind || null,
      status: result.status || null,
      receiptHash: result.receiptHash || result.agentExecutionReceiptHash || result.multiLanguageEmpiricalReceiptHash || result.automationRepairExecutionReceiptHash || node.resultSha256 || null,
      blockers: Array.isArray(result.blockers) ? result.blockers : [],
      usage: result.usage || null,
      summary: result.summary || null,
    } : null,
    failure: node.failureDetail ? {
      message: failure.message || null,
      blockers: Array.isArray(failure.blockers) ? failure.blockers : [],
      receiptKind: failure.receiptKind || null,
      receiptStatus: failure.receiptStatus || null,
      receiptHash: failure.receiptHash || node.failureSha256 || null,
      stderrTail: String(failure.stderrTail || '').slice(-2000),
    } : null,
  });
}

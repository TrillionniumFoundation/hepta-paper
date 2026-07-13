function countsBy(items, key) {
  return Object.fromEntries([...items.reduce((counts, item) => {
    const value = String(item?.[key] || 'unknown');
    counts.set(value, (counts.get(value) || 0) + 1);
    return counts;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right)));
}

export function summarizeCampaign(campaign = {}) {
  return Object.freeze({
    campaignId: campaign.campaign_id || campaign.campaignId || null,
    paperId: campaign.paper_id || campaign.paperId || null,
    status: campaign.status || null,
    effectiveStatus: campaign.effectiveStatus || campaign.effective_status || campaign.status || null,
    currentPhase: campaign.currentPhase || campaign.current_phase || null,
    currentReviewRound: Number(campaign.currentReviewRound ?? campaign.current_review_round ?? 0),
    maxRounds: Number(campaign.maxRounds ?? campaign.max_rounds ?? 0),
    usage: {
      agentCalls: Number(campaign.agentCallCount ?? campaign.agent_call_count ?? 0),
      cpuJobs: Number(campaign.cpuJobCount ?? campaign.cpu_job_count ?? 0),
      gpuJobs: Number(campaign.gpuJobCount ?? campaign.gpu_job_count ?? 0),
      tokens: Number(campaign.tokenCount ?? campaign.token_count ?? 0),
      costUsd: campaign.costKnown === false ? 'unknown' : (campaign.costUsd ?? campaign.cost_usd ?? 'unknown'),
    },
    stopReason: campaign.stop_reason || campaign.stopReason || null,
    lineage: {
      parent: campaign.parentCampaignId || campaign.parent_campaign_id || null,
      supersedes: campaign.supersedesCampaignId || campaign.supersedes_campaign_id || null,
      recoveryOf: campaign.recoveryOfCampaignId || campaign.recovery_of_campaign_id || null,
    },
    updatedAt: campaign.updated_at || campaign.updatedAt || null,
  });
}

export function summarizeNode(node = {}) {
  return Object.freeze({
    nodeId: node.node_id || node.nodeId || null,
    kind: node.kind || null,
    roundIndex: Number(node.roundIndex ?? node.round_index ?? 0),
    status: node.status || null,
    attemptCount: Number(node.attemptCount ?? node.attempt_count ?? 0),
    maxAttempts: Number(node.maxAttempts ?? node.max_attempts ?? 0),
    failureClass: node.failure_class || node.failureClass || null,
    reviewerId: node.reviewerId || node.reviewer_id || null,
    childSessionId: node.childSessionId || node.child_session_id || null,
    reviewHash: node.reviewHash || node.review_hash || null,
    resolvedModel: node.resolvedModel || node.resolved_model || null,
    resultHash: node.result_sha256 || node.resultHash || null,
    updatedAt: node.updated_at || node.updatedAt || null,
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
    eventId: row.event_id || null,
    campaignId: row.campaign_id || event.campaignId || null,
    nodeId: row.node_id || event.nodeId || null,
    kind: row.kind || event.kind || null,
    detail: event.detail || {},
    createdAt: row.created_at || event.createdAt || null,
    eventHash: row.event_sha256 || null,
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
      receiptHash: result.receiptHash || result.agentExecutionReceiptHash || result.multiLanguageEmpiricalReceiptHash || result.automationRepairExecutionReceiptHash || node.result_sha256 || null,
      blockers: Array.isArray(result.blockers) ? result.blockers : [],
      usage: result.usage || null,
      summary: result.summary || null,
    } : null,
    failure: node.failureDetail ? {
      message: failure.message || null,
      blockers: Array.isArray(failure.blockers) ? failure.blockers : [],
      receiptKind: failure.receiptKind || null,
      receiptStatus: failure.receiptStatus || null,
      receiptHash: failure.receiptHash || node.failure_sha256 || null,
      stderrTail: String(failure.stderrTail || '').slice(-2000),
    } : null,
  });
}

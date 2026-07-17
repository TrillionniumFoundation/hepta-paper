import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { parseJsonOrThrow } from '../../workflow-kernel/runtime/data-utils.mjs';

function parseJson(value, fallback) {
  return value === null || value === undefined
    ? fallback
    : parseJsonOrThrow(value, 'campaign_row_json_invalid');
}

export function mapCampaignNodeRow(row) {
  if (!row) return null;

  const hasPreparedResult = row.prepared_result_json !== null && row.prepared_result_json !== undefined;
  const preparedResult = hasPreparedResult
    ? parseJsonOrThrow(row.prepared_result_json, 'campaign_prepared_result_json_invalid')
    : null;
  const preparedResultHash = row.prepared_result_sha256 || null;
  if (hasPreparedResult && hashRecord('PaperCampaignNodeResult', preparedResult) !== preparedResultHash) {
    const error = new Error('campaign_prepared_result_hash_invalid');
    error.code = 'campaign_prepared_result_hash_invalid';
    throw error;
  }

  const preparedRequiresIntegration = Boolean(Number(row.prepared_requires_integration || 0));
  const preparedIntegrationKey = row.prepared_integration_key || null;
  const descriptorHash = preparedResult?.workspaceAttemptIntegration?.workspaceAttemptIntegrationDescriptorHash || null;
  if (preparedRequiresIntegration && (!descriptorHash || descriptorHash !== preparedIntegrationKey)) {
    const error = new Error('campaign_prepared_integration_binding_invalid');
    error.code = 'campaign_prepared_integration_binding_invalid';
    throw error;
  }

  const hasIntegrationReceipt = row.prepared_integration_receipt_json !== null
    && row.prepared_integration_receipt_json !== undefined;
  const preparedIntegrationReceipt = hasIntegrationReceipt
    ? parseJsonOrThrow(row.prepared_integration_receipt_json, 'campaign_prepared_integration_receipt_json_invalid')
    : null;
  const preparedIntegrationReceiptHash = row.prepared_integration_receipt_sha256 || null;
  if (hasIntegrationReceipt) {
    const { workspaceAttemptIntegrationReceiptHash: claimedHash = null, ...receiptPayload } = preparedIntegrationReceipt;
    if (!claimedHash || claimedHash !== preparedIntegrationReceiptHash
      || hashRecord('WorkspaceAttemptIntegrationReceipt', receiptPayload) !== claimedHash
      || preparedIntegrationReceipt.descriptorHash !== preparedIntegrationKey) {
      const error = new Error('campaign_prepared_integration_receipt_invalid');
      error.code = 'campaign_prepared_integration_receipt_invalid';
      throw error;
    }
  }

  return Object.freeze({
    nodeId: row.node_id,
    campaignId: row.campaign_id,
    kind: row.kind,
    status: row.status,
    priority: Number(row.priority || 100),
    roundIndex: Number(row.round_index || 0),
    attemptCount: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || 3),
    attemptId: row.attempt_id || null,
    leaseGeneration: Number(row.lease_generation || 0),
    nodeRevision: Number(row.node_revision || 0),
    role: row.role || null,
    reviewerId: row.reviewer_id || null,
    childSessionId: row.child_session_id || null,
    reviewHash: row.review_hash || null,
    promptHash: row.prompt_hash || null,
    resolvedModel: row.resolved_model || null,
    dependencies: parseJson(row.dependencies_json, []),
    spec: parseJson(row.spec_json, {}),
    result: parseJson(row.result_json, null),
    preparedResult,
    preparedResultHash,
    preparedAttemptId: row.prepared_attempt_id || null,
    preparedAt: row.prepared_at || null,
    preparedRequiresIntegration,
    preparedIntegrationKey,
    preparedIntegrationStatus: row.prepared_integration_status || (preparedRequiresIntegration ? 'pending' : 'none'),
    preparedIntegrationStartedAt: row.prepared_integration_started_at || null,
    preparedIntegrationReceipt,
    preparedIntegrationReceiptHash,
    preparedIntegratedAt: row.prepared_integrated_at || null,
    integratedAt: row.integrated_at || null,
    failureDetail: parseJson(row.failure_json, null),
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: row.lease_expires_at || null,
    resultSha256: row.result_sha256 || null,
    failureClass: row.failure_class || null,
    failureSha256: row.failure_sha256 || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  });
}

export function mapCampaignRow(row) {
  if (!row) return null;
  const agentCallCount = Number(row.agent_call_count || 0);
  const pricedAgentCallCount = Number(row.priced_agent_call_count || 0);
  const costKnown = agentCallCount === pricedAgentCallCount;
  return Object.freeze({
    campaignId: row.campaign_id,
    paperId: row.paper_id,
    status: row.status,
    revision: Number(row.revision || 1),
    currentRound: Number(row.current_review_round ?? row.current_round ?? 0),
    currentReviewRound: Number(row.current_review_round ?? row.current_round ?? 0),
    currentPhase: row.current_phase || row.status || 'queued',
    maxRounds: Number(row.max_rounds || 1),
    accumulatedRunMs: Number(row.accumulated_run_ms || 0),
    agentCallCount,
    cpuJobCount: Number(row.cpu_job_count || 0),
    gpuJobCount: Number(row.gpu_job_count || 0),
    tokenCount: Number(row.token_count || 0),
    pricedAgentCallCount,
    costKnown,
    costUsd: costKnown ? Number(row.cost_usd || 0) : null,
    parentCampaignId: row.parent_campaign_id || null,
    supersedesCampaignId: row.supersedes_campaign_id || null,
    recoveryOfCampaignId: row.recovery_of_campaign_id || null,
    effectiveStatus: row.effective_status || row.status,
    spec: parseJson(row.spec_json, {}),
    stopReason: row.stop_reason || null,
    lastResumedAt: row.last_resumed_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  });
}

export function mapCampaignEventRow(row) {
  if (!row) return null;
  return Object.freeze({
    eventId: row.event_id,
    campaignId: row.campaign_id,
    nodeId: row.node_id || null,
    kind: row.kind,
    event: parseJson(row.event_json, null),
    eventSha256: row.event_sha256,
    createdAt: row.created_at,
  });
}

export function mapCampaignTelemetryRow(row) {
  if (!row) return null;
  return Object.freeze({
    telemetryId: Number(row.telemetry_id),
    campaignId: row.campaign_id,
    nodeId: row.node_id || null,
    sampleKind: row.sample_kind,
    phases: parseJson(row.phases_json, {}),
    lockWaitMs: Number(row.lock_wait_ms || 0),
    queueContentionCount: Number(row.queue_contention_count || 0),
    requestedAt: row.requested_at || null,
    acquiredAt: row.acquired_at || null,
    releasedAt: row.released_at || null,
    createdAt: row.created_at || null,
  });
}

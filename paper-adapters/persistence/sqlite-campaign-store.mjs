import { assertCampaignStorePort } from '../../paper-ports/campaign-store-port.mjs';
import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { evolveCampaignForResume, validateCampaignRoundExtension } from '../../paper-domain/automation/campaign-evolution-policy.mjs';

const DONE = new Set(['completed', 'skipped']);

function parseNode(row) {
  if (!row) return null;
  return Object.freeze({
    ...row,
    roundIndex: Number(row.round_index || 0),
    attemptCount: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || 3),
    role: row.role || null,
    reviewerId: row.reviewer_id || null,
    childSessionId: row.child_session_id || null,
    reviewHash: row.review_hash || null,
    promptHash: row.prompt_hash || null,
    resolvedModel: row.resolved_model || null,
    dependencies: JSON.parse(row.dependencies_json || '[]'),
    spec: JSON.parse(row.spec_json || '{}'),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    failureDetail: row.failure_json ? JSON.parse(row.failure_json) : null,
  });
}

function parseCampaign(row) {
  if (!row) return null;
  return Object.freeze({
    ...row,
    revision: Number(row.revision || 1),
    currentRound: Number(row.current_review_round ?? row.current_round ?? 0),
    currentReviewRound: Number(row.current_review_round ?? row.current_round ?? 0),
    currentPhase: row.current_phase || row.status || 'queued',
    maxRounds: Number(row.max_rounds || 1),
    accumulatedRunMs: Number(row.accumulated_run_ms || 0),
    agentCallCount: Number(row.agent_call_count || 0),
    cpuJobCount: Number(row.cpu_job_count || 0),
    gpuJobCount: Number(row.gpu_job_count || 0),
    tokenCount: Number(row.token_count || 0),
    pricedAgentCallCount: Number(row.priced_agent_call_count || 0),
    costKnown: Number(row.agent_call_count || 0) === Number(row.priced_agent_call_count || 0),
    costUsd: Number(row.agent_call_count || 0) === Number(row.priced_agent_call_count || 0) ? Number(row.cost_usd || 0) : null,
    parentCampaignId: row.parent_campaign_id || null,
    supersedesCampaignId: row.supersedes_campaign_id || null,
    recoveryOfCampaignId: row.recovery_of_campaign_id || null,
    effectiveStatus: row.effective_status || row.status,
    spec: JSON.parse(row.spec_json || '{}'),
  });
}

export function createSqliteCampaignStore({ store, clock } = {}) {
  if (!store || !clock) throw new Error('Campaign store requires StorePort and ClockPort');

  function event(campaignId, nodeId, kind, detail = {}) {
    const createdAt = clock.nowIso();
    const payload = { version: 1, kind, campaignId, nodeId: nodeId || null, detail, createdAt };
    const eventHash = hashRecord('PaperCampaignEvent', payload);
    const eventId = `${campaignId}:${createdAt}:${eventHash.slice(-16)}`;
    const result = store.execute(`INSERT INTO campaign_events(event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at) VALUES(${sqlText(eventId)},${sqlText(campaignId)},${nodeId ? sqlText(nodeId) : 'NULL'},${sqlText(kind)},${sqlJson(payload)},${sqlText(eventHash)},${sqlText(createdAt)});`);
    if (!result.ok) throw new Error(result.error || 'campaign_event_write_failed');
    return eventHash;
  }

  function refreshCampaign(campaignId) {
    const rows = api.listNodes(campaignId);
    const existing = api.getCampaign(campaignId);
    if (['paused', 'cancelled', 'failed', 'stopped'].includes(existing?.status)) return existing;
    const terminalFailure = rows.some((node) => node.status === 'failed_terminal');
    const complete = rows.length > 0 && rows.every((node) => DONE.has(node.status));
    const status = terminalFailure ? 'failed' : complete ? 'completed' : 'running';
    const currentReviewRound = Math.max(0, ...rows
      .filter((node) => node.roundIndex > 0 && node.kind !== 'package' && ['leased', 'running', 'completed', 'failed_terminal'].includes(node.status))
      .map((node) => node.roundIndex));
    const byId = new Map(rows.map((node) => [node.node_id, node]));
    const activeNode = rows.find((node) => ['running', 'leased'].includes(node.status));
    const dependencyReadyNode = rows.find((node) => node.status === 'queued' && node.dependencies.every((dependency) => DONE.has(byId.get(dependency)?.status)));
    const nextNode = activeNode || dependencyReadyNode || rows.find((node) => !DONE.has(node.status) && node.status !== 'failed_terminal');
    const currentPhase = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : (nextNode?.kind || status);
    const now = clock.nowIso();
    const terminal = ['failed', 'completed'].includes(status);
    const elapsedSql = terminal && existing?.last_resumed_at
      ? `accumulated_run_ms=accumulated_run_ms+max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)),last_resumed_at=NULL,`
      : '';
    const result = store.execute(`UPDATE paper_campaigns SET ${elapsedSql}status=${sqlText(status)},current_round=${currentReviewRound},current_review_round=${currentReviewRound},current_phase=${sqlText(currentPhase)},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)};`);
    if (!result.ok) throw new Error(result.error || 'campaign_refresh_failed');
    return api.getCampaign(campaignId);
  }

  const api = {
    version: 1,
    kind: 'SqliteCampaignStore',
    nowEpochMs: () => clock.now().getTime(),
    createCampaign(spec = {}) {
      if (!spec.campaignId || !spec.paperId || !Array.isArray(spec.nodes) || !spec.nodes.length) {
        throw new Error('campaignId, paperId and non-empty nodes are required');
      }
      const existingCampaign = api.getCampaign(spec.campaignId);
      if (existingCampaign) return existingCampaign;
      const now = clock.nowIso();
      const campaign = store.execute(`INSERT OR IGNORE INTO paper_campaigns(campaign_id,paper_id,status,max_rounds,spec_json,created_at,updated_at,last_resumed_at,parent_campaign_id,supersedes_campaign_id,recovery_of_campaign_id,current_phase) VALUES(${sqlText(spec.campaignId)},${sqlText(spec.paperId)},'queued',${Math.max(1, Number(spec.maxRounds || 1))},${sqlJson(spec)},${sqlText(now)},${sqlText(now)},${sqlText(now)},${spec.parentCampaignId ? sqlText(spec.parentCampaignId) : 'NULL'},${spec.supersedesCampaignId ? sqlText(spec.supersedesCampaignId) : 'NULL'},${spec.recoveryOfCampaignId ? sqlText(spec.recoveryOfCampaignId) : 'NULL'},'queued');`);
      if (!campaign.ok) throw new Error(campaign.error || 'campaign_create_failed');
      for (const node of spec.nodes) {
        const result = store.execute(`INSERT OR IGNORE INTO campaign_nodes(node_id,campaign_id,kind,round_index,status,priority,dependencies_json,spec_json,max_attempts,created_at,updated_at,role) VALUES(${sqlText(node.nodeId)},${sqlText(spec.campaignId)},${sqlText(node.kind)},${Number(node.roundIndex || 0)},'queued',${Number(node.priority || 100)},${sqlJson(node.dependencies || [])},${sqlJson(node)},${Math.max(1, Number(node.maxAttempts || 3))},${sqlText(now)},${sqlText(now)},${node.role ? sqlText(node.role) : 'NULL'});`);
        if (!result.ok) throw new Error(result.error || 'campaign_node_create_failed');
      }
      store.execute(`UPDATE paper_campaigns SET status='running',current_phase='dispatching',updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(spec.campaignId)} AND status='queued';`);
      event(spec.campaignId, null, 'campaign_created', { nodeCount: spec.nodes.length });
      return api.getCampaign(spec.campaignId);
    },
    getCampaign(campaignId) {
      return parseCampaign(store.query(`SELECT * FROM paper_campaigns WHERE campaign_id=${sqlText(campaignId)} LIMIT 1;`).rows[0]);
    },
    listCampaigns({ status = null, limit = 100, effectiveOnly = false } = {}) {
      const where = status ? ` WHERE c.status=${sqlText(status)}` : '';
      const rows = store.query(`SELECT c.*,
        CASE WHEN EXISTS(SELECT 1 FROM paper_campaigns n WHERE n.paper_id=c.paper_id AND (n.recovery_of_campaign_id=c.campaign_id OR n.supersedes_campaign_id=c.campaign_id)) THEN 'superseded' ELSE c.status END AS effective_status
        FROM paper_campaigns c${where} ORDER BY c.updated_at DESC,c.campaign_id LIMIT ${Math.max(1, Math.min(1000, Number(limit || 100)))};`).rows.map(parseCampaign);
      return effectiveOnly ? rows.filter((campaign) => campaign.effectiveStatus !== 'superseded') : rows;
    },
    listNodes(campaignId) {
      return store.query(`SELECT * FROM campaign_nodes WHERE campaign_id=${sqlText(campaignId)} ORDER BY priority,created_at,node_id;`).rows.map(parseNode);
    },
    recoverExpiredLeases(campaignId) {
      const now = clock.nowIso();
      const candidates = api.listNodes(campaignId).filter((node) => {
        if (!['leased', 'running'].includes(node.status)) return false;
        if (node.lease_expires_at && node.lease_expires_at < now) return true;
        const match = String(node.lease_owner || '').match(/^paper-campaign-worker:(\d+):/);
        if (!match || Number(match[1]) === process.pid) return false;
        try { process.kill(Number(match[1]), 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
      });
      if (!candidates.length) return [];
      const ids = candidates.map((node) => sqlText(node.node_id)).join(',');
      const result = store.execute(`UPDATE campaign_nodes SET status='queued',lease_owner=NULL,lease_expires_at=NULL,failure_class='lease_expired_recovered',updated_at=${sqlText(now)} WHERE node_id IN (${ids}) AND status IN ('leased','running');`);
      if (!result.ok) throw new Error(result.error || 'campaign_lease_recovery_failed');
      const recovered = api.listNodes(campaignId).filter((node) => node.failure_class === 'lease_expired_recovered' && node.updated_at === now);
      for (const node of recovered) event(campaignId, node.node_id, 'campaign_node_lease_recovered', { previousLeaseOwner: candidates.find((candidate) => candidate.node_id === node.node_id)?.lease_owner || null });
      return recovered;
    },
    renewNodeLease({ nodeId, workerId, leaseSeconds = 120 } = {}) {
      const now = clock.nowIso();
      const expires = new Date(clock.now().getTime() + Math.max(1, Number(leaseSeconds)) * 1000).toISOString();
      const result = store.execute(`UPDATE campaign_nodes SET lease_expires_at=${sqlText(expires)},updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='running' AND lease_owner=${sqlText(workerId)};`);
      if (!result.ok) throw new Error(result.error || 'campaign_node_lease_renew_failed');
      return result;
    },
    claimReady({ campaignId, workerId, leaseSeconds = 120, limit = 1 } = {}) {
      if (api.getCampaign(campaignId)?.status !== 'running') return [];
      api.recoverExpiredLeases(campaignId);
      const nodes = api.listNodes(campaignId);
      const byId = new Map(nodes.map((node) => [node.node_id, node]));
      const candidates = nodes.filter((node) => node.status === 'queued'
        && node.dependencies.every((dependency) => DONE.has(byId.get(dependency)?.status))).slice(0, Math.max(1, Number(limit || 1)));
      const now = clock.nowIso();
      const expires = new Date(clock.now().getTime() + Math.max(1, Number(leaseSeconds)) * 1000).toISOString();
      for (const node of candidates) {
        const result = store.execute(`UPDATE campaign_nodes SET status='leased',lease_owner=${sqlText(workerId)},lease_expires_at=${sqlText(expires)},updated_at=${sqlText(now)} WHERE node_id=${sqlText(node.node_id)} AND status='queued';`);
        if (!result.ok) throw new Error(result.error || 'campaign_node_claim_failed');
      }
      return candidates.map((node) => parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(node.node_id)} AND lease_owner=${sqlText(workerId)} LIMIT 1;`).rows[0])).filter(Boolean);
    },
    startNode({ nodeId, workerId } = {}) {
      const now = clock.nowIso();
      const result = store.execute(`UPDATE campaign_nodes SET status='running',attempt_count=attempt_count+1,updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='leased' AND lease_owner=${sqlText(workerId)};`);
      if (!result.ok) throw new Error(result.error || 'campaign_node_start_failed');
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      if (node?.status !== 'running' || node.lease_owner !== workerId) throw new Error('active campaign node lease required');
      const campaignWrite = store.execute(`UPDATE paper_campaigns SET current_phase=${sqlText(node.kind)},current_review_round=max(current_review_round,${Math.max(0, Number(node.roundIndex || 0))}),revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(node.campaign_id)} AND status='running';`);
      if (!campaignWrite.ok) throw new Error(campaignWrite.error || 'campaign_node_phase_update_failed');
      event(node.campaign_id, nodeId, 'campaign_node_started', { attempt: node.attemptCount, workerId });
      return node;
    },
    completeNode({ nodeId, workerId, result = {} } = {}) {
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      if (!node || node.status !== 'running' || node.lease_owner !== workerId) throw new Error('active campaign node lease required');
      const now = clock.nowIso();
      const resultHash = hashRecord('PaperCampaignNodeResult', result);
      const reviewerId = result.reviewerId || null;
      const role = result.role || node.role || node.spec?.role || null;
      const childSessionId = result.childSessionId || result.sessionKey || null;
      const reviewHash = result.reviewHash || null;
      const promptHash = result.promptHash || null;
      const resolvedModel = result.resolvedModel || null;
      const write = store.execute(`UPDATE campaign_nodes SET status='completed',result_json=${sqlJson(result)},result_sha256=${sqlText(resultHash)},lease_owner=NULL,lease_expires_at=NULL,failure_class=NULL,updated_at=${sqlText(now)},role=${role ? sqlText(role) : 'role'},reviewer_id=${reviewerId ? sqlText(reviewerId) : 'NULL'},child_session_id=${childSessionId ? sqlText(childSessionId) : 'NULL'},review_hash=${reviewHash ? sqlText(reviewHash) : 'NULL'},prompt_hash=${promptHash ? sqlText(promptHash) : 'NULL'},resolved_model=${resolvedModel ? sqlText(resolvedModel) : 'NULL'} WHERE node_id=${sqlText(nodeId)};`);
      if (!write.ok) throw new Error(write.error || 'campaign_node_complete_failed');
      event(node.campaign_id, nodeId, 'campaign_node_completed', { resultHash });
      refreshCampaign(node.campaign_id);
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
    failNode({ nodeId, workerId, failureClass = 'automation_node_failed', failureDetail = {}, retryable = true } = {}) {
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      if (!node || node.status !== 'running' || node.lease_owner !== workerId) throw new Error('active campaign node lease required');
      const canRetry = retryable && node.attemptCount < node.maxAttempts;
      const status = canRetry ? 'queued' : 'failed_terminal';
      const now = clock.nowIso();
      const failureHash = hashRecord('PaperCampaignNodeFailure', failureDetail);
      const write = store.execute(`UPDATE campaign_nodes SET status=${sqlText(status)},failure_class=${sqlText(failureClass)},failure_json=${sqlJson(failureDetail)},failure_sha256=${sqlText(failureHash)},lease_owner=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)};`);
      if (!write.ok) throw new Error(write.error || 'campaign_node_failure_failed');
      event(node.campaign_id, nodeId, canRetry ? 'campaign_node_retry_queued' : 'campaign_node_failed_terminal', { failureClass, failureHash, attempt: node.attemptCount });
      refreshCampaign(node.campaign_id);
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
    skipFutureRounds({ campaignId, afterRound, reason = 'convergence_reached' } = {}) {
      const now = clock.nowIso();
      const result = store.execute(`UPDATE campaign_nodes SET status='skipped',failure_class=${sqlText(reason)},lease_owner=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND round_index>${Number(afterRound || 0)} AND kind<>'package' AND status='queued';`);
      if (!result.ok) throw new Error(result.error || 'campaign_future_round_skip_failed');
      event(campaignId, null, 'campaign_future_rounds_skipped', { afterRound, reason });
      return refreshCampaign(campaignId);
    },
    pauseCampaign(campaignId, reason = 'operator_paused') {
      const campaign = api.getCampaign(campaignId);
      if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
      if (campaign.status !== 'running') return campaign;
      const now = clock.nowIso();
      const write = store.execute(`BEGIN IMMEDIATE; UPDATE paper_campaigns SET status='paused',stop_reason=${sqlText(reason)},accumulated_run_ms=accumulated_run_ms+max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)),last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status='running'; UPDATE campaign_nodes SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status='leased'; COMMIT;`);
      if (!write.ok) throw new Error(write.error || 'campaign_pause_failed');
      event(campaignId, null, 'campaign_paused', { reason });
      return api.getCampaign(campaignId);
    },
    resumeCampaign(campaignId, { budgetOverrides = {} } = {}) {
      const campaign = api.getCampaign(campaignId);
      if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
      if (!['paused', 'stopped'].includes(campaign.status)) return campaign;
      const { nextSpec, overrides, stoppedForBudget, previousCampaignPlanHash } = evolveCampaignForResume({ campaign, budgetOverrides });
      const now = clock.nowIso();
      const reopenSql = stoppedForBudget
        ? ` UPDATE campaign_nodes SET status='queued',failure_class=NULL,failure_json=NULL,failure_sha256=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status='skipped' AND failure_class=${sqlText(campaign.stop_reason)};`
        : '';
      const write = store.execute(`BEGIN IMMEDIATE; UPDATE paper_campaigns SET status='running',stop_reason=NULL,last_resumed_at=${sqlText(now)},spec_json=${sqlJson(nextSpec)},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status=${sqlText(campaign.status)};${reopenSql} COMMIT;`);
      if (!write.ok) throw new Error(write.error || 'campaign_resume_failed');
      event(campaignId, null, 'campaign_resumed', {
        previousStatus: campaign.status,
        budgetOverrides: overrides,
        reopenedBudgetStoppedNodes: Boolean(stoppedForBudget),
        previousCampaignPlanHash,
        campaignPlanHash: nextSpec.campaignPlanHash,
      });
      return api.getCampaign(campaignId);
    },
    extendCampaign(spec = {}) {
      const campaign = api.getCampaign(spec.campaignId);
      if (!campaign) throw new Error(`campaign not found: ${spec.campaignId}`);
      const existingNodes = api.listNodes(spec.campaignId);
      const { additions } = validateCampaignRoundExtension({ campaign, spec, existingNodes });
      const now = clock.nowIso();
      const statements = [
        'BEGIN IMMEDIATE;',
        `UPDATE campaign_nodes SET failure_class='campaign_round_extension_superseded',updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(spec.campaignId)} AND kind='package' AND status='skipped' AND failure_class='referee_convergence_not_reached_within_budget';`,
      ];
      for (const item of additions) {
        statements.push(`INSERT INTO campaign_nodes(node_id,campaign_id,kind,round_index,status,priority,dependencies_json,spec_json,max_attempts,created_at,updated_at) VALUES(${sqlText(item.nodeId)},${sqlText(spec.campaignId)},${sqlText(item.kind)},${Number(item.roundIndex || 0)},'queued',${Number(item.priority || 100)},${sqlJson(item.dependencies || [])},${sqlJson(item)},${Math.max(1, Number(item.maxAttempts || 3))},${sqlText(now)},${sqlText(now)});`);
      }
      statements.push(`UPDATE paper_campaigns SET status='running',stop_reason=NULL,max_rounds=${Number(spec.maxRounds)},spec_json=${sqlJson(spec)},last_resumed_at=${sqlText(now)},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(spec.campaignId)};`, 'COMMIT;');
      const write = store.execute(statements.join(' '));
      if (!write.ok) throw new Error(write.error || 'campaign_extension_failed');
      event(spec.campaignId, null, 'campaign_extended', {
        previousMaxRounds: campaign.maxRounds,
        maxRounds: Number(spec.maxRounds),
        addedNodeIds: additions.map((item) => item.nodeId).sort(),
        previousCampaignPlanHash: campaign.spec?.campaignPlanHash || null,
        campaignPlanHash: spec.campaignPlanHash || null,
      });
      return api.getCampaign(spec.campaignId);
    },
    cancelCampaign(campaignId, reason = 'operator_cancelled') {
      const campaign = api.getCampaign(campaignId);
      if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
      if (['completed', 'failed', 'cancelled'].includes(campaign.status)) return campaign;
      const now = clock.nowIso();
      const elapsedSql = campaign.last_resumed_at ? `accumulated_run_ms=accumulated_run_ms+max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)),` : '';
      const write = store.execute(`BEGIN IMMEDIATE; UPDATE paper_campaigns SET ${elapsedSql}status='cancelled',stop_reason=${sqlText(reason)},last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)}; UPDATE campaign_nodes SET status='skipped',failure_class=${sqlText(reason)},lease_owner=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status IN ('queued','leased'); COMMIT;`);
      if (!write.ok) throw new Error(write.error || 'campaign_cancel_failed');
      event(campaignId, null, 'campaign_cancelled', { reason });
      return api.getCampaign(campaignId);
    },
    cancelNode(nodeId, reason = 'operator_node_cancelled') {
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      if (!node) throw new Error(`campaign node not found: ${nodeId}`);
      if (DONE.has(node.status) || node.status === 'failed_terminal') return node;
      const nodes = api.listNodes(node.campaign_id);
      const cancelled = new Set([nodeId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const candidate of nodes) {
          if (!cancelled.has(candidate.node_id) && candidate.dependencies.some((dependency) => cancelled.has(dependency))) {
            cancelled.add(candidate.node_id);
            changed = true;
          }
        }
      }
      const now = clock.nowIso();
      const ids = [...cancelled].map(sqlText).join(',');
      const failureDetail = { reason, rootNodeId: nodeId };
      const failureHash = hashRecord('PaperCampaignNodeFailure', failureDetail);
      const write = store.execute(`UPDATE campaign_nodes SET status='skipped',failure_class=${sqlText(reason)},failure_json=${sqlJson(failureDetail)},failure_sha256=${sqlText(failureHash)},lease_owner=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE node_id IN (${ids}) AND status IN ('queued','leased','running');`);
      if (!write.ok) throw new Error(write.error || 'campaign_node_cancel_failed');
      event(node.campaign_id, nodeId, 'campaign_node_cancelled', { reason, skippedNodeIds: [...cancelled].sort() });
      const packageNode = nodes.find((candidate) => candidate.kind === 'package');
      if (packageNode && cancelled.has(packageNode.node_id)) api.stopCampaign(node.campaign_id, 'operator_node_cancelled_required_path');
      else refreshCampaign(node.campaign_id);
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
    retryNode(nodeId) {
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      if (!node) throw new Error(`campaign node not found: ${nodeId}`);
      if (node.status !== 'failed_terminal') return node;
      const now = clock.nowIso();
      const write = store.execute(`BEGIN IMMEDIATE; UPDATE campaign_nodes SET status='queued',attempt_count=0,failure_class=NULL,failure_json=NULL,failure_sha256=NULL,updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='failed_terminal'; UPDATE paper_campaigns SET status='running',current_phase=${sqlText(node.kind)},current_review_round=max(current_review_round,${Math.max(0, Number(node.roundIndex || 0))}),stop_reason=NULL,last_resumed_at=coalesce(last_resumed_at,${sqlText(now)}),revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(node.campaign_id)}; COMMIT;`);
      if (!write.ok) throw new Error(write.error || 'campaign_node_retry_failed');
      event(node.campaign_id, nodeId, 'campaign_node_manually_retried', {});
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
    recordUsage(campaignId, delta = {}) {
      const costProvided = Object.prototype.hasOwnProperty.call(delta, 'costUsd') && Number.isFinite(Number(delta.costUsd));
      const values = {
        agent: Math.max(0, Number(delta.agentCalls || 0)),
        cpu: Math.max(0, Number(delta.cpuJobs || 0)),
        gpu: Math.max(0, Number(delta.gpuJobs || 0)),
        tokens: Math.max(0, Number(delta.tokens || 0)),
        cost: costProvided ? Math.max(0, Number(delta.costUsd)) : 0,
        pricedCalls: costProvided ? Math.max(0, Number(delta.pricedAgentCalls ?? 1)) : 0,
      };
      const now = clock.nowIso();
      const write = store.execute(`UPDATE paper_campaigns SET agent_call_count=agent_call_count+${values.agent},cpu_job_count=cpu_job_count+${values.cpu},gpu_job_count=gpu_job_count+${values.gpu},token_count=token_count+${values.tokens},cost_usd=cost_usd+${values.cost},priced_agent_call_count=priced_agent_call_count+${values.pricedCalls},cost_known=CASE WHEN agent_call_count+${values.agent}=priced_agent_call_count+${values.pricedCalls} THEN 1 ELSE 0 END,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)};`);
      if (!write.ok) throw new Error(write.error || 'campaign_usage_write_failed');
      return api.getCampaign(campaignId);
    },
    failCampaign(campaignId, reason = 'campaign_failed') {
      const campaign = api.getCampaign(campaignId);
      if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
      if (['completed', 'failed', 'cancelled'].includes(campaign.status)) return campaign;
      const now = clock.nowIso();
      const elapsedSql = campaign.last_resumed_at ? `accumulated_run_ms=accumulated_run_ms+max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)),` : '';
      const write = store.execute(`BEGIN IMMEDIATE; UPDATE paper_campaigns SET ${elapsedSql}status='failed',stop_reason=${sqlText(reason)},last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)}; UPDATE campaign_nodes SET status='failed_terminal',failure_class=${sqlText(reason)},lease_owner=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status IN ('queued','leased'); COMMIT;`);
      if (!write.ok) throw new Error(write.error || 'campaign_fail_failed');
      event(campaignId, null, 'campaign_failed', { reason });
      return api.getCampaign(campaignId);
    },
    stopCampaign(campaignId, reason = 'campaign_stopped') {
      const campaign = api.getCampaign(campaignId);
      if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
      if (['completed', 'failed', 'cancelled', 'stopped'].includes(campaign.status)) return campaign;
      const now = clock.nowIso();
      const elapsedSql = campaign.last_resumed_at ? `accumulated_run_ms=accumulated_run_ms+max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)),` : '';
      const write = store.execute(`BEGIN IMMEDIATE; UPDATE paper_campaigns SET ${elapsedSql}status='stopped',stop_reason=${sqlText(reason)},last_resumed_at=NULL,revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)}; UPDATE campaign_nodes SET status='skipped',failure_class=${sqlText(reason)},lease_owner=NULL,lease_expires_at=NULL,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status IN ('queued','leased'); COMMIT;`);
      if (!write.ok) throw new Error(write.error || 'campaign_stop_failed');
      event(campaignId, null, 'campaign_stopped', { reason });
      return api.getCampaign(campaignId);
    },
    listEvents(campaignId, { limit = null, before = null } = {}) {
      const boundedLimit = limit === null ? null : Math.max(1, Math.min(1000, Number(limit || 50)));
      const beforeSql = before ? ` AND created_at<${sqlText(before)}` : '';
      const order = boundedLimit === null && !before ? 'ASC' : 'DESC';
      const limitSql = boundedLimit === null ? '' : ` LIMIT ${boundedLimit}`;
      return store.query(`SELECT * FROM campaign_events WHERE campaign_id=${sqlText(campaignId)}${beforeSql} ORDER BY created_at ${order},event_id ${order}${limitSql};`).rows.map((row) => ({ ...row, event: JSON.parse(row.event_json) }));
    },
    recordTelemetry(sample = {}) {
      const phases = sample.phases || {};
      const write = store.execute(`INSERT INTO campaign_telemetry_samples(campaign_id,node_id,sample_kind,phases_json,lock_wait_ms,queue_contention_count,requested_at,acquired_at,released_at,created_at) VALUES(${sqlText(sample.campaignId)},${sample.nodeId ? sqlText(sample.nodeId) : 'NULL'},${sqlText(sample.sampleKind || 'campaign_node_execution')},${sqlJson(phases)},${Math.max(0, Math.round(Number(sample.lockWaitMs || 0)))},${Math.max(0, Math.round(Number(sample.queueContentionCount || 0)))},${sample.requestedAt ? sqlText(sample.requestedAt) : 'NULL'},${sample.acquiredAt ? sqlText(sample.acquiredAt) : 'NULL'},${sample.releasedAt ? sqlText(sample.releasedAt) : 'NULL'},${sqlText(sample.createdAt || clock.nowIso())});`);
      if (!write.ok) throw new Error(write.error || 'campaign_telemetry_write_failed');
      return sample;
    },
    listTelemetry(campaignId = null) {
      const where = campaignId ? ` WHERE campaign_id=${sqlText(campaignId)}` : '';
      return store.query(`SELECT * FROM campaign_telemetry_samples${where} ORDER BY telemetry_id;`).rows.map((row) => ({
        ...row,
        phases: JSON.parse(row.phases_json || '{}'),
        lockWaitMs: Number(row.lock_wait_ms || 0),
        queueContentionCount: Number(row.queue_contention_count || 0),
      }));
    },
  };
  return assertCampaignStorePort(api);
}

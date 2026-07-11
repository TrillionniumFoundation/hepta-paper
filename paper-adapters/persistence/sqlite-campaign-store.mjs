import { assertCampaignStorePort } from '../../paper-ports/campaign-store-port.mjs';
import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const DONE = new Set(['completed', 'skipped']);

function parseNode(row) {
  if (!row) return null;
  return Object.freeze({
    ...row,
    roundIndex: Number(row.round_index || 0),
    attemptCount: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || 3),
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
    currentRound: Number(row.current_round || 0),
    maxRounds: Number(row.max_rounds || 1),
    accumulatedRunMs: Number(row.accumulated_run_ms || 0),
    agentCallCount: Number(row.agent_call_count || 0),
    cpuJobCount: Number(row.cpu_job_count || 0),
    gpuJobCount: Number(row.gpu_job_count || 0),
    tokenCount: Number(row.token_count || 0),
    costUsd: Number(row.cost_usd || 0),
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
    const currentRound = Math.max(0, ...rows.filter((node) => DONE.has(node.status)).map((node) => node.roundIndex));
    const now = clock.nowIso();
    const terminal = ['failed', 'completed'].includes(status);
    const elapsedSql = terminal && existing?.last_resumed_at
      ? `accumulated_run_ms=accumulated_run_ms+max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)),last_resumed_at=NULL,`
      : '';
    const result = store.execute(`UPDATE paper_campaigns SET ${elapsedSql}status=${sqlText(status)},current_round=${currentRound},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)};`);
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
      const campaign = store.execute(`INSERT OR IGNORE INTO paper_campaigns(campaign_id,paper_id,status,max_rounds,spec_json,created_at,updated_at,last_resumed_at) VALUES(${sqlText(spec.campaignId)},${sqlText(spec.paperId)},'queued',${Math.max(1, Number(spec.maxRounds || 1))},${sqlJson(spec)},${sqlText(now)},${sqlText(now)},${sqlText(now)});`);
      if (!campaign.ok) throw new Error(campaign.error || 'campaign_create_failed');
      for (const node of spec.nodes) {
        const result = store.execute(`INSERT OR IGNORE INTO campaign_nodes(node_id,campaign_id,kind,round_index,status,priority,dependencies_json,spec_json,max_attempts,created_at,updated_at) VALUES(${sqlText(node.nodeId)},${sqlText(spec.campaignId)},${sqlText(node.kind)},${Number(node.roundIndex || 0)},'queued',${Number(node.priority || 100)},${sqlJson(node.dependencies || [])},${sqlJson(node)},${Math.max(1, Number(node.maxAttempts || 3))},${sqlText(now)},${sqlText(now)});`);
        if (!result.ok) throw new Error(result.error || 'campaign_node_create_failed');
      }
      store.execute(`UPDATE paper_campaigns SET status='running',updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(spec.campaignId)} AND status='queued';`);
      event(spec.campaignId, null, 'campaign_created', { nodeCount: spec.nodes.length });
      return api.getCampaign(spec.campaignId);
    },
    getCampaign(campaignId) {
      return parseCampaign(store.query(`SELECT * FROM paper_campaigns WHERE campaign_id=${sqlText(campaignId)} LIMIT 1;`).rows[0]);
    },
    listCampaigns({ status = null, limit = 100 } = {}) {
      const where = status ? ` WHERE status=${sqlText(status)}` : '';
      return store.query(`SELECT * FROM paper_campaigns${where} ORDER BY updated_at DESC,campaign_id LIMIT ${Math.max(1, Math.min(1000, Number(limit || 100)))};`).rows.map(parseCampaign);
    },
    listNodes(campaignId) {
      return store.query(`SELECT * FROM campaign_nodes WHERE campaign_id=${sqlText(campaignId)} ORDER BY priority,created_at,node_id;`).rows.map(parseNode);
    },
    recoverExpiredLeases(campaignId) {
      const now = clock.nowIso();
      const result = store.execute(`UPDATE campaign_nodes SET status='queued',lease_owner=NULL,lease_expires_at=NULL,failure_class='lease_expired_recovered',updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status IN ('leased','running') AND lease_expires_at<${sqlText(now)};`);
      if (!result.ok) throw new Error(result.error || 'campaign_lease_recovery_failed');
      return api.listNodes(campaignId).filter((node) => node.failure_class === 'lease_expired_recovered' && node.updated_at === now);
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
      event(node.campaign_id, nodeId, 'campaign_node_started', { attempt: node.attemptCount, workerId });
      return node;
    },
    completeNode({ nodeId, workerId, result = {} } = {}) {
      const node = parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
      if (!node || node.status !== 'running' || node.lease_owner !== workerId) throw new Error('active campaign node lease required');
      const now = clock.nowIso();
      const resultHash = hashRecord('PaperCampaignNodeResult', result);
      const write = store.execute(`UPDATE campaign_nodes SET status='completed',result_json=${sqlJson(result)},result_sha256=${sqlText(resultHash)},lease_owner=NULL,lease_expires_at=NULL,failure_class=NULL,updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)};`);
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
    resumeCampaign(campaignId) {
      const campaign = api.getCampaign(campaignId);
      if (!campaign) throw new Error(`campaign not found: ${campaignId}`);
      if (campaign.status !== 'paused') return campaign;
      const now = clock.nowIso();
      const write = store.execute(`UPDATE paper_campaigns SET status='running',stop_reason=NULL,last_resumed_at=${sqlText(now)},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status='paused';`);
      if (!write.ok) throw new Error(write.error || 'campaign_resume_failed');
      event(campaignId, null, 'campaign_resumed', {});
      return api.getCampaign(campaignId);
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
      const write = store.execute(`UPDATE campaign_nodes SET status='queued',attempt_count=0,failure_class=NULL,failure_json=NULL,failure_sha256=NULL,updated_at=${sqlText(now)} WHERE node_id=${sqlText(nodeId)} AND status='failed_terminal'; UPDATE paper_campaigns SET status='running',stop_reason=NULL,last_resumed_at=coalesce(last_resumed_at,${sqlText(now)}),updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(node.campaign_id)};`);
      if (!write.ok) throw new Error(write.error || 'campaign_node_retry_failed');
      event(node.campaign_id, nodeId, 'campaign_node_manually_retried', {});
      return parseNode(store.query(`SELECT * FROM campaign_nodes WHERE node_id=${sqlText(nodeId)} LIMIT 1;`).rows[0]);
    },
    recordUsage(campaignId, delta = {}) {
      const values = {
        agent: Math.max(0, Number(delta.agentCalls || 0)),
        cpu: Math.max(0, Number(delta.cpuJobs || 0)),
        gpu: Math.max(0, Number(delta.gpuJobs || 0)),
        tokens: Math.max(0, Number(delta.tokens || 0)),
        cost: Math.max(0, Number(delta.costUsd || 0)),
      };
      const now = clock.nowIso();
      const write = store.execute(`UPDATE paper_campaigns SET agent_call_count=agent_call_count+${values.agent},cpu_job_count=cpu_job_count+${values.cpu},gpu_job_count=gpu_job_count+${values.gpu},token_count=token_count+${values.tokens},cost_usd=cost_usd+${values.cost},updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)};`);
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
    listEvents(campaignId) {
      return store.query(`SELECT * FROM campaign_events WHERE campaign_id=${sqlText(campaignId)} ORDER BY created_at,event_id;`).rows.map((row) => ({ ...row, event: JSON.parse(row.event_json) }));
    },
  };
  return assertCampaignStorePort(api);
}

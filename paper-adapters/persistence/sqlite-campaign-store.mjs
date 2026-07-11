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
    const terminalFailure = rows.some((node) => node.status === 'failed_terminal');
    const complete = rows.length > 0 && rows.every((node) => DONE.has(node.status));
    const status = terminalFailure ? 'failed' : complete ? 'completed' : 'running';
    const currentRound = Math.max(0, ...rows.filter((node) => DONE.has(node.status)).map((node) => node.roundIndex));
    const now = clock.nowIso();
    const result = store.execute(`UPDATE paper_campaigns SET status=${sqlText(status)},current_round=${currentRound},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)};`);
    if (!result.ok) throw new Error(result.error || 'campaign_refresh_failed');
    return api.getCampaign(campaignId);
  }

  const api = {
    version: 1,
    kind: 'SqliteCampaignStore',
    createCampaign(spec = {}) {
      if (!spec.campaignId || !spec.paperId || !Array.isArray(spec.nodes) || !spec.nodes.length) {
        throw new Error('campaignId, paperId and non-empty nodes are required');
      }
      const existingCampaign = api.getCampaign(spec.campaignId);
      if (existingCampaign) return existingCampaign;
      const now = clock.nowIso();
      const campaign = store.execute(`INSERT OR IGNORE INTO paper_campaigns(campaign_id,paper_id,status,max_rounds,spec_json,created_at,updated_at) VALUES(${sqlText(spec.campaignId)},${sqlText(spec.paperId)},'queued',${Math.max(1, Number(spec.maxRounds || 1))},${sqlJson(spec)},${sqlText(now)},${sqlText(now)});`);
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
    listNodes(campaignId) {
      return store.query(`SELECT * FROM campaign_nodes WHERE campaign_id=${sqlText(campaignId)} ORDER BY priority,created_at,node_id;`).rows.map(parseNode);
    },
    recoverExpiredLeases(campaignId) {
      const now = clock.nowIso();
      const result = store.execute(`UPDATE campaign_nodes SET status='queued',lease_owner=NULL,lease_expires_at=NULL,failure_class='lease_expired_recovered',updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status IN ('leased','running') AND lease_expires_at<${sqlText(now)};`);
      if (!result.ok) throw new Error(result.error || 'campaign_lease_recovery_failed');
      return api.listNodes(campaignId).filter((node) => node.failure_class === 'lease_expired_recovered' && node.updated_at === now);
    },
    claimReady({ campaignId, workerId, leaseSeconds = 120, limit = 1 } = {}) {
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
    listEvents(campaignId) {
      return store.query(`SELECT * FROM campaign_events WHERE campaign_id=${sqlText(campaignId)} ORDER BY created_at,event_id;`).rows.map((row) => ({ ...row, event: JSON.parse(row.event_json) }));
    },
  };
  return assertCampaignStorePort(api);
}

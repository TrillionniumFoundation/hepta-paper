import { sqlText } from '../../paper-ports/store-port.mjs';

// SQLite persistence translation of CampaignOperationalProjection. The domain
// policy owns the meanings; this adapter keeps the projection update inside the
// same transaction as the fenced node transition.
export function buildSqliteCampaignProjectionStatement({ campaignId, now } = {}) {
  if (!campaignId || !now) throw new Error('campaign projection statement requires campaignId and now');
  const terminalFailure = `EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status='failed_terminal')`;
  const complete = `EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id) AND NOT EXISTS(SELECT 1 FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status NOT IN ('completed','skipped'))`;
  const status = `CASE WHEN ${terminalFailure} THEN 'failed' WHEN ${complete} THEN 'completed' ELSE 'running' END`;
  const phase = `CASE WHEN ${terminalFailure} THEN 'failed' WHEN ${complete} THEN 'completed' ELSE coalesce((SELECT n.kind FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status IN ('running','leased') ORDER BY n.priority,n.created_at,n.node_id LIMIT 1),(SELECT n.kind FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.status NOT IN ('completed','skipped','failed_terminal') ORDER BY n.priority,n.created_at,n.node_id LIMIT 1),'running') END`;
  const terminal = `(${terminalFailure} OR ${complete})`;
  const currentRound = `coalesce((SELECT max(n.round_index) FROM campaign_nodes n WHERE n.campaign_id=paper_campaigns.campaign_id AND n.round_index>0 AND n.kind NOT IN ('package','release-package') AND n.status IN ('leased','running','completed','failed_terminal')),0)`;
  return `UPDATE paper_campaigns SET accumulated_run_ms=accumulated_run_ms+CASE WHEN ${terminal} AND last_resumed_at IS NOT NULL THEN max(0,CAST((julianday(${sqlText(now)})-julianday(last_resumed_at))*86400000 AS INTEGER)) ELSE 0 END,last_resumed_at=CASE WHEN ${terminal} THEN NULL ELSE last_resumed_at END,status=${status},current_round=${currentRound},current_review_round=${currentRound},current_phase=${phase},revision=revision+1,updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(campaignId)} AND status='running';`;
}

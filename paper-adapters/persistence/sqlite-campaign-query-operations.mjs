import { sqlText } from '../../paper-ports/store-port.mjs';
import {
  mapCampaignEventRow,
  mapCampaignNodeRow,
  mapCampaignRow,
  mapCampaignTelemetryRow,
} from './sqlite-campaign-row-mappers.mjs';

export function createCampaignQueryOperations({ store } = {}) {
  if (!store) throw new Error('campaign_query_operations_store_required');
  return Object.freeze({
    getCampaign(campaignId) {
      return mapCampaignRow(store.query(`SELECT * FROM paper_campaigns WHERE campaign_id=${sqlText(campaignId)} LIMIT 1;`).rows[0]);
    },
    listCampaigns({ status = null, limit = 100, offset = 0, effectiveOnly = false } = {}) {
      const where = status ? ` WHERE c.status=${sqlText(status)}` : '';
      const boundedLimit = Math.max(1, Math.min(1000, Number(limit || 100)));
      const boundedOffset = Math.max(0, Math.min(10_000_000, Number(offset || 0)));
      const rows = store.query(`SELECT c.*,
        CASE WHEN EXISTS(SELECT 1 FROM paper_campaigns n WHERE n.paper_id=c.paper_id AND (n.recovery_of_campaign_id=c.campaign_id OR n.supersedes_campaign_id=c.campaign_id)) THEN 'superseded' ELSE c.status END AS effective_status
        FROM paper_campaigns c${where} ORDER BY c.updated_at DESC,c.campaign_id LIMIT ${boundedLimit} OFFSET ${boundedOffset};`).rows.map(mapCampaignRow);
      return effectiveOnly ? rows.filter((campaign) => campaign.effectiveStatus !== 'superseded') : rows;
    },
    listNodes(campaignId) {
      return store.query(`SELECT * FROM campaign_nodes WHERE campaign_id=${sqlText(campaignId)} ORDER BY priority,created_at,node_id;`).rows.map(mapCampaignNodeRow);
    },
    listEvents(campaignId, { limit = null, before = null } = {}) {
      const boundedLimit = limit === null ? null : Math.max(1, Math.min(1000, Number(limit || 50)));
      const beforeSql = before ? ` AND created_at<${sqlText(before)}` : '';
      const order = boundedLimit === null && !before ? 'ASC' : 'DESC';
      const limitSql = boundedLimit === null ? '' : ` LIMIT ${boundedLimit}`;
      return store.query(`SELECT * FROM campaign_events WHERE campaign_id=${sqlText(campaignId)}${beforeSql} ORDER BY created_at ${order},event_id ${order}${limitSql};`).rows.map(mapCampaignEventRow);
    },
    listTelemetry(campaignId = null) {
      const where = campaignId ? ` WHERE campaign_id=${sqlText(campaignId)}` : '';
      return store.query(`SELECT * FROM campaign_telemetry_samples${where} ORDER BY telemetry_id;`).rows.map(mapCampaignTelemetryRow);
    },
  });
}

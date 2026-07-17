import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';

export function createCampaignTelemetryOperations({ store, clock } = {}) {
  if (!store || !clock) throw new Error('campaign_telemetry_operations_dependencies_required');
  return Object.freeze({
    recordTelemetry(sample = {}) {
      const phases = sample.phases || {};
      const write = store.execute(`INSERT INTO campaign_telemetry_samples(campaign_id,node_id,sample_kind,phases_json,lock_wait_ms,queue_contention_count,requested_at,acquired_at,released_at,created_at) VALUES(${sqlText(sample.campaignId)},${sample.nodeId ? sqlText(sample.nodeId) : 'NULL'},${sqlText(sample.sampleKind || 'campaign_node_execution')},${sqlJson(phases)},${Math.max(0, Math.round(Number(sample.lockWaitMs || 0)))},${Math.max(0, Math.round(Number(sample.queueContentionCount || 0)))},${sample.requestedAt ? sqlText(sample.requestedAt) : 'NULL'},${sample.acquiredAt ? sqlText(sample.acquiredAt) : 'NULL'},${sample.releasedAt ? sqlText(sample.releasedAt) : 'NULL'},${sqlText(sample.createdAt || clock.nowIso())});`);
      if (!write.ok) throw new Error(write.error || 'campaign_telemetry_write_failed');
      return sample;
    },
  });
}

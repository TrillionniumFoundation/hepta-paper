// Test-only normalization to the real incumbent SLO API. No statistical formulas here.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { buildCampaignSloReport } from '../../paper-domain/automation/campaign-slo.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';

const date = (milliseconds) => milliseconds === null ? null : new Date(milliseconds).toISOString();
function evaluate(request) {
  return buildCampaignSloReport({
    campaigns: request.campaigns.map((campaign) => ({
      ...campaign, costUsd: campaign.costKnown ? 0 : null,
    })),
    nodes: request.nodes.map((node) => ({ ...node, createdAt: date(node.createdAtUnixMs) })),
    events: request.events.map((event) => ({ ...event, createdAt: date(event.atUnixMs) })),
    telemetrySamples: request.telemetrySamples.map((sample) => ({
      phases: sample.phases,
      ...(sample.lockWaitMs === null ? {} : { lockWaitMs: sample.lockWaitMs }),
      ...(sample.queueContentionCount === null ? {} : {
        queueContentionCount: sample.queueContentionCount,
      }),
    })),
    runtimeBytes: request.runtimeBytes,
    targets: request.targets,
  });
}

const data = fs.readFileSync(0);
if (data.length > 4 * 1024 * 1024) throw new Error('oracle input bound');
const requests = JSON.parse(data);
if (!Array.isArray(requests) || requests.length > 1000) throw new Error('oracle case bound');
const relative = 'paper-domain/automation/campaign-slo.mjs';
console.log(JSON.stringify({
  profile: productionOracleProfile(),
  sources: {
    [relative]: createHash('sha256')
      .update(fs.readFileSync(new URL(`../../${relative}`, import.meta.url))).digest('hex'),
  },
  results: requests.map(evaluate),
}));

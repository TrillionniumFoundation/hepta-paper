#!/usr/bin/env node
import { createReadOnlyPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { safeJsonParse } from '../src/runtime/data-utils.mjs';
import { sqlText } from '../../paper-ports/store-port.mjs';

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') out.json = true;
    else if (token.startsWith('--')) out[token.slice(2)] = argv[++index];
  }
  return out;
}

function percent(value, limit) {
  const maximum = Number(limit || 0);
  return maximum > 0 ? Math.min(100, (Number(value || 0) / maximum) * 100) : null;
}

const options = parseArgs(process.argv.slice(2));
const store = createReadOnlyPaperStore({ root: options.root || defaultPaperAssetRoot(), runtimeRoot: options['runtime-root'] || defaultPaperRuntimeRoot() });
const where = options['campaign-id'] ? ` WHERE campaign_id=${sqlText(String(options['campaign-id']))}` : '';
const campaigns = store.query(`SELECT * FROM paper_campaigns${where} ORDER BY updated_at DESC LIMIT ${Math.max(1, Math.min(1000, Number(options.limit || 100)))};`);
if (!campaigns.ok) throw new Error(campaigns.error || 'campaign dashboard query failed');
const rows = campaigns.rows.map((campaign) => {
  const nodeRows = store.query(`SELECT node_id,kind,status,attempt_count,failure_class,failure_json,result_json,updated_at FROM campaign_nodes WHERE campaign_id=${sqlText(campaign.campaign_id)} ORDER BY updated_at DESC,node_id;`).rows;
  const nodes = Object.entries(Object.groupBy(nodeRows, (node) => node.status)).sort(([left], [right]) => left.localeCompare(right)).map(([status, values]) => ({ status, count: values.length }));
  const events = store.query(`SELECT kind,created_at,event_json FROM campaign_events WHERE campaign_id=${sqlText(campaign.campaign_id)} ORDER BY created_at DESC,event_id DESC LIMIT 20;`).rows.map((event) => ({ kind: event.kind, createdAt: event.created_at, detail: safeJsonParse(event.event_json || '{}', {}).detail || {} }));
  const spec = safeJsonParse(campaign.spec_json || '{}', {});
  const budgets = spec.budgets || {};
  const activeRunMs = Number(campaign.accumulated_run_ms || 0) + (campaign.last_resumed_at ? Math.max(0, Date.now() - Date.parse(campaign.last_resumed_at)) : 0);
  return {
    campaignId: campaign.campaign_id,
    paperId: campaign.paper_id,
    status: campaign.status,
    currentRound: Number(campaign.current_round || 0),
    maxRounds: Number(campaign.max_rounds || 0),
    stopReason: campaign.stop_reason || null,
    updatedAt: campaign.updated_at,
    usage: {
      activeRunMs,
      agentCalls: Number(campaign.agent_call_count || 0),
      cpuJobs: Number(campaign.cpu_job_count || 0),
      gpuJobs: Number(campaign.gpu_job_count || 0),
      tokens: Number(campaign.token_count || 0),
      costUsd: Number(campaign.cost_usd || 0),
    },
    budgetUsePercent: {
      wallTime: percent(activeRunMs, budgets.maxWallTimeMs),
      agentCalls: percent(campaign.agent_call_count, budgets.maxAgentCalls),
      cpuJobs: percent(campaign.cpu_job_count, budgets.maxCpuJobs),
      gpuJobs: percent(campaign.gpu_job_count, budgets.maxGpuJobs),
      tokens: percent(campaign.token_count, budgets.maxTokenCount),
      costUsd: percent(campaign.cost_usd, budgets.maxCostUsd),
    },
    nodes,
    activeNodes: nodeRows.filter((node) => ['leased', 'running'].includes(node.status)).map((node) => ({ nodeId: node.node_id, kind: node.kind, status: node.status, attemptCount: Number(node.attempt_count || 0), updatedAt: node.updated_at })),
    failedNodes: nodeRows.filter((node) => node.status === 'failed_terminal').slice(0, 20).map((node) => ({ nodeId: node.node_id, kind: node.kind, failureClass: node.failure_class, failureDetail: safeJsonParse(node.failure_json || '{}', {}), attemptCount: Number(node.attempt_count || 0), updatedAt: node.updated_at })),
    backendUse: Object.fromEntries([...new Set(nodeRows.map((node) => safeJsonParse(node.result_json || '{}', {}).selectedExecutorId).filter(Boolean))].sort().map((backend) => [backend, nodeRows.filter((node) => safeJsonParse(node.result_json || '{}', {}).selectedExecutorId === backend).length])),
    latestEvent: events[0] || null,
    events,
  };
});
const summary = {
  version: 1,
  kind: 'AutomationCampaignDashboard',
  status: 'automation_campaign_dashboard_ready',
  campaignCount: rows.length,
  byStatus: Object.fromEntries([...new Set(rows.map((row) => row.status))].sort().map((status) => [status, rows.filter((row) => row.status === status).length])),
  totalAgentCalls: rows.reduce((sum, row) => sum + row.usage.agentCalls, 0),
  totalTokens: rows.reduce((sum, row) => sum + row.usage.tokens, 0),
  totalCostUsd: rows.reduce((sum, row) => sum + row.usage.costUsd, 0),
  campaigns: rows,
  externalActionPerformed: false,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

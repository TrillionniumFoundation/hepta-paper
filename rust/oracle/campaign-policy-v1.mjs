// Test-only adapter. Every expected result calls the actual incumbent exports.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as state from '../../paper-domain/automation/campaign-state-policy.mjs';
import * as resource from '../../paper-domain/automation/campaign-mode-resource-budget.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';

const sources = [
  'paper-domain/automation/campaign-state-policy.mjs',
  'paper-domain/automation/campaign-mode-resource-budget.mjs',
];

function evaluate(request) {
  switch (request.kind) {
    case 'constants':
      return {
        CAMPAIGN_NODE_DONE_STATUSES: state.CAMPAIGN_NODE_DONE_STATUSES,
        CAMPAIGN_TERMINAL_STATUSES: state.CAMPAIGN_TERMINAL_STATUSES,
        CAMPAIGN_SETTLED_STATUSES: state.CAMPAIGN_SETTLED_STATUSES,
      };
    case 'projection':
      return state.deriveCampaignOperationalProjection(request.nodes);
    case 'ready':
      return state.selectReadyCampaignNodes(request.nodes, { limit: request.limit })
        .map((node) => node.nodeId);
    case 'failure':
      return state.decideNodeFailureTransition(request.node, { retryable: request.retryable });
    case 'descendants':
      return state.cascadeCancelledNodeIds(request.nodes, request.root_node_id);
    case 'future_round':
      return state.selectFutureRoundNodeIds(request.nodes, { afterRound: request.after_round });
    case 'command':
      return state.decideCampaignCommand({ status: request.campaign_status }, request.command);
    case 'manual_retry':
      return state.decideManualNodeRetry(request.node);
    case 'resource_budget': {
      const selector = request.selector && {
        selectorType: request.selector.selectorType,
        experimentDesign: {
          seedSchedule: Array(request.selector.seedCount).fill(1),
          minimumRepetitions: request.selector.minimumRepetitions,
        },
      };
      return {
        agentCalls: resource.plannedAgentCallUpperBound(request.nodes),
        benchmarkJobs: resource.plannedBenchmarkCellJobUpperBounds(request.nodes, selector),
      };
    }
    case 'empirical_profiles':
      return resource.empiricalExecutionProfiles(request.languages, request.requires_gpu, {
        excludeLean: request.exclude_lean,
      });
    default:
      throw new Error('unsupported oracle request');
  }
}

const input = fs.readFileSync(0);
if (input.length > 4 * 1024 * 1024) throw new Error('oracle input exceeds bound');
const requests = JSON.parse(input);
if (!Array.isArray(requests) || requests.length > 10000) throw new Error('oracle request bound');
console.log(JSON.stringify({
  profile: productionOracleProfile(),
  sources: Object.fromEntries(sources.map((relative) => [
    relative,
    createHash('sha256')
      .update(fs.readFileSync(new URL(`../../${relative}`, import.meta.url))).digest('hex'),
  ])),
  results: requests.map(evaluate),
}));

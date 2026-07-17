import {
  createResultMetricCollector,
  isMetricResultView,
  registerResultMetricTable,
  resultMetric,
} from './metric-descriptor-collector.mjs';
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';

const { count, max, sum } = resultMetric;

const CAMPAIGN_METRICS = Object.freeze({
  campaignQueue: Object.freeze({
    planned: count((result) => Boolean(result.campaignPlan)),
    submitted: count((result) => Boolean(result.campaignSubmission)),
    queued: count((result) => result.campaignSubmission?.status === 'paper_campaign_queued'),
    replayed: count((result) => result.campaignSubmission?.status === 'paper_campaign_already_queued'),
    nodeCount: sum((result) => result.campaignQueue?.nodeCount),
    maximumNodesPerCampaign: max((result) => Number(result.campaignQueue?.nodeCount || 0), 0),
    workflowExecutionsPerformed: count((result) => result.campaignQueue?.workflowExecutionPerformed === true),
  }),
  proposalStaging: Object.freeze({
    staged: count((result) => result.task?.registry?.inventorySource === 'proposal_staging'),
    sourceSkeletons: count((result) => (
      result.task?.registry?.inventorySource === 'proposal_staging'
      && normalizeText(result.task?.sourceWorkspace).includes('/runtime/proposals/')
    )),
  }),
});

export function summarizeCampaignResults(inputResults) {
  const ownsMetricCollector = !isMetricResultView(inputResults);
  const metricCollector = ownsMetricCollector
    ? createResultMetricCollector(inputResults)
    : inputResults.collector;
  const results = ownsMetricCollector ? metricCollector.results : inputResults;
  const summary = registerResultMetricTable(results, CAMPAIGN_METRICS);
  return ownsMetricCollector ? metricCollector.resolve(summary) : summary;
}

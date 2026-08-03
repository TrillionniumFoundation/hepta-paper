import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export const AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID =
  'autonomous-research:local-auto-20260730-57';
export const AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID = 'local-auto-20260730-57';
export const AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_OBJECTIVE =
  'Evaluate a deterministic bounded candidate intervention under the fixed finance_asset_pricing_benchmark protocol, including treatment, control, ablation, and an isolated deterministic rerun.';

export function verifyAutonomousResearchOneShotTargetCampaignDefinition(value) {
  const worker = value?.worker;
  const budgets = value?.budgets;
  return exactKeys(value, [
    'budgets', 'campaignId', 'datasetMountsHash', 'effectiveLaunchMode',
    'humanSubjects', 'localOnly', 'objective', 'paperId', 'privateData',
    'protocolFamily', 'refereeCount', 'requireCampaignAbsentAtLaunch',
    'requireLaunchReady', 'requestedLaunchMode', 'revisionRounds',
    'unlimitedAggregateCost', 'unlimitedAggregateTokens', 'version', 'worker',
  ].sort())
    && value.version === 1
    && value.campaignId === AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID
    && value.paperId === AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID
    && value.objective === AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_OBJECTIVE
    && value.protocolFamily === 'finance_asset_pricing_benchmark'
    && value.revisionRounds === 3 && value.refereeCount === 3
    && value.requestedLaunchMode === 'local-run'
    && value.effectiveLaunchMode === 'golden-bootstrap'
    && value.localOnly === true && value.humanSubjects === false
    && value.privateData === false && value.unlimitedAggregateTokens === true
    && value.unlimitedAggregateCost === true && value.requireLaunchReady === true
    && value.requireCampaignAbsentAtLaunch === true
    && SHA256.test(String(value.datasetMountsHash || ''))
    && exactKeys(worker, [
      'agentSlots', 'concurrency', 'cpuSlots', 'gpuSlots', 'memoryMiB',
    ].sort())
    && worker.concurrency === 8 && worker.agentSlots === 4
    && worker.cpuSlots === 4 && worker.gpuSlots === 1 && worker.memoryMiB === 8192
    && exactKeys(budgets, [
      'maxAgentCalls', 'maxCostUsd', 'maxCpuJobs', 'maxGpuJobs',
      'maxMemoryMiB', 'maxTokenCount', 'maxWallTimeMs',
    ].sort())
    && budgets.maxWallTimeMs === 7_200_000 && budgets.maxAgentCalls === 201
    && budgets.maxCpuJobs === 14_400 && budgets.maxGpuJobs === 16
    && budgets.maxMemoryMiB === 8192
    && budgets.maxTokenCount === Number.MAX_SAFE_INTEGER
    && budgets.maxCostUsd === Number.MAX_SAFE_INTEGER;
}

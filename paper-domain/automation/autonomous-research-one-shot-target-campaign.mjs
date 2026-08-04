import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const HISTORICAL_PAPER_ID = /^local-auto-20260730-([1-9][0-9]*)$/;
const ISSUED_HISTORICAL_TARGET_DEFINITION_HASHES = new Map([
  ['local-auto-20260730-52',
    'sha256:a0c372d5ae49b43f1fef3bf346d717d2a20139aa5372e0d9119a7b93d15ad052'],
  ['local-auto-20260730-53',
    'sha256:90b402a4d8c843b53416eacd5166be97f940d42c3af16b2d81b983cf27bc10b5'],
  ['local-auto-20260730-54',
    'sha256:ce331018eaa3a559c0ea55ecd7438459b11f0d09cb8e6ebde9a25f95cace63c8'],
  ['local-auto-20260730-55',
    'sha256:b1d6d9e3f0ce164edc906b1575b623b8f36a8f173df08cc6062732b3fd0f1cdb'],
  ['local-auto-20260730-56',
    'sha256:23f3e048ee4fae73e90d74a263411cad1bcdc7afd7f93c4155c0da6eac12479e'],
]);
const TARGET_KEYS = Object.freeze([
  'budgets', 'campaignId', 'datasetMountsHash', 'effectiveLaunchMode',
  'humanSubjects', 'localOnly', 'objective', 'paperId', 'privateData',
  'protocolFamily', 'refereeCount', 'requireCampaignAbsentAtLaunch',
  'requireLaunchReady', 'requestedLaunchMode', 'revisionRounds',
  'unlimitedAggregateCost', 'unlimitedAggregateTokens', 'version', 'worker',
].sort());

export const AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID =
  'autonomous-research:local-auto-20260730-57';
export const AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID = 'local-auto-20260730-57';
export const AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_DATASET_MOUNTS_HASH =
  'sha256:586dd4d1edb5ca3efee48d02726a1c7cf2044a6afe81b34bc5821c1e97d9c520';
export const AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_OBJECTIVE =
  'Evaluate a deterministic bounded candidate intervention under the fixed finance_asset_pricing_benchmark protocol, including treatment, control, ablation, and an isolated deterministic rerun.';

function verifyAutonomousResearchOneShotTargetCampaignPolicy(value) {
  const worker = value?.worker;
  const budgets = value?.budgets;
  return exactKeys(value, TARGET_KEYS)
    && value.version === 1
    && value.objective === AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_OBJECTIVE
    && value.protocolFamily === 'finance_asset_pricing_benchmark'
    && value.revisionRounds === 3 && value.refereeCount === 3
    && value.requestedLaunchMode === 'local-run'
    && value.effectiveLaunchMode === 'golden-bootstrap'
    && value.localOnly === true && value.humanSubjects === false
    && value.privateData === false && value.unlimitedAggregateTokens === true
    && value.unlimitedAggregateCost === true && value.requireLaunchReady === true
    && value.requireCampaignAbsentAtLaunch === true
    && value.datasetMountsHash
      === AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_DATASET_MOUNTS_HASH
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

export function verifyAutonomousResearchOneShotHistoricalTargetCampaignDefinition(value) {
  if (verifyAutonomousResearchOneShotTargetCampaignDefinition(value)) return true;
  const expectedHash = ISSUED_HISTORICAL_TARGET_DEFINITION_HASHES.get(
    String(value?.paperId || ''),
  );
  return Boolean(expectedHash
    && value.campaignId === `autonomous-research:${value.paperId}`
    && hashRecord('AutonomousResearchOneShotTargetCampaignDefinition', value)
      === expectedHash);
}

export function historicalAutonomousResearchOneShotCampaignOrdinal(value) {
  if (!verifyAutonomousResearchOneShotHistoricalTargetCampaignDefinition(value)) {
    return null;
  }
  return HISTORICAL_PAPER_ID.exec(value.paperId)[1];
}

export function verifyAutonomousResearchOneShotTargetCampaignDefinition(value) {
  return value?.campaignId === AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID
    && value.paperId === AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID
    && verifyAutonomousResearchOneShotTargetCampaignPolicy(value);
}

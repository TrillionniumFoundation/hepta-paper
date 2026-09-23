import {
  buildCanonicalGpuScientificCampaignExecutionPlan,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';

const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function buildAutonomousResearchGpuScientificExecutionPlan({
  campaignId,
  loopPreparation,
  budgets = {},
  productionReadiness = null,
} = {}) {
  if (loopPreparation?.launchMode !== 'production-run') return null;
  const gpuRuntime = productionReadiness?.runtimes?.gpuContainer || null;
  const gpuDeviceSelector = String(gpuRuntime?.deviceSelector || '');
  const startedAtEpochMs = Date.parse(String(loopPreparation?.createdAt || ''));
  const maxWallTimeMs = Number(budgets?.maxWallTimeMs);
  const absoluteExecutionDeadlineEpochMs = startedAtEpochMs + maxWallTimeMs;
  if (productionReadiness?.gpuScientificRuntimeReady !== true
    || gpuRuntime?.usable !== true
    || !GPU_UUID.test(gpuDeviceSelector)) {
    throw new Error(
      'autonomous_research_production_gpu_scientific_device_authority_required',
    );
  }
  if (!Number.isSafeInteger(startedAtEpochMs) || startedAtEpochMs < 1
    || !Number.isSafeInteger(maxWallTimeMs) || maxWallTimeMs < 1
    || !Number.isSafeInteger(absoluteExecutionDeadlineEpochMs)) {
    throw new Error(
      'autonomous_research_production_gpu_scientific_deadline_authority_required',
    );
  }
  return buildCanonicalGpuScientificCampaignExecutionPlan({
    campaignId,
    paperId: loopPreparation.proposal.paperId,
    gpuDeviceSelector,
    absoluteExecutionDeadlineEpochMs,
  });
}

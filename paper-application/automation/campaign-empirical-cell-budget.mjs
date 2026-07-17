function abortError(signal, fallback = 'campaign_execution_aborted') {
  const error = new Error(String(signal?.reason || fallback));
  error.retryable = true;
  return error;
}

function terminalBudgetError(campaignStore, campaignId, blocker) {
  campaignStore.stopCampaign(campaignId, blocker);
  const error = new Error(blocker);
  error.retryable = false;
  return error;
}

export function createCampaignEmpiricalCellRunner({ campaignId, campaignStore, controller } = {}) {
  if (!campaignId || !campaignStore || !controller?.signal) {
    throw new Error('campaign_empirical_cell_meter_inputs_required');
  }
  return async (operation, { requiresGpu = false } = {}) => {
    if (typeof operation !== 'function') throw new Error('campaign_empirical_cell_operation_required');
    if (controller.signal.aborted) throw abortError(controller.signal);
    const campaign = campaignStore.getCampaign(campaignId);
    if (campaign?.status !== 'running') throw abortError(controller.signal, `campaign_${campaign?.status || 'unavailable'}`);
    const budgets = campaign.spec?.budgets || {};
    if (campaign.cpuJobCount >= Number(budgets.maxCpuJobs ?? Infinity)) {
      throw terminalBudgetError(campaignStore, campaignId, 'campaign_cpu_job_budget_exhausted');
    }
    if (requiresGpu && campaign.gpuJobCount >= Number(budgets.maxGpuJobs ?? Infinity)) {
      throw terminalBudgetError(campaignStore, campaignId, 'campaign_gpu_job_budget_exhausted');
    }
    try {
      campaignStore.recordUsage(
        campaignId,
        { cpuJobs: 1, gpuJobs: requiresGpu ? 1 : 0 },
        { enforceBudget: true },
      );
    } catch {
      const latest = campaignStore.getCampaign(campaignId);
      const latestBudgets = latest?.spec?.budgets || budgets;
      const gpuExhausted = requiresGpu
        && latest?.gpuJobCount >= Number(latestBudgets.maxGpuJobs ?? Infinity);
      throw terminalBudgetError(
        campaignStore,
        campaignId,
        gpuExhausted
          ? 'campaign_gpu_job_budget_exhausted'
          : 'campaign_cpu_job_budget_exhausted',
      );
    }
    const result = await operation({ signal: controller.signal });
    if (controller.signal.aborted) throw abortError(controller.signal);
    return result;
  };
}

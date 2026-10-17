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

function infrastructureControlError(error) {
  return error?.committed === true
    || error?.stateRecoverabilityFatal === true
    || error?.stateRecoverabilityDeferred === true
    || error?.authorityEvidenceRenewalFatal === true
    || error?.authorityEvidenceRenewalDeferred === true
    || error?.residentReactivationRequired === true;
}

export function createCampaignEmpiricalCellRunner({
  campaignId,
  campaignStore,
  controller,
  nodeAttempt = null,
  assertExternalSideEffectReady = null,
  externalActionStarted = null,
} = {}) {
  if (!campaignId || !campaignStore || !controller?.signal) {
    throw new Error('campaign_empirical_cell_meter_inputs_required');
  }
  return async (operation, { requiresGpu = false } = {}) => {
    if (typeof operation !== 'function') throw new Error('campaign_empirical_cell_operation_required');
    if (controller.signal.aborted) throw abortError(controller.signal);
    const reserveUsage = async () => {
      const campaign = campaignStore.getCampaign(campaignId);
      if (campaign?.status !== 'running') throw abortError(
        controller.signal,
        `campaign_${campaign?.status || 'unavailable'}`,
      );
      const budgets = campaign.spec?.budgets || {};
      if (campaign.cpuJobCount >= Number(budgets.maxCpuJobs ?? Infinity)) {
        throw terminalBudgetError(
          campaignStore, campaignId, 'campaign_cpu_job_budget_exhausted',
        );
      }
      if (requiresGpu
        && campaign.gpuJobCount >= Number(budgets.maxGpuJobs ?? Infinity)) {
        throw terminalBudgetError(
          campaignStore, campaignId, 'campaign_gpu_job_budget_exhausted',
        );
      }
      const usageDelta = { cpuJobs: 1, gpuJobs: requiresGpu ? 1 : 0 };
      try {
        if (nodeAttempt && assertExternalSideEffectReady
        && externalActionStarted?.() !== true) {
          campaignStore.reserveNodeInfrastructureUsage({
            ...nodeAttempt,
            usageDelta,
          });
        } else {
          campaignStore.recordUsage(
            campaignId,
            usageDelta,
            { enforceBudget: true },
          );
        }
      } catch (error) {
        if (infrastructureControlError(error)) throw error;
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
    };
    const executeCell = (identity = {}) => {
      if (controller.signal.aborted) throw abortError(controller.signal);
      return operation({ ...identity, signal: controller.signal });
    };
    let result;
    if (assertExternalSideEffectReady?.run) {
      const action = `campaign_empirical_cell_execute:${nodeAttempt?.nodeId || campaignId}`;
      const request = {
        action,
        campaignId,
        nodeId: nodeAttempt?.nodeId || null,
        requiresGpu: Boolean(requiresGpu),
      };
      result = await assertExternalSideEffectReady.run(
        request,
        ({ externalActionId }) => executeCell({
          signal: controller.signal,
          externalActionId,
          idempotencyKey: externalActionId,
        }),
        { beforeStart: reserveUsage },
      );
    } else {
      await reserveUsage();
      if (assertExternalSideEffectReady) {
        const request = {
          action: `campaign_empirical_cell_execute:${nodeAttempt?.nodeId || campaignId}`,
          campaignId,
          nodeId: nodeAttempt?.nodeId || null,
          requiresGpu: Boolean(requiresGpu),
        };
        await assertExternalSideEffectReady(request);
        assertExternalSideEffectReady.assertCurrent?.(request);
        await assertExternalSideEffectReady.markStarted?.(request);
      }
      result = await executeCell();
    }
    if (controller.signal.aborted) throw abortError(controller.signal);
    return result;
  };
}

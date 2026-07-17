function autonomousCampaign(campaign) {
  return Boolean(campaign?.campaignId?.startsWith('autonomous-research:')
    && campaign?.spec?.autonomousResearchPreparation
    && campaign.spec.autonomousResearchPreparation.proposal?.paperId === campaign.paperId);
}

export function selectFairAutonomousCampaignWindow(campaigns, {
  afterCampaignId = null,
  limit = 100,
} = {}) {
  const ordered = [...(campaigns || [])]
    .filter(autonomousCampaign)
    .filter((campaign) => campaign.effectiveStatus !== 'superseded')
    .sort((left, right) => String(left.campaignId).localeCompare(String(right.campaignId)));
  if (!ordered.length) return Object.freeze({ campaigns: Object.freeze([]), nextCursor: null });
  const boundedLimit = Math.max(1, Math.min(10_000, Number(limit || 100)));
  const afterIndex = afterCampaignId === null
    ? -1 : ordered.findIndex((campaign) => campaign.campaignId === afterCampaignId);
  const start = (afterIndex + 1) % ordered.length;
  const selected = [];
  for (let offset = 0; offset < Math.min(boundedLimit, ordered.length); offset += 1) {
    selected.push(ordered[(start + offset) % ordered.length]);
  }
  return Object.freeze({
    campaigns: Object.freeze(selected),
    nextCursor: selected.at(-1)?.campaignId || null,
  });
}

export function discoverAutonomousResearchCampaignWindow({
  campaignStore,
  autonomyFence,
  operationMode,
  machineIntake,
  afterCampaignId,
  limit,
} = {}) {
  const allCampaigns = [];
  const discoveredIds = new Set();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const page = campaignStore.listCampaigns({ effectiveOnly: false, limit: pageSize, offset });
    const unseen = page.filter((campaign) => !discoveredIds.has(campaign.campaignId));
    unseen.forEach((campaign) => discoveredIds.add(campaign.campaignId));
    allCampaigns.push(...unseen);
    if (page.length < pageSize || unseen.length === 0) break;
  }
  const candidates = allCampaigns.filter(autonomousCampaign);
  const eligible = operationMode === 'bootstrap-only'
    ? candidates.filter((campaign) => {
      const intakeId = campaign?.spec?.autonomousResearchMachineIntakeAdmission?.intakeId;
      const record = machineIntake && intakeId
        ? machineIntake.repository.readIntake(intakeId) : null;
      return autonomyFence.inspectCampaign({ campaign, record, operationMode }).ready;
    }) : candidates;
  const window = selectFairAutonomousCampaignWindow(eligible, { afterCampaignId, limit });
  return Object.freeze({
    ...window,
    candidateCampaignCount: candidates.length,
    suppressedCampaignCount: candidates.length - eligible.length,
  });
}

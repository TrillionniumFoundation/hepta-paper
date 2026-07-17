export function autonomousResearchCommandExitCode({
  action,
  report,
  requireFullReady = false,
  requireLaunchReady = false,
} = {}) {
  if (action === 'converge'
    && report?.status !== 'autonomous_research_campaign_completed_and_qualified') return 2;
  if (requireFullReady) {
    const fullReady = action === 'prepare'
      ? report?.unattendedCampaignLaunchReady === true
        && report?.externalQualificationServiceReady === true
      : report?.campaignFullyQualified === true;
    if (!fullReady) return 2;
  }
  if (requireLaunchReady) {
    const launchReady = action === 'prepare'
      ? report?.unattendedCampaignLaunchReady === true
      : report?.autonomousExecutionLaunchReady === true
        || report?.qualificationEligibility?.autonomousExecutionLaunchReady === true;
    if (!launchReady) return 2;
  }
  return 0;
}

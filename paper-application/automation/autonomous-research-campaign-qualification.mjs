import {
  evaluateAutonomousResearchQualificationEligibility,
} from '../../paper-domain/automation/autonomous-research-readiness-policy.mjs';
import { requestExternalResearchQualification } from './external-qualification-recovery.mjs';

export function evaluateAutonomousResearchCampaignQualification({
  preparation,
  campaignReleaseAuthority,
  inspection = null,
} = {}) {
  return evaluateAutonomousResearchQualificationEligibility({
    proposal: preparation?.proposal,
    policyAuthorization: preparation?.policyAuthorization,
    seedBundle: preparation?.seedBundle,
    seedBinding: preparation?.seedBinding,
    principalSeparation: preparation?.principalSeparation,
    topologyInspection: preparation?.topologyInspection,
    datasetLaunchInspection: preparation?.datasetLaunchInspection,
    empiricalRuntimeCapabilityInspection: preparation?.empiricalRuntimeCapabilityInspection,
    empiricalExecutionProfileSelection: preparation?.empiricalExecutionProfileSelection,
    runtimeImageReproducibilityInspection:
      preparation?.runtimeImageReproducibilityInspection,
    capabilityScopeManifest: preparation?.capabilityScopeManifest,
    externalCapabilityTrustInspection:
      preparation?.externalCapabilityTrustInspection,
    researchAgendaProducerReceipt:
      preparation?.researchAgendaProducerReceipt,
    autonomousResearchProviderConfigurationHash:
      preparation?.autonomousResearchProviderConfigurationHash,
    autonomousResearchLoopPreparationReportHash:
      preparation?.autonomousResearchLoopPreparationReportHash,
    autonomousResearchMachineIntakeAdmissionHash:
      preparation?.autonomousResearchMachineIntakeAdmissionHash,
    launchMode: preparation?.launchMode,
    observedAt: preparation?.createdAt,
    campaignReleaseAuthority,
    fullResearchQualificationInspection: inspection,
  });
}

export async function requestAutonomousResearchCampaignQualification({
  externalQualificationClient,
  externalQualificationVerifier,
  campaignReleaseAuthority,
  preparation,
  qualificationStateStore = null,
  allowRequest = false,
  retry = {},
} = {}) {
  return requestExternalResearchQualification({
    externalQualificationClient,
    externalQualificationVerifier,
    campaignReleaseAuthority,
    preparation,
    qualificationStateStore,
    allowRequest,
    retry,
    evaluateEligibility: (inspection) => evaluateAutonomousResearchCampaignQualification({
      preparation,
      campaignReleaseAuthority,
      inspection,
    }),
  });
}

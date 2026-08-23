import {
  inspectPersistedAutonomousResearchAgendaAuthority,
} from './automation-readiness-agenda-authority-inspection.mjs';
import {
  inspectPersistedExperimentIrExecutionAuthority,
} from './automation-readiness-experiment-ir-authority-inspection.mjs';
import {
  inspectPersistedAutonomousResearchVenueRequirementAuthority,
} from './automation-readiness-venue-requirement-authority-inspection.mjs';
import {
  inspectPersistedCampaignResearchGpuScientificReleaseChain,
  inspectPersistedAutonomousResearchAssuranceAuthority,
} from './automation-readiness-research-assurance-authority-inspection.mjs';
import {
  inspectConfiguredAutonomousResearchCapabilityScope,
} from './autonomous-research-external-capability-composition.mjs';
import {
  composeAutonomousSubmissionDispatchContext,
} from './autonomous-submission-runtime-composition.mjs';

export function composeAutomationReadinessCapabilityScope({
  store,
  root,
  runtimeRoot,
  now,
  environment,
  providerInspections,
  providerSpawnSync,
  currentDynamicFormalExecutionAuthority = null,
  gpuScientificPromotionAuthorityVerifier = null,
} = {}) {
  const inspectionClock = Object.freeze({ now: () => new Date(now) });
  const initialAutonomousResearchAgendaAuthorityInspection =
    inspectPersistedAutonomousResearchAgendaAuthority({ store });
  const { autonomousSubmissionRequestVerifier } = composeAutonomousSubmissionDispatchContext({
    root,
    runtimeRoot,
    clock: inspectionClock,
    environment,
    handoffOnly: true,
  });
  const capabilityScopeInspection = inspectConfiguredAutonomousResearchCapabilityScope({
    environment,
    providerInspections,
    providerSpawnSync,
    researchAgendaProducerReceipt:
      initialAutonomousResearchAgendaAuthorityInspection
        .researchAgendaProducerReceipt,
    autonomousSubmissionRequestVerifier,
    clock: inspectionClock,
  });
  const autonomousResearchAgendaAuthorityInspection =
    inspectPersistedAutonomousResearchAgendaAuthority({
      store,
      expectedAgendaAuthorityInspection:
        initialAutonomousResearchAgendaAuthorityInspection,
      currentPriorArtAuthorityTrustConfiguration:
        capabilityScopeInspection.priorArtAuthorityTrustConfiguration,
      currentExternalCapabilityTrustInspection:
        capabilityScopeInspection.externalCapabilityTrustInspection,
      now,
    });
  const experimentIrExecutionAuthorityInspection =
    inspectPersistedExperimentIrExecutionAuthority({
      store,
      agendaAuthorityInspection: autonomousResearchAgendaAuthorityInspection,
    });
  const autonomousResearchVenueRequirementAuthorityInspection =
    inspectPersistedAutonomousResearchVenueRequirementAuthority({
      store,
      expectedVenueProfileRegistryHash:
        capabilityScopeInspection.venueProfileRegistryHash,
      expectedVenueAuthorityConfigurationHash:
        capabilityScopeInspection.venueProfileRegistryAuthorityConfigurationHash,
      expectedSubmissionMetadataAuthorityConfigurationHash:
        capabilityScopeInspection.submissionMetadataAuthorityConfigurationHash,
      expectedAgendaAuthorityInspection:
        autonomousResearchAgendaAuthorityInspection,
    });
  const gpuScientificReleaseChainInspection =
    inspectPersistedCampaignResearchGpuScientificReleaseChain({
      store,
      campaignId: autonomousResearchAgendaAuthorityInspection.campaignId,
      paperId: autonomousResearchAgendaAuthorityInspection.paperId,
      expectedAgendaAuthorityInspection:
        autonomousResearchAgendaAuthorityInspection,
      gpuScientificPromotionAuthorityVerifier,
      runtimeRoot,
      now,
    });
  const autonomousResearchAssuranceAuthorityInspection =
    inspectPersistedAutonomousResearchAssuranceAuthority({
      store,
      expectedAgendaAuthorityInspection:
        autonomousResearchAgendaAuthorityInspection,
      expectedExperimentIrExecutionAuthorityInspection:
        experimentIrExecutionAuthorityInspection,
      currentDynamicFormalExecutionAuthority,
      externalResearchReplayReceiptVerifier:
        capabilityScopeInspection.externalResearchReplayReceiptVerifier,
      reviewerReceiptVerificationAuthority:
        capabilityScopeInspection.reviewerReceiptVerificationAuthority,
      gpuScientificPromotionAuthorityVerifier,
      gpuScientificReleaseChainInspection,
      runtimeRoot,
      now,
    });
  return Object.freeze({
    autonomousResearchAgendaAuthorityInspection,
    experimentIrExecutionAuthorityInspection,
    autonomousResearchVenueRequirementAuthorityInspection,
    autonomousResearchAssuranceAuthorityInspection,
    capabilityScopeInspection,
  });
}

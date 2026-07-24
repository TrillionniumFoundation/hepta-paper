import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import {
  createAgentResearchContentProducer,
} from '../../paper-adapters/automation/agent-research-content-producer.mjs';
import {
  createAgentResearchAgendaProducer,
} from '../../paper-adapters/automation/agent-research-agenda-producer.mjs';
import { prepareAutonomousResearchLoop } from '../../paper-application/automation/autonomous-research-readiness.mjs';
import {
  composeAutonomousResearchRuntimePrincipalBinding,
} from '../../paper-application/automation/autonomous-research-runtime-principal-binding.mjs';
import {
  requireAutonomousResearchProviderConfiguration,
  resolveAutonomousResearchProviderConfiguration,
} from './autonomous-research-provider-configuration.mjs';
import {
  evaluateExternalQualificationServiceReadiness,
  evaluateUnattendedCampaignLaunchReadiness,
  releaseAttestorProductionInspectionReady,
} from './autonomous-research-readiness-inspections.mjs';
import {
  buildAutonomousResearchProductionAdmissionReadiness,
  createAutonomousResearchAdmissionPreflightSandbox,
  createAutonomousResearchMachineIntakeActionFence,
  verifyAutonomousResearchSupervisorReadinessAuthorization,
} from './autonomous-research-enqueue-admission.mjs';
import {
  inspectAutonomousResearchResidentPrerequisites,
} from './autonomous-research-resident-prerequisite-inspection.mjs';
import {
  inspectResearchExecutionReleaseAttestorConfiguration,
} from '../../paper-adapters/build-package/research-execution-release-attestor.mjs';
import {
  inspectConfiguredPinnedFormalSandboxRuntime,
} from '../../paper-adapters/research-verify/pinned-formal-sandbox-runtime-configuration.mjs';
import {
  createAutomationReadinessSideEffectLedger,
} from './automation-readiness-runtime-probes.mjs';
import {
  composeAutonomousResearchExternalCapabilities,
} from './autonomous-research-external-capability-composition.mjs';
import {
  inspectAutonomousResearchRuntimePrincipals,
} from './autonomous-research-runtime-principal-preflight.mjs';
import {
  AUTONOMOUS_RESEARCH_LAUNCH_MODES,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
import {
  inspectAutonomousResearchProductionProfileInputs,
} from '../../paper-domain/automation/autonomous-research-production-profile-contract.mjs';
import {
  buildAutonomousResearchAgentProductionAuthorityBinding,
} from '../../paper-domain/automation/autonomous-research-agent-production-authority-binding.mjs';

export {
  createAutonomousResearchAdmissionPreflightSandbox,
  createAutonomousResearchMachineIntakeActionFence,
  verifyAutonomousResearchSupervisorReadinessAuthorization,
};

export function inspectAutonomousResearchProductionAdmissionReadiness({
  runtimeRoot,
  environment,
  releaseAttestorInspection,
  capabilityScopeManifest = null,
  researchAgendaProducerReceipt = null,
  now,
} = {}) {
  return buildAutonomousResearchProductionAdmissionReadiness({
    residentPrerequisites: inspectAutonomousResearchResidentPrerequisites({
      runtimeRoot, environment, now,
    }),
    releaseAttestorInspection,
    capabilityScopeManifest,
    researchAgendaProducerReceipt,
    now,
  });
}

export function requireAutonomousResearchProductionReleaseAttestorInspection({
  report,
  observedAt,
} = {}) {
  const inspection = report?.researchExecutionReleaseAttestor || null;
  if (!releaseAttestorProductionInspectionReady(inspection)
    || report?.researchExecutionReleaseAttestorReady !== true
    || report?.researchExecutionReleaseAttestorProductionReady !== true
    || inspection?.inspectedAt !== observedAt?.toISOString?.()
    || inspection?.backendProbeExternalActionAttempted !== true
    || inspection?.activeSignerChallengeExternalActionAttempted !== true
    || inspection?.externalActionPerformed !== true) {
    throw new Error('autonomous_research_production_release_attestor_inspection_invalid');
  }
  return inspection;
}

export function inspectAutonomousResearchCampaignReleaseAttestor({
  productionMutation = false,
  productionReadiness = null,
  productionReadinessObservedAt = null,
  runtimeRoot,
  configPath = null,
  observedAt,
  environment = process.env,
  activeVerification = false,
  spawnSyncImpl = undefined,
} = {}) {
  if (productionMutation) {
    return Object.freeze({
      inspection: requireAutonomousResearchProductionReleaseAttestorInspection({
        report: productionReadiness,
        observedAt: productionReadinessObservedAt,
      }),
      sideEffectLedger: null,
    });
  }
  const sideEffectLedger = createAutomationReadinessSideEffectLedger({
    environment,
    spawnSyncImpl,
  });
  let inspection = null;
  try {
    inspection = inspectResearchExecutionReleaseAttestorConfiguration({
      runtimeRoot,
      configPath,
      now: observedAt,
      environment,
      activeVerification,
      spawnSyncImpl: sideEffectLedger.spawnSyncFor('release-attestor'),
    });
  } catch (error) {
    throw sideEffectLedger.attachFailureInspection(error, {
      releaseAttestorInspection: inspection,
    });
  }
  return Object.freeze({ inspection, sideEffectLedger });
}

export function attachAutonomousResearchReadinessFailure({
  error,
  productionReadiness = null,
  sideEffectLedger = null,
  releaseAttestorInspection = null,
} = {}) {
  const failure = error instanceof Error ? error : new Error(errorCode(error));
  if (failure.automationReadinessSideEffectInspection) return failure;
  const inspection = productionReadiness?.readinessSideEffectInspection
    || (sideEffectLedger ? sideEffectLedger.inspection({
      releaseAttestorInspection,
      failureCode: errorCode(failure),
    }) : null);
  if (inspection) failure.automationReadinessSideEffectInspection = inspection;
  return failure;
}

function errorCode(error) {
  return String(error?.message || error || 'unknown_error').slice(0, 512);
}

function createReadinessInspectionClock({ createdAt, clock }) {
  if (typeof clock?.now !== 'function') {
    throw new Error('autonomous_research_readiness_clock_invalid');
  }
  const observed = createdAt === null || createdAt === undefined
    ? clock.now() : new Date(createdAt);
  const observedAt = observed instanceof Date ? observed : new Date(observed);
  if (Number.isNaN(observedAt.getTime())) {
    throw new Error('autonomous_research_readiness_observed_at_invalid');
  }
  const observedAtMilliseconds = observedAt.getTime();
  return Object.freeze({ now: () => new Date(observedAtMilliseconds) });
}

export async function composeAutonomousResearchReadiness({
  paperId,
  objective,
  protocolFamily,
  hypothesisGenerator = null,
  researchAgendaProducer = null,
  researchContentProducer = null,
  venueProfileRegistry = null,
  venueProfileRegistryAuthority = null,
  venueTemplateAssetBundle = null,
  submissionMetadataProfile = null,
  submissionMetadataAuthority = null,
  priorArtRetriever = null,
  externalResearchReplay = null,
  autonomousSubmissionPortal = null,
  autonomousSubmissionRequestVerifier = null,
  autonomousSubmissionPortalDispatchCapability = null,
  researchContentWorkspace = null,
  runtimeRoot = null,
  campaignReleaseAuthority = null,
  revisionRounds = 3,
  refereeCount = 3,
  humanSubjects = false,
  privateData = false,
  datasetMounts = [],
  datasetAuthorityReceipt = null,
  machineIntake = null,
  machineIntakeAdmission = null,
  createdAt = null,
  clock = { now: () => new Date() },
  environment = process.env,
  providerConfiguration = null,
  expectedProviderConfigurationHash = null,
  releaseAttestorInspection = null,
  externalQualificationConfigurationInspection = null,
  externalQualificationClient = null,
  externalQualificationVerifier = null,
  launchMode = null,
  launchModeGate = null,
  providerPricingInspection = null,
  preflightAuthor,
  preflightReviewer,
  preflightEmpiricalRuntime,
  preflightReviewerPrincipalPool,
  spawnSyncImpl = undefined,
  assertExternalSideEffectReady = null,
} = {}) {
  const inspectionClock = createReadinessInspectionClock({ createdAt, clock });
  const effectiveProviderConfiguration = requireAutonomousResearchProviderConfiguration(
    providerConfiguration || resolveAutonomousResearchProviderConfiguration({ environment }),
    { expectedHash: expectedProviderConfigurationHash },
  );
  const authorConfiguration = effectiveProviderConfiguration.researchAuthor;
  const reviewerConfiguration = effectiveProviderConfiguration.formalReviewer;
  const principalInspection = inspectAutonomousResearchRuntimePrincipals({
    authorConfiguration,
    reviewerConfiguration,
    refereeCount,
    environment,
    preflightAuthor,
    preflightReviewer,
    preflightEmpiricalRuntime,
    preflightReviewerPrincipalPool,
    spawnSyncImpl,
    clock: inspectionClock,
  });
  const {
    author,
    reviewer,
    reviewerPrincipalPoolInspection,
    authorIdentityAttestation,
    empiricalRuntimeCapabilityInspection,
    empiricalPluginStartupInspection,
  } = principalInspection;
  const preflightBlockers = [...principalInspection.blockers];
  const effectiveLaunchMode = launchModeGate?.launchMode
    || launchMode
    || AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP;
  const strongProductionRequired = effectiveLaunchMode
    === AUTONOMOUS_RESEARCH_LAUNCH_MODES.PRODUCTION_RUN;
  const requestedContentMode = String(
    environment.HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE || 'deterministic-bounded',
  ).trim().toLowerCase();
  if (!['deterministic-bounded', 'agent-evidence-bound'].includes(requestedContentMode)) {
    throw new Error(`autonomous_research_content_mode_invalid:${requestedContentMode}`);
  }
  const dynamicFormalClaimsEnabled = ['1', 'true', 'yes'].includes(String(
    environment.HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED || '',
  ).trim().toLowerCase());
  const formalSandboxRuntimeInspection =
    inspectConfiguredPinnedFormalSandboxRuntime({
      environment,
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    });
  if (dynamicFormalClaimsEnabled && formalSandboxRuntimeInspection.ready !== true) {
    preflightBlockers.push(...formalSandboxRuntimeInspection.blockers);
  }
  if (strongProductionRequired && requestedContentMode !== 'agent-evidence-bound') {
    preflightBlockers.push('autonomous_research_production_agent_content_mode_required');
  }
  if (strongProductionRequired && !dynamicFormalClaimsEnabled) {
    preflightBlockers.push('autonomous_research_production_dynamic_formal_claims_required');
  }
  if (strongProductionRequired && (authorIdentityAttestation?.ready !== true
    || authorIdentityAttestation?.configurationPinned !== true)) {
    preflightBlockers.push('autonomous_research_production_author_identity_required');
  }
  const externalCapabilities = composeAutonomousResearchExternalCapabilities({
    paperId,
    refereeCount,
    requestedContentMode,
    dynamicFormalClaimsEnabled,
    reviewerPrincipalPoolInspection,
    venueProfileRegistry,
    venueProfileRegistryAuthority,
    venueTemplateAssetBundle,
    submissionMetadataProfile,
    submissionMetadataAuthority,
    priorArtRetriever,
    externalResearchReplay,
    autonomousSubmissionPortal,
    autonomousSubmissionRequestVerifier,
    autonomousSubmissionPortalDispatchCapability,
    requestedProtocolFamily: protocolFamily,
    authorIdentityAttestation,
    environment,
    spawnSyncImpl,
    clock: inspectionClock,
  });
  preflightBlockers.push(...externalCapabilities.blockers);
  const {
    effectiveVenueProfileRegistry,
    effectiveVenueProfileRegistryAuthority,
    effectiveVenueTemplateAssetBundle,
    effectiveSubmissionMetadataProfile,
    effectiveSubmissionMetadataAuthority,
    effectivePriorArtRetriever,
    effectiveExternalResearchReplay,
    effectiveAutonomousSubmissionPortal,
    venueComplianceRuntimeInspection,
    contentCapabilityScopeManifest,
    empiricalFamilies,
    externalCapabilityTrustInspection,
  } = externalCapabilities;
  let productionAuthorityBinding = null;
  if (strongProductionRequired) {
    const configuredProfileInspection = inspectAutonomousResearchProductionProfileInputs({
      launchMode: effectiveLaunchMode,
      researchAgendaProducer: Object.freeze({}),
      hypothesisGenerator: Object.freeze({}),
      requireAgentAuthoredProse: requestedContentMode === 'agent-evidence-bound',
      capabilityScopeManifest: contentCapabilityScopeManifest,
      externalCapabilityTrustInspection,
    });
    preflightBlockers.push(...configuredProfileInspection.blockers);
    if (preflightBlockers.length) {
      throw new Error(
        `autonomous_research_production_preflight_blocked:${[...new Set(preflightBlockers)].join(',')}`,
      );
    }
    const runtimePrincipalBinding = composeAutonomousResearchRuntimePrincipalBinding({
      required: true,
      authorIdentityConfigurationHash: authorIdentityAttestation.configurationHash,
      authorPrincipal: Object.freeze({
        principalId: author.effectivePrincipalId,
        capabilityReceipt: author.capabilityReceipt,
        identityAttestationSubjectHash: authorIdentityAttestation.subject
          .externalPrincipalIdentityAttestationSubjectHash,
      }),
      researchPrincipalPool: reviewerPrincipalPoolInspection.pool,
      externalCapabilityTrustInspection,
    });
    productionAuthorityBinding = buildAutonomousResearchAgentProductionAuthorityBinding({
      runtimePrincipalBinding,
      autonomousResearchProviderConfigurationHash:
        effectiveProviderConfiguration.autonomousResearchProviderConfigurationHash,
      authorPrincipalId: author.effectivePrincipalId,
      authorProvider: author.capabilityReceipt.provider,
      authorModel: author.capabilityReceipt.model,
      authorCapabilityReceiptHash:
        author.capabilityReceipt.codexResearchAuthorCapabilityReceiptHash,
      authorCredentialRootIdentityHash:
        author.capabilityReceipt.credentialRootIdentityHash,
      authorCredentialConfigIdentityHash:
        author.capabilityReceipt.credentialConfigIdentityHash,
    });
  }
  let effectiveResearchAgendaProducer = researchAgendaProducer || null;
  let effectiveHypothesisGenerator = hypothesisGenerator || researchContentProducer || null;
  if ((!effectiveResearchAgendaProducer || !effectiveHypothesisGenerator)
    && requestedContentMode === 'agent-evidence-bound') {
    if (!author || !researchContentWorkspace || !runtimeRoot) {
      preflightBlockers.push('autonomous_research_agent_agenda_and_content_dependencies_missing');
    } else {
      try {
        const contentExecutor = createCodexAgentExecutor({
          codexBinary: author.codexBinary || authorConfiguration.codexBinary,
          codexHome: author.codexHome || authorConfiguration.codexHome,
          model: authorConfiguration.model,
          principalId: author.effectivePrincipalId,
          researchAuthorCapabilityReceipt: author.capabilityReceipt,
        });
        const producerClock = inspectionClock;
        effectiveResearchAgendaProducer ||= createAgentResearchAgendaProducer({
          agentExecutor: contentExecutor,
          workspacePath: researchContentWorkspace,
          cacheRoot: `${runtimeRoot}/automation-cache/research-agenda`,
          producerId: author.effectivePrincipalId,
          allowedProtocolFamilies: empiricalFamilies,
          productionAuthorityBinding,
          clock: producerClock,
          assertExternalSideEffectReady,
        });
        effectiveHypothesisGenerator ||= createAgentResearchContentProducer({
          agentExecutor: contentExecutor,
          workspacePath: researchContentWorkspace,
          cacheRoot: `${runtimeRoot}/automation-cache/research-content`,
          producerId: author.effectivePrincipalId,
          allowedProtocolFamilies: empiricalFamilies,
          dynamicFormalClaimsEnabled,
          capabilityScopeManifestHash:
            contentCapabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash,
          productionAuthorityBinding,
          clock: producerClock,
          assertExternalSideEffectReady,
        });
      } catch (error) {
        preflightBlockers.push(`autonomous_research_agent_agenda_or_content_producer_invalid:${errorCode(error)}`);
      }
    }
  }
  if (requestedContentMode === 'agent-evidence-bound'
    && (!effectiveResearchAgendaProducer || !effectiveHypothesisGenerator)) {
    preflightBlockers.push('autonomous_research_agent_agenda_and_content_producers_required');
    effectiveResearchAgendaProducer = null;
    effectiveHypothesisGenerator = null;
  }
  if (strongProductionRequired
    && (!effectiveResearchAgendaProducer || !effectiveHypothesisGenerator)) {
    throw new Error('autonomous_research_production_agent_content_producers_required');
  }
  const loopPreparation = await prepareAutonomousResearchLoop({
    paperId,
    objective,
    protocolFamily,
    researchAgendaProducer: effectiveResearchAgendaProducer,
    hypothesisGenerator: effectiveHypothesisGenerator,
    requireAgentAuthoredProse: requestedContentMode === 'agent-evidence-bound',
    declaredCapabilityScopeManifest: (effectiveResearchAgendaProducer
      && effectiveHypothesisGenerator)
      || requestedContentMode === 'deterministic-bounded'
      ? contentCapabilityScopeManifest : null,
    venueProfileRegistry: effectiveVenueProfileRegistry,
    venueProfileRegistryAuthority: effectiveVenueProfileRegistryAuthority,
    venueTemplateAssetBundle: effectiveVenueTemplateAssetBundle,
    submissionMetadataProfile: effectiveSubmissionMetadataProfile,
    submissionMetadataAuthority: effectiveSubmissionMetadataAuthority,
    autonomousSubmissionPortalConfigurationHash:
      effectiveAutonomousSubmissionPortal?.configurationHash || null,
    externalResearchReplayConfigurationHash:
      effectiveExternalResearchReplay?.configurationHash || null,
    venueComplianceRuntimeInspection,
    priorArtRetriever: effectivePriorArtRetriever,
    authorIdentityAttestation: authorIdentityAttestation?.subject || null,
    authorIdentityAuthorityEnvelope:
      authorIdentityAttestation?.authorityEnvelope || null,
    authorIdentityConfigurationHash:
      authorIdentityAttestation?.configurationHash || null,
    externalCapabilityTrustInspection,
    authorPrincipal: author ? Object.freeze({
      principalId: author.effectivePrincipalId,
      capabilityReceipt: author.capabilityReceipt,
      identityAttestationSubjectHash:
        authorIdentityAttestation?.subject
          ?.externalPrincipalIdentityAttestationSubjectHash || null,
    }) : null,
    formalReviewerPrincipal: reviewer ? Object.freeze({
      principalId: reviewer.effectivePrincipalId,
      capabilityReceipt: reviewer.capabilityReceipt,
    }) : null,
    researchPrincipalPool: reviewerPrincipalPoolInspection?.pool || null,
    campaignReleaseAuthority,
    revisionRounds,
    refereeCount,
    humanSubjects,
    privateData,
    datasetMounts,
    datasetAuthorityReceipt,
    empiricalRuntimeCapabilityInspection,
    autonomousResearchProviderConfigurationHash:
      effectiveProviderConfiguration.autonomousResearchProviderConfigurationHash,
    productionAuthorityBinding,
    machineIntake,
    machineIntakeAdmission,
    assertExternalSideEffectReady,
    launchMode: effectiveLaunchMode,
    createdAt,
  });
  if (requestedContentMode === 'agent-evidence-bound'
    && !loopPreparation.researchAgendaProducerReceipt) {
    preflightBlockers.push('autonomous_research_machine_generated_agenda_receipt_required');
  }
  if (requestedContentMode === 'agent-evidence-bound'
    && loopPreparation.capabilityScopeManifest.manuscriptMode
      !== 'agent-authored-evidence-bound-ir-v1') {
    preflightBlockers.push('autonomous_research_agent_authored_manuscript_required');
  }
  const runtimePrincipalPreflight = Object.freeze({
    status: preflightBlockers.length
      ? 'autonomous_research_runtime_principals_blocked'
      : 'autonomous_research_runtime_principals_ready',
    authorConfigured: Boolean(author),
    formalReviewerConfigured: Boolean(reviewer),
    distinctPrincipalIds: Boolean(author && reviewer
      && author.effectivePrincipalId !== reviewer.effectivePrincipalId),
    empiricalRuntimeCapabilityInspectionHash:
      empiricalRuntimeCapabilityInspection
        ?.autonomousEmpiricalRuntimeCapabilityInspectionHash || null,
    empiricalPluginStartupReady:
      empiricalPluginStartupInspection.signatureVerified === true,
    empiricalPluginStartupInspection:
      empiricalPluginStartupInspection,
    formalSandboxRuntimeReady: formalSandboxRuntimeInspection.ready === true,
    formalSandboxRuntimeInspection,
    capabilityRequestCoverage: externalCapabilities.capabilityRequestCoverage,
    autonomousResearchProviderConfigurationHash:
      effectiveProviderConfiguration.autonomousResearchProviderConfigurationHash,
    blockers: Object.freeze([...new Set(preflightBlockers)]),
    contentGenerationMode: effectiveResearchAgendaProducer && effectiveHypothesisGenerator
      ? 'agent-evidence-bound'
      : 'deterministic-bounded',
    researchAgendaProducerConfigured: Boolean(effectiveResearchAgendaProducer),
    machineGeneratedAgendaReceiptVerified:
      Boolean(loopPreparation.researchAgendaProducerReceipt),
    manuscriptProductionMode: loopPreparation.capabilityScopeManifest.manuscriptMode,
    requireAgentAuthoredProse: loopPreparation.capabilityScopeManifest.manuscriptMode
      === 'agent-authored-evidence-bound-ir-v1',
    researchContentProducerConfigured: Boolean(effectiveHypothesisGenerator),
    venueProfileRegistryConfigured: Boolean(effectiveVenueProfileRegistry),
    submissionMetadataProfileConfigured: Boolean(effectiveSubmissionMetadataProfile),
    priorArtRetrieverConfigured: Boolean(effectivePriorArtRetriever),
    externalCapabilityTrustReady: externalCapabilityTrustInspection.ready === true,
    externalCapabilityTrustInspection,
    externalCapabilityTrustInspectionHash:
      externalCapabilityTrustInspection
        .autonomousResearchExternalCapabilityTrustInspectionHash,
    externalResearchReplayConfigured: Boolean(effectiveExternalResearchReplay),
    autonomousSubmissionPortalConfigured: Boolean(effectiveAutonomousSubmissionPortal),
    autonomousSubmissionPortalConfigurationHash:
      effectiveAutonomousSubmissionPortal?.configurationHash || null,
    autonomousSubmissionDurableOutboxRequired: Boolean(effectiveAutonomousSubmissionPortal),
    autonomousSubmissionIdempotencyLookupSupported:
      effectiveAutonomousSubmissionPortal?.idempotencyLookupSupported === true,
    venueComplianceRuntimeReady: venueComplianceRuntimeInspection?.ready === true,
    venueComplianceRuntimeInspection,
    reviewerPrincipalPoolConfigured: Boolean(reviewerPrincipalPoolInspection),
    researchPrincipalPoolHash:
      reviewerPrincipalPoolInspection?.pool.researchPrincipalPoolHash || null,
    reviewerPrincipalCount:
      reviewerPrincipalPoolInspection?.pool.reviewerPrincipalCount || 1,
    reviewerTrustDomainCount:
      reviewerPrincipalPoolInspection?.pool.reviewerTrustDomainCount || 1,
  });
  const unattendedCampaignLaunchReady = evaluateUnattendedCampaignLaunchReadiness({
    loopPreparation,
    runtimePrincipalPreflight,
    providerConfigurationHash:
      effectiveProviderConfiguration.autonomousResearchProviderConfigurationHash,
    releaseAttestorInspection,
  });
  const externalQualificationServiceInspection =
    evaluateExternalQualificationServiceReadiness({
      configurationInspection: externalQualificationConfigurationInspection,
      releaseAttestorInspection,
      injectedClient: externalQualificationClient,
      injectedVerifier: externalQualificationVerifier,
    });
  const payload = {
    version: 1,
    kind: 'AutonomousResearchReadinessCompositionReport',
    status: loopPreparation.status,
    runtimePrincipalPreflight,
    releaseAttestorInspection,
    externalQualificationServiceInspection,
    launchModeGate,
    providerPricingInspection,
    loopPreparation,
    autonomousExecutionLaunchReady: loopPreparation.autonomousExecutionLaunchReady,
    unattendedCampaignLaunchReady,
    externalQualificationServiceReady: externalQualificationServiceInspection.ready,
    autonomousPolicyReady: loopPreparation.autonomousPolicyReady,
    qualificationRequestEligible: loopPreparation.qualificationRequestEligible,
    campaignFullyQualified: false,
    fullAutomaticResearchWritingReady: false,
    externalQualificationAuthorityStillRequired:
      !loopPreparation.fullAutomaticResearchWritingReady,
    safety: loopPreparation.safety,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchReadinessCompositionReportHash:
      hashRecord('AutonomousResearchReadinessCompositionReport', payload),
  });
}
export {
  buildAutonomousResearchProductionEnqueueReadiness,
} from './autonomous-research-enqueue-admission.mjs';

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { HEPTA_WORKSPACE_ROOT } from '../../paper-adapters/runtime/workspace-layout.mjs';
import {
  automationReadinessExitCode,
  evaluateAutomationReadiness,
  evaluateAutomationReadinessLevels,
} from '../../paper-application/automation/automation-readiness-policy.mjs';
import {
  AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES,
  AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  inspectAutomationStoreOperationalIntegrity,
  inspectFullResearchQualification,
} from './automation-status-inspection.mjs';
import { inspectScopedPaperStoreSchema } from '../bootstrap/context-foundation-composition.mjs';
import {
  createResearchExecutionReleaseAttestor,
  inspectResearchExecutionReleaseAttestorConfiguration,
} from '../bootstrap/operator-automation-composition.mjs';
import { createReadOnlyPaperStore } from '../bootstrap/operator-persistence-composition.mjs';
import { bootstrapSubmissionHandoffContext } from '../bootstrap/submission-handoff-context-bootstrap.mjs';
import {
  createFullResearchQualificationReceiptPointerRepository,
  fullResearchQualificationReceiptPointerPath,
} from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import {
  inspectGenericDomainCapabilityEvidence,
} from '../../paper-adapters/automation/generic-domain-capability-evidence-repository.mjs';
import {
  buildDynamicFormalExecutionAuthority,
} from '../../paper-adapters/research-verify/dynamic-formal-project-closure-readiness.mjs';
import {
  composeRuntimeImageReproducibilityStatus,
} from './runtime-image-reproducibility-composition.mjs';
import {
  REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
  RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE,
} from '../../paper-domain/automation/runtime-image-reproducibility-receipt-contract.mjs';
import {
  evaluateFullyAutonomousResearchSystemReadiness,
  inspectAutonomousResearchMachineIntakeStatus,
  inspectAutonomousResearchSupervisorInstanceStatus,
} from './automation-machine-intake-readiness.mjs';
import {
  inspectAutonomousResearchResidentPrerequisites,
} from './autonomous-research-resident-prerequisite-inspection.mjs';
import {
  inspectAutonomousResearchStateSafety,
} from './autonomous-research-state-safety-inspection.mjs';
import {
  buildAutomationRuntimeProbes,
  createAutomationReadinessSideEffectLedger,
  inspectAutomationDynamicFormalProjectClosure,
  inspectAutomationFormalSandboxRuntime,
  inspectAutomationAgentProviders,
} from './automation-readiness-runtime-probes.mjs';
import {
  composeAutomationReadinessCapabilityScope,
} from './automation-readiness-capability-scope-composition.mjs';
import {
  inspectAutonomousSubmissionDispatcherReadiness,
} from './autonomous-submission-dispatcher-readiness-composition.mjs';

export {
  evaluateFullyAutonomousResearchSystemReadiness,
  inspectAutonomousResearchMachineIntakeStatus,
  inspectAutonomousResearchSupervisorInstanceStatus,
} from './automation-machine-intake-readiness.mjs';

function readCanonicalQualificationReceipt({ runtimeRoot, environment }) {
  const canonicalPath = fullResearchQualificationReceiptPointerPath({ runtimeRoot });
  const configuredPath = environment.HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT
    ? path.resolve(String(environment.HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT)) : null;
  if (configuredPath && configuredPath !== canonicalPath) {
    return Object.freeze({
      receipt: null,
      blockers: Object.freeze(['full_research_qualification_pointer_path_drift']),
      status: Object.freeze({
        configuredPath, canonicalPath, canonical: false, authorityBacked: false,
      }),
    });
  }
  const repository = createFullResearchQualificationReceiptPointerRepository({ runtimeRoot });
  try {
    const pointer = repository.read();
    return Object.freeze({
      receipt: pointer?.receipt || null,
      blockers: Object.freeze([]),
      status: Object.freeze({
        configuredPath, canonicalPath, canonical: true, authorityBacked: Boolean(pointer),
      }),
    });
  } catch {
    return Object.freeze({
      receipt: null,
      blockers: Object.freeze([
        'full_research_qualification_pointer_authority_or_mirror_drift',
      ]),
      status: Object.freeze({
        configuredPath, canonicalPath, canonical: true, authorityBacked: false,
      }),
    });
  }
}

function automationConfiguration(environment, runtimeRoot) {
  const publishedQualificationPointer = fullResearchQualificationReceiptPointerPath({ runtimeRoot });
  return Object.freeze({
    formalReviewAgentId: environment.HEPTA_OPENCLAW_FORMAL_REVIEW_AGENT || null,
    formalReviewProvider: environment.HEPTA_FORMAL_REVIEW_PROVIDER || 'codex',
    researchAuthorCodexHome: environment.HEPTA_RESEARCH_AUTHOR_CODEX_HOME || environment.CODEX_HOME || null,
    researchAuthorModel: environment.HEPTA_RESEARCH_AUTHOR_MODEL || null,
    researchAuthorCodexBinary: environment.HEPTA_RESEARCH_AUTHOR_CODEX_BINARY || 'codex',
    formalReviewCodexHome: environment.HEPTA_FORMAL_REVIEW_CODEX_HOME || null,
    formalReviewModel: environment.HEPTA_FORMAL_REVIEW_MODEL || null,
    formalReviewCodexBinary: environment.HEPTA_FORMAL_REVIEW_CODEX_BINARY || 'codex',
    qualificationReceiptPath: environment.HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT
      || (fs.existsSync(publishedQualificationPointer) ? publishedQualificationPointer : null),
  });
}

export function deriveFullyAutonomousResearchSystemStatus({
  readinessLevels,
  coreStatus,
} = {}) {
  const readyStatus = 'generic_domain_autonomous_research_system_ready';
  if (readinessLevels?.productionReady === true && coreStatus === readyStatus) {
    return readyStatus;
  }
  if (readinessLevels?.status
    && readinessLevels.status !== 'automation_plane_production_ready') {
    return readinessLevels.status;
  }
  return 'automation_plane_production_blocked';
}

export function composeAutomationReleaseAttestorTrust({
  runtimeRoot,
  environment = process.env,
  now = new Date(),
  activeVerification = false,
  spawnSyncImpl = spawnSync,
} = {}) {
  return Object.freeze({
    inspection: inspectResearchExecutionReleaseAttestorConfiguration({
      runtimeRoot,
      now,
      environment,
      activeVerification,
      spawnSyncImpl,
    }),
    attestor: createResearchExecutionReleaseAttestor({
      runtimeRoot,
      environment,
      clock: { now: () => now },
      spawnSyncImpl,
    }),
  });
}

export function queryAutomationReadiness({
  root,
  runtimeRoot,
  environment = process.env,
  liveProviderCanaryRequested = false,
  requireFullResearch = false,
  requireFullyAutonomous = false,
  activeReleaseAttestorVerification = false,
  spawnSyncImpl = spawnSync,
  now = new Date(),
  codeProvenance = currentCodeProvenance(),
} = {}) {
  if (!root || !runtimeRoot) throw new Error('automation_readiness_query_roots_required');
  const sideEffectLedger = createAutomationReadinessSideEffectLedger({
    environment,
    spawnSyncImpl,
  });
  let observedReleaseAttestorInspection = null;
  try {
  sideEffectLedger.assertEndpointPolicy();
  const runtimeSpawnSync = sideEffectLedger.spawnSyncFor('runtime-sandbox');
  const providerSpawnSync = sideEffectLedger.spawnSyncFor('provider-readiness');
  const releaseAttestorSpawnSync = sideEffectLedger.spawnSyncFor('release-attestor');
  const configuration = automationConfiguration(environment, runtimeRoot);
  const qualificationReceiptRead = readCanonicalQualificationReceipt({ runtimeRoot, environment });
  const genericDomainCapabilityEvidenceInspection =
    inspectGenericDomainCapabilityEvidence({ runtimeRoot, environment });
  const machineIntake = inspectAutonomousResearchMachineIntakeStatus({
    runtimeRoot,
    environment,
  });
  const residentSupervisor = inspectAutonomousResearchSupervisorInstanceStatus({
    runtimeRoot,
    now,
  });
  const residentPrerequisites = inspectAutonomousResearchResidentPrerequisites({
    runtimeRoot,
    environment,
    now,
  });
  const autonomousStateSafety = inspectAutonomousResearchStateSafety({
    workspaceRoot: HEPTA_WORKSPACE_ROOT,
    runtimeRoot,
    now,
    environment,
  });
  const store = createReadOnlyPaperStore({ root, runtimeRoot });
  const runtimes = buildAutomationRuntimeProbes({
    configuration,
    spawnSyncImpl: runtimeSpawnSync,
    environment,
  });
  const formalSandboxRuntime = inspectAutomationFormalSandboxRuntime({
    environment,
    spawnSyncImpl: runtimeSpawnSync,
  });
  const dynamicFormalProjectClosure = inspectAutomationDynamicFormalProjectClosure({
    environment,
    spawnSyncImpl: runtimeSpawnSync,
  });
  let currentDynamicFormalExecutionAuthority = null;
  try {
    currentDynamicFormalExecutionAuthority = buildDynamicFormalExecutionAuthority(
      dynamicFormalProjectClosure,
    );
  } catch { currentDynamicFormalExecutionAuthority = null; }
  const providerInspections = inspectAutomationAgentProviders({
    runtimes,
    configuration,
    liveProviderCanaryRequested,
    spawnSyncImpl: providerSpawnSync,
    environment,
    canaryClock: { now: () => now },
    legacyAgentFallbackProbesRequested: !(requireFullResearch || requireFullyAutonomous),
  });
  const campaignQuery = store.query('SELECT status,count(*) AS count FROM paper_campaigns GROUP BY status ORDER BY status;');
  const nodeQuery = store.query('SELECT status,count(*) AS count FROM campaign_nodes GROUP BY status ORDER BY status;');
  const campaignRows = campaignQuery.ok ? campaignQuery.rows : [];
  const nodeRows = nodeQuery.ok ? nodeQuery.rows : [];
  const campaignStoreSchemaInspection = inspectScopedPaperStoreSchema({
    store,
    allowUnavailable: true,
    rootKind: 'automation-status',
  });
  const campaignStoreSchema = campaignStoreSchemaInspection.receipt;
  const campaignStoreSchemaBlockers = campaignStoreSchemaInspection.blockers;
  const releaseAttestorTrust = composeAutomationReleaseAttestorTrust({
    runtimeRoot,
    environment,
    now,
    activeVerification: activeReleaseAttestorVerification,
    spawnSyncImpl: releaseAttestorSpawnSync,
  });
  const researchExecutionReleaseAttestor = releaseAttestorTrust.inspection;
  observedReleaseAttestorInspection = researchExecutionReleaseAttestor;
  const runtimeImageReproducibilityReport = composeRuntimeImageReproducibilityStatus({
    runtimeRoot,
    repositoryRoot: HEPTA_WORKSPACE_ROOT,
    configPath: environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG || null,
    receiptPath: environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT || null,
    environment,
    now,
    codeProvenance,
  });
  const runtimeImageReproducibility = runtimeImageReproducibilityReport.inspection
    || Object.freeze({
      version: 2,
      kind: 'RuntimeImageReproducibilityReceiptInspection',
      status: 'runtime_image_reproducibility_blocked',
      ready: false,
      receiptAccepted: false,
      receiptHash: null,
      requiredProfiles: Object.freeze([]),
      empiricalFamilyPluginPackageHash:
        RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.empiricalFamilyPluginPackageHash,
      empiricalFamilyPluginRegistryHash:
        RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.empiricalFamilyPluginRegistryHash,
      empiricalFamilyPluginStartupInspectionHash:
        RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
          .empiricalFamilyPluginStartupInspectionHash,
      activeProductionProfileHashes:
        RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.activeProductionProfileHashes,
      runtimeImageReproducibilityActivePluginScopeHash:
        RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
          .runtimeImageReproducibilityActivePluginScopeHash,
      definitionManifestHashes: null,
      inputClosureHashes: null,
      registeredImageDigests: null,
      blockers: runtimeImageReproducibilityReport.blockers,
    });
  const operationalIntegrity = inspectAutomationStoreOperationalIntegrity({ store, now });
  let qualificationReleaseContext = null;
  let fullResearchQualification;
  try {
    const qualificationReceipt = qualificationReceiptRead.receipt;
    if (qualificationReceipt) qualificationReleaseContext = bootstrapSubmissionHandoffContext({ root, runtimeRoot });
    const releaseAttestor = releaseAttestorTrust.attestor;
    const observedRuntimeImageDigests = Object.freeze(Object.fromEntries(
      REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES.map((profile) => [
      profile,
      runtimes.images[profile]?.exactDigestVerified === true ? runtimes.images[profile].observedDigest : null,
      ]),
    ));
    fullResearchQualification = inspectFullResearchQualification({
      qualificationReceipt,
      inputBlockers: qualificationReceiptRead.blockers,
      now,
      codeProvenance,
      researchAuthorCapabilityReceipt: providerInspections.researchAuthorPreflight?.capabilityReceipt || null,
      formalReviewerCapabilityReceipt: providerInspections.formalReviewPreflight?.capabilityReceipt || null,
      campaignStoreSchemaReceipt: campaignStoreSchema,
      runtimeImageDigests: observedRuntimeImageDigests,
      runtimeImageReproducibilityInspection: runtimeImageReproducibility,
      researchAuthorProviderCanaryReceipt:
        providerInspections.researchAuthorModelCanary
          || qualificationReceipt?.researchAuthorProviderCanaryReceipt || null,
      formalReviewerProviderCanaryReceipt:
        providerInspections.formalReviewModelCanary
          || qualificationReceipt?.formalReviewerProviderCanaryReceipt || null,
      releaseAttestorInspection: researchExecutionReleaseAttestor,
      requireGlobalGoldenAuthority: true,
      resolveCampaignReleaseAuthority: qualificationReleaseContext
        ? ({ campaignId }) => qualificationReleaseContext.services.campaignReleaseQuery.getCurrentRelease({ campaignId })
        : null,
      verifyReleaseAttestation: (input) => releaseAttestor.verifyAttestation(input),
      verifyQualificationSignature: (input) => releaseAttestor.verifyDetachedSignature(input),
    });
  } finally {
    qualificationReleaseContext?.services?.persistenceSession?.close?.();
  }
  const readiness = evaluateAutomationReadiness({
    runtimes,
    campaignQueryReady: campaignQuery.ok,
    nodeQueryReady: nodeQuery.ok,
    campaignStoreSchema,
    campaignStoreSchemaBlockers,
    operationalIntegrity,
    researchExecutionReleaseAttestor,
    runtimeImageReproducibility,
    fullResearchQualification,
    liveProviderCanaryRequired: liveProviderCanaryRequested,
  });
  const readinessSideEffectInspection = sideEffectLedger.inspection({
    releaseAttestorInspection: researchExecutionReleaseAttestor,
  });
  const {
    autonomousResearchAgendaAuthorityInspection,
    experimentIrExecutionAuthorityInspection,
    autonomousResearchVenueRequirementAuthorityInspection,
    autonomousResearchAssuranceAuthorityInspection,
    capabilityScopeInspection,
  } = composeAutomationReadinessCapabilityScope({
    store,
    root,
    runtimeRoot,
    now,
    environment,
    providerInspections,
    providerSpawnSync,
    currentDynamicFormalExecutionAuthority,
  });
  const capabilityScopeManifest = capabilityScopeInspection.manifest;
  const publishedDynamicFormalExecutionAuthority =
    genericDomainCapabilityEvidenceInspection.ready === true
      ? genericDomainCapabilityEvidenceInspection.evidence
        ?.dynamicFormalExecutionAuthority || null : null;
  const formalDomainEvidenceCurrent = Boolean(
    currentDynamicFormalExecutionAuthority
    && JSON.stringify(currentDynamicFormalExecutionAuthority)
      === JSON.stringify(publishedDynamicFormalExecutionAuthority),
  );
  const genericDomainCapabilityEvidence = Object.freeze({
    dynamicFormalExecutionAuthority:
      formalDomainEvidenceCurrent
        ? publishedDynamicFormalExecutionAuthority : null,
    externalResearchReplayReceipt:
      autonomousResearchAssuranceAuthorityInspection.ready === true
        ? autonomousResearchAssuranceAuthorityInspection
          .externalResearchReplayReceipt : null,
    externalResearchReplayRequest:
      autonomousResearchAssuranceAuthorityInspection.ready === true
        ? autonomousResearchAssuranceAuthorityInspection
          .externalResearchReplayRequest : null,
    experimentHarnessExecutionReceipt:
      experimentIrExecutionAuthorityInspection.ready === true
        ? experimentIrExecutionAuthorityInspection
          .experimentHarnessExecutionReceipt : null,
    experimentIrExecutionAuthorityReceipt:
      experimentIrExecutionAuthorityInspection.ready === true
        ? experimentIrExecutionAuthorityInspection.receipt : null,
    experimentReplayReceipt:
      experimentIrExecutionAuthorityInspection.ready === true
        ? experimentIrExecutionAuthorityInspection.experimentReplayReceipt : null,
    formalDomainCoverageReceipt:
      formalDomainEvidenceCurrent
        ? genericDomainCapabilityEvidenceInspection.evidence
          ?.formalDomainCoverageReceipt || null : null,
    formalDomainQualificationExternalEvidence:
      formalDomainEvidenceCurrent
        ? genericDomainCapabilityEvidenceInspection.evidence
          ?.formalDomainQualificationExternalEvidence || null : null,
    independentFormalReviewReceipt:
      autonomousResearchAssuranceAuthorityInspection.ready === true
        ? autonomousResearchAssuranceAuthorityInspection
          .independentFormalReviewReceipt : null,
    priorArtClaimAlignmentReceipt:
      autonomousResearchAgendaAuthorityInspection.priorArtClaimAlignmentReady === true
        ? autonomousResearchAgendaAuthorityInspection
          .priorArtClaimAlignmentReceipt : null,
    priorArtEvidenceReceipt:
      autonomousResearchAgendaAuthorityInspection.priorArtClaimAlignmentReady === true
        ? autonomousResearchAgendaAuthorityInspection.priorArtEvidenceReceipt : null,
    researchAgendaIr:
      autonomousResearchAgendaAuthorityInspection.ready === true
        ? autonomousResearchAgendaAuthorityInspection.researchAgendaIr : null,
    venueProfile:
      autonomousResearchVenueRequirementAuthorityInspection.ready === true
        ? autonomousResearchVenueRequirementAuthorityInspection.venueProfile : null,
    venueRequirementIr:
      autonomousResearchVenueRequirementAuthorityInspection.ready === true
        ? autonomousResearchVenueRequirementAuthorityInspection.venueRequirementIr
        : null,
  });
  const fullyAutonomousReadiness = evaluateFullyAutonomousResearchSystemReadiness({
    fullAutomaticResearchWritingReady: readiness.fullAutomaticResearchWritingReady,
    machineIntake,
    residentSupervisor,
    residentPrerequisites,
    autonomousStateSafety,
    capabilityScopeManifest,
    capabilityScopeInspection,
    capabilityRequest: Object.freeze({
      requestedProtocolFamily:
        autonomousResearchAgendaAuthorityInspection.researchAgendaProducerReceipt
          ?.selectedProtocolFamily || null,
      requireMachineGeneratedAgenda: true,
      requireDynamicFormalClaims: true,
      requireStructuredPriorArt: true,
      requiredReviewerTrustDomains: 3,
      requireExternalReplay: true,
      requireVenueProfile: true,
      requireKernelCheckedFormalProof: true,
      requireIndependentFormalReview: true,
      requireFreshFormalReplay: true,
      requireAdvancedNumericalAnalysis: true,
    }),
    researchAgendaProducerReceipt:
      autonomousResearchAgendaAuthorityInspection.researchAgendaProducerReceipt,
    genericDomainCapabilityEvidence:
      genericDomainCapabilityEvidence,
    genericDomainCapabilityVerificationContext: Object.freeze({
      autonomousResearchAssuranceAuthorityInspection,
      externalResearchReplayReceiptVerifier:
        capabilityScopeInspection.externalResearchReplayReceiptVerifier,
      reviewerReceiptVerificationAuthority:
        capabilityScopeInspection.reviewerReceiptVerificationAuthority,
    }),
  });
  const autonomousSubmissionDispatcherReadiness =
    inspectAutonomousSubmissionDispatcherReadiness({
      runtimeRoot,
      environment,
      now,
    });
  const readinessLevels = evaluateAutomationReadinessLevels({
    runtimeReady: readiness.automationOperationalReady,
    runtimeStatus: readiness.status,
    boundedProfileReady: fullyAutonomousReadiness.boundedProfileReady,
    configuredScopeReady: fullyAutonomousReadiness.configuredScopeReady,
    genericCapabilityReady: fullyAutonomousReadiness.genericDomainCapabilityReady,
    formalSandboxRuntimeReady: formalSandboxRuntime.ready,
    dynamicFormalProjectClosureReady: dynamicFormalProjectClosure.ready,
    autonomousSystemReady: fullyAutonomousReadiness.ready,
    submissionDispatcherReady: autonomousSubmissionDispatcherReadiness.ready,
  });
  const fullyAutonomousResearchSystemReady = readinessLevels.productionReady;
  const fullyAutonomousResearchSystemBlockers = Object.freeze([
    ...new Set([
      ...(readiness.blockers || []),
      ...(fullyAutonomousReadiness.blockers || []),
      ...(autonomousResearchAgendaAuthorityInspection.blockers || []),
      ...(experimentIrExecutionAuthorityInspection.blockers || []),
      ...(autonomousResearchVenueRequirementAuthorityInspection.blockers || []),
      ...(autonomousResearchAssuranceAuthorityInspection.blockers || []),
      ...(formalSandboxRuntime.ready === true
        ? [] : formalSandboxRuntime.blockers || ['formal_sandbox_runtime_not_ready']),
      ...(dynamicFormalProjectClosure.ready === true
        ? [] : dynamicFormalProjectClosure.blockers
          || ['dynamic_formal_project_closure_not_ready']),
      ...(autonomousSubmissionDispatcherReadiness.blockers || []),
    ]),
  ]);
  const empiricalLanguageEntries = Object.freeze([
    ...(AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES.includes('python')
      ? [['python', { usable: runtimes.python.usable || runtimes.images.python.usable }]] : []),
    ['node', runtimes.node],
    ...(AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES.includes('r')
      ? [['r', { usable: runtimes.r.usable || runtimes.images.r.usable }]] : []),
    ['julia', runtimes.julia],
    ['lean', runtimes.lean],
    ['latex', runtimes.latex],
  ]);
  const report = Object.freeze({
    version: 2,
    kind: 'AutomationPlaneStatus',
    status: readinessLevels.status,
    runtimeStatus: readiness.status,
    runtimeReady: readinessLevels.runtimeReady,
    boundedProfileReady: readinessLevels.boundedProfileReady,
    configuredScopeReady: fullyAutonomousReadiness.configuredScopeReady,
    genericDomainCapabilityReady:
      fullyAutonomousReadiness.genericDomainCapabilityReady,
    genericDomainCapabilityBlockers:
      fullyAutonomousReadiness.genericDomainCapabilityBlockers,
    genericDomainCapabilityEvidenceInspection,
    genericDomainCapabilityEvidenceCandidate: genericDomainCapabilityEvidence,
    genericResearchReady: readinessLevels.genericResearchReady,
    productionReady: readinessLevels.productionReady,
    automationRuntimeReady: readiness.automationRuntimeReady,
    automationOperationalReady: readiness.automationOperationalReady,
    academicEmpiricalReady: readiness.academicEmpiricalReady,
    academicEmpiricalStatus: readiness.academicEmpiricalReady ? 'academic_empirical_runtime_ready' : 'academic_empirical_runtime_blocked',
    academicEmpiricalReadinessReason: readiness.academicEmpiricalReadinessReason,
    academicEmpiricalDatasetProofBackend: runtimes.sandbox.academicEmpiricalDatasetProofBackend || null,
    researchExecutionReleaseAttestor,
    liveReleaseAttestorVerificationRequested:
      activeReleaseAttestorVerification === true,
    researchExecutionReleaseAttestorReady: researchExecutionReleaseAttestor.ready,
    researchExecutionReleaseAttestorProductionReady:
      researchExecutionReleaseAttestor.productionReady === true,
    runtimeImageReproducibility,
    runtimeImageReproducibilityConfiguration:
      runtimeImageReproducibilityReport.configuration,
    runtimeImageReproducibilityReady: runtimeImageReproducibility.ready === true,
    formalSandboxRuntime,
    formalSandboxRuntimeReady: formalSandboxRuntime.ready === true,
    dynamicFormalProjectClosure,
    dynamicFormalProjectClosureReady: dynamicFormalProjectClosure.ready === true,
    autonomousSubmissionHandoffReady:
      autonomousSubmissionDispatcherReadiness.handoffReady === true,
    autonomousSubmissionDispatcherReady:
      autonomousSubmissionDispatcherReadiness.ready === true,
    autonomousSubmissionDispatcherReadiness,
    liveProviderCanaryRequested,
    liveProviderCanaryReady: readiness.liveProviderCanaryReady,
    fullAutomaticResearchWritingRuntimePreflightReady: readiness.fullAutomaticResearchWritingRuntimePreflightReady,
    fullResearchQualification,
    fullResearchQualificationPointer: qualificationReceiptRead.status,
    fullResearchQualificationReceiptConfigured: Boolean(configuration.qualificationReceiptPath),
    fullResearchQualificationReady: readiness.fullResearchQualificationReady,
    boundedGoldenInfrastructureQualificationReady:
      readiness.boundedGoldenInfrastructureQualificationReady,
    productionGenericResearchQualificationReady:
      readiness.productionGenericResearchQualificationReady,
    fullResearchQualificationBlockers: fullResearchQualification.blockers,
    campaignFullyQualified: readiness.campaignFullyQualified,
    fullAutomaticResearchWritingReady: readiness.fullAutomaticResearchWritingReady,
    machineIntakeConfigured: machineIntake.configured,
    coldStartAutonomyReady: machineIntake.coldStartAutonomyReady,
    machineIntake,
    residentSupervisor,
    residentPrerequisites,
    autonomousStateSafety,
    autonomousStateDatabaseInventoryReady:
      autonomousStateSafety.inventoryRoleCoverageComplete,
    autonomousStateLatestValidRestoreDrillReady:
      autonomousStateSafety.latestValidRestoreDrillReady,
    autonomousStateRestoreAuthorityConfigured:
      autonomousStateSafety.restoreAuthorityConfigured,
    autonomousStateRestoreAuthorityConfigurationHash:
      autonomousStateSafety.restoreAuthorityConfigurationHash,
    autonomousStateOnlineAntiRollbackReady:
      autonomousStateSafety.liveExternalAuthorityVerified === true
      && autonomousStateSafety.onlineAuthorityHeadCurrent === true
      && autonomousStateSafety.writerManifestComplete === true,
    fullyAutonomousResearchSystemReady,
    boundedProfileAutonomousResearchSystemReady:
      readinessLevels.boundedProfileReady,
    fullyAutonomousResearchCoreStatus: fullyAutonomousReadiness.status,
    fullyAutonomousResearchSystemStatus:
      deriveFullyAutonomousResearchSystemStatus({
        readinessLevels,
        coreStatus: fullyAutonomousReadiness.status,
      }),
    fullyAutonomousResearchSystemBlockers,
    fullAutomaticResearchWritingStatus: readiness.fullAutomaticResearchWritingStatus,
    fullAutomaticResearchWritingBlockers: readiness.blockers,
    fullAutomaticResearchWritingScope:
      fullyAutonomousReadiness.genericDomainCapabilityReady
        ? 'generic-domain-evidence-bound-zero-runtime-human-intervention-v1'
        : fullyAutonomousReadiness.configuredScopeReady
          ? 'configured-scope-zero-runtime-human-intervention-v1'
          : 'bounded-profile-zero-runtime-human-intervention-v1',
    autonomousResearchCapabilityScopeManifest: capabilityScopeManifest,
    autonomousResearchCapabilityScopeManifestHash:
      capabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash,
    autonomousResearchCapabilityScopeInspection: capabilityScopeInspection,
    autonomousResearchAgendaAuthorityInspection,
    experimentIrExecutionAuthorityInspection,
    autonomousResearchVenueRequirementAuthorityInspection,
    autonomousResearchAssuranceAuthorityInspection,
    autonomousResearchCapabilityCoverage: fullyAutonomousReadiness.capabilityCoverage,
    autonomousEmpiricalPluginStartupReady:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.signatureVerified === true,
    autonomousEmpiricalPluginStartupInspection:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
    autonomousAdvancedNumericalPluginCoverageReady:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.signatureVerified === true
      && AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
        .allProductionProfilesAdvancedNumericalAnalysisCovered === true,
    autonomousAdvancedNumericalPluginCoverageFamilies:
      AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
        .advancedNumericalAnalysisFamilies,
    supportedAcademicAnalysisFamilies: AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES,
    universalResearchValidityClaimed: false,
    naturalLanguageToLeanEquivalenceMachineProven: false,
    formalSemanticReviewAssurance: 'separated-llm-attestation-plus-lean-kernel-verification-v1',
    runtimeImageBuildReproducibility: Object.freeze({
      runtimeContentDigestsVerified: Object.values(runtimes.images).every((candidate) => candidate.exactDigestVerified),
      bitwiseRebuildVerified: Object.values(runtimes.images).every((candidate) => candidate.buildReproducibility?.bitwiseRebuildVerified === true),
      bitwiseRebuildClaimed: false,
      blockers: Object.freeze([...new Set(Object.values(runtimes.images)
        .flatMap((candidate) => candidate.buildReproducibility?.blockers || []))].sort()),
    }),
    operationalIntegrity,
    readinessSideEffectInspection,
    runtimes,
    empiricalLanguagesReady: empiricalLanguageEntries
      .filter(([, value]) => value.usable).map(([name]) => name),
    empiricalLanguagesUnavailable: empiricalLanguageEntries
      .filter(([, value]) => !value.usable).map(([name]) => name),
    campaignStoreSchema,
    campaignStoreSchemaBlockers,
    campaignStoreReady: readiness.campaignStoreReady,
    campaigns: campaignRows,
    nodes: nodeRows,
    submissionPlaneRequired: false,
    authorityKeysRequired: false,
    researchExecutionReleaseAttestorKeyRequiredForAcademicPackaging: true,
    ownerSignaturesRequired: false,
    coldVolumeRequiredForUnrelatedPapers: false,
    externalActionPerformed: readinessSideEffectInspection.externalActionPerformed,
    externalActionScope: readinessSideEffectInspection.externalActionScope,
  });
  return Object.freeze({
    report,
    readiness,
    exitCode: automationReadinessExitCode(readiness, {
      requireFullResearch,
      requireFullyAutonomous,
      fullyAutonomousResearchSystemReady,
    }),
  });
  } catch (error) {
    throw sideEffectLedger.attachFailureInspection(error, {
      releaseAttestorInspection: observedReleaseAttestorInspection,
    });
  }
}

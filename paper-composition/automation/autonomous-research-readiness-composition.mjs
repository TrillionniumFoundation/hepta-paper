import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { preflightCodexResearchAuthor } from '../../paper-adapters/automation/codex-research-author-preflight.mjs';
import { preflightCodexFormalReviewer } from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
import { prepareAutonomousResearchLoop } from '../../paper-application/automation/autonomous-research-readiness.mjs';
import { preflightAutonomousEmpiricalRuntimes } from '../../paper-adapters/automation/autonomous-empirical-runtime-preflight.mjs';
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
  createAutomationReadinessSideEffectLedger,
} from './automation-readiness-runtime-probes.mjs';

export {
  createAutonomousResearchAdmissionPreflightSandbox,
  createAutonomousResearchMachineIntakeActionFence,
  verifyAutonomousResearchSupervisorReadinessAuthorization,
};

export function inspectAutonomousResearchProductionAdmissionReadiness({
  runtimeRoot,
  environment,
  releaseAttestorInspection,
  now,
} = {}) {
  return buildAutonomousResearchProductionAdmissionReadiness({
    residentPrerequisites: inspectAutonomousResearchResidentPrerequisites({
      runtimeRoot, environment, now,
    }),
    releaseAttestorInspection,
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

export async function composeAutonomousResearchReadiness({
  paperId,
  objective,
  protocolFamily,
  hypothesisGenerator = null,
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
  environment = process.env,
  providerConfiguration = null,
  expectedProviderConfigurationHash = null,
  releaseAttestorInspection = null,
  externalQualificationConfigurationInspection = null,
  externalQualificationClient = null,
  externalQualificationVerifier = null,
  launchModeGate = null,
  providerPricingInspection = null,
  preflightAuthor = preflightCodexResearchAuthor,
  preflightReviewer = preflightCodexFormalReviewer,
  preflightEmpiricalRuntime = preflightAutonomousEmpiricalRuntimes,
  spawnSyncImpl = undefined,
} = {}) {
  const effectiveProviderConfiguration = requireAutonomousResearchProviderConfiguration(
    providerConfiguration || resolveAutonomousResearchProviderConfiguration({ environment }),
    { expectedHash: expectedProviderConfigurationHash },
  );
  const authorConfiguration = effectiveProviderConfiguration.researchAuthor;
  const reviewerConfiguration = effectiveProviderConfiguration.formalReviewer;
  const preflightBlockers = [];
  let author = null;
  let reviewer = null;
  let empiricalRuntimeCapabilityInspection = null;
  try {
    empiricalRuntimeCapabilityInspection = preflightEmpiricalRuntime({
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    });
  } catch (error) {
    preflightBlockers.push(`autonomous_empirical_runtime_preflight_failed:${errorCode(error)}`);
  }
  try {
    author = preflightAuthor({
      ...authorConfiguration,
      environment,
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    });
  } catch (error) {
    preflightBlockers.push(`autonomous_research_author_preflight_failed:${errorCode(error)}`);
  }
  if (author) {
    try {
      reviewer = preflightReviewer({
        ...reviewerConfiguration,
        authorProvider: authorConfiguration.provider,
        authorCodexHome: author.codexHome || authorConfiguration.codexHome,
        environment,
        ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
      });
    } catch (error) {
      preflightBlockers.push(`autonomous_research_reviewer_preflight_failed:${errorCode(error)}`);
    }
  } else {
    preflightBlockers.push('autonomous_research_reviewer_preflight_requires_author');
  }
  const loopPreparation = await prepareAutonomousResearchLoop({
    paperId,
    objective,
    protocolFamily,
    hypothesisGenerator,
    authorPrincipal: author ? Object.freeze({
      principalId: author.effectivePrincipalId,
      capabilityReceipt: author.capabilityReceipt,
    }) : null,
    formalReviewerPrincipal: reviewer ? Object.freeze({
      principalId: reviewer.effectivePrincipalId,
      capabilityReceipt: reviewer.capabilityReceipt,
    }) : null,
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
    machineIntake,
    machineIntakeAdmission,
    launchMode: launchModeGate?.launchMode,
    createdAt,
  });
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
    autonomousResearchProviderConfigurationHash:
      effectiveProviderConfiguration.autonomousResearchProviderConfigurationHash,
    blockers: Object.freeze([...new Set(preflightBlockers)]),
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

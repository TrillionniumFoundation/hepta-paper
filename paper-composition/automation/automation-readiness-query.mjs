import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { HEPTA_WORKSPACE_ROOT } from '../../paper-adapters/runtime/workspace-layout.mjs';
import { automationReadinessExitCode, evaluateAutomationReadiness } from '../../paper-application/automation/automation-readiness-policy.mjs';
import { ANALYSIS_PROTOCOL_FAMILY_PROFILES } from '../../paper-domain/automation/analysis-protocol-contract.mjs';
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
  composeRuntimeImageReproducibilityStatus,
} from './runtime-image-reproducibility-composition.mjs';
import {
  evaluateFullyAutonomousResearchSystemReadiness,
  inspectAutonomousResearchMachineIntakeStatus,
  inspectAutonomousResearchSupervisorInstanceStatus,
} from './automation-machine-intake-readiness.mjs';
import {
  inspectAutonomousResearchResidentPrerequisites,
} from './autonomous-research-resident-prerequisite-inspection.mjs';
import {
  buildAutomationRuntimeProbes,
  createAutomationReadinessSideEffectLedger,
  inspectAutomationAgentProviders,
} from './automation-readiness-runtime-probes.mjs';

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

export function composeAutomationReleaseAttestorTrust({
  runtimeRoot,
  environment = process.env,
  now = new Date(),
  activeVerification = true,
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
  activeReleaseAttestorVerification = true,
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
  const store = createReadOnlyPaperStore({ root, runtimeRoot });
  const runtimes = buildAutomationRuntimeProbes({
    configuration,
    spawnSyncImpl: runtimeSpawnSync,
    environment,
  });
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
      version: 1,
      kind: 'RuntimeImageReproducibilityReceiptInspection',
      status: 'runtime_image_reproducibility_blocked',
      ready: false,
      receiptAccepted: false,
      receiptHash: null,
      requiredProfiles: Object.freeze([]),
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
    const observedRuntimeImageDigests = Object.freeze(Object.fromEntries(['python', 'r'].map((profile) => [
      profile,
      runtimes.images[profile]?.exactDigestVerified === true ? runtimes.images[profile].observedDigest : null,
    ])));
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
  const fullyAutonomousReadiness = evaluateFullyAutonomousResearchSystemReadiness({
    fullAutomaticResearchWritingReady: readiness.fullAutomaticResearchWritingReady,
    machineIntake,
    residentSupervisor,
    residentPrerequisites,
  });
  const fullyAutonomousResearchSystemReady = fullyAutonomousReadiness.ready;
  const fullyAutonomousResearchSystemBlockers = Object.freeze([
    ...new Set([
      ...(readiness.blockers || []),
      ...(fullyAutonomousReadiness.blockers || []),
    ]),
  ]);
  const report = Object.freeze({
    version: 1,
    kind: 'AutomationPlaneStatus',
    status: readiness.status,
    automationRuntimeReady: readiness.automationRuntimeReady,
    automationOperationalReady: readiness.automationOperationalReady,
    academicEmpiricalReady: readiness.academicEmpiricalReady,
    academicEmpiricalStatus: readiness.academicEmpiricalReady ? 'academic_empirical_runtime_ready' : 'academic_empirical_runtime_blocked',
    academicEmpiricalReadinessReason: readiness.academicEmpiricalReadinessReason,
    academicEmpiricalDatasetProofBackend: runtimes.sandbox.academicEmpiricalDatasetProofBackend || null,
    researchExecutionReleaseAttestor,
    researchExecutionReleaseAttestorReady: researchExecutionReleaseAttestor.ready,
    researchExecutionReleaseAttestorProductionReady:
      researchExecutionReleaseAttestor.productionReady === true,
    runtimeImageReproducibility,
    runtimeImageReproducibilityConfiguration:
      runtimeImageReproducibilityReport.configuration,
    runtimeImageReproducibilityReady: runtimeImageReproducibility.ready === true,
    liveProviderCanaryRequested,
    liveProviderCanaryReady: readiness.liveProviderCanaryReady,
    fullAutomaticResearchWritingRuntimePreflightReady: readiness.fullAutomaticResearchWritingRuntimePreflightReady,
    fullResearchQualification,
    fullResearchQualificationPointer: qualificationReceiptRead.status,
    fullResearchQualificationReceiptConfigured: Boolean(configuration.qualificationReceiptPath),
    fullResearchQualificationReady: readiness.fullResearchQualificationReady,
    fullResearchQualificationBlockers: fullResearchQualification.blockers,
    campaignFullyQualified: readiness.campaignFullyQualified,
    fullAutomaticResearchWritingReady: readiness.fullAutomaticResearchWritingReady,
    machineIntakeConfigured: machineIntake.configured,
    coldStartAutonomyReady: machineIntake.coldStartAutonomyReady,
    machineIntake,
    residentSupervisor,
    residentPrerequisites,
    fullyAutonomousResearchSystemReady,
    fullyAutonomousResearchSystemStatus: fullyAutonomousReadiness.status,
    fullyAutonomousResearchSystemBlockers,
    fullAutomaticResearchWritingStatus: readiness.fullAutomaticResearchWritingStatus,
    fullAutomaticResearchWritingBlockers: readiness.blockers,
    fullAutomaticResearchWritingScope: 'registered-formal-and-empirical-profiles-only-v1',
    supportedAcademicAnalysisFamilies: Object.freeze(Object.keys(ANALYSIS_PROTOCOL_FAMILY_PROFILES).sort()),
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
    empiricalLanguagesReady: Object.entries({
      python: { usable: runtimes.python.usable || runtimes.images.python.usable },
      node: runtimes.node,
      r: { usable: runtimes.r.usable || runtimes.images.r.usable },
      julia: runtimes.julia,
      lean: runtimes.lean,
      latex: runtimes.latex,
    }).filter(([, value]) => value.usable).map(([name]) => name),
    empiricalLanguagesUnavailable: Object.entries({
      python: { usable: runtimes.python.usable || runtimes.images.python.usable },
      node: runtimes.node,
      r: { usable: runtimes.r.usable || runtimes.images.r.usable },
      julia: runtimes.julia,
      lean: runtimes.lean,
      latex: runtimes.latex,
    }).filter(([, value]) => !value.usable).map(([name]) => name),
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

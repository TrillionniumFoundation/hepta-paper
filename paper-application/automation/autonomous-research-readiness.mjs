import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createAutonomousHypothesisGenerationReceipt,
  createMachineProposedScientificClaimSet,
} from '../../paper-domain/automation/autonomous-research-proposal-contract.mjs';
import {
  buildAutonomousResearchSeedBinding,
  buildAutonomousResearchSeedContractBundle,
  evaluateAutonomousResearchPolicy,
} from '../../paper-domain/automation/autonomous-research-policy-contract.mjs';
import {
  evaluateAutonomousCampaignTopology,
  evaluateAutonomousDatasetLaunchReadiness,
  evaluateAutonomousResearchPrincipalSeparation,
  evaluateAutonomousResearchQualificationEligibility,
} from '../../paper-domain/automation/autonomous-research-readiness-policy.mjs';
import { selectAutonomousEmpiricalExecutionProfile } from '../../paper-domain/automation/autonomous-empirical-execution-profile-policy.mjs';
import {
  AUTONOMOUS_RESEARCH_LAUNCH_MODES,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
import {
  inspectAutonomousResearchProductionProfileInputs,
  inspectAutonomousResearchProductionProfilePreparation,
} from '../../paper-domain/automation/autonomous-research-production-profile-contract.mjs';
import {
  verifyAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import {
  buildLimitedPriorArtEvidenceReceipt,
  verifyPriorArtEvidenceReceipt,
} from '../../paper-domain/research/prior-art-evidence-contract.mjs';
import {
  STRONG_PRIOR_ART_CAPABILITY_MODE,
  buildAutonomousResearchCapabilityScopeManifest,
  verifyAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import { assertPriorArtRetrievalPort } from '../../paper-ports/prior-art-retrieval-port.mjs';
import {
  verifyResearchPrincipalPool,
} from '../../paper-domain/research/research-principal-pool-contract.mjs';
import {
  buildAutonomousResearchCampaignTopologyTemplate,
} from './autonomous-research-campaign-topology-template.mjs';
import {
  composeAutonomousResearchRuntimePrincipalBinding,
  requireAutonomousResearchAgentProductionAuthorityBinding,
} from './autonomous-research-runtime-principal-binding.mjs';
import {
  generateAutonomousResearchAgenda,
  generateAutonomousResearchHypothesis,
} from './autonomous-research-readiness-generation.mjs';
import {
  buildConservativePriorArtClaimAlignment,
} from './prior-art-claim-alignment-production.mjs';
import {
  prepareAutonomousResearchVenue,
} from './autonomous-research-venue-preparation.mjs';
import {
  buildResearchAgendaClaimBindingReceipt,
  verifyResearchAgendaClaimBindingReceipt,
} from '../../paper-domain/automation/research-agenda-claim-binding-contract.mjs';
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export async function prepareAutonomousResearchLoop({
  paperId,
  objective,
  protocolFamily,
  researchAgendaProducer = null,
  hypothesisGenerator = null,
  requireAgentAuthoredProse = false,
  declaredCapabilityScopeManifest = null,
  venueProfileRegistry = null,
  venueProfileRegistryAuthority = null,
  venueTemplateAssetBundle = null,
  submissionMetadataProfile = null,
  submissionMetadataAuthority = null,
  autonomousSubmissionPortalConfigurationHash = null,
  externalResearchReplayConfigurationHash = null,
  venueComplianceRuntimeInspection = null,
  priorArtRetriever = null,
  authorIdentityAttestation = null,
  authorIdentityAuthorityEnvelope = null,
  authorIdentityConfigurationHash = null,
  externalCapabilityTrustInspection = null,
  authorPrincipal = null,
  formalReviewerPrincipal = null,
  researchPrincipalPool = null,
  campaignReleaseAuthority = null,
  revisionRounds = 3,
  refereeCount = 3,
  humanSubjects = false,
  privateData = false,
  datasetMounts = [],
  datasetAuthorityReceipt = null,
  empiricalRuntimeCapabilityInspection = null,
  runtimeImageReproducibilityInspection = null,
  autonomousResearchProviderConfigurationHash = null,
  productionAuthorityBinding = null,
  machineIntake = null,
  machineIntakeAdmission = null,
  launchMode = AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP,
  createdAt = null,
  assertExternalSideEffectReady = null,
} = {}) {
  if (!Object.values(AUTONOMOUS_RESEARCH_LAUNCH_MODES).includes(launchMode)) {
    throw new Error(`autonomous_research_launch_mode_invalid:${launchMode || '<empty>'}`);
  }
  const productionProfileInputInspection =
    inspectAutonomousResearchProductionProfileInputs({
      launchMode,
      researchAgendaProducer,
      hypothesisGenerator,
      requireAgentAuthoredProse,
      capabilityScopeManifest: declaredCapabilityScopeManifest,
      externalCapabilityTrustInspection,
      empiricalRuntimeCapabilityInspection,
      runtimeImageReproducibilityInspection,
      observedAt: createdAt,
    });
  if (!productionProfileInputInspection.ready) {
    throw new Error(
      `autonomous_research_production_profile_inputs_blocked:${productionProfileInputInspection.blockers.join(',')}`,
    );
  }
  if (externalResearchReplayConfigurationHash !== null
    && !SHA256.test(String(externalResearchReplayConfigurationHash || ''))) {
    throw new Error('autonomous_research_external_replay_configuration_hash_invalid');
  }
  if (Boolean(machineIntake) !== Boolean(machineIntakeAdmission)
    || (machineIntakeAdmission && (
      !verifyAutonomousResearchMachineIntakeAdmission(machineIntakeAdmission, {
        intake: machineIntake,
      })
      || machineIntakeAdmission.paperId !== paperId
      || machineIntakeAdmission.campaignId !== `autonomous-research:${paperId}`
    ))) {
    throw new Error('autonomous_research_machine_intake_admission_binding_invalid');
  }
  const datasetAuthorityConstraintInspection = evaluateAutonomousDatasetLaunchReadiness({
    protocolFamily: datasetAuthorityReceipt?.benchmarkFamily || null,
    datasetMounts,
    datasetAuthorityReceipt,
  });
  const datasetAuthorityProtocolFamily = datasetAuthorityConstraintInspection.status
    === 'autonomous_research_dataset_launch_ready'
    ? datasetAuthorityReceipt.benchmarkFamily : null;
  const agenda = await generateAutonomousResearchAgenda({
    researchAgendaProducer,
    paperId,
    objective,
    protocolFamily,
    datasetAuthorityProtocolFamily,
    selectedAt: createdAt,
  });
  const { agendaSelectionReceipt, researchAgendaProducerReceipt, researchAgendaIr } = agenda;
  const selectedObjective = agendaSelectionReceipt.selectedObjective;
  const selectedProtocolFamily = agendaSelectionReceipt.selectedProtocolFamily;
  const generated = await generateAutonomousResearchHypothesis({
    hypothesisGenerator,
    paperId,
    objective: selectedObjective,
    protocolFamily: selectedProtocolFamily,
    researchAgendaIr,
  });
  const generationReceipt = createAutonomousHypothesisGenerationReceipt({
    draft: generated.draft,
    principalId: generated.principalId,
    provider: generated.provider,
    model: generated.model,
    externalActionPerformed: generated.externalActionPerformed,
    generatedAt: createdAt,
  });
  const proposal = createMachineProposedScientificClaimSet({
    paperId,
    objective: selectedObjective,
    protocolFamily: selectedProtocolFamily,
    draft: generated.draft,
    generationReceipt,
    agendaSelectionReceipt,
    dynamicFormalClaimSeed: generated.dynamicFormalClaimSeed,
    researchContentProducerReceipt: generated.researchContentProducerReceipt,
    createdAt,
  });
  const agendaClaimBindingReceipt = researchAgendaIr
    ? buildResearchAgendaClaimBindingReceipt({ researchAgendaIr, proposal }) : null;
  if (researchAgendaIr && !verifyResearchAgendaClaimBindingReceipt(
    agendaClaimBindingReceipt,
    { researchAgendaIr, proposal },
  ).valid) {
    throw new Error(
      `autonomous_research_agenda_claim_binding_blocked:${agendaClaimBindingReceipt.blockers.join(',')}`,
    );
  }
  const productionRun = launchMode === AUTONOMOUS_RESEARCH_LAUNCH_MODES.PRODUCTION_RUN;
  const {
    venueProfileSelection,
    venueTemplateAsset,
    venueTemplateAssetReady,
    submissionMetadataReceipt,
    venueRequirementIr,
    venueComplianceRuntimeVerified,
  } = prepareAutonomousResearchVenue({
    paperId,
    proposal,
    researchAgendaIr,
    productionRun,
    venueProfileRegistry,
    venueProfileRegistryAuthority,
    venueTemplateAssetBundle,
    submissionMetadataProfile,
    submissionMetadataAuthority,
    venueComplianceRuntimeInspection,
    createdAt,
  });
  if (autonomousSubmissionPortalConfigurationHash !== null
    && !/^sha256:[0-9a-f]{64}$/.test(String(
      autonomousSubmissionPortalConfigurationHash,
    ))) {
    throw new Error('autonomous_research_submission_portal_configuration_hash_invalid');
  }
  let priorArtAuthorityVerificationBundle = null;
  let priorArtAuthorityTrustConfiguration = null;
  let priorArtReceipt = null;
  if (productionRun) {
    if (generated.priorArtReceipt !== null) {
      throw new Error('autonomous_research_production_generated_prior_art_forbidden');
    }
    if (!priorArtRetriever) {
      throw new Error('autonomous_research_production_prior_art_retriever_required');
    }
    const retriever = assertPriorArtRetrievalPort(priorArtRetriever);
    const priorArtTrust = externalCapabilityTrustInspection?.components?.priorArt || null;
    if (retriever.cryptographicAuthorityReady !== true
      || retriever.identityIndependenceReady !== true
      || retriever.evidenceProfile !== STRONG_PRIOR_ART_CAPABILITY_MODE
      || retriever.trustSetHash !== priorArtTrust?.trustSetHash
      || retriever.signatureVerificationPolicyHash
        !== priorArtTrust?.signatureVerificationPolicyHash) {
      throw new Error('autonomous_research_production_prior_art_trust_not_ready');
    }
    if (assertExternalSideEffectReady) {
      await assertExternalSideEffectReady({
        action: 'production_prior_art_retrieval',
        paperId,
      });
      assertExternalSideEffectReady.assertCurrent?.({
        action: 'production_prior_art_retrieval',
        paperId,
      });
    }
    await assertExternalSideEffectReady?.markStarted?.({
      action: 'production_prior_art_retrieval',
    });
    priorArtReceipt = await retriever.retrieve({
      paperId,
      objective: selectedObjective,
      protocolFamily: selectedProtocolFamily,
      researchAgendaIrHash: researchAgendaIr.researchAgendaIrHash,
      priorArtQueryPlan: researchAgendaIr.priorArtQueryPlan,
      agendaSelectionReceiptHash:
        agendaSelectionReceipt.autonomousResearchAgendaSelectionReceiptHash,
      generatorPrincipalId: generated.principalId,
      generatorIdentityAttestation:
        authorIdentityAttestation || generated.principalIdentityAttestation,
      generatorIdentityAuthorityEnvelope:
        authorIdentityAuthorityEnvelope || generated.principalIdentityAuthorityEnvelope,
      createdAt: createdAt || agendaSelectionReceipt.selectedAt
        || '1970-01-01T00:00:00.000Z',
    });
    priorArtAuthorityVerificationBundle = retriever.verifyAuthority(priorArtReceipt);
    if (retriever.authorityFor(priorArtReceipt)
      !== priorArtAuthorityVerificationBundle) {
      throw new Error('autonomous_research_production_prior_art_authority_invalid');
    }
    retriever.verifyAuthorityBundle(
      priorArtReceipt, priorArtAuthorityVerificationBundle,
    );
    priorArtAuthorityTrustConfiguration = retriever.authorityTrustConfiguration();
  } else {
    priorArtReceipt = generated.priorArtReceipt
      || (priorArtRetriever
        ? await (async () => {
          if (assertExternalSideEffectReady) {
            await assertExternalSideEffectReady({
              action: 'bounded_prior_art_retrieval',
              paperId,
            });
            assertExternalSideEffectReady.assertCurrent?.({
              action: 'bounded_prior_art_retrieval',
              paperId,
            });
          }
          await assertExternalSideEffectReady?.markStarted?.({
            action: 'bounded_prior_art_retrieval',
          });
          return assertPriorArtRetrievalPort(priorArtRetriever).retrieve({
        paperId,
        objective: selectedObjective,
        protocolFamily: selectedProtocolFamily,
        researchAgendaIrHash: researchAgendaIr?.researchAgendaIrHash,
        priorArtQueryPlan: researchAgendaIr?.priorArtQueryPlan,
        agendaSelectionReceiptHash:
          agendaSelectionReceipt.autonomousResearchAgendaSelectionReceiptHash,
        generatorPrincipalId: generated.principalId,
        createdAt: createdAt || agendaSelectionReceipt.selectedAt
          || '1970-01-01T00:00:00.000Z',
          });
        })()
      : buildLimitedPriorArtEvidenceReceipt({
        paperId,
        agendaSelectionReceiptHash:
          agendaSelectionReceipt.autonomousResearchAgendaSelectionReceiptHash,
        generatorPrincipalId: generated.principalId,
        createdAt: createdAt || agendaSelectionReceipt.selectedAt
          || '1970-01-01T00:00:00.000Z',
        }));
  }
  const priorArtVerification = verifyPriorArtEvidenceReceipt(priorArtReceipt, {
    paperId,
    agendaSelectionReceiptHash:
      agendaSelectionReceipt.autonomousResearchAgendaSelectionReceiptHash,
    ...(researchAgendaIr ? {
      researchAgendaIrHash: researchAgendaIr.researchAgendaIrHash,
      priorArtQueryPlan: researchAgendaIr.priorArtQueryPlan,
    } : {}),
    requireVerified: productionRun,
  });
  if (!priorArtVerification.valid) {
    throw new Error(`autonomous_research_prior_art_evidence_invalid:${priorArtVerification.blockers.join(',')}`);
  }
  let priorArtClaimAlignmentReceipt = null;
  if (researchAgendaIr && priorArtReceipt?.version === 2) {
    priorArtClaimAlignmentReceipt = buildConservativePriorArtClaimAlignment({
      researchAgendaIr,
      agendaSelectionReceipt,
      priorArtEvidenceReceipt: priorArtReceipt,
    });
  } else if (productionRun) {
    throw new Error('autonomous_research_production_prior_art_claim_alignment_required');
  }
  const policyAuthorization = evaluateAutonomousResearchPolicy({
    proposal,
    agendaSelectionReceipt,
    humanSubjects,
    privateData,
    externalDatasetAuthorityVerified: Boolean(datasetAuthorityProtocolFamily),
    externalSubmissionRequested: false,
    requestedRevisionRounds: revisionRounds,
    requestedRefereeCount: refereeCount,
    evaluatedAt: createdAt,
  });
  const seedBundle = buildAutonomousResearchSeedContractBundle({
    proposal,
    policyAuthorization,
    evidencePlan: [
      'Bind every manuscript empirical result to verified original and replay artifact hashes.',
      'Bind every formal claim to a kernel-checked proof certificate and replay receipt.',
    ],
    reproducibilityPlan: [
      'Preserve code, runtime image, dataset authority, protocol, seed, and output identities by hash.',
      'Require a fresh isolated deterministic rerun before research promotion; do not describe it as independent scientific replication.',
    ],
    createdAt,
  });
  const seedBinding = buildAutonomousResearchSeedBinding({ seedBundle });
  const empiricalExecutionProfileSelection = selectAutonomousEmpiricalExecutionProfile({
    protocolFamily: proposal.protocolFamily,
    runtimeCapabilityInspection: empiricalRuntimeCapabilityInspection,
    runtimeReproducibilityInspection: runtimeImageReproducibilityInspection,
    requireRegisteredRuntime: productionRun,
    observedAt: createdAt,
  });
  const topologyTemplate = buildAutonomousResearchCampaignTopologyTemplate({
    paperId: proposal.paperId,
    revisionRounds: Number(revisionRounds),
    refereeCount: Number(refereeCount),
    empiricalExecutionProfileSelection,
  });
  const topologyInspection = evaluateAutonomousCampaignTopology({ nodes: topologyTemplate.nodes });
  const principalSeparation = evaluateAutonomousResearchPrincipalSeparation({
    authorPrincipal,
    formalReviewerPrincipal,
  });
  const runtimePrincipalBinding = composeAutonomousResearchRuntimePrincipalBinding({
    required: launchMode === AUTONOMOUS_RESEARCH_LAUNCH_MODES.PRODUCTION_RUN,
    authorIdentityConfigurationHash,
    authorPrincipal,
    researchPrincipalPool,
    externalCapabilityTrustInspection,
  });
  const agentAuthority = requireAutonomousResearchAgentProductionAuthorityBinding({
    required: productionRun, binding: productionAuthorityBinding,
    runtimePrincipalBinding, autonomousResearchProviderConfigurationHash,
  });
  if (researchPrincipalPool && !verifyResearchPrincipalPool(researchPrincipalPool)) {
    throw new Error('autonomous_research_principal_pool_invalid');
  }
  const datasetLaunchInspection = evaluateAutonomousDatasetLaunchReadiness({
    protocolFamily: proposal.protocolFamily,
    datasetMounts,
    datasetAuthorityReceipt,
  });
  const qualificationEligibility = evaluateAutonomousResearchQualificationEligibility({
    proposal,
    policyAuthorization,
    seedBundle,
    seedBinding,
    principalSeparation,
    topologyInspection,
    datasetLaunchInspection,
    empiricalRuntimeCapabilityInspection,
    empiricalExecutionProfileSelection,
    runtimeImageReproducibilityInspection,
    launchMode,
    observedAt: createdAt,
    campaignReleaseAuthority,
    fullResearchQualificationInspection: null,
  });
  const derivedCapabilityScopeManifest = buildAutonomousResearchCapabilityScopeManifest({
    scopeId: `hepta.autonomous-research.${proposal.paperId}`,
    agendaMode: researchAgendaProducerReceipt
      ? 'machine-generated' : 'registered-profile',
    manuscriptMode: requireAgentAuthoredProse
      ? 'agent-authored-evidence-bound-ir-v1'
      : 'minimal-report-evidence-bound-ir-v1',
    formalClaimClasses: generated.dynamicFormalClaimSeed
      ? ['dynamic-lean-type-v1', 'registered-template-v1']
      : ['registered-template-v1'],
    empiricalFamilies: [proposal.protocolFamily],
    priorArtMode: priorArtVerification.ready
      ? (priorArtReceipt?.version === 2
          && priorArtReceipt?.evidenceProfile === STRONG_PRIOR_ART_CAPABILITY_MODE
        ? STRONG_PRIOR_ART_CAPABILITY_MODE : 'structured-receipt-v1')
      : 'opaque-hash-v1',
    reviewerPrincipalCount: researchPrincipalPool?.reviewerPrincipalCount || 1,
    reviewerTrustDomainCount: researchPrincipalPool?.reviewerTrustDomainCount || 1,
    replayMode: SHA256.test(String(externalResearchReplayConfigurationHash || ''))
      ? 'external-trust-domain-v1' : 'same-process-recomputation-v1',
    venueMode: venueProfileSelection?.profile.externalSubmissionEnabled
      && autonomousSubmissionPortalConfigurationHash && submissionMetadataReceipt
      && venueTemplateAssetReady
      && venueComplianceRuntimeVerified
      && venueProfileSelection.profile.bibliographyStyle === 'inline-evidence-v1'
      && venueProfileSelection.profile.citationStyle === 'evidence-inline-v1'
      ? 'submission-enabled-v1'
      : venueProfileSelection ? 'profile-selected-v1' : 'disabled',
    externalPrerequisites: Object.freeze([
      ...(!priorArtVerification.ready ? ['prior-art-service'] : []),
      ...(researchPrincipalPool?.reviewerTrustDomainCount >= refereeCount
        ? [] : ['independent-reviewer-trust-domains']),
      ...(!SHA256.test(String(externalResearchReplayConfigurationHash || ''))
        ? ['external-replay-service'] : []),
      ...(!venueProfileSelection ? ['venue-profile-registry'] : []),
      ...(venueProfileSelection?.profile.externalSubmissionEnabled
        && !autonomousSubmissionPortalConfigurationHash
        ? ['submission-portal-service'] : []),
      ...(venueProfileSelection?.profile.externalSubmissionEnabled
        && !submissionMetadataReceipt
        ? ['submission-metadata-profile'] : []),
      ...(venueProfileSelection?.profile.externalSubmissionEnabled
        && !venueTemplateAssetReady
        ? ['venue-template-assets'] : []),
      ...(venueProfileSelection?.profile.externalSubmissionEnabled
        && !venueComplianceRuntimeVerified
        ? ['venue-compliance-runtime'] : []),
      ...(venueProfileSelection?.profile.externalSubmissionEnabled
        && (venueProfileSelection.profile.bibliographyStyle !== 'inline-evidence-v1'
          || venueProfileSelection.profile.citationStyle !== 'evidence-inline-v1')
        ? ['venue-rendering-profile'] : []),
      ...(requireAgentAuthoredProse
        ? (externalCapabilityTrustInspection?.blockers
          || ['autonomous_research_external_capability_trust_missing']) : []),
    ]),
  });
  if (declaredCapabilityScopeManifest
    && (!verifyAutonomousResearchCapabilityScopeManifest(declaredCapabilityScopeManifest)
      || !declaredCapabilityScopeManifest.empiricalFamilies.includes(proposal.protocolFamily)
      || (researchAgendaProducerReceipt
        && JSON.stringify(researchAgendaProducerReceipt.allowedProtocolFamilies)
          !== JSON.stringify(declaredCapabilityScopeManifest.empiricalFamilies))
      || declaredCapabilityScopeManifest.agendaMode !== derivedCapabilityScopeManifest.agendaMode
      || declaredCapabilityScopeManifest.manuscriptMode
        !== derivedCapabilityScopeManifest.manuscriptMode
      || JSON.stringify(declaredCapabilityScopeManifest.formalClaimClasses)
        !== JSON.stringify(derivedCapabilityScopeManifest.formalClaimClasses)
      || declaredCapabilityScopeManifest.priorArtMode
        !== derivedCapabilityScopeManifest.priorArtMode
      || declaredCapabilityScopeManifest.reviewerPrincipalCount
        > (researchPrincipalPool?.reviewerPrincipalCount || 1)
      || declaredCapabilityScopeManifest.reviewerTrustDomainCount
        > (researchPrincipalPool?.reviewerTrustDomainCount || 1)
      || (declaredCapabilityScopeManifest.replayMode === 'external-trust-domain-v1'
        && !SHA256.test(String(externalResearchReplayConfigurationHash || '')))
      || (declaredCapabilityScopeManifest.venueMode === 'submission-enabled-v1'
        && (!venueProfileSelection?.profile.externalSubmissionEnabled
          || !autonomousSubmissionPortalConfigurationHash
          || !submissionMetadataReceipt
          || !venueTemplateAssetReady
          || !venueComplianceRuntimeVerified
          || venueProfileSelection.profile.bibliographyStyle !== 'inline-evidence-v1'
          || venueProfileSelection.profile.citationStyle !== 'evidence-inline-v1')))) {
    throw new Error('autonomous_research_declared_capability_scope_invalid');
  }
  const capabilityScopeManifest = declaredCapabilityScopeManifest
    || derivedCapabilityScopeManifest;
  if (generated.dynamicFormalClaimSeed
    && generated.dynamicFormalClaimSeed.capabilityScopeManifestHash
      !== capabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash) {
    throw new Error('autonomous_research_dynamic_formal_capability_scope_mismatch');
  }
  const productionProfileInspection =
    inspectAutonomousResearchProductionProfilePreparation({
      launchMode,
      proposal,
      capabilityScopeManifest,
      researchAgendaProducerReceipt,
      researchAgendaIr,
      agendaClaimBindingReceipt,
      researchContentProducerReceipt: generated.researchContentProducerReceipt,
      dynamicFormalClaimSeed: generated.dynamicFormalClaimSeed,
      externalCapabilityTrustInspection,
      priorArtReceipt,
      priorArtClaimAlignmentReceipt,
      priorArtAuthorityVerificationBundle,
      priorArtAuthorityTrustConfiguration,
      empiricalRuntimeCapabilityInspection,
      runtimeImageReproducibilityInspection,
      empiricalExecutionProfileSelection,
      runtimePrincipalBinding,
      runtimePrincipalBindingHash:
        runtimePrincipalBinding?.runtimePrincipalBindingHash || null,
      autonomousResearchProviderConfigurationHash,
      productionAuthorityBinding: agentAuthority,
      productionAuthorityBindingHash: agentAuthority?.autonomousResearchAgentProductionAuthorityBindingHash || null,
      observedAt: createdAt,
      venueProfileSelection,
      submissionMetadataReceipt,
    });
  if (!productionProfileInspection.ready) {
    throw new Error(
      `autonomous_research_production_profile_blocked:${productionProfileInspection.blockers.join(',')}`,
    );
  }
  const payload = {
    version: 1,
    kind: 'AutonomousResearchLoopPreparationReport',
    status: qualificationEligibility.status,
    proposal,
    generationReceipt,
    researchAgendaProducerReceipt,
    ...(researchAgendaIr ? { researchAgendaIr } : {}),
    ...(agendaClaimBindingReceipt ? { agendaClaimBindingReceipt } : {}),
    priorArtReceipt,
    priorArtVerification,
    priorArtClaimAlignmentReceipt,
    priorArtAuthorityVerificationBundle,
    priorArtAuthorityVerificationBundleHash:
      priorArtAuthorityVerificationBundle
        ?.priorArtRetrievalAuthorityVerificationBundleHash || null,
    priorArtAuthorityTrustConfiguration,
    priorArtAuthorityTrustConfigurationHash:
      priorArtAuthorityTrustConfiguration
        ?.priorArtAuthorityTrustConfigurationHash || null,
    researchContentProducerReceipt: generated.researchContentProducerReceipt,
    dynamicFormalClaimSeed: generated.dynamicFormalClaimSeed,
    manuscriptOutline: generated.manuscriptOutline,
    venueProfileSelection,
    ...(venueTemplateAsset ? {
      venueTemplateAsset,
      venueTemplateAssetBundleHash:
        venueProfileSelection.venueTemplateAssetBundleHash,
      venueTemplateAssetAuthorityConfigurationHash:
        venueProfileSelection.venueAuthorityConfigurationHash,
    } : {}),
    ...(venueRequirementIr ? { venueRequirementIr } : {}),
    submissionMetadataReceipt,
    venueComplianceRuntimeInspection,
    autonomousSubmissionPortalConfigurationHash,
    externalResearchReplayConfigurationHash,
    externalCapabilityTrustInspection,
    externalCapabilityTrustInspectionHash:
      externalCapabilityTrustInspection
        ?.autonomousResearchExternalCapabilityTrustInspectionHash || null,
    policyAuthorization,
    seedBundle,
    seedBinding,
    launchMode,
    autonomousResearchProviderConfigurationHash,
    ...(machineIntakeAdmission ? {
      autonomousResearchMachineIntakeAdmission: machineIntakeAdmission,
      autonomousResearchMachineIntakeAdmissionHash:
        machineIntakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
    } : {}),
    empiricalRuntimeCapabilityInspection,
    runtimeImageReproducibilityInspection,
    empiricalExecutionProfileSelection,
    principalSeparation,
    researchPrincipalPool,
    researchPrincipalPoolHash: researchPrincipalPool?.researchPrincipalPoolHash || null,
    runtimePrincipalBinding,
    runtimePrincipalBindingHash:
      runtimePrincipalBinding?.runtimePrincipalBindingHash || null,
    productionAuthorityBinding: agentAuthority,
    productionAuthorityBindingHash: agentAuthority?.autonomousResearchAgentProductionAuthorityBindingHash || null,
    topologyTemplate,
    topologyInspection,
    datasetLaunchInspection,
    qualificationEligibility,
    capabilityScopeManifest,
    capabilityScopeManifestHash:
      capabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash,
    productionProfileInspection,
    autonomousExecutionLaunchReady: qualificationEligibility.autonomousExecutionLaunchReady,
    autonomousPolicyReady: policyAuthorization.status === 'machine_proposal_policy_authorized',
    qualificationRequestEligible: qualificationEligibility.qualificationRequestEligible,
    campaignFullyQualified: false,
    fullAutomaticResearchWritingReady: false,
    safety: Object.freeze({
      machineProposed: true,
      operatorApprovalClaimed: false,
      selfSignedExternalTrustClaimed: false,
      externalSubmissionEnabled: false,
      universalResearchValidityClaimed: false,
      naturalLanguageToLeanEquivalenceMachineProven: false,
    }),
    createdAt: createdAt || null,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchLoopPreparationReportHash:
      hashRecord('AutonomousResearchLoopPreparationReport', payload),
  });
}

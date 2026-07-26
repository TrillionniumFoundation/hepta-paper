import {
  createAutonomousResearchMachineIntakeRepository,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-repository.mjs';
import {
  readAutonomousResearchMachineIntakeConfiguration,
  readStaticAutonomousResearchMachineIntake,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import {
  inspectAutonomousResearchSupervisorInstanceStatus,
} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {
  inspectAutonomousResearchTopicProducerStatus,
} from '../../paper-adapters/automation/autonomous-research-topic-producer-status.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from './autonomous-research-provider-configuration.mjs';
import {
  inspectConfiguredAutonomousResearchTopicProducer,
} from './autonomous-research-machine-intake-composition.mjs';
import {
  evaluateAutonomousResearchCapabilityRequestCoverage,
  verifyAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import {
  inspectGenericDomainCapabilityEvidenceBindings,
} from './generic-domain-capability-evidence-publication.mjs';

export { inspectAutonomousResearchSupervisorInstanceStatus };
export {
  inspectAutonomousResearchResidentPrerequisites,
} from './autonomous-research-resident-prerequisite-inspection.mjs';

export function evaluateAutonomousResearchMachineIntakeConfigurationReadiness({
  configuration,
  providerConfiguration,
  topicProducerInspection = null,
} = {}) {
  const currentProviderConfigurationHash = providerConfiguration
    ?.autonomousResearchProviderConfigurationHash || null;
  const recurringTemplates = Array.isArray(configuration?.recurringGoldenTemplates)
    ? configuration.recurringGoldenTemplates : [];
  const staticFiles = Array.isArray(configuration?.staticIntakeFiles)
    ? configuration.staticIntakeFiles : [];
  let staticIntakes = [];
  let staticContentValid = true;
  try {
    staticIntakes = staticFiles.map(({ path }) => (
      readStaticAutonomousResearchMachineIntake(path).intake
    ));
  } catch {
    staticContentValid = false;
  }
  const recurringGoldenProviderConfigurationBound = recurringTemplates.length > 0
    && recurringTemplates.every((template) => (
      template.providerConfigurationHash === currentProviderConfigurationHash
    ));
  const staticIntakeProviderConfigurationBound = staticFiles.length > 0
    && staticContentValid
    && staticIntakes.every((intake) => (
      intake.providerConfigurationHash === currentProviderConfigurationHash
    ));
  const recurringGoldenReady = recurringGoldenProviderConfigurationBound;
  const machineProducerAdmissionCapabilityReady = Boolean(
    configuration?.version === 2
    && configuration?.machineAppendEnabled === true
    && topicProducerInspection?.ready === true
    && topicProducerInspection?.producerProfile?.producerProfileHash
      === configuration.machineProducerProfileHash
    && topicProducerInspection?.producerProfile?.providerConfigurationHash
      === currentProviderConfigurationHash
    && topicProducerInspection?.implementationIdentity?.ready === true,
  );
  const productionIntakeReady = staticIntakeProviderConfigurationBound
    || (configuration?.machineAppendEnabled === true
      && machineProducerAdmissionCapabilityReady);
  const blockers = [];
  if (!recurringTemplates.length) {
    blockers.push('autonomous_research_recurring_golden_template_required');
  } else if (!recurringGoldenProviderConfigurationBound) {
    blockers.push('autonomous_research_recurring_golden_provider_configuration_mismatch');
  }
  if (!staticContentValid) {
    blockers.push('autonomous_research_machine_intake_static_content_invalid_or_drifted');
  } else if (staticFiles.length && !staticIntakeProviderConfigurationBound) {
    blockers.push('autonomous_research_static_intake_provider_configuration_mismatch');
  }
  if (!productionIntakeReady) {
    blockers.push(configuration?.machineAppendEnabled === true
      ? 'autonomous_research_machine_intake_producer_admission_capability_required'
      : 'autonomous_research_production_static_intake_required');
  }
  return Object.freeze({
    configurationReady: blockers.length === 0,
    configurationHash: configuration?.configurationHash || null,
    currentProviderConfigurationHash,
    recurringGoldenReady,
    recurringGoldenProviderConfigurationBound,
    staticIntakeProviderConfigurationBound,
    machineAppendAuthorized: configuration?.machineAppendEnabled === true,
    machineProducerAdmissionCapabilityReady,
    machineProducerProfileHash:
      topicProducerInspection?.producerProfile?.producerProfileHash || null,
    machineProducerImplementationSha256:
      topicProducerInspection?.implementationIdentity?.implementationSha256 || null,
    topicProducerDatasetSnapshot:
      topicProducerInspection?.datasetSnapshot || null,
    topicProducerDatasetSnapshotHash:
      topicProducerInspection?.datasetSnapshot?.datasetSnapshotHash || null,
    productionIntakeReady,
    blockers: Object.freeze(blockers),
  });
}

export function inspectAutonomousResearchMachineIntakeStatus({
  runtimeRoot,
  environment = process.env,
  providerConfiguration = null,
} = {}) {
  if (!runtimeRoot) {
    throw new Error('autonomous_research_machine_intake_status_runtime_root_required');
  }
  const configPath = environment.HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG || null;
  const configured = Boolean(configPath);
  let configuration = null;
  const blockers = [];
  if (!configured) blockers.push('autonomous_research_machine_intake_configuration_missing');
  else {
    try {
      configuration = readAutonomousResearchMachineIntakeConfiguration({
        configPath,
        environment,
      }).configuration;
    } catch {
      blockers.push('autonomous_research_machine_intake_configuration_invalid_or_drifted');
    }
  }
  let effectiveProviderConfiguration = providerConfiguration;
  try {
    effectiveProviderConfiguration ||= resolveAutonomousResearchProviderConfiguration({
      environment,
    });
  } catch {
    effectiveProviderConfiguration = null;
    blockers.push('autonomous_research_machine_intake_provider_configuration_invalid');
  }
  const topicProducerInspection = configuration
    ? inspectConfiguredAutonomousResearchTopicProducer({
      configuration,
      providerConfiguration: effectiveProviderConfiguration,
      environment,
    }) : null;
  const configurationReadiness = configuration
    ? evaluateAutonomousResearchMachineIntakeConfigurationReadiness({
      configuration,
      providerConfiguration: effectiveProviderConfiguration,
      topicProducerInspection,
    }) : Object.freeze({
      configurationReady: false,
      configurationHash: null,
      currentProviderConfigurationHash: effectiveProviderConfiguration
        ?.autonomousResearchProviderConfigurationHash || null,
      recurringGoldenReady: false,
      recurringGoldenProviderConfigurationBound: false,
      staticIntakeProviderConfigurationBound: false,
      machineAppendAuthorized: false,
      machineProducerAdmissionCapabilityReady: false,
      topicProducerDatasetSnapshot: null,
      topicProducerDatasetSnapshotHash: null,
      productionIntakeReady: false,
      blockers: Object.freeze([]),
    });
  blockers.push(...configurationReadiness.blockers);
  let repository = null;
  try {
    repository = createAutonomousResearchMachineIntakeRepository({
      runtimeRoot,
      create: false,
    });
    const state = repository.readStatus({ limit: 100 });
    const topicProducerState = configuration?.version === 2
      && topicProducerInspection?.ready === true
      ? inspectAutonomousResearchTopicProducerStatus({
        runtimeRoot,
        machineIntakeConfigurationHash: configuration.configurationHash,
        producerProfile: topicProducerInspection.producerProfile,
        implementationSha256:
          topicProducerInspection.implementationIdentity.implementationSha256,
      }) : null;
    const repositoryConfigurationAuthorityBound = Boolean(
      configuration
      && state.configuredSourceAuthorityHash === configuration.configurationHash,
    );
    const repositoryProducerAuthorityBound = configuration?.version !== 2
      || state.configuredMachineProducerProfileHash
        === configuration.machineProducerProfileHash;
    if (configuration && !repositoryConfigurationAuthorityBound) {
      blockers.push(state.configuredSourceAuthorityHash
        ? 'autonomous_research_machine_intake_repository_configuration_authority_mismatch'
        : 'autonomous_research_machine_intake_repository_configuration_authority_unbound');
    }
    if (configuration?.version === 2 && !repositoryProducerAuthorityBound) {
      blockers.push(state.configuredMachineProducerProfileHash
        ? 'autonomous_research_machine_intake_repository_producer_authority_mismatch'
        : 'autonomous_research_machine_intake_repository_producer_authority_unbound');
    }
    if (configuration?.version === 2 && topicProducerState?.ready !== true) {
      blockers.push(topicProducerState?.blocker
        || 'autonomous_research_topic_producer_state_required');
    }
    return Object.freeze({
      configured,
      configurationValid: Boolean(configuration),
      ...configurationReadiness,
      repositoryConfigurationAuthorityBound,
      repositoryProducerAuthorityBound,
      repositoryAuthorityGeneration: state.configuredAuthorityGeneration,
      machineProducerLive: topicProducerState?.live === true,
      machineProducerCurrentlyProducible:
        topicProducerState?.currentlyProducible === true,
      topicProducerState,
      coldStartAutonomyReady: blockers.length === 0,
      state,
      blockers: Object.freeze([...new Set(blockers)]),
      statusReadOnly: true,
      configuredIntakesLoadedByStatus: false,
    });
  } catch (error) {
    blockers.push('autonomous_research_machine_intake_state_invalid_or_migration_required');
    return Object.freeze({
      configured,
      configurationValid: Boolean(configuration),
      ...configurationReadiness,
      repositoryConfigurationAuthorityBound: false,
      repositoryProducerAuthorityBound: false,
      repositoryAuthorityGeneration: null,
      machineProducerLive: false,
      machineProducerCurrentlyProducible: false,
      topicProducerState: null,
      coldStartAutonomyReady: false,
      state: null,
      blockers: Object.freeze([...new Set(blockers)]),
      statusReadOnly: true,
      configuredIntakesLoadedByStatus: false,
      stateError: String(error?.message || error),
    });
  } finally { repository?.close(); }
}

export function evaluateFullyAutonomousResearchSystemReadiness({
  fullAutomaticResearchWritingReady,
  machineIntake,
  residentSupervisor,
  residentPrerequisites,
  autonomousStateSafety,
  capabilityScopeManifest = null,
  capabilityScopeInspection = null,
  capabilityRequest = null,
  researchAgendaProducerReceipt = null,
  genericDomainCapabilityEvidence = null,
  genericDomainCapabilityVerificationContext = null,
} = {}) {
  const currentMachineIntakeConfigurationHash = machineIntake?.configurationHash || null;
  const reconciledMachineIntakeConfigurationHash =
    residentSupervisor?.instance?.machineIntakeConfigurationHash || null;
  const currentTopicProducerDatasetSnapshotHash =
    machineIntake?.topicProducerDatasetSnapshotHash || null;
  const reconciledTopicProducerDatasetSnapshotHash =
    residentSupervisor?.instance?.machineIntakeDatasetSnapshotHash || null;
  const currentResidentPrerequisiteIdentityHash = residentPrerequisites
    ?.autonomousResearchResidentPrerequisiteIdentityHash || null;
  const reconciledResidentPrerequisiteIdentityHash = residentSupervisor?.instance
    ?.fullyAutonomousPrerequisiteIdentityHash || null;
  const machineIntakeConfigurationReconciled = Boolean(
    currentMachineIntakeConfigurationHash
    && reconciledMachineIntakeConfigurationHash
    && currentMachineIntakeConfigurationHash === reconciledMachineIntakeConfigurationHash,
  );
  const topicProducerDatasetSnapshotReconciled =
    currentTopicProducerDatasetSnapshotHash === reconciledTopicProducerDatasetSnapshotHash;
  const residentPrerequisiteIdentityReconciled = Boolean(
    currentResidentPrerequisiteIdentityHash && reconciledResidentPrerequisiteIdentityHash
      && currentResidentPrerequisiteIdentityHash
        === reconciledResidentPrerequisiteIdentityHash,
  );
  const boundedProfileReady = fullAutomaticResearchWritingReady === true
    && machineIntake?.coldStartAutonomyReady === true
    && residentSupervisor?.ready === true
    && machineIntakeConfigurationReconciled
    && topicProducerDatasetSnapshotReconciled
    && residentPrerequisites?.ready === true
    && residentPrerequisiteIdentityReconciled
    && autonomousStateSafety?.ready === true;
  const capabilityScopeManifestValid = capabilityScopeManifest
    ? verifyAutonomousResearchCapabilityScopeManifest(capabilityScopeManifest) : false;
  const machineGeneratedAgendaReceiptValid = capabilityScopeManifest?.agendaMode
    === 'machine-generated'
    && verifyAutonomousResearchAgendaProductionReceipt(researchAgendaProducerReceipt).valid
    && capabilityScopeManifest.empiricalFamilies.includes(
      researchAgendaProducerReceipt?.selectedProtocolFamily,
    )
    && JSON.stringify(researchAgendaProducerReceipt?.allowedProtocolFamilies)
      === JSON.stringify(capabilityScopeManifest.empiricalFamilies);
  const capabilityCoverage = capabilityScopeManifestValid
    ? evaluateAutonomousResearchCapabilityRequestCoverage({
      manifest: capabilityScopeManifest,
      ...(capabilityRequest || {}),
    })
    : Object.freeze({
      ready: false,
      status: 'autonomous_research_capability_request_not_covered',
      scopeManifestHash: null,
      blockers: Object.freeze(['autonomous_research_capability_scope_manifest_required']),
    });
  const legacyScopeUnspecified = capabilityScopeManifest === null;
  const capabilityScopeInspectionReady = capabilityScopeInspection !== null
    && (capabilityScopeInspection.authorIdentityAttestationReady === true
      && Array.isArray(capabilityScopeInspection.blockers)
      && capabilityScopeInspection.blockers.length === 0);
  const configuredScopeReady = capabilityScopeManifestValid
    && capabilityScopeManifest?.configuredScopeReady === true
    && capabilityScopeManifest?.genericDeclaredCapability === true
    && capabilityScopeInspectionReady;
  const semanticEvidence = genericDomainCapabilityEvidence || {};
  const semanticEvidenceInspection = inspectGenericDomainCapabilityEvidenceBindings({
    evidence: semanticEvidence,
    researchAgendaProducerReceipt,
    genericDomainCapabilityVerificationContext,
  });
  const {
    researchAgendaIrValid,
    experimentIrExecutionAuthorityValid,
    priorArtClaimAlignmentValid,
    venueRequirementIrValid,
    dynamicFormalExecutionAuthorityValid,
    formalDomainCoverageReceiptValid,
    formalDomainCoverageExternallyReplayed,
    formalDomainIndependentReviewValid,
    externalResearchReplayReceiptValid,
    independentFormalReviewReceiptValid,
  } = semanticEvidenceInspection;
  const genericDomainCapabilityBlockers = Object.freeze([
    ...(dynamicFormalExecutionAuthorityValid && formalDomainCoverageReceiptValid
      ? [] : ['autonomous_research_formal_domain_coverage_receipt_required']),
    ...(formalDomainCoverageExternallyReplayed
      ? [] : ['autonomous_research_formal_domain_coverage_external_replay_required']),
    ...(formalDomainIndependentReviewValid
      ? [] : ['autonomous_research_formal_domain_coverage_independent_review_required']),
    ...(experimentIrExecutionAuthorityValid
      ? [] : ['autonomous_research_experiment_ir_execution_authority_receipt_required']),
    ...(researchAgendaIrValid
      ? [] : ['autonomous_research_research_agenda_ir_receipt_required']),
    ...(priorArtClaimAlignmentValid
      ? [] : ['autonomous_research_prior_art_claim_alignment_receipt_required']),
    ...(venueRequirementIrValid
      ? [] : ['autonomous_research_venue_requirement_ir_receipt_required']),
    ...(externalResearchReplayReceiptValid
      ? [] : ['autonomous_research_external_research_replay_receipt_required']),
    ...(independentFormalReviewReceiptValid
      ? [] : ['autonomous_research_independent_formal_review_receipt_required']),
  ]);
  const genericDomainCapabilityReady = genericDomainCapabilityBlockers.length === 0;
  const ready = boundedProfileReady
    && configuredScopeReady
    && machineGeneratedAgendaReceiptValid
    && capabilityCoverage.ready === true
    && genericDomainCapabilityReady;
  const blockers = [
    ...(fullAutomaticResearchWritingReady === true
      ? [] : ['full_automatic_research_writing_not_ready']),
    ...(machineIntake?.blockers || []),
    ...(residentSupervisor?.blockers
      || ['autonomous_research_supervisor_instance_health_required']),
    ...(!currentMachineIntakeConfigurationHash || !reconciledMachineIntakeConfigurationHash
      ? ['autonomous_research_supervisor_machine_intake_configuration_binding_required']
      : currentMachineIntakeConfigurationHash !== reconciledMachineIntakeConfigurationHash
        ? ['autonomous_research_supervisor_machine_intake_configuration_mismatch'] : []),
    ...(!topicProducerDatasetSnapshotReconciled
      ? ['autonomous_research_supervisor_topic_producer_dataset_snapshot_mismatch'] : []),
    ...(residentPrerequisites?.blockers
      || ['autonomous_research_resident_full_prerequisites_not_ready']),
    ...(!residentPrerequisiteIdentityReconciled
      ? ['autonomous_research_resident_prerequisite_identity_mismatch'] : []),
    ...(autonomousStateSafety?.blockers
      || ['autonomous_research_state_safety_inspection_required']),
    ...(!capabilityScopeManifestValid
      ? ['autonomous_research_capability_scope_manifest_required'] : []),
    ...(capabilityScopeManifestValid && !configuredScopeReady
      ? ['autonomous_research_configured_scope_not_ready'] : []),
    ...(capabilityScopeInspection?.blockers || []),
    ...(capabilityScopeInspection?.authorIdentityAttestationReady !== true
      ? ['autonomous_research_author_identity_attestation_required'] : []),
    ...(capabilityScopeManifest?.agendaMode === 'machine-generated'
      && !machineGeneratedAgendaReceiptValid
      ? ['autonomous_research_machine_generated_agenda_receipt_required'] : []),
    ...(capabilityCoverage.blockers || []),
    ...(configuredScopeReady ? genericDomainCapabilityBlockers : []),
  ];
  return Object.freeze({
    ready,
    status: ready
      ? 'generic_domain_autonomous_research_system_ready'
      : boundedProfileReady
        ? 'bounded_profile_autonomous_research_system_ready'
        : 'autonomous_research_system_blocked',
    boundedProfileReady,
    configuredScopeReady,
    genericDomainCapabilityReady,
    genericDomainCapabilityBlockers,
    genericDomainCapabilityEvidenceInspection: Object.freeze({
      dynamicFormalExecutionAuthorityValid,
      formalDomainCoverageReceiptValid,
      formalDomainCoverageExternallyReplayed,
      experimentIrExecutionAuthorityValid,
      researchAgendaIrValid,
      priorArtClaimAlignmentValid,
      venueRequirementIrValid,
      externalResearchReplayReceiptValid,
      independentFormalReviewReceiptValid,
    }),
    capabilityScopeManifestValid,
    capabilityScopeInspectionReady,
    legacyScopeUnspecified,
    capabilityScopeManifestHash:
      capabilityScopeManifest?.autonomousResearchCapabilityScopeManifestHash || null,
    machineGeneratedAgendaReceiptValid,
    researchAgendaProductionReceiptHash:
      researchAgendaProducerReceipt?.autonomousResearchAgendaProductionReceiptHash || null,
    capabilityCoverage,
    currentMachineIntakeConfigurationHash,
    reconciledMachineIntakeConfigurationHash,
    machineIntakeConfigurationReconciled,
    currentTopicProducerDatasetSnapshotHash,
    reconciledTopicProducerDatasetSnapshotHash,
    topicProducerDatasetSnapshotReconciled,
    currentResidentPrerequisiteIdentityHash,
    reconciledResidentPrerequisiteIdentityHash,
    residentPrerequisiteIdentityReconciled,
    autonomousStateSafetyReady: autonomousStateSafety?.ready === true,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

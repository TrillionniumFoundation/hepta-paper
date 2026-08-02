import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const REQUIRED_STATE_DATABASE_ROLES = Object.freeze([
  'external-qualification',
  'full-research-qualification-publication',
  'machine-intake',
  'native-store',
  'resident-instance',
  'runtime-reproducibility-publication',
  'runtime-reproducibility-refresh',
  'submission-handoff',
  'supervisor-state',
  'topic-producer',
]);
const REQUIRED_ADVANCED_NUMERICAL_REFERENCE_FAMILIES = Object.freeze([
  'linear-algebra',
  'monte-carlo',
  'optimization',
]);
const RELEASE_ATTESTOR_INSPECTION_MAXIMUM_AGE_MS = 2 * 60 * 1000;

function currentReleaseAttestorInspection(inspection, observedAt) {
  const hashField =
    'researchExecutionReleaseAttestorConfigurationInspectionHash';
  const { [hashField]: claimedHash, ...payload } = inspection || {};
  const observedTimestamp = observedAt instanceof Date
    ? observedAt.getTime() : Date.parse(String(observedAt));
  const inspectedAt = Date.parse(String(inspection?.inspectedAt || ''));
  const completedAt = Date.parse(String(
    inspection?.liveVerificationCompletedAt || '',
  ));
  const hardwareAttestedAt = Date.parse(String(
    inspection?.kmsHardwareAuthorityAttestedAt || '',
  ));
  const hardwareExpiresAt = Date.parse(String(
    inspection?.kmsHardwareAuthorityExpiresAt || '',
  ));
  return SHA256.test(String(claimedHash || ''))
    && hashRecord(
      'ResearchExecutionReleaseAttestorConfigurationInspection',
      payload,
    ) === claimedHash
    && [
      observedTimestamp,
      inspectedAt,
      completedAt,
      hardwareAttestedAt,
      hardwareExpiresAt,
    ]
      .every(Number.isFinite)
    && hardwareAttestedAt <= inspectedAt
    && inspectedAt <= completedAt
    && completedAt <= observedTimestamp
    && observedTimestamp - inspectedAt
      <= RELEASE_ATTESTOR_INSPECTION_MAXIMUM_AGE_MS
    && completedAt < hardwareExpiresAt
    && observedTimestamp < hardwareExpiresAt;
}

function selectedBlockers(blockers, patterns) {
  return Object.freeze([...new Set((blockers || []).filter((blocker) => (
    patterns.some((pattern) => String(blocker).includes(pattern))
  )))].sort());
}

function externalizedAsset(asset, inspection) {
  const observed = inspection.assets.find((candidate) => candidate.assetId === asset.assetId);
  return Object.freeze({
    assetId: asset.assetId,
    sourcePath: asset.sourcePath,
    externalized: observed?.externalized === true,
    expectedIdentitySha256: asset.expectedIdentitySha256,
    observedIdentitySha256: observed?.observedIdentitySha256 || null,
    externalReference: asset.externalReference ? Object.freeze({
      kind: asset.externalReference.kind,
      transport: asset.externalReference.transport,
      repositoryUrl: asset.externalReference.repositoryUrl,
      pinnedCommit: asset.externalReference.pinnedCommit,
      digest: asset.externalReference.digest,
      restoreDrillReceiptHash:
        asset.externalReference.restoreDrillReceipt
          ?.repositoryAssetExternalRestoreDrillReceiptHash || null,
    }) : null,
  });
}

export function buildProductionDependencyHandoff({
  readiness,
  repositoryAssetInspection,
  repositoryAssetManifest,
  numericalCandidates = [],
  observedAt = new Date(),
} = {}) {
  if (readiness?.version !== 2 || readiness?.kind !== 'AutomationPlaneStatus'
    || repositoryAssetInspection?.version !== 1
    || repositoryAssetInspection?.kind !== 'RepositoryAssetExternalizationInspection'
    || repositoryAssetManifest?.version !== 1
    || repositoryAssetManifest?.kind !== 'RepositoryAssetExternalizationManifest'
    || !Array.isArray(numericalCandidates)) {
    throw new Error('production_dependency_handoff_input_invalid');
  }
  const blockers = readiness.fullyAutonomousResearchSystemBlockers || [];
  const state = readiness.autonomousStateSafety || {};
  const coveredStateRoles = state.inventoryCoveredRoles || [];
  const missingStateRoles = REQUIRED_STATE_DATABASE_ROLES.filter((role) => (
    !coveredStateRoles.includes(role)
  ));
  const identityBlockers = selectedBlockers(blockers, [
    'research_author_', 'formal_review_independent_principal',
    'research_execution_release_attestor',
  ]);
  const readinessQualificationBlockers = selectedBlockers(blockers, [
    'prior_art', 'external_replay', 'generic_content_qualification',
    'external_qualification', 'runtime_reproducibility',
  ]);
  const numericalFamilies = numericalCandidates.map((candidate) => (
    candidate?.analysisFamily
  ));
  const numericalReady =
    numericalCandidates.length === REQUIRED_ADVANCED_NUMERICAL_REFERENCE_FAMILIES.length
    && new Set(numericalFamilies).size
      === REQUIRED_ADVANCED_NUMERICAL_REFERENCE_FAMILIES.length
    && REQUIRED_ADVANCED_NUMERICAL_REFERENCE_FAMILIES.every((analysisFamily) => (
      numericalFamilies.includes(analysisFamily)
    ))
    && numericalCandidates.every((candidate) => (
      candidate.productionQualified === true
      && candidate.fullProductionReady === true
      && candidate.registryPinned === true
      && candidate.runtimeConfigurationPinned === true
      && candidate.dependentDocumentsPinned === true
    ));
  const numericalBlockers = Object.freeze([...new Set([
    ...(numericalReady ? [] : [
      'three_advanced_numerical_reference_families_full_production_qualification_required',
    ]),
    ...numericalCandidates.flatMap((candidate) => (
      candidate?.qualificationBlockers || []
    )),
  ])].sort());
  const authorIdentity = readiness.researchAuthorIdentityAttestation || {};
  const releaseAttestor = readiness.researchExecutionReleaseAttestor || {};
  const releaseAttestorInspectionCurrent =
    currentReleaseAttestorInspection(releaseAttestor, observedAt);
  const capabilityScope =
    readiness.autonomousResearchCapabilityScopeInspection || {};
  const priorArtTrust =
    capabilityScope.externalCapabilityTrustInspection?.components?.priorArt || {};
  const externalReplayTrust =
    capabilityScope.externalCapabilityTrustInspection?.components?.externalReplay || {};
  const runtimeReproducibilityConfiguration =
    readiness.runtimeImageReproducibilityConfiguration || {};
  const priorArtServiceReady =
    capabilityScope.priorArtServiceConfigurationPinned === true
    && capabilityScope.priorArtServiceFullProductionReady === true
    && priorArtTrust.cryptographicAuthorityReady === true
    && priorArtTrust.identityIndependenceReady === true
    && priorArtTrust.evidenceProfile === 'structured-ranked-deduplicated-v2';
  const externalReplayServiceReady =
    capabilityScope.externalReplayServiceConfigurationPinned === true
    && capabilityScope.externalReplayServiceCrashRecoveryReady === true
    && capabilityScope.externalReplayServiceFullProductionReady === true
    && externalReplayTrust.cryptographicAuthorityReady === true
    && externalReplayTrust.identityIndependenceReady === true;
  const runtimeReproducibilityReady =
    readiness.runtimeImageReproducibilityReady === true
    && runtimeReproducibilityConfiguration.configurationPinned === true
    && runtimeReproducibilityConfiguration.fullProductionReady === true;
  const qualificationBlockers = Object.freeze([...new Set([
    ...readinessQualificationBlockers,
    ...(priorArtServiceReady
      ? [] : ['prior_art_service_full_production_not_ready']),
    ...(externalReplayServiceReady
      ? [] : ['external_replay_service_full_production_not_ready']),
    ...(runtimeReproducibilityReady
      ? [] : ['runtime_reproducibility_full_production_not_ready']),
  ])].sort());
  const authorIdentityReady = readiness.researchAuthorIdentityFullProductionReady === true
    && authorIdentity.fullProductionReady === true
    && authorIdentity.cryptographicAuthorityReady === true
    && authorIdentity.configurationVersion === 2
    && authorIdentity.stablePolicyPinned === true;
  const releaseAttestorReady =
    readiness.researchExecutionReleaseAttestorProductionReady === true
    && readiness.liveReleaseAttestorVerificationRequested === true
    && releaseAttestorInspectionCurrent
    && releaseAttestor.fullProductionReady === true
    && releaseAttestor.backendKind === 'external-kms-command'
    && releaseAttestor.hardwareProtected === true
    && releaseAttestor.privateKeyExportable === false
    && releaseAttestor.externalSignerProcess === true
    && releaseAttestor.configurationPinned === true
    && releaseAttestor.configurationIdentityProfile
      === 'stable-kms-authority-policy-and-rotating-bundle-v3'
    && releaseAttestor.kmsHardwareAuthorityAttestationReady === true
    && releaseAttestor.kmsHardwareAuthorityIndependent === true
    && SHA256.test(String(
      releaseAttestor.kmsHardwareAuthorityAttestationInspectionHash || '',
    ))
    && SHA256.test(String(
      releaseAttestor.kmsHardwareAuthorityVerificationReceiptHash || '',
    ))
    && releaseAttestor.independentBackendProbeVerified === true
    && releaseAttestor.activeSignerChallengeVerified === true;
  const identityAndAttestationBlockers = Object.freeze([...new Set([
    ...identityBlockers,
    ...(authorIdentityReady
      ? [] : ['author_identity_external_cryptographic_attestation_required']),
    ...(releaseAttestorReady
      ? [] : ['release_attestor_hardware_kms_required']),
    ...(releaseAttestorInspectionCurrent
      && readiness.liveReleaseAttestorVerificationRequested === true
      ? [] : ['research_execution_release_attestor_fresh_live_inspection_required']),
    ...(releaseAttestor.externalSignerProcess === true
      ? [] : ['research_execution_release_attestor_production_backend_required']),
    ...(releaseAttestor.configurationPinned === true
      ? [] : ['research_execution_release_attestor_config_pin_required']),
    ...(releaseAttestor.kmsHardwareAuthorityAttestationReady === true
      && releaseAttestor.kmsHardwareAuthorityIndependent === true
      ? [] : [
        'research_execution_release_attestor_kms_hardware_authority_attestation_required',
      ]),
    ...(releaseAttestor.independentBackendProbeVerified === true
      ? [] : ['research_execution_release_attestor_independent_backend_probe_required']),
    ...(releaseAttestor.activeSignerChallengeVerified === true
      ? [] : ['research_execution_release_attestor_active_signer_challenge_required']),
  ])].sort());
  const externalQualificationReady = qualificationBlockers.length === 0
    && priorArtServiceReady
    && externalReplayServiceReady
    && runtimeReproducibilityReady;
  const stateSafetyReady = readiness.autonomousStateDatabaseInventoryReady === true
    && readiness.autonomousStateOnlineAntiRollbackReady === true
    && readiness.autonomousStateLatestValidRestoreDrillReady === true;
  const submissionReady = readiness.autonomousSubmissionDispatcherReady === true;
  const fullyProductionReady = readiness.fullyAutonomousResearchSystemReady === true
    && repositoryAssetInspection.fullyExternalized === true
    && readiness.dynamicFormalProjectClosureReady === true
    && authorIdentityReady
    && releaseAttestorReady
    && externalQualificationReady
    && stateSafetyReady
    && submissionReady
    && numericalReady;
  const payload = Object.freeze({
    version: 1,
    kind: 'HeptaPaperProductionDependencyHandoff',
    status: fullyProductionReady
      ? 'hepta_paper_production_dependencies_ready'
      : 'hepta_paper_external_authority_inputs_required',
    ready: fullyProductionReady,
    fullyProductionReady,
    priorityOrder: Object.freeze([
      'author-identity-external-attestation',
      'release-attestor-hardware-kms',
      'prior-art-and-external-replay',
      'runtime-image-reproducibility',
      'advanced-numerical-qualification',
      'submission-portal-binding-and-independent-canary',
    ]),
    readinessReportHash: hashRecord('AutomationPlaneStatus', readiness),
    deploymentEnvironment: Object.freeze({
      observed: Boolean(readiness.deploymentEnvironmentInspection),
      status: readiness.deploymentEnvironmentInspection?.status || null,
      source: readiness.deploymentEnvironmentInspection?.source || null,
      filePath: readiness.deploymentEnvironmentInspection?.filePath || null,
      fileHash: readiness.deploymentEnvironmentInspection?.fileHash || null,
      loadedKeys: Object.freeze([
        ...(readiness.deploymentEnvironmentInspection?.loadedKeys || []),
      ]),
      credentialMaterialLoaded:
        readiness.deploymentEnvironmentInspection?.credentialMaterialLoaded === true,
      inspectionHash:
        readiness.deploymentEnvironmentInspection
          ?.automationReadinessDeploymentEnvironmentInspectionHash || null,
    }),
    repositoryAssetInspectionHash:
      hashRecord('RepositoryAssetExternalizationInspection', repositoryAssetInspection),
    assets: Object.freeze({
      ready: repositoryAssetInspection.fullyExternalized === true,
      status: repositoryAssetInspection.status,
      entries: Object.freeze(repositoryAssetManifest.assets.map((asset) => (
        externalizedAsset(asset, repositoryAssetInspection)
      ))),
      blockers: Object.freeze([
        ...(repositoryAssetInspection.integrityBlockers || []),
        ...(repositoryAssetInspection.externalizationBlockers || []),
      ]),
    }),
    formalClosure: Object.freeze({
      ready: readiness.dynamicFormalProjectClosureReady === true,
      status: readiness.dynamicFormalProjectClosure?.status || null,
      toolchain: readiness.dynamicFormalProjectClosure?.toolchain || null,
      projectRoot: readiness.dynamicFormalProjectClosure?.projectRoot || null,
      closureHash:
        readiness.dynamicFormalProjectClosure?.formalProjectClosureHash || null,
      productionMathlibReleaseIdentityHash:
        readiness.dynamicFormalProjectClosure
          ?.productionMathlibReleaseIdentityHash || null,
      productionMathlibBuildAuthorityHash:
        readiness.dynamicFormalProjectClosure
          ?.productionMathlibBuildAuthorityHash || null,
      executableProbeReceiptHash:
        readiness.dynamicFormalProjectClosure
          ?.formalSandboxProbeReceiptHash || null,
      blockers: Object.freeze(readiness.dynamicFormalProjectClosure?.blockers || []),
    }),
    independentIdentityAndAttestation: Object.freeze({
      ready: authorIdentityReady && releaseAttestorReady,
      requiredEnvironmentVariables: Object.freeze([
        'HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG',
        'HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH',
        'HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG',
        'HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH',
      ]),
      requiredInvariants: Object.freeze([
        'author-identity-is-signed-by-a-pinned-external-platform-identity-authority',
        'author-identity-uses-a-stable-v2-policy-pin-with-rotating-signed-attestations',
        'author-and-reviewer-use-distinct-role-principal-ids',
        'reviewer-uses-fresh-ephemeral-no-resume-session',
        'reviewer-cannot-inherit-author-context',
        'reviewer-reads-only-the-frozen-artifact-bundle',
        'release-attestor-uses-hardware-protected-nonexportable-external-kms-hsm',
        'release-attestor-resolved-configuration-identity-is-out-of-band-pinned',
        'release-attestor-pin-binds-stable-kms-policy-while-signed-bundles-rotate',
        'release-attestor-hardware-properties-are-signed-by-an-independent-kms-control-plane-authority',
        'release-attestor-independent-backend-probe-passes',
        'release-attestor-live-signing-challenge-passes',
      ]),
      currentAuthorIdentity: Object.freeze({
        status: authorIdentity.status || null,
        ready: authorIdentity.ready === true,
        identityMode: authorIdentity.identityMode || null,
        cryptographicAuthorityReady:
          authorIdentity.cryptographicAuthorityReady === true,
        sessionIsolationReady: authorIdentity.sessionIsolationReady === true,
        configurationPinned: authorIdentity.configurationPinned === true,
        stablePolicyPinned: authorIdentity.stablePolicyPinned === true,
        configurationVersion: authorIdentity.configurationVersion || null,
        configurationHash: authorIdentity.configurationHash || null,
        subjectHash: authorIdentity.subjectHash || null,
        trustSetHash: authorIdentity.trustSetHash || null,
        signatureVerificationPolicyHash:
          authorIdentity.signatureVerificationPolicyHash || null,
        fullProductionReady: authorIdentity.fullProductionReady === true,
      }),
      currentAttestor: Object.freeze({
        inspectionCurrent: releaseAttestorInspectionCurrent,
        inspectedAt: releaseAttestor.inspectedAt || null,
        status: releaseAttestor.status || null,
        productionStatus:
          releaseAttestor.productionStatus || null,
        fullProductionStatus: releaseAttestor.fullProductionStatus || null,
        boundedProductionReady: releaseAttestor.productionReady === true,
        fullProductionReady: releaseAttestor.fullProductionReady === true,
        configurationPinned: releaseAttestor.configurationPinned === true,
        configurationFileHash:
          releaseAttestor.configurationFileHash || null,
        configurationIdentityHash:
          releaseAttestor.configurationIdentityHash || null,
        configurationIdentityProfile:
          releaseAttestor.configurationIdentityProfile || null,
        kmsHardwareAuthorityAttestationReady:
          releaseAttestor.kmsHardwareAuthorityAttestationReady === true,
        kmsHardwareAuthorityIndependent:
          releaseAttestor.kmsHardwareAuthorityIndependent === true,
        kmsHardwareAuthorityAttestationInspectionHash:
          releaseAttestor.kmsHardwareAuthorityAttestationInspectionHash || null,
        kmsHardwareAuthorityAttestationBundleHash:
          releaseAttestor.kmsHardwareAuthorityAttestationBundleHash || null,
        kmsHardwareAuthorityAttestationSubjectHash:
          releaseAttestor.kmsHardwareAuthorityAttestationSubjectHash || null,
        kmsHardwareAuthorityTrustStoreHash:
          releaseAttestor.kmsHardwareAuthorityTrustStoreHash || null,
        kmsHardwareAuthorityVerificationReceiptHash:
          releaseAttestor.kmsHardwareAuthorityVerificationReceiptHash || null,
        kmsHardwareAuthorityAttestedAt:
          releaseAttestor.kmsHardwareAuthorityAttestedAt || null,
        kmsHardwareAuthorityExpiresAt:
          releaseAttestor.kmsHardwareAuthorityExpiresAt || null,
        kmsProvider: releaseAttestor.kmsProvider || null,
        kmsProviderAccountIdentityHash:
          releaseAttestor.kmsProviderAccountIdentityHash || null,
        kmsKeyResourceIdentityHash:
          releaseAttestor.kmsKeyResourceIdentityHash || null,
        kmsCredentialGenerationIdentityHash:
          releaseAttestor.kmsCredentialGenerationIdentityHash || null,
        backendKind: releaseAttestor.backendKind || null,
        assuranceProfile:
          releaseAttestor.signerBackendAssuranceProfile || null,
        threatBoundary:
          releaseAttestor.signerBackendThreatBoundary || null,
        hardwareProtected:
          releaseAttestor.hardwareProtected === true,
        privateKeyExportable:
          releaseAttestor.privateKeyExportable !== false,
        externalSignerProcess:
          releaseAttestor.externalSignerProcess === true,
        independentBackendProbeVerified:
          releaseAttestor.independentBackendProbeVerified === true,
        activeSignerChallengeVerified:
          releaseAttestor.activeSignerChallengeVerified === true,
      }),
      blockers: identityAndAttestationBlockers,
    }),
    externalQualification: Object.freeze({
      ready: externalQualificationReady,
      requiredEnvironmentVariables: Object.freeze([
        'HEPTA_PRIOR_ART_SERVICE_CONFIG',
        'HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH',
        'HEPTA_PRIOR_ART_SERVICE_TOKEN_FILE',
        'HEPTA_EXTERNAL_REPLAY_CONFIG',
        'HEPTA_EXTERNAL_REPLAY_CONFIG_HASH',
        'HEPTA_EXTERNAL_REPLAY_SERVICE_TOKEN_FILE',
        'HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG',
        'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG',
        'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH',
      ]),
      requiredInvariants: Object.freeze([
        'prior-art-and-replay-configurations-match-out-of-band-sha256-pins',
        'prior-art-and-replay-principals-are-external-to-the-research-author',
        'external-qualification-receipts-are-current-and-content-bound',
        'external-replay-v4-signed-lookup-resume-recovery-is-ready',
        'runtime-images-are-registered-by-immutable-digest',
        'runtime-reproducibility-configuration-matches-out-of-band-identity-sha256-pin',
        'runtime-reproducibility-principal-passes-provider-canary',
      ]),
      currentPriorArt: Object.freeze({
        configured: capabilityScope.priorArtServiceConfigured === true,
        configurationPinned:
          capabilityScope.priorArtServiceConfigurationPinned === true,
        fullProductionReady:
          capabilityScope.priorArtServiceFullProductionReady === true,
        configurationHash:
          capabilityScope.priorArtServiceConfigurationHash || null,
        cryptographicAuthorityReady:
          priorArtTrust.cryptographicAuthorityReady === true,
        identityIndependenceReady:
          priorArtTrust.identityIndependenceReady === true,
        evidenceProfile: priorArtTrust.evidenceProfile || null,
        blockers: Object.freeze(priorArtTrust.blockers || []),
      }),
      currentExternalReplay: Object.freeze({
        configured: capabilityScope.externalReplayServiceConfigured === true,
        configurationPinned:
          capabilityScope.externalReplayServiceConfigurationPinned === true,
        crashRecoveryReady:
          capabilityScope.externalReplayServiceCrashRecoveryReady === true,
        fullProductionReady:
          capabilityScope.externalReplayServiceFullProductionReady === true,
        configurationHash:
          capabilityScope.externalResearchReplayConfigurationHash || null,
        cryptographicAuthorityReady:
          externalReplayTrust.cryptographicAuthorityReady === true,
        identityIndependenceReady:
          externalReplayTrust.identityIndependenceReady === true,
        blockers: Object.freeze(externalReplayTrust.blockers || []),
      }),
      runtimeImageReproducibility: Object.freeze({
        status: readiness.runtimeImageReproducibility?.status || null,
        configured: runtimeReproducibilityConfiguration.configured === true,
        boundedReady: runtimeReproducibilityConfiguration.boundedReady === true,
        configurationPinned:
          runtimeReproducibilityConfiguration.configurationPinned === true,
        fullProductionReady:
          runtimeReproducibilityConfiguration.fullProductionReady === true,
        configurationIdentityHash:
          runtimeReproducibilityConfiguration.configurationIdentityHash || null,
        trustIdentityHash:
          runtimeReproducibilityConfiguration.trustIdentityHash || null,
        receiptHash: readiness.runtimeImageReproducibility?.receiptHash || null,
        activePluginScopeHash:
          readiness.runtimeImageReproducibility
            ?.runtimeImageReproducibilityActivePluginScopeHash || null,
        blockers: Object.freeze(
          readiness.runtimeImageReproducibility?.blockers || [],
        ),
      }),
      blockers: qualificationBlockers,
    }),
    stateSafety: Object.freeze({
      ready: stateSafetyReady,
      requiredDatabaseRoleCount: REQUIRED_STATE_DATABASE_ROLES.length,
      coveredDatabaseRoles: Object.freeze([...coveredStateRoles].sort()),
      missingDatabaseRoles: Object.freeze(missingStateRoles),
      freshMachineIntakeGenesisMode: 'root-owned-configuration',
      freshMachineIntakeGenesisDocuments: Object.freeze([
        '/etc/hepta-paper/intake/config.json',
        '/etc/hepta-paper/intake/topic-producer-profile.json',
      ]),
      fixedMachineIntakeRotationAuthorityDocuments: Object.freeze([
        '/etc/hepta-paper/authority-rotation/AUTHORITY_TRUST_STORE.json',
        '/etc/hepta-paper/authority-rotation/OWNER_TRUST_STORE.json',
        '/etc/hepta-paper/authority-rotation/AUTONOMOUS_RESEARCH_INTAKE_AUTHORITY_BOOTSTRAP.json',
      ]),
      requiredEnvironmentVariables: Object.freeze([
        'HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG',
        'HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG',
        'HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG',
      ]),
      executionSequence: Object.freeze([
        'automation:autonomous-research-state-provision -- --action plan',
        'automation:autonomous-research-state-provision -- --action execute --execute --plan-id sha256:...',
        'automation:autonomous-research-online-schema-transition -- --action plan',
        'automation:autonomous-research-online-schema-transition -- --action execute --execute --transition-id sha256:...',
        'automation:autonomous-research-state-backup -- --action reconcile-and-renew',
      ]),
      inventoryHash: state.inventory?.inventoryHash || null,
      writerManifestHash: state.writerManifestHash || null,
      blockers: Object.freeze(state.blockers || []),
    }),
    submission: Object.freeze({
      ready: submissionReady,
      handoffReady: readiness.autonomousSubmissionHandoffReady === true,
      requiredEnvironmentVariables: Object.freeze([
        'HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG',
        'HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH',
        'HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH',
        'HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG',
        'HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG',
        'HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH',
        'HEPTA_SUBMISSION_DISPATCHER_IDENTITY_CONFIG_PATH',
        'HEPTA_SUBMISSION_DISPATCHER_CYCLE_SIGNING_CONFIG',
      ]),
      requiredInvariants: Object.freeze([
        'research-process-never-receives-portal-credential',
        'resident-dispatcher-uses-distinct-principal',
        'portal-descriptor-and-private-config-bind-the-same-configuration-hash',
        'portal-descriptor-matches-its-out-of-band-sha256-pin',
        'portal-and-dispatcher-cycle-use-distinct-signing-subjects-and-public-keys',
        'no-pending-challenge-means-no-external-submission-action',
        'independent-live-portal-canary-verifies-the-dispatcher-cycle',
      ]),
      readiness: Object.freeze({
        status:
          readiness.autonomousSubmissionDispatcherReadiness?.status || null,
        planHash:
          readiness.autonomousSubmissionDispatcherReadiness?.planHash || null,
        challengeHash:
          readiness.autonomousSubmissionDispatcherReadiness?.challengeHash || null,
        cycleReceiptHash:
          readiness.autonomousSubmissionDispatcherReadiness?.cycleReceiptHash || null,
        portalDescriptorHash:
          readiness.autonomousSubmissionDispatcherReadiness
            ?.portalDescriptorHash || null,
        portalConfigurationIdentityPinned:
          readiness.autonomousSubmissionDispatcherReadiness
            ?.portalConfigurationIdentityPinned === true,
        portalDescriptorPinned:
          readiness.autonomousSubmissionDispatcherReadiness
            ?.portalDescriptorPinned === true,
        portalFullProductionReady:
          readiness.autonomousSubmissionDispatcherReadiness
            ?.portalFullProductionReady === true,
        livePortalCanaryAuthorityIndependentFromDispatcher:
          readiness.autonomousSubmissionDispatcherReadiness
            ?.livePortalCanaryAuthorityIndependentFromDispatcher === true,
        livePortalCanaryIndependentVerificationReceiptHash:
          readiness.autonomousSubmissionDispatcherReadiness
            ?.livePortalCanaryIndependentVerificationReceiptHash || null,
      }),
      blockers: Object.freeze(
        readiness.autonomousSubmissionDispatcherReadiness?.blockers || [],
      ),
    }),
    advancedNumericalQualification: Object.freeze({
      ready: numericalReady,
      requiredRoles: Object.freeze([
        'advanced_numerical_plugin_authority',
        'advanced_numerical_oracle_authority',
        'advanced_numerical_replay_authority',
        'advanced_numerical_uncertainty_reviewer',
        'advanced_numerical_scientific_reviewer',
      ]),
      requiredInvariants: Object.freeze([
        'all-five-authority-subjects-are-distinct',
        'all-five-authority-organizations-and-public-keys-are-distinct',
        'registry-matches-out-of-band-sha256-pin',
        'runtime-configuration-pins-every-trust-and-evidence-document',
        'five-role-specific-evidence-receipts-exist-and-are-cryptographically-verified',
        'reference-and-replay-process-receipts-are-distinct',
        'reference-and-replay-process-identities-are-distinct',
        'reference-and-replay-result-hashes-are-identical',
        'qualification-statement-is-expiring-and-content-bound',
      ]),
      requiredEnvironmentVariables: Object.freeze([
        'HEPTA_ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_REGISTRY',
        'HEPTA_ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_REGISTRY_HASH',
      ]),
      requiredAnalysisFamilies:
        REQUIRED_ADVANCED_NUMERICAL_REFERENCE_FAMILIES,
      candidates: Object.freeze(numericalCandidates),
      blockers: numericalBlockers,
    }),
    selfIssuanceForbidden: true,
    credentialMaterialIncluded: false,
  });
  return Object.freeze({
    ...payload,
    heptaPaperProductionDependencyHandoffHash: hashRecord(
      'HeptaPaperProductionDependencyHandoff',
      payload,
    ),
  });
}

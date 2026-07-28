import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

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
  const qualificationBlockers = selectedBlockers(blockers, [
    'prior_art', 'external_replay', 'generic_content_qualification',
    'external_qualification', 'runtime_reproducibility',
  ]);
  const numericalReady = numericalCandidates.length > 0
    && numericalCandidates.every((candidate) => candidate.productionQualified === true);
  const payload = Object.freeze({
    version: 1,
    kind: 'HeptaPaperProductionDependencyHandoff',
    status: readiness.fullyAutonomousResearchSystemReady === true && numericalReady
      ? 'hepta_paper_production_dependencies_ready'
      : 'hepta_paper_external_authority_inputs_required',
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
      ready: identityBlockers.length === 0
        && readiness.researchExecutionReleaseAttestorProductionReady === true,
      requiredEnvironmentVariables: Object.freeze([
        'HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG',
        'HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH',
        'HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG',
        'HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG',
      ]),
      requiredInvariants: Object.freeze([
        'author-and-reviewer-use-distinct-external-principal-subjects',
        'reviewer-pool-excludes-author-origin-subjects',
        'release-attestor-uses-production-kms-or-hsm-external-signer',
        'release-attestor-independent-backend-probe-passes',
        'release-attestor-live-signing-challenge-passes',
      ]),
      currentAttestor: Object.freeze({
        status: readiness.researchExecutionReleaseAttestor?.status || null,
        productionStatus:
          readiness.researchExecutionReleaseAttestor?.productionStatus || null,
        backendKind: readiness.researchExecutionReleaseAttestor?.backendKind || null,
        hardwareProtected:
          readiness.researchExecutionReleaseAttestor?.hardwareProtected === true,
        externalSignerProcess:
          readiness.researchExecutionReleaseAttestor?.externalSignerProcess === true,
        independentBackendProbeVerified:
          readiness.researchExecutionReleaseAttestor
            ?.independentBackendProbeVerified === true,
        activeSignerChallengeVerified:
          readiness.researchExecutionReleaseAttestor
            ?.activeSignerChallengeVerified === true,
      }),
      blockers: identityBlockers,
    }),
    externalQualification: Object.freeze({
      ready: qualificationBlockers.length === 0
        && readiness.runtimeImageReproducibilityReady === true,
      requiredEnvironmentVariables: Object.freeze([
        'HEPTA_PRIOR_ART_SERVICE_CONFIG',
        'HEPTA_PRIOR_ART_SERVICE_TOKEN_FILE',
        'HEPTA_EXTERNAL_REPLAY_CONFIG',
        'HEPTA_EXTERNAL_REPLAY_SERVICE_TOKEN_FILE',
        'HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG',
        'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG',
        'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT',
      ]),
      requiredInvariants: Object.freeze([
        'prior-art-and-replay-principals-are-external-to-the-research-author',
        'external-qualification-receipts-are-current-and-content-bound',
        'runtime-images-are-registered-by-immutable-digest',
        'runtime-reproducibility-principal-passes-provider-canary',
      ]),
      runtimeImageReproducibility: Object.freeze({
        status: readiness.runtimeImageReproducibility?.status || null,
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
      ready: readiness.autonomousStateDatabaseInventoryReady === true
        && readiness.autonomousStateOnlineAntiRollbackReady === true
        && readiness.autonomousStateLatestValidRestoreDrillReady === true,
      requiredDatabaseRoleCount: REQUIRED_STATE_DATABASE_ROLES.length,
      coveredDatabaseRoles: Object.freeze([...coveredStateRoles].sort()),
      missingDatabaseRoles: Object.freeze(missingStateRoles),
      fixedMachineIntakeAuthorityDocuments: Object.freeze([
        '/etc/hepta-paper/authority-rotation/AUTHORITY_TRUST_STORE.json',
        '/etc/hepta-paper/authority-rotation/OWNER_TRUST_STORE.json',
        '/etc/hepta-paper/authority-rotation/AUTONOMOUS_RESEARCH_INTAKE_AUTHORITY_BOOTSTRAP.json',
        '/etc/hepta-paper/authority-rotation/AUTONOMOUS_RESEARCH_INTAKE_AUTHORITY_GENESIS.json',
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
      ready: readiness.autonomousSubmissionDispatcherReady === true,
      handoffReady: readiness.autonomousSubmissionHandoffReady === true,
      requiredEnvironmentVariables: Object.freeze([
        'HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG',
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
        'reference-and-replay-process-receipts-are-distinct',
        'reference-and-replay-result-hashes-are-identical',
        'qualification-statement-is-expiring-and-content-bound',
      ]),
      requiredEnvironmentVariables: Object.freeze([
        'HEPTA_ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_REGISTRY',
      ]),
      candidates: Object.freeze(numericalCandidates),
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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProductionDependencyHandoff,
} from '../../paper-application/automation/production-dependency-handoff.mjs';
import {
  productionReleaseInspection,
} from './support/external-qualification-release-inspection-builder.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = '2026-07-15T12:30:30.000Z';

function fixture({ ready = false } = {}) {
  const coveredRoles = ready ? [
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
  ] : ['native-store', 'resident-instance', 'submission-handoff', 'supervisor-state'];
  const readiness = {
    version: 2,
    kind: 'AutomationPlaneStatus',
    fullyAutonomousResearchSystemReady: ready,
    fullyAutonomousResearchSystemBlockers: ready ? [] : [
      'research_author_configuration_not_ready',
      'formal_review_independent_principal_not_ready',
      'research_execution_release_attestor_not_ready',
      'independent_hypothesis_prior_art_qualification_not_ready',
      'autonomous_research_external_replay_not_ready',
    ],
    dynamicFormalProjectClosureReady: true,
    dynamicFormalProjectClosure: {
      status: 'dynamic_formal_project_closure_ready',
      toolchain: 'leanprover/lean4:v4.30.0',
      projectRoot: '/srv/hepta-paper/formal/mathlib-project',
      formalProjectClosureHash: H('1'),
      productionMathlibReleaseIdentityHash: H('2'),
      productionMathlibBuildAuthorityHash: H('3'),
      formalSandboxProbeReceiptHash: H('4'),
      blockers: [],
    },
    researchAuthorIdentityAttestationReady: true,
    researchAuthorIdentityCryptographicAuthorityReady: ready,
    researchAuthorIdentityFullProductionReady: ready,
    researchAuthorIdentityAttestation: {
      status: ready
        ? 'autonomous_research_author_identity_verified'
        : 'autonomous_research_author_session_identity_verified',
      ready: true,
      identityMode: ready
        ? 'external-cryptographic-attestation'
        : 'fresh-ephemeral-session-policy',
      cryptographicAuthorityReady: ready,
      sessionIsolationReady: !ready,
      configurationPinned: true,
      configurationVersion: ready ? 2 : 1,
      stablePolicyPinned: ready,
      configurationHash: H('0'),
      subjectHash: H('1'),
      trustSetHash: H('2'),
      signatureVerificationPolicyHash: H('3'),
      fullProductionReady: ready,
    },
    researchExecutionReleaseAttestorProductionReady: ready,
    liveReleaseAttestorVerificationRequested: ready,
    researchExecutionReleaseAttestor: {
      status: ready ? 'research_execution_release_attestor_ready'
        : 'research_execution_release_attestor_blocked',
      productionStatus: ready ? 'research_execution_release_attestor_production_ready'
        : 'research_execution_release_attestor_production_blocked',
      fullProductionStatus: ready
        ? 'research_execution_release_attestor_full_production_ready'
        : 'research_execution_release_attestor_full_production_blocked',
      productionReady: ready,
      fullProductionReady: ready,
      configurationPinned: ready,
      configurationFileHash: ready ? H('a') : null,
      configurationIdentityHash: ready ? H('b') : null,
      kmsHardwareAuthorityAttestationReady: ready,
      kmsHardwareAuthorityIndependent: ready,
      kmsHardwareAuthorityAttestationInspectionHash: ready ? H('c') : null,
      kmsHardwareAuthorityVerificationReceiptHash: ready ? H('d') : null,
      kmsHardwareAuthorityAttestationBundleHash: ready ? H('e') : null,
      kmsHardwareAuthorityAttestationSubjectHash: ready ? H('f') : null,
      kmsHardwareAuthorityTrustStoreHash: ready ? H('10') : null,
      kmsProvider: ready ? 'external-kms-test' : null,
      kmsProviderAccountIdentityHash: ready ? H('11') : null,
      kmsKeyResourceIdentityHash: ready ? H('12') : null,
      kmsCredentialGenerationIdentityHash: ready ? H('13') : null,
      backendKind: ready ? 'external-kms-command' : 'dedicated-uid-command',
      hardwareProtected: ready,
      privateKeyExportable: !ready,
      externalSignerProcess: ready,
      independentBackendProbeVerified: ready,
      activeSignerChallengeVerified: ready,
    },
    autonomousResearchCapabilityScopeInspection: {
      priorArtServiceConfigured: ready,
      priorArtServiceConfigurationPinned: ready,
      priorArtServiceFullProductionReady: ready,
      priorArtServiceConfigurationHash: ready ? H('4') : null,
      externalReplayServiceConfigured: ready,
      externalReplayServiceConfigurationPinned: ready,
      externalReplayServiceCrashRecoveryReady: ready,
      externalReplayServiceFullProductionReady: ready,
      externalResearchReplayConfigurationHash: ready ? H('5') : null,
      externalCapabilityTrustInspection: {
        components: {
          priorArt: {
            cryptographicAuthorityReady: ready,
            identityIndependenceReady: ready,
            evidenceProfile: ready ? 'structured-ranked-deduplicated-v2' : null,
            blockers: ready ? [] : ['autonomous_research_prior_art_configuration_not_pinned'],
          },
          externalReplay: {
            cryptographicAuthorityReady: ready,
            identityIndependenceReady: ready,
            blockers: ready
              ? [] : ['autonomous_research_external_replay_crash_recovery_not_ready'],
          },
        },
      },
    },
    runtimeImageReproducibilityReady: ready,
    runtimeImageReproducibility: {
      status: ready ? 'runtime_image_reproducibility_ready'
        : 'runtime_image_reproducibility_blocked',
      receiptHash: ready ? H('5') : null,
      runtimeImageReproducibilityActivePluginScopeHash: H('6'),
      blockers: ready ? [] : ['runtime_reproducibility_configuration_path_required'],
    },
    runtimeImageReproducibilityConfiguration: {
      status: ready ? 'runtime_image_reproducibility_configuration_ready'
        : 'runtime_image_reproducibility_configuration_blocked',
      ready,
      configured: ready,
      boundedReady: ready,
      configurationPinned: ready,
      fullProductionReady: ready,
      configurationIdentityHash: ready ? H('6') : null,
      trustIdentityHash: ready ? H('7') : null,
      blockers: ready ? [] : ['runtime_reproducibility_configuration_path_required'],
    },
    autonomousStateDatabaseInventoryReady: ready,
    autonomousStateOnlineAntiRollbackReady: ready,
    autonomousStateLatestValidRestoreDrillReady: ready,
    autonomousStateSafety: {
      inventoryCoveredRoles: coveredRoles,
      inventory: { inventoryHash: ready ? H('7') : null },
      writerManifestHash: H('8'),
      blockers: ready ? [] : ['autonomous_research_state_database_inventory_10_of_10_required'],
    },
    autonomousSubmissionDispatcherReady: ready,
    autonomousSubmissionHandoffReady: true,
    autonomousSubmissionDispatcherReadiness: {
      version: 1,
      kind: 'AutonomousSubmissionDispatcherReadinessInspection',
      status: ready ? 'autonomous_submission_dispatcher_ready'
        : 'autonomous_submission_dispatcher_blocked',
      ready,
      handoffReady: ready,
      planHash: ready ? H('9') : null,
      challengeHash: ready ? H('a') : null,
      cycleReceiptHash: ready ? H('b') : null,
      dispatcherPrincipalId: ready ? 'dispatcher-principal' : null,
      signatureVerified: ready,
      portalId: ready ? 'portal-one' : null,
      portalConfigurationHash: ready ? H('e') : null,
      portalDescriptorHash: ready ? H('c') : null,
      portalBindingVerified: ready,
      livePortalCanaryVerified: ready,
      portalConfigurationIdentityPinned: ready,
      portalDescriptorPinned: ready,
      portalFullProductionReady: ready,
      livePortalCanaryAuthorityIndependentFromDispatcher: ready,
      livePortalCanaryCycleVerificationReceiptHash: ready ? H('f') : null,
      livePortalCanaryIndependentVerificationReceiptHash: ready ? H('d') : null,
      signedAt: ready ? '2026-07-15T12:29:30.000Z' : null,
      expiresAt: ready ? '2026-07-15T12:40:30.000Z' : null,
      blockers: ready ? [] : ['autonomous_submission_dispatcher_challenge_missing'],
    },
  };
  if (ready) {
    const activeReleaseKey = Object.freeze({
      keyId: 'release-key-current',
      keyVersion: 'v2',
      subjectId: 'release-attestor',
      organization: 'Research Release Office',
      role: 'research_execution_release_attestor',
      algorithm: 'ed25519',
      status: 'active',
      publicKeySpkiHash: H('a'),
      effectiveFrom: '2026-07-10T00:00:00.000Z',
      expiresAt: '2026-09-01T00:00:00.000Z',
      revokedAt: null,
    });
    readiness.researchExecutionReleaseAttestor = productionReleaseInspection({
      trustedKeys: [activeReleaseKey],
      activeKey: activeReleaseKey,
    });
  }
  const assetManifest = {
    version: 1,
    kind: 'RepositoryAssetExternalizationManifest',
    assets: [{
      assetId: 'core-reference',
      sourcePath: 'core',
      expectedIdentitySha256: H('e'),
      externalReference: {
        kind: 'immutable-release',
        transport: 'git-submodule',
        repositoryUrl: 'https://example.invalid/core.git',
        pinnedCommit: 'f'.repeat(40),
        digest: H('e'),
        restoreDrillReceipt: {
          repositoryAssetExternalRestoreDrillReceiptHash: H('f'),
        },
      },
    }],
  };
  const assetInspection = {
    version: 1,
    kind: 'RepositoryAssetExternalizationInspection',
    status: 'repository_assets_externalized',
    fullyExternalized: true,
    assets: [{
      assetId: 'core-reference',
      externalized: true,
      observedIdentitySha256: H('e'),
    }],
    integrityBlockers: [],
    externalizationBlockers: [],
  };
  const qualificationRoles = [
    'advanced_numerical_oracle_authority',
    'advanced_numerical_replay_authority',
    'advanced_numerical_scientific_reviewer',
    'advanced_numerical_uncertainty_reviewer',
  ];
  const candidates = [
    'linear-algebra',
    'monte-carlo',
    'optimization',
  ].map((analysisFamily) => {
    const identity = `-${analysisFamily}`;
    return {
      pluginId: `hepta.reference.${analysisFamily}`,
      pluginVersion: '1.0.0',
      analysisFamily,
      status: ready ? 'reference_candidate_full_production_qualified'
        : 'reference_candidate_unqualified',
      productionQualified: ready,
      fullProductionReady: ready,
      registryConfigured: ready,
      registryPinned: ready,
      registryHash: ready ? H('1') : null,
      runtimeConfigurationPinned: ready,
      runtimeConfigurationHash: ready ? H('2') : null,
      dependentDocumentsPinned: ready,
      entrypoint: 'worker.py',
      entrypointHash: ready ? H('3') : null,
      sourceMerkleHash: ready ? H('4') : null,
      sourceWorkspaceManifestHash: ready ? H('5') : null,
      candidateManifestHash: ready ? H('6') : null,
      runtimeExecutableHash: ready ? H('7') : null,
      runtimePackageClosureHash: ready ? H('8') : null,
      signedBundleHash: ready ? H('9') : null,
      qualificationStatementHash: ready ? H('a') : null,
      qualificationEvidenceBundleHash: ready ? H('b') : null,
      qualificationInspectionHash: ready ? H('c') : null,
      qualificationExpiresAt: ready ? '2026-07-15T12:40:30.000Z' : null,
      pluginAuthoritySubjectIds: ready ? [`plugin${identity}`] : [],
      pluginAuthorityOrganizations: ready ? [`plugin-org${identity}`] : [],
      pluginAuthorityPublicKeySpkiHashes: ready ? [H('d')] : [],
      qualificationAuthoritySubjectIds: ready ? [
        `oracle${identity}`,
        `replay${identity}`,
        `scientific${identity}`,
        `uncertainty${identity}`,
      ] : [],
      qualificationAuthorityOrganizations: ready ? [
        `oracle-org${identity}`,
        `replay-org${identity}`,
        `scientific-org${identity}`,
        `uncertainty-org${identity}`,
      ] : [],
      qualificationAuthorityPublicKeySpkiHashes: ready
        ? [H('e'), H('f'), H('0'), H('1')] : [],
      qualificationAuthorityRoles: ready ? qualificationRoles : [],
      evidenceReceiptHashes: ready ? {
        independentNumericOracleReceiptHash: H('5'),
        referenceExecutionReceiptHash: H('6'),
        replayExecutionReceiptHash: H('7'),
        scientificReviewReceiptHash: H('8'),
        typedUncertaintyReviewReceiptHash: H('9'),
      } : null,
      referenceExecutionProcessIdentityHash: ready ? H('2') : null,
      replayExecutionProcessIdentityHash: ready ? H('3') : null,
      qualificationResultHash: ready ? H('4') : null,
      qualificationBlockers: ready ? [] : [
        'advanced_numerical_reference_qualification_registry_path_required',
      ],
    };
  });
  return { readiness, assetManifest, assetInspection, candidates };
}

test('production dependency handoff exposes exact external inputs without credentials', () => {
  const value = fixture();
  const handoff = buildProductionDependencyHandoff({
    readiness: value.readiness,
    repositoryAssetInspection: value.assetInspection,
    repositoryAssetManifest: value.assetManifest,
    numericalCandidates: value.candidates,
    observedAt: new Date(NOW),
  });
  assert.equal(handoff.status, 'hepta_paper_external_authority_inputs_required');
  assert.deepEqual(handoff.priorityOrder, [
    'author-identity-external-attestation',
    'release-attestor-hardware-kms',
    'prior-art-and-external-replay',
    'runtime-image-reproducibility',
    'advanced-numerical-qualification',
    'submission-portal-binding-and-independent-canary',
  ]);
  assert.equal(handoff.assets.ready, true);
  assert.equal(handoff.formalClosure.ready, true);
  assert.equal(handoff.deploymentEnvironment.credentialMaterialLoaded, false);
  assert.deepEqual(
    handoff.independentIdentityAndAttestation.requiredEnvironmentVariables,
    [
      'HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG',
      'HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH',
      'HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG',
      'HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH',
    ],
  );
  assert.equal(
    handoff.independentIdentityAndAttestation.requiredInvariants.includes(
      'reviewer-uses-fresh-ephemeral-no-resume-session',
    ),
    true,
  );
  assert.equal(
    handoff.independentIdentityAndAttestation.currentAuthorIdentity
      .cryptographicAuthorityReady,
    false,
  );
  assert.equal(
    handoff.independentIdentityAndAttestation.currentAttestor.fullProductionReady,
    false,
  );
  assert.deepEqual(handoff.submission.requiredEnvironmentVariables, [
    'HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG',
    'HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH',
    'HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH',
    'HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG',
    'HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG',
    'HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH',
    'HEPTA_SUBMISSION_DISPATCHER_IDENTITY_CONFIG_PATH',
    'HEPTA_SUBMISSION_DISPATCHER_CYCLE_SIGNING_CONFIG',
  ]);
  assert.ok(handoff.independentIdentityAndAttestation.blockers.includes(
    'author_identity_external_cryptographic_attestation_required',
  ));
  assert.ok(handoff.independentIdentityAndAttestation.blockers.includes(
    'release_attestor_hardware_kms_required',
  ));
  assert.ok(handoff.externalQualification.requiredEnvironmentVariables.includes(
    'HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH',
  ));
  assert.ok(handoff.externalQualification.requiredEnvironmentVariables.includes(
    'HEPTA_EXTERNAL_REPLAY_CONFIG_HASH',
  ));
  assert.ok(handoff.externalQualification.requiredEnvironmentVariables.includes(
    'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH',
  ));
  assert.ok(
    handoff.advancedNumericalQualification.requiredEnvironmentVariables.includes(
      'HEPTA_ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_REGISTRY_HASH',
    ),
  );
  assert.equal(handoff.advancedNumericalQualification.ready, false);
  assert.ok(handoff.advancedNumericalQualification.blockers.includes(
    'three_advanced_numerical_reference_families_full_production_qualification_required',
  ));
  assert.equal(handoff.externalQualification.requiredEnvironmentVariables.includes(
    'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT',
  ), false);
  assert.ok(handoff.externalQualification.requiredInvariants.includes(
    'external-replay-v4-signed-lookup-resume-recovery-is-ready',
  ));
  assert.equal(handoff.externalQualification.currentPriorArt.fullProductionReady, false);
  assert.equal(
    handoff.externalQualification.currentExternalReplay.crashRecoveryReady,
    false,
  );
  assert.equal(
    handoff.externalQualification.runtimeImageReproducibility.configurationPinned,
    false,
  );
  assert.ok(handoff.externalQualification.blockers.includes(
    'prior_art_service_full_production_not_ready',
  ));
  assert.ok(handoff.externalQualification.blockers.includes(
    'external_replay_service_full_production_not_ready',
  ));
  assert.ok(handoff.externalQualification.blockers.includes(
    'runtime_reproducibility_full_production_not_ready',
  ));
  assert.deepEqual(handoff.stateSafety.missingDatabaseRoles, [
    'external-qualification',
    'full-research-qualification-publication',
    'machine-intake',
    'runtime-reproducibility-publication',
    'runtime-reproducibility-refresh',
    'topic-producer',
  ]);
  assert.equal(handoff.selfIssuanceForbidden, true);
  assert.equal(handoff.credentialMaterialIncluded, false);
  assert.doesNotMatch(JSON.stringify(handoff), /PRIVATE KEY|Bearer |token-value/i);
  assert.match(handoff.heptaPaperProductionDependencyHandoffHash,
    /^sha256:[0-9a-f]{64}$/);
});

test('handoff becomes ready only when external state, submission, and numeric gates pass', () => {
  const value = fixture({ ready: true });
  const handoff = buildProductionDependencyHandoff({
    readiness: value.readiness,
    repositoryAssetInspection: value.assetInspection,
    repositoryAssetManifest: value.assetManifest,
    numericalCandidates: value.candidates,
    observedAt: new Date(NOW),
  });
  assert.equal(handoff.status, 'hepta_paper_production_dependencies_ready');
  assert.equal(handoff.fullyProductionReady, true);
  assert.equal(handoff.independentIdentityAndAttestation.ready, true);
  assert.equal(handoff.externalQualification.ready, true);
  assert.equal(
    handoff.externalQualification.runtimeImageReproducibility.fullProductionReady,
    true,
  );
  assert.equal(handoff.stateSafety.ready, true);
  assert.equal(handoff.submission.ready, true);
  assert.equal(handoff.advancedNumericalQualification.ready, true);
});

test('handoff requires a current record-bound live release-attestor inspection', () => {
  const stale = fixture({ ready: true });
  const staleHandoff = buildProductionDependencyHandoff({
    readiness: stale.readiness,
    repositoryAssetInspection: stale.assetInspection,
    repositoryAssetManifest: stale.assetManifest,
    numericalCandidates: stale.candidates,
    observedAt: new Date('2026-07-15T12:33:00.001Z'),
  });
  assert.equal(staleHandoff.fullyProductionReady, false);
  assert.equal(
    staleHandoff.independentIdentityAndAttestation.currentAttestor
      .inspectionCurrent,
    false,
  );
  assert.ok(staleHandoff.independentIdentityAndAttestation.blockers.includes(
    'research_execution_release_attestor_fresh_live_inspection_required',
  ));

  const notLive = fixture({ ready: true });
  notLive.readiness.liveReleaseAttestorVerificationRequested = false;
  const notLiveHandoff = buildProductionDependencyHandoff({
    readiness: notLive.readiness,
    repositoryAssetInspection: notLive.assetInspection,
    repositoryAssetManifest: notLive.assetManifest,
    numericalCandidates: notLive.candidates,
    observedAt: new Date(NOW),
  });
  assert.equal(notLiveHandoff.fullyProductionReady, false);
  assert.ok(notLiveHandoff.independentIdentityAndAttestation.blockers.includes(
    'research_execution_release_attestor_fresh_live_inspection_required',
  ));
});

test('handoff rejects a stale runtime-ready boolean without the out-of-band pin', () => {
  const value = fixture({ ready: true });
  value.readiness.runtimeImageReproducibilityConfiguration.configurationPinned = false;
  value.readiness.runtimeImageReproducibilityConfiguration.fullProductionReady = false;
  const handoff = buildProductionDependencyHandoff({
    readiness: value.readiness,
    repositoryAssetInspection: value.assetInspection,
    repositoryAssetManifest: value.assetManifest,
    numericalCandidates: value.candidates,
    observedAt: new Date(NOW),
  });
  assert.equal(handoff.fullyProductionReady, false);
  assert.equal(handoff.externalQualification.ready, false);
  assert.ok(handoff.externalQualification.blockers.includes(
    'runtime_reproducibility_full_production_not_ready',
  ));
});

test('handoff rejects stale release-attestor summary booleans and missing pin', () => {
  const cases = [
    [
      'externalSignerProcess',
      'research_execution_release_attestor_production_backend_required',
    ],
    [
      'configurationPinned',
      'research_execution_release_attestor_config_pin_required',
    ],
    [
      'kmsHardwareAuthorityAttestationReady',
      'research_execution_release_attestor_kms_hardware_authority_attestation_required',
    ],
    [
      'independentBackendProbeVerified',
      'research_execution_release_attestor_independent_backend_probe_required',
    ],
    [
      'activeSignerChallengeVerified',
      'research_execution_release_attestor_active_signer_challenge_required',
    ],
  ];
  for (const [field, blocker] of cases) {
    const value = fixture({ ready: true });
    value.readiness.researchExecutionReleaseAttestor = {
      ...value.readiness.researchExecutionReleaseAttestor,
      [field]: false,
    };
    const handoff = buildProductionDependencyHandoff({
      readiness: value.readiness,
      repositoryAssetInspection: value.assetInspection,
      repositoryAssetManifest: value.assetManifest,
      numericalCandidates: value.candidates,
      observedAt: new Date(NOW),
    });
    assert.equal(handoff.fullyProductionReady, false, field);
    assert.equal(handoff.independentIdentityAndAttestation.ready, false, field);
    assert.ok(
      handoff.independentIdentityAndAttestation.blockers.includes(blocker),
      field,
    );
  }
});

test('handoff rejects stale numerical qualification booleans without pin chain', () => {
  const value = fixture({ ready: true });
  value.candidates[0].registryPinned = false;
  value.candidates[0].runtimeConfigurationPinned = false;
  value.candidates[0].dependentDocumentsPinned = false;
  const handoff = buildProductionDependencyHandoff({
    readiness: value.readiness,
    repositoryAssetInspection: value.assetInspection,
    repositoryAssetManifest: value.assetManifest,
    numericalCandidates: value.candidates,
    observedAt: new Date(NOW),
  });
  assert.equal(handoff.fullyProductionReady, false);
  assert.equal(handoff.advancedNumericalQualification.ready, false);
  assert.ok(handoff.advancedNumericalQualification.blockers.includes(
    'three_advanced_numerical_reference_families_full_production_qualification_required',
  ));
});

test('handoff rejects numerical readiness when evidence hashes and authority roles are absent', () => {
  const value = fixture({ ready: true });
  value.candidates[1].qualificationEvidenceBundleHash = null;
  value.candidates[1].qualificationAuthorityRoles = [];
  const handoff = buildProductionDependencyHandoff({
    readiness: value.readiness,
    repositoryAssetInspection: value.assetInspection,
    repositoryAssetManifest: value.assetManifest,
    numericalCandidates: value.candidates,
    observedAt: new Date(NOW),
  });
  assert.equal(handoff.fullyProductionReady, false);
  assert.equal(handoff.advancedNumericalQualification.ready, false);
  assert.ok(handoff.advancedNumericalQualification.blockers.includes(
    'advanced_numerical_reference_qualification_detail_invalid:monte-carlo',
  ));
});

test('handoff requires all five distinct signed numerical evidence receipt hashes', () => {
  const cases = [
    ['missing receipt hash', (candidate) => {
      candidate.evidenceReceiptHashes.referenceExecutionReceiptHash = null;
    }],
    ['duplicate receipt hash', (candidate) => {
      candidate.evidenceReceiptHashes.replayExecutionReceiptHash =
        candidate.evidenceReceiptHashes.referenceExecutionReceiptHash;
    }],
    ['multiple plugin subjects', (candidate) => {
      candidate.pluginAuthoritySubjectIds.push('second-plugin-authority');
    }],
    ['multiple plugin organizations', (candidate) => {
      candidate.pluginAuthorityOrganizations.push('second-plugin-organization');
    }],
    ['multiple plugin keys', (candidate) => {
      candidate.pluginAuthorityPublicKeySpkiHashes.push(H('a'));
    }],
    ['organization aliases', (candidate) => {
      candidate.pluginAuthorityOrganizations[0] = '  Shared-Authority  ';
      candidate.qualificationAuthorityOrganizations[0] = 'shared-authority';
    }],
  ];
  for (const [label, mutate] of cases) {
    const value = fixture({ ready: true });
    mutate(value.candidates[0]);
    const handoff = buildProductionDependencyHandoff({
      readiness: value.readiness,
      repositoryAssetInspection: value.assetInspection,
      repositoryAssetManifest: value.assetManifest,
      numericalCandidates: value.candidates,
      observedAt: new Date(NOW),
    });
    assert.equal(handoff.fullyProductionReady, false, label);
    assert.equal(handoff.advancedNumericalQualification.ready, false, label);
    assert.ok(handoff.advancedNumericalQualification.blockers.includes(
      'advanced_numerical_reference_qualification_detail_invalid:linear-algebra',
    ), label);
  }
});

test('handoff rejects a stale portal-ready boolean without the detailed canary projection', () => {
  const value = fixture({ ready: true });
  value.readiness.autonomousSubmissionDispatcherReadiness = {
    ...value.readiness.autonomousSubmissionDispatcherReadiness,
    livePortalCanaryVerified: false,
  };
  const handoff = buildProductionDependencyHandoff({
    readiness: value.readiness,
    repositoryAssetInspection: value.assetInspection,
    repositoryAssetManifest: value.assetManifest,
    numericalCandidates: value.candidates,
    observedAt: new Date(NOW),
  });
  assert.equal(handoff.fullyProductionReady, false);
  assert.equal(handoff.submission.ready, false);
  assert.ok(handoff.submission.blockers.includes(
    'autonomous_submission_dispatcher_readiness_detail_invalid',
  ));
});

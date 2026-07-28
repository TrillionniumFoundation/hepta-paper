import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProductionDependencyHandoff,
} from '../../paper-application/automation/production-dependency-handoff.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;

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
    researchExecutionReleaseAttestorProductionReady: ready,
    researchExecutionReleaseAttestor: {
      status: ready ? 'research_execution_release_attestor_ready'
        : 'research_execution_release_attestor_blocked',
      productionStatus: ready ? 'research_execution_release_attestor_production_ready'
        : 'research_execution_release_attestor_production_blocked',
      backendKind: ready ? 'kms-external-command-ed25519-v1' : null,
      hardwareProtected: ready,
      externalSignerProcess: ready,
      independentBackendProbeVerified: ready,
      activeSignerChallengeVerified: ready,
    },
    runtimeImageReproducibilityReady: ready,
    runtimeImageReproducibility: {
      status: ready ? 'runtime_image_reproducibility_ready'
        : 'runtime_image_reproducibility_blocked',
      receiptHash: ready ? H('5') : null,
      runtimeImageReproducibilityActivePluginScopeHash: H('6'),
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
      status: ready ? 'autonomous_submission_dispatcher_ready'
        : 'autonomous_submission_dispatcher_blocked',
      planHash: ready ? H('9') : null,
      challengeHash: ready ? H('a') : null,
      cycleReceiptHash: ready ? H('b') : null,
      portalDescriptorHash: ready ? H('c') : null,
      livePortalCanaryIndependentVerificationReceiptHash: ready ? H('d') : null,
      blockers: ready ? [] : ['autonomous_submission_dispatcher_challenge_missing'],
    },
  };
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
  const candidates = [{
    pluginId: 'hepta.reference.linear-algebra',
    analysisFamily: 'linear-algebra',
    productionQualified: ready,
    sourceMerkleHash: H('1'),
    sourceWorkspaceManifestHash: H('2'),
  }];
  return { readiness, assetManifest, assetInspection, candidates };
}

test('production dependency handoff exposes exact external inputs without credentials', () => {
  const value = fixture();
  const handoff = buildProductionDependencyHandoff({
    readiness: value.readiness,
    repositoryAssetInspection: value.assetInspection,
    repositoryAssetManifest: value.assetManifest,
    numericalCandidates: value.candidates,
  });
  assert.equal(handoff.status, 'hepta_paper_external_authority_inputs_required');
  assert.equal(handoff.assets.ready, true);
  assert.equal(handoff.formalClosure.ready, true);
  assert.equal(handoff.deploymentEnvironment.credentialMaterialLoaded, false);
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
  });
  assert.equal(handoff.status, 'hepta_paper_production_dependencies_ready');
  assert.equal(handoff.independentIdentityAndAttestation.ready, true);
  assert.equal(handoff.externalQualification.ready, true);
  assert.equal(handoff.stateSafety.ready, true);
  assert.equal(handoff.submission.ready, true);
  assert.equal(handoff.advancedNumericalQualification.ready, true);
});

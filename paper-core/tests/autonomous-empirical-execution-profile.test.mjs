import assert from 'node:assert/strict';
import test from 'node:test';
import { preflightAutonomousEmpiricalRuntimes } from '../../paper-adapters/automation/autonomous-empirical-runtime-preflight.mjs';
import {
  inspectDockerRuntimeImageManifest,
} from '../../paper-adapters/automation/docker-runtime-image-manifest-inspection.mjs';
import { AUTOMATION_RUNTIME_IMAGES } from '../../paper-adapters/automation/runtime-image-registry.mjs';
import { prepareAutonomousResearchLoop } from '../../paper-application/automation/autonomous-research-readiness.mjs';
import {
  AUTONOMOUS_EMPIRICAL_EXECUTION_PROFILE_POLICY,
  AUTONOMOUS_EMPIRICAL_PROTOCOL_FAMILIES,
  selectAutonomousEmpiricalExecutionProfile,
  verifyAutonomousEmpiricalExecutionProfileSelection,
  verifyAutonomousEmpiricalRuntimeCapabilityInspection,
} from '../../paper-domain/automation/autonomous-empirical-execution-profile-policy.mjs';
import { evaluateAutonomousResearchQualificationEligibility } from '../../paper-domain/automation/autonomous-research-readiness-policy.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const FAMILY_LANGUAGES = Object.freeze({
  econometrics_panel_benchmark: 'r',
  finance_asset_pricing_benchmark: 'r',
  ml_algorithm_benchmark: 'python',
  operations_optimization_benchmark: 'python',
  rl_stochastic_control_benchmark: 'python',
});

function runtimeInspection({ unavailable = [], wrongDigest = [] } = {}) {
  return preflightAutonomousEmpiricalRuntimes({
    spawnSyncImpl(_command, args) {
      const [language, runtime] = Object.entries({
        python: AUTOMATION_RUNTIME_IMAGES.python,
        r: AUTOMATION_RUNTIME_IMAGES.r,
      }).find(([, candidate]) => candidate.image === args[2]) || [];
      if (!runtime || unavailable.includes(language)) return { status: 1, stdout: '' };
      const observedDigest = wrongDigest.includes(language)
        ? `sha256:${'0'.repeat(64)}` : runtime.imageDigest;
      return { status: 0, stdout: JSON.stringify([{
        Id: `sha256:${'f'.repeat(64)}`,
        Descriptor: {
          digest: observedDigest,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
        },
        Os: 'linux',
        Architecture: 'amd64',
      }]) };
    },
  });
}

test('manifest inspection accepts Descriptor digest, never Docker legacy Id', () => {
  const expected = AUTOMATION_RUNTIME_IMAGES.python.imageDigest;
  const inspect = (document) => inspectDockerRuntimeImageManifest({
    image: AUTOMATION_RUNTIME_IMAGES.python.image,
    expectedManifestDigest: expected,
    spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify([document]) }),
  });
  const valid = inspect({
    Id: `sha256:${'1'.repeat(64)}`,
    Descriptor: {
      digest: expected,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
    },
    Os: 'linux',
    Architecture: 'amd64',
  });
  assert.equal(valid.ready, true);
  assert.equal(valid.observedManifestDigest, expected);
  assert.notEqual(valid.observedLegacyId, expected);
  assert.equal(valid.legacyImageIdAcceptedAsManifestIdentity, false);

  const legacyOnly = inspect({ Id: expected, Os: 'linux', Architecture: 'amd64' });
  assert.equal(legacyOnly.ready, false);
  assert.ok(legacyOnly.blockers.includes('docker_runtime_image_descriptor_digest_missing'));

  const descriptorDrift = inspect({
    Id: expected,
    Descriptor: {
      digest: `sha256:${'0'.repeat(64)}`,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
    },
    Os: 'linux',
    Architecture: 'amd64',
  });
  assert.equal(descriptorDrift.ready, false);
  assert.ok(descriptorDrift.blockers.includes('docker_runtime_image_manifest_digest_mismatch'));

  const schema2Substitution = inspect({
    Id: expected,
    Descriptor: {
      digest: expected,
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    },
    Os: 'linux',
    Architecture: 'amd64',
  });
  assert.equal(schema2Substitution.ready, false);
  assert.ok(schema2Substitution.blockers.includes(
    'docker_runtime_image_manifest_media_type_invalid',
  ));
});

function rehashCapabilityInspection(value, mutate) {
  const {
    autonomousEmpiricalRuntimeCapabilityInspectionHash: _ignored,
    ...payload
  } = structuredClone(value);
  mutate(payload);
  return Object.freeze({
    ...payload,
    autonomousEmpiricalRuntimeCapabilityInspectionHash:
      hashRecord('AutonomousEmpiricalRuntimeCapabilityInspection', payload),
  });
}

function rehashSelection(value, mutate) {
  const {
    autonomousEmpiricalExecutionProfileSelectionHash: _ignored,
    ...payload
  } = structuredClone(value);
  mutate(payload);
  return Object.freeze({
    ...payload,
    autonomousEmpiricalExecutionProfileSelectionHash:
      hashRecord('AutonomousEmpiricalExecutionProfileSelection', payload),
  });
}

test('five protocol families select one immutable R or Python execution profile', () => {
  const capabilityInspection = runtimeInspection();
  assert.deepEqual(AUTONOMOUS_EMPIRICAL_PROTOCOL_FAMILIES, Object.keys(FAMILY_LANGUAGES));
  assert.equal(verifyAutonomousEmpiricalRuntimeCapabilityInspection(capabilityInspection), true);

  for (const [protocolFamily, language] of Object.entries(FAMILY_LANGUAGES)) {
    const selection = selectAutonomousEmpiricalExecutionProfile({
      protocolFamily,
      runtimeCapabilityInspection: capabilityInspection,
      language: language === 'r' ? 'python' : 'r',
    });
    assert.equal(selection.status, 'autonomous_empirical_execution_profile_ready');
    assert.deepEqual(selection.executionProfile, { label: language, language, requiresGpu: false });
    assert.equal(selection.profileCount, 1);
    assert.equal(selection.runtimeFallbackAllowed, false);
    assert.equal(selection.runtimeFallbackPerformed, false);
    assert.equal(selection.callerOverrideAllowed, false);
    assert.equal(selection.runtimeCapabilityInspectionHash,
      capabilityInspection.autonomousEmpiricalRuntimeCapabilityInspectionHash);
    assert.equal(verifyAutonomousEmpiricalExecutionProfileSelection(selection, {
      protocolFamily,
      requireReady: true,
      runtimeCapabilityInspection: capabilityInspection,
      requireRuntimeCapabilityInspection: true,
    }), true);
  }

  assert.throws(() => selectAutonomousEmpiricalExecutionProfile({
    protocolFamily: 'unsupported_family',
    runtimeCapabilityInspection: capabilityInspection,
  }), /autonomous_empirical_execution_profile_family_unsupported/);
});

test('runtime preflight receipt is replayed against pinned image, digest, and supervisor identities', () => {
  const capabilityInspection = runtimeInspection();
  for (const language of ['python', 'r']) {
    const runtime = AUTOMATION_RUNTIME_IMAGES[language];
    const capability = capabilityInspection.languages[language];
    const pin = AUTONOMOUS_EMPIRICAL_EXECUTION_PROFILE_POLICY.runtimePins[language];
    assert.equal(capability.image, runtime.image);
    assert.equal(capability.expectedDigest, runtime.imageDigest);
    assert.equal(capability.observedDigest, runtime.imageDigest);
    assert.equal(capability.exactDigestVerified, true);
    assert.equal(capability.available, true);
    assert.deepEqual(capability.datasetAccessSupervisor, pin.datasetAccessSupervisor);
  }

  const imageTamper = rehashCapabilityInspection(capabilityInspection, (payload) => {
    payload.languages.python.image = 'attacker/python:latest';
  });
  assert.equal(verifyAutonomousEmpiricalRuntimeCapabilityInspection(imageTamper), false);

  const digestTamper = rehashCapabilityInspection(capabilityInspection, (payload) => {
    payload.languages.r.expectedDigest = `sha256:${'f'.repeat(64)}`;
  });
  assert.equal(verifyAutonomousEmpiricalRuntimeCapabilityInspection(digestTamper), false);

  const fallbackTamper = rehashCapabilityInspection(capabilityInspection, (payload) => {
    payload.languages.javascript = structuredClone(payload.languages.python);
    payload.languages.javascript.language = 'javascript';
  });
  assert.equal(verifyAutonomousEmpiricalRuntimeCapabilityInspection(fallbackTamper), false);
});

test('an unavailable selected language blocks without falling back to the other ready runtime', () => {
  const capabilityInspection = runtimeInspection({ wrongDigest: ['r'] });
  assert.equal(verifyAutonomousEmpiricalRuntimeCapabilityInspection(capabilityInspection), true);
  assert.deepEqual(capabilityInspection.unavailableLanguages, ['r']);

  const rSelection = selectAutonomousEmpiricalExecutionProfile({
    protocolFamily: 'econometrics_panel_benchmark',
    runtimeCapabilityInspection: capabilityInspection,
  });
  assert.equal(rSelection.executionProfile.language, 'r');
  assert.equal(rSelection.status, 'autonomous_empirical_execution_profile_blocked');
  assert.deepEqual(rSelection.blockers, ['autonomous_empirical_runtime_language_unavailable:r']);
  assert.equal(rSelection.runtimeFallbackPerformed, false);
  assert.equal(rSelection.selectedRuntimeImage,
    AUTOMATION_RUNTIME_IMAGES.r.image);

  const pythonSelection = selectAutonomousEmpiricalExecutionProfile({
    protocolFamily: 'ml_algorithm_benchmark',
    runtimeCapabilityInspection: capabilityInspection,
  });
  assert.equal(pythonSelection.status, 'autonomous_empirical_execution_profile_ready');
  assert.equal(pythonSelection.executionProfile.language, 'python');
});

test('preparation and readiness topology share one selection hash and fail closed without its receipt', async () => {
  const capabilityInspection = runtimeInspection();
  const prepared = await prepareAutonomousResearchLoop({
    paperId: 'empirical-profile-binding-paper',
    protocolFamily: 'finance_asset_pricing_benchmark',
    empiricalRuntimeCapabilityInspection: capabilityInspection,
    revisionRounds: 1,
    refereeCount: 2,
    createdAt: '2026-07-16T00:00:00.000Z',
  });
  const selection = prepared.empiricalExecutionProfileSelection;
  assert.equal(selection.executionProfile.language, 'r');
  assert.equal(selection.runtimeCapabilityInspectionHash,
    capabilityInspection.autonomousEmpiricalRuntimeCapabilityInspectionHash);
  assert.equal(prepared.topologyTemplate.empiricalExecutionProfileSelectionHash,
    selection.autonomousEmpiricalExecutionProfileSelectionHash);
  assert.deepEqual(prepared.topologyTemplate.empiricalExecutionProfile, selection.executionProfile);
  assert.equal(prepared.qualificationEligibility.launchBlockers.includes(
    'autonomous_research_qualification_empirical_runtime_profile_not_ready',
  ), false);

  const withoutReceipt = await prepareAutonomousResearchLoop({
    paperId: 'empirical-profile-missing-receipt-paper',
    protocolFamily: 'finance_asset_pricing_benchmark',
    revisionRounds: 1,
    refereeCount: 2,
    createdAt: '2026-07-16T00:00:00.000Z',
  });
  assert.equal(withoutReceipt.autonomousExecutionLaunchReady, false);
  assert.equal(withoutReceipt.empiricalExecutionProfileSelection.status,
    'autonomous_empirical_execution_profile_blocked');
  assert.ok(withoutReceipt.qualificationEligibility.launchBlockers.includes(
    'autonomous_research_qualification_empirical_runtime_profile_not_ready',
  ));

  assert.equal(verifyAutonomousEmpiricalExecutionProfileSelection(selection, {
    protocolFamily: 'econometrics_panel_benchmark',
    requireReady: true,
    runtimeCapabilityInspection: capabilityInspection,
    requireRuntimeCapabilityInspection: true,
  }), false);

  const alternativeCapabilityInspection = runtimeInspection({ wrongDigest: ['python'] });
  const fullyRehashedSelection = rehashSelection(selection, (payload) => {
    payload.runtimeCapabilityInspectionHash = alternativeCapabilityInspection
      .autonomousEmpiricalRuntimeCapabilityInspectionHash;
  });
  assert.equal(verifyAutonomousEmpiricalExecutionProfileSelection(fullyRehashedSelection, {
    protocolFamily: prepared.proposal.protocolFamily,
    requireReady: true,
  }), false);
  assert.equal(verifyAutonomousEmpiricalExecutionProfileSelection(fullyRehashedSelection, {
    protocolFamily: prepared.proposal.protocolFamily,
    requireReady: true,
    runtimeCapabilityInspection: capabilityInspection,
    requireRuntimeCapabilityInspection: true,
  }), false);
  assert.equal(verifyAutonomousEmpiricalExecutionProfileSelection(fullyRehashedSelection, {
    protocolFamily: prepared.proposal.protocolFamily,
    requireReady: true,
    runtimeCapabilityInspection: alternativeCapabilityInspection,
    requireRuntimeCapabilityInspection: true,
  }), true);

  const forgedEligibility = evaluateAutonomousResearchQualificationEligibility({
    proposal: prepared.proposal,
    policyAuthorization: prepared.policyAuthorization,
    seedBundle: prepared.seedBundle,
    seedBinding: prepared.seedBinding,
    principalSeparation: prepared.principalSeparation,
    topologyInspection: prepared.topologyInspection,
    datasetLaunchInspection: prepared.datasetLaunchInspection,
    empiricalRuntimeCapabilityInspection: capabilityInspection,
    empiricalExecutionProfileSelection: fullyRehashedSelection,
  });
  assert.ok(forgedEligibility.launchBlockers.includes(
    'autonomous_research_qualification_empirical_runtime_profile_not_ready',
  ));
});

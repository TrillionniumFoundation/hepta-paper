import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createResearchExecutionReleaseAttestor,
} from '../../paper-adapters/build-package/research-execution-release-attestor.mjs';
import {
  composeAutomationReleaseAttestorTrust,
} from '../../paper-composition/automation/automation-readiness-query.mjs';
import {
  composeProductionExternalAuthorityIntake,
} from '../../paper-composition/automation/production-external-authority-intake-composition.mjs';
import {
  composeAutonomousResearchCampaignAction,
} from '../../paper-composition/automation/autonomous-research-campaign-composition.mjs';
import {
  buildAutonomousResearchProductionEnqueueReadiness,
} from '../../paper-composition/automation/autonomous-research-enqueue-admission.mjs';
import {
  inspectAutonomousResearchCampaignReleaseAttestor,
} from '../../paper-composition/automation/autonomous-research-readiness-composition.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  H,
  NOW,
  fixture,
  inspectResearchExecutionReleaseAttestorConfiguration,
  inspectResearchExecutionReleaseAttestorConfigurationAsync,
  manifest,
  signer,
  writeFile,
} from './support/research-execution-release-attestor-rotation-fixture.mjs';
test('external KMS inspection proves a non-exportable backend and overlap verifies retiring keys', (t) => {
  const f = fixture(t);
  const inspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    now: new Date(NOW),
    spawnSyncImpl: f.spawnSyncImpl,
    randomBytesImpl: () => Buffer.alloc(32, 7),
  });
  assert.equal(inspection.ready, true);
  assert.equal(inspection.productionReady, true);
  assert.equal(inspection.fullProductionReady, true);
  assert.equal(
    inspection.fullProductionStatus,
    'research_execution_release_attestor_full_production_ready',
  );
  assert.deepEqual(inspection.fullProductionBlockers, []);
  assert.equal(inspection.backendKind, 'external-kms-command');
  assert.equal(inspection.hardwareProtected, true);
  assert.equal(inspection.privateKeyExportable, false);
  assert.equal(inspection.privateKeyLoadedIntoMainProcess, false);
  assert.equal(inspection.credentialMaterialReadByMainProcess, false);
  assert.equal(inspection.independentBackendProbeVerified, true);
  assert.equal(inspection.activeSignerChallengeVerified, true);
  assert.match(inspection.activeSignerChallengeSigningPayloadHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(inspection.activeSignerChallengeVerificationHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(inspection.externalActionPerformed, true);
  assert.equal(
    inspection.externalActionScope,
    'independent_release_backend_probe_and_active_key_signature_challenge',
  );
  assert.equal(inspection.trustedKeys.length, 2);
  assert.equal(JSON.stringify(inspection).includes(f.configPath), false);
  assert.equal(JSON.stringify(inspection).includes('PRIVATE KEY'), false);

  const attestor = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    clock: { now: () => new Date(NOW) },
    spawnSyncImpl: f.spawnSyncImpl,
    randomBytesImpl: () => Buffer.alloc(32, 9),
  });
  const payloadHash = H('qualification-payload');
  const retiringSignature = crypto.sign(
    null,
    Buffer.from(payloadHash, 'utf8'),
    f.retiring.privateKey,
  ).toString('base64');
  assert.equal(attestor.verifyDetachedSignature({
    signingPayloadHash: payloadHash,
    signature: retiringSignature,
    signer: signer('release-key-old', 'v1'),
    signedAt: '2026-07-15T11:00:00.000Z',
  }), true);
  assert.equal(attestor.verifyDetachedSignature({
    signingPayloadHash: payloadHash,
    signature: retiringSignature,
    signer: signer('release-key-old', 'wrong-version'),
    signedAt: '2026-07-15T11:00:00.000Z',
  }), false);
  assert.equal(attestor.verifyDetachedSignature({
    signingPayloadHash: payloadHash,
    signature: retiringSignature,
    signer: signer('release-key-old', 'v1'),
    signedAt: '2026-06-30T23:59:59.000Z',
  }), false);
  assert.equal(attestor.verifyDetachedSignature({
    signingPayloadHash: payloadHash,
    signature: retiringSignature,
    signer: signer('release-key-old', 'v1'),
    signedAt: '2026-08-01T00:00:00.000Z',
  }), false);

  const releaseManifest = manifest();
  const attestation = attestor.attestCapsuleManifest({
    manifest: releaseManifest,
    manifestFileHash: H('manifest-file'),
    signedAt: NOW,
  });
  assert.equal(attestation.keyId, 'release-key-current');
  assert.equal(attestation.keyVersion, 'v2');
  assert.equal(attestor.verifyAttestation({
    attestation,
    manifest: releaseManifest,
    manifestFileHash: H('manifest-file'),
  }), true);
  const expiredWindowVerifier = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    clock: { now: () => new Date('2026-07-16T12:00:00.001Z') },
    spawnSyncImpl: f.spawnSyncImpl,
  });
  assert.equal(expiredWindowVerifier.verifyAttestation({
    attestation,
    manifest: releaseManifest,
    manifestFileHash: H('manifest-file'),
  }), false);

  for (const [name, input] of [
    ['missing-attestation', {}],
    ['wrong-manifest-file', {
      attestation,
      manifest: releaseManifest,
      manifestFileHash: H('wrong-manifest-file'),
    }],
    ['wrong-key-version', {
      attestation: { ...attestation, keyVersion: 'retired-version' },
      manifest: releaseManifest,
      manifestFileHash: H('manifest-file'),
    }],
  ]) {
    assert.equal(attestor.verifyAttestation(input), false, name);
  }
  for (const [name, input] of [
    ['missing-detached-input', {}],
    ['malformed-payload-hash', {
      signingPayloadHash: 'not-a-hash',
      signature: retiringSignature,
      signer: signer('release-key-old', 'v1'),
      signedAt: '2026-07-15T11:00:00.000Z',
    }],
    ['malformed-signature', {
      signingPayloadHash: payloadHash,
      signature: 'not-base64',
      signer: signer('release-key-old', 'v1'),
      signedAt: '2026-07-15T11:00:00.000Z',
    }],
    ['unknown-signer', {
      signingPayloadHash: payloadHash,
      signature: retiringSignature,
      signer: signer('unknown-release-key', 'v1'),
      signedAt: '2026-07-15T11:00:00.000Z',
    }],
    ['invalid-signed-at', {
      signingPayloadHash: payloadHash,
      signature: retiringSignature,
      signer: signer('release-key-old', 'v1'),
      signedAt: 'not-a-time',
    }],
  ]) {
    assert.equal(attestor.verifyDetachedSignature(input), false, name);
  }

  const stringClockAttestor = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    clock: { now: () => NOW },
    spawnSyncImpl: f.spawnSyncImpl,
  });
  assert.equal(stringClockAttestor.verifyDetachedSignature({
    signingPayloadHash: payloadHash,
    signature: retiringSignature,
    signer: signer('release-key-old', 'v1'),
    signedAt: '2026-07-15T11:00:00.000Z',
  }), true);
  assert.throws(() => attestor.attestCapsuleManifest({
    manifest: releaseManifest,
    manifestFileHash: H('manifest-file'),
    signedAt: 'not-a-time',
  }), /research_execution_release_attestor_signing_time_not_current/);

  const unavailable = createResearchExecutionReleaseAttestor({
    configPath: path.join(f.root, 'missing-release-attestor.json'),
    clock: { now: () => new Date(NOW) },
  });
  assert.equal(unavailable.verifyAttestation({
    attestation,
    manifest: releaseManifest,
    manifestFileHash: H('manifest-file'),
  }), false);
  assert.equal(unavailable.verifyDetachedSignature({
    signingPayloadHash: payloadHash,
    signature: retiringSignature,
    signer: signer('release-key-old', 'v1'),
    signedAt: '2026-07-15T11:00:00.000Z',
  }), false);
  assert.throws(() => unavailable.attestCapsuleManifest({
    manifest: releaseManifest,
    manifestFileHash: H('manifest-file'),
  }), /research_execution_release_attestor_config_not_private_regular_file/);
});

test('external authority intake accepts pinned KMS v3 material without invoking KMS', (t) => {
  const f = fixture(t);
  const inspection = composeProductionExternalAuthorityIntake({
    authorConfigPath: null,
    releaseAttestorConfigPath: f.configPath,
    releaseAttestorExpectedConfigurationHash: f.configurationIdentityHash(),
    environment: process.env,
    now: new Date(NOW),
  });
  assert.equal(inspection.releaseAttestor.configured, true);
  assert.equal(
    inspection.releaseAttestor.configurationPinned,
    true,
    JSON.stringify(inspection.releaseAttestor),
  );
  assert.equal(inspection.releaseAttestor.backendKind, 'external-kms-command');
  assert.equal(inspection.releaseAttestor.hardwareProtected, true);
  assert.equal(inspection.releaseAttestor.privateKeyExportable, false);
  assert.equal(inspection.releaseAttestor.kmsHardwareAuthorityReady, true);
  assert.equal(inspection.releaseAttestor.kmsHardwareAuthorityIndependent, true);
  assert.equal(inspection.releaseAttestor.readyForLiveVerification, true);
  assert.equal(inspection.releaseAttestor.liveProbeRequired, true);
  assert.equal(inspection.releaseAttestor.liveSignerChallengeRequired, true);
  assert.equal(inspection.externalActionPerformed, false);
  assert.equal(inspection.serviceStateChanged, false);
  assert.equal(fs.existsSync(f.unexpectedSpawnPath), false);
  assert.equal(inspection.readyForLiveVerification, false);
});

test('v3 KMS policy pin survives signed bundle file rotation', (t) => {
  const f = fixture(t);
  const stablePolicyPin = f.configurationIdentityHash();
  const stableConfigurationFileHash = f.configurationFileHash();
  const originalBundleHash = JSON.parse(fs.readFileSync(
    f.configuration.hardwareAuthorityAttestation.bundlePath,
    'utf8',
  )).bundleHash;
  const rotatedBundle = f.rotateHardwareAuthorityBundle({
    attestedAt: '2026-07-15T11:59:30.000Z',
    expiresAt: '2026-07-15T12:06:00.000Z',
  });
  assert.notEqual(rotatedBundle.bundleHash, originalBundleHash);
  assert.equal(f.configurationFileHash(), stableConfigurationFileHash);
  assert.equal(f.configurationIdentityHash(), stablePolicyPin);
  const inspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    expectedConfigurationHash: stablePolicyPin,
    now: new Date(NOW),
    activeVerification: false,
  });
  assert.equal(inspection.configurationPinned, true);
  assert.equal(
    inspection.configurationIdentityProfile,
    'stable-kms-authority-policy-and-rotating-bundle-v3',
  );
  assert.equal(inspection.kmsHardwareAuthorityAttestationReady, true);
  assert.equal(inspection.externalActionPerformed, false);

  const alternateBundlePath = path.join(f.root, 'kms-hardware-authority-alt.json');
  writeFile(
    alternateBundlePath,
    fs.readFileSync(f.configuration.hardwareAuthorityAttestation.bundlePath),
  );
  const redirectedConfiguration = structuredClone(f.configuration);
  redirectedConfiguration.hardwareAuthorityAttestation.bundlePath =
    alternateBundlePath;
  f.save(redirectedConfiguration);
  const redirected = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    expectedConfigurationHash: stablePolicyPin,
    now: new Date(NOW),
    activeVerification: false,
  });
  assert.equal(redirected.configurationPinned, false);
  assert.ok(redirected.blockers.includes(
    'research_execution_release_attestor_config_pin_mismatch',
  ));
  assert.equal(redirected.externalActionPerformed, false);
});

test('manifest time cannot roll back an expired KMS hardware authority', (t) => {
  const f = fixture(t);
  let externalActions = 0;
  const countedSpawn = (...args) => {
    externalActions += 1;
    return f.spawnSyncImpl(...args);
  };
  const currentAttestor = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    clock: { now: () => new Date(NOW) },
    spawnSyncImpl: countedSpawn,
  });
  const staleManifest = {
    ...manifest(),
    createdAt: '2026-07-15T11:44:59.999Z',
  };
  assert.throws(() => currentAttestor.attestCapsuleManifest({
    manifest: staleManifest,
    manifestFileHash: H('stale-manifest-file'),
    signedAt: staleManifest.createdAt,
  }), /research_execution_release_attestor_signing_time_not_current/);
  assert.equal(externalActions, 0);

  const futureManifest = {
    ...manifest(),
    createdAt: '2026-07-15T12:00:00.001Z',
  };
  assert.throws(() => currentAttestor.attestCapsuleManifest({
    manifest: futureManifest,
    manifestFileHash: H('future-manifest-file'),
    signedAt: futureManifest.createdAt,
  }), /research_execution_release_attestor_signing_time_not_current/);
  assert.equal(externalActions, 0);

  const expiredAuthorityAttestor = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    clock: { now: () => new Date('2026-07-15T12:06:00.000Z') },
    spawnSyncImpl: countedSpawn,
  });
  assert.throws(() => expiredAuthorityAttestor.attestCapsuleManifest({
    manifest: manifest(),
    manifestFileHash: H('expired-authority-manifest-file'),
    signedAt: NOW,
  }), /research_execution_release_attestor_kms_hardware_authority_attestation_required/);
  assert.equal(externalActions, 0);

  const shortLifetimeConfiguration = structuredClone(f.configuration);
  shortLifetimeConfiguration.attestationLifetimeSeconds = 60;
  f.save(shortLifetimeConfiguration);
  const expiredBeforeSigningAttestor = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    clock: { now: () => new Date(NOW) },
    spawnSyncImpl: countedSpawn,
  });
  const alreadyExpiredManifest = {
    ...manifest(),
    createdAt: '2026-07-15T11:58:00.000Z',
  };
  assert.throws(() => expiredBeforeSigningAttestor.attestCapsuleManifest({
    manifest: alreadyExpiredManifest,
    manifestFileHash: H('already-expired-manifest-file'),
    signedAt: alreadyExpiredManifest.createdAt,
  }), /research_execution_release_attestor_expiry_invalid/);
  assert.equal(externalActions, 0);
});

test('KMS signing is deadline-bound and revalidated after the signer returns', (t) => {
  const f = fixture(t);
  f.rotateHardwareAuthorityBundle({
    attestedAt: '2026-07-15T11:59:30.000Z',
    expiresAt: '2026-07-15T12:00:02.000Z',
  });
  const ticks = [
    new Date(NOW),
    new Date(NOW),
    new Date('2026-07-15T12:00:02.000Z'),
  ];
  let signerRequest = null;
  let signerTimeoutMs = null;
  const attestor = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    clock: { now: () => ticks.shift() },
    spawnSyncImpl(executable, args, options) {
      signerRequest = JSON.parse(String(options.input));
      signerTimeoutMs = options.timeout;
      return f.spawnSyncImpl(executable, args, options);
    },
  });
  assert.throws(() => attestor.attestCapsuleManifest({
    manifest: manifest(),
    manifestFileHash: H('deadline-bound-manifest-file'),
    signedAt: NOW,
  }), /research_execution_release_attestor_signing_authorization_expired/);
  assert.equal(signerRequest.version, 2);
  assert.equal(signerRequest.protocol, 'hepta-release-signer-json-stdio-v2');
  assert.equal(
    signerRequest.authorizationExpiresAt,
    '2026-07-15T12:00:02.000Z',
  );
  assert.ok(signerTimeoutMs <= 2_000);

  const invalidEcho = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    clock: { now: () => new Date(NOW) },
    spawnSyncImpl(executable, args, options) {
      const result = f.spawnSyncImpl(executable, args, options);
      const request = JSON.parse(String(options.input));
      if (request.kind !== 'ResearchExecutionReleaseSignerRequest') return result;
      const response = JSON.parse(result.stdout);
      const { researchExecutionReleaseSignerResponseHash: _hash, ...payload } = response;
      payload.authorizationExpiresAt = '2026-07-15T12:00:01.999Z';
      return {
        ...result,
        stdout: JSON.stringify({
          ...payload,
          researchExecutionReleaseSignerResponseHash:
            hashRecord('ResearchExecutionReleaseSignerResponse', payload),
        }),
      };
    },
  });
  assert.throws(() => invalidEcho.attestCapsuleManifest({
    manifest: manifest(),
    manifestFileHash: H('wrong-deadline-echo-manifest-file'),
    signedAt: NOW,
  }), /research_execution_release_attestor_backend_signing_response_invalid/);
});

test('Golden release-attestor verification uses the bounded readiness side-effect ledger', (t) => {
  const f = fixture(t);
  let externalCalls = 0;
  const environment = { ...process.env };
  environment.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH =
    f.configurationIdentityHash(environment);
  const passive = inspectAutonomousResearchCampaignReleaseAttestor({
    runtimeRoot: f.root,
    configPath: f.configPath,
    observedAt: new Date(NOW),
    environment,
    activeVerification: false,
    spawnSyncImpl() {
      externalCalls += 1;
      throw new Error('passive inspection must not spawn');
    },
  });
  assert.equal(passive.inspection.externalActionPerformed, false);
  assert.equal(passive.sideEffectLedger.inspection().processActionCount, 0);

  const active = inspectAutonomousResearchCampaignReleaseAttestor({
    runtimeRoot: f.root,
    configPath: f.configPath,
    observedAt: new Date(NOW),
    environment,
    activeVerification: true,
    actionClock: { now: () => new Date(NOW) },
    spawnSyncImpl(...args) {
      externalCalls += 1;
      return f.spawnSyncImpl(...args);
    },
  });
  const sideEffects = active.sideEffectLedger.inspection({
    releaseAttestorInspection: active.inspection,
  });
  assert.equal(
    active.inspection.productionReady,
    true,
    JSON.stringify(active.inspection),
  );
  assert.equal(externalCalls, 2);
  assert.equal(sideEffects.processActionCount, 2);
  assert.equal(sideEffects.releaseAttestorProcessActionCount, 2);
  assert.equal(sideEffects.releaseAttestorBackendProbeActionCount, 1);
  assert.equal(sideEffects.releaseAttestorSignerChallengeActionCount, 1);
  assert.equal(sideEffects.externalEndpointActionCount, 2);
});

test('enqueue admission trust inspection reads KMS configuration without probe or signer challenge', (t) => {
  const f = fixture(t);
  let externalCalls = 0;
  const environment = {
    ...process.env,
    HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG: f.configPath,
  };
  environment.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH =
    f.configurationIdentityHash(environment);
  const trust = composeAutomationReleaseAttestorTrust({
    environment,
    now: new Date(NOW),
    activeVerification: false,
    spawnSyncImpl(...args) {
      externalCalls += 1;
      return f.spawnSyncImpl(...args);
    },
  });
  assert.equal(externalCalls, 0);
  assert.equal(trust.inspection.ready, true, JSON.stringify(trust.inspection));
  assert.equal(trust.inspection.productionReady, false);
  assert.equal(trust.inspection.backendProductionEligible, true);
  assert.equal(trust.inspection.backendProbeExternalActionAttempted, false);
  assert.equal(trust.inspection.activeSignerChallengeExternalActionAttempted, false);
  assert.equal(trust.inspection.externalActionPerformed, false);
  assert.equal(trust.inspection.externalActionScope, 'none');
  const report = {
    automationOperationalReady: true,
    academicEmpiricalReady: true,
    researchExecutionReleaseAttestorReady: true,
    runtimeImageReproducibilityReady: true,
    fullResearchQualificationReady: true,
    liveProviderCanaryRequested: false,
    externalActionPerformed: false,
    researchExecutionReleaseAttestor: trust.inspection,
    productionGenericCapabilityReady: true,
    fullAutomaticResearchWritingBlockers: [
      'research_execution_release_attestor_production_backend_not_ready',
    ],
  };
  assert.equal(buildAutonomousResearchProductionEnqueueReadiness(report)
    .productionEnqueueAdmissionReady, true);
  const externallyMutated = buildAutonomousResearchProductionEnqueueReadiness({
    ...report,
    externalActionPerformed: true,
  });
  assert.equal(externallyMutated.productionEnqueueAdmissionReady, false);
  assert.match(externallyMutated.productionEnqueueAdmissionBlockers.join(','),
    /production_enqueue_readiness_external_action_forbidden/);
});

test('live readiness attestor verification uses action time instead of a stale query snapshot', (t) => {
  const f = fixture(t);
  const environment = {
    ...process.env,
    HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG: f.configPath,
  };
  environment.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH =
    f.configurationIdentityHash(environment);
  const trust = composeAutomationReleaseAttestorTrust({
    environment,
    now: new Date('2026-07-15T11:30:00.000Z'),
    activeVerificationNow: new Date(NOW),
    activeVerification: true,
    activeVerificationClock: { now: () => new Date(NOW) },
    spawnSyncImpl: f.spawnSyncImpl,
  });
  assert.equal(trust.inspection.inspectedAt, NOW);
  assert.equal(
    trust.inspection.independentBackendProbeVerified,
    true,
    JSON.stringify(trust.inspection),
  );
  assert.equal(trust.inspection.activeSignerChallengeVerified, true);
  assert.equal(trust.inspection.productionReady, true);
});

test('production mutation cannot reach live KMS before persisted-plan reservation', async (t) => {
  const f = fixture(t);
  const root = path.join(f.root, 'paper');
  const runtimeRoot = path.join(f.root, 'runtime');
  const environment = {
    ...process.env,
    HEPTA_RESEARCH_AUTHOR_PROVIDER: 'codex',
    HEPTA_RESEARCH_AUTHOR_MODEL: 'author-model',
    HEPTA_FORMAL_REVIEW_PROVIDER: 'codex',
    HEPTA_FORMAL_REVIEW_MODEL: 'reviewer-model',
    HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD: '1',
    HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD: '1',
    HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG: f.configPath,
  };
  environment.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH =
    f.configurationIdentityHash(environment);
  let readinessInspections = 0;
  let liveSpawns = 0;
  const readiness = (inspection) => ({
    automationOperationalReady: true,
    academicEmpiricalReady: true,
    fullResearchQualificationReady: true,
    campaignFullyQualified: true,
    fullAutomaticResearchWritingReady: true,
    researchExecutionReleaseAttestorReady: true,
    researchExecutionReleaseAttestorProductionReady: true,
    researchExecutionReleaseAttestor: inspection,
    runtimeImageReproducibilityReady: true,
    runtimeImageReproducibility: { remainingValidityMs: 48 * 60 * 60 * 1000 },
    fullResearchQualification: { remainingValidityMs: 48 * 60 * 60 * 1000 },
  });
  const failure = await composeAutonomousResearchCampaignAction({
    action: 'resume',
    launchMode: 'production-run',
    paperId: 'single-live-attestor-inspection',
    root,
    runtimeRoot,
    budgets: { maxCostUsd: 10 },
    environment,
    readinessClock: { now: () => new Date(NOW) },
    productionReadinessInspector(input) {
      readinessInspections += 1;
      const trust = composeAutomationReleaseAttestorTrust({
        runtimeRoot,
        environment,
        now: input.now,
        activeVerification: true,
        spawnSyncImpl(...args) {
          liveSpawns += 1;
          return f.spawnSyncImpl(...args);
        },
      });
      return { report: readiness(trust.inspection) };
    },
  }).then(() => null, (error) => error);
  assert.ok(failure);
  assert.match(String(failure.message),
    /autonomous_research_production_readiness_authorization_required/);
  assert.equal(readinessInspections, 0);
  assert.equal(liveSpawns, 0, 'readiness reservation must precede every KMS action');
  assert.equal(fs.existsSync(f.unexpectedSpawnPath), false,
    'campaign composition must not execute a second attestor inspection');

  await assert.rejects(() => composeAutonomousResearchCampaignAction({
    action: 'resume',
    launchMode: 'production-run',
    paperId: 'forged-live-attestor-inspection',
    root,
    runtimeRoot,
    budgets: { maxCostUsd: 10 },
    environment,
    readinessClock: { now: () => new Date(NOW) },
    productionReadinessInspector: () => ({ report: readiness(null) }),
  }), /autonomous_research_production_readiness_authorization_required/);
  assert.equal(fs.existsSync(f.unexpectedSpawnPath), false);
});

test('external KMS inspection synchronously fences the probe-to-signer boundary', (t) => {
  const f = fixture(t);
  const stages = [];
  const inspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    expectedConfigurationHash: f.configurationIdentityHash(),
    now: new Date(NOW),
    spawnSyncImpl: f.spawnSyncImpl,
    randomBytesImpl: () => Buffer.alloc(32, 17),
    onSynchronousProgress({ stage }) { stages.push(stage); },
  });
  assert.equal(inspection.productionReady, true);
  const afterProbe = stages.indexOf(
    'release_attestor_after_backend_probe_before_signer_challenge',
  );
  const beforeSigner = stages.indexOf('release_attestor_before_active_signer_challenge');
  const afterSigner = stages.indexOf('release_attestor_after_active_signer_challenge');
  assert.ok(afterProbe >= 0 && beforeSigner > afterProbe && afterSigner > beforeSigner);

  let externalCalls = 0;
  assert.throws(() => inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    now: new Date(NOW),
    spawnSyncImpl(...args) {
      externalCalls += 1;
      return f.spawnSyncImpl(...args);
    },
    onSynchronousProgress: async () => {},
  }), /progress_callback_must_be_synchronous/);
  assert.equal(externalCalls, 0);
});

test('live KMS inspection cannot cross its authorization deadline or an async bundle rotation',
  async (t) => {
    const synchronous = fixture(t);
    synchronous.rotateHardwareAuthorityBundle({
      attestedAt: '2026-07-15T11:59:30.000Z',
      expiresAt: '2026-07-15T12:00:02.000Z',
    });
    const ticks = [
      new Date(NOW),
      new Date('2026-07-15T12:00:00.500Z'),
      new Date('2026-07-15T12:00:01.000Z'),
      new Date('2026-07-15T12:00:02.000Z'),
    ];
    let synchronousCalls = 0;
    const expiredAfterChallenge =
      inspectResearchExecutionReleaseAttestorConfiguration({
        configPath: synchronous.configPath,
        expectedConfigurationHash: synchronous.configurationIdentityHash(),
        now: new Date(NOW),
        clock: {
          now: () => ticks.shift()
            || new Date('2026-07-15T12:00:02.000Z'),
        },
        spawnSyncImpl(...args) {
          synchronousCalls += 1;
          return synchronous.spawnSyncImpl(...args);
        },
      });
    assert.equal(synchronousCalls, 2);
    assert.equal(expiredAfterChallenge.backendProbeExternalActionAttempted, true);
    assert.equal(
      expiredAfterChallenge.activeSignerChallengeExternalActionAttempted,
      true,
    );
    assert.equal(expiredAfterChallenge.activeSignerChallengeVerified, false);
    assert.equal(expiredAfterChallenge.productionReady, false);
    assert.equal(expiredAfterChallenge.fullProductionReady, false);
    assert.equal(
      expiredAfterChallenge.liveVerificationCompletedAt,
      '2026-07-15T12:00:02.000Z',
    );
    assert.ok(expiredAfterChallenge.blockers.includes(
      'research_execution_release_attestor_kms_hardware_authority_attestation_required',
    ));

    const asynchronous = fixture(t);
    const asynchronousPin = asynchronous.configurationIdentityHash();
    let asynchronousCalls = 0;
    const rotatedBeforeSigner =
      await inspectResearchExecutionReleaseAttestorConfigurationAsync({
        configPath: asynchronous.configPath,
        expectedConfigurationHash: asynchronousPin,
        now: new Date(NOW),
        clock: { now: () => new Date(NOW) },
        spawnSyncImpl(...args) {
          asynchronousCalls += 1;
          return asynchronous.spawnSyncImpl(...args);
        },
        async onProgress({ stage }) {
          if (stage === 'release_attestor_before_active_signer_challenge') {
            asynchronous.rotateHardwareAuthorityBundle({
              attestedAt: '2026-07-15T11:49:00.000Z',
              expiresAt: '2026-07-15T11:59:00.000Z',
            });
          }
        },
      });
    assert.equal(asynchronousCalls, 1);
    assert.equal(rotatedBeforeSigner.backendProbeExternalActionAttempted, true);
    assert.equal(
      rotatedBeforeSigner.activeSignerChallengeExternalActionAttempted,
      false,
    );
    assert.equal(rotatedBeforeSigner.productionReady, false);
    assert.equal(rotatedBeforeSigner.fullProductionReady, false);
    assert.ok(rotatedBeforeSigner.blockers.includes(
      'research_execution_release_attestor_kms_hardware_authority_attestation_required',
    ));
  });

test('async release-attestor inspection mirrors live trust and fails closed per boundary',
  async (t) => {
    const f = fixture(t);
    const stages = [];
    const live = await inspectResearchExecutionReleaseAttestorConfigurationAsync({
      configPath: f.configPath,
      expectedConfigurationHash: f.configurationIdentityHash(),
      now: new Date(NOW),
      spawnSyncImpl: f.spawnSyncImpl,
      randomBytesImpl: () => Buffer.alloc(32, 19),
      async onProgress({ stage }) { stages.push(stage); },
    });
    assert.equal(live.ready, true, JSON.stringify(live.blockers));
    assert.equal(live.productionReady, true, JSON.stringify(live.productionBlockers));
    assert.ok(stages.indexOf('release_attestor_after_configuration_read')
      < stages.indexOf('release_attestor_before_backend_probe'));
    assert.ok(stages.indexOf(
      'release_attestor_after_backend_probe_before_signer_challenge',
    ) < stages.indexOf('release_attestor_before_active_signer_challenge'));

    await assert.rejects(() => inspectResearchExecutionReleaseAttestorConfigurationAsync({
      configPath: f.configPath,
      now: new Date(NOW),
      spawnSyncImpl: f.spawnSyncImpl,
      onProgress: 'not-a-function',
    }), /research_execution_release_attestor_progress_callback_invalid/);

    for (const scenario of [
      Object.freeze({
        name: 'passive',
        options: Object.freeze({ activeVerification: false }),
        expectedReady: true,
        expectedProductionReady: false,
        expectedBlocker: null,
      }),
      Object.freeze({
        name: 'invalid-time',
        options: Object.freeze({ now: 'not-a-time' }),
        expectedReady: false,
        expectedProductionReady: false,
        expectedBlocker: 'research_execution_release_attestor_inspection_time_invalid',
      }),
      Object.freeze({
        name: 'invalid-entropy',
        options: Object.freeze({ randomBytesImpl: () => Buffer.alloc(1) }),
        expectedReady: false,
        expectedProductionReady: false,
        expectedBlocker:
          'research_execution_release_attestor_active_signer_challenge_not_verified',
      }),
      Object.freeze({
        name: 'missing-configuration',
        options: Object.freeze({
          configPath: path.join(f.root, 'missing-async-release-attestor.json'),
          activeVerification: false,
        }),
        expectedReady: false,
        expectedProductionReady: false,
        expectedBlocker:
          'research_execution_release_attestor_config_not_private_regular_file',
      }),
    ]) {
      const inspection = await inspectResearchExecutionReleaseAttestorConfigurationAsync({
        configPath: f.configPath,
        expectedConfigurationHash: f.configurationIdentityHash(),
        now: new Date(NOW),
        spawnSyncImpl: f.spawnSyncImpl,
        randomBytesImpl: () => Buffer.alloc(32, 23),
        ...scenario.options,
      });
      assert.equal(inspection.ready, scenario.expectedReady, scenario.name);
      assert.equal(
        inspection.productionReady,
        scenario.expectedProductionReady,
        scenario.name,
      );
      if (scenario.expectedBlocker) {
        assert.ok(inspection.blockers.includes(scenario.expectedBlocker), scenario.name);
      }
    }
  });

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createResearchExecutionReleaseAttestor,
  inspectResearchExecutionReleaseAttestorConfiguration,
  inspectResearchExecutionReleaseAttestorConfigurationAsync,
} from '../../paper-adapters/build-package/research-execution-release-attestor.mjs';
import {
  composeAutomationReleaseAttestorTrust,
} from '../../paper-composition/automation/automation-readiness-query.mjs';
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

const NOW = '2026-07-15T12:00:00.000Z';
const H = (label) => hashRecord('ResearchExecutionReleaseAttestorRotationTestHash', { label });

function writeFile(candidate, value, mode = 0o600) {
  fs.writeFileSync(candidate, value, { mode });
  fs.chmodSync(candidate, mode);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-attestor-rotation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const active = crypto.generateKeyPairSync('ed25519');
  const retiring = crypto.generateKeyPairSync('ed25519');
  const probe = crypto.generateKeyPairSync('ed25519');
  const activePublicKeyPath = path.join(root, 'active-public.pem');
  const retiringPublicKeyPath = path.join(root, 'retiring-public.pem');
  const probePublicKeyPath = path.join(root, 'probe-public.pem');
  writeFile(activePublicKeyPath, active.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFile(retiringPublicKeyPath, retiring.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFile(probePublicKeyPath, probe.publicKey.export({ type: 'spki', format: 'pem' }));
  const signerExecutable = path.join(root, 'kms-signer');
  const probeExecutable = path.join(root, 'kms-independent-probe');
  const unexpectedSpawnPath = path.join(root, 'unexpected-direct-spawn.log');
  const unexpectedSpawn = (scope) => `#!/usr/bin/env node\n`
    + `require('node:fs').appendFileSync(${JSON.stringify(unexpectedSpawnPath)}, `
    + `${JSON.stringify(`${scope}\n`)});\n`;
  writeFile(signerExecutable, unexpectedSpawn('signer'), 0o700);
  writeFile(probeExecutable, unexpectedSpawn('probe'), 0o700);
  const signerCredentialRoot = path.join(root, 'signer-credentials');
  const probeCredentialRoot = path.join(root, 'probe-credentials');
  fs.mkdirSync(signerCredentialRoot, { mode: 0o700 });
  fs.mkdirSync(probeCredentialRoot, { mode: 0o700 });
  const configPath = path.join(root, 'release-attestor.json');
  const probeSigner = Object.freeze({
    keyId: 'kms-probe-key',
    keyVersion: 'probe-v3',
    subjectId: 'independent-kms-probe',
    organization: 'Independent KMS Operations',
    role: 'research_execution_release_signer_backend_probe_attestor',
    algorithm: 'ed25519',
  });
  const configuration = {
    version: 2,
    kind: 'ResearchExecutionReleaseAttestorConfiguration',
    status: 'active',
    attestationLifetimeSeconds: 24 * 60 * 60,
    trustSet: {
      version: 1,
      kind: 'ResearchExecutionReleaseAttestorTrustSet',
      keys: [{
        keyId: 'release-key-old',
        keyVersion: 'v1',
        subjectId: 'release-attestor',
        organization: 'Research Release Office',
        role: 'research_execution_release_attestor',
        algorithm: 'ed25519',
        status: 'retiring',
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        expiresAt: '2026-08-01T00:00:00.000Z',
        revokedAt: null,
        publicKeyPath: retiringPublicKeyPath,
      }, {
        keyId: 'release-key-current',
        keyVersion: 'v2',
        subjectId: 'release-attestor',
        organization: 'Research Release Office',
        role: 'research_execution_release_attestor',
        algorithm: 'ed25519',
        status: 'active',
        effectiveFrom: '2026-07-10T00:00:00.000Z',
        expiresAt: '2026-09-01T00:00:00.000Z',
        revokedAt: null,
        publicKeyPath: activePublicKeyPath,
      }],
    },
    backend: {
      kind: 'external-kms-command',
      backendId: 'research-kms-production',
      backendVersion: 'hsm-cluster-v7',
      algorithm: 'ed25519',
      hardwareProtected: true,
      privateKeyExportable: false,
      externalSignerProcess: true,
      activeKeyId: 'release-key-current',
      activeKeyVersion: 'v2',
      signerCommand: {
        serviceId: 'release-kms-signer',
        principalId: 'release-kms-principal',
        protocol: 'hepta-release-signer-json-stdio-v1',
        executable: signerExecutable,
        credentialRoot: signerCredentialRoot,
        args: [],
        environmentAllowlist: [],
        timeoutMs: 5000,
      },
      probeCommand: {
        serviceId: 'independent-kms-probe',
        principalId: 'independent-kms-probe-principal',
        protocol: 'hepta-release-signer-probe-json-stdio-v1',
        executable: probeExecutable,
        credentialRoot: probeCredentialRoot,
        args: [],
        environmentAllowlist: [],
        timeoutMs: 5000,
      },
      probeAttestor: {
        ...probeSigner,
        status: 'active',
        effectiveFrom: '2026-07-01T00:00:00.000Z',
        expiresAt: '2027-07-01T00:00:00.000Z',
        revokedAt: null,
        publicKeyPath: probePublicKeyPath,
      },
    },
  };
  const save = (value = configuration) => writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`);
  save();

  function spawnSyncImpl(executable, _args, options) {
    const request = JSON.parse(String(options.input));
    if (executable === probeExecutable) {
      const payload = {
        version: 1,
        kind: 'ResearchExecutionReleaseSignerBackendProbeAttestation',
        status: 'research_execution_release_signer_backend_probe_verified',
        backendDescriptorHash: request.backendDescriptorHash,
        backendId: request.backendId,
        backendVersion: request.backendVersion,
        activeKeyId: request.activeKeyId,
        activeKeyVersion: request.activeKeyVersion,
        activePublicKeySpkiHash: request.activePublicKeySpkiHash,
        algorithm: 'ed25519',
        challengeHash: request.challengeHash,
        backendReachable: true,
        hardwareProtected: true,
        privateKeyExportable: false,
        externalSignerProcess: true,
        probedAt: '2026-07-15T11:59:59.000Z',
        expiresAt: '2026-07-15T12:04:59.000Z',
        externalActionPerformed: true,
        externalActionScope: 'single_read_only_release_signer_backend_challenge',
        signer: probeSigner,
      };
      const signingPayloadHash = hashRecord(
        'ResearchExecutionReleaseSignerBackendProbeAttestationSigningPayload',
        payload,
      );
      const signature = crypto.sign(
        null,
        Buffer.from(signingPayloadHash, 'utf8'),
        probe.privateKey,
      ).toString('base64');
      const signed = { ...payload, signature };
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          ...signed,
          researchExecutionReleaseSignerBackendProbeAttestationHash: hashRecord(
            'ResearchExecutionReleaseSignerBackendProbeAttestation',
            signed,
          ),
        }),
      };
    }
    assert.equal(executable, signerExecutable);
    const signature = crypto.sign(
      null,
      Buffer.from(request.signingPayloadHash, 'utf8'),
      active.privateKey,
    ).toString('base64');
    const response = {
      version: 1,
      kind: 'ResearchExecutionReleaseSignerResponse',
      status: 'research_execution_release_digest_signed',
      backendDescriptorHash: request.backendDescriptorHash,
      backendId: request.backendId,
      backendVersion: request.backendVersion,
      keyId: request.keyId,
      keyVersion: request.keyVersion,
      algorithm: 'ed25519',
      signingPayloadHash: request.signingPayloadHash,
      requestNonceHash: request.requestNonceHash,
      signature,
    };
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        ...response,
        researchExecutionReleaseSignerResponseHash:
          hashRecord('ResearchExecutionReleaseSignerResponse', response),
      }),
    };
  }
  return {
    root,
    active,
    retiring,
    configPath,
    configuration,
    save,
    spawnSyncImpl,
    unexpectedSpawnPath,
    activePublicKeyPath,
    retiringPublicKeyPath,
  };
}

function signer(keyId, keyVersion) {
  return Object.freeze({
    keyId,
    keyVersion,
    subjectId: 'release-attestor',
    organization: 'Research Release Office',
    role: 'research_execution_release_attestor',
    algorithm: 'ed25519',
  });
}

function manifest() {
  return Object.freeze({
    researchEvidenceCapsuleManifestHash: H('manifest'),
    campaignId: 'campaign:rotation',
    paperId: 'paper:rotation',
    researchReportHash: H('report'),
    experimentRegistryHash: H('registry'),
    campaignResearchSourceSnapshotHash: H('source-snapshot'),
    verifiedSourceMerkleHash: H('source-merkle'),
    verifiedSourceWorkspaceManifestHash: H('source-workspace'),
    researchVerifyNodeId: 'campaign:rotation:research-verify',
    researchVerifyAttemptId: 'attempt:rotation',
    researchVerifyLeaseGeneration: 1,
    academicExperimentCount: 1,
    experimentCount: 1,
    createdAt: NOW,
  });
}

test('external KMS inspection proves a non-exportable backend and overlap verifies retiring keys', (t) => {
  const f = fixture(t);
  const inspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    now: new Date(NOW),
    spawnSyncImpl: f.spawnSyncImpl,
    randomBytesImpl: () => Buffer.alloc(32, 7),
  });
  assert.equal(inspection.ready, true);
  assert.equal(inspection.productionReady, true);
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
  }), /research_execution_release_attestor_key_not_valid_at_signing_time/);

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

test('Golden release-attestor verification uses the bounded readiness side-effect ledger', (t) => {
  const f = fixture(t);
  let externalCalls = 0;
  const passive = inspectAutonomousResearchCampaignReleaseAttestor({
    runtimeRoot: f.root,
    configPath: f.configPath,
    observedAt: new Date(NOW),
    environment: {},
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
    environment: {},
    activeVerification: true,
    spawnSyncImpl(...args) {
      externalCalls += 1;
      return f.spawnSyncImpl(...args);
    },
  });
  const sideEffects = active.sideEffectLedger.inspection({
    releaseAttestorInspection: active.inspection,
  });
  assert.equal(active.inspection.productionReady, true);
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
  const trust = composeAutomationReleaseAttestorTrust({
    environment: {
      HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG: f.configPath,
    },
    now: new Date(NOW),
    activeVerification: false,
    spawnSyncImpl(...args) {
      externalCalls += 1;
      return f.spawnSyncImpl(...args);
    },
  });
  assert.equal(externalCalls, 0);
  assert.equal(trust.inspection.ready, true);
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

test('production mutation cannot reach live KMS before persisted-plan reservation', async (t) => {
  const f = fixture(t);
  const root = path.join(f.root, 'paper');
  const runtimeRoot = path.join(f.root, 'runtime');
  const environment = {
    HEPTA_RESEARCH_AUTHOR_PROVIDER: 'codex',
    HEPTA_RESEARCH_AUTHOR_MODEL: 'author-model',
    HEPTA_FORMAL_REVIEW_PROVIDER: 'codex',
    HEPTA_FORMAL_REVIEW_MODEL: 'reviewer-model',
    HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD: '1',
    HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD: '1',
    HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG: f.configPath,
  };
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

test('async release-attestor inspection mirrors live trust and fails closed per boundary',
  async (t) => {
    const f = fixture(t);
    const stages = [];
    const live = await inspectResearchExecutionReleaseAttestorConfigurationAsync({
      configPath: f.configPath,
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

test('revocation, duplicate SPKI encodings, wrong algorithm, and private-key disclosure fail closed', (t) => {
  const f = fixture(t);
  const revoked = structuredClone(f.configuration);
  revoked.trustSet.keys[0].revokedAt = '2026-07-15T11:30:00.000Z';
  f.save(revoked);
  const revokedAttestor = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    clock: { now: () => new Date(NOW) },
    spawnSyncImpl: f.spawnSyncImpl,
  });
  const payloadHash = H('revoked-payload');
  const signature = crypto.sign(
    null,
    Buffer.from(payloadHash, 'utf8'),
    f.retiring.privateKey,
  ).toString('base64');
  assert.equal(revokedAttestor.verifyDetachedSignature({
    signingPayloadHash: payloadHash,
    signature,
    signer: signer('release-key-old', 'v1'),
    signedAt: '2026-07-15T11:00:00.000Z',
  }), false);

  const duplicatePemPath = path.join(f.root, 'retiring-public-alternate.pem');
  const alternatePem = String(
    f.retiring.publicKey.export({ type: 'spki', format: 'pem' }),
  ).replaceAll('\n', '\r\n');
  writeFile(duplicatePemPath, alternatePem);
  const duplicate = structuredClone(f.configuration);
  duplicate.trustSet.keys.push({
    ...duplicate.trustSet.keys[0],
    keyId: 'release-key-alias',
    keyVersion: 'alias-v9',
    publicKeyPath: duplicatePemPath,
  });
  f.save(duplicate);
  const duplicateInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    now: new Date(NOW),
    spawnSyncImpl: f.spawnSyncImpl,
  });
  assert.equal(duplicateInspection.ready, false);
  assert.ok(duplicateInspection.blockers.includes(
    'research_execution_release_attestor_trust_set_key_identity_collision',
  ));

  const wrongAlgorithm = structuredClone(f.configuration);
  wrongAlgorithm.backend.algorithm = 'rsa-sha256';
  f.save(wrongAlgorithm);
  const algorithmInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    now: new Date(NOW),
    spawnSyncImpl: f.spawnSyncImpl,
  });
  assert.equal(algorithmInspection.ready, false);
  assert.ok(algorithmInspection.blockers.includes(
    'research_execution_release_attestor_backend_descriptor_invalid',
  ));

  const disclosure = structuredClone(f.configuration);
  disclosure.backend.privateKeyPath = '/forbidden/main-process-private-key.pem';
  f.save(disclosure);
  const disclosureInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    now: new Date(NOW),
    spawnSyncImpl: f.spawnSyncImpl,
  });
  assert.equal(disclosureInspection.ready, false);
  assert.ok(disclosureInspection.blockers.includes(
    'research_execution_release_attestor_private_key_disclosure_forbidden',
  ));
  assert.equal(disclosureInspection.privateKeyDisclosed, false);
  assert.equal(JSON.stringify(disclosureInspection).includes('main-process-private-key.pem'), false);
});

test('file signer is explicit local degradation and forged independent probes never unlock production', (t) => {
  const f = fixture(t);
  const localPrivateKeyPath = path.join(f.root, 'local-private.pem');
  const localConfigPath = path.join(f.root, 'local-config.json');
  writeFile(localPrivateKeyPath, f.active.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFile(localConfigPath, JSON.stringify({
    version: 1,
    kind: 'ResearchExecutionReleaseAttestorConfiguration',
    keyId: 'local-release-key',
    keyVersion: 'local-v1',
    subjectId: 'local-release-attestor',
    organization: 'Local Test Release Office',
    algorithm: 'ed25519',
    role: 'research_execution_release_attestor',
    status: 'active',
    revoked: false,
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    attestationLifetimeSeconds: 86400,
    privateKeyPath: localPrivateKeyPath,
  }));
  const localInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: localConfigPath,
    now: new Date(NOW),
  });
  assert.equal(localInspection.ready, true);
  assert.equal(localInspection.productionReady, false);
  assert.equal(localInspection.backendKind, 'local-file');
  assert.equal(localInspection.privateKeyLoadedIntoMainProcess, true);
  assert.equal(localInspection.externalActionPerformed, false);
  assert.ok(localInspection.productionBlockers.includes(
    'research_execution_release_attestor_production_backend_required',
  ));
  assert.equal(JSON.stringify(localInspection).includes(localPrivateKeyPath), false);

  const forgedProbe = (executable, args, options) => {
    const result = f.spawnSyncImpl(executable, args, options);
    if (executable !== f.configuration.backend.probeCommand.executable) return result;
    const response = JSON.parse(result.stdout);
    response.backendVersion = 'attacker-downgrade';
    return { ...result, stdout: JSON.stringify(response) };
  };
  const forgedInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    now: new Date(NOW),
    spawnSyncImpl: forgedProbe,
  });
  assert.equal(forgedInspection.ready, false);
  assert.equal(forgedInspection.productionReady, false);
  assert.ok(forgedInspection.blockers.includes(
    'research_execution_release_attestor_backend_probe_not_verified',
  ));
  assert.equal(forgedInspection.activeSignerChallengeVerified, false);
  assert.equal(forgedInspection.externalActionScope, 'independent_release_backend_probe');

  const wrongVersionSigner = (executable, args, options) => {
    const result = f.spawnSyncImpl(executable, args, options);
    if (executable !== f.configuration.backend.signerCommand.executable) return result;
    const response = JSON.parse(result.stdout);
    const { researchExecutionReleaseSignerResponseHash: _hash, ...payload } = response;
    payload.keyVersion = 'retired-version-downgrade';
    return {
      ...result,
      stdout: JSON.stringify({
        ...payload,
        researchExecutionReleaseSignerResponseHash:
          hashRecord('ResearchExecutionReleaseSignerResponse', payload),
      }),
    };
  };
  const downgradedAttestor = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    clock: { now: () => new Date(NOW) },
    spawnSyncImpl: wrongVersionSigner,
  });
  assert.throws(() => downgradedAttestor.attestCapsuleManifest({
    manifest: manifest(),
    manifestFileHash: H('manifest-file'),
    signedAt: NOW,
  }), /research_execution_release_attestor_backend_signing_response_invalid/);
});

test('an independent probe cannot hide an unreachable or wrong active KMS signing key', (t) => {
  const f = fixture(t);
  const unreachableSigner = (executable, args, options) => {
    if (executable === f.configuration.backend.signerCommand.executable) {
      return { status: 1, signal: null, stdout: '', stderr: 'active key unavailable' };
    }
    return f.spawnSyncImpl(executable, args, options);
  };
  const unreachable = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    now: new Date(NOW),
    spawnSyncImpl: unreachableSigner,
    randomBytesImpl: () => Buffer.alloc(32, 11),
  });
  assert.equal(unreachable.independentBackendProbeVerified, true);
  assert.equal(unreachable.activeSignerChallengeVerified, false);
  assert.equal(unreachable.ready, false);
  assert.equal(unreachable.productionReady, false);
  assert.ok(unreachable.blockers.includes(
    'research_execution_release_attestor_active_signer_challenge_not_verified',
  ));
  assert.ok(unreachable.productionBlockers.includes(
    'research_execution_release_attestor_active_signer_challenge_required',
  ));

  const wrongKey = crypto.generateKeyPairSync('ed25519');
  const wrongKeySigner = (executable, args, options) => {
    const result = f.spawnSyncImpl(executable, args, options);
    if (executable !== f.configuration.backend.signerCommand.executable) return result;
    const request = JSON.parse(String(options.input));
    const response = JSON.parse(result.stdout);
    const { researchExecutionReleaseSignerResponseHash: _hash, ...payload } = response;
    payload.signature = crypto.sign(
      null,
      Buffer.from(request.signingPayloadHash, 'utf8'),
      wrongKey.privateKey,
    ).toString('base64');
    return {
      ...result,
      stdout: JSON.stringify({
        ...payload,
        researchExecutionReleaseSignerResponseHash:
          hashRecord('ResearchExecutionReleaseSignerResponse', payload),
      }),
    };
  };
  const mismatched = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: f.configPath,
    now: new Date(NOW),
    spawnSyncImpl: wrongKeySigner,
    randomBytesImpl: () => Buffer.alloc(32, 12),
  });
  assert.equal(mismatched.independentBackendProbeVerified, true);
  assert.equal(mismatched.activeSignerChallengeVerified, false);
  assert.equal(mismatched.productionReady, false);

  const mismatchedAttestor = createResearchExecutionReleaseAttestor({
    configPath: f.configPath,
    clock: { now: () => new Date(NOW) },
    spawnSyncImpl: wrongKeySigner,
  });
  assert.throws(() => mismatchedAttestor.attestCapsuleManifest({
    manifest: manifest(),
    manifestFileHash: H('manifest-file'),
    signedAt: NOW,
  }), /research_execution_release_attestor_backend_signature_invalid/);
});

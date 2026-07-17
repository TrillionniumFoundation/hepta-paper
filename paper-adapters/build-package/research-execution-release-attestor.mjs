import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  buildCampaignReleaseExecutionAttestationUnsignedPayload,
  campaignReleaseExecutionAttestationSigningPayloadHash,
  finalizeCampaignReleaseExecutionAttestation,
  verifyCampaignReleaseExecutionAttestationStructure,
} from '../../paper-domain/automation/campaign-release-execution-attestation-contract.mjs';
import { assertResearchExecutionReleaseAttestorPort } from '../../paper-ports/research-execution-release-attestor-port.mjs';
import { RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS } from '../../paper-ports/research-execution-release-signer-backend-port.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readProvisionedReleaseAttestorConfiguration } from './research-execution-release-attestor-configuration.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const SIGNATURE = /^[A-Za-z0-9+/]{80,120}={0,2}$/;

function canonicalTimestamp(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : null;
}

function reportSynchronousProgress(onProgress, stage) {
  if (onProgress === null || onProgress === undefined) return;
  if (typeof onProgress !== 'function') {
    throw new Error('research_execution_release_attestor_progress_callback_invalid');
  }
  const result = onProgress(Object.freeze({ stage }));
  if (result && typeof result.then === 'function') {
    throw new Error('research_execution_release_attestor_progress_callback_must_be_synchronous');
  }
}

function matchingTrustedKey(configuration, signer, { signedAt, verificationTime } = {}) {
  const signedAtMs = canonicalTimestamp(String(signedAt || ''));
  const verificationMs = verificationTime instanceof Date
    ? verificationTime.getTime() : Date.parse(verificationTime);
  if (signedAtMs === null || !Number.isFinite(verificationMs)) return null;
  return configuration.trustedKeys.find((key) => {
    const effectiveFrom = Date.parse(key.effectiveFrom);
    const expiresAt = Date.parse(key.expiresAt);
    const revokedAt = key.revokedAt === null ? Number.POSITIVE_INFINITY : Date.parse(key.revokedAt);
    return signer?.keyId === key.signer.keyId
      && signer?.keyVersion === key.signer.keyVersion
      && signer?.subjectId === key.signer.subjectId
      && (signer?.organization || null) === key.signer.organization
      && signer?.role === key.signer.role
      && signer?.algorithm === 'ed25519'
      && ['active', 'retiring'].includes(key.status)
      && signedAtMs >= effectiveFrom && signedAtMs < expiresAt && signedAtMs < revokedAt
      && verificationMs >= effectiveFrom && verificationMs < expiresAt && verificationMs < revokedAt;
  }) || null;
}

function activeSignerChallenge({ configuration, descriptor, timestamp, probe, randomBytesImpl }) {
  const activeKey = configuration?.activeKey || null;
  if (descriptor?.productionEligible !== true || probe?.verified !== true
    || !activeKey || !Number.isFinite(timestamp)) {
    return Object.freeze({
      attempted: false, verified: false, signingPayloadHash: null, verificationHash: null,
    });
  }
  try {
    const nonce = randomBytesImpl(32);
    if (!Buffer.isBuffer(nonce) || nonce.length !== 32) throw new Error('challenge entropy invalid');
    const signingPayloadHash = hashRecord(
      'ResearchExecutionReleaseAttestorActiveSignerChallengeSigningPayload',
      {
        version: 1,
        kind: 'ResearchExecutionReleaseAttestorActiveSignerChallenge',
        backendDescriptorHash:
          descriptor.researchExecutionReleaseSignerBackendDescriptorHash,
        backendId: descriptor.backendId,
        backendVersion: descriptor.backendVersion,
        keyId: activeKey.signer.keyId,
        keyVersion: activeKey.signer.keyVersion,
        publicKeySpkiHash: activeKey.publicKeySpkiHash,
        trustSetHash: configuration.trustSetHash,
        inspectedAt: new Date(timestamp).toISOString(),
        nonceHash: hashBytes(nonce),
      },
    );
    const signature = configuration.backendPort.signDigest({
      signingPayloadHash,
      keyId: activeKey.signer.keyId,
      keyVersion: activeKey.signer.keyVersion,
    });
    const verified = SIGNATURE.test(String(signature || '')) && crypto.verify(
      null,
      Buffer.from(signingPayloadHash, 'utf8'),
      activeKey.publicKey,
      Buffer.from(signature, 'base64'),
    );
    if (!verified) throw new Error('active signer challenge signature invalid');
    return Object.freeze({
      attempted: true,
      verified: true,
      signingPayloadHash,
      verificationHash: hashRecord(
        'ResearchExecutionReleaseAttestorActiveSignerChallengeVerification',
        {
          version: 1,
          backendDescriptorHash:
            descriptor.researchExecutionReleaseSignerBackendDescriptorHash,
          keyId: activeKey.signer.keyId,
          keyVersion: activeKey.signer.keyVersion,
          publicKeySpkiHash: activeKey.publicKeySpkiHash,
          signingPayloadHash,
          inspectedAt: new Date(timestamp).toISOString(),
          verified: true,
        },
      ),
    });
  } catch {
    return Object.freeze({
      attempted: true, verified: false, signingPayloadHash: null, verificationHash: null,
    });
  }
}

function inspectionPayload({
  read, timestamp, probe, probeAttempted, signerChallenge, blockers, productionBlockers,
}) {
  const configuration = read.configuration;
  const activeKey = configuration?.activeKey || null;
  const descriptor = configuration?.backendPort?.describeBackend() || null;
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const uniqueProductionBlockers = Object.freeze([...new Set([
    ...uniqueBlockers,
    ...productionBlockers,
  ])]);
  return Object.freeze({
    version: 1,
    kind: 'ResearchExecutionReleaseAttestorConfigurationInspection',
    status: uniqueBlockers.length
      ? 'research_execution_release_attestor_blocked'
      : 'research_execution_release_attestor_ready',
    ready: uniqueBlockers.length === 0,
    productionStatus: uniqueProductionBlockers.length
      ? 'research_execution_release_attestor_production_blocked'
      : 'research_execution_release_attestor_production_ready',
    productionReady: uniqueProductionBlockers.length === 0,
    inspectedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    keyId: activeKey?.signer.keyId || null,
    keyVersion: activeKey?.signer.keyVersion || null,
    subjectId: activeKey?.signer.subjectId || null,
    organization: activeKey?.signer.organization || null,
    role: activeKey?.signer.role || null,
    algorithm: activeKey?.signer.algorithm || null,
    publicKeySpkiHash: activeKey?.publicKeySpkiHash || null,
    effectiveFrom: activeKey?.effectiveFrom || null,
    expiresAt: activeKey?.expiresAt || null,
    trustSetVersion: configuration?.trustSetVersion || null,
    trustSetHash: configuration?.trustSetHash || null,
    trustedKeys: configuration?.publicKeys || Object.freeze([]),
    backendKind: descriptor?.backendKind || null,
    backendId: descriptor?.backendId || null,
    backendVersion: descriptor?.backendVersion || null,
    backendProductionEligible: descriptor?.productionEligible === true,
    backendDescriptorHash:
      descriptor?.researchExecutionReleaseSignerBackendDescriptorHash || null,
    backendCommandIdentityHash: descriptor?.commandIdentityHash || null,
    backendProbeCommandIdentityHash: descriptor?.probeCommandIdentityHash || null,
    signerBackendAssurance: descriptor?.productionEligible === true
      ? probe.verified === true && signerChallenge.verified === true
        ? 'independently-probed-and-active-key-challenged-hardware-protected-nonexportable-signer-v2'
        : 'production-backend-configured-live-verification-not-performed-v1'
      : 'local-file-private-key-main-process-degraded-v1',
    hardwareProtected: descriptor?.hardwareProtected === true,
    privateKeyExportable: descriptor?.privateKeyExportable !== false,
    externalSignerProcess: descriptor?.externalSignerProcess === true,
    privateKeyLoadedIntoMainProcess:
      descriptor?.backendKind === RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.LOCAL_FILE,
    credentialMaterialReadByMainProcess: descriptor?.credentialMaterialReadByMainProcess !== false,
    independentBackendProbeVerified: probe.verified === true,
    backendProbeExternalActionAttempted: probeAttempted === true,
    backendProbeAttestationHash:
      probe.attestation?.researchExecutionReleaseSignerBackendProbeAttestationHash || null,
    backendProbeAttestorKeyId: configuration?.probeAttestor?.signer.keyId || null,
    backendProbeAttestorKeyVersion: configuration?.probeAttestor?.signer.keyVersion || null,
    backendProbeAttestorSubjectId: configuration?.probeAttestor?.signer.subjectId || null,
    backendProbeAttestorOrganization:
      configuration?.probeAttestor?.signer.organization || null,
    backendProbeAttestorRole: configuration?.probeAttestor?.signer.role || null,
    backendProbeAttestorAlgorithm: configuration?.probeAttestor?.signer.algorithm || null,
    backendProbeAttestorEffectiveFrom: configuration?.probeAttestor?.effectiveFrom || null,
    backendProbeAttestorExpiresAt: configuration?.probeAttestor?.expiresAt || null,
    backendProbeAttestorPublicKeySpkiHash:
      configuration?.probeAttestor?.publicKeySpkiHash || null,
    activeSignerChallengeVerified: signerChallenge.verified === true,
    activeSignerChallengeExternalActionAttempted: signerChallenge.attempted === true,
    activeSignerChallengeSigningPayloadHash: signerChallenge.signingPayloadHash || null,
    activeSignerChallengeVerificationHash: signerChallenge.verificationHash || null,
    externalActionPerformed: probeAttempted === true || signerChallenge.attempted === true,
    externalActionScope: signerChallenge.attempted === true
      ? 'independent_release_backend_probe_and_active_key_signature_challenge'
      : probeAttempted === true ? 'independent_release_backend_probe' : 'none',
    privateKeyDisclosed: false,
    productionBlockers: uniqueProductionBlockers,
    blockers: uniqueBlockers,
  });
}

export function inspectResearchExecutionReleaseAttestorConfiguration({
  runtimeRoot,
  configPath = null,
  now = new Date(),
  environment = process.env,
  spawnSyncImpl = spawnSync,
  randomBytesImpl = crypto.randomBytes,
  onSynchronousProgress = null,
  activeVerification = true,
} = {}) {
  reportSynchronousProgress(
    onSynchronousProgress,
    'release_attestor_before_configuration_read',
  );
  const read = readProvisionedReleaseAttestorConfiguration({
    runtimeRoot, configPath, environment, spawnSyncImpl, randomBytesImpl,
  });
  reportSynchronousProgress(
    onSynchronousProgress,
    'release_attestor_after_configuration_read',
  );
  const blockers = read.blocker ? [read.blocker] : [];
  const timestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    blockers.push('research_execution_release_attestor_inspection_time_invalid');
  }
  const activeKey = read.configuration?.activeKey || null;
  if (activeKey && (timestamp < Date.parse(activeKey.effectiveFrom)
    || timestamp >= Date.parse(activeKey.expiresAt)
    || (activeKey.revokedAt && timestamp >= Date.parse(activeKey.revokedAt)))) {
    blockers.push('research_execution_release_attestor_key_not_currently_valid');
  }
  let probe = Object.freeze({ verified: false, attestation: null });
  const descriptor = read.configuration?.backendPort?.describeBackend() || null;
  const probeAttempted = activeVerification === true
    && descriptor?.productionEligible === true && Number.isFinite(timestamp);
  if (probeAttempted) {
    reportSynchronousProgress(
      onSynchronousProgress,
      'release_attestor_before_backend_probe',
    );
    try {
      probe = read.configuration.backendPort.probeBackend({ inspectedAt: new Date(timestamp) });
    } catch { probe = Object.freeze({ verified: false, attestation: null }); }
    reportSynchronousProgress(
      onSynchronousProgress,
      'release_attestor_after_backend_probe_before_signer_challenge',
    );
    if (probe.verified !== true) {
      blockers.push('research_execution_release_attestor_backend_probe_not_verified');
    }
  }
  reportSynchronousProgress(
    onSynchronousProgress,
    'release_attestor_before_active_signer_challenge',
  );
  const signerChallenge = activeVerification === true
    ? activeSignerChallenge({
      configuration: read.configuration,
      descriptor,
      timestamp,
      probe,
      randomBytesImpl,
    }) : Object.freeze({
      attempted: false, verified: false, signingPayloadHash: null, verificationHash: null,
    });
  reportSynchronousProgress(
    onSynchronousProgress,
    'release_attestor_after_active_signer_challenge',
  );
  if (activeVerification === true && descriptor?.productionEligible === true
    && signerChallenge.verified !== true) {
    blockers.push('research_execution_release_attestor_active_signer_challenge_not_verified');
  }
  const productionBlockers = [];
  if (descriptor?.productionEligible !== true
    || descriptor?.backendKind !== RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.EXTERNAL_KMS_COMMAND
    || descriptor?.hardwareProtected !== true || descriptor?.privateKeyExportable !== false
    || descriptor?.externalSignerProcess !== true) {
    productionBlockers.push('research_execution_release_attestor_production_backend_required');
  }
  if (probe.verified !== true) {
    productionBlockers.push('research_execution_release_attestor_independent_backend_probe_required');
  }
  if (signerChallenge.verified !== true) {
    productionBlockers.push('research_execution_release_attestor_active_signer_challenge_required');
  }
  const payload = inspectionPayload({
    read, timestamp, probe, probeAttempted, signerChallenge, blockers, productionBlockers,
  });
  return Object.freeze({
    ...payload,
    researchExecutionReleaseAttestorConfigurationInspectionHash: hashRecord(
      'ResearchExecutionReleaseAttestorConfigurationInspection',
      payload,
    ),
  });
}

export function createResearchExecutionReleaseAttestor({
  runtimeRoot,
  configPath = null,
  clock = null,
  environment = process.env,
  spawnSyncImpl = spawnSync,
  randomBytesImpl = crypto.randomBytes,
} = {}) {
  const now = () => {
    const value = clock?.now ? clock.now() : new Date();
    return value instanceof Date ? value : new Date(value);
  };
  const readConfiguration = () => readProvisionedReleaseAttestorConfiguration({
    runtimeRoot, configPath, environment, spawnSyncImpl, randomBytesImpl,
  });
  return assertResearchExecutionReleaseAttestorPort(Object.freeze({
    version: 1,
    kind: 'ResearchExecutionReleaseAttestorPort',
    inspectConfiguration() {
      return inspectResearchExecutionReleaseAttestorConfiguration({
        runtimeRoot, configPath, now: now(), environment, spawnSyncImpl, randomBytesImpl,
      });
    },
    verifyAttestation({ attestation, manifest, manifestFileHash } = {}) {
      const read = readConfiguration();
      if (!read.configuration) return false;
      const structure = verifyCampaignReleaseExecutionAttestationStructure(attestation, {
        manifest,
        researchEvidenceCapsuleManifestHash: manifest?.researchEvidenceCapsuleManifestHash,
        researchEvidenceCapsuleManifestFileHash: manifestFileHash,
      });
      const key = matchingTrustedKey(read.configuration, attestation, {
        signedAt: attestation?.signedAt,
        verificationTime: now(),
      });
      if (!structure.valid || !key) return false;
      try {
        return crypto.verify(
          null,
          Buffer.from(campaignReleaseExecutionAttestationSigningPayloadHash(attestation), 'utf8'),
          key.publicKey,
          Buffer.from(String(attestation.signature || ''), 'base64'),
        );
      } catch { return false; }
    },
    verifyDetachedSignature({ signingPayloadHash, signature, signer, signedAt } = {}) {
      const read = readConfiguration();
      if (!read.configuration || !SHA256.test(String(signingPayloadHash || ''))
        || !SIGNATURE.test(String(signature || ''))) return false;
      const key = matchingTrustedKey(read.configuration, signer, {
        signedAt,
        verificationTime: now(),
      });
      if (!key) return false;
      try {
        return crypto.verify(null, Buffer.from(signingPayloadHash, 'utf8'), key.publicKey,
          Buffer.from(signature, 'base64'));
      } catch { return false; }
    },
    attestCapsuleManifest({ manifest, manifestFileHash, signedAt = null } = {}) {
      const observedAt = signedAt ? new Date(signedAt) : now();
      const read = readConfiguration();
      if (!read.configuration) throw new Error(read.blocker);
      const configuration = read.configuration;
      const activeKey = configuration.activeKey;
      const timestamp = observedAt.getTime();
      const keyExpiresAt = Date.parse(activeKey.expiresAt);
      if (!Number.isFinite(timestamp) || timestamp < Date.parse(activeKey.effectiveFrom)
        || timestamp >= keyExpiresAt || activeKey.status !== 'active'
        || activeKey.revokedAt !== null) {
        throw new Error('research_execution_release_attestor_key_not_valid_at_signing_time');
      }
      const expiresAt = Math.min(timestamp + configuration.lifetimeMs, keyExpiresAt);
      if (expiresAt <= timestamp) {
        throw new Error('research_execution_release_attestor_expiry_invalid');
      }
      const unsignedPayload = buildCampaignReleaseExecutionAttestationUnsignedPayload({
        manifest,
        manifestFileHash,
        signer: activeKey.signer,
        signedAt: observedAt,
        validFrom: observedAt,
        expiresAt: new Date(expiresAt),
      });
      const signingPayloadHash = campaignReleaseExecutionAttestationSigningPayloadHash(unsignedPayload);
      const signature = configuration.backendPort.signDigest({
        signingPayloadHash,
        keyId: activeKey.signer.keyId,
        keyVersion: activeKey.signer.keyVersion,
      });
      const attestation = finalizeCampaignReleaseExecutionAttestation({ unsignedPayload, signature });
      if (!crypto.verify(null, Buffer.from(signingPayloadHash, 'utf8'), activeKey.publicKey,
        Buffer.from(signature, 'base64'))) {
        throw new Error('research_execution_release_attestor_signature_self_verification_failed');
      }
      return attestation;
    },
  }));
}

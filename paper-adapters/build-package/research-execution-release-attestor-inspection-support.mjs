import crypto from 'node:crypto';

import {
  RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS,
} from '../../paper-ports/research-execution-release-signer-backend-port.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  inspectResearchExecutionReleaseKmsHardwareAttestationBundle,
} from './research-execution-release-kms-hardware-attestation.mjs';

const SIGNATURE = /^[A-Za-z0-9+/]{80,120}={0,2}$/;

function canonicalTimestamp(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString() === value ? timestamp : null;
}

export function signerAuthorizationDeadline(
  configuration,
  outputExpiresAt = Number.POSITIVE_INFINITY,
) {
  const keyExpiresAt = Date.parse(configuration?.activeKey?.expiresAt);
  const hardwareExpiresAt = configuration?.configurationVersion === 3
    ? Date.parse(
      configuration?.kmsHardwareAuthorityAttestation?.bundle?.subject?.expiresAt,
    )
    : Number.POSITIVE_INFINITY;
  return Math.min(keyExpiresAt, hardwareExpiresAt, outputExpiresAt);
}

export function activeSignerChallenge({
  configuration,
  descriptor,
  timestamp,
  probe,
  randomBytesImpl,
}) {
  const activeKey = configuration?.activeKey || null;
  const authorizationDeadline = signerAuthorizationDeadline(configuration);
  if (descriptor?.productionEligible !== true || probe?.verified !== true
    || !activeKey || !Number.isFinite(timestamp)
    || !Number.isFinite(authorizationDeadline)
    || authorizationDeadline <= timestamp) {
    return Object.freeze({
      attempted: false,
      verified: false,
      signingPayloadHash: null,
      verificationHash: null,
    });
  }
  try {
    const nonce = randomBytesImpl(32);
    if (!Buffer.isBuffer(nonce) || nonce.length !== 32) {
      throw new Error('challenge entropy invalid');
    }
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
      ...(configuration.configurationVersion === 3 ? {
        authorizationExpiresAt: new Date(authorizationDeadline).toISOString(),
        maximumWaitMs: authorizationDeadline - timestamp,
      } : {}),
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
      attempted: true,
      verified: false,
      signingPayloadHash: null,
      verificationHash: null,
    });
  }
}

export function inspectKmsHardwareAuthority(
  configuration,
  descriptor,
  timestamp,
) {
  if (descriptor?.backendKind
      !== RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.EXTERNAL_KMS_COMMAND
    || !Number.isFinite(timestamp)) {
    return null;
  }
  const authority = configuration?.kmsHardwareAuthorityAttestation || null;
  const activeKey = configuration?.activeKey || null;
  const probeAttestor = configuration?.probeAttestor || null;
  return inspectResearchExecutionReleaseKmsHardwareAttestationBundle(
    authority?.bundle,
    {
      now: new Date(timestamp),
      expected: {
        kmsProvider: descriptor.kmsProvider,
        providerAccountIdentityHash: descriptor.providerAccountIdentityHash,
        keyResourceIdentityHash: descriptor.keyResourceIdentityHash,
        credentialGenerationIdentityHash:
          descriptor.credentialGenerationIdentityHash,
        backendDescriptorHash:
          descriptor.researchExecutionReleaseSignerBackendDescriptorHash,
        backendId: descriptor.backendId,
        backendVersion: descriptor.backendVersion,
        activeKeyId: activeKey?.signer.keyId,
        activeKeyVersion: activeKey?.signer.keyVersion,
        activePublicKeySpkiHash: activeKey?.publicKeySpkiHash,
        trustSetHash: configuration?.trustSetHash,
        challengeHash: authority?.challengeHash,
      },
      expectedTrustStoreHash: authority?.trustStoreHash,
      expectedSignerKeyIds: authority?.signerKeyIds,
      prohibitedAuthorities: [
        ...(configuration?.publicKeys || []),
        ...(probeAttestor ? [{
          ...probeAttestor.signer,
          publicKeySpkiHash: probeAttestor.publicKeySpkiHash,
        }] : []),
      ],
    },
  );
}

export function configurationAuthorizesExternalKmsTrust(
  configuration,
  descriptor,
) {
  return descriptor?.backendKind
    !== RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.EXTERNAL_KMS_COMMAND
    || configuration?.configurationPinned === true;
}

export function configurationAuthorizesExternalKmsAction(
  configuration,
  descriptor,
  kmsHardwareAuthority,
) {
  return configurationAuthorizesExternalKmsTrust(configuration, descriptor)
    && (descriptor?.backendKind
      !== RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.EXTERNAL_KMS_COMMAND
      || kmsHardwareAuthority?.hardwareAuthorityReady === true);
}

export function probeAttestationCurrentAt(probe, timestamp) {
  const probedAt = canonicalTimestamp(probe?.attestation?.probedAt);
  const expiresAt = canonicalTimestamp(probe?.attestation?.expiresAt);
  return probe?.verified === true
    && probedAt !== null
    && expiresAt !== null
    && timestamp >= probedAt
    && timestamp < expiresAt;
}

function liveActionTimestamp(clock) {
  try {
    const value = clock?.now?.();
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  } catch {
    return null;
  }
}

export function revalidateLiveAuthority({
  readConfiguration,
  baselineConfigurationIdentityHash,
  baselineBackendDescriptorHash,
  previousTimestamp,
  clock,
} = {}) {
  const timestamp = liveActionTimestamp(clock);
  if (timestamp === null || timestamp < previousTimestamp) {
    return Object.freeze({
      ready: false,
      blocker: 'research_execution_release_attestor_live_action_time_invalid',
      timestamp,
    });
  }
  const read = readConfiguration();
  if (!read.configuration) {
    return Object.freeze({
      ready: false,
      blocker: read.blocker
        || 'research_execution_release_attestor_configuration_changed_during_live_verification',
      timestamp,
    });
  }
  const configuration = read.configuration;
  const descriptor = configuration.backendPort.describeBackend();
  const activeKey = configuration.activeKey;
  const probeAttestor = configuration.probeAttestor;
  const state = { timestamp, read, descriptor };
  if (configuration.configurationIdentityHash !== baselineConfigurationIdentityHash
    || descriptor.researchExecutionReleaseSignerBackendDescriptorHash
      !== baselineBackendDescriptorHash) {
    return Object.freeze({
      ready: false,
      blocker:
        'research_execution_release_attestor_configuration_changed_during_live_verification',
      ...state,
    });
  }
  if (!activeKey || activeKey.status !== 'active' || activeKey.revokedAt !== null
    || timestamp < Date.parse(activeKey.effectiveFrom)
    || timestamp >= Date.parse(activeKey.expiresAt)) {
    return Object.freeze({
      ready: false,
      blocker: 'research_execution_release_attestor_key_not_currently_valid',
      ...state,
    });
  }
  if (!probeAttestor || probeAttestor.status !== 'active'
    || probeAttestor.revokedAt !== null
    || timestamp < Date.parse(probeAttestor.effectiveFrom)
    || timestamp >= Date.parse(probeAttestor.expiresAt)) {
    return Object.freeze({
      ready: false,
      blocker: 'research_execution_release_attestor_backend_probe_not_verified',
      ...state,
    });
  }
  const kmsHardwareAuthority = inspectKmsHardwareAuthority(
    configuration,
    descriptor,
    timestamp,
  );
  if (!configurationAuthorizesExternalKmsAction(
    configuration,
    descriptor,
    kmsHardwareAuthority,
  )) {
    return Object.freeze({
      ready: false,
      blocker:
        'research_execution_release_attestor_kms_hardware_authority_attestation_required',
      ...state,
      kmsHardwareAuthority,
    });
  }
  return Object.freeze({
    ready: true,
    blocker: null,
    ...state,
    kmsHardwareAuthority,
  });
}

export function releaseAttestorInspectionPayload({
  read,
  timestamp,
  completionTimestamp,
  kmsHardwareAuthority,
  probe,
  probeAttempted,
  signerChallenge,
  blockers,
  productionBlockers,
}) {
  const configuration = read.configuration;
  const activeKey = configuration?.activeKey || null;
  const descriptor = configuration?.backendPort?.describeBackend() || null;
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const uniqueProductionBlockers = Object.freeze([...new Set([
    ...uniqueBlockers,
    ...productionBlockers,
  ])]);
  const fullProductionBlockers = Object.freeze([...new Set([
    ...uniqueProductionBlockers,
    ...(descriptor?.backendKind
      === RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.EXTERNAL_KMS_COMMAND
      && descriptor?.hardwareProtected === true
      && descriptor?.privateKeyExportable === false
      ? [] : [
        'research_execution_release_attestor_full_production_hardware_kms_required',
      ]),
    ...(descriptor?.backendKind
      === RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.EXTERNAL_KMS_COMMAND
      && configuration?.configurationPinned !== true
      ? ['research_execution_release_attestor_config_pin_required'] : []),
    ...(descriptor?.backendKind
      === RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.EXTERNAL_KMS_COMMAND
      && kmsHardwareAuthority?.hardwareAuthorityReady !== true
      ? [
        'research_execution_release_attestor_kms_hardware_authority_attestation_required',
      ] : []),
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
    fullProductionStatus: fullProductionBlockers.length
      ? 'research_execution_release_attestor_full_production_blocked'
      : 'research_execution_release_attestor_full_production_ready',
    fullProductionReady: fullProductionBlockers.length === 0,
    inspectedAt: Number.isFinite(timestamp)
      ? new Date(timestamp).toISOString() : null,
    liveVerificationCompletedAt: Number.isFinite(completionTimestamp)
      ? new Date(completionTimestamp).toISOString() : null,
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
    configurationFileHash: configuration?.configurationFileHash || null,
    configurationIdentityHash: configuration?.configurationIdentityHash || null,
    configurationIdentityProfile:
      configuration?.configurationIdentityProfile || null,
    configurationPinned: configuration?.configurationPinned === true,
    kmsHardwareAuthorityAttestationReady:
      kmsHardwareAuthority?.hardwareAuthorityReady === true,
    kmsHardwareAuthorityAttestationInspectionHash:
      kmsHardwareAuthority
        ?.researchExecutionReleaseKmsHardwareAttestationInspectionHash || null,
    kmsHardwareAuthorityAttestationBundleHash:
      kmsHardwareAuthority?.bundleHash || null,
    kmsHardwareAuthorityAttestationSubjectHash:
      kmsHardwareAuthority?.subjectHash || null,
    kmsHardwareAuthorityTrustStoreHash:
      kmsHardwareAuthority?.trustStoreHash || null,
    kmsHardwareAuthorityVerificationReceiptHash:
      kmsHardwareAuthority?.verificationReceiptHash || null,
    kmsHardwareAuthorityAttestedAt:
      kmsHardwareAuthority?.attestedAt || null,
    kmsHardwareAuthorityExpiresAt:
      kmsHardwareAuthority?.expiresAt || null,
    kmsHardwareAuthorityIndependent:
      kmsHardwareAuthority?.authorityIndependent === true,
    kmsHardwareAuthorityVerifiedKeyIds:
      kmsHardwareAuthority?.verifiedKeyIds || Object.freeze([]),
    kmsHardwareAuthorityBlockers:
      kmsHardwareAuthority?.blockers || Object.freeze([]),
    kmsProvider: descriptor?.kmsProvider || null,
    kmsProviderAccountIdentityHash:
      descriptor?.providerAccountIdentityHash || null,
    kmsKeyResourceIdentityHash:
      descriptor?.keyResourceIdentityHash || null,
    kmsCredentialGenerationIdentityHash:
      descriptor?.credentialGenerationIdentityHash || null,
    backendKind: descriptor?.backendKind || null,
    backendId: descriptor?.backendId || null,
    backendVersion: descriptor?.backendVersion || null,
    backendProductionEligible: descriptor?.productionEligible === true,
    backendDescriptorHash:
      descriptor?.researchExecutionReleaseSignerBackendDescriptorHash || null,
    backendCommandIdentityHash: descriptor?.commandIdentityHash || null,
    backendProbeCommandIdentityHash:
      descriptor?.probeCommandIdentityHash || null,
    signerBackendAssurance: descriptor?.productionEligible === true
      ? probe.verified === true && signerChallenge.verified === true
        ? descriptor.backendKind
          === RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.DEDICATED_UID_COMMAND
          ? 'independently-probed-and-active-key-challenged-dedicated-host-uid-signer-v1'
          : 'independently-probed-and-active-key-challenged-hardware-protected-nonexportable-signer-v2'
        : 'production-backend-configured-live-verification-not-performed-v1'
      : 'local-file-private-key-main-process-degraded-v1',
    signerBackendAssuranceProfile: descriptor?.assuranceProfile || null,
    signerBackendThreatBoundary: descriptor?.threatBoundary || null,
    hardwareProtected: descriptor?.hardwareProtected === true,
    privateKeyExportable: descriptor?.privateKeyExportable !== false,
    externalSignerProcess: descriptor?.externalSignerProcess === true,
    privateKeyLoadedIntoMainProcess:
      descriptor?.backendKind
        === RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.LOCAL_FILE,
    credentialMaterialReadByMainProcess:
      descriptor?.credentialMaterialReadByMainProcess !== false,
    independentBackendProbeVerified: probe.verified === true,
    backendProbeExternalActionAttempted: probeAttempted === true,
    backendProbeAttestationHash:
      probe.attestation
        ?.researchExecutionReleaseSignerBackendProbeAttestationHash || null,
    backendProbeAttestorKeyId:
      configuration?.probeAttestor?.signer.keyId || null,
    backendProbeAttestorKeyVersion:
      configuration?.probeAttestor?.signer.keyVersion || null,
    backendProbeAttestorSubjectId:
      configuration?.probeAttestor?.signer.subjectId || null,
    backendProbeAttestorOrganization:
      configuration?.probeAttestor?.signer.organization || null,
    backendProbeAttestorRole:
      configuration?.probeAttestor?.signer.role || null,
    backendProbeAttestorAlgorithm:
      configuration?.probeAttestor?.signer.algorithm || null,
    backendProbeAttestorEffectiveFrom:
      configuration?.probeAttestor?.effectiveFrom || null,
    backendProbeAttestorExpiresAt:
      configuration?.probeAttestor?.expiresAt || null,
    backendProbeAttestorPublicKeySpkiHash:
      configuration?.probeAttestor?.publicKeySpkiHash || null,
    activeSignerChallengeVerified: signerChallenge.verified === true,
    activeSignerChallengeExternalActionAttempted:
      signerChallenge.attempted === true,
    activeSignerChallengeSigningPayloadHash:
      signerChallenge.signingPayloadHash || null,
    activeSignerChallengeVerificationHash:
      signerChallenge.verificationHash || null,
    externalActionPerformed:
      probeAttempted === true || signerChallenge.attempted === true,
    externalActionScope: signerChallenge.attempted === true
      ? 'independent_release_backend_probe_and_active_key_signature_challenge'
      : probeAttempted === true ? 'independent_release_backend_probe' : 'none',
    privateKeyDisclosed: false,
    productionBlockers: uniqueProductionBlockers,
    fullProductionBlockers,
    blockers: uniqueBlockers,
  });
}

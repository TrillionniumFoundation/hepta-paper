import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  buildCampaignReleaseExecutionAttestationUnsignedPayload,
  campaignReleaseExecutionAttestationCurrentAt,
  campaignReleaseExecutionAttestationSigningPayloadHash,
  finalizeCampaignReleaseExecutionAttestation,
  verifyCampaignReleaseExecutionAttestationStructure,
} from '../../paper-domain/automation/campaign-release-execution-attestation-contract.mjs';
import { assertResearchExecutionReleaseAttestorPort } from '../../paper-ports/research-execution-release-attestor-port.mjs';
import { readProvisionedReleaseAttestorConfiguration } from './research-execution-release-attestor-configuration.mjs';
import {
  RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTATION_MAXIMUM_LIFETIME_MS,
} from '../../paper-domain/automation/research-execution-release-kms-hardware-attestation-contract.mjs';
import {
  inspectResearchExecutionReleaseAttestorConfiguration,
  inspectResearchExecutionReleaseAttestorConfigurationAsync,
} from './research-execution-release-attestor-inspection.mjs';
import {
  configurationAuthorizesExternalKmsAction,
  configurationAuthorizesExternalKmsTrust,
  inspectKmsHardwareAuthority,
  signerAuthorizationDeadline,
} from './research-execution-release-attestor-inspection-support.mjs';

export {
  inspectResearchExecutionReleaseAttestorConfiguration,
  inspectResearchExecutionReleaseAttestorConfigurationAsync,
};

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const SIGNATURE = /^[A-Za-z0-9+/]{80,120}={0,2}$/;

function canonicalTimestamp(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : null;
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

export function createResearchExecutionReleaseAttestor({
  runtimeRoot,
  configPath = null,
  expectedConfigurationHash = null,
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
    runtimeRoot,
    configPath,
    expectedConfigurationHash,
    environment,
    spawnSyncImpl,
    randomBytesImpl,
  });
  return assertResearchExecutionReleaseAttestorPort(Object.freeze({
    version: 1,
    kind: 'ResearchExecutionReleaseAttestorPort',
    inspectConfiguration() {
      return inspectResearchExecutionReleaseAttestorConfiguration({
        runtimeRoot,
        configPath,
        expectedConfigurationHash,
        now: now(),
        environment,
        spawnSyncImpl,
        randomBytesImpl,
        clock: { now },
      });
    },
    verifyAttestation({ attestation, manifest, manifestFileHash } = {}) {
      const observedAt = now();
      const read = readConfiguration();
      const descriptor = read.configuration?.backendPort?.describeBackend() || null;
      if (!read.configuration
        || !configurationAuthorizesExternalKmsTrust(read.configuration, descriptor)) {
        return false;
      }
      const structure = verifyCampaignReleaseExecutionAttestationStructure(attestation, {
        manifest,
        researchEvidenceCapsuleManifestHash: manifest?.researchEvidenceCapsuleManifestHash,
        researchEvidenceCapsuleManifestFileHash: manifestFileHash,
      });
      if (!campaignReleaseExecutionAttestationCurrentAt(attestation, observedAt)) {
        return false;
      }
      const key = matchingTrustedKey(read.configuration, attestation, {
        signedAt: attestation?.signedAt,
        verificationTime: observedAt,
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
      const observedAt = now();
      const read = readConfiguration();
      const descriptor = read.configuration?.backendPort?.describeBackend() || null;
      if (!read.configuration
        || !configurationAuthorizesExternalKmsTrust(read.configuration, descriptor)
        || !SHA256.test(String(signingPayloadHash || ''))
        || !SIGNATURE.test(String(signature || ''))) return false;
      const key = matchingTrustedKey(read.configuration, signer, {
        signedAt,
        verificationTime: observedAt,
      });
      if (!key) return false;
      try {
        return crypto.verify(null, Buffer.from(signingPayloadHash, 'utf8'), key.publicKey,
          Buffer.from(signature, 'base64'));
      } catch { return false; }
    },
    attestCapsuleManifest({ manifest, manifestFileHash, signedAt = null } = {}) {
      const requestedSignedAt = signedAt ?? manifest?.createdAt ?? null;
      const timestamp = canonicalTimestamp(String(requestedSignedAt || ''));
      const manifestCreatedAt = canonicalTimestamp(String(manifest?.createdAt || ''));
      if (timestamp === null || manifestCreatedAt !== timestamp) {
        throw new Error('research_execution_release_attestor_signing_time_not_current');
      }
      const observedAt = new Date(timestamp);
      const read = readConfiguration();
      if (!read.configuration) throw new Error(read.blocker);
      const configuration = read.configuration;
      const descriptor = configuration.backendPort.describeBackend();
      const actionTimestamp = now().getTime();
      if (!Number.isFinite(actionTimestamp)
        || timestamp > actionTimestamp
        || actionTimestamp - timestamp
          > RESEARCH_EXECUTION_RELEASE_KMS_HARDWARE_ATTESTATION_MAXIMUM_LIFETIME_MS) {
        throw new Error('research_execution_release_attestor_signing_time_not_current');
      }
      if (!configurationAuthorizesExternalKmsTrust(configuration, descriptor)) {
        throw new Error('research_execution_release_attestor_config_pin_required');
      }
      const activeKey = configuration.activeKey;
      const keyExpiresAt = Date.parse(activeKey.expiresAt);
      if (!Number.isFinite(timestamp) || timestamp < Date.parse(activeKey.effectiveFrom)
        || timestamp >= keyExpiresAt
        || actionTimestamp < Date.parse(activeKey.effectiveFrom)
        || actionTimestamp >= keyExpiresAt
        || activeKey.status !== 'active'
        || activeKey.revokedAt !== null) {
        throw new Error('research_execution_release_attestor_key_not_valid_at_signing_time');
      }
      const kmsHardwareAuthority = inspectKmsHardwareAuthority(
        configuration,
        descriptor,
        actionTimestamp,
      );
      if (!configurationAuthorizesExternalKmsAction(
        configuration,
        descriptor,
        kmsHardwareAuthority,
      )) {
        throw new Error(
          'research_execution_release_attestor_kms_hardware_authority_attestation_required',
        );
      }
      const expiresAt = Math.min(timestamp + configuration.lifetimeMs, keyExpiresAt);
      if (expiresAt <= actionTimestamp) {
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
      const signingActionTimestamp = now().getTime();
      const currentKmsHardwareAuthority = inspectKmsHardwareAuthority(
        configuration,
        descriptor,
        signingActionTimestamp,
      );
      if (!Number.isFinite(signingActionTimestamp)
        || signingActionTimestamp < actionTimestamp
        || signingActionTimestamp < timestamp
        || signingActionTimestamp < Date.parse(activeKey.effectiveFrom)
        || signingActionTimestamp >= keyExpiresAt) {
        throw new Error('research_execution_release_attestor_key_not_valid_at_signing_time');
      }
      if (expiresAt <= signingActionTimestamp) {
        throw new Error('research_execution_release_attestor_expiry_invalid');
      }
      if (!configurationAuthorizesExternalKmsAction(
          configuration,
          descriptor,
          currentKmsHardwareAuthority,
        )) {
        throw new Error(
          'research_execution_release_attestor_kms_hardware_authority_attestation_required',
        );
      }
      const authorizationDeadline = signerAuthorizationDeadline(
        configuration,
        expiresAt,
      );
      if (!Number.isFinite(authorizationDeadline)
        || authorizationDeadline <= signingActionTimestamp) {
        throw new Error('research_execution_release_attestor_signing_authorization_expired');
      }
      const signature = configuration.backendPort.signDigest({
        signingPayloadHash,
        keyId: activeKey.signer.keyId,
        keyVersion: activeKey.signer.keyVersion,
        ...(configuration.configurationVersion === 3 ? {
          authorizationExpiresAt: new Date(authorizationDeadline).toISOString(),
          maximumWaitMs: authorizationDeadline - signingActionTimestamp,
        } : {}),
      });
      const completedActionTimestamp = now().getTime();
      if (!Number.isFinite(completedActionTimestamp)
        || completedActionTimestamp < signingActionTimestamp
        || completedActionTimestamp >= authorizationDeadline) {
        throw new Error('research_execution_release_attestor_signing_authorization_expired');
      }
      const completedRead = readConfiguration();
      if (!completedRead.configuration) throw new Error(completedRead.blocker);
      const completedConfiguration = completedRead.configuration;
      const completedDescriptor = completedConfiguration.backendPort.describeBackend();
      const completedKey = completedConfiguration.activeKey;
      if (completedDescriptor.researchExecutionReleaseSignerBackendDescriptorHash
          !== descriptor.researchExecutionReleaseSignerBackendDescriptorHash
        || completedKey?.publicKeySpkiHash !== activeKey.publicKeySpkiHash
        || completedKey?.signer.keyId !== activeKey.signer.keyId
        || completedKey?.signer.keyVersion !== activeKey.signer.keyVersion
        || completedKey?.status !== 'active'
        || completedKey?.revokedAt !== null
        || completedActionTimestamp < Date.parse(completedKey?.effectiveFrom)
        || completedActionTimestamp >= Date.parse(completedKey?.expiresAt)) {
        throw new Error(
          'research_execution_release_attestor_configuration_changed_during_signing',
        );
      }
      const completedKmsHardwareAuthority = inspectKmsHardwareAuthority(
        completedConfiguration,
        completedDescriptor,
        completedActionTimestamp,
      );
      if (!configurationAuthorizesExternalKmsAction(
        completedConfiguration,
        completedDescriptor,
        completedKmsHardwareAuthority,
      )) {
        throw new Error(
          'research_execution_release_attestor_kms_hardware_authority_attestation_required',
        );
      }
      if (!crypto.verify(null, Buffer.from(signingPayloadHash, 'utf8'), completedKey.publicKey,
        Buffer.from(signature, 'base64'))) {
        throw new Error('research_execution_release_attestor_signature_self_verification_failed');
      }
      return finalizeCampaignReleaseExecutionAttestation({ unsignedPayload, signature });
    },
  }));
}

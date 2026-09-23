import fs from 'node:fs';
import path from 'node:path';
import {
  verifyAutonomousSubmissionMetadataProfile,
} from '../../paper-domain/automation/autonomous-submission-metadata-contract.mjs';
import {
  buildAutonomousConfigurationAuthorityProof,
} from '../../paper-domain/automation/autonomous-configuration-authority-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CONFIG_KEYS = Object.freeze([
  'authorityEnvelope', 'configurationHash', 'expectedKeyIds', 'kind',
  'maximumLifetimeMs', 'profile', 'trustStore', 'version',
]);

export function buildSignedAutonomousSubmissionMetadataProfileConfiguration({
  profile,
  trustStore,
  authorityEnvelope,
  expectedKeyIds,
  maximumLifetimeMs = 24 * 60 * 60 * 1_000,
  observedAt,
} = {}) {
  if (!verifyAutonomousSubmissionMetadataProfile(profile)) {
    throw new Error('signed_autonomous_submission_metadata_profile_invalid');
  }
  const authorityProof = buildAutonomousConfigurationAuthorityProof({
    subjectKind: 'AutonomousSubmissionMetadataProfile',
    subjectHash: profile.profileHash,
    requiredRole: 'submission_metadata_authority',
    trustStore,
    authorityEnvelope,
    expectedKeyIds,
    maximumLifetimeMs,
  }, { observedAt });
  return Object.freeze({
    version: 2,
    kind: 'SignedAutonomousSubmissionMetadataProfileConfiguration',
    profile,
    trustStore,
    authorityEnvelope,
    expectedKeyIds: authorityProof.expectedKeyIds,
    maximumLifetimeMs: authorityProof.maximumLifetimeMs,
    configurationHash: authorityProof.configurationHash,
  });
}

export function readAutonomousSubmissionMetadataProfile({
  configPath,
  expectedConfigurationHash = null,
  now = new Date(),
} = {}) {
  const candidate = path.resolve(String(configPath || ''));
  let profile = null;
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
      throw new Error('invalid');
    }
    profile = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  } catch {
    throw new Error('autonomous_submission_metadata_profile_config_invalid');
  }
  if (verifyAutonomousSubmissionMetadataProfile(profile)) {
    if (expectedConfigurationHash !== null) {
      throw new Error('autonomous_submission_metadata_configuration_pin_invalid');
    }
    return Object.freeze(profile);
  }
  if (!hasExactObjectKeys(profile, CONFIG_KEYS)
    || profile?.version !== 2
    || profile?.kind !== 'SignedAutonomousSubmissionMetadataProfileConfiguration'
    || !SHA256.test(String(profile?.configurationHash || ''))
    || !verifyAutonomousSubmissionMetadataProfile(profile?.profile)) {
    throw new Error('autonomous_submission_metadata_profile_verification_failed');
  }
  let authorityProof = null;
  try {
    authorityProof = buildAutonomousConfigurationAuthorityProof({
      subjectKind: 'AutonomousSubmissionMetadataProfile',
      subjectHash: profile.profile.profileHash,
      requiredRole: 'submission_metadata_authority',
      trustStore: profile.trustStore,
      authorityEnvelope: profile.authorityEnvelope,
      expectedKeyIds: profile.expectedKeyIds,
      maximumLifetimeMs: profile.maximumLifetimeMs,
    }, { observedAt: new Date(now).toISOString() });
  } catch {
    throw new Error('autonomous_submission_metadata_profile_authority_invalid');
  }
  if (authorityProof.configurationHash !== profile.configurationHash
    || (expectedConfigurationHash !== null
      && expectedConfigurationHash !== profile.configurationHash)) {
    throw new Error('autonomous_submission_metadata_configuration_pin_invalid');
  }
  return Object.freeze({
    version: 2,
    kind: 'VerifiedAutonomousSubmissionMetadataProfileConfiguration',
    profile: Object.freeze(profile.profile),
    authorityProof,
    configurationHash: profile.configurationHash,
    configurationPinned: expectedConfigurationHash === profile.configurationHash,
    cryptographicAuthorityReady: true,
    trustSetHash: authorityProof.trustSetHash,
    signatureVerificationPolicyHash: authorityProof.signatureVerificationPolicyHash,
  });
}

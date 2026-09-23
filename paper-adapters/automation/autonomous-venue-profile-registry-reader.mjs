import fs from 'node:fs';
import path from 'node:path';
import {
  verifyAutonomousVenueProfileRegistry,
} from '../../paper-domain/automation/autonomous-venue-profile-contract.mjs';
import {
  buildAutonomousConfigurationAuthorityProof,
} from '../../paper-domain/automation/autonomous-configuration-authority-contract.mjs';
import {
  buildAutonomousVenueTemplateAssetBundle,
  verifyAutonomousVenueTemplateAssetBundle,
} from '../../paper-domain/automation/autonomous-venue-template-asset-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CONFIG_KEYS_V2 = Object.freeze([
  'authorityEnvelope', 'configurationHash', 'expectedKeyIds', 'kind',
  'maximumLifetimeMs', 'registry', 'trustStore', 'version',
]);
const CONFIG_KEYS_V3 = Object.freeze([
  ...CONFIG_KEYS_V2,
  'templateAssetBundle',
].sort());
const TEMPLATE_ASSET_SUBJECT_KIND = 'AutonomousVenueTemplateAssetBundle';

export function buildSignedAutonomousVenueProfileRegistryConfiguration({
  registry,
  trustStore,
  authorityEnvelope,
  expectedKeyIds,
  maximumLifetimeMs = 24 * 60 * 60 * 1_000,
  observedAt,
  templateAssets = null,
} = {}) {
  if (!verifyAutonomousVenueProfileRegistry(registry)
    || ![2, 3].includes(registry.version)) {
    throw new Error('signed_autonomous_venue_profile_registry_invalid');
  }
  const configurationVersion = registry.version === 3 ? 3 : 2;
  if (configurationVersion === 2 && templateAssets !== null) {
    throw new Error('signed_autonomous_venue_profile_template_assets_unexpected');
  }
  const templateAssetBundle = configurationVersion === 3
    ? buildAutonomousVenueTemplateAssetBundle({ registry, assets: templateAssets })
    : null;
  const authorityProof = buildAutonomousConfigurationAuthorityProof({
    subjectKind: templateAssetBundle
      ? TEMPLATE_ASSET_SUBJECT_KIND : 'AutonomousVenueProfileRegistry',
    subjectHash: templateAssetBundle
      ? templateAssetBundle.autonomousVenueTemplateAssetBundleHash
      : registry.autonomousVenueProfileRegistryHash,
    requiredRole: 'venue_profile_authority',
    trustStore,
    authorityEnvelope,
    expectedKeyIds,
    maximumLifetimeMs,
  }, { observedAt });
  return Object.freeze({
    version: configurationVersion,
    kind: 'SignedAutonomousVenueProfileRegistryConfiguration',
    registry,
    ...(templateAssetBundle ? { templateAssetBundle } : {}),
    trustStore,
    authorityEnvelope,
    expectedKeyIds: authorityProof.expectedKeyIds,
    maximumLifetimeMs: authorityProof.maximumLifetimeMs,
    configurationHash: authorityProof.configurationHash,
  });
}

export function readAutonomousVenueProfileRegistry({
  configPath,
  expectedConfigurationHash = null,
  now = new Date(),
} = {}) {
  const candidate = path.resolve(String(configPath || ''));
  let stat;
  let registry;
  try {
    stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
      throw new Error('invalid');
    }
    registry = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  } catch { throw new Error('autonomous_venue_profile_registry_config_invalid'); }
  if (verifyAutonomousVenueProfileRegistry(registry)) {
    if (expectedConfigurationHash !== null) {
      throw new Error('autonomous_venue_profile_registry_configuration_pin_invalid');
    }
    return Object.freeze(registry);
  }
  const signedVersion = registry?.version;
  if (!hasExactObjectKeys(
    registry,
    signedVersion === 3 ? CONFIG_KEYS_V3 : CONFIG_KEYS_V2,
  )
    || ![2, 3].includes(signedVersion)
    || registry?.kind !== 'SignedAutonomousVenueProfileRegistryConfiguration'
    || !SHA256.test(String(registry?.configurationHash || ''))
    || !verifyAutonomousVenueProfileRegistry(registry?.registry)
    || registry.registry.version !== signedVersion
    || (signedVersion === 3 && !verifyAutonomousVenueTemplateAssetBundle(
      registry.templateAssetBundle,
      { registry: registry.registry },
    ))) {
    throw new Error('autonomous_venue_profile_registry_verification_failed');
  }
  const templateAssetBundle = signedVersion === 3
    ? buildAutonomousVenueTemplateAssetBundle({
      registry: registry.registry,
      assets: registry.templateAssetBundle.assets,
    }) : null;
  let authorityProof = null;
  try {
    authorityProof = buildAutonomousConfigurationAuthorityProof({
      subjectKind: templateAssetBundle
        ? TEMPLATE_ASSET_SUBJECT_KIND : 'AutonomousVenueProfileRegistry',
      subjectHash: templateAssetBundle
        ? templateAssetBundle.autonomousVenueTemplateAssetBundleHash
        : registry.registry.autonomousVenueProfileRegistryHash,
      requiredRole: 'venue_profile_authority',
      trustStore: registry.trustStore,
      authorityEnvelope: registry.authorityEnvelope,
      expectedKeyIds: registry.expectedKeyIds,
      maximumLifetimeMs: registry.maximumLifetimeMs,
    }, { observedAt: new Date(now).toISOString() });
  } catch {
    throw new Error('autonomous_venue_profile_registry_authority_invalid');
  }
  if (authorityProof.configurationHash !== registry.configurationHash
    || (expectedConfigurationHash !== null
      && expectedConfigurationHash !== registry.configurationHash)) {
    throw new Error('autonomous_venue_profile_registry_configuration_pin_invalid');
  }
  return Object.freeze({
    version: signedVersion,
    kind: 'VerifiedAutonomousVenueProfileRegistryConfiguration',
    registry: Object.freeze(registry.registry),
    ...(templateAssetBundle ? {
      templateAssetBundle,
      templateAssets: templateAssetBundle.assets,
    } : {}),
    authorityProof,
    configurationHash: registry.configurationHash,
    configurationPinned: expectedConfigurationHash === registry.configurationHash,
    cryptographicAuthorityReady: true,
    trustSetHash: authorityProof.trustSetHash,
    signatureVerificationPolicyHash: authorityProof.signatureVerificationPolicyHash,
  });
}

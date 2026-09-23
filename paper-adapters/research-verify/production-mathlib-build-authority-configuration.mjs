import path from 'node:path';

import {
  readImmutableJsonDocument,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import {
  buildProductionMathlibBuildAuthority,
  buildSignedProductionMathlibBuildAuthority,
} from './production-mathlib-build-authority.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export const PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIG_ENV =
  'HEPTA_PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIG';
export const PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIGURATION_HASH_ENV =
  'HEPTA_PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIGURATION_HASH';

export function inspectConfiguredProductionMathlibBuildAuthority({
  environment = process.env,
  formalProjectClosureHash,
  productionMathlibReleaseIdentityHash,
  trustedClosureHashes,
  observedAt = new Date().toISOString(),
} = {}) {
  const configPath = String(
    environment?.[PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIG_ENV] || '',
  ).trim();
  const expectedConfigurationHash = String(
    environment?.[PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIGURATION_HASH_ENV] || '',
  ).trim().toLowerCase();
  if (!configPath && !expectedConfigurationHash) {
    return buildProductionMathlibBuildAuthority({
      formalProjectClosureHash,
      productionMathlibReleaseIdentityHash,
      trustedClosureHashes,
    });
  }
  if (!configPath || !path.isAbsolute(configPath)
    || !SHA256.test(expectedConfigurationHash)) {
    throw new Error('production_mathlib_build_authority_configuration_pin_required');
  }
  const configuration = readImmutableJsonDocument(configPath, {
    maximumBytes: 1024 * 1024,
  });
  const authority = buildSignedProductionMathlibBuildAuthority(configuration, {
    observedAt,
    expectedConfigurationHash,
  });
  if (authority.formalProjectClosureHash !== formalProjectClosureHash
    || authority.productionMathlibReleaseIdentityHash
      !== productionMathlibReleaseIdentityHash) {
    throw new Error('production_mathlib_build_authority_subject_drift');
  }
  return authority;
}

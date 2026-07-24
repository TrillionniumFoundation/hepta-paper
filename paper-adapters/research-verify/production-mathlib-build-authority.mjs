import {
  PRODUCTION_LEAN_TOOLCHAIN,
  PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES,
  PRODUCTION_MATHLIB_BUILD_CLOSURE_HASHES,
  PRODUCTION_MATHLIB_RELEASES,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import {
  buildAutonomousConfigurationAuthorityProof,
  verifyAutonomousConfigurationAuthorityProof,
} from '../../paper-domain/automation/autonomous-configuration-authority-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
export const PRODUCTION_MATHLIB_BUILD_AUTHORITY_ROLE =
  'production_mathlib_build_authority';

const AUTHORIZATION_KEYS = Object.freeze([
  'formalProjectClosureHash', 'kind', 'productionMathlibReleaseIdentityHash',
  'productionMathlibReleasePolicyHash', 'toolchain',
  'toolchainRootMerkleHash', 'version',
]);
const SIGNED_CONFIGURATION_KEYS = Object.freeze([
  'authorityEnvelope', 'authorization', 'configurationHash', 'expectedKeyIds',
  'kind', 'maximumLifetimeMs', 'trustStore', 'version',
]);
const SIGNED_AUTHORITY_KEYS = Object.freeze([
  'authorityProof', 'authorizationType', 'blockers', 'configurationHash',
  'configurationPinned', 'formalProjectClosureHash', 'kind',
  'productionMathlibBuildAuthorityHash',
  'productionMathlibReleaseIdentityHash', 'productionMathlibReleasePolicyHash',
  'status', 'toolchain', 'toolchainRootMerkleHash', 'version',
]);

function configuredHashes() {
  return PRODUCTION_MATHLIB_BUILD_CLOSURE_HASHES[PRODUCTION_LEAN_TOOLCHAIN] || [];
}

export function productionMathlibReleasePolicyHash() {
  return hashRecord('ProductionMathlibReleasePolicy', {
    toolchain: PRODUCTION_LEAN_TOOLCHAIN,
    toolchainRootMerkleHash:
      PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES[PRODUCTION_LEAN_TOOLCHAIN],
    release: PRODUCTION_MATHLIB_RELEASES[PRODUCTION_LEAN_TOOLCHAIN],
  });
}

export function buildProductionMathlibBuildAuthorization({
  formalProjectClosureHash,
  productionMathlibReleaseIdentityHash,
} = {}) {
  if (!SHA256.test(String(formalProjectClosureHash || ''))
    || !SHA256.test(String(productionMathlibReleaseIdentityHash || ''))) {
    throw new Error('production_mathlib_build_authorization_identity_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'ProductionMathlibBuildAuthorization',
    toolchain: PRODUCTION_LEAN_TOOLCHAIN,
    toolchainRootMerkleHash:
      PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES[PRODUCTION_LEAN_TOOLCHAIN],
    productionMathlibReleasePolicyHash: productionMathlibReleasePolicyHash(),
    productionMathlibReleaseIdentityHash,
    formalProjectClosureHash,
  });
}

export function productionMathlibBuildAuthorizationHash(authorization) {
  return hashRecord('ProductionMathlibBuildAuthorization', authorization);
}

export function verifyProductionMathlibBuildAuthorization(authorization) {
  if (!hasExactObjectKeys(authorization, AUTHORIZATION_KEYS)) return false;
  let expected;
  try {
    expected = buildProductionMathlibBuildAuthorization(authorization);
  } catch { return false; }
  return JSON.stringify(expected) === JSON.stringify(authorization);
}

export function buildSignedProductionMathlibBuildAuthorityConfiguration({
  authorization,
  trustStore,
  authorityEnvelope,
  expectedKeyIds,
  maximumLifetimeMs = 24 * 60 * 60 * 1_000,
  observedAt,
} = {}) {
  if (!verifyProductionMathlibBuildAuthorization(authorization)) {
    throw new Error('signed_production_mathlib_build_authorization_invalid');
  }
  const authorityProof = buildAutonomousConfigurationAuthorityProof({
    subjectKind: 'ProductionMathlibBuildAuthorization',
    subjectHash: productionMathlibBuildAuthorizationHash(authorization),
    requiredRole: PRODUCTION_MATHLIB_BUILD_AUTHORITY_ROLE,
    trustStore,
    authorityEnvelope,
    expectedKeyIds,
    maximumLifetimeMs,
  }, { observedAt });
  return Object.freeze({
    version: 1,
    kind: 'SignedProductionMathlibBuildAuthorityConfiguration',
    authorization,
    trustStore,
    authorityEnvelope,
    expectedKeyIds: authorityProof.expectedKeyIds,
    maximumLifetimeMs: authorityProof.maximumLifetimeMs,
    configurationHash: authorityProof.configurationHash,
  });
}

export function verifySignedProductionMathlibBuildAuthorityConfiguration(
  configuration,
  { observedAt, expectedConfigurationHash = null } = {},
) {
  if (!hasExactObjectKeys(configuration, SIGNED_CONFIGURATION_KEYS)
    || configuration?.version !== 1
    || configuration?.kind
      !== 'SignedProductionMathlibBuildAuthorityConfiguration'
    || !verifyProductionMathlibBuildAuthorization(configuration.authorization)
    || !SHA256.test(String(configuration?.configurationHash || ''))
    || (expectedConfigurationHash !== null
      && configuration.configurationHash !== expectedConfigurationHash)) return false;
  let authorityProof;
  try {
    authorityProof = buildAutonomousConfigurationAuthorityProof({
      subjectKind: 'ProductionMathlibBuildAuthorization',
      subjectHash: productionMathlibBuildAuthorizationHash(
        configuration.authorization,
      ),
      requiredRole: PRODUCTION_MATHLIB_BUILD_AUTHORITY_ROLE,
      trustStore: configuration.trustStore,
      authorityEnvelope: configuration.authorityEnvelope,
      expectedKeyIds: configuration.expectedKeyIds,
      maximumLifetimeMs: configuration.maximumLifetimeMs,
    }, { observedAt });
  } catch { return false; }
  return authorityProof.configurationHash === configuration.configurationHash;
}

export function buildSignedProductionMathlibBuildAuthority(configuration, {
  observedAt,
  expectedConfigurationHash,
} = {}) {
  if (!SHA256.test(String(expectedConfigurationHash || ''))
    || !verifySignedProductionMathlibBuildAuthorityConfiguration(configuration, {
      observedAt,
      expectedConfigurationHash,
    })) {
    throw new Error('production_mathlib_build_authority_configuration_invalid');
  }
  const authorization = configuration.authorization;
  const authorityProof = buildAutonomousConfigurationAuthorityProof({
    subjectKind: 'ProductionMathlibBuildAuthorization',
    subjectHash: productionMathlibBuildAuthorizationHash(authorization),
    requiredRole: PRODUCTION_MATHLIB_BUILD_AUTHORITY_ROLE,
    trustStore: configuration.trustStore,
    authorityEnvelope: configuration.authorityEnvelope,
    expectedKeyIds: configuration.expectedKeyIds,
    maximumLifetimeMs: configuration.maximumLifetimeMs,
  }, { observedAt });
  const payload = {
    version: 2,
    kind: 'ProductionMathlibBuildAuthority',
    status: 'production_mathlib_build_authority_verified',
    authorizationType: 'independent_ed25519_signed_configuration',
    toolchain: authorization.toolchain,
    toolchainRootMerkleHash: authorization.toolchainRootMerkleHash,
    productionMathlibReleasePolicyHash:
      authorization.productionMathlibReleasePolicyHash,
    formalProjectClosureHash: authorization.formalProjectClosureHash,
    productionMathlibReleaseIdentityHash:
      authorization.productionMathlibReleaseIdentityHash,
    configurationHash: configuration.configurationHash,
    configurationPinned: true,
    authorityProof,
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...payload,
    productionMathlibBuildAuthorityHash: hashRecord(
      'ProductionMathlibBuildAuthority', payload,
    ),
  });
}

export function buildProductionMathlibBuildAuthority({
  formalProjectClosureHash,
  productionMathlibReleaseIdentityHash,
  trustedClosureHashes = configuredHashes(),
} = {}) {
  const allowlist = Object.freeze([...new Set(trustedClosureHashes)].sort());
  const authorized = allowlist.includes(formalProjectClosureHash);
  const payload = {
    version: 1,
    kind: 'ProductionMathlibBuildAuthority',
    status: authorized
      ? 'production_mathlib_build_authority_verified'
      : 'production_mathlib_build_authority_blocked',
    authorizationType: 'code_reviewed_closure_allowlist',
    toolchain: PRODUCTION_LEAN_TOOLCHAIN,
    formalProjectClosureHash,
    productionMathlibReleaseIdentityHash,
    trustedClosureAllowlistHash: hashRecord(
      'ProductionMathlibBuildClosureAllowlist', allowlist,
    ),
    blockers: Object.freeze(authorized
      ? [] : ['dynamic_formal_mathlib_build_authority_required']),
  };
  return Object.freeze({
    ...payload,
    productionMathlibBuildAuthorityHash: hashRecord(
      'ProductionMathlibBuildAuthority', payload,
    ),
  });
}

export function verifyProductionMathlibBuildAuthority(authority, {
  trustedClosureHashes = configuredHashes(),
  observedAt = new Date().toISOString(),
  expectedConfigurationHash = null,
} = {}) {
  if (authority?.version === 2) {
    if (!hasExactObjectKeys(authority, SIGNED_AUTHORITY_KEYS)) return false;
    const { productionMathlibBuildAuthorityHash, ...payload } = authority;
    let authorization;
    try {
      authorization = buildProductionMathlibBuildAuthorization(authority);
    } catch { return false; }
    return authority.kind === 'ProductionMathlibBuildAuthority'
      && authority.status === 'production_mathlib_build_authority_verified'
      && authority.authorizationType === 'independent_ed25519_signed_configuration'
      && authority.configurationPinned === true
      && SHA256.test(String(authority.configurationHash || ''))
      && (expectedConfigurationHash === null
        || authority.configurationHash === expectedConfigurationHash)
      && authority.toolchain === PRODUCTION_LEAN_TOOLCHAIN
      && authority.toolchainRootMerkleHash
        === PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES[PRODUCTION_LEAN_TOOLCHAIN]
      && authority.productionMathlibReleasePolicyHash
        === productionMathlibReleasePolicyHash()
      && verifyAutonomousConfigurationAuthorityProof(authority.authorityProof, {
        subjectKind: 'ProductionMathlibBuildAuthorization',
        subjectHash: productionMathlibBuildAuthorizationHash(authorization),
        requiredRole: PRODUCTION_MATHLIB_BUILD_AUTHORITY_ROLE,
        observedAt,
        expectedConfigurationHash: authority.configurationHash,
      })
      && Array.isArray(authority.blockers) && authority.blockers.length === 0
      && productionMathlibBuildAuthorityHash === hashRecord(
        'ProductionMathlibBuildAuthority', payload,
      );
  }
  const { productionMathlibBuildAuthorityHash, ...payload } = authority || {};
  const allowlist = Object.freeze([...new Set(trustedClosureHashes)].sort());
  return authority?.version === 1
    && authority?.kind === 'ProductionMathlibBuildAuthority'
    && authority?.status === 'production_mathlib_build_authority_verified'
    && authority?.authorizationType === 'code_reviewed_closure_allowlist'
    && authority?.toolchain === PRODUCTION_LEAN_TOOLCHAIN
    && SHA256.test(String(authority?.formalProjectClosureHash || ''))
    && allowlist.includes(authority.formalProjectClosureHash)
    && SHA256.test(String(authority?.productionMathlibReleaseIdentityHash || ''))
    && authority?.trustedClosureAllowlistHash === hashRecord(
      'ProductionMathlibBuildClosureAllowlist', allowlist,
    )
    && Array.isArray(authority?.blockers) && authority.blockers.length === 0
    && productionMathlibBuildAuthorityHash === hashRecord(
      'ProductionMathlibBuildAuthority', payload,
    );
}

import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const DESCRIPTOR_KEYS = Object.freeze([
  'capabilityReceiptHash', 'credentialConfigIdentityHash',
  'credentialRootIdentityHash', 'kind', 'modelIdentityHash', 'principalDescriptorHash',
  'principalId', 'provider', 'providerAccountIdentityHash', 'roles',
  'signerIdentityHash', 'trustDomainIdentityHash', 'version',
]);

function canonicalId(value) {
  const candidate = String(value || '').trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

function canonicalHash(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function canonicalRoles(values) {
  if (!Array.isArray(values) || !values.length || values.length > 16) return null;
  const roles = values.map(canonicalId);
  if (roles.some((role) => !role) || new Set(roles).size !== roles.length) return null;
  return Object.freeze([...roles].sort());
}

export function buildResearchPrincipalDescriptor({
  principalId,
  roles,
  provider,
  modelIdentityHash,
  providerAccountIdentityHash,
  credentialRootIdentityHash,
  credentialConfigIdentityHash,
  trustDomainIdentityHash,
  capabilityReceiptHash,
  signerIdentityHash,
} = {}) {
  const payload = {
    version: 1,
    kind: 'ResearchPrincipalDescriptor',
    principalId: canonicalId(principalId),
    roles: canonicalRoles(roles),
    provider: canonicalId(provider),
    modelIdentityHash: canonicalHash(modelIdentityHash),
    providerAccountIdentityHash: canonicalHash(providerAccountIdentityHash),
    credentialRootIdentityHash: canonicalHash(credentialRootIdentityHash),
    credentialConfigIdentityHash: canonicalHash(credentialConfigIdentityHash),
    trustDomainIdentityHash: canonicalHash(trustDomainIdentityHash),
    capabilityReceiptHash: canonicalHash(capabilityReceiptHash),
    signerIdentityHash: canonicalHash(signerIdentityHash),
  };
  if (Object.values(payload).some((value) => value === null)) {
    throw new Error('research_principal_descriptor_invalid');
  }
  return Object.freeze({
    ...payload,
    principalDescriptorHash: hashRecord('ResearchPrincipalDescriptor', payload),
  });
}

export function verifyResearchPrincipalDescriptor(descriptor) {
  if (!hasExactObjectKeys(descriptor, DESCRIPTOR_KEYS)) return false;
  try {
    const rebuilt = buildResearchPrincipalDescriptor(descriptor);
    return JSON.stringify(rebuilt) === JSON.stringify(descriptor);
  } catch { return false; }
}

export function buildResearchPrincipalPool({
  poolId,
  principals,
  minimumReviewerTrustDomains = 2,
} = {}) {
  const selectedPoolId = canonicalId(poolId);
  if (!selectedPoolId || !Array.isArray(principals) || !principals.length
    || principals.length > 32 || principals.some((principal) => (
      !verifyResearchPrincipalDescriptor(principal)
    )) || !Number.isSafeInteger(minimumReviewerTrustDomains)
    || minimumReviewerTrustDomains < 1 || minimumReviewerTrustDomains > principals.length) {
    throw new Error('research_principal_pool_invalid');
  }
  const selected = Object.freeze([...principals].sort((left, right) => (
    left.principalId.localeCompare(right.principalId)
  )));
  const reviewerPrincipals = selected.filter((principal) => (
    principal.roles.includes('formal-review') || principal.roles.includes('independent-review')
  ));
  const unique = (field) => new Set(reviewerPrincipals.map((principal) => principal[field])).size;
  const blockers = [];
  if (new Set(selected.map((principal) => principal.principalId)).size !== selected.length) {
    blockers.push('research_principal_pool_principal_ids_duplicate');
  }
  if (reviewerPrincipals.length < minimumReviewerTrustDomains
    || unique('providerAccountIdentityHash') < minimumReviewerTrustDomains
    || unique('credentialRootIdentityHash') < minimumReviewerTrustDomains
    || unique('trustDomainIdentityHash') < minimumReviewerTrustDomains) {
    blockers.push('research_principal_pool_reviewer_independence_insufficient');
  }
  const payload = {
    version: 1,
    kind: 'ResearchPrincipalPool',
    status: blockers.length ? 'research_principal_pool_blocked' : 'research_principal_pool_ready',
    poolId: selectedPoolId,
    principals: selected,
    principalCount: selected.length,
    reviewerPrincipalCount: reviewerPrincipals.length,
    reviewerProviderAccountCount: unique('providerAccountIdentityHash'),
    reviewerCredentialRootCount: unique('credentialRootIdentityHash'),
    reviewerTrustDomainCount: unique('trustDomainIdentityHash'),
    minimumReviewerTrustDomains,
    blockers: Object.freeze(blockers),
  };
  return Object.freeze({
    ...payload,
    researchPrincipalPoolHash: hashRecord('ResearchPrincipalPool', payload),
  });
}

export function verifyResearchPrincipalPool(pool) {
  let rebuilt = null;
  try { rebuilt = buildResearchPrincipalPool(pool); }
  catch { return false; }
  return JSON.stringify(rebuilt) === JSON.stringify(pool)
    && pool.status === 'research_principal_pool_ready';
}

export function selectResearchPrincipal({ pool, role, selectionKey } = {}) {
  if (!verifyResearchPrincipalPool(pool)) throw new Error('research_principal_pool_not_ready');
  const candidates = pool.principals.filter((principal) => principal.roles.includes(role));
  if (!candidates.length) throw new Error(`research_principal_pool_role_missing:${role}`);
  const selectionHash = hashRecord('ResearchPrincipalPoolSelection', {
    poolHash: pool.researchPrincipalPoolHash,
    role,
    selectionKey: String(selectionKey || ''),
  });
  const ordinalMatch = role === 'independent-review'
    ? String(selectionKey || '').match(/(?:revision-)?referee[-:]?(\d+)/i)
    : null;
  const ordinal = ordinalMatch ? Number(ordinalMatch[1]) : null;
  const index = Number.isSafeInteger(ordinal) && ordinal > 0
    ? (ordinal - 1) % candidates.length
    : Number.parseInt(selectionHash.slice(-8), 16) % candidates.length;
  return candidates[index];
}

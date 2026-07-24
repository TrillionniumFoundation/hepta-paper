import fs from 'node:fs';
import path from 'node:path';
import {
  buildReviewerReceiptSignerServiceConfiguration,
  verifyReviewerReceiptSignerServiceConfiguration,
} from './http-reviewer-receipt-signer-adapter.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const PRINCIPAL_KEYS = Object.freeze([
  'codexBinary', 'codexHome', 'model', 'providerAccountIdentityHash', 'roles',
  'signerConfiguration', 'trustDomainIdentityHash',
]);
const CONFIG_KEYS = Object.freeze([
  'configurationHash', 'kind', 'minimumReviewerTrustDomains', 'poolId',
  'principals', 'version',
]);

function canonicalRoles(values) {
  if (!Array.isArray(values) || !values.length || values.length > 2) return null;
  const selected = values.map((value) => String(value || '').trim());
  if (selected.some((value) => !['formal-review', 'independent-review'].includes(value))
    || new Set(selected).size !== selected.length) return null;
  return Object.freeze([...selected].sort());
}

function buildPrincipalConfiguration(value = {}) {
  if (!hasExactObjectKeys(value, PRINCIPAL_KEYS)) {
    throw new Error('reviewer_principal_configuration_shape_invalid');
  }
  const roles = canonicalRoles(value.roles);
  const codexBinary = String(value.codexBinary || '').trim();
  const codexHome = path.resolve(String(value.codexHome || ''));
  const model = String(value.model || '').trim();
  const providerAccountIdentityHash = String(value.providerAccountIdentityHash || '').toLowerCase();
  const trustDomainIdentityHash = String(value.trustDomainIdentityHash || '').toLowerCase();
  const signerConfiguration = buildReviewerReceiptSignerServiceConfiguration(
    value.signerConfiguration,
  );
  if (!roles || !codexBinary || !model || !path.isAbsolute(codexHome)
    || !SHA256.test(providerAccountIdentityHash)
    || !SHA256.test(trustDomainIdentityHash)
    || !verifyReviewerReceiptSignerServiceConfiguration(signerConfiguration)) {
    throw new Error('reviewer_principal_configuration_invalid');
  }
  return Object.freeze({
    roles,
    codexBinary,
    codexHome,
    model,
    providerAccountIdentityHash,
    trustDomainIdentityHash,
    signerConfiguration,
  });
}

export function buildReviewerPrincipalPoolConfiguration({
  version = 1,
  poolId,
  principals,
  minimumReviewerTrustDomains = 2,
} = {}) {
  if (![1, 2].includes(Number(version)) || !SAFE_ID.test(String(poolId || ''))
    || !Array.isArray(principals) || principals.length < 2 || principals.length > 16
    || !Number.isSafeInteger(Number(minimumReviewerTrustDomains))
    || Number(minimumReviewerTrustDomains) < 2
    || Number(minimumReviewerTrustDomains) > principals.length) {
    throw new Error('reviewer_principal_pool_configuration_invalid');
  }
  const selected = Object.freeze(principals.map(buildPrincipalConfiguration)
    .sort((left, right) => left.providerAccountIdentityHash.localeCompare(
      right.providerAccountIdentityHash,
    )));
  if (new Set(selected.map((item) => item.providerAccountIdentityHash)).size !== selected.length
    || new Set(selected.map((item) => item.codexHome)).size !== selected.length
    || new Set(selected.map((item) => item.trustDomainIdentityHash)).size
      < Number(minimumReviewerTrustDomains)
    || selected.filter((item) => item.roles.includes('formal-review')).length < 1
    || selected.filter((item) => item.roles.includes('independent-review')).length
      < Number(minimumReviewerTrustDomains)) {
    throw new Error('reviewer_principal_pool_configuration_independence_invalid');
  }
  if (Number(version) === 2
    && selected.some((item) => item.signerConfiguration.version !== 2)) {
    throw new Error('reviewer_principal_pool_cryptographic_signer_required');
  }
  const payload = {
    version: Number(version),
    kind: 'ReviewerPrincipalPoolConfiguration',
    poolId: String(poolId),
    principals: selected,
    minimumReviewerTrustDomains: Number(minimumReviewerTrustDomains),
  };
  return Object.freeze({
    ...payload,
    configurationHash: hashRecord('ReviewerPrincipalPoolConfiguration', payload),
  });
}

export function verifyReviewerPrincipalPoolConfiguration(configuration) {
  if (!hasExactObjectKeys(configuration, CONFIG_KEYS)) return false;
  try {
    return JSON.stringify(buildReviewerPrincipalPoolConfiguration(configuration))
      === JSON.stringify(configuration);
  } catch { return false; }
}

export function readReviewerPrincipalPoolConfiguration({ configPath } = {}) {
  const candidate = path.resolve(String(configPath || ''));
  let parsed;
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('invalid');
    parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  } catch { throw new Error('reviewer_principal_pool_configuration_file_invalid'); }
  if (!verifyReviewerPrincipalPoolConfiguration(parsed)) {
    throw new Error('reviewer_principal_pool_configuration_verification_failed');
  }
  return parsed;
}

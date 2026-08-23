import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExternalAuthorityConfiguration,
  buildExternalAuthorityConfigurationSet,
  inspectExternalAuthorityConfigurationSet,
  verifyExternalAuthorityConfiguration,
  verifyExternalAuthorityConfigurationSet,
} from '../../paper-domain/automation/external-authority-configuration-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-08-23T10:00:00.000Z');
const EXPIRES = '2026-08-23T11:00:00.000Z';

function H(label) {
  return hashRecord('ExternalAuthorityConfigurationTestValue', { label });
}

function authority({
  authorityId,
  role,
  organization,
  trustDomain,
  backendKind = 'external-attestation',
  hardwareProtected = false,
  privateKeyExportable = false,
  humanSingleUseAuthorizationRequired = false,
  independentOf = [],
} = {}) {
  return buildExternalAuthorityConfiguration({
    authorityId,
    role,
    subjectId: `${authorityId}-subject`,
    organization,
    trustDomain,
    backendKind,
    configurationPath: `/run/hepta/${authorityId}.json`,
    trustStorePath: `/run/hepta/${authorityId}-trust-store.json`,
    configurationContentHash: H(`${authorityId}:configuration`),
    trustStoreHash: H(`${authorityId}:trust-store`),
    attestationSubjectHash: H(`${authorityId}:subject`),
    attestationEnvelopeHash: H(`${authorityId}:envelope`),
    hardwareProtected,
    privateKeyExportable,
    independentOf,
    humanSingleUseAuthorizationRequired,
    externalActionAllowed: false,
    externalActionPerformed: false,
    expiresAt: EXPIRES,
  });
}

test('external authority references are hash-bound and structurally fail closed', () => {
  const config = authority({
    authorityId: 'release-attestor',
    role: 'release-attestor',
    organization: 'Independent KMS Authority',
    trustDomain: 'kms-domain',
    backendKind: 'external-kms-command',
    hardwareProtected: true,
  });
  assert.equal(verifyExternalAuthorityConfiguration(config), true);
  assert.equal(config.externalActionAllowed, false);
  assert.equal(config.externalActionPerformed, false);

  const tampered = { ...config, trustStoreHash: H('different-trust-store') };
  assert.equal(verifyExternalAuthorityConfiguration(tampered), false);

  const privateMaterial = { ...config, privateKeyPem: 'not accepted here' };
  assert.equal(verifyExternalAuthorityConfiguration(privateMaterial), false);
});

test('hardware and human-permit policies cannot be downgraded by configuration', () => {
  assert.throws(() => authority({
    authorityId: 'release-attestor',
    role: 'release-attestor',
    organization: 'Independent KMS Authority',
    trustDomain: 'kms-domain',
    backendKind: 'external-kms-command',
    hardwareProtected: false,
  }), /external_authority_configuration_policy_invalid/);

  assert.throws(() => authority({
    authorityId: 'portal-authorizer',
    role: 'portal-production-authorizer',
    organization: 'Independent Portal Authority',
    trustDomain: 'portal-domain',
    backendKind: 'portal-authority',
    independentOf: ['portal-observer'],
    humanSingleUseAuthorizationRequired: false,
  }), /external_authority_configuration_policy_invalid/);

  assert.throws(() => authority({
    authorityId: 'portal-observer',
    role: 'portal-observer',
    organization: 'Independent Portal Authority',
    trustDomain: 'portal-domain',
    backendKind: 'portal-authority',
    independentOf: ['portal-observer'],
  }), /external_authority_configuration_self_independence_invalid/);
});

test('authority set enforces role coverage and independent identity domains', () => {
  const author = authority({
    authorityId: 'research-author',
    role: 'research-author',
    organization: 'Research Provider',
    trustDomain: 'author-domain',
  });
  const reviewer = authority({
    authorityId: 'reviewer',
    role: 'independent-reviewer',
    organization: 'Independent Review Org',
    trustDomain: 'review-domain',
    independentOf: ['research-author'],
  });
  const qualifier = authority({
    authorityId: 'qualifier',
    role: 'external-qualifier',
    organization: 'Independent Qualifier Org',
    trustDomain: 'qualifier-domain',
    independentOf: ['research-author', 'reviewer'],
  });
  const set = buildExternalAuthorityConfigurationSet({
    entries: [qualifier, reviewer, author],
    requiredRoles: ['research-author', 'independent-reviewer', 'external-qualifier'],
    expiresAt: EXPIRES,
  });
  assert.equal(verifyExternalAuthorityConfigurationSet(set), true);

  const blockedWithoutVerifier = inspectExternalAuthorityConfigurationSet(set, { now: NOW });
  assert.equal(blockedWithoutVerifier.productionReady, false);
  assert.ok(blockedWithoutVerifier.blockers.includes(
    'external_authority_external_verifier_required',
  ));
  assert.equal(blockedWithoutVerifier.externalActionPerformed, false);

  const verified = inspectExternalAuthorityConfigurationSet(set, {
    now: NOW,
    verifyAuthority: () => true,
  });
  assert.equal(verified.productionReady, true);
  assert.equal(verified.cryptographicVerificationDelegated, true);

  const duplicateDomain = {
    ...qualifier,
    authorityId: 'qualifier-two',
    subjectId: 'qualifier-two-subject',
  };
  assert.throws(() => buildExternalAuthorityConfigurationSet({
    entries: [author, reviewer, qualifier, duplicateDomain],
    requiredRoles: ['research-author', 'independent-reviewer', 'external-qualifier'],
    expiresAt: EXPIRES,
  }), /external_authority_configuration_set_independence_or_coverage_invalid/);
});

test('authority set rejects stale expiry and path placeholders before any action', () => {
  const config = authority({
    authorityId: 'restore-authority',
    role: 'restore-authority',
    organization: 'Independent Restore Org',
    trustDomain: 'restore-domain',
    independentOf: ['research-authority'],
  });
  assert.throws(() => buildExternalAuthorityConfigurationSet({
    entries: [config],
    requiredRoles: ['restore-authority'],
    expiresAt: '2026-08-23T12:00:00.000Z',
  }), /external_authority_configuration_set_expiry_exceeds_entry/);
  assert.throws(() => buildExternalAuthorityConfiguration({
    ...config,
    configurationPath: '/run/hepta/REPLACE_WITH_AUTHORITY.json',
}), /external_authority_configuration_path_invalid/);
});

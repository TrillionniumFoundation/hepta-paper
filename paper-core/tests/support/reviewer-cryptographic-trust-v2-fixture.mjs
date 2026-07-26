import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertPinnedExternalEvidenceEnvelope,
  buildPinnedExternalEvidenceEnvelope,
  pinnedExternalEvidenceSigningPayload,
} from '../../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildReviewerReceiptSignerServiceConfiguration,
  buildReviewerSignerIdentityAttestationBundle,
} from '../../../paper-adapters/automation/http-reviewer-receipt-signer-adapter.mjs';
import {
  buildRecoverableReviewerExecutorServiceConfiguration,
} from '../../../paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs';
import {
  buildReviewerPrincipalPoolConfiguration,
} from '../../../paper-adapters/automation/reviewer-principal-pool-configuration-reader.mjs';
import {
  preflightReviewerPrincipalPool,
} from '../../../paper-composition/automation/reviewer-principal-pool-composition.mjs';
import {
  buildExternalPrincipalIdentityAttestationSubject,
} from '../../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import { buildExecutorCapabilities } from '../../../paper-ports/executor-capabilities.mjs';
import { hashBytes, hashRecord } from '../../../workflow-kernel/record-hash.mjs';

export const REVIEWER_CRYPTOGRAPHIC_TRUST_V2_TEST_NOW =
  new Date('2026-07-19T02:00:00.000Z');

export const reviewerCryptographicTrustV2Hash = (label) => hashRecord(
  'ReviewerCryptographicTrustV2Test',
  { label },
);

export function trustKey(pair, { keyId, role, subjectId }) {
  return Object.freeze({
    keyId,
    subjectId,
    organization: 'Reviewer Trust Test Authority',
    algorithm: 'ed25519',
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    roles: [role],
    status: 'active',
    effectiveFrom: '2026-07-19T00:00:00.000Z',
    expiresAt: '2026-07-20T00:00:00.000Z',
    revokedAt: null,
  });
}

export function trustStore(keys) {
  return Object.freeze({ version: 1, kind: 'AuthorityTrustStore', keys });
}

export function signedEnvelope(pair, {
  subjectKind,
  subjectHash,
  keyId,
  role,
  signedAt = '2026-07-19T01:59:00.000Z',
  expiresAt = '2026-07-19T02:01:00.000Z',
}) {
  const placeholder = buildPinnedExternalEvidenceEnvelope({
    subjectKind,
    subjectHash,
    signedAt,
    expiresAt,
    signatures: [{ keyId, role, algorithm: 'ed25519', value: 'placeholder' }],
  });
  const value = crypto.sign(
    null,
    pinnedExternalEvidenceSigningPayload(placeholder),
    pair.privateKey,
  ).toString('base64');
  return buildPinnedExternalEvidenceEnvelope({
    ...placeholder,
    signatures: [{ keyId, role, algorithm: 'ed25519', value }],
  });
}

export function reviewerFixture(index, root, { recoverySigner = false } = {}) {
  const receiptKey = crypto.generateKeyPairSync('ed25519');
  const identityKey = crypto.generateKeyPairSync('ed25519');
  const executionKey = crypto.generateKeyPairSync('ed25519');
  const receiptKeyId = `reviewer-receipt-key-${index}`;
  const identityKeyId = `reviewer-identity-key-${index}`;
  const executionKeyId = `reviewer-execution-key-${index}`;
  const serviceId = `reviewer-signer-${index}`;
  const principalId = `reviewer-principal-${index}`;
  const providerAccountIdentityHash = reviewerCryptographicTrustV2Hash(`account-${index}`);
  const credentialRootIdentityHash =
    reviewerCryptographicTrustV2Hash(`credential-root-${index}`);
  const trustDomainIdentityHash =
    reviewerCryptographicTrustV2Hash(`trust-domain-${index}`);
  const identitySubject = buildExternalPrincipalIdentityAttestationSubject({
    serviceId,
    principalId,
    provider: 'openai-codex',
    providerAccountIdentityHash,
    credentialRootIdentityHash,
    hostIdentityHash: reviewerCryptographicTrustV2Hash(`host-${index}`),
    processIdentityHash: reviewerCryptographicTrustV2Hash(`process-${index}`),
    trustDomainIdentityHash,
    signerPublicKeySpkiHash: hashBytes(
      receiptKey.publicKey.export({ type: 'spki', format: 'der' }),
    ),
    challengeHash: reviewerCryptographicTrustV2Hash(`challenge-${index}`),
    assuranceProfile: 'pinned-provider-account-and-platform-attestation-v1',
    attestedAt: '2026-07-19T01:58:00.000Z',
    expiresAt: '2026-07-19T02:02:00.000Z',
  });
  const identityEnvelope = signedEnvelope(identityKey, {
    subjectKind: 'ExternalPrincipalIdentityAttestationSubject',
    subjectHash: identitySubject.externalPrincipalIdentityAttestationSubjectHash,
    keyId: identityKeyId,
    role: 'external_principal_identity_attestor',
  });
  const identityAttestationBundle = buildReviewerSignerIdentityAttestationBundle({
    subject: identitySubject,
    authorityEnvelope: identityEnvelope,
    trustStore: trustStore([trustKey(identityKey, {
      keyId: identityKeyId,
      role: 'external_principal_identity_attestor',
      subjectId: `reviewer-identity-authority-${index}`,
    })]),
    signerKeyIds: [identityKeyId],
    maximumLifetimeMs: 5 * 60 * 1000,
  });
  const signerConfiguration = buildReviewerReceiptSignerServiceConfiguration({
    version: recoverySigner ? 3 : 2,
    serviceId,
    endpoint: `https://reviewer-${index}.example.test/v2/sign`,
    ...(recoverySigner ? {
      lookupEndpoint: `https://reviewer-${index}.example.test/v3/operations`,
      resumeEndpoint: `https://reviewer-${index}.example.test/v3/resume`,
    } : {}),
    serviceIdentityHash: reviewerCryptographicTrustV2Hash(`service-${index}`),
    tokenEnvironmentVariable: `REVIEWER_SIGNER_TOKEN_${index}_FILE`,
    timeoutMs: 5_000,
    receiptTrustStore: trustStore([trustKey(receiptKey, {
      keyId: receiptKeyId,
      role: 'reviewer_receipt_attestor',
      subjectId: `reviewer-receipt-authority-${index}`,
    })]),
    receiptSignerKeyIds: [receiptKeyId],
    receiptMaximumLifetimeMs: 5 * 60 * 1000,
    identityAttestationBundle,
  });
  const recoverableExecutorConfiguration =
    buildRecoverableReviewerExecutorServiceConfiguration({
      serviceId: `reviewer-executor-${index}`,
      endpoint: `https://reviewer-executor-${index}.example.test/v1/execute`,
      lookupEndpoint:
        `https://reviewer-executor-${index}.example.test/v1/operations`,
      resumeEndpoint:
        `https://reviewer-executor-${index}.example.test/v1/resume`,
      serviceIdentityHash:
        reviewerCryptographicTrustV2Hash(`executor-service-${index}`),
      tokenEnvironmentVariable: `REVIEWER_EXECUTOR_TOKEN_${index}_FILE`,
      timeoutMs: 20 * 60 * 1000,
      outcomeTrustStore: trustStore([trustKey(executionKey, {
        keyId: executionKeyId,
        role: 'reviewer_execution_attestor',
        subjectId: `reviewer-execution-authority-${index}`,
      })]),
      outcomeSignerKeyIds: [executionKeyId],
      outcomeMaximumLifetimeMs: 5 * 60 * 1000,
    });
  return Object.freeze({
    index,
    root,
    receiptKey,
    receiptKeyId,
    serviceId,
    principalId,
    providerAccountIdentityHash,
    credentialRootIdentityHash,
    trustDomainIdentityHash,
    signerConfiguration,
    recoverableExecutorConfiguration,
  });
}

export function reviewerPreflight({ codexHome, model }) {
  const index = Number(path.basename(codexHome).split('-').at(-1));
  const payload = {
    version: 1,
    kind: 'CodexFormalReviewerCapabilityReceipt',
    status: 'codex_formal_reviewer_capability_ready',
    provider: 'openai',
    model,
    codexVersion: 'codex-reviewer-v2-test',
    codexBinaryIdentityHash: reviewerCryptographicTrustV2Hash('codex-binary'),
    credentialRootIdentityHash:
      reviewerCryptographicTrustV2Hash(`credential-root-${index}`),
    credentialConfigIdentityHash:
      reviewerCryptographicTrustV2Hash(`credential-config-${index}`),
    authorCredentialRootIdentityHash:
      reviewerCryptographicTrustV2Hash('author-credential-root'),
    authenticationStatus: 'codex_authentication_verified',
    modelOptionVerified: true,
    selectedModelExecutionCanaryVerified: false,
    readOnlyReviewRequired: true,
    dynamicAttemptWorkspaceRequired: true,
    credentialIndependenceVerified: true,
    assuranceScope: 'filesystem_credential_root_and_principal_separation',
    providerAccountIndependenceVerified: false,
    externalActionPerformed: false,
  };
  return Object.freeze({
    codexBinary: '/usr/bin/true',
    codexHome,
    effectivePrincipalId: `reviewer-principal-${index}`,
    capabilityReceipt: Object.freeze({
      ...payload,
      codexFormalReviewerCapabilityReceiptHash:
        hashRecord('CodexFormalReviewerCapabilityReceipt', payload),
    }),
  });
}

export function reviewerExecutor(principalId) {
  return Object.freeze({
    executorId: `executor-${principalId}`,
    capabilities: () => buildExecutorCapabilities({
      executorId: `executor-${principalId}`,
      sandboxModes: ['read-only'],
      networkPolicy: 'none',
      receiptKinds: ['AgentExecutionReceipt'],
    }),
    async execute() { throw new Error('execution_not_expected'); },
  });
}

export function writeReviewerCryptographicTrustV2Json(candidate, value) {
  fs.writeFileSync(candidate, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function strongPoolFixture(t, { recoverySigner = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-reviewer-v2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtures = [1, 2].map((index) => reviewerFixture(
    index,
    root,
    { recoverySigner },
  ));
  const authorSigner = crypto.generateKeyPairSync('ed25519');
  const authorIdentityAuthority = crypto.generateKeyPairSync('ed25519');
  const authorIdentitySubject = buildExternalPrincipalIdentityAttestationSubject({
    serviceId: 'research-author-service',
    principalId: 'research-author-principal',
    provider: 'openai-codex',
    providerAccountIdentityHash:
      reviewerCryptographicTrustV2Hash('author-account'),
    credentialRootIdentityHash:
      reviewerCryptographicTrustV2Hash('author-credential-root'),
    hostIdentityHash: reviewerCryptographicTrustV2Hash('author-host'),
    processIdentityHash: reviewerCryptographicTrustV2Hash('author-process'),
    trustDomainIdentityHash:
      reviewerCryptographicTrustV2Hash('author-trust-domain'),
    signerPublicKeySpkiHash: hashBytes(
      authorSigner.publicKey.export({ type: 'spki', format: 'der' }),
    ),
    challengeHash:
      reviewerCryptographicTrustV2Hash('author-identity-challenge'),
    assuranceProfile: 'pinned-provider-account-and-platform-attestation-v1',
    attestedAt: '2026-07-19T01:58:00.000Z',
    expiresAt: '2026-07-19T02:02:00.000Z',
  });
  const authorIdentityEnvelope = signedEnvelope(authorIdentityAuthority, {
    subjectKind: 'ExternalPrincipalIdentityAttestationSubject',
    subjectHash: authorIdentitySubject.externalPrincipalIdentityAttestationSubjectHash,
    keyId: 'author-identity-key',
    role: 'external_principal_identity_attestor',
  });
  const authorIdentityTrustStore = trustStore([trustKey(authorIdentityAuthority, {
    keyId: 'author-identity-key',
    role: 'external_principal_identity_attestor',
    subjectId: 'author-identity-authority',
  })]);
  const authorIdentityAttestation = Object.freeze({
    subject: authorIdentitySubject,
    verificationReceipt: assertPinnedExternalEvidenceEnvelope({
      envelope: authorIdentityEnvelope,
      subjectKind: 'ExternalPrincipalIdentityAttestationSubject',
      subjectHash: authorIdentitySubject.externalPrincipalIdentityAttestationSubjectHash,
      trustStore: authorIdentityTrustStore,
      requiredRole: 'external_principal_identity_attestor',
      expectedKeyIds: ['author-identity-key'],
      now: REVIEWER_CRYPTOGRAPHIC_TRUST_V2_TEST_NOW,
      maximumLifetimeMs: 5 * 60 * 1000,
    }),
  });
  for (const fixture of fixtures) {
    fs.mkdirSync(path.join(root, `reviewer-home-${fixture.index}`), { mode: 0o700 });
  }
  const configuration = buildReviewerPrincipalPoolConfiguration({
    version: 2,
    poolId: 'cryptographic-reviewers-v2',
    minimumReviewerTrustDomains: 2,
    principals: fixtures.map((fixture) => ({
      codexBinary: '/usr/bin/true',
      codexHome: path.join(root, `reviewer-home-${fixture.index}`),
      model: `reviewer-model-${fixture.index}`,
      providerAccountIdentityHash: fixture.providerAccountIdentityHash,
      roles: fixture.index === 1
        ? ['formal-review', 'independent-review'] : ['independent-review'],
      signerConfiguration: fixture.signerConfiguration,
      recoverableExecutorConfiguration:
        fixture.recoverableExecutorConfiguration,
      trustDomainIdentityHash: fixture.trustDomainIdentityHash,
    })),
  });
  const configPath = path.join(root, 'reviewers-v2.json');
  writeReviewerCryptographicTrustV2Json(configPath, configuration);
  const environment = Object.fromEntries(fixtures.flatMap((fixture) => {
    const signerTokenPath = path.join(
      root,
      `reviewer-signer-token-${fixture.index}`,
    );
    const executorTokenPath = path.join(
      root,
      `reviewer-executor-token-${fixture.index}`,
    );
    fs.writeFileSync(signerTokenPath, `signer-token-${fixture.index}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(executorTokenPath, `executor-token-${fixture.index}\n`, {
      mode: 0o600,
    });
    return [
      [`REVIEWER_SIGNER_TOKEN_${fixture.index}_FILE`, signerTokenPath],
      [`REVIEWER_EXECUTOR_TOKEN_${fixture.index}_FILE`, executorTokenPath],
    ];
  }));
  const fetchImpl = async (url, init) => {
    const fixture = fixtures.find((candidate) => String(url).includes(
      `reviewer-${candidate.index}.example.test`,
    ));
    const request = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          requestHash: request.requestHash,
          serviceId: fixture.serviceId,
          serviceIdentityHash: fixture.signerConfiguration.serviceIdentityHash,
          externalActionPerformed: true,
          authorityEnvelope: signedEnvelope(fixture.receiptKey, {
            subjectKind: 'ReviewerReceiptSigningSubjectV1',
            subjectHash: request.subjectHash,
            keyId: fixture.receiptKeyId,
            role: 'reviewer_receipt_attestor',
          }),
        };
      },
    };
  };
  const inspection = preflightReviewerPrincipalPool({
    configPath,
    authorProvider: 'openai',
    authorCodexHome: path.join(root, 'author-home'),
    environment,
    preflightReviewer: reviewerPreflight,
    fetchImpl,
    clock: { now: () => REVIEWER_CRYPTOGRAPHIC_TRUST_V2_TEST_NOW },
    authorIdentityAttestation,
  });
  return {
    root,
    fixtures,
    configuration,
    configPath,
    environment,
    fetchImpl,
    inspection,
    authorIdentityAttestation,
    authorIdentitySource: Object.freeze({
      subject: authorIdentitySubject,
      authorityEnvelope: authorIdentityEnvelope,
      trustStore: authorIdentityTrustStore,
    }),
  };
}

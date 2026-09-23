import assert from 'node:assert/strict';
import test from 'node:test';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createAutonomousResearchQualificationContextProvider,
} from '../../paper-composition/automation/autonomous-research-qualification-context.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from '../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import {
  AUTONOMOUS_EXTERNAL_QUALIFICATION_ATTEMPT_LEASE_MS,
  normalizeExternalQualificationRetryPolicy,
} from '../../paper-domain/automation/autonomous-external-qualification-state-contract.mjs';
import {
  buildAutonomousResearchRuntimePrincipalBinding,
} from '../../paper-domain/automation/autonomous-research-runtime-principal-binding-contract.mjs';

const H = (label) => hashRecord('QualificationProgressTestHash', { label });
const START = Date.parse('2026-07-17T06:00:00.000Z');

test('qualification attempt leases retain a five-minute margin over one KMS command', () => {
  assert.equal(AUTONOMOUS_EXTERNAL_QUALIFICATION_ATTEMPT_LEASE_MS, 10 * 60 * 1000);
  assert.equal(
    normalizeExternalQualificationRetryPolicy().attemptLeaseMs,
    AUTONOMOUS_EXTERNAL_QUALIFICATION_ATTEMPT_LEASE_MS,
  );
  assert.equal(
    normalizeExternalQualificationRetryPolicy({ attemptLeaseMs: 60_000 }).attemptLeaseMs,
    AUTONOMOUS_EXTERNAL_QUALIFICATION_ATTEMPT_LEASE_MS,
  );
});

function fixture({ attestorStageMs = 9 * 60 * 1000 } = {}) {
  let nowMs = START;
  let campaignLeaseExpiresAt = START + 15 * 60 * 1000;
  let attemptLeaseExpiresAt = START + 10 * 60 * 1000;
  const stages = [];
  let signerStarted = false;
  const renew = (kind, leaseMs, readExpiry, writeExpiry) => ({ stage }) => {
    if (nowMs >= readExpiry()) {
      throw new Error(kind === 'attempt'
        ? 'autonomous_research_qualification_attempt_lease_lost'
        : 'supervisor_lease_lost');
    }
    writeExpiry(nowMs + leaseMs);
    stages.push(`${kind}:${stage}`);
  };
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    environment: {
      HEPTA_RESEARCH_AUTHOR_PROVIDER: 'codex',
      HEPTA_RESEARCH_AUTHOR_MODEL: 'author-model',
      HEPTA_FORMAL_REVIEW_PROVIDER: 'codex',
      HEPTA_FORMAL_REVIEW_MODEL: 'reviewer-model',
    },
  });
  const campaignProgress = renew(
    'campaign',
    15 * 60 * 1000,
    () => campaignLeaseExpiresAt,
    (value) => { campaignLeaseExpiresAt = value; },
  );
  const provider = createAutonomousResearchQualificationContextProvider({
    schemaVersionReceipt: Object.freeze({ version: 1 }),
    providerConfiguration,
    expectedProviderConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    clock: { now: () => new Date(nowMs) },
    onProgress: campaignProgress,
    onSynchronousProgress: campaignProgress,
    preflightAuthor: () => ({ capabilityReceipt: Object.freeze({ role: 'author' }) }),
    preflightReviewer: () => ({ capabilityReceipt: Object.freeze({ role: 'reviewer' }) }),
    probeModelAvailability: ({ errorPrefix }) => {
      nowMs += 8 * 60 * 1000;
      return Object.freeze({ kind: 'FixtureCanary', errorPrefix });
    },
    codeProvenanceProvider: () => Object.freeze({ status: 'fixture' }),
    runtimeImageStatusComposer: () => Object.freeze({
      blockers: Object.freeze([]),
      inspection: Object.freeze({ ready: true }),
    }),
    pinnedImageDigestInspector: (profile) => H(profile.name || profile.image),
    releaseAttestorInspector: ({ onSynchronousProgress }) => {
      onSynchronousProgress({ stage: 'release_attestor_before_backend_probe' });
      nowMs += attestorStageMs;
      onSynchronousProgress({
        stage: 'release_attestor_after_backend_probe_before_signer_challenge',
      });
      signerStarted = true;
      nowMs += attestorStageMs;
      onSynchronousProgress({ stage: 'release_attestor_after_active_signer_challenge' });
      return Object.freeze({ ready: true, productionReady: true });
    },
  });
  return {
    provider,
    providerConfiguration,
    stages,
    elapsed: () => nowMs - START,
    signerStarted: () => signerStarted,
    attemptProgress: renew(
      'attempt',
      10 * 60 * 1000,
      () => attemptLeaseExpiresAt,
      (value) => { attemptLeaseExpiresAt = value; },
    ),
  };
}

test('qualification progress renews all fences across timer-starving synchronous stages', async () => {
  const f = fixture();
  const result = await f.provider({
    preparation: {
      autonomousResearchProviderConfigurationHash:
        f.providerConfiguration.autonomousResearchProviderConfigurationHash,
    },
    onSynchronousProgress: f.attemptProgress,
  });
  assert.equal(result.releaseAttestorInspection.productionReady, true);
  assert.equal(f.signerStarted(), true);
  assert.ok(f.elapsed() > 30 * 60 * 1000);
  assert.ok(f.stages.includes(
    'campaign:qualification_context_after_author_provider_canary',
  ));
  assert.ok(f.stages.includes(
    'attempt:qualification_context_before_reviewer_provider_canary',
  ));
  assert.ok(f.stages.includes(
    'campaign:release_attestor_after_backend_probe_before_signer_challenge',
  ));
  assert.ok(f.stages.includes(
    'attempt:release_attestor_after_backend_probe_before_signer_challenge',
  ));
});

test('qualification progress blocks the signer when a synchronous attempt fence expires', async () => {
  const f = fixture({ attestorStageMs: 11 * 60 * 1000 });
  await assert.rejects(() => f.provider({
    preparation: {
      autonomousResearchProviderConfigurationHash:
        f.providerConfiguration.autonomousResearchProviderConfigurationHash,
    },
    onSynchronousProgress: f.attemptProgress,
  }), /attempt_lease_lost/);
  assert.equal(f.signerStarted(), false);
});

test('production qualification rebuilds the persisted reviewer authority binding', async () => {
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    environment: {
      HEPTA_RESEARCH_AUTHOR_PROVIDER: 'codex',
      HEPTA_RESEARCH_AUTHOR_MODEL: 'author-model',
      HEPTA_FORMAL_REVIEW_PROVIDER: 'codex',
      HEPTA_FORMAL_REVIEW_MODEL: 'reviewer-model',
    },
  });
  const author = Object.freeze({
    effectivePrincipalId: 'qualification-author',
    codexHome: '/qualification-author-home',
    capabilityReceipt: Object.freeze({
      codexResearchAuthorCapabilityReceiptHash: H('qualification-author-capability'),
      credentialRootIdentityHash: H('qualification-author-credential-root'),
    }),
  });
  const authorIdentityAttestation = Object.freeze({
    configurationHash: H('qualification-author-identity-configuration'),
    subject: Object.freeze({
      externalPrincipalIdentityAttestationSubjectHash:
        H('qualification-author-identity-subject'),
    }),
  });
  const reviewerEvidenceAuthority = Object.freeze({
    researchPrincipalPoolHash: H('qualification-reviewer-pool'),
    reviewerTrustSetHash: H('qualification-reviewer-trust'),
    reviewerSignatureVerificationPolicyHash: H('qualification-reviewer-policy'),
    verifySignedReviewerReceipt: () => true,
  });
  const runtimePrincipalBinding = buildAutonomousResearchRuntimePrincipalBinding({
    authorPrincipalId: author.effectivePrincipalId,
    authorIdentityConfigurationHash: authorIdentityAttestation.configurationHash,
    authorIdentitySubjectHash:
      authorIdentityAttestation.subject.externalPrincipalIdentityAttestationSubjectHash,
    authorCapabilityReceiptHash:
      author.capabilityReceipt.codexResearchAuthorCapabilityReceiptHash,
    authorCredentialRootIdentityHash:
      author.capabilityReceipt.credentialRootIdentityHash,
    researchPrincipalPoolHash: reviewerEvidenceAuthority.researchPrincipalPoolHash,
    reviewerTrustSetHash: reviewerEvidenceAuthority.reviewerTrustSetHash,
    reviewerSignatureVerificationPolicyHash:
      reviewerEvidenceAuthority.reviewerSignatureVerificationPolicyHash,
  });
  const provider = createAutonomousResearchQualificationContextProvider({
    schemaVersionReceipt: Object.freeze({ version: 1 }),
    providerConfiguration,
    expectedProviderConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    environment: { HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG: '/reviewers.json' },
    clock: { now: () => new Date(START) },
    preflightAuthor: () => author,
    preflightReviewer: () => ({ capabilityReceipt: Object.freeze({ role: 'reviewer' }) }),
    authorIdentityInspector: () => authorIdentityAttestation,
    reviewerReceiptAuthorityComposer: ({ configPath, authorIdentityAttestation: observed }) => {
      assert.equal(configPath, '/reviewers.json');
      assert.equal(observed, authorIdentityAttestation);
      return Object.freeze({ verificationAuthority: reviewerEvidenceAuthority });
    },
    probeModelAvailability: () => Object.freeze({ ready: true }),
    codeProvenanceProvider: () => Object.freeze({ status: 'fixture' }),
    runtimeImageStatusComposer: () => Object.freeze({
      blockers: Object.freeze([]),
      inspection: Object.freeze({ ready: true }),
    }),
    pinnedImageDigestInspector: (profile) => H(profile.name || profile.image),
    releaseAttestorInspector: () => Object.freeze({ ready: true }),
  });
  const preparation = Object.freeze({
    launchMode: 'production-run',
    autonomousResearchProviderConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    runtimePrincipalBinding,
    runtimePrincipalBindingHash: runtimePrincipalBinding.runtimePrincipalBindingHash,
  });
  const result = await provider({ preparation });
  assert.equal(result.reviewerEvidenceAuthority, reviewerEvidenceAuthority);
  assert.deepEqual(result.runtimePrincipalBinding, runtimePrincipalBinding);
  const rotatedBinding = buildAutonomousResearchRuntimePrincipalBinding({
    ...runtimePrincipalBinding,
    reviewerTrustSetHash: H('qualification-reviewer-trust-rotated'),
  });
  await assert.rejects(() => provider({
    preparation: {
      ...preparation,
      runtimePrincipalBinding: rotatedBinding,
      runtimePrincipalBindingHash: rotatedBinding.runtimePrincipalBindingHash,
    },
  }), /qualification_runtime_principal_binding_invalid/);
});

test('production qualification uses the internal reviewer session pool by default', async () => {
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    environment: {
      HEPTA_RESEARCH_AUTHOR_PROVIDER: 'codex',
      HEPTA_RESEARCH_AUTHOR_MODEL: 'author-model',
      HEPTA_FORMAL_REVIEW_PROVIDER: 'codex',
      HEPTA_FORMAL_REVIEW_MODEL: 'reviewer-model',
    },
  });
  const author = Object.freeze({
    effectivePrincipalId: 'qualification-session-author',
    codexHome: '/qualification-shared-home',
    capabilityReceipt: Object.freeze({
      codexResearchAuthorCapabilityReceiptHash: H('session-author-capability'),
      credentialRootIdentityHash: H('session-shared-credential-root'),
    }),
  });
  const reviewer = Object.freeze({
    effectivePrincipalId: 'qualification-session-reviewer',
    capabilityReceipt: Object.freeze({ role: 'fresh-session-reviewer' }),
  });
  const authorIdentityAttestation = Object.freeze({
    configurationHash: H('session-author-identity-configuration'),
    subject: Object.freeze({
      autonomousResearchAuthorSessionIdentitySubjectHash:
        H('session-author-identity-subject'),
    }),
  });
  const reviewerEvidenceAuthority = Object.freeze({
    version: 3,
    kind: 'ReviewerReceiptVerificationAuthority',
    authorityMode: 'fresh-isolated-session',
    sessionIsolationReady: true,
    cryptographicAuthorityReady: false,
    identityIndependenceReady: true,
    researchPrincipalPoolHash: H('session-reviewer-pool'),
    reviewerTrustSetHash: H('session-reviewer-trust'),
    reviewerSignatureVerificationPolicyHash: H('session-reviewer-policy'),
    verifySignedReviewerReceipt: () => false,
    verifySessionReviewerReceipt: () => true,
  });
  const reviewerSessionPoolInspection = Object.freeze({
    pool: Object.freeze({
      researchPrincipalPoolHash: reviewerEvidenceAuthority.researchPrincipalPoolHash,
    }),
    trustInspection: Object.freeze({ kind: 'fixture-session-trust' }),
  });
  const runtimePrincipalBinding = buildAutonomousResearchRuntimePrincipalBinding({
    authorPrincipalId: author.effectivePrincipalId,
    authorIdentityConfigurationHash: authorIdentityAttestation.configurationHash,
    authorIdentitySubjectHash:
      authorIdentityAttestation.subject
        .autonomousResearchAuthorSessionIdentitySubjectHash,
    authorCapabilityReceiptHash:
      author.capabilityReceipt.codexResearchAuthorCapabilityReceiptHash,
    authorCredentialRootIdentityHash:
      author.capabilityReceipt.credentialRootIdentityHash,
    researchPrincipalPoolHash: reviewerEvidenceAuthority.researchPrincipalPoolHash,
    reviewerTrustSetHash: reviewerEvidenceAuthority.reviewerTrustSetHash,
    reviewerSignatureVerificationPolicyHash:
      reviewerEvidenceAuthority.reviewerSignatureVerificationPolicyHash,
  });
  let sessionBuilderCalls = 0;
  let authorityFactoryCalls = 0;
  const provider = createAutonomousResearchQualificationContextProvider({
    schemaVersionReceipt: Object.freeze({ version: 1 }),
    providerConfiguration,
    expectedProviderConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    environment: {},
    clock: { now: () => new Date(START) },
    preflightAuthor: () => author,
    preflightReviewer: () => reviewer,
    authorIdentityInspector: () => authorIdentityAttestation,
    reviewerReceiptAuthorityComposer: () => {
      throw new Error('external_reviewer_pool_must_not_be_loaded');
    },
    reviewerSessionPoolBuilder(input) {
      sessionBuilderCalls += 1;
      assert.equal(input.author, author);
      assert.equal(input.reviewer, reviewer);
      return reviewerSessionPoolInspection;
    },
    reviewerReceiptVerificationAuthorityFactory(input) {
      authorityFactoryCalls += 1;
      assert.equal(input.pool, reviewerSessionPoolInspection.pool);
      assert.equal(input.trustInspection, reviewerSessionPoolInspection.trustInspection);
      return reviewerEvidenceAuthority;
    },
    probeModelAvailability: () => Object.freeze({ ready: true }),
    codeProvenanceProvider: () => Object.freeze({ status: 'fixture' }),
    runtimeImageStatusComposer: () => Object.freeze({
      blockers: Object.freeze([]),
      inspection: Object.freeze({ ready: true }),
    }),
    pinnedImageDigestInspector: (profile) => H(profile.name || profile.image),
    releaseAttestorInspector: () => Object.freeze({ ready: true }),
  });
  const result = await provider({
    preparation: {
      launchMode: 'production-run',
      autonomousResearchProviderConfigurationHash:
        providerConfiguration.autonomousResearchProviderConfigurationHash,
      runtimePrincipalBinding,
      runtimePrincipalBindingHash: runtimePrincipalBinding.runtimePrincipalBindingHash,
    },
  });
  assert.equal(sessionBuilderCalls, 1);
  assert.equal(authorityFactoryCalls, 1);
  assert.equal(result.reviewerEvidenceAuthority, reviewerEvidenceAuthority);
  assert.deepEqual(result.runtimePrincipalBinding, runtimePrincipalBinding);
});

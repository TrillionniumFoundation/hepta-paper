import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  buildPriorArtIndependentReviewAuthoritySubjectV2,
  buildPriorArtRetrievalAuthoritySubjectV2,
  buildPriorArtServiceConfiguration,
  createHttpPriorArtRetrievalAdapter,
} from '../../paper-adapters/automation/http-prior-art-retrieval-adapter.mjs';
import {
  buildPinnedExternalEvidenceEnvelope,
  pinnedExternalEvidenceSigningPayload,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildExternalPrincipalIdentityAttestationSubject,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import {
  buildPriorArtEvidenceReceiptV2,
} from '../../paper-domain/research/prior-art-evidence-contract.mjs';
import {
  verifyPriorArtAuthorityVerificationBundle,
} from '../../paper-domain/research/prior-art-authority-verification-contract.mjs';
import {
  priorArtQueryPlanHash,
} from '../../paper-domain/automation/research-agenda-ir.mjs';
import { assertPriorArtRetrievalPort } from '../../paper-ports/prior-art-retrieval-port.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-07-19T02:00:00.000Z');
const RETRIEVAL_ROLE = 'prior_art_retrieval_service';
const REVIEW_ROLE = 'prior_art_independent_reviewer';
const IDENTITY_ROLE = 'external_principal_identity_attestor';
const H = (label) => hashRecord('HttpPriorArtRetrievalAdapterV2Test', { label });

function spkiHash(pair) {
  return hashBytes(pair.publicKey.export({ type: 'spki', format: 'der' }));
}

function trustStore(pair, { keyId, subjectId, role }) {
  return Object.freeze({
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [Object.freeze({
      keyId,
      subjectId,
      organization: 'Independent Research Authority',
      algorithm: 'ed25519',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [role],
      status: 'active',
      effectiveFrom: '2026-07-19T00:00:00.000Z',
      expiresAt: '2026-07-20T00:00:00.000Z',
      revokedAt: null,
    })],
  });
}

function signedEnvelope(pair, {
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

function identity(label, signerPublicKeySpkiHash, overrides = {}) {
  return buildExternalPrincipalIdentityAttestationSubject({
    serviceId: `service-${label}`,
    principalId: `principal-${label}`,
    provider: `provider-${label}`,
    providerAccountIdentityHash: H(`account-${label}`),
    credentialRootIdentityHash: H(`credential-${label}`),
    hostIdentityHash: H(`host-${label}`),
    processIdentityHash: H(`process-${label}`),
    trustDomainIdentityHash: H(`domain-${label}`),
    signerPublicKeySpkiHash,
    challengeHash: H(`challenge-${label}`),
    assuranceProfile: 'pinned-provider-account-and-platform-attestation-v1',
    attestedAt: '2026-07-19T01:58:00.000Z',
    expiresAt: '2026-07-19T02:02:00.000Z',
    ...overrides,
  });
}

function evidenceInput({
  reviewerIdentity,
  signatureVerificationReceiptHash,
  researchAgendaIrHash,
  priorArtQueryPlan,
}) {
  const resultSetHash = H('crossref-result-set');
  return {
    paperId: 'paper-prior-art-v2',
    agendaSelectionReceiptHash: H('agenda'),
    researchAgendaIrHash,
    priorArtQueryPlan,
    generatorPrincipalId: 'principal-generator',
    queries: [{
      queryId: 'query-1',
      query: priorArtQueryPlan[0],
      executedAt: '2026-07-19T01:55:00.000Z',
      providerResults: [{
        providerId: 'crossref-snapshot',
        providerQueryId: 'crossref-query-1',
        corpusSnapshotHash: H('crossref-corpus'),
        resultSetHash,
        retrievalReceiptHash: H('crossref-retrieval'),
        resultCount: 1,
      }],
    }],
    works: [{
      workId: 'work-1',
      title: 'Signed and ranked research evidence',
      authors: ['Ada Researcher'],
      year: 2026,
      identifiers: {
        doi: '10.1000/signed-prior-art.1',
        arxiv: '2601.01234v1',
        openAlex: 'W123456789',
        url: 'https://example.test/signed-prior-art',
      },
      abstractHash: H('abstract'),
      providerSources: [{
        providerId: 'crossref-snapshot',
        providerWorkId: 'crossref-work-1',
        queryId: 'query-1',
        resultSetHash,
        sourceSnapshotHash: H('crossref-work'),
      }],
    }],
    deduplication: {
      algorithmId: 'scholarly-identity-union',
      algorithmVersion: '1.0.0',
      algorithmConfigurationHash: H('dedupe-config'),
    },
    rankings: [{
      queryId: 'query-1',
      algorithmId: 'bounded-relevance-ranking',
      algorithmVersion: '1.0.0',
      algorithmConfigurationHash: H('ranking-config'),
      sourceResultSetHashes: [resultSetHash],
      entries: [{ workId: 'work-1', rank: 1, scoreMicros: 900_000 }],
    }],
    coverageLimitations: [
      'The signed corpus snapshot is finite and cannot prove open-world completeness.',
    ],
    independentReview: {
      principalId: reviewerIdentity.principalId,
      providerAccountIdentityHash: reviewerIdentity.providerAccountIdentityHash,
      trustDomainIdentityHash: reviewerIdentity.trustDomainIdentityHash,
      reviewReceiptHash: H('independent-review'),
      signatureVerificationReceiptHash,
      independentFromGenerator: true,
    },
    createdAt: '2026-07-19T01:56:00.000Z',
    mode: 'verified',
  };
}

function fixture() {
  const retrievalPair = crypto.generateKeyPairSync('ed25519');
  const reviewPair = crypto.generateKeyPairSync('ed25519');
  const identityPair = crypto.generateKeyPairSync('ed25519');
  const attackerPair = crypto.generateKeyPairSync('ed25519');
  const researchAgendaIrHash = H('research-agenda-ir');
  const priorArtQueryPlan = ['signed ranked autonomous research evidence'];
  const generatorIdentity = identity('generator', H('generator-signer-spki'), {
    serviceId: 'author-service-1',
    principalId: 'principal-generator',
  });
  const retrievalIdentity = identity('retrieval', spkiHash(retrievalPair), {
    serviceId: 'prior-art-service-1',
  });
  const reviewerIdentity = identity('reviewer', spkiHash(reviewPair));
  const configuration = buildPriorArtServiceConfiguration({
    version: 2,
    serviceId: retrievalIdentity.serviceId,
    endpoint: 'https://prior-art.example.test/retrieve',
    serviceIdentityHash: H('service-identity'),
    tokenEnvironmentVariable: 'PRIOR_ART_TEST_TOKEN',
    retrievalTrustStore: trustStore(retrievalPair, {
      keyId: 'retrieval-key-1', subjectId: 'retrieval-authority-1', role: RETRIEVAL_ROLE,
    }),
    retrievalSignerKeyIds: ['retrieval-key-1'],
    independentReviewTrustStore: trustStore(reviewPair, {
      keyId: 'review-key-1', subjectId: 'review-authority-1', role: REVIEW_ROLE,
    }),
    independentReviewSignerKeyIds: ['review-key-1'],
    identityTrustStore: trustStore(identityPair, {
      keyId: 'identity-key-1', subjectId: 'identity-authority-1', role: IDENTITY_ROLE,
    }),
    identitySignerKeyIds: ['identity-key-1'],
  });
  const identityEnvelope = (subject) => signedEnvelope(identityPair, {
    subjectKind: 'ExternalPrincipalIdentityAttestationSubject',
    subjectHash: subject.externalPrincipalIdentityAttestationSubjectHash,
    keyId: 'identity-key-1',
    role: IDENTITY_ROLE,
  });
  const generatorIdentityAuthorityEnvelope = identityEnvelope(generatorIdentity);
  const responseDocument = (body, {
    retrievalSigningPair = retrievalPair,
    retrievalRole = RETRIEVAL_ROLE,
    retrievalSignedAt = '2026-07-19T01:59:00.000Z',
    retrievalExpiresAt = '2026-07-19T02:01:00.000Z',
    retrievalRequestHash = body.requestHash,
    reviewRole = REVIEW_ROLE,
    arbitraryReviewVerificationHash = false,
    tamperReceipt = false,
    identityCollision = false,
  } = {}) => {
    const effectiveReviewerIdentity = identityCollision
      ? identity('reviewer-collision', spkiHash(reviewPair), {
        principalId: reviewerIdentity.principalId,
        providerAccountIdentityHash: generatorIdentity.providerAccountIdentityHash,
      }) : reviewerIdentity;
    const preliminaryReceipt = buildPriorArtEvidenceReceiptV2(evidenceInput({
      reviewerIdentity: effectiveReviewerIdentity,
      signatureVerificationReceiptHash: H('placeholder-review-verification'),
      researchAgendaIrHash: body.researchAgendaIrHash,
      priorArtQueryPlan: body.priorArtQueryPlan,
    }));
    const reviewSubject = buildPriorArtIndependentReviewAuthoritySubjectV2({
      receipt: preliminaryReceipt,
    });
    const independentReviewAuthorityEnvelope = signedEnvelope(reviewPair, {
      subjectKind: 'PriorArtIndependentReviewAuthoritySubjectV2',
      subjectHash: reviewSubject.priorArtIndependentReviewAuthoritySubjectHash,
      keyId: 'review-key-1',
      role: reviewRole,
    });
    const receipt = buildPriorArtEvidenceReceiptV2(evidenceInput({
      reviewerIdentity: effectiveReviewerIdentity,
      signatureVerificationReceiptHash: arbitraryReviewVerificationHash
        ? H('remote-arbitrary-verification')
        : hashRecord('PinnedExternalEvidenceEnvelope', independentReviewAuthorityEnvelope),
      researchAgendaIrHash: body.researchAgendaIrHash,
      priorArtQueryPlan: body.priorArtQueryPlan,
    }));
    const retrievalSubject = buildPriorArtRetrievalAuthoritySubjectV2({
      requestHash: retrievalRequestHash,
      serviceId: configuration.serviceId,
      serviceIdentityHash: configuration.serviceIdentityHash,
      priorArtEvidenceReceiptHash: receipt.priorArtEvidenceReceiptHash,
      researchAgendaIrHash: body.researchAgendaIrHash,
      priorArtQueryPlan: body.priorArtQueryPlan,
      priorArtQueryPlanHash: body.priorArtQueryPlanHash,
    });
    const retrievalAuthorityEnvelope = signedEnvelope(retrievalSigningPair, {
      subjectKind: 'PriorArtRetrievalAuthoritySubjectV2',
      subjectHash: retrievalSubject.priorArtRetrievalAuthoritySubjectHash,
      keyId: 'retrieval-key-1',
      role: retrievalRole,
      signedAt: retrievalSignedAt,
      expiresAt: retrievalExpiresAt,
    });
    const returnedReceipt = tamperReceipt ? structuredClone(receipt) : receipt;
    if (tamperReceipt) returnedReceipt.works[0].title = 'Tampered after signing';
    return {
      requestHash: body.requestHash,
      serviceId: configuration.serviceId,
      serviceIdentityHash: configuration.serviceIdentityHash,
      externalActionPerformed: true,
      priorArtEvidenceReceipt: returnedReceipt,
      retrievalAuthorityEnvelope,
      independentReviewAuthorityEnvelope,
      retrievalIdentityAttestation: retrievalIdentity,
      retrievalIdentityAuthorityEnvelope: identityEnvelope(retrievalIdentity),
      reviewerIdentityAttestation: effectiveReviewerIdentity,
      reviewerIdentityAuthorityEnvelope: identityEnvelope(effectiveReviewerIdentity),
    };
  };
  const retrieveInput = {
    paperId: 'paper-prior-art-v2',
    objective: 'Validate signed structured prior art.',
    protocolFamily: 'rl_stochastic_control_benchmark',
    agendaSelectionReceiptHash: H('agenda'),
    researchAgendaIrHash,
    priorArtQueryPlan,
    generatorPrincipalId: generatorIdentity.principalId,
    generatorIdentityAttestation: generatorIdentity,
    generatorIdentityAuthorityEnvelope,
    createdAt: '2026-07-19T01:56:00.000Z',
  };
  return {
    attackerPair,
    configuration,
    responseDocument,
    retrieveInput,
  };
}

function adapterFor(selected, responseOptions = {}) {
  let body = null;
  const adapter = createHttpPriorArtRetrievalAdapter({
    configuration: selected.configuration,
    environment: { PRIOR_ART_TEST_TOKEN: 'secret-token' },
    clock: { now: () => NOW },
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        async json() { return selected.responseDocument(body, responseOptions); },
      };
    },
  });
  return { adapter, requestBody: () => body };
}

test('v2 verifies retrieval, independent review, and distinct signed identities locally', async () => {
  const selected = fixture();
  const { adapter, requestBody } = adapterFor(selected);
  assert.equal(adapter.evidenceProfile, 'structured-ranked-deduplicated-v2');
  assert.equal(adapter.cryptographicAuthorityReady, true);
  assert.equal(adapter.identityIndependenceReady, true);
  assert.match(adapter.trustSetHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(adapter.signatureVerificationPolicyHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(assertPriorArtRetrievalPort(adapter, {
    expectedConfigurationHash: selected.configuration.configurationHash,
  }), adapter);

  const receipt = await adapter.retrieve(selected.retrieveInput);
  assert.equal(receipt.version, 2);
  assert.equal(receipt.status, 'prior_art_evidence_verified');
  assert.equal(requestBody().generatorIdentityAttestationSubjectHash,
    selected.retrieveInput.generatorIdentityAttestation
      .externalPrincipalIdentityAttestationSubjectHash);
  assert.equal(requestBody().researchAgendaIrHash,
    selected.retrieveInput.researchAgendaIrHash);
  assert.deepEqual(requestBody().priorArtQueryPlan,
    selected.retrieveInput.priorArtQueryPlan);
  assert.equal(requestBody().priorArtQueryPlanHash,
    priorArtQueryPlanHash(selected.retrieveInput.priorArtQueryPlan));
  const authority = adapter.authorityFor(receipt);
  assert.equal(authority.cryptographicAuthorityReady, true);
  assert.equal(authority.identityIndependenceReady, true);
  assert.notEqual(
    authority.independentReviewVerification
      .pinnedExternalEvidenceVerificationReceiptHash,
    receipt.independentReview.signatureVerificationReceiptHash,
  );
  assert.equal(authority.independentReviewVerification.envelopeHash,
    receipt.independentReview.signatureVerificationReceiptHash);
  assert.match(authority.priorArtRetrievalAuthorityVerificationBundleHash,
    /^sha256:[0-9a-f]{64}$/);
  assert.equal(adapter.verifyAuthorityBundle(receipt, authority), authority);
  assert.equal(verifyPriorArtAuthorityVerificationBundle({
    receipt,
    authorityBundle: authority,
    trustConfiguration: adapter.authorityTrustConfiguration(),
    researchAgendaIrHash: H('different-research-agenda-ir'),
    priorArtQueryPlan: selected.retrieveInput.priorArtQueryPlan,
  }), false);
  assert.equal(verifyPriorArtAuthorityVerificationBundle({
    receipt,
    authorityBundle: authority,
    trustConfiguration: adapter.authorityTrustConfiguration(),
    researchAgendaIrHash: selected.retrieveInput.researchAgendaIrHash,
    priorArtQueryPlan: ['modified signed ranked evidence query'],
  }), false);

  const forged = structuredClone(authority);
  forged.retrievalEnvelope.signatures[0].value = Buffer.alloc(64).toString('base64');
  forged.retrievalVerification.envelopeHash = hashRecord(
    'PinnedExternalEvidenceEnvelope', forged.retrievalEnvelope,
  );
  const {
    pinnedExternalEvidenceVerificationReceiptHash: _verificationHash,
    ...verificationPayload
  } = forged.retrievalVerification;
  forged.retrievalVerification.pinnedExternalEvidenceVerificationReceiptHash = hashRecord(
    'PinnedExternalEvidenceVerificationReceipt', verificationPayload,
  );
  const {
    priorArtRetrievalAuthorityVerificationBundleHash: _bundleHash,
    ...bundlePayload
  } = forged;
  forged.priorArtRetrievalAuthorityVerificationBundleHash = hashRecord(
    'PriorArtRetrievalAuthorityVerificationBundle', bundlePayload,
  );
  assert.equal(verifyPriorArtAuthorityVerificationBundle({
    receipt,
    authorityBundle: forged,
    trustConfiguration: adapter.authorityTrustConfiguration(),
    researchAgendaIrHash: selected.retrieveInput.researchAgendaIrHash,
    priorArtQueryPlan: selected.retrieveInput.priorArtQueryPlan,
  }), false);
  assert.throws(() => adapter.verifyAuthorityBundle(receipt, forged),
    /prior_art_retrieval_authority_bundle_invalid/);
});

test('v2 refuses retrieval without an exact agenda query-plan binding', async () => {
  const selected = fixture();
  const { adapter } = adapterFor(selected);
  await assert.rejects(adapter.retrieve({
    ...selected.retrieveInput,
    researchAgendaIrHash: null,
  }), /prior_art_retrieval_agenda_query_plan_binding_invalid/);
  await assert.rejects(adapter.retrieve({
    ...selected.retrieveInput,
    priorArtQueryPlan: [],
  }), /prior_art_retrieval_agenda_query_plan_binding_invalid/);
});

test('v2 rejects wrong key, role, expiry, and request binding', async (t) => {
  for (const [name, options] of [
    ['wrong-key', (selected) => ({ retrievalSigningPair: selected.attackerPair })],
    ['wrong-role', () => ({ reviewRole: 'untrusted_review_role' })],
    ['expired', () => ({
      retrievalSignedAt: '2026-07-19T01:00:00.000Z',
      retrievalExpiresAt: '2026-07-19T01:01:00.000Z',
    })],
    ['wrong-request', () => ({ retrievalRequestHash: H('wrong-request') })],
  ]) {
    await t.test(name, async () => {
      const selected = fixture();
      const { adapter } = adapterFor(selected, options(selected));
      await assert.rejects(adapter.retrieve(selected.retrieveInput),
        /pinned_external_evidence_verification_capability_invalid/);
    });
  }
});

test('v2 rejects content tamper and remote arbitrary verification hashes', async (t) => {
  for (const [name, options, expected] of [
    ['content-tamper', { tamperReceipt: true }, /prior_art_service_response_invalid/],
    ['arbitrary-review-hash', { arbitraryReviewVerificationHash: true },
      /prior_art_independent_review_envelope_binding_invalid/],
    ['identity-collision', { identityCollision: true },
      /prior_art_external_identity_independence_invalid/],
  ]) {
    await t.test(name, async () => {
      const selected = fixture();
      const { adapter } = adapterFor(selected, options);
      await assert.rejects(adapter.retrieve(selected.retrieveInput), expected);
    });
  }
});

test('v1 stays bounded and does not expose cryptographic readiness', () => {
  const configuration = buildPriorArtServiceConfiguration({
    serviceId: 'legacy-prior-art-service',
    endpoint: 'https://prior-art.example.test/legacy',
    serviceIdentityHash: H('legacy-service'),
    tokenEnvironmentVariable: 'PRIOR_ART_TEST_TOKEN',
  });
  const adapter = createHttpPriorArtRetrievalAdapter({
    configuration,
    environment: { PRIOR_ART_TEST_TOKEN: 'secret-token' },
    fetchImpl: async () => { throw new Error('unused'); },
  });
  assert.equal(adapter.evidenceProfile, 'structured-receipt-v1');
  assert.equal(adapter.cryptographicAuthorityReady, false);
  assert.equal(adapter.identityIndependenceReady, false);
  assert.equal(adapter.trustSetHash, null);
});

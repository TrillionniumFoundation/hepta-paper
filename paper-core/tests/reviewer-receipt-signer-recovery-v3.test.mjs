import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  buildPinnedExternalEvidenceEnvelope,
  pinnedExternalEvidenceSigningPayload,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildReviewerReceiptSignerServiceConfiguration,
  createHttpReviewerReceiptSignerAdapter,
} from '../../paper-adapters/automation/http-reviewer-receipt-signer-adapter.mjs';
import {
  buildReviewerReceiptSigningRecoveryOutcome,
} from '../../paper-domain/research/external-operation-recovery-outcome-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-07-24T02:00:00.000Z');
const ROLE = 'reviewer_receipt_attestor';
const H = (label) => hashRecord(
  'ReviewerReceiptSignerRecoveryV3Test',
  { label },
);

function signedEnvelope(pair, { subjectKind, subjectHash }) {
  const placeholder = buildPinnedExternalEvidenceEnvelope({
    subjectKind,
    subjectHash,
    signedAt: '2026-07-24T01:59:00.000Z',
    expiresAt: '2026-07-24T02:10:00.000Z',
    signatures: [{
      keyId: 'recovery-signer-key',
      role: ROLE,
      algorithm: 'ed25519',
      value: 'placeholder',
    }],
  });
  const value = crypto.sign(
    null,
    pinnedExternalEvidenceSigningPayload(placeholder),
    pair.privateKey,
  ).toString('base64');
  return buildPinnedExternalEvidenceEnvelope({
    ...placeholder,
    signatures: [{
      keyId: 'recovery-signer-key',
      role: ROLE,
      algorithm: 'ed25519',
      value,
    }],
  });
}

function fixture() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const serviceId = 'reviewer-recovery-signer';
  const configuration = buildReviewerReceiptSignerServiceConfiguration({
    version: 3,
    serviceId,
    endpoint: 'https://reviewer-recovery.example.test/v3/sign',
    lookupEndpoint:
      'https://reviewer-recovery.example.test/v3/operations',
    resumeEndpoint: 'https://reviewer-recovery.example.test/v3/resume',
    serviceIdentityHash: H('service-identity'),
    tokenEnvironmentVariable: 'REVIEWER_RECOVERY_TOKEN',
    receiptTrustStore: {
      version: 1,
      kind: 'AuthorityTrustStore',
      keys: [{
        keyId: 'recovery-signer-key',
        subjectId: 'reviewer-recovery-authority',
        organization: 'Reviewer Recovery Test Authority',
        algorithm: 'ed25519',
        publicKeyPem: pair.publicKey.export({
          type: 'spki',
          format: 'pem',
        }),
        roles: [ROLE],
        status: 'active',
        effectiveFrom: '2026-07-24T00:00:00.000Z',
        expiresAt: '2026-07-25T00:00:00.000Z',
        revokedAt: null,
      }],
    },
    receiptSignerKeyIds: ['recovery-signer-key'],
  });
  const operationId = H('operation');
  const idempotencyKey = H('idempotency-key');
  const subjectHash = H('subject');
  const principal = Object.freeze({
    principalId: 'reviewer-recovery-principal',
    principalDescriptorHash: H('principal-descriptor'),
    signerIdentityHash: configuration.signerIdentityHash,
    researchPrincipalPoolHash: H('principal-pool'),
  });
  const requestPayload = {
    version: 3,
    kind: 'ReviewerReceiptSigningRequest',
    subjectHash,
    principalId: principal.principalId,
    principalDescriptorHash: principal.principalDescriptorHash,
    researchPrincipalPoolHash: principal.researchPrincipalPoolHash,
  };
  const requestHash = hashRecord(
    'ReviewerReceiptSigningRequest',
    requestPayload,
  );
  const notFoundDocument = () => {
    const outcome = buildReviewerReceiptSigningRecoveryOutcome({
      serviceId,
      serviceIdentityHash: configuration.serviceIdentityHash,
      operationId,
      idempotencyKey,
      requestHash,
      operationStatus: 'not_found',
      externalActionPerformed: false,
      resultHash: null,
    });
    return {
      operationId,
      idempotencyKey,
      requestHash,
      serviceId,
      serviceIdentityHash: configuration.serviceIdentityHash,
      operationStatus: 'not_found',
      externalActionPerformed: false,
      signedReviewerReceipt: null,
      authorityEnvelope: null,
      recoveryAuthorityEnvelope: signedEnvelope(pair, {
        subjectKind: outcome.kind,
        subjectHash: outcome.reviewerReceiptSigningRecoveryOutcomeHash,
      }),
    };
  };
  const completedDocument = (observedRequestHash) => {
    const outcome = buildReviewerReceiptSigningRecoveryOutcome({
      serviceId,
      serviceIdentityHash: configuration.serviceIdentityHash,
      operationId,
      idempotencyKey,
      requestHash: observedRequestHash,
      operationStatus: 'completed',
      externalActionPerformed: true,
      resultHash: subjectHash,
    });
    return {
      operationId,
      idempotencyKey,
      requestHash: observedRequestHash,
      serviceId,
      serviceIdentityHash: configuration.serviceIdentityHash,
      operationStatus: 'completed',
      externalActionPerformed: true,
      signedReviewerReceipt: null,
      authorityEnvelope: signedEnvelope(pair, {
        subjectKind: 'ReviewerReceiptSigningSubjectV1',
        subjectHash,
      }),
      recoveryAuthorityEnvelope: signedEnvelope(pair, {
        subjectKind: outcome.kind,
        subjectHash: outcome.reviewerReceiptSigningRecoveryOutcomeHash,
      }),
    };
  };
  const create = (fetchImpl) => createHttpReviewerReceiptSignerAdapter({
    configuration,
    environment: { REVIEWER_RECOVERY_TOKEN: 'test-token' },
    clock: { now: () => NOW },
    fetchImpl,
  });
  const lookup = (signer) => signer.lookup({
    operationId,
    idempotencyKey,
    subjectHash,
    principal,
  });
  return Object.freeze({
    completedDocument,
    configuration,
    create,
    idempotencyKey,
    lookup,
    notFoundDocument,
    operationId,
    principal,
    subjectHash,
  });
}

test('signer recovery v3 preserves one operation identity across action, lookup, and resume', async () => {
  const input = fixture();
  const calls = [];
  const signer = input.create(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), init, body });
    const requestHash = init.method === 'GET'
      ? new URL(url).searchParams.get('requestHash') : body.requestHash;
    return {
      ok: true,
      status: 200,
      async json() {
        return init.method === 'GET'
          ? input.notFoundDocument()
          : input.completedDocument(requestHash);
      },
    };
  });
  assert.equal(signer.version, 2);
  assert.equal(signer.configurationVersion, 3);
  assert.equal(signer.crashRecoveryReady, true);
  assert.equal(signer.recoveryOutcomeCryptographicAuthorityReady, true);
  assert.match(
    signer.recoveryOutcomeVerificationPolicyHash,
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.deepEqual(await input.lookup(signer), {
    status: 'not_found',
    receipt: null,
  });
  const resumed = await signer.resume({
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    subjectHash: input.subjectHash,
    principal: input.principal,
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.receipt.version, 2);
  const signed = await signer.sign({
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    subjectHash: input.subjectHash,
    principal: input.principal,
  });
  assert.equal(signed.version, 2);

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(
      call.init.headers['operation-id'],
      input.operationId,
    );
    assert.equal(
      call.init.headers['idempotency-key'],
      input.idempotencyKey,
    );
  }
  const lookupUrl = new URL(calls[0].url);
  assert.equal(
    lookupUrl.searchParams.get('operationId'),
    input.operationId,
  );
  assert.equal(
    lookupUrl.searchParams.get('idempotencyKey'),
    input.idempotencyKey,
  );
  assert.equal(calls[1].body.version, 1);
  assert.equal(
    calls[1].body.kind,
    'ReviewerReceiptSigningResumeRequest',
  );
  assert.equal(calls[1].body.request.version, 3);
  assert.equal(
    calls[1].body.request.kind,
    'ReviewerReceiptSigningRequest',
  );
  assert.equal(calls[2].body.version, 3);
  assert.equal(calls[2].body.kind, 'ReviewerReceiptSigningRequest');
  assert.equal(calls[2].body.operationId, input.operationId);
  assert.equal(calls[2].body.idempotencyKey, input.idempotencyKey);
});

test('signer recovery v3 rejects unverifiable and contradictory not-found outcomes', async () => {
  const input = fixture();
  const unsigned = input.create(async () => ({
    ok: true,
    status: 200,
    async json() {
      const { recoveryAuthorityEnvelope: _removed, ...document } =
        input.notFoundDocument();
      return document;
    },
  }));
  await assert.rejects(
    () => input.lookup(unsigned),
    /pinned_external_evidence/,
  );

  const contradictory = input.create(async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ...input.notFoundDocument(),
        externalActionPerformed: true,
      };
    },
  }));
  await assert.rejects(
    () => input.lookup(contradictory),
    /reviewer_receipt_signer_recovery_response_invalid/,
  );

  const receiptOnNotFound = input.create(async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ...input.notFoundDocument(),
        signedReviewerReceipt: {
          signedReviewerReceiptHash: H('unexpected-receipt'),
        },
      };
    },
  }));
  await assert.rejects(
    () => input.lookup(receiptOnNotFound),
    /reviewer_receipt_signer_recovery_response_invalid/,
  );

  const bareNotFound = input.create(async () => ({
    ok: false,
    status: 404,
  }));
  await assert.rejects(
    () => input.lookup(bareNotFound),
    /reviewer_receipt_signer_recovery_http_failed:404/,
  );
});

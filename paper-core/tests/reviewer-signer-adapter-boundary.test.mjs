import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReviewerReceiptSignerServiceConfiguration,
  buildReviewerSignerIdentityAttestationBundle,
  createHttpReviewerReceiptSignerAdapter,
  reviewerReceiptSignerCryptographicIdentityHash,
  verifyReviewerReceiptSignerServiceConfiguration,
} from '../../paper-adapters/automation/http-reviewer-receipt-signer-adapter.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('ReviewerCryptographicTrustV2Test', { label });

test('reviewer signer adapter rejects configuration and HTTP short-circuit edges', async () => {
  const identityHashInput = {
    receiptTrustStoreHash: H('edge-receipt-trust-store'),
    receiptSignerKeyIds: ['edge-reviewer-key'],
  };
  assert.match(
    reviewerReceiptSignerCryptographicIdentityHash(identityHashInput),
    /^sha256:[0-9a-f]{64}$/,
  );
  for (const [label, input] of [
    ['missing input', undefined],
    ['unsafe key id', { ...identityHashInput, receiptSignerKeyIds: ['unsafe key'] }],
    ['wrong signer role', { ...identityHashInput, receiptSignerRole: 'wrong-role' }],
  ]) {
    assert.throws(
      () => reviewerReceiptSignerCryptographicIdentityHash(input),
      /reviewer_receipt_signer_cryptographic_identity_invalid/,
      label,
    );
  }

  assert.throws(
    () => buildReviewerSignerIdentityAttestationBundle({ authorityEnvelope: {} }),
    /reviewer_signer_identity_attestation_bundle_invalid/,
  );

  const validInput = {
    version: 1,
    serviceId: 'edge-reviewer-signer',
    endpoint: 'https://reviewer-edge.example.test/v1/sign',
    serviceIdentityHash: H('edge-reviewer-service'),
    signerIdentityHash: H('edge-reviewer-signer'),
    tokenEnvironmentVariable: 'EDGE_REVIEWER_TOKEN',
    timeoutMs: 1_000,
  };
  const validConfiguration = buildReviewerReceiptSignerServiceConfiguration(validInput);
  assert.equal(verifyReviewerReceiptSignerServiceConfiguration(validConfiguration), true);
  for (const [label, patch, error] of [
    ['endpoint syntax', { endpoint: '%' }, /endpoint_invalid/],
    ['version', { version: 3 }, /service_configuration_invalid/],
    ['service id', { serviceId: '' }, /service_configuration_invalid/],
    ['service identity', { serviceIdentityHash: '' }, /service_configuration_invalid/],
    ['token variable', { tokenEnvironmentVariable: '' }, /service_configuration_invalid/],
    ['timeout ceiling', { timeoutMs: 10 * 60 * 1_000 + 1 }, /service_configuration_invalid/],
    ['signer identity', { signerIdentityHash: null }, /service_configuration_invalid/],
  ]) {
    assert.throws(
      () => buildReviewerReceiptSignerServiceConfiguration({ ...validInput, ...patch }),
      error,
      label,
    );
  }
  assert.equal(verifyReviewerReceiptSignerServiceConfiguration(null), false);
  assert.equal(verifyReviewerReceiptSignerServiceConfiguration({
    ...validConfiguration,
    endpoint: 'not-a-url',
  }), false);

  assert.throws(() => createHttpReviewerReceiptSignerAdapter({
    configuration: validConfiguration,
    environment: {},
    fetchImpl: async () => ({ ok: true }),
  }), /runtime_credentials_missing/);
  assert.throws(() => createHttpReviewerReceiptSignerAdapter({
    configuration: validConfiguration,
    environment: { EDGE_REVIEWER_TOKEN: 'token' },
    fetchImpl: null,
  }), /runtime_credentials_missing/);

  const principal = {
    principalId: 'edge-reviewer-principal',
    principalDescriptorHash: H('edge-reviewer-principal-descriptor'),
    signerIdentityHash: validConfiguration.signerIdentityHash,
  };
  const failedHttpAdapter = createHttpReviewerReceiptSignerAdapter({
    configuration: validConfiguration,
    environment: { EDGE_REVIEWER_TOKEN: 'token' },
    fetchImpl: async () => ({ ok: false, status: 0 }),
  });
  await assert.rejects(
    () => failedHttpAdapter.sign({ subjectHash: 'invalid', principal }),
    /reviewer_receipt_signer_request_invalid/,
  );
  await assert.rejects(
    () => failedHttpAdapter.sign({
      subjectHash: H('edge-review-subject'),
      principal: { ...principal, signerIdentityHash: H('wrong-signer') },
    }),
    /reviewer_receipt_signer_request_invalid/,
  );
  await assert.rejects(
    () => failedHttpAdapter.sign({ subjectHash: H('edge-review-subject'), principal }),
    /reviewer_receipt_signer_http_failed:0/,
  );

  const invalidDocumentAdapter = createHttpReviewerReceiptSignerAdapter({
    configuration: validConfiguration,
    environment: { EDGE_REVIEWER_TOKEN: 'token' },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      return {
        ok: true,
        async json() {
          return {
            requestHash: request.requestHash,
            serviceId: validConfiguration.serviceId,
            serviceIdentityHash: validConfiguration.serviceIdentityHash,
            externalActionPerformed: false,
          };
        },
      };
    },
  });
  const signal = new AbortController().signal;
  await assert.rejects(
    () => invalidDocumentAdapter.sign({
      subjectHash: H('edge-review-subject'),
      principal,
      signal,
    }),
    /reviewer_receipt_signer_response_invalid/,
  );

  const missingReceiptAdapter = createHttpReviewerReceiptSignerAdapter({
    configuration: validConfiguration,
    environment: { EDGE_REVIEWER_TOKEN: 'token' },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      return {
        ok: true,
        async json() {
          return {
            requestHash: request.requestHash,
            serviceId: validConfiguration.serviceId,
            serviceIdentityHash: validConfiguration.serviceIdentityHash,
            externalActionPerformed: true,
          };
        },
      };
    },
  });
  await assert.rejects(
    () => missingReceiptAdapter.sign({ subjectHash: H('edge-review-subject'), principal }),
    /reviewer_receipt_signer_response_invalid/,
  );
});

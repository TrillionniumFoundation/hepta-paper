import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    ['version', { version: 4 }, /service_configuration_invalid/],
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

test('reviewer signer adapter makes no HTTP request for a pre-aborted signal', async () => {
  const configuration = buildReviewerReceiptSignerServiceConfiguration({
    version: 1,
    serviceId: 'pre-aborted-reviewer-signer',
    endpoint: 'https://reviewer-edge.example.test/v1/sign',
    serviceIdentityHash: H('pre-aborted-reviewer-service'),
    signerIdentityHash: H('pre-aborted-reviewer-signer'),
    tokenEnvironmentVariable: 'EDGE_REVIEWER_TOKEN',
    timeoutMs: 1_000,
  });
  const principal = {
    principalId: 'pre-aborted-reviewer-principal',
    principalDescriptorHash: H('pre-aborted-reviewer-principal-descriptor'),
    signerIdentityHash: configuration.signerIdentityHash,
  };
  let fetchCalls = 0;
  const selected = createHttpReviewerReceiptSignerAdapter({
    configuration,
    environment: { EDGE_REVIEWER_TOKEN: 'token' },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('fetch_must_not_run');
    },
  });
  const controller = new AbortController();
  const abortReason = new Error('reviewer_signer_pre_aborted');
  controller.abort(abortReason);

  await assert.rejects(() => selected.sign({
    subjectHash: H('pre-aborted-review-subject'),
    principal,
    signal: controller.signal,
  }), (error) => error === abortReason);
  assert.equal(fetchCalls, 0);
});

test('reviewer signer resolves an opaque credential file without leaking it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-reviewer-credential-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credentialPath = path.join(root, 'reviewer-token');
  const credential = 'reviewer-file-secret-value';
  fs.writeFileSync(credentialPath, `${credential}\n`, { mode: 0o600 });
  const configuration = buildReviewerReceiptSignerServiceConfiguration({
    version: 1,
    serviceId: 'file-credential-reviewer-signer',
    endpoint: 'https://reviewer-edge.example.test/v1/sign',
    serviceIdentityHash: H('file-credential-reviewer-service'),
    signerIdentityHash: H('file-credential-reviewer-signer'),
    tokenEnvironmentVariable: 'EDGE_REVIEWER_TOKEN_FILE',
    timeoutMs: 1_000,
  });
  const principal = {
    principalId: 'file-credential-reviewer-principal',
    principalDescriptorHash: H('file-credential-reviewer-principal-descriptor'),
    signerIdentityHash: configuration.signerIdentityHash,
  };
  let authorization = null;
  const selected = createHttpReviewerReceiptSignerAdapter({
    configuration,
    environment: { EDGE_REVIEWER_TOKEN_FILE: credentialPath },
    fetchImpl: async (_url, init) => {
      authorization = init.headers.authorization;
      return { ok: false, status: 503 };
    },
  });
  let failure = null;
  try {
    await selected.sign({
      subjectHash: H('file-credential-review-subject'),
      principal,
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(authorization, `Bearer ${credential}`);
  assert.notEqual(authorization, `Bearer ${credentialPath}`);
  assert.match(String(failure?.message), /reviewer_receipt_signer_http_failed:503/);
  assert.equal(String(failure).includes(credential), false);
  assert.equal(String(failure).includes(credentialPath), false);
});

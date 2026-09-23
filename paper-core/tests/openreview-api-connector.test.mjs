import assert from 'node:assert/strict';
import test from 'node:test';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import {
  buildOpenReviewSubmissionPlan,
  openReviewNoteEditFromPlan,
  verifyOpenReviewSubmissionPlan,
} from '../../paper-domain/submission/openreview-submission-plan.mjs';
import { createOpenReviewApiConnector } from '../../paper-adapters/submission/openreview-api-connector.mjs';

function fixture() {
  const pdfBytes = Buffer.from('%PDF-1.7\nbounded fixture\n');
  const request = Object.freeze({
    kind: 'AutonomousSubmissionRequest',
    requestHash: `sha256:${'1'.repeat(64)}`,
    idempotencyKey: `sha256:${'2'.repeat(64)}`,
    compiledPdfHash: hashBytes(pdfBytes),
    venueId: 'ICLR.cc/2027/Conference',
  });
  const plan = buildOpenReviewSubmissionPlan({
    request,
    invitation: 'ICLR.cc/2027/Conference/-/Submission',
    title: 'Bounded Autonomous Research',
    abstract: 'A fully evidence-bound fixture.',
    authorNames: ['Ada Lovelace'],
    authorProfiles: ['~Ada_Lovelace1'],
    keywords: ['automation', 'verification'],
    content: { venueid: 'ICLR.cc/2027/Conference' },
  });
  return { pdfBytes, request, plan };
}

function client({ existing = null } = {}) {
  const calls = [];
  return {
    calls,
    value: Object.freeze({
      kind: 'OpenReviewClientPort',
      networkPolicy: 'openreview-only',
      credentialIsolation: true,
      async findNoteByIdempotencyKey(input) {
        calls.push(['find', input]);
        return existing;
      },
      async uploadPdf(input) {
        calls.push(['upload', input]);
        return { url: 'https://openreview.net/pdf/fixture.pdf' };
      },
      async postNoteEdit(input) {
        calls.push(['post', input]);
        return { id: 'note-1', forum: 'forum-1', mnumber: 1 };
      },
    }),
  };
}

test('OpenReview plan is exact, hash-bound, and maps to API v2 content values', () => {
  const { request, plan } = fixture();
  assert.equal(verifyOpenReviewSubmissionPlan(plan, { request }), true);
  const edit = openReviewNoteEditFromPlan(plan, {
    pdfUrl: 'https://openreview.net/pdf/fixture.pdf',
  });
  assert.equal(edit.content.title.value, plan.title);
  assert.equal(edit.content.hepta_submission_idempotency_key.value, plan.idempotencyKey);
  assert.equal(edit.content.hepta_submission_plan_hash.value, plan.openReviewSubmissionPlanHash);
  assert.equal(verifyOpenReviewSubmissionPlan({ ...plan, title: 'changed' }, { request }), false);
});

test('OpenReview connector uploads exact PDF once and emits a non-production observation receipt', async () => {
  const { pdfBytes, request, plan } = fixture();
  const transport = client();
  const connector = createOpenReviewApiConnector({ client: transport.value });
  const receipt = await connector.submit({ request, plan, pdfBytes });
  assert.deepEqual(transport.calls.map(([operation]) => operation), ['find', 'upload', 'post']);
  assert.equal(receipt.externalActionPerformed, true);
  assert.equal(receipt.productionEligible, false);
  assert.equal(receipt.cryptographicPortalAuthorityVerified, false);
  await assert.rejects(
    connector.submit({ request, plan, pdfBytes: Buffer.from('changed') }),
    /openreview_submission_material_invalid/,
  );
});

test('OpenReview connector reuses an idempotent remote note without upload', async () => {
  const { pdfBytes, request, plan } = fixture();
  const transport = client({ existing: { id: 'note-existing', forum: 'forum-existing' } });
  const connector = createOpenReviewApiConnector({ client: transport.value });
  const receipt = await connector.submit({ request, plan, pdfBytes });
  assert.deepEqual(transport.calls.map(([operation]) => operation), ['find']);
  assert.equal(receipt.operation, 'lookup');
  assert.equal(receipt.externalActionPerformed, false);
});

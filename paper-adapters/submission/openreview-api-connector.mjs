import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { assertOpenReviewClientPort } from '../../paper-ports/openreview-client-port.mjs';
import {
  openReviewNoteEditFromPlan,
  verifyOpenReviewSubmissionPlan,
} from '../../paper-domain/submission/openreview-submission-plan.mjs';

function remoteReceipt(plan, note, operation) {
  const noteId = String(note?.id || '').trim();
  const forumId = String(note?.forum || noteId).trim();
  if (!noteId || !forumId) throw new Error('openreview_remote_note_identity_invalid');
  const payload = {
    version: 1,
    kind: 'OpenReviewConnectorReceipt',
    status: 'openreview_remote_submission_observed',
    operation,
    requestHash: plan.requestHash,
    idempotencyKey: plan.idempotencyKey,
    openReviewSubmissionPlanHash: plan.openReviewSubmissionPlanHash,
    venueId: plan.venueId,
    invitation: plan.invitation,
    noteId,
    forumId,
    remoteModificationNumber: Number.isSafeInteger(note?.mnumber) ? note.mnumber : null,
    externalActionPerformed: operation === 'post',
    cryptographicPortalAuthorityVerified: false,
    productionEligible: false,
  };
  return Object.freeze({
    ...payload,
    openReviewConnectorReceiptHash: hashRecord('OpenReviewConnectorReceipt', payload),
  });
}

export function createOpenReviewApiConnector({ client: suppliedClient } = {}) {
  const client = assertOpenReviewClientPort(suppliedClient);
  return Object.freeze({
    version: 1,
    kind: 'OpenReviewApiConnector',
    provider: 'openreview',
    productionEligible: false,
    limitation:
      'official API observation is not a signed independent portal receipt',
    async lookup({ request, plan, signal = null } = {}) {
      if (!verifyOpenReviewSubmissionPlan(plan, { request })) {
        throw new Error('openreview_submission_plan_invalid');
      }
      const note = await client.findNoteByIdempotencyKey({
        invitation: plan.invitation,
        idempotencyKey: plan.idempotencyKey,
        signal,
      });
      return note ? remoteReceipt(plan, note, 'lookup') : null;
    },
    async submit({ request, plan, pdfBytes, signal = null } = {}) {
      if (!verifyOpenReviewSubmissionPlan(plan, { request })
        || !Buffer.isBuffer(pdfBytes)
        || hashBytes(pdfBytes) !== plan.compiledPdfHash) {
        throw new Error('openreview_submission_material_invalid');
      }
      const existing = await client.findNoteByIdempotencyKey({
        invitation: plan.invitation,
        idempotencyKey: plan.idempotencyKey,
        signal,
      });
      if (existing) return remoteReceipt(plan, existing, 'lookup');
      const uploaded = await client.uploadPdf({
        bytes: pdfBytes,
        contentHash: plan.compiledPdfHash,
        signal,
      });
      const noteEdit = openReviewNoteEditFromPlan(plan, { pdfUrl: uploaded?.url });
      const note = await client.postNoteEdit({ noteEdit, signal });
      return remoteReceipt(plan, note, 'post');
    },
  });
}

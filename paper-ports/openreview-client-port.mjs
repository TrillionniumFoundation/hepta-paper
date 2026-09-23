export function assertOpenReviewClientPort(value) {
  if (value?.kind !== 'OpenReviewClientPort'
    || typeof value.uploadPdf !== 'function'
    || typeof value.postNoteEdit !== 'function'
    || typeof value.findNoteByIdempotencyKey !== 'function'
    || value.networkPolicy !== 'openreview-only'
    || value.credentialIsolation !== true) {
    throw new Error('openreview_client_port_invalid');
  }
  return value;
}

export function assertOpenReviewSubmissionClientPort(value) {
  const selected = assertOpenReviewClientPort(value);
  if (typeof selected.probe !== 'function'
    || typeof selected.getInvitationSchema !== 'function'
    || typeof selected.validateContent !== 'function'
    || typeof selected.getNote !== 'function') {
    throw new Error('openreview_submission_client_port_invalid');
  }
  return selected;
}

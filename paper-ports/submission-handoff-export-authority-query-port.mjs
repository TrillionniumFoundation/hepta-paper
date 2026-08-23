export function assertSubmissionHandoffExportAuthorityQueryPort(value) {
  if (value?.version !== 1
      || value?.kind !== 'SubmissionHandoffExportAuthorityQueryPort'
      || value?.readOnly !== true
      || typeof value.getCurrentReviewedSubmissionAuthority !== 'function') {
    throw new Error('submission_handoff_export_authority_query_port_invalid');
  }
  return value;
}

export function createSubmissionHandoffExportAuthorityQueryCapability(value) {
  const query = assertSubmissionHandoffExportAuthorityQueryPort(value);
  return Object.freeze({
    version: query.version,
    kind: query.kind,
    readOnly: true,
    getCurrentReviewedSubmissionAuthority(input) {
      return query.getCurrentReviewedSubmissionAuthority(input);
    },
  });
}

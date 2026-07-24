export function assertSubmissionCommitPermitAuthorityPort(value) {
  if (value?.kind !== 'SubmissionCommitPermitAuthority'
    || value.singleUsePermitConsumption !== true
    || value.durableConsumptionRequired !== true
    || typeof value.consume !== 'function') {
    throw new Error('submission_commit_permit_authority_port_invalid');
  }
  return value;
}

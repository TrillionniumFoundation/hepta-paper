export function assertAutonomousSubmissionOutboxPort(value) {
  if (!value || value.kind !== 'AutonomousSubmissionOutboxPort'
    || value.durability !== 'sqlite-transactional-outbox-v1'
    || value.singleUseDispatchCapabilityIssued !== true
    || typeof value.externallyFencedMutations !== 'boolean') {
    throw new Error('autonomous_submission_outbox_port_invalid');
  }
  for (const method of [
    'prepareAutonomousSubmission',
    'beginAutonomousSubmissionAttempt',
    'recordAutonomousSubmissionOutcome',
    'getAutonomousSubmission',
    'listAutonomousSubmissionsForCampaign',
    'listDispatchableAutonomousSubmissions',
  ]) {
    if (typeof value[method] !== 'function') {
      throw new Error('autonomous_submission_outbox_port_invalid');
    }
  }
  return value;
}

export function assertAutonomousSubmissionHandoffOutboxPort(value) {
  if (!value || !['AutonomousSubmissionHandoffOutboxPort', 'AutonomousSubmissionOutboxPort']
    .includes(value.kind)
    || value.durability !== 'sqlite-transactional-outbox-v1'
    || typeof value.externallyFencedMutations !== 'boolean') {
    throw new Error('autonomous_submission_handoff_outbox_port_invalid');
  }
  for (const method of [
    'prepareAutonomousSubmission',
    'getAutonomousSubmission',
    'listAutonomousSubmissionsForCampaign',
  ]) {
    if (typeof value[method] !== 'function') {
      throw new Error('autonomous_submission_handoff_outbox_port_invalid');
    }
  }
  return value;
}

export function assertAutonomousSubmissionRequestVerifierPort(value) {
  if (value?.version !== 1
    || value?.kind !== 'AutonomousSubmissionRequestVerifier'
    || typeof value.verify !== 'function') {
    throw new Error('AutonomousSubmissionRequestVerifierPort invalid');
  }
  return value;
}

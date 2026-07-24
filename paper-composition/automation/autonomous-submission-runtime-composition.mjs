import {
  createAutonomousSubmissionOutboxRepository,
} from '../../paper-adapters/automation/autonomous-submission-outbox-repository.mjs';
import {
  createAutonomousSubmissionDispatchAuthority,
} from './autonomous-submission-dispatch-authority-composition.mjs';
import {
  composePinnedAutonomousSubmissionRequestVerifier,
} from './autonomous-submission-request-verifier-composition.mjs';

function assertAutonomousSubmissionDispatchAuthority(authority) {
  if (authority?.kind !== 'AutonomousSubmissionDispatchAuthority'
    || authority.outbox?.kind
      !== 'AutonomousSubmissionOutboxDispatchCapabilityAuthority'
    || authority.portal?.kind
      !== 'AutonomousSubmissionPortalDispatchCapabilityAuthority') {
    throw new Error('autonomous_submission_dispatch_authority_invalid');
  }
  return authority;
}

export function composeAutonomousSubmissionDispatchContext({
  root,
  runtimeRoot,
  clock = null,
  environment = process.env,
  autonomousSubmissionDispatchAuthority = null,
  handoffOnly = false,
} = {}) {
  const autonomousSubmissionRequestVerifier =
    composePinnedAutonomousSubmissionRequestVerifier({
      root,
      runtimeRoot,
      clock,
      environment,
      allowPortalCredential: !handoffOnly,
    });
  const dispatchAuthority = handoffOnly ? null : assertAutonomousSubmissionDispatchAuthority(
    autonomousSubmissionDispatchAuthority || createAutonomousSubmissionDispatchAuthority(),
  );
  return Object.freeze({
    autonomousSubmissionRequestVerifier,
    autonomousSubmissionDispatchAuthority: dispatchAuthority,
  });
}

export function composeAutonomousSubmissionOutbox({
  store,
  receiptLedger,
  clock,
  autonomousSubmissionRequestVerifier,
  autonomousSubmissionDispatchAuthority,
  autonomousSubmissionOutbox = null,
  handoffOnly = false,
  dedicatedHandoffRequired = false,
} = {}) {
  return autonomousSubmissionOutbox || createAutonomousSubmissionOutboxRepository({
    store,
    receiptLedger,
    clock,
    submissionRequestVerifier: autonomousSubmissionRequestVerifier,
    dispatchCapability: autonomousSubmissionDispatchAuthority?.outbox || null,
    handoffOnly,
    dedicatedHandoffRequired,
  });
}

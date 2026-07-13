import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function normalizedHashes(values = []) {
  return uniqueStrings(values).sort();
}

function sha256Hash(value) {
  return /^sha256:[a-f0-9]{64}$/i.test(String(value || ''));
}

export function buildLiveVenueStateProof({
  dispatchAuthorization,
  responseIntake,
  observation = null,
} = {}) {
  const blockers = [];
  if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') {
    blockers.push('dispatch_authorization_not_ready');
  }
  if (responseIntake?.status !== 'executor_response_accepted') blockers.push('executor_response_not_accepted');
  if (!observation) blockers.push('live_venue_observation_missing');
  if (observation && !observation.observedAt) blockers.push('venue_observation_timestamp_missing');
  if (observation && observation.dispatchAuthorizationHash !== dispatchAuthorization?.submissionDispatchAuthorizationHash) {
    blockers.push('venue_observation_dispatch_hash_mismatch');
  }
  if (observation && observation.executorResponseIntakeHash !== responseIntake?.executorResponseIntakeHash) {
    blockers.push('venue_observation_response_hash_mismatch');
  }
  if (observation && observation.provider !== dispatchAuthorization?.provider) {
    blockers.push('venue_observation_provider_mismatch');
  }
  if (observation && observation.accountId !== dispatchAuthorization?.accountId) {
    blockers.push('venue_observation_account_mismatch');
  }
  if (responseIntake?.outcome === 'submitted') {
    if (!responseIntake.providerReceiptHash) blockers.push('provider_receipt_missing');
    if (observation?.providerReceiptHash !== responseIntake.providerReceiptHash) {
      blockers.push('venue_observation_provider_receipt_hash_mismatch');
    }
    if (!responseIntake.submissionId || observation?.submissionId !== responseIntake.submissionId) {
      blockers.push('venue_observation_submission_id_mismatch');
    }
    if (!['submitted', 'received', 'under_review'].includes(observation?.observedState)) {
      blockers.push('venue_observation_state_invalid');
    }
    if (!Array.isArray(observation?.evidenceHashes) || !observation.evidenceHashes.filter(Boolean).length) {
      blockers.push('venue_observation_evidence_missing');
    }
    if ((observation?.evidenceHashes || []).some((hash) => !sha256Hash(hash))) blockers.push('venue_observation_evidence_hash_invalid');
  } else if (['rejected', 'cancelled'].includes(responseIntake?.outcome)) {
    if (observation?.observedState !== responseIntake.outcome) blockers.push('venue_observation_terminal_state_mismatch');
  } else {
    blockers.push('executor_response_not_terminal');
  }
  const payload = {
    version: 1,
    kind: 'LiveVenueStateProof',
    paperId: dispatchAuthorization?.paperId || null,
    status: blockers.length ? 'live_venue_state_proof_blocked' : 'live_venue_state_proof_verified',
    dispatchAuthorizationHash: dispatchAuthorization?.submissionDispatchAuthorizationHash || null,
    executorResponseIntakeHash: responseIntake?.executorResponseIntakeHash || null,
    responseEnvelopeHash: responseIntake?.responseEnvelopeHash || null,
    providerReceiptHash: responseIntake?.providerReceiptHash || null,
    provider: observation?.provider || null,
    accountId: observation?.accountId || null,
    submissionId: observation?.submissionId || null,
    observedState: observation?.observedState || null,
    observedAt: observation?.observedAt || null,
    observationEvidenceHashes: normalizedHashes(observation?.evidenceHashes || []),
    externalStateChanged: responseIntake?.outcome === 'submitted',
    blockers: uniqueStrings(blockers),
  };
  return Object.freeze({ ...payload, liveVenueStateProofHash: hashRecord('LiveVenueStateProof', payload) });
}

export function buildLiveSubmissionReconciliation({
  dispatchAuthorization,
  responseIntake,
  venueStateProof,
} = {}) {
  const blockers = [];
  if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') {
    blockers.push('dispatch_authorization_not_ready');
  }
  if (responseIntake?.status !== 'executor_response_accepted') blockers.push('executor_response_not_accepted');
  if (!['submitted', 'rejected', 'cancelled'].includes(responseIntake?.outcome)) {
    blockers.push('executor_response_not_terminal');
  }
  if (venueStateProof?.status !== 'live_venue_state_proof_verified') blockers.push('live_venue_state_proof_not_verified');
  if (venueStateProof?.dispatchAuthorizationHash !== dispatchAuthorization?.submissionDispatchAuthorizationHash) {
    blockers.push('live_reconciliation_dispatch_hash_mismatch');
  }
  if (venueStateProof?.executorResponseIntakeHash !== responseIntake?.executorResponseIntakeHash) {
    blockers.push('live_reconciliation_response_hash_mismatch');
  }
  if (venueStateProof?.responseEnvelopeHash !== responseIntake?.responseEnvelopeHash) blockers.push('live_reconciliation_response_envelope_mismatch');
  if (venueStateProof?.providerReceiptHash !== responseIntake?.providerReceiptHash) blockers.push('live_reconciliation_provider_receipt_mismatch');
  if (venueStateProof?.submissionId !== responseIntake?.submissionId) blockers.push('live_reconciliation_submission_id_mismatch');
  const payload = {
    version: 1,
    kind: 'LiveSubmissionReconciliation',
    paperId: dispatchAuthorization?.paperId || null,
    status: blockers.length ? 'live_submission_reconciliation_blocked' : 'live_submission_reconciled',
    outcome: responseIntake?.outcome || null,
    dispatchAuthorizationHash: dispatchAuthorization?.submissionDispatchAuthorizationHash || null,
    responseIntakeHash: responseIntake?.executorResponseIntakeHash || null,
    responseEnvelopeHash: responseIntake?.responseEnvelopeHash || null,
    providerReceiptHash: responseIntake?.providerReceiptHash || null,
    venueStateProofHash: venueStateProof?.liveVenueStateProofHash || null,
    submissionId: responseIntake?.submissionId || null,
    uploadedArtifactHashes: normalizedHashes(responseIntake?.uploadedArtifactHashes || []),
    externalActionPerformed: responseIntake?.outcome === 'submitted',
    blockers: uniqueStrings(blockers),
  };
  return Object.freeze({ ...payload, submissionReconciliationHash: hashRecord('LiveSubmissionReconciliation', payload) });
}

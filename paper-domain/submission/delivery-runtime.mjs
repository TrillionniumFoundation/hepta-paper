import { digest, hashRecord as hashPaperRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildSubmissionReleaseLock } from './release-lock.mjs';
import { buildLiveSubmissionReconciliation, buildLiveVenueStateProof } from './live-delivery-evidence.mjs';

function normalizedHashes(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))].sort();
}

function sha256Hash(value) {
  return /^sha256:[a-f0-9]{64}$/i.test(String(value || ''));
}

function normalizedIdentityList(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || ''))
      .filter(Boolean),
  )].sort();
}

export function inspectProviderCapabilityVerificationReceipt({
  receipt,
  expected = {},
  now = null,
} = {}) {
  const blockers = [];
  const {
    providerCapabilityVerificationReceiptHash: claimedHash,
    ...payload
  } = receipt || {};
  const validFromMs = Date.parse(String(receipt?.validFrom || ''));
  const expiresAtMs = Date.parse(String(receipt?.expiresAt || ''));
  const observedAtMs = now instanceof Date ? now.getTime() : Number.NaN;
  const verifiedSubjectIds = normalizedIdentityList(
    receipt?.verifiedSubjectIds,
  );
  if (receipt?.version !== 1
      || receipt?.kind !== 'ProviderCapabilityVerificationReceipt'
      || receipt?.status !== 'provider_capability_verified'
      || !Array.isArray(receipt?.blockers)
      || receipt.blockers.length !== 0) {
    blockers.push('provider_capability_receipt_contract_invalid');
  }
  if (!sha256Hash(claimedHash)
      || claimedHash !== hashPaperRecord(
        'ProviderCapabilityVerificationReceipt',
        payload,
      )) {
    blockers.push('provider_capability_receipt_self_hash_invalid');
  }
  if (receipt?.cryptographicSignaturesVerified !== true) {
    blockers.push('provider_capability_receipt_signatures_unverified');
  }
  if (!receipt?.provider || !receipt?.accountId || !receipt?.portalRoute
      || !sha256Hash(receipt?.executorDescriptorHash)
      || !sha256Hash(receipt?.capabilitiesHash)
      || !sha256Hash(receipt?.attestationHash)
      || verifiedSubjectIds.length === 0
      || verifiedSubjectIds.length !== receipt?.verifiedSubjectIds?.length) {
    blockers.push('provider_capability_receipt_identity_invalid');
  }
  if (!Number.isFinite(validFromMs)
      || !Number.isFinite(expiresAtMs)
      || validFromMs >= expiresAtMs) {
    blockers.push('provider_capability_receipt_validity_invalid');
  }
  if (now !== null && (!Number.isFinite(observedAtMs)
      || validFromMs > observedAtMs
      || expiresAtMs <= observedAtMs)) {
    blockers.push('provider_capability_receipt_not_current');
  }
  const exactBindings = [
    ['provider', receipt?.provider],
    ['accountId', receipt?.accountId],
    ['portalRoute', receipt?.portalRoute],
    ['executorDescriptorHash', receipt?.executorDescriptorHash],
    ['capabilitiesHash', receipt?.capabilitiesHash],
    ['attestationHash', receipt?.attestationHash],
    ['providerCapabilityVerificationReceiptHash', claimedHash],
  ];
  for (const [field, observed] of exactBindings) {
    if (expected[field] !== undefined && expected[field] !== observed) {
      blockers.push(`provider_capability_receipt_binding_invalid:${field}`);
    }
  }
  if (expected.verifiedSubjectIds !== undefined
      && JSON.stringify(normalizedIdentityList(expected.verifiedSubjectIds))
        !== JSON.stringify(verifiedSubjectIds)) {
    blockers.push(
      'provider_capability_receipt_binding_invalid:verifiedSubjectIds',
    );
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    version: 1,
    kind: 'ProviderCapabilityVerificationReceiptInspection',
    status: uniqueBlockers.length
      ? 'provider_capability_verification_receipt_blocked'
      : 'provider_capability_verification_receipt_verified',
    ready: uniqueBlockers.length === 0,
    providerCapabilityVerificationReceiptHash: claimedHash || null,
    cryptographicSignaturesVerified:
      receipt?.cryptographicSignaturesVerified === true,
    currentSignatureRevalidated: false,
    originalSignedAttestationAvailable: false,
    validFrom: Number.isFinite(validFromMs) ? receipt.validFrom : null,
    expiresAt: Number.isFinite(expiresAtMs) ? receipt.expiresAt : null,
    verifiedSubjectIds: Object.freeze(verifiedSubjectIds),
    blockers: uniqueBlockers,
  });
}

export function buildSubmissionDispatchAuthorization({
  paperTask,
  outbox,
  replayGuard,
  reviewedSubmitPreflightPacket,
  controlledExecutorReceipt,
  liveAuthorizationReceipt,
  artifactPackage = null,
  redrivePlan = null,
  responseDueAt = null,
  submissionDecisionPacket = null,
  reviewedVenueEvidence = null,
  providerCapabilityVerificationReceipt = null,
} = {}) {
  const blockers = [];
  if (!paperTask?.taskKey) blockers.push('paper_task_required');
  if (outbox?.status !== 'queued_for_dry_run_executor') blockers.push('executor_outbox_not_ready');
  if (replayGuard?.status !== 'dry_run_replay_allowed') blockers.push('replay_guard_not_ready');
  if (!sha256Hash(replayGuard?.replayKey)) blockers.push('persistent_replay_key_missing');
  if (reviewedSubmitPreflightPacket?.status !== 'reviewed_submit_preflight_ready_for_external_executor') {
    blockers.push('reviewed_submit_preflight_not_ready');
  }
  if (controlledExecutorReceipt?.status !== 'controlled_external_executor_receipt_recorded') {
    blockers.push('controlled_executor_boundary_not_ready');
  }
  if (!controlledExecutorReceipt?.executorId || !sha256Hash(controlledExecutorReceipt?.executorDescriptorHash)
    || !sha256Hash(controlledExecutorReceipt?.executorCapabilitiesHash)) blockers.push('controlled_executor_identity_not_bound');
  if (liveAuthorizationReceipt?.authorizationSubject?.executorDescriptorHash !== controlledExecutorReceipt?.executorDescriptorHash) {
    blockers.push('live_authorization_executor_descriptor_mismatch');
  }
  if (liveAuthorizationReceipt?.status !== 'live_submission_authorization_verified') {
    blockers.push('live_submission_authorization_not_verified');
  }
  const artifactPackageHash = artifactPackage?.artifactPackageHash
    || reviewedSubmitPreflightPacket?.artifactPackageHash
    || null;
  const expectedArtifactHashes = normalizedHashes((artifactPackage?.artifacts || []).map((item) => item?.hash));
  if (artifactPackage?.submitReady !== true || !artifactPackageHash || !expectedArtifactHashes.length) {
    blockers.push('submit_ready_artifact_package_not_bound');
  }
  if (expectedArtifactHashes.length !== (artifactPackage?.artifacts || []).length) blockers.push('artifact_package_contains_unhashed_artifact');
  if (expectedArtifactHashes.some((hash) => !sha256Hash(hash))) blockers.push('artifact_package_contains_invalid_hash');
  if (artifactPackageHash) {
    const {
      artifactPackageHash: _artifactPackageHash,
      semanticIdentityVersion: _semanticIdentityVersion,
      semanticIdentityHash: _semanticIdentityHash,
      ...artifactPackagePayload
    } = artifactPackage || {};
    if (digest({ version: 1, kind: 'PaperArtifactPackage', payload: artifactPackagePayload }) !== artifactPackageHash) blockers.push('artifact_package_hash_invalid');
  }
  if (liveAuthorizationReceipt?.authorizationSubject?.artifactPackageHash !== artifactPackageHash) {
    blockers.push('live_authorization_artifact_package_mismatch');
  }
  if (submissionDecisionPacket?.status !== 'reviewed_submission_decision_verified') blockers.push('reviewed_submission_decision_not_verified');
  if (liveAuthorizationReceipt?.authorizationSubject?.reviewedSubmissionDecisionPacketHash !== submissionDecisionPacket?.reviewedSubmissionDecisionPacketHash) {
    blockers.push('live_authorization_submission_decision_mismatch');
  }
  if (reviewedVenueEvidence?.status !== 'reviewed_venue_evidence_verified') blockers.push('reviewed_venue_evidence_not_verified');
  if (liveAuthorizationReceipt?.authorizationSubject?.reviewedVenueEvidenceHash !== reviewedVenueEvidence?.reviewedVenueEvidenceHash) {
    blockers.push('live_authorization_reviewed_venue_evidence_mismatch');
  }
  if (liveAuthorizationReceipt?.authorizationSubject?.venueObservationSourceVerificationReceiptHash !== reviewedVenueEvidence?.sourceVerificationReceiptHash) {
    blockers.push('live_authorization_venue_source_receipt_mismatch');
  }
  if (providerCapabilityVerificationReceipt?.status !== 'provider_capability_verified') blockers.push('provider_capability_not_verified');
  if (!providerCapabilityVerificationReceipt?.provider
    || !providerCapabilityVerificationReceipt?.accountId
    || providerCapabilityVerificationReceipt.provider
      !== liveAuthorizationReceipt?.provider
    || providerCapabilityVerificationReceipt.accountId
      !== liveAuthorizationReceipt?.accountId) {
    blockers.push('provider_capability_principal_mismatch');
  }
  if (liveAuthorizationReceipt?.authorizationSubject?.providerCapabilityVerificationReceiptHash !== providerCapabilityVerificationReceipt?.providerCapabilityVerificationReceiptHash) blockers.push('live_authorization_provider_capability_mismatch');
  if (liveAuthorizationReceipt?.authorizationSubject?.portalRoute !== providerCapabilityVerificationReceipt?.portalRoute
    || reviewedVenueEvidence?.portalRoute !== providerCapabilityVerificationReceipt?.portalRoute) blockers.push('provider_capability_portal_route_mismatch');
  if (redrivePlan) {
    if (redrivePlan.status !== 'submission_redrive_reauthorization_required') blockers.push('redrive_plan_not_ready_for_reauthorization');
    if (liveAuthorizationReceipt?.nonce === redrivePlan.priorNonce) blockers.push('redrive_authorization_nonce_not_fresh');
    if (liveAuthorizationReceipt?.liveSubmissionAuthorizationReceiptHash === redrivePlan.priorLiveAuthorizationHash) {
      blockers.push('redrive_authorization_receipt_not_fresh');
    }
    if (liveAuthorizationReceipt?.provider !== redrivePlan.provider) blockers.push('redrive_authorization_provider_mismatch');
    if (liveAuthorizationReceipt?.accountId !== redrivePlan.accountId) blockers.push('redrive_authorization_account_mismatch');
    if (artifactPackageHash !== redrivePlan.artifactPackageHash) blockers.push('redrive_artifact_package_mismatch');
    if (liveAuthorizationReceipt?.authorizationSubject?.redrivePlanHash !== redrivePlan?.submissionRedrivePlanHash) blockers.push('redrive_plan_not_bound_to_live_authorization');
    if (liveAuthorizationReceipt?.authorizationSubject?.redriveDecisionHash !== redrivePlan?.redriveDecisionHash) blockers.push('redrive_decision_not_bound_to_live_authorization');
    if (liveAuthorizationReceipt?.authorizationSubject?.priorDispatchCycleHash !== redrivePlan?.priorDispatchCycleHash) blockers.push('redrive_prior_cycle_not_bound_to_live_authorization');
    if (expectedArtifactHashes.length !== redrivePlan.expectedArtifactHashes?.length
      || expectedArtifactHashes.some((hash, index) => hash !== redrivePlan.expectedArtifactHashes[index])) {
      blockers.push('redrive_artifact_hash_set_mismatch');
    }
  }
  const effectiveResponseDueAt = responseDueAt || liveAuthorizationReceipt?.responseDueAt || null;
  const responseDueMs = Date.parse(String(effectiveResponseDueAt || ''));
  if (!Number.isFinite(responseDueMs)) blockers.push('executor_response_due_at_invalid');
  const effectiveReplayKey = redrivePlan
    ? hashPaperRecord('SubmissionRedriveReplayKey', { replayKey: replayGuard?.replayKey || null, redrivePlanHash: redrivePlan?.submissionRedrivePlanHash || null })
    : replayGuard?.replayKey || null;
  const actionScopeKey = hashPaperRecord('SubmissionActionScopeKey', {
    paperId: paperTask?.paperId || null,
    action: 'reviewed_submit',
    artifactPackageHash,
    reviewedSubmissionDecisionPacketHash: submissionDecisionPacket?.reviewedSubmissionDecisionPacketHash || null,
    venueTarget: liveAuthorizationReceipt?.authorizationSubject?.venueTarget || null,
    provider: liveAuthorizationReceipt?.provider || null,
    accountId: liveAuthorizationReceipt?.accountId || null,
    portalRoute: providerCapabilityVerificationReceipt?.portalRoute || null,
    providerCapabilityVerificationReceiptHash: providerCapabilityVerificationReceipt?.providerCapabilityVerificationReceiptHash || null,
  });
  const dispatchCycleHash = hashPaperRecord('SubmissionDispatchCycle', {
    paperId: paperTask?.paperId || null,
    replayKey: effectiveReplayKey,
    nonce: liveAuthorizationReceipt?.nonce || null,
    liveAuthorizationHash: liveAuthorizationReceipt?.liveSubmissionAuthorizationReceiptHash || null,
    priorDispatchAuthorizationHash: redrivePlan?.dispatchAuthorizationHash || null,
    attempt: redrivePlan?.nextAttempt || 1,
  });
  const record = {
    version: 1,
    kind: 'SubmissionDispatchAuthorization',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'submission_dispatch_authorization_blocked' : 'submission_dispatch_authorization_ready',
    outboxHash: outbox?.externalExecutorHandoffOutboxHash || null,
    replayGuardHash: replayGuard?.submissionReplayGuardHash || null,
    replayKey: effectiveReplayKey,
    actionScopeKey,
    dispatchCycleHash,
    preflightHash: reviewedSubmitPreflightPacket?.reviewedSubmitPreflightPacketHash || null,
    controlledExecutorReceiptHash: controlledExecutorReceipt?.controlledExternalExecutorReceiptHash || null,
    executorId: controlledExecutorReceipt?.executorId || null,
    executorDescriptorHash: controlledExecutorReceipt?.executorDescriptorHash || null,
    executorCapabilitiesHash: controlledExecutorReceipt?.executorCapabilitiesHash || null,
    liveAuthorizationHash: liveAuthorizationReceipt?.liveSubmissionAuthorizationReceiptHash || null,
    artifactPackageHash,
    expectedArtifactHashes,
    reviewedSubmissionDecisionPacketHash:
      submissionDecisionPacket?.reviewedSubmissionDecisionPacketHash || null,
    provider: liveAuthorizationReceipt?.provider || null,
    accountId: liveAuthorizationReceipt?.accountId || null,
    providerCapabilityVerificationReceiptHash:
      providerCapabilityVerificationReceipt
        ?.providerCapabilityVerificationReceiptHash || null,
    portalRoute: providerCapabilityVerificationReceipt?.portalRoute || null,
    nonce: liveAuthorizationReceipt?.nonce || null,
    redrivePlanHash: redrivePlan?.submissionRedrivePlanHash || null,
    attempt: redrivePlan?.nextAttempt || 1,
    responseDueAt: Number.isFinite(responseDueMs) ? new Date(responseDueMs).toISOString() : null,
    blockers,
    externalActionPerformed: false,
  };
  return { ...record, submissionDispatchAuthorizationHash: hashPaperRecord('SubmissionDispatchAuthorization', record) };
}

export function buildExecutorResponseIntake({ dispatchAuthorization, response = null, responseVerificationReceipt = null } = {}) {
  const blockers = [];
  const identityBound = Boolean(dispatchAuthorization?.executorDescriptorHash);
  if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') blockers.push('dispatch_authorization_not_ready');
  if (!response) blockers.push('executor_response_missing');
  if (response && response.dispatchAuthorizationHash !== dispatchAuthorization?.submissionDispatchAuthorizationHash) {
    blockers.push('executor_response_dispatch_hash_mismatch');
  }
  if (response && !['submitted', 'rejected', 'failed', 'cancelled'].includes(response.outcome)) {
    blockers.push('executor_response_outcome_invalid');
  }
  if (response && (!response.responseId || !response.performedAt)) blockers.push('executor_response_identity_or_timestamp_missing');
  if (response?.outcome === 'submitted' && (!response.providerReceiptHash || !response.providerReceipt)) {
    blockers.push('provider_receipt_missing');
  }
  if (response?.outcome === 'submitted' && response.providerReceipt
    && hashPaperRecord('ProviderSubmissionReceipt', response.providerReceipt) !== response.providerReceiptHash) {
    blockers.push('provider_receipt_hash_invalid');
  }
  if (response && response.provider !== dispatchAuthorization?.provider) blockers.push('executor_response_provider_mismatch');
  if (response && response.accountId !== dispatchAuthorization?.accountId) blockers.push('executor_response_account_mismatch');
  if (response && identityBound && response.executorId !== dispatchAuthorization?.executorId) blockers.push('executor_response_executor_id_mismatch');
  if (response && identityBound && response.executorDescriptorHash !== dispatchAuthorization?.executorDescriptorHash) blockers.push('executor_response_executor_descriptor_mismatch');
  if (response && identityBound && response.capabilitiesHash !== dispatchAuthorization?.executorCapabilitiesHash) blockers.push('executor_response_capabilities_mismatch');
  if (response && identityBound && responseVerificationReceipt?.status !== 'executor_response_signature_verified') blockers.push('executor_response_signature_not_verified');
  if (response && identityBound && responseVerificationReceipt?.cryptographicSignaturesVerified !== true) blockers.push('executor_response_cryptographic_signature_not_verified');
  if (response && identityBound && responseVerificationReceipt?.responseId !== response.responseId) blockers.push('executor_response_signature_receipt_mismatch');
  if (response && identityBound && responseVerificationReceipt?.dispatchAuthorizationHash !== dispatchAuthorization?.submissionDispatchAuthorizationHash) blockers.push('executor_response_signature_dispatch_mismatch');
  if (response && identityBound && responseVerificationReceipt?.executorDescriptorHash !== dispatchAuthorization?.executorDescriptorHash) blockers.push('executor_response_signature_descriptor_mismatch');
  if (response?.outcome === 'submitted' && !response.submissionId) blockers.push('submission_id_missing');
  if (response?.outcome === 'submitted' && response.providerReceipt?.submissionId !== response.submissionId) {
    blockers.push('provider_receipt_submission_id_mismatch');
  }
  if (response?.outcome === 'submitted' && response.providerReceipt?.provider !== dispatchAuthorization?.provider) {
    blockers.push('provider_receipt_provider_mismatch');
  }
  if (response?.outcome === 'submitted' && response.providerReceipt?.accountId !== dispatchAuthorization?.accountId) {
    blockers.push('provider_receipt_account_mismatch');
  }
  if (response?.outcome === 'submitted' && response.providerReceipt?.dispatchAuthorizationHash !== dispatchAuthorization?.submissionDispatchAuthorizationHash) {
    blockers.push('provider_receipt_dispatch_hash_mismatch');
  }
  if (response && Number(response.attempt || 0) !== Number(dispatchAuthorization?.attempt || 0)) {
    blockers.push('executor_response_attempt_mismatch');
  }
  const expectedArtifactHashes = normalizedHashes(dispatchAuthorization?.expectedArtifactHashes || []);
  const uploadedArtifactHashes = normalizedHashes(response?.uploadedArtifactHashes || []);
  if (response?.outcome === 'submitted' && expectedArtifactHashes.length
    && (expectedArtifactHashes.length !== uploadedArtifactHashes.length
      || expectedArtifactHashes.some((hash, index) => hash !== uploadedArtifactHashes[index]))) {
    blockers.push('uploaded_artifact_hash_set_mismatch');
  }
  const receiptArtifactHashes = normalizedHashes(response?.providerReceipt?.uploadedArtifactHashes || []);
  if (response?.outcome === 'submitted' && (receiptArtifactHashes.length !== uploadedArtifactHashes.length
    || receiptArtifactHashes.some((hash, index) => hash !== uploadedArtifactHashes[index]))) {
    blockers.push('provider_receipt_artifact_hash_set_mismatch');
  }
  const responseEnvelope = response ? {
    responseId: response.responseId || null,
    outcome: response.outcome || null,
    dispatchAuthorizationHash: response.dispatchAuthorizationHash || null,
    provider: response.provider || null,
    accountId: response.accountId || null,
    submissionId: response.submissionId || null,
    providerReceiptHash: response.providerReceiptHash || null,
    uploadedArtifactHashes,
    performedAt: response.performedAt || null,
    attempt: Number(response.attempt || 0),
    executorId: response.executorId || null,
    executorDescriptorHash: response.executorDescriptorHash || null,
    capabilitiesHash: response.capabilitiesHash || null,
  } : null;
  const record = {
    version: 1,
    kind: 'ExecutorResponseIntake',
    paperId: dispatchAuthorization?.paperId || null,
    status: blockers.length ? 'executor_response_intake_blocked' : 'executor_response_accepted',
    dispatchAuthorizationHash: dispatchAuthorization?.submissionDispatchAuthorizationHash || null,
    responseId: response?.responseId || null,
    outcome: response?.outcome || null,
    provider: response?.provider || null,
    accountId: response?.accountId || null,
    submissionId: response?.submissionId || null,
    providerReceiptHash: response?.providerReceiptHash || null,
    uploadedArtifactHashes,
    performedAt: response?.performedAt || null,
    responseEnvelopeHash: responseEnvelope ? hashPaperRecord('ExternalExecutorResponseEnvelope', responseEnvelope) : null,
    executorResponseVerificationReceiptHash: responseVerificationReceipt?.executorResponseVerificationReceiptHash || null,
    attempt: Number(response?.attempt || 0),
    blockers,
  };
  return { ...record, executorResponseIntakeHash: hashPaperRecord('ExecutorResponseIntake', record) };
}

export function buildSubmissionRedrivePlan({ dispatchAuthorization, responseIntake, redriveDecision = null, priorAttempts = [], maximumAttempts = 3 } = {}) {
  const attempts = Array.isArray(priorAttempts) ? priorAttempts : [];
  const explicitFailure = responseIntake?.status === 'executor_response_accepted' && responseIntake?.outcome === 'failed';
  const ambiguous = responseIntake?.blockers?.includes('executor_response_missing') === true;
  const retryableOutcome = explicitFailure || (ambiguous
    && redriveDecision?.status === 'submission_redrive_reauthorization_approved'
    && redriveDecision?.decision === 'request_new_dispatch_authorization');
  const blockers = [];
  if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') blockers.push('dispatch_authorization_not_ready');
  if (!retryableOutcome) blockers.push('executor_response_not_retryable');
  if (ambiguous && !redriveDecision) blockers.push('ambiguous_result_review_required');
  if (attempts.length + 1 >= maximumAttempts) blockers.push('redrive_attempt_limit_reached');
  const record = {
    version: 1,
    kind: 'SubmissionRedrivePlan',
    paperId: dispatchAuthorization?.paperId || null,
    status: ambiguous && redriveDecision?.decision === 'continue_waiting'
      ? 'submission_redrive_waiting'
      : blockers.length ? 'submission_redrive_blocked' : 'submission_redrive_reauthorization_required',
    dispatchAuthorizationHash: dispatchAuthorization?.submissionDispatchAuthorizationHash || null,
    responseIntakeHash: responseIntake?.executorResponseIntakeHash || null,
    redriveDecisionHash: redriveDecision?.submissionRedriveDecisionHash || null,
    priorAttemptHashes: attempts.map((attempt) => attempt.submissionRedriveAttemptHash).filter(Boolean),
    nextAttempt: attempts.length + 2,
    maximumAttempts,
    provider: dispatchAuthorization?.provider || null,
    accountId: dispatchAuthorization?.accountId || null,
    priorNonce: dispatchAuthorization?.nonce || null,
    priorLiveAuthorizationHash: dispatchAuthorization?.liveAuthorizationHash || null,
    artifactPackageHash: dispatchAuthorization?.artifactPackageHash || null,
    expectedArtifactHashes: normalizedHashes(dispatchAuthorization?.expectedArtifactHashes || []),
    requiresFreshAuthorization: true,
    priorDispatchCycleHash: dispatchAuthorization?.dispatchCycleHash || null,
    blockers,
    externalActionPerformed: false,
  };
  return { ...record, submissionRedrivePlanHash: hashPaperRecord('SubmissionRedrivePlan', record) };
}

export function buildSubmissionRedriveAttempt({ redrivePlan, dispatchAuthorization = null, result = null } = {}) {
  const blockers = [];
  if (redrivePlan?.status !== 'submission_redrive_reauthorization_required') blockers.push('redrive_plan_not_ready');
  if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') blockers.push('fresh_dispatch_authorization_missing');
  if (dispatchAuthorization?.redrivePlanHash !== redrivePlan?.submissionRedrivePlanHash) blockers.push('fresh_dispatch_redrive_plan_mismatch');
  if (dispatchAuthorization?.nonce === redrivePlan?.priorNonce) blockers.push('fresh_dispatch_nonce_reused');
  if (dispatchAuthorization?.liveAuthorizationHash === redrivePlan?.priorLiveAuthorizationHash) blockers.push('fresh_live_authorization_reused');
  if (!result) blockers.push('redrive_result_missing');
  const record = {
    version: 1,
    kind: 'SubmissionRedriveAttempt',
    paperId: redrivePlan?.paperId || null,
    status: blockers.length ? 'submission_redrive_attempt_blocked' : 'submission_redrive_attempt_recorded',
    redrivePlanHash: redrivePlan?.submissionRedrivePlanHash || null,
    dispatchAuthorizationHash: dispatchAuthorization?.submissionDispatchAuthorizationHash || null,
    attempt: redrivePlan?.nextAttempt || null,
    resultHash: result?.resultHash || null,
    blockers,
  };
  return { ...record, submissionRedriveAttemptHash: hashPaperRecord('SubmissionRedriveAttempt', record) };
}

export function buildSubmissionDeliveryRuntime({
  paperTask,
  outbox,
  replayGuard,
  reviewedSubmitPreflightPacket,
  controlledExecutorReceipt,
  liveAuthorizationReceipt,
  reconciliation,
  executorResponse = null,
  executorResponseVerificationReceipt = null,
  priorRedriveAttempts = [],
  artifactPackage = null,
  venueObservation = null,
  redriveDecision = null,
  responseDueAt = null,
  submissionDecisionPacket = null,
  reviewedVenueEvidence = null,
  providerCapabilityVerificationReceipt = null,
} = {}) {
  const dispatchAuthorization = buildSubmissionDispatchAuthorization({
    paperTask,
    outbox,
    replayGuard,
    reviewedSubmitPreflightPacket,
    controlledExecutorReceipt,
    liveAuthorizationReceipt,
    artifactPackage,
    responseDueAt,
    submissionDecisionPacket,
    reviewedVenueEvidence,
    providerCapabilityVerificationReceipt,
  });
  const responseIntake = buildExecutorResponseIntake({ dispatchAuthorization, response: executorResponse, responseVerificationReceipt: executorResponseVerificationReceipt });
  const redrivePlan = buildSubmissionRedrivePlan({ dispatchAuthorization, responseIntake, redriveDecision, priorAttempts: priorRedriveAttempts });
  const liveVenueStateProof = venueObservation
    ? buildLiveVenueStateProof({ dispatchAuthorization, responseIntake, observation: venueObservation })
    : null;
  const effectiveReconciliation = liveVenueStateProof
    ? buildLiveSubmissionReconciliation({ dispatchAuthorization, responseIntake, venueStateProof: liveVenueStateProof })
    : reconciliation;
  const releaseLock = buildSubmissionReleaseLock({ paperTask, dispatchAuthorization, responseIntake, reconciliation: effectiveReconciliation });
  return Object.freeze({
    version: 1,
    kind: 'SubmissionDeliveryRuntime',
    status: releaseLock.status === 'submission_release_unlocked'
      ? 'submission_delivery_complete'
      : 'submission_delivery_blocked',
    dispatchAuthorization,
    responseIntake,
    redrivePlan,
    liveVenueStateProof,
    reconciliation: effectiveReconciliation || null,
    releaseLock,
    executorImplementationPresent: false,
    externalActionPerformed: effectiveReconciliation?.externalActionPerformed === true,
  });
}

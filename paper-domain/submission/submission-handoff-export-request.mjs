import { verifyPaperRecordHash } from '../contracts/primitives.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HUMAN_CONFIRMED_FIELDS = Object.freeze([
  'abstract', 'anonymity', 'authors', 'checklist', 'conflicts', 'coverLetter',
  'keywords', 'subjectAreas', 'supplements', 'title', 'track',
]);

const REQUEST_KEYS = Object.freeze([
  'campaignId',
  'dispatchAuthorization',
  'handoff',
  'kind',
  'manifest',
  'replayGuard',
  'reviewedSubmitPreflightPacket',
  'submissionDecisionPacket',
  'submissionHandoffExportRequestHash',
  'version',
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function recordPayload(record, excludedFields) {
  const payload = { ...(record || {}) };
  for (const field of excludedFields) delete payload[field];
  return payload;
}

function paperRecordHashValid(record, kind, hashField, excludedFields = []) {
  return verifyPaperRecordHash({
    kind,
    payload: recordPayload(record, [hashField, ...excludedFields]),
    recordHash: record?.[hashField],
  }).valid;
}

function ordinaryRecordHashValid(record, kind, hashField) {
  return record?.[hashField] === hashRecord(
    kind,
    recordPayload(record, [hashField]),
  );
}

function hashesValid(record, fields) {
  return fields.every((field) => SHA256.test(String(record?.[field] || '')));
}

function requiredFieldsPresent(record, fields) {
  return fields.every((field) => {
    const value = record?.[field];
    return value !== null
      && value !== undefined
      && value !== ''
      && (!Array.isArray(value) || value.length > 0);
  });
}

function canonicalDecisionValid(decision) {
  const confirmed = [...new Set(
    Array.isArray(decision?.humanConfirmedFields)
      ? decision.humanConfirmedFields.map(String) : [],
  )].sort();
  return decision?.version === 1
    && requiredFieldsPresent(decision, [
      'paperId', 'metadata', 'reviewedBy', 'reviewedAt',
      'humanConfirmedFields',
    ])
    && (!decision.venueSubmissionPlanHash
      || SHA256.test(String(decision.venueSubmissionPlanHash)))
    && decision.reviewActorType === 'human'
    && decision.machineSuggestionsAreAuthority === false
    && decision.localWorksheetGrantsAuthorization === false
    && Array.isArray(decision.blockers) && decision.blockers.length === 0
    && JSON.stringify(confirmed) === JSON.stringify(HUMAN_CONFIRMED_FIELDS);
}

function canonicalPreflightValid(preflight) {
  return hashesValid(preflight, [
    'approvalHash',
    'artifactPackageHash',
    'freshVenueEvidenceBundleHash',
    'independentRefereeAuthorityReceiptHash',
    'liveSubmissionAuthorizationReceiptHash',
    'manifestHash',
    'manuscriptPromotionGateHash',
    'outboxHash',
    'replayGuardHash',
    'reviewedSubmissionDecisionPacketHash',
    'semanticPromotionLockHash',
    'venueSubmissionPlanHash',
  ])
    && Array.isArray(preflight?.blockers) && preflight.blockers.length === 0
    && preflight?.safety?.preflightOnly === true
    && preflight?.safety?.grantsLiveExecutionInsideOverlay === false
    && preflight?.safety?.requiresExternalExecutor === true
    && preflight?.safety?.dualControlAuthorizationVerified === true
    && preflight?.safety?.externalActionPerformed === false;
}

function canonicalDispatchValid(dispatch) {
  const expectedHashes = Array.isArray(dispatch?.expectedArtifactHashes)
    ? dispatch.expectedArtifactHashes.map(String) : [];
  return hashesValid(dispatch, [
    'actionScopeKey',
    'artifactPackageHash',
    'controlledExecutorReceiptHash',
    'dispatchCycleHash',
    'executorCapabilitiesHash',
    'executorDescriptorHash',
    'liveAuthorizationHash',
    'outboxHash',
    'preflightHash',
    'providerCapabilityVerificationReceiptHash',
    'replayGuardHash',
    'replayKey',
    'reviewedSubmissionDecisionPacketHash',
  ])
    && expectedHashes.length > 0
    && expectedHashes.every((value) => SHA256.test(value))
    && JSON.stringify(expectedHashes)
      === JSON.stringify([...new Set(expectedHashes)].sort())
    && Number.isInteger(dispatch?.attempt) && dispatch.attempt > 0
    && Number.isFinite(Date.parse(String(dispatch?.responseDueAt || '')))
    && Boolean(dispatch?.executorId)
    && Boolean(dispatch?.provider)
    && Boolean(dispatch?.accountId)
    && Boolean(dispatch?.nonce)
    && Boolean(dispatch?.portalRoute)
    && Array.isArray(dispatch?.blockers) && dispatch.blockers.length === 0;
}

function canonicalOutboxValid(outbox) {
  return outbox?.version === 1
    && requiredFieldsPresent(outbox, [
      'paperId', 'action', 'manifestHash', 'replayGuardHash',
    ])
    && hashesValid(outbox, ['manifestHash', 'replayGuardHash'])
    && hashesValid(outbox, ['handoffEnvelopeHash'])
    && Array.isArray(outbox?.blockers) && outbox.blockers.length === 0
    && outbox?.safety?.previewOnly === true
    && outbox?.safety?.externalActionPerformed === false
    && outbox?.safety?.sourceMutation === false;
}

function canonicalControlledExecutorValid(controlled) {
  const chain = controlled?.hashChain;
  return hashesValid(controlled, [
    'executorCapabilitiesHash',
    'executorDescriptorHash',
    'reviewedSubmissionDecisionPacketHash',
  ])
    && hashesValid(chain, [
      'approvalHash',
      'executorCapabilitiesHash',
      'executorDescriptorHash',
      'independentRefereeAuthorityReceiptHash',
      'liveSubmissionAuthorizationReceiptHash',
      'manifestHash',
      'outboxHash',
      'replayGuardHash',
      'reviewedSubmissionDecisionPacketHash',
      'reviewedSubmitPreflightPacketHash',
    ])
    && controlled?.executorDescriptorHash === chain?.executorDescriptorHash
    && controlled?.executorCapabilitiesHash === chain?.executorCapabilitiesHash
    && controlled?.reviewedSubmissionDecisionPacketHash
      === chain?.reviewedSubmissionDecisionPacketHash
    && controlled?.controlledExecutorReady === true
    && controlled?.liveSubmitPerformed === false
    && controlled?.externalActionPerformed === false
    && Array.isArray(controlled?.blockers) && controlled.blockers.length === 0
    && controlled?.safety?.receiptOnly === true
    && controlled?.safety?.grantsLiveExecutionInsideOverlay === false
    && controlled?.safety?.executesExternalAction === false
    && controlled?.safety?.externalActionPerformed === false
    && controlled?.safety?.dualControlAuthorizationVerified === true;
}

export function inspectSubmissionHandoffPersistedAuthorityRecords({
  outbox,
  reviewedSubmitPreflightPacket,
  controlledExecutorReceipt,
  dispatchAuthorization,
} = {}) {
  const blockers = [];
  if (!canonicalOutboxValid(outbox)) {
    blockers.push('submission_handoff_export_authority_outbox_contract_invalid');
  }
  if (!canonicalPreflightValid(reviewedSubmitPreflightPacket)) {
    blockers.push('submission_handoff_export_authority_preflight_contract_invalid');
  }
  if (!canonicalControlledExecutorValid(controlledExecutorReceipt)) {
    blockers.push('submission_handoff_export_authority_executor_contract_invalid');
  }
  if (!canonicalDispatchValid(dispatchAuthorization)) {
    blockers.push('submission_handoff_export_authority_dispatch_contract_invalid');
  }
  return Object.freeze(blockers);
}

function commonIdentityBlockers(record, label, manifest) {
  const blockers = [];
  if (record?.paperId !== manifest?.paperId) {
    blockers.push(`submission_handoff_export_${label}_paper_mismatch`);
  }
  if (record?.taskKey !== manifest?.taskKey) {
    blockers.push(`submission_handoff_export_${label}_task_mismatch`);
  }
  return blockers;
}

function verifyComponentRecords(request) {
  const blockers = [];
  const {
    manifest,
    handoff,
    replayGuard,
    reviewedSubmitPreflightPacket: preflight,
    dispatchAuthorization: dispatch,
    submissionDecisionPacket: decision,
  } = request;

  if (manifest?.kind !== 'PaperActionManifest'
      || manifest?.status !== 'ready_for_adapter'
      || manifest?.readyForAdapter !== true
      || manifest?.action !== 'reviewed-submit') {
    blockers.push('submission_handoff_export_manifest_not_ready');
  }
  if (!paperRecordHashValid(
    manifest,
    'PaperActionManifest',
    'manifestHash',
    ['hash'],
  ) || (manifest?.hash && manifest.hash !== manifest.manifestHash)) {
    blockers.push('submission_handoff_export_manifest_hash_invalid');
  }
  if (manifest?.safety?.executesExternalAction !== false) {
    blockers.push('submission_handoff_export_manifest_safety_invalid');
  }

  if (handoff?.kind !== 'PaperHandoffEnvelope'
      || handoff?.status !== 'dry_run_ready'
      || handoff?.readyForExecution !== false
      || handoff?.manifestHash !== manifest?.manifestHash) {
    blockers.push('submission_handoff_export_handoff_not_ready');
  }
  if (!paperRecordHashValid(handoff, 'PaperHandoffEnvelope', 'envelopeHash')) {
    blockers.push('submission_handoff_export_handoff_hash_invalid');
  }
  if (handoff?.safety?.executesExternalAction !== false) {
    blockers.push('submission_handoff_export_handoff_safety_invalid');
  }
  blockers.push(...commonIdentityBlockers(handoff, 'handoff', manifest));

  if (replayGuard?.kind !== 'SubmissionReplayGuard'
      || replayGuard?.status !== 'dry_run_replay_allowed'
      || replayGuard?.manifestHash !== manifest?.manifestHash) {
    blockers.push('submission_handoff_export_replay_guard_not_ready');
  }
  if (!paperRecordHashValid(
    replayGuard,
    'SubmissionReplayGuard',
    'submissionReplayGuardHash',
  )) {
    blockers.push('submission_handoff_export_replay_guard_hash_invalid');
  }
  if (replayGuard?.safety?.grantsExecutionPermission !== false
      || replayGuard?.safety?.externalActionPerformed !== false) {
    blockers.push('submission_handoff_export_replay_guard_safety_invalid');
  }
  blockers.push(...commonIdentityBlockers(replayGuard, 'replay_guard', manifest));

  if (preflight?.kind !== 'ReviewedSubmitPreflightPacket'
      || preflight?.status
        !== 'reviewed_submit_preflight_ready_for_external_executor'
      || preflight?.externalExecutorHandoffReady !== true
      || preflight?.liveExecutorBoundaryBlocked !== false) {
    blockers.push('submission_handoff_export_preflight_not_ready');
  }
  if (!paperRecordHashValid(
    preflight,
    'ReviewedSubmitPreflightPacket',
    'reviewedSubmitPreflightPacketHash',
  )) {
    blockers.push('submission_handoff_export_preflight_hash_invalid');
  }
  if (preflight?.manifestHash !== manifest?.manifestHash
      || preflight?.replayGuardHash
        !== replayGuard?.submissionReplayGuardHash
      || preflight?.safety?.externalActionPerformed !== false) {
    blockers.push('submission_handoff_export_preflight_binding_invalid');
  }
  blockers.push(...commonIdentityBlockers(preflight, 'preflight', manifest));

  if (decision?.kind !== 'ReviewedSubmissionDecisionPacket'
      || decision?.status !== 'reviewed_submission_decision_verified'
      || decision?.externalActionPerformed !== false) {
    blockers.push('submission_handoff_export_decision_not_ready');
  }
  if (!ordinaryRecordHashValid(
    decision,
    'ReviewedSubmissionDecisionPacket',
    'reviewedSubmissionDecisionPacketHash',
  )) {
    blockers.push('submission_handoff_export_decision_hash_invalid');
  }
  if (!canonicalDecisionValid(decision)) {
    blockers.push('submission_handoff_export_decision_contract_invalid');
  }
  blockers.push(...commonIdentityBlockers(decision, 'decision', manifest));

  if (dispatch?.kind !== 'SubmissionDispatchAuthorization'
      || dispatch?.status !== 'submission_dispatch_authorization_ready'
      || dispatch?.externalActionPerformed !== false) {
    blockers.push('submission_handoff_export_dispatch_not_ready');
  }
  if (!ordinaryRecordHashValid(
    dispatch,
    'SubmissionDispatchAuthorization',
    'submissionDispatchAuthorizationHash',
  )) {
    blockers.push('submission_handoff_export_dispatch_hash_invalid');
  }
  if (!canonicalDispatchValid(dispatch)) {
    blockers.push('submission_handoff_export_dispatch_contract_invalid');
  }
  if (!canonicalPreflightValid(preflight)) {
    blockers.push('submission_handoff_export_preflight_contract_invalid');
  }
  if (dispatch?.preflightHash !== preflight?.reviewedSubmitPreflightPacketHash
      || dispatch?.outboxHash !== preflight?.outboxHash
      || dispatch?.replayGuardHash !== replayGuard?.submissionReplayGuardHash
      || dispatch?.reviewedSubmissionDecisionPacketHash
        !== decision?.reviewedSubmissionDecisionPacketHash) {
    blockers.push('submission_handoff_export_dispatch_binding_invalid');
  }
  blockers.push(...commonIdentityBlockers(dispatch, 'dispatch', manifest));
  return blockers;
}

function verifyExpectedReleaseBindings(request, expected) {
  const blockers = [];
  const manifest = request.manifest;
  const preflight = request.reviewedSubmitPreflightPacket;
  const dispatch = request.dispatchAuthorization;
  if (expected.campaignId && request.campaignId !== expected.campaignId) {
    blockers.push('submission_handoff_export_campaign_mismatch');
  }
  if (expected.paperId && manifest?.paperId !== expected.paperId) {
    blockers.push('submission_handoff_export_release_paper_mismatch');
  }
  if (expected.artifactPackageHash
      && (manifest?.payload?.artifactPackageHash
          !== expected.artifactPackageHash
        || preflight?.artifactPackageHash !== expected.artifactPackageHash
        || dispatch?.artifactPackageHash !== expected.artifactPackageHash)) {
    blockers.push('submission_handoff_export_artifact_package_mismatch');
  }
  if (expected.manuscriptPromotionGateHash
      && manifest?.payload?.manuscriptPromotionGateHash
        !== expected.manuscriptPromotionGateHash) {
    blockers.push('submission_handoff_export_promotion_gate_mismatch');
  }
  return blockers;
}

function sameRecord(left, right) {
  return hashRecord('SubmissionHandoffExportAuthorityBoundValue', left)
    === hashRecord('SubmissionHandoffExportAuthorityBoundValue', right);
}

function verifyPersistedAuthorityBindings(request, authority) {
  const blockers = [];
  if (authority?.status !== 'submission_handoff_export_authority_ready'
      || authority?.readOnly !== true) {
    blockers.push('submission_handoff_export_persisted_authority_required');
    return blockers;
  }
  const authorityPayload = { ...authority };
  delete authorityPayload.submissionHandoffExportAuthorityHash;
  if (authority.submissionHandoffExportAuthorityHash !== hashRecord(
    'PersistedSubmissionHandoffExportAuthority',
    authorityPayload,
  )) {
    blockers.push('submission_handoff_export_persisted_authority_hash_invalid');
  }
  if (!hashesValid(authority, [
    'authorizationConsumptionHash',
    'dispatchAuthorizationHash',
    'payloadBindingHash',
    'providerCapabilityHash',
    'releaseLockHash',
    'rowBindingHash',
  ]) || authority.responseCount !== 0 || authority.deadLetterCount !== 0
      || !Number.isFinite(Date.parse(String(authority.observedAt || '')))) {
    blockers.push('submission_handoff_export_persisted_authority_lineage_invalid');
  }
  if (authority.paperId !== request.manifest?.paperId
      || authority.dispatchAuthorizationHash
        !== request.dispatchAuthorization?.submissionDispatchAuthorizationHash
      || !sameRecord(
        authority.dispatchAuthorization,
        request.dispatchAuthorization,
      )
      || !sameRecord(
        authority.reviewedSubmitPreflightPacket,
        request.reviewedSubmitPreflightPacket,
      )) {
    blockers.push('submission_handoff_export_persisted_authority_record_mismatch');
  }
  if (authority.outbox?.manifestHash !== request.manifest?.manifestHash
      || authority.outbox?.handoffEnvelopeHash !== request.handoff?.envelopeHash
      || authority.outbox?.replayGuardHash
        !== request.replayGuard?.submissionReplayGuardHash
      || authority.outbox?.externalExecutorHandoffOutboxHash
        !== request.reviewedSubmitPreflightPacket?.outboxHash) {
    blockers.push('submission_handoff_export_persisted_outbox_mismatch');
  }
  if (authority.controlledExecutorReceipt
        ?.controlledExternalExecutorReceiptHash
      !== request.dispatchAuthorization?.controlledExecutorReceiptHash
      || authority.controlledExecutorReceipt?.hashChain?.manifestHash
        !== request.manifest?.manifestHash
      || authority.controlledExecutorReceipt?.hashChain?.replayGuardHash
        !== request.replayGuard?.submissionReplayGuardHash
      || authority.controlledExecutorReceipt?.hashChain
        ?.reviewedSubmitPreflightPacketHash
        !== request.reviewedSubmitPreflightPacket
          ?.reviewedSubmitPreflightPacketHash
      || authority.controlledExecutorReceipt?.hashChain
        ?.reviewedSubmissionDecisionPacketHash
        !== request.submissionDecisionPacket
          ?.reviewedSubmissionDecisionPacketHash) {
    blockers.push('submission_handoff_export_persisted_executor_mismatch');
  }
  blockers.push(...inspectSubmissionHandoffPersistedAuthorityRecords({
    outbox: authority.outbox,
    reviewedSubmitPreflightPacket: authority.reviewedSubmitPreflightPacket,
    controlledExecutorReceipt: authority.controlledExecutorReceipt,
    dispatchAuthorization: authority.dispatchAuthorization,
  }));
  return blockers;
}

export function verifySubmissionHandoffExportRequest(request, expected = {}) {
  const blockers = [];
  const plainObject = request && typeof request === 'object'
    && !Array.isArray(request);
  if (!plainObject) blockers.push('submission_handoff_export_request_object_required');
  const keys = plainObject ? Object.keys(request).sort() : [];
  if (plainObject && JSON.stringify(keys) !== JSON.stringify(REQUEST_KEYS)) {
    blockers.push('submission_handoff_export_request_shape_invalid');
  }
  if (request?.version !== 1 || request?.kind !== 'SubmissionHandoffExportRequest') {
    blockers.push('submission_handoff_export_request_contract_invalid');
  }
  if (!String(request?.campaignId || '').trim()) {
    blockers.push('submission_handoff_export_request_campaign_required');
  }
  if (plainObject) {
    const payload = recordPayload(request, [
      'submissionHandoffExportRequestHash',
    ]);
    if (request.submissionHandoffExportRequestHash
        !== hashRecord('SubmissionHandoffExportRequest', payload)) {
      blockers.push('submission_handoff_export_request_hash_invalid');
    }
    blockers.push(...verifyComponentRecords(request));
    blockers.push(...verifyExpectedReleaseBindings(request, expected));
    blockers.push(...verifyPersistedAuthorityBindings(
      request,
      expected.submissionAuthority,
    ));
  }
  const uniqueBlockers = unique(blockers);
  const payload = {
    version: 1,
    kind: 'SubmissionHandoffExportRequestVerificationReceipt',
    status: uniqueBlockers.length
      ? 'submission_handoff_export_request_blocked'
      : 'submission_handoff_export_request_verified',
    campaignId: request?.campaignId || null,
    paperId: request?.manifest?.paperId || null,
    submissionHandoffExportRequestHash:
      request?.submissionHandoffExportRequestHash || null,
    blockers: uniqueBlockers,
    grantsExecutionPermission: false,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    submissionHandoffExportRequestVerificationReceiptHash: hashRecord(
      'SubmissionHandoffExportRequestVerificationReceipt',
      payload,
    ),
  });
}

export function assertSubmissionHandoffExportRequest(request, expected = {}) {
  const receipt = verifySubmissionHandoffExportRequest(request, expected);
  if (receipt.status !== 'submission_handoff_export_request_verified') {
    const error = new Error(
      `submission_handoff_export_request_blocked:${receipt.blockers.join(',')}`,
    );
    error.code = 'submission_handoff_export_request_blocked';
    error.receipt = receipt;
    throw error;
  }
  return receipt;
}

import {
  classifyExternalQualificationFailureCodes,
} from '../../paper-domain/automation/external-research-qualification-failure-policy.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  externalQualificationInfrastructureControlFlow as infrastructureControlFlow,
  externalQualificationInspectionWithIdentity as inspectionWithIdentity,
  externalQualificationOutcome as outcome,
  markExternalQualificationSideEffectStarted as markExternalSideEffectStarted,
  reportExternalQualificationProgress as reportProgress,
  reportExternalQualificationSynchronousProgress as reportSynchronousProgress,
} from './external-qualification-recovery-support.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const LOOKUP_STATUSES = new Set([
  'qualification_found',
  'qualification_in_progress',
  'qualification_definitively_not_found',
  'qualification_terminal',
]);

function releaseRecoveryLease(store, attemptLease) {
  if (!attemptLease) return;
  store.releaseQualificationAttemptLease(attemptLease);
}

function lookupRequest({ authority, state, idempotencyKey, sideEffectPermitHash }) {
  return Object.freeze({
    campaignId: authority.campaignId,
    paperId: authority.paperId,
    campaignReleaseBundleHash: authority.campaignReleaseBundleHash,
    idempotencyKey,
    qualificationCycle: state.recovery.cycle,
    qualificationEpoch: state.recovery.epoch,
    qualificationAttempt: state.recovery.attemptCount,
    qualificationTotalAttempt: state.recovery.totalAttemptCount,
    sideEffectPermitHash,
  });
}

function qualificationRequest({
  authority,
  preparation,
  state,
  idempotencyKey,
  sideEffectPermitHash,
}) {
  const releaseBinding = authority.releaseBundle
    ?.autonomousResearchReleaseBinding || null;
  return Object.freeze({
    campaignId: authority.campaignId,
    paperId: authority.paperId,
    campaignReleaseBundleHash: authority.campaignReleaseBundleHash,
    proposalHash: preparation.proposal.machineProposedScientificClaimSetHash,
    policyAuthorizationHash:
      preparation.policyAuthorization.autonomousResearchPolicyAuthorizationHash,
    seedBindingHash: preparation.seedBinding.autonomousResearchSeedBindingHash,
    qualificationScope: releaseBinding?.qualificationScope || null,
    genericContentCanaryVerified:
      releaseBinding?.genericContentCanaryVerified === true,
    trustedAutonomousManuscriptRenderReceiptHash:
      releaseBinding?.trustedAutonomousManuscriptRenderReceiptHash || null,
    evidenceBoundManuscriptIrHash:
      releaseBinding?.evidenceBoundManuscriptIrHash || null,
    manuscriptIrFileHash: releaseBinding?.manuscriptIrFileHash || null,
    renderedManuscriptHash: releaseBinding?.renderedManuscriptHash || null,
    agentExecutionReceiptHash: releaseBinding?.agentExecutionReceiptHash || null,
    isolatedAgentMergeReceiptHash:
      releaseBinding?.isolatedAgentMergeReceiptHash || null,
    agentAuthoredSourceDraftHash:
      releaseBinding?.agentAuthoredSourceDraftHash || null,
    agentAuthoredSourceDraftFileHash:
      releaseBinding?.agentAuthoredSourceDraftFileHash || null,
    agentWorkspacePostimageBindingHash:
      releaseBinding?.agentWorkspacePostimageBindingHash || null,
    venueProfileSelectionHash: releaseBinding?.venueProfileSelectionHash || null,
    submissionMetadataReceiptHash:
      releaseBinding?.submissionMetadataReceiptHash || null,
    idempotencyKey,
    qualificationCycle: state.recovery.cycle,
    qualificationEpoch: state.recovery.epoch,
    qualificationAttempt: state.recovery.attemptCount,
    qualificationTotalAttempt: state.recovery.totalAttemptCount,
    sideEffectPermitHash,
  });
}

function authoritativeLookupBound(lookup, {
  configuration,
  idempotencyKey,
  sideEffectPermitHash,
}) {
  const failureCodes = lookup?.terminalFailureCodes;
  const found = lookup?.status === 'qualification_found';
  const terminal = lookup?.status === 'qualification_terminal';
  return lookup?.authoritative === true
    && lookup?.signatureVerified === true
    && lookup?.requestDigestVerified === true
    && LOOKUP_STATUSES.has(lookup?.status)
    && lookup?.idempotencyKey === idempotencyKey
    && lookup?.sideEffectPermitHash === sideEffectPermitHash
    && lookup?.configurationIdentityHash === configuration.configurationIdentityHash
    && lookup?.trustIdentityHash === configuration.trustIdentityHash
    && lookup?.clientServiceIdentityHash === configuration.clientServiceIdentityHash
    && SHA256.test(String(lookup?.requestHash || ''))
    && SHA256.test(String(lookup?.lookupStatusHash || ''))
    && Array.isArray(failureCodes)
    && failureCodes.length <= 64
    && failureCodes.every((code) => (
      typeof code === 'string' && code.length > 0 && code.length <= 256
    ))
    && (terminal ? failureCodes.length > 0 : failureCodes.length === 0)
    && (found
      ? lookup?.receipt && typeof lookup.receipt === 'object'
        && !Array.isArray(lookup.receipt)
      : lookup?.receipt === null);
}

function remainingAttemptMilliseconds(state, currentNow) {
  return Math.max(1, Math.min(
    Date.parse(state.recovery.deadlineAt),
    Date.parse(state.recovery.globalDeadlineAt),
  ) - currentNow());
}

export async function recoverStaleExternalQualificationAttempt({
  staleAttemptExpired = false,
  qualificationStateStore,
  externalQualificationClient,
  externalQualificationVerifier,
  campaignReleaseAuthority,
  preparation,
  configuration,
  policy,
  retry,
  currentNow,
  writeState,
  evaluateEligibility,
} = {}) {
  if (!staleAttemptExpired) return Object.freeze({ handled: false });
  let reconciliation;
  try {
    reconciliation = qualificationStateStore
      .reconcileStaleQualificationAttemptReservation({
        ownerId: `qualification-recovery:${process.pid}:${Math.random().toString(16).slice(2)}`,
        leaseMs: policy.attemptLeaseMs,
        now: new Date(currentNow()),
      });
  } catch (error) {
    if (error?.message
      === 'autonomous_research_qualification_attempt_recovery_lease_active') {
      return Object.freeze({
        handled: true,
        result: outcome(
          'qualification_external_service_attempt_in_progress',
          null,
          configuration,
        ),
      });
    }
    throw error;
  }
  if (reconciliation?.status === 'stale_attempt_reservation_refunded') {
    return Object.freeze({
      handled: true,
      result: outcome(
        'qualification_external_service_stale_attempt_refunded',
        null,
        configuration,
      ),
    });
  }
  if (reconciliation?.status
    !== 'stale_attempt_authoritative_lookup_required') {
    throw new Error('autonomous_research_qualification_stale_attempt_recovery_invalid');
  }
  const {
    attemptLease,
    idempotencyKey,
    sideEffectPermitHash,
    state,
  } = reconciliation;
  if (qualificationStateStore.externallyFencedMutationsRequired === true
    && !SHA256.test(String(sideEffectPermitHash || ''))) {
    throw new Error(
      'autonomous_research_qualification_stale_attempt_side_effect_permit_invalid',
    );
  }
  await reportProgress(retry, 'qualification_recovery_after_stale_attempt_takeover');
  if (typeof externalQualificationClient?.lookupQualification !== 'function') {
    releaseRecoveryLease(qualificationStateStore, attemptLease);
    return Object.freeze({
      handled: true,
      result: outcome(
        'qualification_external_service_authoritative_lookup_required',
        null,
        configuration,
      ),
    });
  }
  if (typeof externalQualificationVerifier?.verifyLookup !== 'function') {
    releaseRecoveryLease(qualificationStateStore, attemptLease);
    return Object.freeze({
      handled: true,
      result: outcome(
        'qualification_external_service_authoritative_lookup_verifier_required',
        null,
        configuration,
      ),
    });
  }

  let lookup;
  try {
    reportSynchronousProgress(
      retry,
      'qualification_recovery_external_authoritative_lookup',
    );
    markExternalSideEffectStarted(retry, 'external_qualification_authoritative_lookup');
    const expectedRequest = lookupRequest({
      authority: campaignReleaseAuthority,
      state,
      idempotencyKey,
      sideEffectPermitHash,
    });
    const candidate = await externalQualificationClient.lookupQualification(
      expectedRequest,
      {
        signal: retry.signal || null,
        timeoutMs: remainingAttemptMilliseconds(state, currentNow),
      },
    );
    reportSynchronousProgress(
      retry,
      'qualification_recovery_external_authoritative_lookup_verification',
    );
    lookup = await externalQualificationVerifier.verifyLookup({
      candidate,
      expectedRequest,
    });
    await reportProgress(retry, 'qualification_recovery_after_authoritative_lookup');
  } catch (error) {
    if (infrastructureControlFlow(error)
      || error?.message === 'autonomous_research_qualification_progress_fence_lost') {
      throw error;
    }
    releaseRecoveryLease(qualificationStateStore, attemptLease);
    return Object.freeze({
      handled: true,
      result: outcome(
        'qualification_external_service_authoritative_lookup_deferred',
        null,
        configuration,
      ),
    });
  }
  if (!authoritativeLookupBound(lookup, {
    configuration,
    idempotencyKey,
    sideEffectPermitHash,
  })) {
    releaseRecoveryLease(qualificationStateStore, attemptLease);
    throw new Error(
      'autonomous_research_qualification_authoritative_lookup_binding_invalid',
    );
  }
  if (lookup.status === 'qualification_in_progress') {
    return Object.freeze({
      handled: true,
      result: outcome(
        'qualification_external_service_authoritative_lookup_pending',
        null,
        configuration,
      ),
    });
  }
  if (lookup.status === 'qualification_terminal') {
    writeState({
      status: 'qualification_terminal_blocked',
      terminalFailure: Object.freeze({
        failureCodes: Object.freeze([...lookup.terminalFailureCodes]),
        rejectedReceiptHash: null,
        recoveryConfigurationIdentityHash:
          configuration.recoveryConfigurationIdentityHash,
      }),
    }, attemptLease);
    releaseRecoveryLease(qualificationStateStore, attemptLease);
    return Object.freeze({
      handled: true,
      result: outcome(
        'qualification_external_service_terminal_blocked',
        null,
        configuration,
      ),
    });
  }

  let receipt = lookup.receipt;
  if (lookup.status === 'qualification_definitively_not_found') {
    try {
      await reportProgress(retry, 'qualification_recovery_before_same_key_resume');
      reportSynchronousProgress(
        retry,
        'qualification_recovery_same_key_resume_final_fence',
      );
      markExternalSideEffectStarted(
        retry,
        'external_qualification_request_same_key_resume',
      );
      receipt = await externalQualificationClient.requestQualification(
        qualificationRequest({
          authority: campaignReleaseAuthority,
          preparation,
          state,
          idempotencyKey,
          sideEffectPermitHash,
        }),
        {
          signal: retry.signal || null,
          timeoutMs: remainingAttemptMilliseconds(state, currentNow),
        },
      );
      await reportProgress(retry, 'qualification_recovery_after_same_key_resume');
    } catch (error) {
      if (infrastructureControlFlow(error)
        || error?.message === 'autonomous_research_qualification_progress_fence_lost') {
        throw error;
      }
      releaseRecoveryLease(qualificationStateStore, attemptLease);
      return Object.freeze({
        handled: true,
        result: outcome(
          'qualification_external_service_same_key_resume_deferred',
          null,
          configuration,
        ),
      });
    }
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      releaseRecoveryLease(qualificationStateStore, attemptLease);
      throw new Error(
        'autonomous_research_qualification_same_key_resume_receipt_invalid',
      );
    }
  }

  const renewed = qualificationStateStore.renewQualificationAttemptLease({
    ...attemptLease,
    leaseMs: policy.attemptLeaseMs,
    now: new Date(currentNow()),
  });
  if (!renewed) {
    return Object.freeze({
      handled: true,
      result: outcome(
        'qualification_external_service_attempt_lease_lost',
        null,
        configuration,
      ),
    });
  }
  await reportProgress(retry, 'qualification_recovery_before_recovered_verification');
  reportSynchronousProgress(
    retry,
    'qualification_recovery_recovered_external_verification',
  );
  qualificationStateStore.markQualificationAttemptExternalActionStarted({
    expectedStateHash: state.autonomousExternalQualificationStateHash,
    expectedGeneration: state.generation,
    idempotencyKey,
    attemptLease: renewed,
    action: 'external_qualification_verification',
    now: new Date(currentNow()),
  });
  markExternalSideEffectStarted(retry, 'external_qualification_verification');
  await reportProgress(
    retry,
    'qualification_recovery_after_recovered_verification_marker',
  );
  reportSynchronousProgress(
    retry,
    'qualification_recovery_recovered_external_verification_final_fence',
  );
  let inspection = null;
  try {
    inspection = inspectionWithIdentity(await externalQualificationVerifier.verify({
      receipt,
      campaignReleaseAuthority,
      preparation,
    }, {
      signal: retry.signal || null,
      timeoutMs: remainingAttemptMilliseconds(state, currentNow),
    }), configuration);
    await reportProgress(retry, 'qualification_recovery_after_recovered_verification');
  } catch (error) {
    if (infrastructureControlFlow(error)
      || error?.message === 'autonomous_research_qualification_progress_fence_lost') {
      throw error;
    }
    releaseRecoveryLease(qualificationStateStore, renewed);
    return Object.freeze({
      handled: true,
      result: outcome(
        'qualification_external_service_recovered_verification_deferred',
        null,
        configuration,
      ),
    });
  }
  const eligibility = inspection?.kind === 'FullResearchQualificationInspection'
    ? evaluateEligibility(inspection) : null;
  if (eligibility?.fullAutomaticResearchWritingReady
    || eligibility?.boundedGoldenCapabilityQualificationVerified) {
    writeState({
      status: 'qualification_verified',
      receipt,
      verifiedInspection: inspection,
    }, renewed);
    releaseRecoveryLease(qualificationStateStore, renewed);
    return Object.freeze({
      handled: true,
      result: outcome(
        'qualification_external_service_verified',
        inspection,
        configuration,
      ),
    });
  }
  const classification = inspection
    ? classifyExternalQualificationFailureCodes(inspection.failureCodes) : null;
  if (classification?.terminalForConfiguration) {
    writeState({
      status: 'qualification_terminal_blocked',
      terminalFailure: Object.freeze({
        failureCodes: classification.failureCodes,
        rejectedReceiptHash: hashRecord(
          'AutonomousExternalQualificationRejectedReceipt',
          receipt,
        ),
        recoveryConfigurationIdentityHash:
          configuration.recoveryConfigurationIdentityHash,
      }),
    }, renewed);
    releaseRecoveryLease(qualificationStateStore, renewed);
    return Object.freeze({
      handled: true,
      result: outcome('qualification_external_service_blocked', inspection, configuration),
    });
  }
  releaseRecoveryLease(qualificationStateStore, renewed);
  return Object.freeze({
    handled: true,
    result: outcome(
      'qualification_external_service_recovered_verification_deferred',
      inspection,
      configuration,
    ),
  });
}

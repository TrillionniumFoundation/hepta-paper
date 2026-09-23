import {
  assertAutonomousSubmissionHandoffOutboxPort,
  assertAutonomousSubmissionOutboxPort,
} from '../../paper-ports/autonomous-submission-outbox-port.mjs';
import {
  assertAutonomousSubmissionPortalPort,
} from '../../paper-ports/autonomous-submission-portal-port.mjs';
import {
  AUTONOMOUS_SUBMISSION_DELIVERY_STATES,
} from '../../paper-domain/automation/autonomous-submission-delivery-contract.mjs';
import {
  verifyAutonomousSubmissionReceipt,
} from '../../paper-domain/automation/autonomous-submission-contract.mjs';

function requireSubmissionRequestVerifier(value) {
  if (value?.kind !== 'AutonomousSubmissionRequestVerifier'
    || typeof value.verify !== 'function') {
    throw new Error('autonomous_submission_request_verifier_required');
  }
  return value;
}

function failureFrom(error) {
  return Object.freeze({
    code: String(error?.message || error || 'autonomous_submission_delivery_failed')
      .slice(0, 256),
    httpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : null,
  });
}

function isInfrastructureFenceControlFlow(error) {
  return error?.stateRecoverabilityFatal === true
    || error?.stateRecoverabilityDeferred === true
    || error?.authorityEvidenceRenewalFatal === true
    || error?.authorityEvidenceRenewalDeferred === true
    || error?.residentReactivationRequired === true;
}

function result(state, { networkActionPerformed = false, reconciled = false } = {}) {
  const receipt = state?.stateReceipt || null;
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionDeliveryReport',
    status: `autonomous_submission_delivery_${receipt?.state || 'unavailable'}`,
    request: state?.request || null,
    deliveryStateReceipt: receipt,
    receipt: receipt?.submissionReceipt || null,
    networkActionPerformed,
    reconciled,
    externalActionPerformed: receipt?.externalActionPerformed === true,
    externalActionMayHaveOccurred: receipt?.externalActionMayHaveOccurred === true,
    safeToRedriveWithoutLookup: receipt?.redrivePermitted === true,
    lookupRequired: receipt?.lookupRequired === true,
    terminal: receipt?.terminal === true,
  });
}

export function inspectPersistedAutonomousSubmissionDelivery({
  outbox: suppliedOutbox,
  campaignId,
  paperId,
  portalConfigurationHash,
  portalId = null,
  submissionRequestVerifier,
} = {}) {
  const requestVerifier = requireSubmissionRequestVerifier(submissionRequestVerifier);
  const outbox = assertAutonomousSubmissionHandoffOutboxPort(suppliedOutbox);
  const states = outbox.listAutonomousSubmissionsForCampaign({
    campaignId,
    paperId,
    portalId,
  });
  if (states.length > 1) {
    throw new Error('autonomous_submission_recovery_ambiguous_requests');
  }
  if (states.length === 0) return null;
  const current = states[0];
  if (requestVerifier.verify(current.request) !== true
    || current.request.portalConfigurationHash !== portalConfigurationHash) {
    throw new Error('autonomous_submission_portal_configuration_binding_invalid');
  }
  return Object.freeze({
    request: current.request,
    delivery: result(current),
    receipt: current.stateReceipt.submissionReceipt || null,
  });
}

export function evaluateAutonomousSubmissionDeliveryReadiness({
  required = false,
  autonomousSubmission = null,
  submissionRequestVerifier,
  completedReceiptVerifier = null,
  requireCryptographicAuthority = false,
} = {}) {
  const requestVerifier = required === true
    ? requireSubmissionRequestVerifier(submissionRequestVerifier)
    : null;
  const ready = required !== true || (
    autonomousSubmission?.delivery?.status === 'autonomous_submission_delivery_completed'
    && autonomousSubmission.delivery.terminal === true
    && verifyAutonomousSubmissionReceipt(autonomousSubmission.receipt, {
      request: autonomousSubmission.request,
      requestVerifier,
      completedReceiptVerifier,
      requireCryptographicAuthority,
    })
  );
  const terminalFailure = required === true
    && autonomousSubmission?.delivery?.status
      === 'autonomous_submission_delivery_explicit_failure'
    && autonomousSubmission.delivery.terminal === true;
  return Object.freeze({ required: required === true, ready, terminalFailure });
}

export function autonomousSubmissionAwareCampaignStatus({
  campaignStatus,
  qualificationEligibility,
  submissionReadiness,
} = {}) {
  if (campaignStatus !== 'completed') {
    return `autonomous_research_campaign_${campaignStatus || 'unavailable'}`;
  }
  if (qualificationEligibility?.fullAutomaticResearchWritingReady !== true) {
    return qualificationEligibility?.qualificationRequestEligible
      ? 'autonomous_research_campaign_completed_external_qualification_eligible'
      : 'autonomous_research_campaign_completed_qualification_blocked';
  }
  if (submissionReadiness?.terminalFailure === true) {
    return 'autonomous_research_campaign_completed_submission_failed';
  }
  return submissionReadiness?.ready === true
    ? 'autonomous_research_campaign_completed_and_qualified'
    : 'autonomous_research_campaign_completed_submission_pending';
}

export function prepareAutonomousSubmissionHandoff({
  outbox: suppliedOutbox,
  request,
  portalId,
  submissionRequestVerifier,
} = {}) {
  const requestVerifier = requireSubmissionRequestVerifier(submissionRequestVerifier);
  const outbox = assertAutonomousSubmissionHandoffOutboxPort(suppliedOutbox);
  const normalizedPortalId = String(portalId || '').trim();
  if (!normalizedPortalId || requestVerifier.verify(request) !== true) {
    throw new Error('autonomous_submission_handoff_request_invalid');
  }
  const prepared = outbox.prepareAutonomousSubmission({
    request,
    portalId: normalizedPortalId,
  });
  return result(prepared);
}

async function lookupUnsettled({
  portal,
  outbox,
  current,
  request,
  signal,
  submissionRequestVerifier,
  assertExternalSideEffectReady,
}) {
  let lookup;
  try {
    await assertExternalSideEffectReady?.({ action: 'portal_lookup' });
    assertExternalSideEffectReady?.assertCurrent?.({ action: 'portal_lookup' });
    await assertExternalSideEffectReady?.markStarted?.({ action: 'portal_lookup' });
    lookup = await portal.lookup({ request, signal });
  }
  catch (error) {
    if (isInfrastructureFenceControlFlow(error)) throw error;
    if (current.stateReceipt.state === AUTONOMOUS_SUBMISSION_DELIVERY_STATES.DISPATCHING) {
      const uncertain = outbox.recordAutonomousSubmissionOutcome({
        request,
        portalId: portal.portalId,
        state: AUTONOMOUS_SUBMISSION_DELIVERY_STATES.UNCERTAIN,
        resolution: 'remote-outcome-uncertain',
        failure: failureFrom(error),
      });
      return Object.freeze({ settled: result(uncertain, { reconciled: true }) });
    }
    return Object.freeze({ settled: result(current, { reconciled: true }) });
  }
  if (lookup?.status === 'autonomous_submission_portal_completed'
    && lookup.authoritative === true
    && lookup.requestHash === request.requestHash
    && lookup.idempotencyKey === request.idempotencyKey
    && verifyAutonomousSubmissionReceipt(lookup.receipt, {
      request,
      requestVerifier: submissionRequestVerifier,
      completedReceiptVerifier: portal.completedReceiptVerifier || null,
      requireCryptographicAuthority:
        portal.signedCompletedReceiptSupported === true,
    })) {
    const completed = outbox.recordAutonomousSubmissionOutcome({
      request,
      portalId: portal.portalId,
      state: AUTONOMOUS_SUBMISSION_DELIVERY_STATES.COMPLETED,
      resolution: 'remote-confirmed-completed',
      submissionReceipt: lookup.receipt,
    });
    return Object.freeze({ settled: result(completed, { reconciled: true }) });
  }
  if (lookup?.status !== 'autonomous_submission_portal_authoritative_not_found'
    || lookup.authoritative !== true
    || lookup.externalActionPerformed !== false
    || lookup.requestHash !== request.requestHash
    || lookup.idempotencyKey !== request.idempotencyKey) {
    return Object.freeze({ settled: result(current, { reconciled: true }) });
  }
  return Object.freeze({
    dispatch: outbox.beginAutonomousSubmissionAttempt({
      request,
      portalId: portal.portalId,
      authoritativeNotFoundReceipt: lookup.authoritativeNotFoundReceipt || null,
    }),
  });
}

export async function deliverAutonomousSubmission({
  portal: suppliedPortal,
  outbox: suppliedOutbox,
  request,
  signal = null,
  submissionRequestVerifier,
  assertExternalSideEffectReady = null,
} = {}) {
  const requestVerifier = requireSubmissionRequestVerifier(submissionRequestVerifier);
  const portal = assertAutonomousSubmissionPortalPort(suppliedPortal);
  const outbox = assertAutonomousSubmissionOutboxPort(suppliedOutbox);
  if (requestVerifier.verify(request) !== true
    || request.portalConfigurationHash !== portal.configurationHash) {
    throw new Error('autonomous_submission_delivery_request_invalid');
  }
  let current = outbox.prepareAutonomousSubmission({
    request,
    portalId: portal.portalId,
  });
  if (current.stateReceipt.state === AUTONOMOUS_SUBMISSION_DELIVERY_STATES.COMPLETED
    || current.stateReceipt.state
      === AUTONOMOUS_SUBMISSION_DELIVERY_STATES.EXPLICIT_FAILURE) {
    return result(current);
  }
  let dispatch;
  if (['dispatching', 'uncertain'].includes(current.stateReceipt.state)) {
    const reconciliation = await lookupUnsettled({
      portal,
      outbox,
      current,
      request,
      signal,
      submissionRequestVerifier: requestVerifier,
      assertExternalSideEffectReady,
    });
    if (reconciliation.settled) return reconciliation.settled;
    if (!reconciliation.dispatch) {
      throw new Error('autonomous_submission_reconciliation_invalid');
    }
    dispatch = reconciliation.dispatch;
  } else {
    dispatch = outbox.beginAutonomousSubmissionAttempt({
      request,
      portalId: portal.portalId,
    });
  }
  if (dispatch?.sideEffectPermit?.kind !== 'AutonomousSubmissionDispatchPermit') {
    throw new Error('autonomous_submission_dispatch_capability_missing');
  }
  let submissionReceipt;
  try {
    await assertExternalSideEffectReady?.({
      action: 'portal_submit',
      dispatch,
    });
    assertExternalSideEffectReady?.assertCurrent?.({
      action: 'portal_submit',
      dispatch,
    });
    await assertExternalSideEffectReady?.markStarted?.({
      action: 'portal_submit',
      dispatch,
    });
    submissionReceipt = await portal.submit({
      request,
      sideEffectPermit: dispatch.sideEffectPermit,
      signal,
    });
  } catch (error) {
    if (isInfrastructureFenceControlFlow(error)) throw error;
    if (error?.autonomousSubmissionCrashSimulation === true) throw error;
    const explicit = error?.autonomousSubmissionOutcome === 'explicit_failure';
    current = outbox.recordAutonomousSubmissionOutcome({
      request,
      portalId: portal.portalId,
      state: explicit
        ? AUTONOMOUS_SUBMISSION_DELIVERY_STATES.EXPLICIT_FAILURE
        : AUTONOMOUS_SUBMISSION_DELIVERY_STATES.UNCERTAIN,
      resolution: explicit
        ? 'remote-confirmed-explicit-failure' : 'remote-outcome-uncertain',
      failure: failureFrom(error),
    });
    return result(current, { networkActionPerformed: true });
  }
  if (!verifyAutonomousSubmissionReceipt(submissionReceipt, {
    request,
    requestVerifier,
    completedReceiptVerifier: portal.completedReceiptVerifier || null,
    requireCryptographicAuthority:
      portal.signedCompletedReceiptSupported === true,
  })) {
    current = outbox.recordAutonomousSubmissionOutcome({
      request,
      portalId: portal.portalId,
      state: AUTONOMOUS_SUBMISSION_DELIVERY_STATES.UNCERTAIN,
      resolution: 'remote-outcome-uncertain',
      failure: { code: 'autonomous_submission_receipt_invalid', httpStatus: null },
    });
    return result(current, { networkActionPerformed: true });
  }
  current = outbox.recordAutonomousSubmissionOutcome({
    request,
    portalId: portal.portalId,
    state: AUTONOMOUS_SUBMISSION_DELIVERY_STATES.COMPLETED,
    resolution: 'remote-confirmed-completed',
    submissionReceipt,
  });
  return result(current, { networkActionPerformed: true });
}

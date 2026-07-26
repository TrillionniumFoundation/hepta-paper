import {
  STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID,
  buildStrictFullAutoLiveVerificationReceipt,
  verifyStrictFullAutoAcceptancePlan,
  verifyStrictFullAutoAcceptanceReceipt,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';
import {
  STRICT_FULL_AUTO_ACCEPTANCE_COMPLETE_RENEWAL_STEP_ORDER,
} from '../../paper-domain/automation/strict-full-auto-acceptance-policy.mjs';
import {
  LIVE_VERIFICATION_MAX_DURATION_MS,
  assertInvocationOutput,
  finalVerificationStep,
  isStrictFullAutoAcceptanceNotReady,
} from './strict-full-auto-acceptance-state.mjs';

function bindAcceptanceStep(error, stepId) {
  const selected = error instanceof Error ? error : new Error(String(error));
  if (!selected.acceptanceStepId) selected.acceptanceStepId = stepId;
  return selected;
}

export class StrictFullAutoAcceptanceLiveVerification {
  statusReport(plan, state, receipt, liveVerificationReceipt, disposition = null) {
    const superseded = disposition?.status === 'superseded';
    return Object.freeze({
      version: 1,
      kind: 'StrictFullAutoAcceptanceStatus',
      planHash: plan.planHash,
      status: superseded ? 'superseded' : (state?.status || 'not-started'),
      completedStepCount: state?.completedStepReceipts.length || 0,
      totalStepCount: plan.steps.length,
      strictFullAutoAccepted: !superseded
        && disposition?.status !== 'candidate'
        && liveVerificationReceipt?.strictFullAutoAccepted === true,
      receipt: receipt || null,
      liveVerificationReceipt: superseded ? null : (liveVerificationReceipt || null),
      activePlanHash: disposition?.activePlanHash || null,
      supersededByPlanHash: disposition?.supersededByPlanHash || null,
    });
  }

  verifyCompleteCheckpoint(plan, state) {
    const receipt = this.repository.readReceipt(plan);
    verifyStrictFullAutoAcceptanceReceipt({
      plan,
      receipt,
      stepReceipts: state.completedStepReceipts,
      finalVerificationReceipt: state.finalVerificationReceipt,
    });
    if (receipt.receiptHash !== state.acceptanceReceiptHash) {
      throw new Error('strict_full_auto_acceptance_state_receipt_binding_invalid');
    }
    return receipt;
  }

  async runLiveVerificationUnderLease({
    plan,
    state,
    receipt,
    lease,
    signal,
  }) {
    const liveVerificationStartedAt = this.now();
    const verificationController = new AbortController();
    const forwardLeaseAbort = () => {
      verificationController.abort(signal.reason);
    };
    if (signal.aborted) {
      verificationController.abort(signal.reason);
    } else {
      signal.addEventListener('abort', forwardLeaseAbort, { once: true });
    }
    try {
      let primaryVerificationFailure = null;
      const verificationTasks = plan.steps.map(async (step) => {
        try {
          const output = await this.runBoundCommand({
            lease,
            plan, step, phase: 'verify', invocation: step.verify,
            signal: verificationController.signal,
          });
          return assertInvocationOutput(
            step.verify, output, `${step.stepId}:live-status-verify`,
          ).outputHash;
        } catch (error) {
          const bound = bindAcceptanceStep(error, step.stepId);
          if (!verificationController.signal.aborted) {
            primaryVerificationFailure = bound;
            verificationController.abort(bound);
          }
          throw bound;
        }
      });
      let verificationOutputHashes;
      try {
        verificationOutputHashes = await Promise.all(verificationTasks);
      } catch (error) {
        if (!verificationController.signal.aborted) verificationController.abort(error);
        await Promise.allSettled(verificationTasks);
        throw primaryVerificationFailure || error;
      }
      let finalVerificationOutputHash;
      const finalStep = finalVerificationStep(plan);
      try {
        const finalOutput = await this.runBoundCommand({
          lease,
          plan,
          step: finalStep,
          phase: 'verify',
          invocation: plan.finalVerification,
          signal: verificationController.signal,
        });
        finalVerificationOutputHash = assertInvocationOutput(
          plan.finalVerification,
          finalOutput,
          `${STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID}:live-status-verify`,
        ).outputHash;
      } catch (error) {
        const bound = bindAcceptanceStep(error, finalStep.stepId);
        if (!verificationController.signal.aborted) verificationController.abort(bound);
        throw bound;
      }
      const liveVerificationObservedAt = this.now();
      const liveVerificationDurationMs = Date.parse(liveVerificationObservedAt)
        - Date.parse(liveVerificationStartedAt);
      if (!Number.isSafeInteger(liveVerificationDurationMs)
        || liveVerificationDurationMs < 0
        || liveVerificationDurationMs > LIVE_VERIFICATION_MAX_DURATION_MS) {
        throw new Error('strict_full_auto_acceptance_live_verification_window_invalid');
      }
      const finalPlan = verifyStrictFullAutoAcceptancePlan(this.repository.inspectPlan());
      if (finalPlan.planHash !== plan.planHash) {
        throw new Error('strict_full_auto_acceptance_live_verification_plan_drift');
      }
      // Revalidate the immutable checkpoint immediately before binding a new live generation.
      verifyStrictFullAutoAcceptanceReceipt({
        plan,
        receipt,
        stepReceipts: state.completedStepReceipts,
        finalVerificationReceipt: state.finalVerificationReceipt,
      });
      return buildStrictFullAutoLiveVerificationReceipt({
        plan,
        checkpointReceipt: receipt,
        verificationOutputHashes,
        finalVerificationOutputHash,
        startedAt: liveVerificationStartedAt,
        observedAt: liveVerificationObservedAt,
        maximumDurationMs: LIVE_VERIFICATION_MAX_DURATION_MS,
      });
    } finally {
      signal.removeEventListener('abort', forwardLeaseAbort);
    }
  }

  async convergeCompleteStateUnderLease({
    plan,
    state,
    receipt,
    lease,
    signal,
  }) {
    const renewable = new Set(STRICT_FULL_AUTO_ACCEPTANCE_COMPLETE_RENEWAL_STEP_ORDER);
    const renewed = new Set();
    let finalRetryRemaining = 1;
    const maximumPasses = renewable.size + 2;
    for (let pass = 0; pass < maximumPasses; pass += 1) {
      try {
        return await this.runLiveVerificationUnderLease({
          plan, state, receipt, lease, signal,
        });
      } catch (error) {
        if (!isStrictFullAutoAcceptanceNotReady(error)) throw error;
        if (error.acceptanceStepId === STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID
          && finalRetryRemaining > 0) {
          finalRetryRemaining -= 1;
          continue;
        }
        const step = plan.steps.find((candidate) => (
          candidate.stepId === error.acceptanceStepId
        ));
        if (!step || !renewable.has(step.stepId) || renewed.has(step.stepId)) throw error;
        const ensureRenewalIntent = this.repositoryCapability('ensureRenewalIntent');
        if (!ensureRenewalIntent) {
          throw new Error('strict_full_auto_acceptance_renewal_store_required');
        }
        ensureRenewalIntent(plan, step, {
          lease,
          checkpointReceiptHash: receipt.receiptHash,
        });
        const output = await this.runBoundCommand({
          lease,
          plan,
          step,
          phase: 'execute',
          invocation: step.execute,
          signal,
        });
        assertInvocationOutput(step.execute, output, `${step.stepId}:complete-renewal`);
        renewed.add(step.stepId);
      }
    }
    throw new Error('strict_full_auto_acceptance_complete_renewal_bound_exhausted');
  }
}

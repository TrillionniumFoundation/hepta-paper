import {
  STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID,
  buildStrictFullAutoLiveVerificationReceipt,
  buildStrictFullAutoAcceptanceReceipt,
  buildStrictFullAutoFinalVerificationReceipt,
  strictFullAutoAcceptanceHash,
  verifyStrictFullAutoAcceptancePlan,
  verifyStrictFullAutoAcceptanceReceipt,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';
import {
  LIVE_VERIFICATION_MAX_DURATION_MS,
  RECOVERY_REEXECUTION_SAFE_STEPS,
  assertInvocationOutput,
  failureRecord,
  finalVerificationStep,
  initialState,
  stepReceipt,
  transitionedState,
  verifyState,
} from './strict-full-auto-acceptance-state.mjs';

export class StrictFullAutoAcceptanceOrchestrator {
  constructor({ repository, commandRunner, now = () => new Date().toISOString() } = {}) {
    if (!repository || typeof repository.inspectPlan !== 'function'
      || !commandRunner || typeof commandRunner.run !== 'function') {
      throw new Error('strict_full_auto_acceptance_dependencies_required');
    }
    this.repository = repository;
    this.commandRunner = commandRunner;
    this.now = now;
  }

  plan() {
    return this.repository.inspectPlan();
  }

  assertStablePlan(plan, lease) {
    this.repository.assertLease(plan, lease);
    const inspected = verifyStrictFullAutoAcceptancePlan(this.repository.inspectPlan());
    if (inspected.planHash !== plan.planHash) {
      throw new Error('strict_full_auto_acceptance_plan_or_reference_drift');
    }
    this.repository.readRuntimeRootActivation(plan);
    this.repository.assertLease(plan, lease);
  }

  checkpointState(plan, state, lease, updates) {
    this.assertStablePlan(plan, lease);
    const next = transitionedState(state, lease, updates, this.now);
    this.repository.writeState(plan, next, {
      lease,
      expectedRevision: state.revision,
    });
    return next;
  }

  async runBoundCommand({ plan, lease, signal, ...request }) {
    this.assertStablePlan(plan, lease);
    const output = await this.commandRunner.run({ plan, signal, ...request });
    if (request.step?.stepId === 'state-provisioning' && request.phase === 'execute') {
      this.repository.ensureRuntimeRootActivation(plan, { lease });
    }
    this.assertStablePlan(plan, lease);
    return output;
  }

  async withExclusiveLease(plan, purpose, work) {
    const lease = this.repository.acquireLease(plan, { purpose });
    const controller = new AbortController();
    let heartbeatFailure = null;
    const heartbeat = setInterval(() => {
      try { this.repository.renewLease(plan, lease); }
      catch (error) {
        heartbeatFailure = error;
        if (!controller.signal.aborted) controller.abort(error);
      }
    }, 10_000);
    heartbeat.unref?.();
    try {
      const result = await work({ lease, signal: controller.signal });
      if (heartbeatFailure) throw heartbeatFailure;
      this.assertStablePlan(plan, lease);
      return result;
    } finally {
      clearInterval(heartbeat);
      this.repository.releaseLease(plan, lease);
    }
  }

  async status({ leasedContext = null } = {}) {
    const plan = verifyStrictFullAutoAcceptancePlan(this.repository.inspectPlan());
    if (leasedContext && leasedContext.planHash !== plan.planHash) {
      throw new Error('strict_full_auto_acceptance_live_verification_plan_drift');
    }
    const state = this.repository.readState(plan);
    if (!state) return Object.freeze({
      version: 1,
      kind: 'StrictFullAutoAcceptanceStatus',
      planHash: plan.planHash,
      status: 'not-started',
      completedStepCount: 0,
      totalStepCount: plan.steps.length,
      strictFullAutoAccepted: false,
      receipt: null,
      liveVerificationReceipt: null,
    });
    const verifiedState = verifyState(plan, state);
    const receipt = this.repository.readReceipt(plan);
    let liveVerificationReceipt = null;
    if (verifiedState.status === 'complete') {
      if (!leasedContext) {
        return this.withExclusiveLease(plan, 'live-status', ({ lease, signal }) => this.status({
          leasedContext: { planHash: plan.planHash, lease, signal },
        }));
      }
      verifyStrictFullAutoAcceptanceReceipt({
        plan,
        receipt,
        stepReceipts: verifiedState.completedStepReceipts,
        finalVerificationReceipt: verifiedState.finalVerificationReceipt,
      });
      if (receipt.receiptHash !== verifiedState.acceptanceReceiptHash) {
        throw new Error('strict_full_auto_acceptance_state_receipt_binding_invalid');
      }
      const liveVerificationStartedAt = this.now();
      const verificationController = new AbortController();
      if (leasedContext.signal.aborted) {
        verificationController.abort(leasedContext.signal.reason);
      } else {
        leasedContext.signal.addEventListener('abort', () => {
          verificationController.abort(leasedContext.signal.reason);
        }, { once: true });
      }
      const verificationTasks = plan.steps.map(async (step) => {
        try {
          const output = await this.runBoundCommand({
            lease: leasedContext.lease,
            plan, step, phase: 'verify', invocation: step.verify,
            signal: verificationController.signal,
          });
          return assertInvocationOutput(
            step.verify, output, `${step.stepId}:live-status-verify`,
          ).outputHash;
        } catch (error) {
          if (!verificationController.signal.aborted) verificationController.abort(error);
          throw error;
        }
      });
      let verificationOutputHashes;
      try {
        verificationOutputHashes = await Promise.all(verificationTasks);
      } catch (error) {
        if (!verificationController.signal.aborted) verificationController.abort(error);
        await Promise.allSettled(verificationTasks);
        throw error;
      }
      let finalVerificationOutputHash;
      try {
        const finalStep = finalVerificationStep(plan);
        const finalOutput = await this.runBoundCommand({
          lease: leasedContext.lease,
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
        if (!verificationController.signal.aborted) verificationController.abort(error);
        throw error;
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
      liveVerificationReceipt = buildStrictFullAutoLiveVerificationReceipt({
        plan,
        checkpointReceipt: receipt,
        verificationOutputHashes,
        finalVerificationOutputHash,
        startedAt: liveVerificationStartedAt,
        observedAt: liveVerificationObservedAt,
        maximumDurationMs: LIVE_VERIFICATION_MAX_DURATION_MS,
      });
    } else if (receipt) {
      throw new Error('strict_full_auto_acceptance_premature_receipt');
    }
    return Object.freeze({
      version: 1,
      kind: 'StrictFullAutoAcceptanceStatus',
      planHash: plan.planHash,
      status: verifiedState.status,
      completedStepCount: verifiedState.completedStepReceipts.length,
      totalStepCount: plan.steps.length,
      strictFullAutoAccepted: liveVerificationReceipt?.strictFullAutoAccepted === true,
      receipt: receipt || null,
      liveVerificationReceipt,
    });
  }

  async execute({ expectedPlanHash } = {}) {
    // inspectPlan validates every public and opaque reference before any state write or child action.
    const plan = verifyStrictFullAutoAcceptancePlan(this.repository.inspectPlan());
    if (expectedPlanHash !== plan.planHash) {
      throw new Error('strict_full_auto_acceptance_explicit_plan_hash_required');
    }
    await this.withExclusiveLease(plan, 'execute', ({ lease, signal }) => (
      this.executeUnderLease({ plan, lease, signal })
    ));
    return this.status();
  }

  async executeUnderLease({ plan, lease, signal }) {
    let state = this.repository.readState(plan);
    if (!state) this.repository.assertRuntimeRootAbsent(plan);
    state = state ? verifyState(plan, state) : initialState(plan, this.now, lease);
    if (!this.repository.readState(plan)) {
      this.repository.writeState(plan, state, { lease, expectedRevision: null });
    }
    if (state.status === 'complete') return state;
    const initialRuntimeActivation = this.repository.readRuntimeRootActivation(plan);
    if (state.runtimeRootActivationHash !== null
      && initialRuntimeActivation?.runtimeRootActivationHash
        !== state.runtimeRootActivationHash) {
      throw new Error('strict_full_auto_acceptance_state_runtime_root_binding_invalid');
    }

    for (let index = state.completedStepReceipts.length; index < plan.steps.length; index += 1) {
      const step = plan.steps[index];
      let active = state.activeStep;
      this.repository.ensureIntent(plan, step, { lease });
      if (!active) {
        active = Object.freeze({
          stepId: step.stepId,
          idempotencyKey: step.idempotencyKey,
          phase: 'execute',
          intentHash: strictFullAutoAcceptanceHash({
            planHash: plan.planHash,
            stepId: step.stepId,
            idempotencyKey: step.idempotencyKey,
          }),
          executionOutputHash: null,
          attempt: 1,
        });
        state = this.checkpointState(plan, state, lease, {
          status: 'executing', activeStep: active, failure: null,
        });
      }

      try {
        let executionOutputHash = active.executionOutputHash;
        if (active.phase === 'execute') {
          const dispatchStart = this.repository.ensureDispatchStarted(plan, step, { lease });
          // A verify-first recovery closes the crash window after an external command succeeded
          // but before its output hash was checkpointed.
          if (!dispatchStart.created || state.status === 'failed' || active.attempt > 1) {
            try {
              if (step.stepId === 'state-provisioning'
                && state.runtimeRootActivationHash === null) {
                let activation = null;
                try { activation = this.repository.ensureRuntimeRootActivation(plan, { lease }); }
                catch (error) {
                  if (!String(error?.message).includes('runtime_root_not_activated')) throw error;
                }
                if (activation) {
                  state = this.checkpointState(plan, state, lease, {
                    runtimeRootActivationHash: activation.runtimeRootActivationHash,
                  });
                }
              }
              const recovered = await this.runBoundCommand({
                lease,
                plan, step, phase: 'verify', invocation: step.verify,
                signal,
              });
              const verified = assertInvocationOutput(step.verify, recovered,
                `${step.stepId}:recovery-verify`);
              if (step.stepId === 'state-provisioning'
                && state.runtimeRootActivationHash === null) {
                throw new Error('strict_full_auto_acceptance_runtime_root_activation_missing');
              }
              executionOutputHash = strictFullAutoAcceptanceHash({
                recoveredFromIntentHash: active.intentHash,
                verificationOutputHash: verified.outputHash,
              });
              const receipt = stepReceipt({ plan, step, executionOutputHash,
                verificationOutputHash: verified.outputHash, now: this.now });
              state = this.checkpointState(plan, state, lease, {
                status: 'executing',
                completedStepReceipts: [...state.completedStepReceipts, receipt],
                activeStep: null, failure: null,
              });
              continue;
            } catch (recoveryError) {
              if (!RECOVERY_REEXECUTION_SAFE_STEPS.has(step.stepId)) {
                throw new Error(
                  `strict_full_auto_acceptance_outcome_uncertain:${step.stepId}`,
                  { cause: recoveryError },
                );
              }
              // The plan contract restricts this phase to commands with immutable child plan
              // identifiers or durable idempotency. The runner passes the same plan-bound key.
            }
          }
          const executionOutput = await this.runBoundCommand({
            lease,
            plan, step, phase: 'execute', invocation: step.execute,
            signal,
          });
          executionOutputHash = assertInvocationOutput(
            step.execute,
            executionOutput,
            `${step.stepId}:execute`,
          ).outputHash;
          active = Object.freeze({ ...active, phase: 'verify', executionOutputHash });
          const runtimeActivation = step.stepId === 'state-provisioning'
            ? this.repository.readRuntimeRootActivation(plan) : null;
          state = this.checkpointState(plan, state, lease, {
            status: 'executing', activeStep: active, failure: null,
            ...(runtimeActivation ? {
              runtimeRootActivationHash: runtimeActivation.runtimeRootActivationHash,
            } : {}),
          });
        }
        const verificationOutput = await this.runBoundCommand({
          lease,
          plan, step, phase: 'verify', invocation: step.verify,
          signal,
        });
        const verified = assertInvocationOutput(
          step.verify,
          verificationOutput,
          `${step.stepId}:verify`,
        );
        const receipt = stepReceipt({ plan, step, executionOutputHash,
          verificationOutputHash: verified.outputHash, now: this.now });
        state = this.checkpointState(plan, state, lease, {
          status: 'executing',
          completedStepReceipts: [...state.completedStepReceipts, receipt],
          activeStep: null, failure: null,
        });
      } catch (error) {
        const retryActive = Object.freeze({ ...state.activeStep,
          attempt: state.activeStep.attempt + 1 });
        state = this.checkpointState(plan, state, lease, {
          status: 'failed', activeStep: retryActive,
          failure: failureRecord(error, step, this.now),
        });
        throw error;
      }
    }

    if (state.finalVerificationReceipt === null) {
      const finalStep = finalVerificationStep(plan);
      let active = state.activeStep;
      this.repository.ensureIntent(plan, finalStep, { lease });
      if (!active) {
        active = Object.freeze({
          stepId: finalStep.stepId,
          idempotencyKey: finalStep.idempotencyKey,
          phase: 'final-verify',
          intentHash: strictFullAutoAcceptanceHash({
            planHash: plan.planHash,
            stepId: finalStep.stepId,
            idempotencyKey: finalStep.idempotencyKey,
          }),
          executionOutputHash: null,
          attempt: 1,
        });
        state = this.checkpointState(plan, state, lease, {
          status: 'executing', activeStep: active, failure: null,
        });
      }
      try {
        const finalOutput = await this.runBoundCommand({
          lease,
          plan,
          step: finalStep,
          phase: 'verify',
          invocation: plan.finalVerification,
          signal,
        });
        const verified = assertInvocationOutput(
          plan.finalVerification,
          finalOutput,
          `${finalStep.stepId}:execute-final-verify`,
        );
        const finalVerificationReceipt = buildStrictFullAutoFinalVerificationReceipt({
          plan,
          outputHash: verified.outputHash,
          completedAt: this.now(),
        });
        state = this.checkpointState(plan, state, lease, {
          status: 'executing', finalVerificationReceipt,
          activeStep: null, failure: null,
        });
      } catch (error) {
        const retryActive = Object.freeze({ ...state.activeStep,
          attempt: state.activeStep.attempt + 1 });
        state = this.checkpointState(plan, state, lease, {
          status: 'failed', activeStep: retryActive,
          failure: failureRecord(error, finalStep, this.now),
        });
        throw error;
      }
    }

    const existingReceipt = this.repository.readReceipt(plan);
    const receipt = existingReceipt
      ? verifyStrictFullAutoAcceptanceReceipt({
        plan,
        receipt: existingReceipt,
        stepReceipts: state.completedStepReceipts,
        finalVerificationReceipt: state.finalVerificationReceipt,
      })
      : buildStrictFullAutoAcceptanceReceipt({
        plan,
        stepReceipts: state.completedStepReceipts,
        finalVerificationReceipt: state.finalVerificationReceipt,
        completedAt: this.now(),
      });
    if (!existingReceipt) this.repository.writeReceipt(plan, receipt, { lease });
    state = this.checkpointState(plan, state, lease, {
      status: 'complete', activeStep: null, failure: null,
      acceptanceReceiptHash: receipt.receiptHash,
    });
    return state;
  }
}

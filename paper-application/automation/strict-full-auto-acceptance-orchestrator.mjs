import {
  buildStrictFullAutoAcceptanceReceipt,
  buildStrictFullAutoFinalVerificationReceipt,
  strictFullAutoAcceptanceHash,
  verifyStrictFullAutoAcceptancePlan,
  verifyStrictFullAutoAcceptanceReceipt,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';
import {
  RECOVERY_REEXECUTION_SAFE_STEPS,
  assertInvocationOutput,
  failureRecord,
  finalVerificationStep,
  initialState,
  stepReceipt,
  transitionedState,
  verifyState,
} from './strict-full-auto-acceptance-state.mjs';
import {
  StrictFullAutoAcceptanceLiveVerification,
} from './strict-full-auto-acceptance-live-verification.mjs';

export class StrictFullAutoAcceptanceOrchestrator
  extends StrictFullAutoAcceptanceLiveVerification {
  constructor({ repository, commandRunner, now = () => new Date().toISOString() } = {}) {
    super();
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

  repositoryCapability(name) {
    if (typeof this.repository[name] === 'function') {
      return this.repository[name].bind(this.repository);
    }
    if (typeof this.repository.controlStore?.[name] === 'function') {
      return this.repository.controlStore[name].bind(this.repository.controlStore);
    }
    return null;
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
    const disposition = this.repositoryCapability('planDisposition')?.(plan)
      || Object.freeze({
      status: 'active', activePlanHash: plan.planHash, supersededByPlanHash: null,
    });
    const state = this.repository.readState(plan);
    if (!state) return this.statusReport(plan, null, null, null, disposition);
    const verifiedState = verifyState(plan, state);
    const receipt = this.repository.readReceipt(plan);
    if (disposition.status === 'superseded') {
      const verifiedReceipt = verifiedState.status === 'complete'
        ? this.verifyCompleteCheckpoint(plan, verifiedState) : null;
      if (verifiedState.status !== 'complete' && receipt) {
        throw new Error('strict_full_auto_acceptance_premature_receipt');
      }
      return this.statusReport(plan, verifiedState, verifiedReceipt, null, disposition);
    }
    if (verifiedState.status !== 'complete') {
      if (receipt) throw new Error('strict_full_auto_acceptance_premature_receipt');
      return this.statusReport(plan, verifiedState, null, null, disposition);
    }
    if (!leasedContext) {
      return this.withExclusiveLease(plan, 'live-status', ({ lease, signal }) => this.status({
        leasedContext: { planHash: plan.planHash, lease, signal },
      }));
    }
    const checkpointReceipt = this.verifyCompleteCheckpoint(plan, verifiedState);
    const liveVerificationReceipt = await this.runLiveVerificationUnderLease({
      plan,
      state: verifiedState,
      receipt: checkpointReceipt,
      lease: leasedContext.lease,
      signal: leasedContext.signal,
    });
    return this.statusReport(
      plan,
      verifiedState,
      checkpointReceipt,
      liveVerificationReceipt,
      disposition,
    );
  }

  async execute({ expectedPlanHash } = {}) {
    // inspectPlan validates every public and opaque reference before any state write or child action.
    const plan = verifyStrictFullAutoAcceptancePlan(this.repository.inspectPlan());
    if (expectedPlanHash !== plan.planHash) {
      throw new Error('strict_full_auto_acceptance_explicit_plan_hash_required');
    }
    return this.withExclusiveLease(plan, 'execute', async ({ lease, signal }) => {
      this.repositoryCapability('ensureCandidate')?.(plan, { lease });
      const state = verifyState(
        plan,
        await this.executeUnderLease({ plan, lease, signal }),
      );
      if (state.status !== 'complete') {
        throw new Error('strict_full_auto_acceptance_execution_incomplete');
      }
      const receipt = this.verifyCompleteCheckpoint(plan, state);
      const liveVerificationReceipt = await this.convergeCompleteStateUnderLease({
        plan, state, receipt, lease, signal,
      });
      this.repositoryCapability('writeLiveReceipt')?.(
        plan, liveVerificationReceipt, { lease },
      );
      this.repositoryCapability('promoteCandidate')?.(
        plan, liveVerificationReceipt, { lease },
      );
      const disposition = this.repositoryCapability('planDisposition')?.(plan)
        || Object.freeze({
        status: 'active', activePlanHash: plan.planHash, supersededByPlanHash: null,
      });
      return this.statusReport(
        plan, state, receipt, liveVerificationReceipt, disposition,
      );
    });
  }

  runtimeAdoptionStatus() {
    const plan = verifyStrictFullAutoAcceptancePlan(this.repository.inspectPlan());
    if (plan.runtimeRootAdoption.mode === 'fresh-runtime-only') {
      return Object.freeze({
        version: 1,
        kind: 'StrictFullAutoAcceptanceRuntimeAdoptionStatus',
        planHash: plan.planHash,
        mode: plan.runtimeRootAdoption.mode,
        ready: true,
        adoptionRequired: false,
        adoptionReceiptHash: null,
        runtimeRootActivationHash: null,
        blockers: Object.freeze([]),
      });
    }
    const adoption = this.repositoryCapability('readPristineRuntimeAdoption')?.(plan) || null;
    const activation = this.repository.readRuntimeRootActivation(plan);
    const ready = Boolean(adoption
      && activation?.version === 2
      && activation.adoptionReceiptHash === adoption.adoptionReceiptHash);
    return Object.freeze({
      version: 1,
      kind: 'StrictFullAutoAcceptanceRuntimeAdoptionStatus',
      planHash: plan.planHash,
      mode: plan.runtimeRootAdoption.mode,
      ready,
      adoptionRequired: true,
      adoptionReceiptHash: adoption?.adoptionReceiptHash || null,
      runtimeRootActivationHash: activation?.runtimeRootActivationHash || null,
      blockers: Object.freeze(ready
        ? [] : ['strict_full_auto_acceptance_pristine_runtime_adoption_required']),
    });
  }

  inspectRuntimeAdoptionCandidate() {
    const plan = verifyStrictFullAutoAcceptancePlan(this.repository.inspectPlan());
    const inspection = this.repositoryCapability(
      'inspectPristineRuntimeAdoptionCandidate',
    )?.(plan);
    if (!inspection) {
      throw new Error('strict_full_auto_acceptance_pristine_runtime_inspector_required');
    }
    const rechecked = verifyStrictFullAutoAcceptancePlan(this.repository.inspectPlan());
    if (rechecked.planHash !== plan.planHash) {
      throw new Error('strict_full_auto_acceptance_plan_or_reference_drift');
    }
    return inspection;
  }

  async adoptRuntime({ expectedPlanHash } = {}) {
    const plan = verifyStrictFullAutoAcceptancePlan(this.repository.inspectPlan());
    if (expectedPlanHash !== plan.planHash) {
      throw new Error('strict_full_auto_acceptance_explicit_plan_hash_required');
    }
    if (plan.runtimeRootAdoption.mode === 'fresh-runtime-only') {
      return this.runtimeAdoptionStatus();
    }
    return this.withExclusiveLease(plan, 'runtime-adoption', ({ lease }) => {
      this.repositoryCapability('ensureCandidate')?.(plan, { lease });
      if (this.repository.readState(plan)) {
        throw new Error('strict_full_auto_acceptance_pristine_runtime_adoption_after_state_forbidden');
      }
      const adopted = this.repositoryCapability('preparePristineRuntimeRootAdoption')?.(
        plan,
        { lease },
      );
      if (!adopted) {
        throw new Error('strict_full_auto_acceptance_pristine_runtime_adoption_unavailable');
      }
      this.assertStablePlan(plan, lease);
      return this.runtimeAdoptionStatus();
    });
  }

  async executeUnderLease({ plan, lease, signal }) {
    let state = this.repository.readState(plan);
    let inheritedRuntimeRootActivation = null;
    if (!state) {
      inheritedRuntimeRootActivation = this.repositoryCapability(
        'prepareCandidateRuntimeRootActivation',
      )?.(plan, { lease }) || null;
      if (!inheritedRuntimeRootActivation
        && plan.runtimeRootAdoption.mode === 'verified-pristine-existing-runtime') {
        const adoption = this.repositoryCapability('readPristineRuntimeAdoption')?.(plan) || null;
        const activation = this.repository.readRuntimeRootActivation(plan);
        if (!adoption
          || activation?.version !== 2
          || activation.adoptionReceiptHash !== adoption.adoptionReceiptHash) {
          throw new Error('strict_full_auto_acceptance_pristine_runtime_adoption_required');
        }
        inheritedRuntimeRootActivation = activation;
      }
      if (!inheritedRuntimeRootActivation) this.repository.assertRuntimeRootAbsent(plan);
    }
    state = state ? verifyState(plan, state) : initialState(plan, this.now, lease, {
      runtimeRootActivationHash:
        inheritedRuntimeRootActivation?.runtimeRootActivationHash || null,
    });
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
      const runtimeActivation = this.repository.readRuntimeRootActivation(plan);
      const adoptedProvisioning = step.stepId === 'state-provisioning'
        && runtimeActivation?.version === 2;
      const adoptedProvisioningBasis = adoptedProvisioning ? Object.freeze({
        version: 1,
        kind: 'StrictFullAutoAcceptanceAdoptedProvisioningExecutionBasis',
        adoptionReceiptHash: runtimeActivation.adoptionReceiptHash,
        runtimeRootActivationHash: runtimeActivation.runtimeRootActivationHash,
      }) : null;
      let active = state.activeStep;
      this.repository.ensureIntent(plan, step, { lease });
      if (!active) {
        active = Object.freeze({
          stepId: step.stepId,
          idempotencyKey: step.idempotencyKey,
          phase: adoptedProvisioning ? 'verify' : 'execute',
          intentHash: strictFullAutoAcceptanceHash({
            planHash: plan.planHash,
            stepId: step.stepId,
            idempotencyKey: step.idempotencyKey,
          }),
          executionOutputHash: adoptedProvisioning
            ? strictFullAutoAcceptanceHash(adoptedProvisioningBasis) : null,
          attempt: 1,
        });
        state = this.checkpointState(plan, state, lease, {
          status: 'executing', activeStep: active, failure: null,
        });
      }

      try {
        let executionOutputHash = active.executionOutputHash;
        if (adoptedProvisioning
          && (active.phase !== 'verify'
            || active.executionOutputHash
              !== strictFullAutoAcceptanceHash(adoptedProvisioningBasis))) {
          throw new Error('strict_full_auto_acceptance_adopted_provisioning_state_invalid');
        }
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
                executionBasis: null,
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
          executionBasis: adoptedProvisioningBasis,
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

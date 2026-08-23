import {
  STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID,
  STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER,
  strictFullAutoAcceptanceHash,
  strictFullAutoAcceptanceJsonEqual,
  verifyStrictFullAutoFinalVerificationReceipt,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';

export const RECOVERY_REEXECUTION_SAFE_STEPS = new Set([
  'online-transition',
  'production-campaign-qualification',
]);
// The live pass has two bounded phases: concurrent per-step verification (15m)
// followed by an independent aggregate verification (15m), plus one minute for
// checkpoint/reference revalidation overhead.
export const LIVE_VERIFICATION_MAX_DURATION_MS = 31 * 60 * 1000;

function canonicalTimestamp(value) {
  const parsed = Date.parse(value);
  return typeof value === 'string' && Number.isFinite(parsed)
    && new Date(parsed).toISOString() === value;
}

function stateBody(value) {
  return {
    version: value.version,
    kind: value.kind,
    planHash: value.planHash,
    revision: value.revision,
    fenceToken: value.fenceToken,
    status: value.status,
    completedStepReceipts: value.completedStepReceipts,
    runtimeRootActivationHash: value.runtimeRootActivationHash,
    finalVerificationReceipt: value.finalVerificationReceipt,
    acceptanceReceiptHash: value.acceptanceReceiptHash,
    activeStep: value.activeStep,
    failure: value.failure,
    updatedAt: value.updatedAt,
  };
}

function signedState(value) {
  const body = stateBody(value);
  return Object.freeze({ ...body, stateHash: strictFullAutoAcceptanceHash(body) });
}

export function initialState(plan, now, lease, {
  runtimeRootActivationHash = null,
} = {}) {
  return signedState({
    version: 2,
    kind: 'StrictFullAutoAcceptanceState',
    planHash: plan.planHash,
    revision: 1,
    fenceToken: lease.fenceToken,
    status: 'executing',
    completedStepReceipts: [],
    runtimeRootActivationHash,
    finalVerificationReceipt: null,
    acceptanceReceiptHash: null,
    activeStep: null,
    failure: null,
    updatedAt: now(),
  });
}

export function transitionedState(state, lease, updates, now) {
  return signedState({
    ...state,
    ...updates,
    revision: state.revision + 1,
    fenceToken: lease.fenceToken,
    updatedAt: now(),
  });
}

export function finalVerificationStep(plan) {
  const submissionStep = plan.steps.find((step) => step.stepId === 'submission-dispatcher');
  return Object.freeze({
    stepId: STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID,
    idempotencyKey: submissionStep.idempotencyKey,
    verify: plan.finalVerification,
  });
}

function verifyStepReceipt(receipt, expectedStep, index, runtimeRootActivationHash) {
  if (!exactKeys(receipt, [
    'stepId', 'stepDefinitionHash', 'idempotencyKey', 'planHash', 'configurationHash',
    'referenceSetHash', 'executionBasis', 'executionOutputHash', 'verificationOutputHash',
    'completedAt', 'skippedCount', 'receiptHash',
  ]) || receipt.stepId !== STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER[index]
    || receipt.stepDefinitionHash !== strictFullAutoAcceptanceHash(expectedStep)
    || receipt.idempotencyKey !== expectedStep.idempotencyKey
    || !/^sha256:[0-9a-f]{64}$/.test(String(receipt.executionOutputHash || ''))
    || !/^sha256:[0-9a-f]{64}$/.test(String(receipt.verificationOutputHash || ''))
    || !canonicalTimestamp(receipt.completedAt)
    || receipt.skippedCount !== 0) {
    throw new Error(`strict_full_auto_acceptance_state_step_receipt_invalid:${index}`);
  }
  if (receipt.executionBasis !== null) {
    if (expectedStep.stepId !== 'state-provisioning'
      || !exactKeys(receipt.executionBasis, [
        'version', 'kind', 'adoptionReceiptHash', 'runtimeRootActivationHash',
      ])
      || receipt.executionBasis.version !== 1
      || receipt.executionBasis.kind
        !== 'StrictFullAutoAcceptanceAdoptedProvisioningExecutionBasis'
      || !/^sha256:[0-9a-f]{64}$/.test(String(
        receipt.executionBasis.adoptionReceiptHash || '',
      ))
      || receipt.executionBasis.runtimeRootActivationHash !== runtimeRootActivationHash
      || receipt.executionOutputHash
        !== strictFullAutoAcceptanceHash(receipt.executionBasis)) {
      throw new Error(`strict_full_auto_acceptance_state_step_receipt_invalid:${index}`);
    }
  }
  const { receiptHash, ...body } = receipt;
  if (strictFullAutoAcceptanceHash(body) !== receiptHash) {
    throw new Error(`strict_full_auto_acceptance_state_step_receipt_hash_invalid:${index}`);
  }
  return receipt;
}

export function verifyState(plan, state) {
  if (!exactKeys(state, [
    'version', 'kind', 'planHash', 'revision', 'fenceToken', 'status',
    'completedStepReceipts', 'runtimeRootActivationHash', 'activeStep', 'finalVerificationReceipt',
    'acceptanceReceiptHash', 'failure', 'updatedAt', 'stateHash',
  ]) || state.version !== 2 || state.kind !== 'StrictFullAutoAcceptanceState'
    || state.planHash !== plan.planHash
    || !Number.isSafeInteger(state.revision) || state.revision < 1
    || !/^sha256:[0-9a-f]{64}$/.test(String(state.fenceToken || ''))
    || !['executing', 'failed', 'complete'].includes(state.status)
    || !Array.isArray(state.completedStepReceipts)
    || state.completedStepReceipts.length > plan.steps.length
    || !canonicalTimestamp(state.updatedAt)
    || strictFullAutoAcceptanceHash(stateBody(state)) !== state.stateHash) {
    throw new Error('strict_full_auto_acceptance_state_invalid');
  }
  if ((state.completedStepReceipts.length > 0
      && !/^sha256:[0-9a-f]{64}$/.test(String(state.runtimeRootActivationHash || '')))
    || (state.completedStepReceipts.length === 0
      && state.runtimeRootActivationHash !== null
      && !/^sha256:[0-9a-f]{64}$/.test(String(state.runtimeRootActivationHash)))) {
    throw new Error('strict_full_auto_acceptance_state_runtime_root_binding_invalid');
  }
  const referenceSetHash = strictFullAutoAcceptanceHash(plan.referenceBindings);
  let previousCompletedAt = Number.NEGATIVE_INFINITY;
  state.completedStepReceipts.forEach((receipt, index) => {
    verifyStepReceipt(receipt, plan.steps[index], index, state.runtimeRootActivationHash);
    const completedAt = Date.parse(receipt.completedAt);
    if (receipt.planHash !== plan.planHash
      || receipt.configurationHash !== plan.configurationHash
      || receipt.referenceSetHash !== referenceSetHash
      || completedAt < previousCompletedAt || completedAt > Date.parse(state.updatedAt)) {
      throw new Error(`strict_full_auto_acceptance_state_step_identity_invalid:${index}`);
    }
    previousCompletedAt = completedAt;
  });
  if (state.finalVerificationReceipt !== null) {
    verifyStrictFullAutoFinalVerificationReceipt({
      plan,
      receipt: state.finalVerificationReceipt,
    });
    if (state.completedStepReceipts.length !== plan.steps.length
      || Date.parse(state.finalVerificationReceipt.completedAt) < previousCompletedAt
      || Date.parse(state.finalVerificationReceipt.completedAt) > Date.parse(state.updatedAt)) {
      throw new Error('strict_full_auto_acceptance_state_final_verification_identity_invalid');
    }
  }
  if ((state.status === 'complete'
      && (state.completedStepReceipts.length !== plan.steps.length
        || state.finalVerificationReceipt === null
        || state.activeStep !== null || state.failure !== null
        || !/^sha256:[0-9a-f]{64}$/.test(String(state.acceptanceReceiptHash || ''))))
    || (state.status === 'failed' && (state.activeStep === null || state.failure === null))
    || (state.status === 'executing' && state.failure !== null)
    || (state.status !== 'complete' && state.acceptanceReceiptHash !== null)) {
    throw new Error('strict_full_auto_acceptance_state_status_invariant_invalid');
  }
  if (state.activeStep !== null) {
    const expectedStep = state.completedStepReceipts.length < plan.steps.length
      ? plan.steps[state.completedStepReceipts.length] : finalVerificationStep(plan);
    const finalVerificationActive = expectedStep.stepId
      === STRICT_FULL_AUTO_ACCEPTANCE_FINAL_VERIFICATION_STEP_ID;
    if (!exactKeys(state.activeStep, [
      'stepId', 'idempotencyKey', 'phase', 'intentHash', 'executionOutputHash',
      'attempt',
    ]) || state.activeStep.stepId !== expectedStep?.stepId
      || state.activeStep.idempotencyKey !== expectedStep?.idempotencyKey
      || !(finalVerificationActive
        ? state.activeStep.phase === 'final-verify'
        : ['execute', 'verify'].includes(state.activeStep.phase))
      || !Number.isSafeInteger(state.activeStep.attempt) || state.activeStep.attempt < 1
      || state.activeStep.intentHash !== strictFullAutoAcceptanceHash({
        planHash: plan.planHash,
        stepId: expectedStep.stepId,
        idempotencyKey: expectedStep.idempotencyKey,
      })
      || (['execute', 'final-verify'].includes(state.activeStep.phase)
        && state.activeStep.executionOutputHash !== null)
      || (state.activeStep.phase === 'verify'
        && !/^sha256:[0-9a-f]{64}$/.test(String(
          state.activeStep.executionOutputHash || '',
        )))) {
      throw new Error('strict_full_auto_acceptance_active_step_invalid');
    }
  }
  if (state.failure !== null) {
    if (!exactKeys(state.failure, [
      'stepId', 'failedAt', 'errorClass', 'errorHash',
    ]) || state.failure.stepId !== state.activeStep?.stepId
      || typeof state.failure.failedAt !== 'string'
      || !Number.isFinite(Date.parse(state.failure.failedAt))
      || typeof state.failure.errorClass !== 'string' || state.failure.errorClass.length === 0
      || state.failure.errorHash !== strictFullAutoAcceptanceHash({
        errorClass: state.failure.errorClass,
      })) {
      throw new Error('strict_full_auto_acceptance_state_failure_invalid');
    }
  }
  return state;
}

function jsonPointer(value, pointer) {
  return pointer.split('/').slice(1).reduce((current, key) => (
    current && Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined
  ), value);
}

function skippedCount(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + skippedCount(item), 0);
  if (!value || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((sum, [key, item]) => {
    if (['skipped', 'skipCount', 'skippedCount'].includes(key)
      && ((Number.isSafeInteger(item) && item > 0) || item === true)) {
      return sum + (item === true ? 1 : item);
    }
    return sum + skippedCount(item);
  }, 0);
}

export function assertInvocationOutput(invocation, output, label) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error(`strict_full_auto_acceptance_output_not_json_object:${label}`);
  }
  const skips = skippedCount(output);
  if (skips !== 0) throw new Error(`strict_full_auto_acceptance_skip_forbidden:${label}:${skips}`);
  for (const assertion of invocation.assertions) {
    if (!strictFullAutoAcceptanceJsonEqual(
      jsonPointer(output, assertion.path),
      assertion.equals,
    )) {
      const error = new Error(
        `strict_full_auto_acceptance_assertion_failed:${label}:${assertion.path}`,
      );
      error.code = 'STRICT_FULL_AUTO_ACCEPTANCE_NOT_READY';
      error.assertionPath = assertion.path;
      throw error;
    }
  }
  return Object.freeze({ outputHash: strictFullAutoAcceptanceHash(output), skippedCount: skips });
}

export function isStrictFullAutoAcceptanceNotReady(error) {
  return error?.code === 'STRICT_FULL_AUTO_ACCEPTANCE_NOT_READY';
}

export function stepReceipt({
  plan,
  step,
  executionBasis = null,
  executionOutputHash,
  verificationOutputHash,
  now,
}) {
  if (executionBasis !== null
    && executionOutputHash !== strictFullAutoAcceptanceHash(executionBasis)) {
    throw new Error('strict_full_auto_acceptance_step_execution_basis_invalid');
  }
  const body = Object.freeze({
    stepId: step.stepId,
    stepDefinitionHash: strictFullAutoAcceptanceHash(step),
    idempotencyKey: step.idempotencyKey,
    planHash: plan.planHash,
    configurationHash: plan.configurationHash,
    referenceSetHash: strictFullAutoAcceptanceHash(plan.referenceBindings),
    executionBasis,
    executionOutputHash,
    verificationOutputHash,
    completedAt: now(),
    skippedCount: 0,
  });
  return Object.freeze({ ...body, receiptHash: strictFullAutoAcceptanceHash(body) });
}

export function failureRecord(error, step, now) {
  const errorClass = String(error?.message || error || 'external_failure').split(':')[0];
  return Object.freeze({
    stepId: step.stepId,
    failedAt: now(),
    errorClass,
    errorHash: strictFullAutoAcceptanceHash({ errorClass }),
  });
}

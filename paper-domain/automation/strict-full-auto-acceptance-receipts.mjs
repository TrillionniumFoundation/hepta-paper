import {
  SHA256,
  STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER,
} from './strict-full-auto-acceptance-policy.mjs';
import {
  canonicalTimestamp,
  exactKeys,
  strictFullAutoAcceptanceHash,
} from './strict-full-auto-acceptance-primitives.mjs';
import {
  verifyStrictFullAutoAcceptancePlan,
} from './strict-full-auto-acceptance-plan.mjs';

export function buildStrictFullAutoFinalVerificationReceipt({
  plan,
  outputHash,
  completedAt,
} = {}) {
  const verifiedPlan = verifyStrictFullAutoAcceptancePlan(plan);
  if (!SHA256.test(String(outputHash || '')) || !canonicalTimestamp(completedAt)) {
    throw new Error('strict_full_auto_acceptance_final_verification_receipt_input_invalid');
  }
  const canonical = Object.freeze({
    version: 1,
    kind: 'StrictFullAutoFinalAggregateVerificationReceipt',
    planHash: verifiedPlan.planHash,
    qualificationPaperId: verifiedPlan.qualificationPaperId,
    invocationHash: strictFullAutoAcceptanceHash(verifiedPlan.finalVerification),
    outputHash,
    completedAt,
    skippedCount: 0,
    strongestDeclaredCapabilityStatusVerified: true,
  });
  return Object.freeze({ ...canonical, receiptHash: strictFullAutoAcceptanceHash(canonical) });
}

export function verifyStrictFullAutoFinalVerificationReceipt({ plan, receipt } = {}) {
  const rebuilt = buildStrictFullAutoFinalVerificationReceipt({
    plan,
    outputHash: receipt?.outputHash,
    completedAt: receipt?.completedAt,
  });
  if (!exactKeys(receipt, Object.keys(rebuilt)) || receipt.receiptHash !== rebuilt.receiptHash) {
    throw new Error('strict_full_auto_acceptance_final_verification_receipt_mismatch');
  }
  return rebuilt;
}

export function buildStrictFullAutoAcceptanceReceipt({
  plan,
  stepReceipts,
  finalVerificationReceipt,
  completedAt,
} = {}) {
  const verifiedPlan = verifyStrictFullAutoAcceptancePlan(plan);
  if (!Array.isArray(stepReceipts)
    || stepReceipts.length !== STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER.length
    || !canonicalTimestamp(completedAt)) {
    throw new Error('strict_full_auto_acceptance_receipt_input_invalid');
  }
  for (const [index, receipt] of stepReceipts.entries()) {
    if (!exactKeys(receipt, [
      'stepId', 'stepDefinitionHash', 'idempotencyKey', 'planHash', 'configurationHash',
      'referenceSetHash', 'executionBasis', 'executionOutputHash',
      'verificationOutputHash', 'completedAt', 'skippedCount', 'receiptHash',
    ]) || receipt.stepId !== STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER[index]
      || receipt.stepDefinitionHash !== strictFullAutoAcceptanceHash(verifiedPlan.steps[index])
      || receipt.idempotencyKey !== verifiedPlan.steps[index].idempotencyKey
      || receipt.planHash !== verifiedPlan.planHash
      || receipt.configurationHash !== verifiedPlan.configurationHash
      || receipt.referenceSetHash !== strictFullAutoAcceptanceHash(verifiedPlan.referenceBindings)
      || !SHA256.test(String(receipt.executionOutputHash || ''))
      || !SHA256.test(String(receipt.verificationOutputHash || ''))
      || !canonicalTimestamp(receipt.completedAt)
      || receipt.skippedCount !== 0 || !SHA256.test(String(receipt.receiptHash || ''))) {
      throw new Error(`strict_full_auto_acceptance_step_receipt_invalid:${index}`);
    }
    if (receipt.executionBasis !== null
      && (receipt.stepId !== 'state-provisioning'
        || !exactKeys(receipt.executionBasis, [
          'version', 'kind', 'adoptionReceiptHash', 'runtimeRootActivationHash',
        ])
        || receipt.executionBasis.version !== 1
        || receipt.executionBasis.kind
          !== 'StrictFullAutoAcceptanceAdoptedProvisioningExecutionBasis'
        || !SHA256.test(String(receipt.executionBasis.adoptionReceiptHash || ''))
        || !SHA256.test(String(receipt.executionBasis.runtimeRootActivationHash || ''))
        || receipt.executionOutputHash
          !== strictFullAutoAcceptanceHash(receipt.executionBasis))) {
      throw new Error(`strict_full_auto_acceptance_step_receipt_invalid:${index}`);
    }
    const { receiptHash, ...body } = receipt;
    if (strictFullAutoAcceptanceHash(body) !== receiptHash) {
      throw new Error(`strict_full_auto_acceptance_step_receipt_hash_mismatch:${index}`);
    }
  }
  const verifiedFinalVerificationReceipt = verifyStrictFullAutoFinalVerificationReceipt({
    plan: verifiedPlan,
    receipt: finalVerificationReceipt,
  });
  const latestStepCompletedAt = Date.parse(stepReceipts.at(-1)?.completedAt || '');
  if (Date.parse(verifiedFinalVerificationReceipt.completedAt) < latestStepCompletedAt
    || Date.parse(completedAt) < Date.parse(verifiedFinalVerificationReceipt.completedAt)) {
    throw new Error('strict_full_auto_acceptance_final_verification_timeline_invalid');
  }
  const canonical = Object.freeze({
    version: 3,
    kind: 'StrictFullAutoAcceptanceCheckpointReceipt',
    planHash: verifiedPlan.planHash,
    qualificationPaperId: verifiedPlan.qualificationPaperId,
    configurationHash: verifiedPlan.configurationHash,
    referenceSetHash: strictFullAutoAcceptanceHash(verifiedPlan.referenceBindings),
    completedStepReceiptHashes: Object.freeze(stepReceipts.map((item) => item.receiptHash)),
    finalVerificationReceiptHash: verifiedFinalVerificationReceipt.receiptHash,
    completedAt,
    checkpointComplete: true,
    skippedCount: 0,
    externalAuthoritiesSelfSigned: false,
    privateKeyMaterialHandled: false,
    localCheckpointOnly: true,
    liveVerificationRequired: true,
    strictFullAutoAccepted: false,
  });
  return Object.freeze({ ...canonical, receiptHash: strictFullAutoAcceptanceHash(canonical) });
}

export function verifyStrictFullAutoAcceptanceReceipt({
  plan,
  receipt,
  stepReceipts,
  finalVerificationReceipt,
} = {}) {
  const rebuilt = buildStrictFullAutoAcceptanceReceipt({
    plan,
    stepReceipts,
    finalVerificationReceipt,
    completedAt: receipt?.completedAt,
  });
  if (!exactKeys(receipt, Object.keys(rebuilt)) || receipt.receiptHash !== rebuilt.receiptHash) {
    throw new Error('strict_full_auto_acceptance_receipt_mismatch');
  }
  return rebuilt;
}

export function buildStrictFullAutoLiveVerificationReceipt({
  plan,
  checkpointReceipt,
  verificationOutputHashes,
  finalVerificationOutputHash,
  startedAt,
  observedAt,
  maximumDurationMs,
} = {}) {
  const verifiedPlan = verifyStrictFullAutoAcceptancePlan(plan);
  if (!checkpointReceipt || checkpointReceipt.localCheckpointOnly !== true
    || checkpointReceipt.strictFullAutoAccepted !== false
    || !SHA256.test(String(checkpointReceipt.receiptHash || ''))
    || !Array.isArray(verificationOutputHashes)
    || verificationOutputHashes.length !== verifiedPlan.steps.length
    || verificationOutputHashes.some((hash) => !SHA256.test(String(hash || '')))
    || !SHA256.test(String(finalVerificationOutputHash || ''))
    || !canonicalTimestamp(startedAt) || !canonicalTimestamp(observedAt)) {
    throw new Error('strict_full_auto_acceptance_live_verification_input_invalid');
  }
  const verificationDurationMs = Date.parse(observedAt) - Date.parse(startedAt);
  if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs < 1
    || !Number.isSafeInteger(verificationDurationMs) || verificationDurationMs < 0
    || verificationDurationMs > maximumDurationMs) {
    throw new Error('strict_full_auto_acceptance_live_verification_window_invalid');
  }
  const canonical = Object.freeze({
    version: 1,
    kind: 'StrictFullAutoLiveVerificationReceipt',
    planHash: verifiedPlan.planHash,
    qualificationPaperId: verifiedPlan.qualificationPaperId,
    checkpointReceiptHash: checkpointReceipt.receiptHash,
    verificationOutputHashes: Object.freeze([...verificationOutputHashes]),
    finalVerificationInvocationHash:
      strictFullAutoAcceptanceHash(verifiedPlan.finalVerification),
    finalVerificationOutputHash,
    startedAt,
    observedAt,
    verificationDurationMs,
    maximumDurationMs,
    planAndReferenceIdentityReverifiedAfterChecks: true,
    localCheckpointTrustedAsAuthority: false,
    allStepsLiveVerified: true,
    finalAggregateLiveVerified: true,
    skippedCount: 0,
    strictFullAutoAccepted: true,
  });
  return Object.freeze({ ...canonical, receiptHash: strictFullAutoAcceptanceHash(canonical) });
}

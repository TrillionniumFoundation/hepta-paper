import {
  formalDomainQualificationRecoveryIdempotencyKey,
} from '../../paper-adapters/automation/formal-domain-qualification-recovery-journal.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RECOVERY_PORT_KINDS = Object.freeze({
  reviewer: 'FormalDomainQualificationReviewerRecoveryPort',
  signer: 'FormalDomainQualificationSignerRecoveryPort',
});

export function assertRecoveryPort(port, stage) {
  if (!port || port.kind !== RECOVERY_PORT_KINDS[stage]
    || port.crashRecoveryReady !== true
    || !SHA256.test(String(port.configurationIdentityHash || ''))
    || port.recoveryOutcomeCryptographicAuthorityReady !== true
    || !SHA256.test(String(
      port.recoveryOutcomeVerificationPolicyHash || '',
    ))
    || typeof port.lookup !== 'function'
    || typeof port.resume !== 'function'
    || typeof port.execute !== 'function'
    || typeof port.verifyReceipt !== 'function') {
    throw new Error(
      `formal_domain_qualification_${stage}_lookup_resume_required`,
    );
  }
  return port;
}

export function assertReplayRecoveryPort(port) {
  if (port?.crashRecoveryReady !== true
    || !SHA256.test(String(
      port.recoveryConfigurationIdentityHash || port.configurationHash || '',
    ))
    || port.recoveryOutcomeCryptographicAuthorityReady !== true
    || !SHA256.test(String(
      port.recoveryOutcomeVerificationPolicyHash || '',
    ))
    || typeof port.lookup !== 'function'
    || typeof port.resume !== 'function'
    || typeof port.replay !== 'function'
    || typeof port.verifyReceipt !== 'function') {
    throw new Error(
      'formal_domain_qualification_external_replay_lookup_resume_required',
    );
  }
  return port;
}

function normalizeRecoveryResolution(resolution, verifyReceipt) {
  if (!resolution || !['completed', 'in_progress', 'not_found']
    .includes(resolution.status)) {
    throw new Error('formal_domain_qualification_recovery_resolution_invalid');
  }
  if (resolution.status !== 'completed') {
    if (resolution.receipt !== null && resolution.receipt !== undefined) {
      throw new Error('formal_domain_qualification_recovery_resolution_invalid');
    }
    return Object.freeze({ status: resolution.status, receipt: null });
  }
  if (!verifyReceipt(resolution.receipt)) {
    throw new Error('formal_domain_qualification_recovery_receipt_invalid');
  }
  return Object.freeze({
    status: 'completed',
    receipt: Object.freeze(resolution.receipt),
  });
}

async function authorizeRecoveryStage(gate, {
  stage,
  campaignId,
  operationId,
  idempotencyKey,
} = {}) {
  if (!gate) return;
  await gate({
    action: `formal_domain_qualification_${stage}`,
    campaignId,
    operationId,
    idempotencyKey,
  });
  gate.assertCurrent?.({
    action: `formal_domain_qualification_${stage}`,
    campaignId,
    operationId,
    idempotencyKey,
  });
  await gate.markStarted?.({
    action: `formal_domain_qualification_${stage}`,
    operationId,
    idempotencyKey,
  });
}

function assertRecoveryLookupCurrent(gate, {
  stage,
  campaignId,
  operationId,
  idempotencyKey,
} = {}) {
  gate?.assertCurrent?.({
    action: `formal_domain_qualification_${stage}_lookup`,
    campaignId,
    operationId,
    idempotencyKey,
  });
}

export function assertRecoveryExecutionActive(executionSignal) {
  if (executionSignal?.aborted === true) {
    if (executionSignal.reason instanceof Error) {
      throw executionSignal.reason;
    }
    throw new Error('formal_domain_qualification_execution_aborted');
  }
}

export function assertRecoveryGenerationSelectionCurrent(gate, {
  campaignId,
  lineageId,
} = {}) {
  gate?.assertCurrent?.({
    action: 'formal_domain_qualification_generation_select',
    campaignId,
    lineageId,
  });
}

export async function resolveCrashSafeStage({
  journal,
  operationId,
  stage,
  request,
  port,
  execute,
  resume = null,
  verifyReceipt,
  campaignId,
  assertExternalSideEffectReady,
  faultInjector,
  executionSignal,
}) {
  const idempotencyKey = formalDomainQualificationRecoveryIdempotencyKey({
    operationId,
    stage,
  });
  const completed = journal.latest(stage, 'stage_completed');
  if (completed) {
    if (completed.idempotencyKey !== idempotencyKey
      || !verifyReceipt(completed.result?.receipt)) {
      throw new Error('formal_domain_qualification_recovery_journal_receipt_invalid');
    }
    return completed.result.receipt;
  }
  const priorStart = journal.latest(stage, 'stage_started');
  if (priorStart && priorStart.idempotencyKey !== idempotencyKey) {
    throw new Error('formal_domain_qualification_recovery_journal_identity_invalid');
  }

  const recoveryInput = Object.freeze({
    operationId,
    idempotencyKey,
    request,
    signal: executionSignal || null,
  });
  assertRecoveryExecutionActive(executionSignal);
  assertRecoveryLookupCurrent(assertExternalSideEffectReady, {
    stage,
    campaignId,
    operationId,
    idempotencyKey,
  });
  const lookup = normalizeRecoveryResolution(
    await port.lookup(recoveryInput),
    verifyReceipt,
  );
  if (lookup.status === 'completed') {
    if (!priorStart) {
      journal.append({
        stage,
        event: 'stage_started',
        idempotencyKey,
      });
    }
    journal.append({
      stage,
      event: 'stage_completed',
      idempotencyKey,
      result: Object.freeze({ receipt: lookup.receipt, recovered: true }),
    });
    return lookup.receipt;
  }

  assertRecoveryExecutionActive(executionSignal);
  await authorizeRecoveryStage(assertExternalSideEffectReady, {
    stage,
    campaignId,
    operationId,
    idempotencyKey,
  });
  assertRecoveryExecutionActive(executionSignal);
  if (!priorStart) {
    journal.append({
      stage,
      event: 'stage_started',
      idempotencyKey,
    });
  }
  assertRecoveryExecutionActive(executionSignal);
  let receipt;
  if (priorStart || lookup.status === 'in_progress') {
    const resumed = normalizeRecoveryResolution(
      await (resume ? resume(recoveryInput) : port.resume(recoveryInput)),
      verifyReceipt,
    );
    if (resumed.status !== 'completed') {
      throw new Error(
        `formal_domain_qualification_${stage}_recovery_incomplete:${resumed.status}`,
      );
    }
    receipt = resumed.receipt;
  } else {
    receipt = await execute({ ...recoveryInput });
    if (!verifyReceipt(receipt)) {
      throw new Error('formal_domain_qualification_recovery_receipt_invalid');
    }
  }
  await faultInjector?.({
    point: 'after_remote_success_before_journal_append',
    stage,
    operationId,
    idempotencyKey,
    receipt,
  });
  journal.append({
    stage,
    event: 'stage_completed',
    idempotencyKey,
    result: Object.freeze({
      receipt,
      recovered: Boolean(priorStart) || lookup.status === 'in_progress',
    }),
  });
  return receipt;
}

export async function resolveRepeatableLocalStage({
  journal,
  operationId,
  stage,
  request,
  execute,
  verifyReceipt,
  campaignId,
  assertExternalSideEffectReady,
  faultInjector,
  executionSignal,
}) {
  const idempotencyKey = formalDomainQualificationRecoveryIdempotencyKey({
    operationId,
    stage,
  });
  const completed = journal.latest(stage, 'stage_completed');
  if (completed) {
    if (completed.idempotencyKey !== idempotencyKey
      || !verifyReceipt(completed.result?.receipt)) {
      throw new Error('formal_domain_qualification_recovery_journal_receipt_invalid');
    }
    return completed.result.receipt;
  }
  const priorStart = journal.latest(stage, 'stage_started');
  if (priorStart && priorStart.idempotencyKey !== idempotencyKey) {
    throw new Error('formal_domain_qualification_recovery_journal_identity_invalid');
  }
  assertRecoveryExecutionActive(executionSignal);
  await authorizeRecoveryStage(assertExternalSideEffectReady, {
    stage,
    campaignId,
    operationId,
    idempotencyKey,
  });
  assertRecoveryExecutionActive(executionSignal);
  if (!priorStart) {
    journal.append({
      stage,
      event: 'stage_started',
      idempotencyKey,
    });
  }
  const receipt = await execute({
    operationId,
    idempotencyKey,
    request,
    signal: executionSignal || null,
  });
  if (!verifyReceipt(receipt)) {
    throw new Error('formal_domain_qualification_recovery_receipt_invalid');
  }
  await faultInjector?.({
    point: 'after_remote_success_before_journal_append',
    stage,
    operationId,
    idempotencyKey,
    receipt,
  });
  journal.append({
    stage,
    event: 'stage_completed',
    idempotencyKey,
    result: Object.freeze({
      receipt,
      recovered: Boolean(priorStart),
    }),
  });
  return receipt;
}

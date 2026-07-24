import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const PRODUCTION_AUTONOMOUS_RESEARCH_RUNTIME_ROOT =
  '/var/lib/hepta-paper/runtime';
export const PRODUCTION_AUTONOMOUS_SUBMISSION_HANDOFF_LAYOUT_RECEIPT_PATH =
  '/run/hepta-paper-handoff-layout/'
  + 'autonomous-submission-handoff-layout.receipt.json';
export const PRODUCTION_AUTONOMOUS_SUBMISSION_HANDOFF_LAYOUT_HELPER_PATH =
  '/usr/libexec/hepta-paper/autonomous-submission-handoff-layout-provision';

const sleepArray = new Int32Array(new SharedArrayBuffer(4));

function parseVerifierOutput(output) {
  let receipt;
  try {
    receipt = JSON.parse(String(output || ''));
  } catch {
    throw new Error('autonomous_submission_handoff_layout_verifier_output_invalid');
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.status
      !== 'autonomous_submission_handoff_layout_receipt_verified'
    || receipt.ready !== true || receipt.databaseOpenedReadOnly !== true
    || receipt.databaseContentCreated !== false
    || receipt.credentialContentCreated !== false
    || receipt.authorityContentCreated !== false
    || !/^sha256:[0-9a-f]{64}$/.test(String(receipt.databaseSha256 || ''))) {
    throw new Error('autonomous_submission_handoff_layout_verifier_output_invalid');
  }
  return Object.freeze({ ...receipt });
}

export function verifyAutonomousSubmissionHandoffLayoutReceipt({
  runtimeRoot,
  receiptPath,
  helperPath = PRODUCTION_AUTONOMOUS_SUBMISSION_HANDOFF_LAYOUT_HELPER_PATH,
  timeoutMs = 10_000,
} = {}) {
  const resolvedRuntimeRoot = path.resolve(String(runtimeRoot || ''));
  const resolvedReceiptPath = path.resolve(String(receiptPath || ''));
  const resolvedHelperPath = path.resolve(String(helperPath || ''));
  if (!path.isAbsolute(String(runtimeRoot || ''))
    || !path.isAbsolute(String(receiptPath || ''))
    || !path.isAbsolute(String(helperPath || ''))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('autonomous_submission_handoff_layout_verifier_arguments_invalid');
  }
  const child = spawnSync(resolvedHelperPath, [
    '--verify-layout-receipt',
    '--runtime-root',
    resolvedRuntimeRoot,
    '--receipt-path',
    resolvedReceiptPath,
  ], {
    encoding: 'utf8',
    env: Object.freeze({ PATH: '/usr/sbin:/usr/bin' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
  });
  if (child.error || child.status !== 0 || child.signal
    || !child.stdout || child.stderr) {
    throw new Error(
      'autonomous_submission_handoff_layout_native_verification_failed',
      { cause: child.error || new Error(String(child.stderr || child.signal || child.status)) },
    );
  }
  return parseVerifierOutput(child.stdout);
}

export function awaitProductionAutonomousSubmissionHandoffLayoutReceipt({
  runtimeRoot,
  timeoutMs = 120_000,
  pollMs = 100,
} = {}) {
  const resolvedRuntimeRoot = path.resolve(String(runtimeRoot || ''));
  if (resolvedRuntimeRoot !== PRODUCTION_AUTONOMOUS_RESEARCH_RUNTIME_ROOT) {
    return null;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs) {
    throw new Error('autonomous_submission_handoff_layout_wait_policy_invalid');
  }
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      return verifyAutonomousSubmissionHandoffLayoutReceipt({
        runtimeRoot: resolvedRuntimeRoot,
        receiptPath:
          PRODUCTION_AUTONOMOUS_SUBMISSION_HANDOFF_LAYOUT_RECEIPT_PATH,
      });
    } catch (error) {
      lastError = error;
      Atomics.wait(sleepArray, 0, 0, Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  }
  throw new Error(
    'autonomous_submission_handoff_layout_receipt_wait_timeout',
    { cause: lastError },
  );
}

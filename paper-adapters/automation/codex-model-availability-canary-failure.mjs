import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  inspectManagedRuntimeFailure,
} from './codex-openclaw-managed-failure-protocol.mjs';

const MANAGED_QUOTA_FAILURE_CODE =
  'codex_openclaw_managed_profile_quota_exhausted';
const PROCESS_ERROR_CLASSES = new Map([
  ['E2BIG', 'argument_limit'],
  ['EACCES', 'permission_denied'],
  ['EAGAIN', 'temporarily_unavailable'],
  ['EMFILE', 'descriptor_limit'],
  ['ENFILE', 'descriptor_limit'],
  ['ENOENT', 'executable_missing'],
  ['ENOBUFS', 'output_limit'],
  ['ENOMEM', 'memory_limit'],
  ['ETIMEDOUT', 'timeout'],
]);
const PROCESS_SIGNALS = new Set([
  'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL',
  'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP', 'SIGUSR1', 'SIGUSR2',
]);
const VERIFIED_MODEL_AVAILABILITY_CANARY_FAILURES = new WeakMap();

function modelCanaryFailureDiagnostic({
  runtime,
  result = null,
  cause = null,
  failureExecutorBinding = null,
} = {}) {
  const processError = result?.error || cause;
  const stdout = String(result?.stdout || '');
  const stderr = String(result?.stderr || '');
  const processResult = Object.freeze({
    timedOut: processError?.code === 'ETIMEDOUT',
    outputTruncated: processError?.code === 'ENOBUFS',
    stdout,
    stderr,
    exitCode: Number.isSafeInteger(result?.status) ? result.status : null,
    signal: result?.signal || null,
    error: processError || null,
  });
  const managedFailure = inspectManagedRuntimeFailure({
    managedRuntimeExpected: runtime?.managedRuntimeEvidenceRequired === true,
    cancelled: false,
    processResult,
    model: runtime?.model,
    capabilityReceipt: runtime,
    failureExecutorBinding,
  });
  const verifiedManagedFailure = managedFailure.managedFailureEvidenceVerified === true
    && managedFailure.managedFailureEvidence?.version === 5;
  const managedRuntimeFailureCode = verifiedManagedFailure
    ? managedFailure.managedRuntimeFailureCode : null;
  const failureClass = managedRuntimeFailureCode === MANAGED_QUOTA_FAILURE_CODE
    ? 'quota' : 'unknown';
  const processErrorClass = processError
    ? PROCESS_ERROR_CLASSES.get(String(processError.code || '')) || 'other'
    : null;
  const signalClass = result?.signal
    ? (PROCESS_SIGNALS.has(result.signal) ? result.signal : 'other') : null;
  const exitStatus = Number.isSafeInteger(result?.status)
    && result.status >= 0 && result.status <= 255 ? result.status : null;
  const failureSource = verifiedManagedFailure
    ? 'verified_managed_failure_protocol_v5'
    : cause ? 'spawn_exception'
      : processError ? 'process_error'
        : result?.signal ? 'process_signal'
          : result?.status !== 0 ? 'nonzero_exit' : 'response_mismatch';
  const diagnostic = Object.freeze({
    version: 1,
    failureClass,
    failureSource,
    managedRuntimeFailureCode,
    exitStatus,
    signalClass,
    processErrorClass,
  });
  return Object.freeze({
    failureClass,
    diagnosticHash: hashRecord(
      'CodexModelAvailabilityCanaryFailureDiagnostic',
      diagnostic,
    ),
  });
}

export function failCodexModelAvailabilityCanary(errorPrefix, input) {
  const diagnostic = modelCanaryFailureDiagnostic(input);
  const error = new Error(`${errorPrefix}_model_live_canary_failed`);
  Object.defineProperties(error, {
    retryable: {
      value: false,
      enumerable: true,
      writable: false,
      configurable: false,
    },
    failureClass: {
      value: diagnostic.failureClass,
      enumerable: true,
      writable: false,
      configurable: false,
    },
    diagnosticHash: {
      value: diagnostic.diagnosticHash,
      enumerable: true,
      writable: false,
      configurable: false,
    },
  });
  VERIFIED_MODEL_AVAILABILITY_CANARY_FAILURES.set(error, diagnostic);
  throw error;
}

export function verifiedCodexModelAvailabilityCanaryFailure(error) {
  return VERIFIED_MODEL_AVAILABILITY_CANARY_FAILURES.get(error) || null;
}

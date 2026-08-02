import {
  verifyOpenClawManagedFailureEvidence,
} from './codex-openclaw-managed-usage-evidence.mjs';

const MANAGED_RUNTIME_FAILURE_CODE_PATTERN =
  /^codex_openclaw_managed_[a-z0-9_:-]{1,128}$/;

export function managedRuntimeFailureRetryable(
  code,
  verifiedFailureEvidence = null,
) {
  if (!code) return true;
  return !String(code).startsWith('codex_openclaw_managed_')
    || (verifiedFailureEvidence?.version === 5
      && verifiedFailureEvidence?.usageComplete === true
      && verifiedFailureEvidence?.failureDisposition === 'retryable');
}

function strictObject(line) {
  try {
    const parsed = JSON.parse(String(line));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed : null;
  } catch {
    return null;
  }
}

export function parseManagedRuntimeFailureProtocol(stderr) {
  const lines = String(stderr || '').split(/\r?\n/);
  while (lines.at(-1) === '') lines.pop();
  if (!lines.length) return null;
  const finalLine = lines.at(-1);
  if (MANAGED_RUNTIME_FAILURE_CODE_PATTERN.test(finalLine)) {
    return lines.length === 1
      ? Object.freeze({ code: finalLine, evidence: null, valid: true })
      : Object.freeze({ code: null, evidence: null, valid: false });
  }
  const evidence = strictObject(finalLine);
  const code = lines.length > 1 ? lines.at(-2) : null;
  if (!evidence || !MANAGED_RUNTIME_FAILURE_CODE_PATTERN.test(code)) {
    return Object.freeze({ code: null, evidence: null, valid: false });
  }
  return Object.freeze({ code, evidence, valid: true });
}

export function inspectManagedRuntimeFailure({
  managedRuntimeExpected,
  cancelled,
  processResult,
  model,
  capabilityReceipt,
  failureExecutorBinding,
} = {}) {
  const protocol = managedRuntimeExpected
    && !cancelled
    && !processResult.timedOut
    && !processResult.outputTruncated
    && processResult.stdout.length === 0
    && (processResult.exitCode !== 0 || processResult.error)
    ? parseManagedRuntimeFailureProtocol(processResult.stderr) : null;
  const code = protocol?.code || null;
  const evidence = protocol?.valid === true ? protocol.evidence : null;
  const evidenceVerified = Boolean(evidence
    && verifyOpenClawManagedFailureEvidence(evidence, {
      failureCode: code,
      model,
      expectedAuthProfileIdentityHash:
        capabilityReceipt?.openClawManagedAuthProfileIdentityHash,
      expectedRuntimeProvenanceHash:
        capabilityReceipt?.openClawManagedRuntimeProvenanceHash,
      expectedFailureExecutionBinding:
        failureExecutorBinding?.expectedFailureExecutionBinding,
    }));
  return Object.freeze({
    parsedManagedRuntimeFailureProtocol: protocol,
    managedRuntimeFailureCode: code,
    managedFailureEvidence: evidence,
    managedFailureEvidenceVerified: evidenceVerified,
  });
}

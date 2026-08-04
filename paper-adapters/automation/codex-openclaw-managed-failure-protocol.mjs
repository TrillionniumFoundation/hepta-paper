import {
  verifyOpenClawManagedFailureEvidence,
} from './codex-openclaw-managed-usage-evidence.mjs';
import {
  isKnownOpenClawManagedFailureCode,
  OPENCLAW_MANAGED_UNCLASSIFIED_FAILURE_CODE,
  projectOpenClawManagedFailureCode,
} from './codex-openclaw-managed-failure-code.mjs';

export function managedRuntimeFailureRetryable(
  code,
  verifiedFailureEvidence = null,
) {
  if (!code) return true;
  const safeCode = projectOpenClawManagedFailureCode(code);
  return safeCode !== OPENCLAW_MANAGED_UNCLASSIFIED_FAILURE_CODE
    && (verifiedFailureEvidence?.version === 5
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
  if (isKnownOpenClawManagedFailureCode(finalLine)) {
    return lines.length === 1
      ? Object.freeze({ code: finalLine, evidence: null, valid: true })
      : Object.freeze({ code: null, evidence: null, valid: false });
  }
  if (lines.length === 1) {
    return Object.freeze({
      code: projectOpenClawManagedFailureCode(finalLine),
      evidence: null,
      valid: false,
    });
  }
  const evidence = strictObject(finalLine);
  const candidate = lines.at(-2);
  if (!evidence || !isKnownOpenClawManagedFailureCode(candidate)) {
    const code = evidence
      ? projectOpenClawManagedFailureCode(candidate) : null;
    return Object.freeze({ code, evidence: null, valid: false });
  }
  const code = projectOpenClawManagedFailureCode(candidate);
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

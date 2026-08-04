import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifiedCodexModelAvailabilityCanaryFailure,
} from '../../paper-adapters/automation/codex-model-availability-canary-failure.mjs';

const NORMALIZED_FAILURE_CLASSES = new Set([
  'aborted', 'authentication', 'context', 'overloaded', 'quota',
  'rate_limited', 'unknown', 'unsupported_model',
]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ERROR_CODES = new Set([
  'autonomous_research_one_shot_source_snapshot_blocked:dirty_git_worktree',
  'autonomous_research_provider_canary_attempt_failed',
  'autonomous_research_supervisor_author_canary_model_live_canary_failed',
  'autonomous_research_supervisor_provider_canary_failed',
  'autonomous_research_supervisor_reviewer_canary_model_live_canary_failed',
  'dirty_git_worktree',
  'unknown_error',
]);

function internalErrorCode(error) {
  for (const candidate of [error?.code, error?.message]) {
    if (typeof candidate === 'string' && SAFE_ERROR_CODES.has(candidate)) {
      return candidate;
    }
  }
  return 'unknown_error';
}

export function autonomousResearchOneShotCampaignAttemptFailureOutcome(error, phase) {
  const verifiedCanaryFailure = phase === 'provider_started'
    ? verifiedCodexModelAvailabilityCanaryFailure(error) : null;
  const failureClass = NORMALIZED_FAILURE_CLASSES.has(
    verifiedCanaryFailure?.failureClass,
  ) ? verifiedCanaryFailure.failureClass : 'unknown';
  const suppliedDiagnosticHash = typeof verifiedCanaryFailure?.diagnosticHash === 'string'
    ? verifiedCanaryFailure.diagnosticHash : '';
  const diagnosticHash = SHA256.test(suppliedDiagnosticHash)
    ? suppliedDiagnosticHash
    : hashRecord('AutonomousResearchOneShotCampaignAttemptFailureDiagnostic', {
      version: 1,
      phase,
      failureClass,
      diagnosticSource: 'unclassified_failure',
    });
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptFailure',
    phase,
    errorCode: internalErrorCode(error),
    failureClass,
    diagnosticHash,
  });
}

export function autonomousResearchOneShotCampaignAttemptMonitorReport(inspection) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptCompositionReport',
    status: 'autonomous_research_one_shot_campaign_attempt_monitor_only',
    inspection,
    terminalReceipt: null,
  });
}

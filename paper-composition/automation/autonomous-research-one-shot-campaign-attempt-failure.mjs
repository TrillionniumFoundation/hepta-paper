import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifiedCodexModelAvailabilityCanaryFailure,
} from '../../paper-adapters/automation/codex-model-availability-canary-failure.mjs';

const NORMALIZED_FAILURE_CLASSES = new Set([
  'aborted', 'authentication', 'context', 'overloaded', 'quota',
  'rate_limited', 'unknown', 'unsupported_model',
]);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const FAILURE_STAGE_BY_PHASE = Object.freeze({
  attempt_reserved: 'preconditions',
  preconditions_verified: 'campaign_preparation',
  prepare_verified: 'provider_readiness',
  provider_started: 'provider_action',
  provider_completed: 'launch_readiness',
  launch_started: 'launch_action',
});
const PREFLIGHT_BLOCKER_POLICIES = Object.freeze({
  autonomous_research_one_shot_dataset_binding_mismatch: Object.freeze({
    failureClass: 'dataset_not_ready', failingStage: 'dataset_contract',
  }),
  autonomous_research_one_shot_dataset_contract_invalid: Object.freeze({
    failureClass: 'dataset_not_ready', failingStage: 'dataset_contract',
  }),
  autonomous_research_one_shot_dataset_manifest_invalid: Object.freeze({
    failureClass: 'dataset_not_ready', failingStage: 'dataset_manifest',
  }),
  autonomous_research_one_shot_dataset_mounts_invalid: Object.freeze({
    failureClass: 'dataset_not_ready', failingStage: 'dataset_input',
  }),
  autonomous_research_one_shot_dataset_source_unreadable: Object.freeze({
    failureClass: 'dataset_not_ready', failingStage: 'dataset_source',
  }),
  autonomous_research_one_shot_dataset_trust_invalid: Object.freeze({
    failureClass: 'dataset_not_ready', failingStage: 'dataset_trust',
  }),
  autonomous_research_one_shot_dataset_v4_envelope_invalid: Object.freeze({
    failureClass: 'dataset_not_ready', failingStage: 'dataset_envelope',
  }),
  autonomous_research_one_shot_execution_binding_invalid: Object.freeze({
    failureClass: 'preflight_not_ready', failingStage: 'execution_binding',
  }),
  autonomous_research_one_shot_native_store_not_ready: Object.freeze({
    failureClass: 'campaign_state_not_ready', failingStage: 'reviewed_target',
  }),
  autonomous_research_one_shot_attempt_journal_not_ready: Object.freeze({
    failureClass: 'campaign_state_not_ready', failingStage: 'reviewed_target',
  }),
  autonomous_research_one_shot_protected_campaign_fingerprint_invalid: Object.freeze({
    failureClass: 'campaign_state_not_ready', failingStage: 'reviewed_target',
  }),
  autonomous_research_one_shot_protected_campaign_missing: Object.freeze({
    failureClass: 'campaign_state_not_ready', failingStage: 'reviewed_target',
  }),
  autonomous_research_one_shot_provider_authentication_not_ready: Object.freeze({
    failureClass: 'provider_not_ready', failingStage: 'provider_runtime',
  }),
  autonomous_research_one_shot_provider_binary_not_ready: Object.freeze({
    failureClass: 'provider_not_ready', failingStage: 'provider_runtime',
  }),
  autonomous_research_one_shot_provider_configuration_invalid: Object.freeze({
    failureClass: 'provider_not_ready', failingStage: 'provider_configuration',
  }),
  autonomous_research_one_shot_provider_configuration_mismatch: Object.freeze({
    failureClass: 'provider_not_ready', failingStage: 'provider_configuration',
  }),
  autonomous_research_one_shot_provider_runtime_not_ready: Object.freeze({
    failureClass: 'provider_not_ready', failingStage: 'provider_runtime',
  }),
  autonomous_research_one_shot_provider_runtime_not_proven: Object.freeze({
    failureClass: 'provider_not_ready', failingStage: 'provider_runtime',
  }),
  autonomous_research_one_shot_reviewer_independence_not_proven: Object.freeze({
    failureClass: 'reviewer_not_ready', failingStage: 'reviewer_identity',
  }),
  'autonomous_research_one_shot_source_snapshot_blocked:dirty_git_worktree': Object.freeze({
    failureClass: 'source_not_clean', failingStage: 'source_provenance',
  }),
  autonomous_research_one_shot_source_provenance_invalid: Object.freeze({
    failureClass: 'source_not_clean', failingStage: 'source_provenance',
  }),
  autonomous_research_one_shot_source_snapshot_invalid: Object.freeze({
    failureClass: 'source_not_clean', failingStage: 'source_snapshot',
  }),
  autonomous_research_one_shot_target_campaign_already_exists: Object.freeze({
    failureClass: 'campaign_state_not_ready', failingStage: 'reviewed_target',
  }),
  autonomous_research_one_shot_target_campaign_attempt_already_recorded: Object.freeze({
    failureClass: 'campaign_state_not_ready', failingStage: 'reviewed_target',
  }),
});
const SAFE_ERROR_CODES = new Set([
  ...Object.keys(PREFLIGHT_BLOCKER_POLICIES),
  'autonomous_research_one_shot_execution_binding_changed:pre_launch',
  'autonomous_research_one_shot_execution_binding_changed:pre_provider',
  'autonomous_research_one_shot_prepare_not_launch_ready',
  'autonomous_research_one_shot_source_snapshot_blocked:dirty_git_worktree',
  'autonomous_research_provider_canary_attempt_failed',
  'autonomous_research_supervisor_author_canary_model_live_canary_failed',
  'autonomous_research_supervisor_provider_canary_failed',
  'autonomous_research_supervisor_reviewer_canary_model_live_canary_failed',
  'dirty_git_worktree',
  'unknown_error',
]);
const JOURNAL_FAILURE_CLASS_BY_ERROR_CODE = Object.freeze({
  'autonomous_research_one_shot_execution_binding_changed:pre_launch':
    'campaign_state_not_ready',
  'autonomous_research_one_shot_execution_binding_changed:pre_provider':
    'campaign_state_not_ready',
  autonomous_research_one_shot_prepare_not_launch_ready: 'campaign_not_ready',
  'autonomous_research_one_shot_source_snapshot_blocked:dirty_git_worktree':
    'source_not_clean',
});

function internalErrorCode(error) {
  for (const candidate of [error?.code, error?.message]) {
    if (typeof candidate === 'string' && SAFE_ERROR_CODES.has(candidate)) {
      return candidate;
    }
  }
  return 'unknown_error';
}

function fallbackDiagnosticHash({ failingStage, failureClass }) {
  return hashRecord('AutonomousResearchOneShotCampaignAttemptFailureDiagnostic', {
    version: 1,
    failingStage,
    failureClass,
    diagnosticSource: 'unclassified_failure',
  });
}

export function autonomousResearchOneShotCampaignPreflightBlocker(errorCode) {
  const policy = PREFLIGHT_BLOCKER_POLICIES[errorCode];
  if (!policy) {
    throw new Error('autonomous_research_one_shot_preflight_blocker_code_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignPreflightBlocker',
    errorCode,
    failureClass: policy.failureClass,
    failingStage: policy.failingStage,
    diagnosticHash: hashRecord('AutonomousResearchOneShotCampaignPreflightDiagnostic', {
      version: 1,
      errorCode,
      failureClass: policy.failureClass,
      failingStage: policy.failingStage,
    }),
  });
  return payload;
}

export function autonomousResearchOneShotCampaignAttemptFailureOutcome(error, phase) {
  const failingStage = FAILURE_STAGE_BY_PHASE[phase] || 'unknown';
  const errorCode = internalErrorCode(error);
  const verifiedCanaryFailure = phase === 'provider_started'
    ? verifiedCodexModelAvailabilityCanaryFailure(error) : null;
  const providerFailureClass = NORMALIZED_FAILURE_CLASSES.has(
    verifiedCanaryFailure?.failureClass,
  ) ? verifiedCanaryFailure.failureClass : 'unknown';
  const failureClass = providerFailureClass === 'unknown'
    ? JOURNAL_FAILURE_CLASS_BY_ERROR_CODE[errorCode] || 'unknown'
    : providerFailureClass;
  const suppliedDiagnosticHash = typeof verifiedCanaryFailure?.diagnosticHash === 'string'
    ? verifiedCanaryFailure.diagnosticHash : '';
  const diagnosticHash = SHA256.test(suppliedDiagnosticHash)
    ? suppliedDiagnosticHash
    : fallbackDiagnosticHash({ failingStage, failureClass });
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptFailure',
    errorCode,
    failureClass,
    failingStage,
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

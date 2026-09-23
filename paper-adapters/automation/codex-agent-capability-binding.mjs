import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectCodexRuntimeIdentity, preflightCodexRuntime } from './codex-runtime-preflight.mjs';
import {
  managedCapabilityReceiptValid,
  openClawManagedCapabilityIdentityMatches,
} from './codex-openclaw-managed-executor-capability.mjs';

function runtimeIdentityMatchesCapability(runtime, capability) {
  return runtime?.codexBinaryIdentityHash === capability?.codexBinaryIdentityHash
    && runtime?.credentialRootIdentityHash === capability?.credentialRootIdentityHash
    && runtime?.credentialConfigIdentityHash === capability?.credentialConfigIdentityHash
    && runtime?.codexVersion === capability?.codexVersion
    && runtime?.model === capability?.model
    && runtime?.modelSelectionSource === capability?.modelSelectionSource
    && runtime?.executionTransport === (capability?.executionTransport || 'codex_cli')
    && runtime?.authenticationAuthorityMode === (capability?.authenticationAuthorityMode || 'codex_home')
    && openClawManagedCapabilityIdentityMatches(runtime, capability);
}

function runtimeMatchesCapability(runtime, capability) {
  return runtimeIdentityMatchesCapability(runtime, capability)
    && runtime?.authenticationStatus === capability?.authenticationStatus;
}

function postflightFailureCode(error, capabilityPrefix) {
  const candidate = String(error?.code || error?.message || '').trim();
  return new RegExp(`^${capabilityPrefix}_[a-z0-9_]{1,160}$`).test(candidate)
    ? candidate
    : `${capabilityPrefix}_capability_runtime_postflight_unclassified`;
}

function postflightFailureRetryable(failureCode, capabilityPrefix) {
  return new Set([
    `${capabilityPrefix}_version_unverified`,
    `${capabilityPrefix}_openclaw_managed_runtime_required`,
  ]).has(failureCode);
}

function validateCapabilityReceipts({
  formalReviewerCapabilityReceipt,
  researchAuthorCapabilityReceipt,
  codexHome,
  resolvedModel,
  principalId,
}) {
  if (formalReviewerCapabilityReceipt) {
    const {
      codexFormalReviewerCapabilityReceiptHash,
      ...capabilityPayload
    } = formalReviewerCapabilityReceipt;
    if (formalReviewerCapabilityReceipt?.status !== 'codex_formal_reviewer_capability_ready'
      || hashRecord('CodexFormalReviewerCapabilityReceipt', capabilityPayload)
        !== codexFormalReviewerCapabilityReceiptHash
      || !formalReviewerCapabilityReceipt?.credentialConfigIdentityHash
      || !formalReviewerCapabilityReceipt?.codexBinaryIdentityHash
      || formalReviewerCapabilityReceipt?.model !== resolvedModel
      || formalReviewerCapabilityReceipt?.authenticationStatus !== 'codex_authentication_verified'
      || formalReviewerCapabilityReceipt?.modelOptionVerified !== true
      || formalReviewerCapabilityReceipt?.selectedModelExecutionCanaryVerified !== false
      || formalReviewerCapabilityReceipt?.readOnlyReviewRequired !== true
      || formalReviewerCapabilityReceipt?.dynamicAttemptWorkspaceRequired !== true
      || formalReviewerCapabilityReceipt?.providerCredentialSharingPermitted !== true
      || formalReviewerCapabilityReceipt?.freshEphemeralSessionRequired !== true
      || formalReviewerCapabilityReceipt?.authorContextInheritanceForbidden !== true
      || formalReviewerCapabilityReceipt?.frozenArtifactReviewRequired !== true
      || formalReviewerCapabilityReceipt?.reviewerMustDifferFromAuthorPrincipal !== true
      || formalReviewerCapabilityReceipt?.assuranceScope
        !== 'ephemeral_session_frozen_artifact_and_role_separation'
      || formalReviewerCapabilityReceipt?.providerAccountIndependenceVerified !== false
      || !managedCapabilityReceiptValid(formalReviewerCapabilityReceipt, 'formal-reviewer')
      || !codexHome || !resolvedModel || !principalId) {
      throw new Error('codex_formal_reviewer_capability_receipt_invalid');
    }
  }
  if (formalReviewerCapabilityReceipt && researchAuthorCapabilityReceipt) {
    throw new Error('codex_agent_capability_role_ambiguous');
  }
  if (researchAuthorCapabilityReceipt) {
    const {
      codexResearchAuthorCapabilityReceiptHash,
      ...capabilityPayload
    } = researchAuthorCapabilityReceipt;
    if (researchAuthorCapabilityReceipt.status !== 'codex_research_author_capability_ready'
      || hashRecord('CodexResearchAuthorCapabilityReceipt', capabilityPayload)
        !== codexResearchAuthorCapabilityReceiptHash
      || !researchAuthorCapabilityReceipt.credentialConfigIdentityHash
      || !researchAuthorCapabilityReceipt.codexBinaryIdentityHash
      || researchAuthorCapabilityReceipt.model !== resolvedModel
      || researchAuthorCapabilityReceipt.assuranceScope !== 'filesystem_credential_root_runtime_and_model_selection_preflight'
      || researchAuthorCapabilityReceipt.providerAccountIdentityAttested !== false
      || researchAuthorCapabilityReceipt.authenticationStatus !== 'codex_authentication_verified'
      || researchAuthorCapabilityReceipt.selectedModelExecutionCanaryVerified !== false
      || researchAuthorCapabilityReceipt.workspaceWriteRequired !== true
      || researchAuthorCapabilityReceipt.dynamicAttemptWorkspaceRequired !== true
      || researchAuthorCapabilityReceipt.freshEphemeralSessionRequired !== true
      || researchAuthorCapabilityReceipt.priorAgentContextInheritanceForbidden !== true
      || !managedCapabilityReceiptValid(researchAuthorCapabilityReceipt, 'research-author')
      || !codexHome || !resolvedModel || !principalId) {
      throw new Error('codex_research_author_capability_receipt_invalid');
    }
  }
}

export function createCodexAgentCapabilityBinding({
  formalReviewerCapabilityReceipt = null,
  researchAuthorCapabilityReceipt = null,
  codexHome = null,
  resolvedModel = null,
  principalId = null,
} = {}) {
  const capabilityReceipt = formalReviewerCapabilityReceipt
    || researchAuthorCapabilityReceipt;
  const capabilityPrefix = formalReviewerCapabilityReceipt
    ? 'formal_review_codex' : 'research_author_codex';
  validateCapabilityReceipts({
    formalReviewerCapabilityReceipt,
    researchAuthorCapabilityReceipt,
    codexHome,
    resolvedModel,
    principalId,
  });
  return Object.freeze({
    capabilityPrefix,
    preflight({ codexBinary, model, spawnSyncImpl }) {
      if (!capabilityReceipt) return codexBinary;
      const runtime = preflightCodexRuntime({
        codexBinary,
        codexHome,
        model,
        errorPrefix: capabilityPrefix,
        spawnSyncImpl,
      });
      if (!runtimeMatchesCapability(runtime, capabilityReceipt)) {
        const error = new Error(`${capabilityPrefix}_capability_runtime_identity_changed`);
        error.retryable = false;
        throw error;
      }
      return runtime.codexBinary;
    },
    inspectPostflight({ codexBinary, model, spawnSyncImpl }) {
      if (!capabilityReceipt) {
        return Object.freeze({ failure: null, blocker: null });
      }
      try {
        const runtime = inspectCodexRuntimeIdentity({
          codexBinary,
          codexHome,
          model,
          errorPrefix: capabilityPrefix,
          spawnSyncImpl,
        });
        if (runtimeIdentityMatchesCapability(runtime, capabilityReceipt)) {
          return Object.freeze({ failure: null, blocker: null });
        }
        const failureCode = `${capabilityPrefix}_capability_runtime_identity_changed_during_execution`;
        const failure = Object.freeze({
          phase: 'identity_only',
          failureCode,
          disposition: 'permanent',
          outcomeHash: hashRecord('CodexCapabilityRuntimePostflightOutcome', {
            phase: 'identity_only',
            failureCode,
            disposition: 'permanent',
          }),
        });
        return Object.freeze({ failure, blocker: failureCode });
      } catch (error) {
        const failureCode = postflightFailureCode(error, capabilityPrefix);
        const retryable = postflightFailureRetryable(failureCode, capabilityPrefix);
        const failure = Object.freeze({
          phase: 'identity_only',
          failureCode,
          disposition: retryable ? 'retryable' : 'permanent',
          outcomeHash: hashRecord('CodexCapabilityRuntimePostflightOutcome', {
            phase: 'identity_only',
            failureCode,
            disposition: retryable ? 'retryable' : 'permanent',
          }),
        });
        return Object.freeze({
          failure,
          blocker: `${capabilityPrefix}_capability_runtime_postflight_failed`,
        });
      }
    },
  });
}

import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  inspectCodexCredentialRootIdentity,
  preflightCodexRuntime,
} from './codex-runtime-preflight.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
function fail(code) {
  const error = new Error(code);
  error.retryable = false;
  throw error;
}

/**
 * Synchronous, read-only production preflight for the independent Codex formal reviewer.
 * It deliberately never opens auth.json, credentials.json, tokens, cookies or key files.
 * Known credential-file metadata is identity-bound without reading secret content.
 * Authentication is delegated to `codex login status`; command output is evaluated in
 * memory and is neither returned nor included in the receipt.
 */
export function preflightCodexFormalReviewer({
  codexBinary = 'codex',
  codexHome,
  model,
  authorProvider = null,
  authorCodexHome = null,
  spawnSyncImpl = spawnSync,
  environment = process.env,
} = {}) {
  const runtime = preflightCodexRuntime({
    codexBinary,
    codexHome,
    model,
    errorPrefix: 'formal_review_codex',
    spawnSyncImpl,
    environment,
  });
  const reviewerCredentialRootIdentityHash = runtime.credentialRootIdentityHash;
  const authorCredentialRootIdentityHash = authorProvider === 'codex'
    ? inspectCodexCredentialRootIdentity({
      codexHome: authorCodexHome,
      errorPrefix: 'formal_review_codex_author',
    }).credentialRootIdentityHash
    : null;
  const capabilityPayload = {
    version: 1,
    kind: 'CodexFormalReviewerCapabilityReceipt',
    status: 'codex_formal_reviewer_capability_ready',
    provider: 'openai',
    model: runtime.model,
    modelSelectionSource: runtime.modelSelectionSource,
    codexVersion: runtime.codexVersion,
    codexBinaryIdentityHash: runtime.codexBinaryIdentityHash,
    credentialRootIdentityHash: reviewerCredentialRootIdentityHash,
    credentialConfigIdentityHash: runtime.credentialConfigIdentityHash,
    authorProvider: authorProvider || null,
    authorCredentialRootIdentityHash,
    credentialIndependenceVerified: authorProvider === 'codex'
      ? authorCredentialRootIdentityHash !== reviewerCredentialRootIdentityHash
      : true,
    providerCredentialSharingPermitted: true,
    freshEphemeralSessionRequired: true,
    authorContextInheritanceForbidden: true,
    frozenArtifactReviewRequired: true,
    reviewerMustDifferFromAuthorPrincipal: true,
    assuranceScope: 'ephemeral_session_frozen_artifact_and_role_separation',
    providerAccountIndependenceVerified: false,
    authenticationStatus: runtime.authenticationStatus,
    modelOptionVerified: runtime.modelOptionVerified,
    executionTransport: runtime.executionTransport,
    authenticationAuthorityMode: runtime.authenticationAuthorityMode,
    managedRuntimeEvidenceRequired: runtime.managedRuntimeEvidenceRequired,
    openClawManagedConfigurationHash:
      runtime.openClawManagedConfigurationHash,
    openClawManagedRuntimeProvenanceHash:
      runtime.openClawManagedRuntimeProvenanceHash,
    openClawManagedAuthProfileIdentityHash:
      runtime.openClawManagedAuthProfileIdentityHash,
    openClawManagedAuthSourceIdentityHash:
      runtime.openClawManagedAuthSourceIdentityHash,
    openClawManagedAgentId: runtime.openClawManagedAgentId,
    openClawManagedPrincipalRole: runtime.openClawManagedPrincipalRole,
    openClawManagedMaximumContextBytes:
      runtime.openClawManagedMaximumContextBytes,
    openClawManagedMaximumFileCount:
      runtime.openClawManagedMaximumFileCount,
    selectedModelExecutionCanaryVerified: false,
    readOnlyReviewRequired: true,
    dynamicAttemptWorkspaceRequired: true,
  };
  const capabilityReceipt = Object.freeze({
    ...capabilityPayload,
    codexFormalReviewerCapabilityReceiptHash: hashRecord('CodexFormalReviewerCapabilityReceipt', capabilityPayload),
  });
  if (!SHA256.test(capabilityReceipt.codexFormalReviewerCapabilityReceiptHash)) {
    fail('formal_review_codex_capability_receipt_invalid');
  }
  return Object.freeze({
    codexBinary: runtime.codexBinary,
    codexHome: runtime.codexHome,
    effectivePrincipalId: `codex-formal-reviewer:${hashRecord('CodexFormalReviewerPrincipal', {
      credentialConfigIdentityHash: runtime.credentialConfigIdentityHash,
    }).slice(7, 39)}`,
    capabilityReceipt,
  });
}

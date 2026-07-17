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
  let authorCredentialRootIdentityHash = null;
  if (authorProvider === 'codex') {
    const authorRoot = inspectCodexCredentialRootIdentity({
      codexHome: authorCodexHome,
      errorPrefix: 'formal_review_codex_author',
    });
    authorCredentialRootIdentityHash = authorRoot.credentialRootIdentityHash;
    if (authorRoot.codexHome === runtime.codexHome
      || authorCredentialRootIdentityHash === reviewerCredentialRootIdentityHash) {
      fail('formal_review_codex_credential_root_must_be_distinct');
    }
  }
  const capabilityPayload = {
    version: 1,
    kind: 'CodexFormalReviewerCapabilityReceipt',
    status: 'codex_formal_reviewer_capability_ready',
    provider: 'openai',
    model: runtime.model,
    codexVersion: runtime.codexVersion,
    codexBinaryIdentityHash: runtime.codexBinaryIdentityHash,
    credentialRootIdentityHash: reviewerCredentialRootIdentityHash,
    credentialConfigIdentityHash: runtime.credentialConfigIdentityHash,
    authorProvider: authorProvider || null,
    authorCredentialRootIdentityHash,
    credentialIndependenceVerified: authorProvider === 'codex'
      ? authorCredentialRootIdentityHash !== reviewerCredentialRootIdentityHash
      : true,
    assuranceScope: authorProvider === 'codex'
      ? 'filesystem_credential_root_and_principal_separation'
      : 'configured_principal_and_process_separation',
    providerAccountIndependenceVerified: false,
    authenticationStatus: runtime.authenticationStatus,
    modelOptionVerified: runtime.modelOptionVerified,
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

import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { preflightCodexRuntime } from './codex-runtime-preflight.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;

export function preflightCodexResearchAuthor({
  codexBinary = 'codex',
  codexHome,
  model,
  spawnSyncImpl = spawnSync,
  environment = process.env,
} = {}) {
  const runtime = preflightCodexRuntime({
    codexBinary,
    codexHome,
    model,
    errorPrefix: 'research_author_codex',
    spawnSyncImpl,
    environment,
  });
  const payload = {
    version: 1,
    kind: 'CodexResearchAuthorCapabilityReceipt',
    status: 'codex_research_author_capability_ready',
    provider: 'openai',
    model: runtime.model,
    codexVersion: runtime.codexVersion,
    codexBinaryIdentityHash: runtime.codexBinaryIdentityHash,
    credentialRootIdentityHash: runtime.credentialRootIdentityHash,
    credentialConfigIdentityHash: runtime.credentialConfigIdentityHash,
    authenticationStatus: runtime.authenticationStatus,
    modelOptionVerified: runtime.modelOptionVerified,
    selectedModelExecutionCanaryVerified: false,
    workspaceWriteRequired: true,
    dynamicAttemptWorkspaceRequired: true,
    freshEphemeralSessionRequired: true,
    priorAgentContextInheritanceForbidden: true,
    assuranceScope: 'filesystem_credential_root_runtime_and_model_selection_preflight',
    providerAccountIdentityAttested: false,
    externalActionPerformed: false,
  };
  const capabilityReceipt = Object.freeze({
    ...payload,
    codexResearchAuthorCapabilityReceiptHash: hashRecord('CodexResearchAuthorCapabilityReceipt', payload),
  });
  if (!SHA256.test(capabilityReceipt.codexResearchAuthorCapabilityReceiptHash)) {
    throw new Error('research_author_codex_capability_receipt_invalid');
  }
  return Object.freeze({
    codexBinary: runtime.codexBinary,
    codexHome: runtime.codexHome,
    effectivePrincipalId: `codex-research-author:${hashRecord('CodexResearchAuthorPrincipal', {
      credentialConfigIdentityHash: runtime.credentialConfigIdentityHash,
    }).slice(7, 39)}`,
    capabilityReceipt,
  });
}

import path from 'node:path';
import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import { preflightCodexFormalReviewer } from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
import { createIsolatedAgentExecutor } from '../../paper-adapters/automation/isolated-agent-executor.mjs';

export function bootstrapFormalReviewAgentExecutor({
  authorAgentId,
  provider = process.env.HEPTA_FORMAL_REVIEW_PROVIDER || 'codex',
  reviewerAgentId = process.env.HEPTA_OPENCLAW_FORMAL_REVIEW_AGENT || null,
  reviewerCapabilityProfilePath = process.env.HEPTA_OPENCLAW_FORMAL_REVIEW_AGENT_CAPABILITY_PROFILE || null,
  expectedReviewerCapabilityProfileHash = process.env.HEPTA_OPENCLAW_FORMAL_REVIEW_AGENT_CAPABILITY_PROFILE_HASH || null,
  model = process.env.HEPTA_FORMAL_REVIEW_MODEL || null,
  codexBinary = process.env.HEPTA_FORMAL_REVIEW_CODEX_BINARY || 'codex',
  codexHome = process.env.HEPTA_FORMAL_REVIEW_CODEX_HOME || null,
  authorProvider = null,
  authorCodexHome = null,
  runtimeRoot,
  workspaceRegistry,
  createCodexExecutor = createCodexAgentExecutor,
  createIsolatedExecutor = createIsolatedAgentExecutor,
  preflightCodexReviewer = preflightCodexFormalReviewer,
  spawnSyncImpl = undefined,
  environment = undefined,
} = {}) {
  if (!authorAgentId) throw new Error('formal_review_author_principal_required');
  if (!['codex', 'openclaw'].includes(provider)) throw new Error(`formal_review_provider_unsupported:${provider}`);
  if (provider === 'openclaw' && (!reviewerAgentId || reviewerAgentId === authorAgentId)) {
    throw new Error('formal_review_agent_principal_must_be_distinct');
  }
  if (!runtimeRoot) throw new Error('formal_review_agent_runtime_root_required');
  if (provider === 'openclaw') {
    if (!reviewerCapabilityProfilePath || !expectedReviewerCapabilityProfileHash) {
      throw new Error('formal_review_agent_capability_profile_required');
    }
    // Campaign nodes always execute from a newly materialized attempt tree.
    // OpenClaw deliberately requires an exact, statically configured workspace,
    // so it cannot preserve that per-attempt boundary. Never weaken either side.
    throw new Error('formal_review_openclaw_static_workspace_incompatible_with_attempt_isolation');
  }
  const preflight = preflightCodexReviewer({
    codexBinary,
    codexHome,
    model,
    authorProvider,
    authorCodexHome,
    ...(environment ? { environment } : {}),
    ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
  });
  const effectiveReviewerPrincipal = preflight.effectivePrincipalId;
  if (!effectiveReviewerPrincipal || effectiveReviewerPrincipal === authorAgentId) {
    throw new Error('formal_review_agent_principal_must_be_distinct');
  }
  const delegate = createCodexExecutor({
    codexBinary: preflight.codexBinary || codexBinary,
    codexHome: preflight.codexHome,
    model,
    principalId: effectiveReviewerPrincipal,
    formalReviewerCapabilityReceipt: preflight.capabilityReceipt,
  });
  return createIsolatedExecutor({
    delegate,
    isolationRoot: path.join(runtimeRoot, 'automation-formal-review-workspaces'),
    keepWorkspaces: false,
    keepFailedWorkspaces: true,
    workspaceRegistry,
  });
}

import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { restrictedChildEnvironment, runBoundedChildProcess } from './bounded-child-process.mjs';
import { createAgentExecutorTemplate, isExternalAgentCancellation } from './agent-executor-template.mjs';
import { readOnlyMutationBlockers } from './workspace-change-tracker.mjs';
import { preflightCodexRuntime } from './codex-runtime-preflight.mjs';

function parseStructuredOutput(text) {
  const source = String(text || '').trim();
  if (!source) return null;
  try { return JSON.parse(source); } catch { /* diagnostics may precede JSON */ }
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    try { return JSON.parse(lines.slice(index).join('\n')); } catch { /* keep scanning */ }
  }
  return null;
}

function codexRuntimeMatchesCapability(runtime, capability) {
  return runtime?.codexBinaryIdentityHash === capability?.codexBinaryIdentityHash
    && runtime?.credentialRootIdentityHash === capability?.credentialRootIdentityHash
    && runtime?.credentialConfigIdentityHash === capability?.credentialConfigIdentityHash
    && runtime?.codexVersion === capability?.codexVersion
    && runtime?.authenticationStatus === capability?.authenticationStatus
    && runtime?.model === capability?.model;
}

export function createCodexAgentExecutor({
  codexBinary = 'codex',
  codexHome = null,
  model = null,
  principalId = null,
  formalReviewerCapabilityReceipt = null,
  researchAuthorCapabilityReceipt = null,
  oss = false,
  localProvider = 'ollama',
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  if (principalId !== null && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(String(principalId))) {
    throw new Error('codex_agent_principal_id_invalid');
  }
  const executorId = principalId
    ? `codex-agent-executor-v1:${principalId}`
    : 'codex-agent-executor-v1';
  if (formalReviewerCapabilityReceipt) {
    const { codexFormalReviewerCapabilityReceiptHash, ...capabilityPayload } = formalReviewerCapabilityReceipt;
    if (formalReviewerCapabilityReceipt?.status !== 'codex_formal_reviewer_capability_ready'
      || hashRecord('CodexFormalReviewerCapabilityReceipt', capabilityPayload)
        !== codexFormalReviewerCapabilityReceiptHash
      || !formalReviewerCapabilityReceipt?.credentialConfigIdentityHash
      || !formalReviewerCapabilityReceipt?.codexBinaryIdentityHash
      || formalReviewerCapabilityReceipt?.model !== model
      || formalReviewerCapabilityReceipt?.authenticationStatus !== 'codex_authentication_verified'
      || formalReviewerCapabilityReceipt?.modelOptionVerified !== true
      || formalReviewerCapabilityReceipt?.selectedModelExecutionCanaryVerified !== false
      || formalReviewerCapabilityReceipt?.readOnlyReviewRequired !== true
      || formalReviewerCapabilityReceipt?.dynamicAttemptWorkspaceRequired !== true
      || formalReviewerCapabilityReceipt?.credentialIndependenceVerified !== true
      || !['filesystem_credential_root_and_principal_separation', 'configured_principal_and_process_separation']
        .includes(formalReviewerCapabilityReceipt?.assuranceScope)
      || formalReviewerCapabilityReceipt?.providerAccountIndependenceVerified !== false
      || !codexHome || !model || !principalId) {
      throw new Error('codex_formal_reviewer_capability_receipt_invalid');
    }
  }
  if (formalReviewerCapabilityReceipt && researchAuthorCapabilityReceipt) {
    throw new Error('codex_agent_capability_role_ambiguous');
  }
  if (researchAuthorCapabilityReceipt) {
    const { codexResearchAuthorCapabilityReceiptHash, ...capabilityPayload } = researchAuthorCapabilityReceipt;
    if (researchAuthorCapabilityReceipt.status !== 'codex_research_author_capability_ready'
      || hashRecord('CodexResearchAuthorCapabilityReceipt', capabilityPayload)
        !== codexResearchAuthorCapabilityReceiptHash
      || !researchAuthorCapabilityReceipt.credentialConfigIdentityHash
      || !researchAuthorCapabilityReceipt.codexBinaryIdentityHash
      || researchAuthorCapabilityReceipt.model !== model
      || researchAuthorCapabilityReceipt.assuranceScope !== 'filesystem_credential_root_runtime_and_model_selection_preflight'
      || researchAuthorCapabilityReceipt.providerAccountIdentityAttested !== false
      || researchAuthorCapabilityReceipt.authenticationStatus !== 'codex_authentication_verified'
      || researchAuthorCapabilityReceipt.selectedModelExecutionCanaryVerified !== false
      || researchAuthorCapabilityReceipt.workspaceWriteRequired !== true
      || researchAuthorCapabilityReceipt.dynamicAttemptWorkspaceRequired !== true
      || !codexHome || !model || !principalId) {
      throw new Error('codex_research_author_capability_receipt_invalid');
    }
  }
  return createAgentExecutorTemplate({
    kind: 'CodexAgentExecutor',
    executorId,
    capabilityDefinition: {
      networkPolicy: oss ? 'local-provider-only' : 'sandbox-restricted',
      maximumTimeoutMs: timeoutMs,
      maximumOutputTokens: null,
      provider: oss ? `local:${localProvider}` : 'openai',
    },
    workspaceValidationMessage: 'agent role, existing workspacePath and instructions are required',
    sandboxValidationMessage: 'agent sandbox must be read-only or workspace-write',
    captureWorkspaceManifest: true,
    async executeStrategy({
      role,
      instructions,
      context,
      requiredChecks,
      sandbox,
      outputTokenBudget,
      requestedTimeout,
      signal,
      workspaceMutationPolicy,
      workspace,
      promptHash,
      changedWorkspacePaths,
    }) {
      let verifiedCodexBinary = codexBinary;
      const capabilityReceipt = formalReviewerCapabilityReceipt || researchAuthorCapabilityReceipt;
      const capabilityPrefix = formalReviewerCapabilityReceipt
        ? 'formal_review_codex' : 'research_author_codex';
      if (capabilityReceipt) {
        const freshRuntime = preflightCodexRuntime({
          codexBinary,
          codexHome,
          model,
          errorPrefix: capabilityPrefix,
          spawnSyncImpl,
        });
        if (!codexRuntimeMatchesCapability(freshRuntime, capabilityReceipt)) {
          const error = new Error(`${capabilityPrefix}_capability_runtime_identity_changed`);
          error.retryable = false;
          throw error;
        }
        verifiedCodexBinary = freshRuntime.codexBinary;
      }
      const prompt = [
        `You are the ${role} for an automated paper campaign.`,
        principalId ? `Your runtime principal is ${principalId}. Do not impersonate another campaign principal.` : '',
        'Work only inside the provided workspace. Do not submit externally, send messages, or access credentials.',
        String(instructions),
        workspaceMutationPolicy
          ? `The runtime enforces this exact workspace mutation policy: ${JSON.stringify(workspaceMutationPolicy)}`
          : '',
        `Structured context: ${JSON.stringify(context)}`,
        requiredChecks.length ? `Before finishing run these checks when applicable: ${requiredChecks.join(' ; ')}` : '',
        outputTokenBudget ? `Keep the final response within ${Math.max(128, Number(outputTokenBudget))} output tokens. Prefer editing files with tools over returning file bodies.` : '',
        'Finish with one compact JSON object containing status, summary, checksRun, and blockers. Include every role-specific JSON field explicitly requested by the task in that same object.',
      ].filter(Boolean).join('\n\n');
      const promptDigest = promptHash(prompt);
      const sessionId = `codex-exec:${crypto.randomUUID()}`;
      const args = ['exec'];
      if (oss) args.push('--oss', '--local-provider', localProvider);
      if (model) args.push('--model', model);
      args.push('--ephemeral', '--color', 'never', '--sandbox', sandbox, '--skip-git-repo-check', '--cd', workspace, '-');
      const startedAt = new Date().toISOString();
      const processResult = await runBoundedChildProcess({
        spawnImpl,
        executable: verifiedCodexBinary,
        args,
        cwd: workspace,
        env: restrictedChildEnvironment({
          allowedKeys: ['CODEX_HOME', 'OLLAMA_HOST'],
          overrides: {
            HEPTA_AUTOMATION_ROLE: role,
            ...(codexHome ? { CODEX_HOME: codexHome } : {}),
          },
        }),
        stdin: prompt,
        timeoutMs: Math.min(Number(requestedTimeout || timeoutMs), timeoutMs),
        signal,
      });
      const completedAt = new Date().toISOString();
      const changes = changedWorkspacePaths();
      const blockers = [];
      const cancelled = isExternalAgentCancellation(processResult);
      if (processResult.timedOut) blockers.push('codex_agent_timeout');
      if (cancelled) blockers.push('codex_agent_cancelled');
      if (!cancelled && (processResult.exitCode !== 0 || processResult.error)) blockers.push('codex_agent_process_failed');
      if (processResult.outputTruncated) blockers.push('codex_agent_output_truncated');
      blockers.push(...readOnlyMutationBlockers({ sandbox, changedPaths: changes }));
      if (capabilityReceipt) {
        try {
          const postflightRuntime = preflightCodexRuntime({
            codexBinary,
            codexHome,
            model,
            errorPrefix: capabilityPrefix,
            spawnSyncImpl,
          });
          if (!codexRuntimeMatchesCapability(postflightRuntime, capabilityReceipt)) {
            blockers.push(
              `${capabilityPrefix}_capability_runtime_identity_changed_during_execution`,
            );
          }
        } catch {
          blockers.push(`${capabilityPrefix}_capability_runtime_postflight_failed`);
        }
      }
      const structuredOutput = processResult.outputTruncated
        ? null
        : parseStructuredOutput(processResult.stdout);
      const payload = {
        providerMode: oss ? `local:${localProvider}` : 'openai',
        agentId: principalId,
        model,
        resolvedModel: model,
        promptHash: promptDigest,
        sessionId,
        childSessionId: sessionId,
        maximumOutputTokens: outputTokenBudget ? Math.max(128, Number(outputTokenBudget)) : null,
        role,
        status: blockers.length ? 'agent_execution_failed' : 'agent_execution_completed',
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        changedPaths: changes,
        blockers,
        stdoutHash: processResult.stdoutHash,
        stderrHash: processResult.stderrHash,
        outputTruncated: processResult.outputTruncated,
        finalOutput: processResult.stdout.slice(-12000),
        structuredOutput,
        stderrTail: processResult.stderr.slice(-12000),
        error: processResult.error?.message || null,
        startedAt,
        completedAt,
        externalActionPerformed: false,
        externalActionVerification: 'codex_sandbox_policy',
        ...(formalReviewerCapabilityReceipt ? {
          codexFormalReviewerCapabilityReceiptHash: formalReviewerCapabilityReceipt.codexFormalReviewerCapabilityReceiptHash,
          codexCredentialRootIdentityHash: formalReviewerCapabilityReceipt.credentialRootIdentityHash,
          codexCredentialConfigIdentityHash: formalReviewerCapabilityReceipt.credentialConfigIdentityHash,
          codexAuthorCredentialRootIdentityHash: formalReviewerCapabilityReceipt.authorCredentialRootIdentityHash,
          codexCredentialIndependenceVerified: formalReviewerCapabilityReceipt.credentialIndependenceVerified,
          codexReviewerAssuranceScope: formalReviewerCapabilityReceipt.assuranceScope,
          codexProviderAccountIndependenceVerified: false,
          codexBinaryIdentityHash: formalReviewerCapabilityReceipt.codexBinaryIdentityHash,
          codexVersion: formalReviewerCapabilityReceipt.codexVersion,
          codexAuthenticationStatus: formalReviewerCapabilityReceipt.authenticationStatus,
        } : {}),
        ...(researchAuthorCapabilityReceipt ? {
          codexResearchAuthorCapabilityReceiptHash: researchAuthorCapabilityReceipt.codexResearchAuthorCapabilityReceiptHash,
          codexResearchAuthorAssuranceScope: researchAuthorCapabilityReceipt.assuranceScope,
          codexResearchAuthorProviderAccountIdentityAttested: researchAuthorCapabilityReceipt.providerAccountIdentityAttested,
          codexCredentialRootIdentityHash: researchAuthorCapabilityReceipt.credentialRootIdentityHash,
          codexCredentialConfigIdentityHash: researchAuthorCapabilityReceipt.credentialConfigIdentityHash,
          codexBinaryIdentityHash: researchAuthorCapabilityReceipt.codexBinaryIdentityHash,
          codexVersion: researchAuthorCapabilityReceipt.codexVersion,
          codexAuthenticationStatus: researchAuthorCapabilityReceipt.authenticationStatus,
        } : {}),
      };
      return {
        payload,
        failureMessage: blockers.join(',') || payload.error || `agent exited ${payload.exitCode}`,
        retryable: !cancelled && !blockers.includes('read_only_agent_modified_workspace')
          && !blockers.some((blocker) => (
            blocker === `${capabilityPrefix}_capability_runtime_identity_changed_during_execution`
            || blocker === `${capabilityPrefix}_capability_runtime_postflight_failed`
          )),
      };
    },
  });
}

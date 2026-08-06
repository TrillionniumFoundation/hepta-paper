import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { restrictedChildEnvironment, runBoundedChildProcess } from './bounded-child-process.mjs';
import { createAgentExecutorTemplate, isExternalAgentCancellation } from './agent-executor-template.mjs';
import { readOnlyMutationBlockers } from './workspace-change-tracker.mjs';
import { createCodexAgentCapabilityBinding } from './codex-agent-capability-binding.mjs';
import { inspectManagedRuntimeFailure, managedRuntimeFailureRetryable } from './codex-openclaw-managed-failure-protocol.mjs';
import {
  managedFailureExecutorBindingForWorkspace,
  openClawManagedRuntimeExpected,
} from './codex-openclaw-managed-executor-capability.mjs';
import {
  buildOpenClawManagedExecutionMetadata,
  OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD,
  verifyOpenClawManagedExecutionEvidence,
} from './codex-openclaw-managed-runtime.mjs';
import {
  GATEWAY_CLEANUP_WINDOW_MS,
} from './codex-openclaw-managed-gateway-reconciliation.mjs';
const MANAGED_RUNTIME_MAXIMUM_CLEANUP_RESERVE_MS = 300_000;
const MANAGED_RUNTIME_MINIMUM_MODEL_WINDOW_MS = 1_250;
export function managedRuntimeTimeoutBudget(effectiveTimeoutMs) {
  const selectedTimeoutMs = Number(effectiveTimeoutMs);
  if (!Number.isSafeInteger(selectedTimeoutMs)
    || selectedTimeoutMs < (
      GATEWAY_CLEANUP_WINDOW_MS + MANAGED_RUNTIME_MINIMUM_MODEL_WINDOW_MS
    )) {
    throw new Error('codex_agent_managed_timeout_budget_invalid');
  }
  const cleanupReserveMs = Math.max(
    GATEWAY_CLEANUP_WINDOW_MS,
    Math.min(
      MANAGED_RUNTIME_MAXIMUM_CLEANUP_RESERVE_MS,
      Math.floor(selectedTimeoutMs / 4),
    ),
  );
  return Object.freeze({
    cleanupReserveMs,
    innerTimeoutMs: selectedTimeoutMs - cleanupReserveMs,
  });
}
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
function parseStrictStructuredOutput(text) {
  const source = String(text || '').trim();
  if (!source) return null;
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed : null;
  } catch { return null; }
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
  const capabilityReceipt = formalReviewerCapabilityReceipt || researchAuthorCapabilityReceipt;
  const resolvedModel = capabilityReceipt?.model || model || null;
  if (principalId !== null && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(String(principalId))) {
    throw new Error('codex_agent_principal_id_invalid');
  }
  const executorId = principalId
    ? `codex-agent-executor-v1:${principalId}`
    : 'codex-agent-executor-v1';
  const capabilityBinding = createCodexAgentCapabilityBinding({
    formalReviewerCapabilityReceipt,
    researchAuthorCapabilityReceipt,
    codexHome,
    resolvedModel,
    principalId,
  });
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
      const { capabilityPrefix } = capabilityBinding;
      const verifiedCodexBinary = capabilityBinding.preflight({
        codexBinary,
        model,
        spawnSyncImpl,
      });
      const managedRuntimeExpected = openClawManagedRuntimeExpected(capabilityReceipt);
      const managedGatewayRuntime = managedRuntimeExpected
        && capabilityReceipt?.openClawManagedAuthBindingMode
          === 'current-agent-gateway-oauth-route';
      const prompt = [
        managedRuntimeExpected
          ? buildOpenClawManagedExecutionMetadata({
            role,
            sandbox,
            workspaceMutationPolicy,
          }) : '',
        `You are the ${role} for an automated paper campaign.`,
        principalId ? `Your runtime principal is ${principalId}. Do not impersonate another campaign principal.` : '',
        'Work only inside the provided workspace. Do not submit externally, send messages, or access credentials.',
        String(instructions),
        workspaceMutationPolicy
          ? `The runtime enforces this exact workspace mutation policy: ${JSON.stringify(workspaceMutationPolicy)}`
          : '',
        `Structured context: ${JSON.stringify(context)}`,
        requiredChecks.length ? `Before finishing run these checks when applicable: ${requiredChecks.join(' ; ')}` : '',
        outputTokenBudget
          ? managedRuntimeExpected
            ? `Keep the final response within ${Math.max(128, Number(outputTokenBudget))} output tokens. This managed transport is tool-free: do not call tools. ${sandbox === 'workspace-write'
              ? 'Return complete replacement file bodies through the required top-level edits array.'
              : 'Return the required structured JSON directly.'}`
            : `Keep the final response within ${Math.max(128, Number(outputTokenBudget))} output tokens. Prefer editing files with tools over returning file bodies.`
          : '',
        'Finish with one compact JSON object containing status, summary, checksRun, and blockers. Include every role-specific JSON field explicitly requested by the task in that same object.',
      ].filter(Boolean).join('\n\n');
      const promptDigest = promptHash(prompt);
      const localSessionId = `codex-exec:${crypto.randomUUID()}`;
      const failureExecutorBinding = managedRuntimeExpected
        ? managedFailureExecutorBindingForWorkspace({
          capabilityReceipt,
          executionInvocationId: localSessionId,
          executionRole: role,
          principalId,
          principalRole: formalReviewerCapabilityReceipt
            ? 'formal-reviewer' : 'research-author',
          originalPromptHash: promptDigest,
          sandbox,
          workspace,
        }) : null;
      const args = ['exec'];
      if (oss) args.push('--oss', '--local-provider', localProvider);
      if (model) args.push('--model', model);
      args.push('--ephemeral', '--color', 'never', '--sandbox', sandbox, '--skip-git-repo-check', '--cd', workspace, '-');
      const startedAt = new Date().toISOString();
      const effectiveTimeoutMs = Math.min(
        Number(requestedTimeout || timeoutMs),
        timeoutMs,
      );
      const managedRuntimeInnerTimeoutMs = managedRuntimeExpected
        ? managedRuntimeTimeoutBudget(effectiveTimeoutMs).innerTimeoutMs
        : effectiveTimeoutMs;
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
            ...(managedRuntimeExpected ? {
              HEPTA_CODEX_OPENCLAW_MANAGED_TIMEOUT_MS:
                managedRuntimeInnerTimeoutMs,
              ...failureExecutorBinding.environmentOverrides,
            } : {}),
          },
        }),
        stdin: prompt,
        timeoutMs: effectiveTimeoutMs,
        signal,
      });
      const completedAt = new Date().toISOString();
      const changes = changedWorkspacePaths();
      const blockers = [];
      const cancelled = isExternalAgentCancellation(processResult);
      const {
        parsedManagedRuntimeFailureProtocol, managedRuntimeFailureCode,
        managedFailureEvidence, managedFailureEvidenceVerified,
      } = inspectManagedRuntimeFailure({
        managedRuntimeExpected, cancelled, processResult,
        model: resolvedModel, capabilityReceipt, failureExecutorBinding,
      });
      let capabilityPostflightFailure = null;
      if (processResult.timedOut) blockers.push('codex_agent_timeout');
      if (cancelled) blockers.push('codex_agent_cancelled');
      if (!cancelled && (processResult.exitCode !== 0 || processResult.error)) blockers.push('codex_agent_process_failed');
      if (processResult.outputTruncated) blockers.push('codex_agent_output_truncated');
      blockers.push(...readOnlyMutationBlockers({ sandbox, changedPaths: changes }));
      if (capabilityReceipt) {
        const postflight = capabilityBinding.inspectPostflight({
          codexBinary,
          model,
          spawnSyncImpl,
        });
        capabilityPostflightFailure = postflight.failure;
        if (postflight.blocker) blockers.push(postflight.blocker);
      }
      const parsedStructuredOutput = processResult.outputTruncated
        ? null
        : managedRuntimeExpected
          ? parseStrictStructuredOutput(processResult.stdout)
          : parseStructuredOutput(processResult.stdout);
      const managedExecutionEvidence = parsedStructuredOutput
        ? parsedStructuredOutput[OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD] || null
        : null;
      const managedExecutionEvidenceVerified = managedRuntimeExpected
        && verifyOpenClawManagedExecutionEvidence(managedExecutionEvidence, {
          originalPromptHash: promptDigest,
          model: resolvedModel,
          changedPaths: changes,
          expectedConfigurationHash: capabilityReceipt?.openClawManagedConfigurationHash,
          expectedRuntimeProvenanceHash: capabilityReceipt?.openClawManagedRuntimeProvenanceHash,
          expectedAuthBindingMode:
            capabilityReceipt?.openClawManagedAuthBindingMode,
          expectedAuthProfileIdentityHash:
            capabilityReceipt?.openClawManagedAuthProfileIdentityHash,
          expectedGatewayRouteIdentityHash:
            capabilityReceipt?.openClawManagedGatewayRouteIdentityHash,
          expectedAuthSourceIdentityHash:
            capabilityReceipt?.openClawManagedAuthSourceIdentityHash,
        });
      if (managedRuntimeExpected
        && !managedExecutionEvidenceVerified
        && !managedFailureEvidenceVerified) {
        blockers.push('codex_openclaw_managed_execution_evidence_invalid');
      } else if (!managedRuntimeExpected && managedExecutionEvidence) {
        blockers.push('codex_openclaw_managed_execution_evidence_unexpected');
      }
      if (parsedManagedRuntimeFailureProtocol?.valid === false) {
        blockers.push('codex_openclaw_managed_failure_protocol_invalid');
      }
      if (managedFailureEvidence && !managedFailureEvidenceVerified) {
        blockers.push('codex_openclaw_managed_failure_usage_evidence_invalid');
      }
      const managedOutputAuthorized = !managedRuntimeExpected
        || (managedExecutionEvidenceVerified && blockers.length === 0);
      const structuredOutput = parsedStructuredOutput && managedOutputAuthorized
        ? Object.freeze(Object.fromEntries(Object.entries(parsedStructuredOutput)
          .filter(([key]) => key !== OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD)))
        : null;
      if (managedRuntimeExpected && managedOutputAuthorized && structuredOutput?.status === 'blocked') blockers.push('codex_openclaw_managed_model_reported_blocked');
      const verifiedSessionId = managedExecutionEvidenceVerified
        ? managedExecutionEvidence.completionInvocationId
        : localSessionId;
      const payload = {
        providerMode: oss ? `local:${localProvider}` : 'openai',
        agentId: principalId,
        model: resolvedModel,
        resolvedModel,
        modelSelectionSource: capabilityReceipt?.modelSelectionSource
          || (model ? 'explicit_override' : null),
        promptHash: promptDigest,
        sessionId: verifiedSessionId,
        childSessionId: verifiedSessionId,
        sessionIsolation: managedExecutionEvidenceVerified
          ? managedExecutionEvidence.sessionIsolation
          : 'fresh_ephemeral_no_resume',
        contextInheritance: 'forbidden',
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
        finalOutput: managedOutputAuthorized ? processResult.stdout.slice(-12000) : '',
        structuredOutput,
        stderrTail: managedRuntimeExpected
          ? managedRuntimeFailureCode ? `${managedRuntimeFailureCode}\n` : ''
          : processResult.stderr.slice(-12000),
        error: managedRuntimeExpected ? null : processResult.error?.message || null,
        ...(capabilityPostflightFailure ? {
          details: Object.freeze({ capabilityRuntimePostflight: capabilityPostflightFailure }),
        } : {}),
        ...(managedRuntimeFailureCode ? {
          managedRuntimeFailureCode,
          managedRuntimeFailureDisposition: managedRuntimeFailureRetryable(
            managedRuntimeFailureCode,
            managedFailureEvidenceVerified ? managedFailureEvidence : null,
          )
            ? 'retryable' : 'permanent',
        } : {}),
        startedAt,
        completedAt,
        externalActionPerformed: managedFailureEvidenceVerified
          ? managedFailureEvidence.externalActionPerformed : false,
        externalModelInvocationPerformed: managedExecutionEvidenceVerified || managedFailureEvidenceVerified ? true : null,
        externalSideEffectPerformed: managedExecutionEvidenceVerified
          ? false : managedFailureEvidenceVerified
            ? managedFailureEvidence.externalSideEffectPerformed : null,
        externalActionVerification: managedExecutionEvidenceVerified
          ? managedGatewayRuntime
            ? 'openclaw_current_agent_gateway_rpc_no_tools_or_delivery'
            : 'openclaw_user_locked_codex_app_server_no_tools_or_delivery'
          : managedFailureEvidenceVerified
            ? managedGatewayRuntime
              ? 'openclaw_current_agent_gateway_rpc_failure_evidence'
              : 'openclaw_user_locked_codex_app_server_failure_evidence'
            : 'codex_sandbox_policy',
        ...(managedExecutionEvidenceVerified ? {
          ...(managedExecutionEvidence.usage ? { usage: managedExecutionEvidence.usage } : {}),
          codexExecutionTransport: capabilityReceipt.executionTransport,
          codexAuthenticationAuthorityMode:
            capabilityReceipt.authenticationAuthorityMode,
          openClawManagedCodexExecutionHash: managedExecutionEvidence.openClawManagedCodexExecutionHash,
          openClawManagedExecutionEvidence: managedExecutionEvidence,
          openClawCompletionInvocationId: managedExecutionEvidence.completionInvocationId,
          openClawSuccessfulAttemptId: managedExecutionEvidence.successfulAttemptId,
          openClawAttemptTraceHash: managedExecutionEvidence.attemptTraceHash,
          openClawSourceSnapshotHash: managedExecutionEvidence.sourceSnapshotHash,
          openClawManagedConfigurationHash: managedExecutionEvidence.configurationHash,
          openClawManagedRuntimeProvenanceHash: managedExecutionEvidence
            .openClawManagedRuntimeProvenance.openClawManagedRuntimeProvenanceHash,
          openClawManagedAuthProfileIdentityHash: managedExecutionEvidence.openClawManagedAuthProfileIdentityHash,
          openClawManagedGatewayRouteIdentityHash:
            managedExecutionEvidence.openClawManagedGatewayRouteIdentityHash
              || null,
          openClawManagedAuthBindingMode:
            managedExecutionEvidence.openClawManagedAuthBindingMode
              || 'user-locked-profile',
          openClawManagedAuthSourceIdentityHash: managedExecutionEvidence.openClawManagedAuthSourceIdentityHash,
          credentialMaterialExported: false,
          simpleCompletionModelRun: false,
          codexAppServerOneShot:
            managedExecutionEvidence.codexAppServerOneShot,
          gatewayDirectRpcOneShot:
            managedExecutionEvidence.gatewayDirectRpcOneShot === true,
          toolExecutionEnabled: false,
          messageDeliveryEnabled: false,
        } : {}),
        ...(managedFailureEvidenceVerified ? {
          usage: managedFailureEvidence.usage,
          usageComplete: managedFailureEvidence.usageComplete !== false,
          openClawManagedFailureUsageEvidence: managedFailureEvidence,
          openClawManagedFailureUsageEvidenceHash:
            managedFailureEvidence.openClawManagedCodexFailureUsageEvidenceHash,
        } : {}),
        ...(formalReviewerCapabilityReceipt ? {
          codexFormalReviewerCapabilityReceiptHash: formalReviewerCapabilityReceipt.codexFormalReviewerCapabilityReceiptHash,
          codexCredentialRootIdentityHash: formalReviewerCapabilityReceipt.credentialRootIdentityHash,
          codexCredentialConfigIdentityHash: formalReviewerCapabilityReceipt.credentialConfigIdentityHash,
          codexAuthorCredentialRootIdentityHash: formalReviewerCapabilityReceipt.authorCredentialRootIdentityHash,
          codexCredentialIndependenceVerified: formalReviewerCapabilityReceipt.credentialIndependenceVerified,
          codexProviderCredentialSharingPermitted: formalReviewerCapabilityReceipt.providerCredentialSharingPermitted,
          codexFreshEphemeralSessionRequired: formalReviewerCapabilityReceipt.freshEphemeralSessionRequired,
          codexAuthorContextInheritanceForbidden: formalReviewerCapabilityReceipt.authorContextInheritanceForbidden,
          codexFrozenArtifactReviewRequired: formalReviewerCapabilityReceipt.frozenArtifactReviewRequired,
          codexReviewerAssuranceScope: formalReviewerCapabilityReceipt.assuranceScope,
          codexProviderAccountIndependenceVerified: false,
          codexBinaryIdentityHash: formalReviewerCapabilityReceipt.codexBinaryIdentityHash,
          codexVersion: formalReviewerCapabilityReceipt.codexVersion,
          codexAuthenticationStatus: formalReviewerCapabilityReceipt.authenticationStatus,
          codexExecutionTransport: formalReviewerCapabilityReceipt.executionTransport || 'codex_cli',
          codexAuthenticationAuthorityMode: formalReviewerCapabilityReceipt.authenticationAuthorityMode || 'codex_home',
        } : {}),
        ...(researchAuthorCapabilityReceipt ? {
          codexResearchAuthorCapabilityReceiptHash: researchAuthorCapabilityReceipt.codexResearchAuthorCapabilityReceiptHash,
          codexResearchAuthorAssuranceScope: researchAuthorCapabilityReceipt.assuranceScope,
          codexFreshEphemeralSessionRequired: researchAuthorCapabilityReceipt.freshEphemeralSessionRequired,
          codexPriorAgentContextInheritanceForbidden: researchAuthorCapabilityReceipt.priorAgentContextInheritanceForbidden,
          codexResearchAuthorProviderAccountIdentityAttested: researchAuthorCapabilityReceipt.providerAccountIdentityAttested,
          codexCredentialRootIdentityHash: researchAuthorCapabilityReceipt.credentialRootIdentityHash,
          codexCredentialConfigIdentityHash: researchAuthorCapabilityReceipt.credentialConfigIdentityHash,
          codexBinaryIdentityHash: researchAuthorCapabilityReceipt.codexBinaryIdentityHash,
          codexVersion: researchAuthorCapabilityReceipt.codexVersion,
          codexAuthenticationStatus: researchAuthorCapabilityReceipt.authenticationStatus,
          codexExecutionTransport: researchAuthorCapabilityReceipt.executionTransport || 'codex_cli',
          codexAuthenticationAuthorityMode: researchAuthorCapabilityReceipt.authenticationAuthorityMode || 'codex_home',
        } : {}),
      };
      return {
        payload,
        failureMessage: managedRuntimeFailureCode
          || blockers.join(',') || payload.error || `agent exited ${payload.exitCode}`,
        retryable: !cancelled && !blockers.includes('read_only_agent_modified_workspace')
          && parsedManagedRuntimeFailureProtocol?.valid !== false
          && !blockers.includes('codex_openclaw_managed_failure_usage_evidence_invalid') && !blockers.includes('codex_openclaw_managed_model_reported_blocked')
          && managedRuntimeFailureRetryable(
            managedRuntimeFailureCode,
            managedFailureEvidenceVerified ? managedFailureEvidence : null,
          )
          && !blockers.some((blocker) => (
            blocker === `${capabilityPrefix}_capability_runtime_identity_changed_during_execution`
          ))
          && (!blockers.includes(
            `${capabilityPrefix}_capability_runtime_postflight_failed`,
          ) || capabilityPostflightFailure?.disposition === 'retryable'),
      };
    },
  });
}

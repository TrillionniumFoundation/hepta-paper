import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { restrictedChildEnvironment, runBoundedChildProcess } from './bounded-child-process.mjs';
import { createAgentExecutorTemplate, isExternalAgentCancellation } from './agent-executor-template.mjs';
import { readOnlyMutationBlockers } from './workspace-change-tracker.mjs';
import { inspectCodexRuntimeIdentity, preflightCodexRuntime } from './codex-runtime-preflight.mjs';
import { inspectManagedRuntimeFailure, managedRuntimeFailureRetryable } from './codex-openclaw-managed-failure-protocol.mjs';
import {
  managedCapabilityReceiptValid,
  managedFailureExecutorBindingForWorkspace,
  openClawManagedCapabilityIdentityMatches,
  openClawManagedRuntimeExpected,
} from './codex-openclaw-managed-executor-capability.mjs';
import {
  buildOpenClawManagedExecutionMetadata,
  OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD,
  verifyOpenClawManagedExecutionEvidence,
} from './codex-openclaw-managed-runtime.mjs';
const MANAGED_RUNTIME_MAXIMUM_CLEANUP_RESERVE_MS = 90_000;
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
function codexRuntimeIdentityMatchesCapability(runtime, capability) {
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
function codexRuntimeMatchesCapability(runtime, capability) {
  return codexRuntimeIdentityMatchesCapability(runtime, capability)
    && runtime?.authenticationStatus === capability?.authenticationStatus;
}
function safeCapabilityPostflightFailureCode(error, capabilityPrefix) {
  const candidate = String(error?.code || error?.message || '').trim();
  return new RegExp(`^${capabilityPrefix}_[a-z0-9_]{1,160}$`).test(candidate)
    ? candidate
    : `${capabilityPrefix}_capability_runtime_postflight_unclassified`;
}
function capabilityPostflightFailureRetryable(failureCode, capabilityPrefix) {
  return new Set([
    `${capabilityPrefix}_version_unverified`,
    `${capabilityPrefix}_openclaw_managed_runtime_required`,
  ]).has(failureCode);
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
  if (formalReviewerCapabilityReceipt) {
    const { codexFormalReviewerCapabilityReceiptHash, ...capabilityPayload } = formalReviewerCapabilityReceipt;
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
      || !managedCapabilityReceiptValid(
        formalReviewerCapabilityReceipt,
        'formal-reviewer',
      )
      || !codexHome || !resolvedModel || !principalId) {
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
      || researchAuthorCapabilityReceipt.model !== resolvedModel
      || researchAuthorCapabilityReceipt.assuranceScope !== 'filesystem_credential_root_runtime_and_model_selection_preflight'
      || researchAuthorCapabilityReceipt.providerAccountIdentityAttested !== false
      || researchAuthorCapabilityReceipt.authenticationStatus !== 'codex_authentication_verified'
      || researchAuthorCapabilityReceipt.selectedModelExecutionCanaryVerified !== false
      || researchAuthorCapabilityReceipt.workspaceWriteRequired !== true
      || researchAuthorCapabilityReceipt.dynamicAttemptWorkspaceRequired !== true
      || researchAuthorCapabilityReceipt.freshEphemeralSessionRequired !== true
      || researchAuthorCapabilityReceipt.priorAgentContextInheritanceForbidden !== true
      || !managedCapabilityReceiptValid(
        researchAuthorCapabilityReceipt,
        'research-author',
      )
      || !codexHome || !resolvedModel || !principalId) {
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
      const managedRuntimeExpected = openClawManagedRuntimeExpected(capabilityReceipt);
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
      const managedRuntimeCleanupReserveMs = Math.min(
        MANAGED_RUNTIME_MAXIMUM_CLEANUP_RESERVE_MS,
        Math.floor(effectiveTimeoutMs / 5),
      );
      const managedRuntimeInnerTimeoutMs = Math.max(
        250,
        effectiveTimeoutMs - managedRuntimeCleanupReserveMs,
      );
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
        try {
          const postflightRuntime = inspectCodexRuntimeIdentity({
            codexBinary,
            codexHome,
            model,
            errorPrefix: capabilityPrefix,
            spawnSyncImpl,
          });
          if (!codexRuntimeIdentityMatchesCapability(postflightRuntime, capabilityReceipt)) {
            const failureCode = `${capabilityPrefix}_capability_runtime_identity_changed_during_execution`;
            capabilityPostflightFailure = Object.freeze({
              phase: 'identity_only',
              failureCode,
              disposition: 'permanent',
              outcomeHash: hashRecord('CodexCapabilityRuntimePostflightOutcome', {
                phase: 'identity_only',
                failureCode,
                disposition: 'permanent',
              }),
            });
            blockers.push(failureCode);
          }
        } catch (error) {
          const failureCode = safeCapabilityPostflightFailureCode(error, capabilityPrefix);
          const retryable = capabilityPostflightFailureRetryable(failureCode, capabilityPrefix);
          capabilityPostflightFailure = Object.freeze({
            phase: 'identity_only',
            failureCode,
            disposition: retryable ? 'retryable' : 'permanent',
            outcomeHash: hashRecord('CodexCapabilityRuntimePostflightOutcome', {
              phase: 'identity_only',
              failureCode,
              disposition: retryable ? 'retryable' : 'permanent',
            }),
          });
          blockers.push(`${capabilityPrefix}_capability_runtime_postflight_failed`);
        }
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
          expectedAuthProfileIdentityHash:
            capabilityReceipt?.openClawManagedAuthProfileIdentityHash,
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
          ? 'fresh_one_shot_codex_app_server_no_resume' : 'fresh_ephemeral_no_resume',
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
          ? 'openclaw_user_locked_codex_app_server_no_tools_or_delivery'
          : managedFailureEvidenceVerified
            ? 'openclaw_user_locked_codex_app_server_failure_evidence'
            : 'codex_sandbox_policy',
        ...(managedExecutionEvidenceVerified ? {
          ...(managedExecutionEvidence.usage ? { usage: managedExecutionEvidence.usage } : {}),
          codexExecutionTransport: 'openclaw_user_locked_codex_app_server',
          codexAuthenticationAuthorityMode: 'openclaw_user_locked_profile_fail_closed',
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
          openClawManagedAuthSourceIdentityHash: managedExecutionEvidence.openClawManagedAuthSourceIdentityHash,
          credentialMaterialExported: false,
          simpleCompletionModelRun: false,
          codexAppServerOneShot: true,
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
          && !blockers.includes('codex_openclaw_managed_failure_usage_evidence_invalid')
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

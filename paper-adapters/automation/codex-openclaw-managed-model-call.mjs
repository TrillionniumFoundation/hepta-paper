import crypto from 'node:crypto';
import path from 'node:path';

import {
  loadOpenClawModelRuntime,
  verifyOpenClawModelRuntimeProvenance,
} from './codex-openclaw-managed-configuration.mjs';
import {
  MAXIMUM_MODEL_ATTEMPTS,
  OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD,
  SAFE_THINKING,
  modelAttemptTraceHash,
  runtimeError,
} from './codex-openclaw-managed-runtime-common.mjs';
import {
  agentCommandErrorText,
  agentCommandExternalDeliveryObserved,
  agentCommandIsolationObserved,
  agentCommandText,
  codexAppServerTraceViolatesPin,
  completionAbortScope,
  errorWithAttemptTrace,
  loadRuntimeWithinAbortScope,
  modelAttemptRecord,
  modelFailureClass,
  thinkingForModelAttempt,
  validCodexAppServerExecutionTrace,
  verifyExplicitProfileAvailable,
} from './codex-openclaw-managed-model-support.mjs';
import {
  runManagedOneShotAgentCommand,
} from './codex-openclaw-managed-one-shot-session.mjs';
import {
  aggregateManagedUsage,
  normalizeManagedUsage,
} from './codex-openclaw-managed-usage-evidence.mjs';

export async function callManagedModel({
  configuration,
  model,
  prompt,
  timeoutMs,
  signal = null,
  modelRuntimeLoader = loadOpenClawModelRuntime,
} = {}) {
  const abortScope = completionAbortScope(signal, timeoutMs);
  const attemptTrace = [];
  const startedAt = Date.now();
  let lastFailureClass = 'transport';
  let runtime = null;
  let primaryFailure = null;
  let completedResult = null;
  try {
    runtime = await loadRuntimeWithinAbortScope({
      modelRuntimeLoader,
      configuration,
      abortScope,
    });
    if (!verifyOpenClawModelRuntimeProvenance(runtime?.runtimeProvenance)) {
      throw runtimeError(
        'codex_openclaw_managed_model_runtime_provenance_invalid',
      );
    }
    verifyExplicitProfileAvailable({ runtime, configuration });
    for (let attempt = 1; attempt <= MAXIMUM_MODEL_ATTEMPTS; attempt += 1) {
      if (abortScope.signal.aborted) {
        throw errorWithAttemptTrace(
          abortScope.timedOut()
            ? 'codex_openclaw_managed_model_timeout'
            : 'codex_openclaw_managed_model_cancelled',
          attemptTrace,
          { retryable: abortScope.timedOut() },
        );
      }
      const attemptId = crypto.randomUUID();
      const thinking = thinkingForModelAttempt(configuration.thinking, attempt);
      const remainingTimeoutMs = Math.max(
        1,
        Number(timeoutMs) - (Date.now() - startedAt),
      );
      let invocation;
      try {
        invocation = await runManagedOneShotAgentCommand({
          runtime,
          configuration,
          model,
          prompt,
          thinking,
          attemptId,
          abortSignal: abortScope.signal,
          timeoutMs: remainingTimeoutMs,
        });
      } catch (error) {
        const failedInvocation = error?.managedInvocationFailure;
        const failedResponse = failedInvocation?.result || null;
        const failedUsage = normalizeManagedUsage(
          failedResponse?.meta?.agentMeta?.usage,
          {
            lastCallUsage: failedResponse?.meta?.agentMeta?.lastCallUsage,
          },
        );
        if (failedResponse) {
          const failedResponseText = agentCommandText(failedResponse);
          const failedResponseErrorText = agentCommandErrorText(failedResponse);
          attemptTrace.push(modelAttemptRecord({
            attemptNumber: attempt,
            attemptId,
            model,
            configuration,
            thinking,
            outcome: 'transient_provider_failure',
            stopReason: failedResponse?.meta?.stopReason || 'error',
            errorClass: 'session_cleanup_failed',
            responseText: failedResponseText,
            responseErrorText: failedResponseErrorText,
            resolvedThinking: failedResponse?.meta?.requestShaping?.thinking,
            executionTrace: failedResponse?.meta?.executionTrace,
            response: failedResponse,
            sessionBindingBeforeHash:
              failedInvocation.sessionBindingBeforeHash,
            sessionBindingAfterHash: null,
            sessionCleanup: null,
            sessionCleanupHash: null,
            sessionCleanupVerified: false,
            usage: failedUsage,
          }));
          throw errorWithAttemptTrace(
            String(error?.code || error?.message
              || 'codex_openclaw_managed_session_cleanup_failed'),
            attemptTrace,
            { retryable: Boolean(failedUsage) && error?.retryable === true },
          );
        }
        throw error;
      }
      const response = invocation.result;
      const thrown = invocation.thrown;
      const responseText = agentCommandText(response);
      const responseErrorText = agentCommandErrorText(response);
      const stopReason = response?.meta?.stopReason || (thrown ? 'error' : '');
      const attemptUsage = normalizeManagedUsage(
        response?.meta?.agentMeta?.usage,
        {
          lastCallUsage: response?.meta?.agentMeta?.lastCallUsage,
        },
      );
      const attemptRecordFields = {
        attemptNumber: attempt,
        attemptId,
        model,
        configuration,
        thinking,
        responseText,
        responseErrorText,
        resolvedThinking: response?.meta?.requestShaping?.thinking,
        executionTrace: response?.meta?.executionTrace,
        response,
        sessionBindingBeforeHash:
          invocation.sessionBindingBeforeHash,
        sessionBindingAfterHash:
          invocation.sessionBindingAfterHash,
        sessionCleanup: invocation.sessionCleanup,
        sessionCleanupHash: invocation.sessionCleanupHash,
        sessionCleanupVerified: invocation.cleanupVerified,
        usage: attemptUsage,
      };
      if (invocation.sessionBindingBeforeHash
          !== invocation.sessionBindingAfterHash) {
        attemptTrace.push(modelAttemptRecord({
          ...attemptRecordFields,
          outcome: 'transient_provider_failure',
          stopReason: stopReason || 'error',
          errorClass: 'session_binding_changed',
        }));
        throw errorWithAttemptTrace(
          'codex_openclaw_managed_session_binding_changed',
          attemptTrace,
          { retryable: false },
        );
      }
      if (abortScope.signal.aborted) {
        attemptTrace.push(modelAttemptRecord({
          ...attemptRecordFields,
          outcome: 'transient_provider_failure',
          stopReason: 'aborted',
          errorClass: 'aborted',
        }));
        throw errorWithAttemptTrace(
          abortScope.timedOut()
            ? 'codex_openclaw_managed_model_timeout'
            : 'codex_openclaw_managed_model_cancelled',
          attemptTrace,
          {
            retryable: abortScope.timedOut() && Boolean(attemptUsage),
          },
        );
      }
      const agentMeta = response?.meta?.agentMeta;
      if (!attemptUsage) {
        const usageFailureClass = response ? 'usage_invalid' : modelFailureClass({
          stopReason,
          errorCode: thrown?.code,
          errorType: thrown?.reason || thrown?.type || thrown?.name,
          errorMessage: thrown?.message,
        });
        attemptTrace.push(modelAttemptRecord({
          ...attemptRecordFields,
          outcome: 'transient_provider_failure',
          stopReason: stopReason || 'error',
          errorClass: usageFailureClass,
        }));
        const usageFailureCode = response
          ? 'codex_openclaw_managed_usage_invalid'
          : usageFailureClass === 'authentication'
            ? 'codex_openclaw_managed_auth_profile_unavailable'
            : usageFailureClass === 'quota'
              ? 'codex_openclaw_managed_profile_quota_exhausted'
              : usageFailureClass === 'unsupported_model'
                ? 'codex_openclaw_managed_model_unsupported_by_profile'
                : 'codex_openclaw_managed_transient_provider_response';
        throw errorWithAttemptTrace(
          usageFailureCode,
          attemptTrace,
          { retryable: false },
        );
      }
      if (response && (
        agentMeta?.sessionId !== attemptId
        || agentMeta?.provider !== model.provider
        || agentMeta?.model !== model.modelId
        || agentMeta?.agentHarnessId !== 'codex'
        || response?.meta?.requestShaping?.authMode !== 'auth-profile'
      )) {
        attemptTrace.push(modelAttemptRecord({
          ...attemptRecordFields,
          outcome: 'transient_provider_failure',
          stopReason: stopReason || 'error',
          errorClass: 'model_resolution_mismatch',
        }));
        throw errorWithAttemptTrace(
          'codex_openclaw_managed_model_resolution_mismatch',
          attemptTrace,
          { retryable: false },
        );
      }
      if (codexAppServerTraceViolatesPin(
        response?.meta?.executionTrace,
        model,
      )) {
        attemptTrace.push(modelAttemptRecord({
          ...attemptRecordFields,
          outcome: 'transient_provider_failure',
          stopReason: stopReason || 'error',
          errorClass: 'fallback_violation',
        }));
        throw errorWithAttemptTrace(
          'codex_openclaw_managed_runtime_fallback_observed',
          attemptTrace,
          { retryable: false },
        );
      }
      const policyViolationObserved = Boolean(
        Number(response?.meta?.toolSummary?.calls || 0) > 0
        || (response?.meta?.pendingToolCalls || []).length > 0
        || agentCommandExternalDeliveryObserved(response)
      );
      if (policyViolationObserved) {
        attemptTrace.push(modelAttemptRecord({
          ...attemptRecordFields,
          outcome: 'transient_provider_failure',
          stopReason: stopReason || 'toolUse',
          errorClass: 'policy_violation',
        }));
        throw errorWithAttemptTrace(
          'codex_openclaw_managed_agent_policy_violation',
          attemptTrace,
          { retryable: false },
        );
      }
      const reportedSessionFile = agentMeta?.sessionFile;
      const expectedInternalSessionFile = path.join(
        runtime.internalRunsDir,
        `${attemptId}.jsonl`,
      );
      const completed = !thrown
        && stopReason === 'stop'
        && responseText
        && agentMeta?.sessionId === attemptId
        && agentMeta?.provider === model.provider
        && agentMeta?.model === model.modelId
        && agentMeta?.agentHarnessId === 'codex'
        && (reportedSessionFile === undefined
          || (path.isAbsolute(String(reportedSessionFile || ''))
            && path.resolve(reportedSessionFile)
              === expectedInternalSessionFile))
        && response?.meta?.requestShaping?.authMode === 'auth-profile'
        && SAFE_THINKING.has(
          String(response?.meta?.requestShaping?.thinking || ''),
        )
        && response?.meta?.completion?.stopReason === 'stop'
        && response?.meta?.completion?.finishReason === 'stop'
        && agentCommandIsolationObserved(response)
        && validCodexAppServerExecutionTrace(
          response?.meta?.executionTrace,
          model,
        );
      if (completed) {
        const successfulAttempt = modelAttemptRecord({
          ...attemptRecordFields,
          outcome: 'completed',
          stopReason,
          errorClass: null,
        });
        attemptTrace.push(successfulAttempt);
        const frozenTrace = Object.freeze([...attemptTrace]);
        const aggregateUsage = aggregateManagedUsage(
          frozenTrace.map((entry) => entry.usage),
        );
        if (!aggregateUsage) {
          throw errorWithAttemptTrace(
            'codex_openclaw_managed_usage_invalid',
            frozenTrace,
            { retryable: false },
          );
        }
        completedResult = Object.freeze({
          text: responseText,
          completionInvocationId:
            `openclaw-codex-app-server:${attemptId}`,
          successfulAttemptId: attemptId,
          successfulResponseHash: successfulAttempt.responseTextHash,
          successfulSessionBindingHash:
            successfulAttempt.sessionBindingAfterHash,
          resolvedProvider: model.provider,
          resolvedModel: model.modelId,
          usage: aggregateUsage,
          attemptTrace: frozenTrace,
          attemptTraceHash: modelAttemptTraceHash(frozenTrace),
          attemptCount: attempt,
          thinking: successfulAttempt.resolvedThinking || thinking,
          runtimeProvenance: runtime.runtimeProvenance,
        });
        return completedResult;
      }
      lastFailureClass = modelFailureClass({
        stopReason,
        errorCode: thrown?.code,
        errorType: thrown?.reason || thrown?.type || thrown?.name,
        errorMessage: thrown?.message || response?.meta?.error?.message,
        errorText: responseErrorText,
        text: responseText,
      });
      attemptTrace.push(modelAttemptRecord({
        ...attemptRecordFields,
        outcome: 'transient_provider_failure',
        stopReason: stopReason || 'error',
        errorClass: lastFailureClass,
      }));
      if (lastFailureClass === 'authentication') {
        throw errorWithAttemptTrace(
          'codex_openclaw_managed_auth_profile_unavailable',
          attemptTrace,
          { retryable: false },
        );
      }
      if (lastFailureClass === 'quota') {
        throw errorWithAttemptTrace(
          'codex_openclaw_managed_profile_quota_exhausted',
          attemptTrace,
          { retryable: false },
        );
      }
      if (lastFailureClass === 'unsupported_model') {
        throw errorWithAttemptTrace(
          'codex_openclaw_managed_model_unsupported_by_profile',
          attemptTrace,
          { retryable: false },
        );
      }
      if (attempt < MAXIMUM_MODEL_ATTEMPTS) continue;
      throw errorWithAttemptTrace(
        'codex_openclaw_managed_transient_provider_response',
        attemptTrace,
      );
    }
  } catch (error) {
    primaryFailure = error;
    if (runtime?.runtimeProvenance && error?.attemptTrace?.length) {
      error.runtimeProvenance = runtime.runtimeProvenance;
    }
    throw error;
  } finally {
    try {
      if (typeof runtime?.disposeRegisteredAgentHarnesses === 'function') {
        await runtime.disposeRegisteredAgentHarnesses();
      }
    } catch {
      if (!primaryFailure) {
        const code = 'codex_openclaw_managed_agent_runtime_disposal_failed';
        if (completedResult?.attemptTrace?.length) {
          const disposalTrace = Object.freeze(completedResult.attemptTrace.map(
            (attempt, index, attempts) => (index === attempts.length - 1
              ? Object.freeze({
                ...attempt,
                outcome: 'transient_provider_failure',
                stopReason: 'error',
                errorClass: 'runtime_disposal_failed',
              }) : attempt),
          ));
          throw errorWithAttemptTrace(code, disposalTrace, {
            retryable: false,
            runtimeProvenance: completedResult.runtimeProvenance,
          });
        }
        throw runtimeError(code);
      }
    } finally {
      abortScope.cleanup();
    }
  }
  throw errorWithAttemptTrace(
    lastFailureClass === 'quota'
      ? 'codex_openclaw_managed_profile_quota_exhausted'
      : 'codex_openclaw_managed_transient_provider_response',
    attemptTrace,
  );
}
export function isCodexAvailabilityCanary(prompt, sandbox) {
  return sandbox === 'read-only'
    && /HEPTA_CODEX_MODEL_CANARY_CHALLENGE/.test(prompt)
    && /HEPTA_CODEX_CANARY_RESPONSE/.test(prompt);
}

export function normalizeStructuredResponse(parsed, validation, managedAuth) {
  const roleOutput = { ...parsed };
  delete roleOutput.edits;
  delete roleOutput.checks;
  delete roleOutput[OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD];
  return {
    ...roleOutput,
    status: parsed.status,
    checksRun: [],
    blockers: validation.blockers,
    [OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD]: managedAuth,
  };
}

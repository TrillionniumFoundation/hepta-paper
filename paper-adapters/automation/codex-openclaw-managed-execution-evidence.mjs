import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

import {
  MAXIMUM_MODEL_ATTEMPTS,
  SAFE_THINKING,
  modelAttemptTraceHash,
  runtimeError,
} from './codex-openclaw-managed-runtime-common.mjs';
import {
  codexAppServerTraceViolatesPin,
  validCodexAppServerExecutionTrace,
} from './codex-openclaw-managed-model-support.mjs';
import {
  aggregateManagedUsage,
  managedUsageHash,
  normalizeManagedUsage,
  sameManagedUsage,
  validCanonicalManagedUsage,
  validLegacyManagedUsage,
} from './codex-openclaw-managed-usage-evidence.mjs';
import {
  verifyOpenClawModelRuntimeProvenance,
} from './codex-openclaw-managed-configuration.mjs';

export function managedAuthEvidence({
  managed,
  snapshot,
  configuration,
  changedPaths,
  validation,
  originalPromptHash,
} = {}) {
  const usage = normalizeManagedUsage(managed.usage);
  if (!usage) throw runtimeError('codex_openclaw_managed_usage_invalid', { retryable: false });
  if (!verifyOpenClawModelRuntimeProvenance(managed.runtimeProvenance)) {
    throw runtimeError(
      'codex_openclaw_managed_model_runtime_provenance_invalid',
      { retryable: false },
    );
  }
  const payload = {
    version: 6,
    kind: 'OpenClawManagedCodexExecution',
    status: 'openclaw_managed_codex_execution_completed',
    provider: managed.resolvedProvider,
    model: managed.resolvedModel,
    agentId: configuration.agentId,
    principalRole: configuration.principalRole,
    completionInvocationId: managed.completionInvocationId,
    successfulAttemptId: managed.successfulAttemptId,
    successfulResponseHash: managed.successfulResponseHash,
    successfulSessionBindingHash:
      managed.successfulSessionBindingHash,
    attemptTrace: managed.attemptTrace,
    attemptTraceHash: managed.attemptTraceHash,
    originalPromptHash,
    sourceSnapshotHash: snapshot.snapshotHash,
    sourceSnapshotFileCount: snapshot.fileCount,
    sourceSnapshotBytes: snapshot.byteCount,
    configurationHash: configuration.configurationHash,
    openClawManagedRuntimeProvenance: managed.runtimeProvenance,
    openClawManagedAuthProfileIdentityHash:
      configuration.openClawManagedAuthProfileIdentityHash,
    openClawManagedAuthSourceIdentityHash:
      configuration.openClawManagedAuthSourceIdentityHash,
    changedPaths,
    completionTransport: 'openclaw-codex-app-server-agent-command',
    profileSelection: 'openclaw-managed-user-locked-profile',
    authProfileBindingMode: 'codex-app-server-user-locked-session',
    authProfileBindingVerified: true,
    profileFailoverPermitted: false,
    runtimeFallbackObserved: false,
    credentialMaterialCopied: false,
    runtimeHarness: 'codex',
    toolsDisabled: true,
    toolExecutionEnabled: false,
    openClawDynamicToolsAllowlist: [],
    nativeToolSurfaceEnabled: false,
    nativeToolCallsObserved: 0,
    simpleCompletionModelRun: false,
    codexAppServerOneShot: true,
    messageDeliveryEnabled: false,
    externalDeliveryObserved: false,
    promptSurface: 'openclaw-agent-command-single-user',
    promptPersistence: 'openclaw-user-turn-transcript-suppressed',
    sessionStatePersistence: 'openclaw-entry-and-managed-artifacts-removed',
    sessionCleanupScope:
      'openclaw-session-store-artifacts-and-temporary-workspace-only',
    codexAppServerStateCleanupPerformed: false,
    sessionIsolation: 'fresh_one_shot_codex_app_server_no_resume',
    sessionCleanupVerified: managed.attemptTrace.every(
      (attempt) => attempt.sessionCleanupVerified === true,
    ),
    contextInheritance: 'forbidden',
    modelReportedChecks: validation.reportedChecks,
    usage,
    usageHash: managedUsageHash(usage),
    modelAttemptCount: managed.attemptCount,
    thinkingStrategy: configuration.thinking === 'adaptive'
      ? 'high-medium-low' : 'fixed',
    resolvedThinkingLevel: managed.thinking,
    externalModelInvocationPerformed: true,
    externalSideEffectPerformed: false,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    openClawManagedCodexExecutionHash:
      hashRecord('OpenClawManagedCodexAppServerExecution', payload),
  });
}

function validManagedAttemptTrace(payload) {
  const attempts = payload?.attemptTrace;
  const canonicalUsageRequired = payload?.version >= 5;
  const sha256Pattern = /^sha256:[0-9a-f]{64}$/;
  const model = {
    provider: payload?.provider,
    modelId: payload?.model,
  };
  if (!Array.isArray(attempts)
    || attempts.length < 1
    || attempts.length > MAXIMUM_MODEL_ATTEMPTS
    || payload.modelAttemptCount !== attempts.length
    || payload.attemptTraceHash !== modelAttemptTraceHash(attempts)) {
    return false;
  }
  const attemptIds = new Set();
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const final = index === attempts.length - 1;
    if (!attempt
      || attempt.attemptNumber !== index + 1
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        String(attempt.attemptId || ''),
      )
      || attemptIds.has(attempt.attemptId)
      || attempt.provider !== payload.provider
      || attempt.model !== payload.model
      || attempt.authProfileIdentityHash
        !== payload.openClawManagedAuthProfileIdentityHash
      || !SAFE_THINKING.has(attempt.thinking)
      || (attempt.resolvedThinking !== null
        && !SAFE_THINKING.has(attempt.resolvedThinking))
      || attempt.authProfileOverrideSource !== 'user'
      || attempt.runtimeFallbackUsed !== false
      || attempt.sessionCleanupVerified !== true
      || !sha256Pattern.test(String(
        attempt.sessionBindingBeforeHash || '',
      ))
      || attempt.sessionBindingBeforeHash
        !== attempt.sessionBindingAfterHash
      || !attempt.sessionCleanup
      || attempt.sessionCleanup.sessionEntryRemoved !== true
      || attempt.sessionCleanup.artifactsRemoved !== true
      || attempt.sessionCleanup.attemptWorkspaceRemoved !== true
      || attempt.sessionCleanupHash !== hashRecord(
        'OpenClawManagedCodexAppServerSessionCleanup',
        attempt.sessionCleanup,
      )
      || (canonicalUsageRequired && (!validCanonicalManagedUsage(attempt.usage)
        || attempt.usageHash !== hashRecord(
          'OpenClawManagedCodexAppServerAttemptUsage',
          { attemptId: attempt.attemptId, usage: attempt.usage },
        )))
      || attempt.toolCallsObserved !== 0
      || attempt.pendingToolCallCount !== 0
      || attempt.externalDeliveryObserved !== false
      || ![null, 'codex'].includes(attempt.agentHarnessId)
      || ![null, 'auth-profile'].includes(attempt.requestAuthMode)
      || (attempt.responseTextHash !== null
        && !sha256Pattern.test(String(attempt.responseTextHash || '')))
      || (attempt.responseErrorHash !== null
        && !sha256Pattern.test(String(attempt.responseErrorHash || '')))
      || (attempt.executionTrace === null
        ? attempt.executionTraceHash !== null
        : (attempt.executionTraceHash !== hashRecord(
          'OpenClawManagedCodexAppServerExecutionTrace',
          attempt.executionTrace,
        )
          || codexAppServerTraceViolatesPin(
            attempt.executionTrace,
            model,
          )))
      || (final && (attempt.outcome !== 'completed'
        || attempt.stopReason !== 'stop'
        || attempt.errorClass !== null
        || attempt.responseErrorHash !== null
        || attempt.agentHarnessId !== 'codex'
        || attempt.requestAuthMode !== 'auth-profile'
        || !sha256Pattern.test(
          String(attempt.responseTextHash || ''),
        )
        || !validCodexAppServerExecutionTrace(
          attempt.executionTrace,
          model,
        )))
      || (!final && (attempt.outcome !== 'transient_provider_failure'
        || typeof attempt.errorClass !== 'string'
        || !attempt.errorClass))) {
      return false;
    }
    attemptIds.add(attempt.attemptId);
  }
  const successfulAttempt = attempts.at(-1);
  const aggregateUsage = canonicalUsageRequired
    ? aggregateManagedUsage(attempts.map((attempt) => attempt.usage)) : null;
  const expectedThinking = payload.thinkingStrategy === 'high-medium-low'
    ? ['high', 'medium', 'low'].slice(0, attempts.length)
    : Array(attempts.length).fill(attempts[0].thinking);
  return (!canonicalUsageRequired || (aggregateUsage
      && sameManagedUsage(payload.usage, aggregateUsage)
      && payload.usageHash === managedUsageHash(aggregateUsage)))
    && payload.successfulAttemptId === successfulAttempt.attemptId
    && payload.completionInvocationId
      === `openclaw-codex-app-server:${successfulAttempt.attemptId}`
    && payload.successfulResponseHash === successfulAttempt.responseTextHash
    && payload.successfulSessionBindingHash
      === successfulAttempt.sessionBindingAfterHash
    && payload.resolvedThinkingLevel
      === (successfulAttempt.resolvedThinking || successfulAttempt.thinking)
    && JSON.stringify(attempts.map((attempt) => attempt.thinking))
      === JSON.stringify(expectedThinking);
}

export function verifyOpenClawManagedExecutionEvidence(evidence, {
  originalPromptHash,
  model,
  changedPaths,
  expectedConfigurationHash,
  expectedRuntimeProvenanceHash,
  expectedAuthProfileIdentityHash,
  expectedAuthSourceIdentityHash,
  allowLegacyVersion4 = false,
} = {}) {
  const {
    openClawManagedCodexExecutionHash: claimedHash,
    ...payload
  } = evidence || {};
  const expectedChangedPaths = [...new Set(
    (changedPaths || []).map(String),
  )].sort();
  return Boolean(
    evidence
    && (payload.version === 6
      || (allowLegacyVersion4 === true && payload.version === 4))
    && payload.kind === 'OpenClawManagedCodexExecution'
    && payload.status === 'openclaw_managed_codex_execution_completed'
    && hashRecord(
      'OpenClawManagedCodexAppServerExecution',
      payload,
    ) === claimedHash
    && payload.provider === 'openai'
    && payload.model === model
    && payload.originalPromptHash === originalPromptHash
    && /^sha256:[0-9a-f]{64}$/.test(String(payload.sourceSnapshotHash || ''))
    && /^sha256:[0-9a-f]{64}$/.test(String(expectedConfigurationHash || ''))
    && payload.configurationHash === expectedConfigurationHash
    && /^sha256:[0-9a-f]{64}$/.test(
      String(expectedRuntimeProvenanceHash || ''),
    )
    && verifyOpenClawModelRuntimeProvenance(
      payload.openClawManagedRuntimeProvenance,
      { expectedProvenanceHash: expectedRuntimeProvenanceHash },
    )
    && /^sha256:[0-9a-f]{64}$/.test(String(expectedAuthProfileIdentityHash || ''))
    && payload.openClawManagedAuthProfileIdentityHash
      === expectedAuthProfileIdentityHash
    && /^sha256:[0-9a-f]{64}$/.test(String(expectedAuthSourceIdentityHash || ''))
    && payload.openClawManagedAuthSourceIdentityHash
      === expectedAuthSourceIdentityHash
    && JSON.stringify(payload.changedPaths) === JSON.stringify(expectedChangedPaths)
    && payload.completionTransport === 'openclaw-codex-app-server-agent-command'
    && payload.profileSelection === 'openclaw-managed-user-locked-profile'
    && payload.authProfileBindingMode
      === 'codex-app-server-user-locked-session'
    && payload.authProfileBindingVerified === true
    && payload.profileFailoverPermitted === false
    && payload.runtimeFallbackObserved === false
    && payload.credentialMaterialCopied === false
    && payload.runtimeHarness === 'codex'
    && payload.toolsDisabled === true
    && payload.toolExecutionEnabled === false
    && Array.isArray(payload.openClawDynamicToolsAllowlist)
    && payload.openClawDynamicToolsAllowlist.length === 0
    && payload.nativeToolSurfaceEnabled === false
    && payload.nativeToolCallsObserved === 0
    && payload.simpleCompletionModelRun === false
    && payload.codexAppServerOneShot === true
    && payload.messageDeliveryEnabled === false
    && payload.externalDeliveryObserved === false
    && payload.promptSurface === 'openclaw-agent-command-single-user'
    && payload.promptPersistence
      === 'openclaw-user-turn-transcript-suppressed'
    && payload.sessionStatePersistence
      === 'openclaw-entry-and-managed-artifacts-removed'
    && payload.sessionCleanupScope
      === 'openclaw-session-store-artifacts-and-temporary-workspace-only'
    && payload.codexAppServerStateCleanupPerformed === false
    && payload.sessionIsolation === 'fresh_one_shot_codex_app_server_no_resume'
    && payload.sessionCleanupVerified === true
    && payload.contextInheritance === 'forbidden'
    && Array.isArray(payload.modelReportedChecks)
    && (payload.version === 4
      ? validLegacyManagedUsage(payload.usage)
      : (validCanonicalManagedUsage(payload.usage)
        && payload.usageHash === managedUsageHash(payload.usage)))
    && validManagedAttemptTrace(payload)
    && ['fixed', 'high-medium-low'].includes(payload.thinkingStrategy)
    && SAFE_THINKING.has(payload.resolvedThinkingLevel)
    && payload.externalModelInvocationPerformed === true
    && payload.externalSideEffectPerformed === false
    && payload.externalActionPerformed === false
  );
}

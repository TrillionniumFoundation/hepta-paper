import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  withCodexOpenClawManagedSessionStoreLifecycleLock,
} from './codex-openclaw-managed-lifecycle.mjs';
import {
  PRIVATE_DIRECTORY_MODE,
  runtimeError,
} from './codex-openclaw-managed-runtime-common.mjs';

function managedOneShotSessionIdentity(configuration, attemptId) {
  const segment = `hepta-managed-one-shot-${attemptId}`;
  return Object.freeze({
    sessionId: attemptId,
    sessionKey:
      `agent:${configuration.agentId}:subagent:${segment}`,
    segment,
  });
}
function managedOneShotSessionEntry({
  configuration,
  model,
  attemptId,
} = {}) {
  return Object.freeze({
    sessionId: attemptId,
    updatedAt: Date.now(),
    authProfileOverride: configuration.authProfileId,
    authProfileOverrideSource: 'user',
    modelOverride: model.modelId,
    providerOverride: model.provider,
    modelOverrideSource: 'user',
    agentRuntimeOverride: 'codex',
    status: 'running',
  });
}

function managedOneShotSessionBindingProjection(entry) {
  return Object.freeze({
    sessionId: entry?.sessionId || null,
    authProfileOverride: entry?.authProfileOverride || null,
    authProfileOverrideSource: entry?.authProfileOverrideSource || null,
    providerOverride: entry?.providerOverride || null,
    modelOverride: entry?.modelOverride || null,
    modelOverrideSource: entry?.modelOverrideSource || null,
    agentRuntimeOverride: entry?.agentRuntimeOverride || null,
  });
}

function validManagedOneShotSessionBinding(entry, {
  configuration,
  model,
  identity,
} = {}) {
  const projection = managedOneShotSessionBindingProjection(entry);
  return Boolean(
    projection.sessionId === identity.sessionId
    && projection.authProfileOverride === configuration.authProfileId
    && projection.authProfileOverrideSource === 'user'
    && projection.providerOverride === model.provider
    && projection.modelOverride === model.modelId
    && projection.modelOverrideSource === 'user'
    && projection.agentRuntimeOverride === 'codex'
  );
}

function managedOneShotSessionBindingHash(entry) {
  return hashRecord(
    'OpenClawManagedCodexAppServerSessionBinding',
    managedOneShotSessionBindingProjection(entry),
  );
}

function removeExactManagedArtifact(candidate) {
  if (!fs.existsSync(candidate)) return;
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('managed artifact is not a regular file');
  }
  fs.rmSync(candidate, { force: true });
  if (fs.existsSync(candidate)) throw new Error('managed artifact remained');
}

function exactManagedOneShotArtifacts(runtime, attemptId) {
  const suffixes = [
    '.jsonl',
    '.trajectory.jsonl',
    '.trajectory-path.json',
    '.jsonl.codex-app-server.json',
    '.jsonl.codex-app-server.json.migrated',
  ];
  return Object.freeze([
    ...suffixes.map((suffix) => path.join(
      runtime.sessionsDir,
      `${attemptId}${suffix}`,
    )),
    ...suffixes.map((suffix) => path.join(
      runtime.internalRunsDir,
      `${attemptId}${suffix}`,
    )),
  ]);
}

function unexpectedManagedOneShotArtifacts(runtime, attemptId) {
  const prefix = `${attemptId}.`;
  return [runtime.sessionsDir, runtime.internalRunsDir].flatMap((directory) => {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => path.join(directory, entry));
  });
}

function exactManagedCleanupFailureCode(error, fallback) {
  const code = String(error?.code || '');
  return /^codex_openclaw_managed_session_cleanup_[a-z0-9_]+$/.test(code)
    ? code : fallback;
}

async function cleanupManagedOneShotSession({
  runtime,
  configuration,
  model,
  identity,
  result,
  attemptWorkspace,
  sessionPrepared,
} = {}) {
  const disappearedAfterResidueVerificationCode =
    'codex_openclaw_managed_session_cleanup_entry_disappeared_after_residue_verification';
  let sessionEntry = null;
  let sessionBindingAfterHash = null;
  let sessionEntryRemoved = false;
  let artifactsRemoved = false;
  let attemptWorkspaceRemoved = false;
  let sessionFailureCode = null;
  let artifactFailureCode = null;
  let workspaceFailureCode = null;
  let sessionFailureFallbackCode =
    'codex_openclaw_managed_session_cleanup_entry_inspection_failed';
  try {
    sessionEntry = runtime.getSessionEntry({
      agentId: configuration.agentId,
      sessionKey: identity.sessionKey,
      storePath: runtime.sessionStorePath,
      readConsistency: 'latest',
    });
    if (!sessionEntry && sessionPrepared) {
      sessionFailureCode = disappearedAfterResidueVerificationCode;
    }
    if (sessionEntry && !validManagedOneShotSessionBinding(sessionEntry, {
      configuration,
      model,
      identity,
    })) {
      throw runtimeError(
        'codex_openclaw_managed_session_cleanup_entry_binding_changed',
      );
    }
    if (sessionEntry) {
      sessionBindingAfterHash =
        managedOneShotSessionBindingHash(sessionEntry);
      let deletedOwnedEntry = false;
      sessionFailureFallbackCode =
        'codex_openclaw_managed_session_cleanup_entry_delete_failed';
      await runtime.updateSessionStore(
        runtime.sessionStorePath,
        (store) => {
          const current = store[identity.sessionKey];
          if (!current) {
            throw runtimeError(
              'codex_openclaw_managed_session_cleanup_entry_disappeared_during_delete',
            );
          }
          if (!validManagedOneShotSessionBinding(current, {
            configuration,
            model,
            identity,
          })) {
            throw runtimeError(
              'codex_openclaw_managed_session_cleanup_entry_binding_changed',
            );
          }
          delete store[identity.sessionKey];
          deletedOwnedEntry = true;
          return true;
        },
        {
          skipMaintenance: true,
          requireWriteSuccess: true,
        },
      );
      if (!deletedOwnedEntry) {
        throw runtimeError(
          'codex_openclaw_managed_session_cleanup_entry_delete_failed',
        );
      }
    }
    sessionFailureFallbackCode =
      'codex_openclaw_managed_session_cleanup_entry_residue_verification_failed';
    const remaining = runtime.getSessionEntry({
      agentId: configuration.agentId,
      sessionKey: identity.sessionKey,
      storePath: runtime.sessionStorePath,
      readConsistency: 'latest',
    });
    if (remaining) {
      throw runtimeError(
        'codex_openclaw_managed_session_cleanup_entry_remained',
      );
    }
    sessionEntryRemoved = true;
  } catch (error) {
    sessionFailureCode = exactManagedCleanupFailureCode(
      error,
      sessionFailureFallbackCode,
    );
  }
  {
    const expectedSessionTranscript = path.join(
      runtime.sessionsDir,
      `${identity.sessionId}.jsonl`,
    );
    try {
      const resolvedSessionTranscript = path.resolve(
        runtime.resolveSessionFilePath(
          identity.sessionId,
          sessionEntry || { sessionId: identity.sessionId },
          { sessionsDir: runtime.sessionsDir },
        ),
      );
      if (resolvedSessionTranscript !== expectedSessionTranscript) {
        throw runtimeError(
          'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
        );
      }
    } catch (error) {
      artifactFailureCode = exactManagedCleanupFailureCode(
        error,
        'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
      );
    }
    const reportedSessionFile = result?.meta?.agentMeta?.sessionFile;
    try {
      if (reportedSessionFile !== undefined) {
        const expectedInternalTranscript = path.join(
          runtime.internalRunsDir,
          `${identity.sessionId}.jsonl`,
        );
        if (!path.isAbsolute(String(reportedSessionFile || ''))
          || path.resolve(reportedSessionFile) !== expectedInternalTranscript) {
          throw runtimeError(
            'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
          );
        }
      }
    } catch (error) {
      artifactFailureCode ||= exactManagedCleanupFailureCode(
        error,
        'codex_openclaw_managed_session_cleanup_artifact_scope_invalid',
      );
    }
    const exactArtifacts = exactManagedOneShotArtifacts(
      runtime,
      identity.sessionId,
    );
    for (const candidate of exactArtifacts) {
      try {
        removeExactManagedArtifact(candidate);
      } catch {
        artifactFailureCode ||=
          'codex_openclaw_managed_session_cleanup_artifact_removal_failed';
      }
    }
    if (exactArtifacts.some(
      (candidate) => fs.existsSync(candidate),
    )) {
      artifactFailureCode ||=
        'codex_openclaw_managed_session_cleanup_artifact_residue_detected';
    }
    try {
      if (unexpectedManagedOneShotArtifacts(
        runtime,
        identity.sessionId,
      ).length > 0) {
        artifactFailureCode ||=
          'codex_openclaw_managed_session_cleanup_artifact_residue_detected';
      }
    } catch {
      artifactFailureCode ||=
        'codex_openclaw_managed_session_cleanup_artifact_residue_verification_failed';
    }
    artifactsRemoved = artifactFailureCode === null;
  }
  try {
    fs.rmSync(attemptWorkspace, { recursive: true, force: true });
    if (fs.existsSync(attemptWorkspace)) throw new Error('attempt workspace remained');
    attemptWorkspaceRemoved = true;
  } catch {
    workspaceFailureCode =
      'codex_openclaw_managed_session_cleanup_temporary_workspace_removal_failed';
  }
  const safetyFailureCode = (
    sessionFailureCode === disappearedAfterResidueVerificationCode
      ? null : sessionFailureCode
  ) || artifactFailureCode || workspaceFailureCode;
  if (safetyFailureCode) throw runtimeError(safetyFailureCode);
  if (sessionFailureCode === disappearedAfterResidueVerificationCode) {
    if (!sessionEntryRemoved || !artifactsRemoved || !attemptWorkspaceRemoved) {
      throw runtimeError(
        'codex_openclaw_managed_session_cleanup_residue_verification_failed',
      );
    }
    throw runtimeError(disappearedAfterResidueVerificationCode, {
      retryable: true,
    });
  }
  const cleanupProjection = Object.freeze({
    sessionEntryRemoved,
    artifactsRemoved,
    attemptWorkspaceRemoved,
  });
  return Object.freeze({
    sessionBindingAfterHash,
    sessionCleanup: cleanupProjection,
    sessionCleanupHash: hashRecord(
      'OpenClawManagedCodexAppServerSessionCleanup',
      cleanupProjection,
    ),
    verified: Object.values(cleanupProjection).every(Boolean),
  });
}

async function runManagedOneShotAgentCommandUnderLock({
  runtime,
  configuration,
  model,
  prompt,
  thinking,
  attemptId,
  abortSignal,
  timeoutMs,
} = {}) {
  const identity = managedOneShotSessionIdentity(configuration, attemptId);
  const attemptWorkspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hepta-managed-codex-app-server-'),
  );
  fs.chmodSync(attemptWorkspace, PRIVATE_DIRECTORY_MODE);
  let result = null;
  let thrown = null;
  let sessionPrepared = false;
  let sessionBindingBeforeHash = null;
  try {
    await runtime.upsertSessionEntry({
      agentId: configuration.agentId,
      sessionKey: identity.sessionKey,
      storePath: runtime.sessionStorePath,
      entry: managedOneShotSessionEntry({
        configuration,
        model,
        attemptId,
      }),
    });
    const preparedEntry = runtime.getSessionEntry({
      agentId: configuration.agentId,
      sessionKey: identity.sessionKey,
      storePath: runtime.sessionStorePath,
      readConsistency: 'latest',
    });
    if (!validManagedOneShotSessionBinding(preparedEntry, {
      configuration,
      model,
      identity,
    })) {
      throw runtimeError(
        'codex_openclaw_managed_session_binding_failed',
      );
    }
    sessionBindingBeforeHash =
      managedOneShotSessionBindingHash(preparedEntry);
    sessionPrepared = true;
    result = await runtime.agentCommand({
      message: prompt,
      agentId: configuration.agentId,
      provider: model.provider,
      model: model.modelId,
      sessionId: identity.sessionId,
      sessionKey: identity.sessionKey,
      runId: attemptId,
      lane: `hepta-paper-managed:${attemptId}`,
      thinking,
      timeout: String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      abortSignal,
      senderIsOwner: true,
      allowModelOverride: true,
      deliver: false,
      json: false,
      toolsAllow: [],
      disableMessageTool: true,
      bootstrapContextMode: 'lightweight',
      workspaceDir: attemptWorkspace,
      cwd: attemptWorkspace,
      cleanupBundleMcpOnRunEnd: true,
      cleanupCliLiveSessionOnRunEnd: true,
      oneShotCliRun: true,
      sessionEffects: 'internal',
      preserveUserFacingSessionModelState: true,
      suppressPromptPersistence: true,
      skipInitialSessionTouch: true,
      messageChannel: 'internal',
    }, runtime.silentRuntime);
  } catch (error) {
    thrown = error;
  }
  let cleanup;
  try {
    cleanup = await cleanupManagedOneShotSession({
      runtime,
      configuration,
      model,
      identity,
      result,
      attemptWorkspace,
      sessionPrepared,
    });
  } catch (error) {
    try {
      fs.rmSync(attemptWorkspace, { recursive: true, force: true });
    } catch { /* preserve the exact cleanup failure */ }
    if (result && error && typeof error === 'object') {
      error.managedInvocationFailure = Object.freeze({
        result,
        thrown,
        sessionBindingBeforeHash,
      });
    }
    throw error;
  }
  if (!sessionPrepared) {
    throw runtimeError('codex_openclaw_managed_session_binding_failed');
  }
  return Object.freeze({
    result,
    thrown,
    sessionBindingBeforeHash,
    sessionBindingAfterHash: cleanup.sessionBindingAfterHash,
    sessionCleanup: cleanup.sessionCleanup,
    sessionCleanupHash: cleanup.sessionCleanupHash,
    cleanupVerified: cleanup.verified,
  });
}

export async function runManagedOneShotAgentCommand(options = {}) {
  return await withCodexOpenClawManagedSessionStoreLifecycleLock(
    () => runManagedOneShotAgentCommandUnderLock(options),
    {
      sessionsDir: options.runtime?.sessionsDir,
      timeoutMs: options.timeoutMs,
      signal: options.abortSignal,
    },
  );
}

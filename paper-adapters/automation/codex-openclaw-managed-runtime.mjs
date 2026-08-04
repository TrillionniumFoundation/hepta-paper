import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
  loadOpenClawModelRuntime,
  openClawModelRuntimeProvenance,
  readCodexOpenClawManagedConfiguration,
  verifyOpenClawModelRuntimeProvenance,
} from './codex-openclaw-managed-configuration.mjs';
import {
  managedAuthEvidence,
} from './codex-openclaw-managed-execution-evidence.mjs';
import {
  buildOpenClawManagedFailureExecutionBinding,
  OPENCLAW_MANAGED_INVOCATION_ID_ENV,
  OPENCLAW_MANAGED_PRINCIPAL_ID_ENV,
} from './codex-openclaw-managed-failure-execution-binding.mjs';
import {
  isCodexAvailabilityCanary,
  normalizeStructuredResponse,
  callManagedModel,
} from './codex-openclaw-managed-model-call.mjs';
import {
  failureWithCompletedManagedUsage,
  verifyExplicitProfileAvailable,
} from './codex-openclaw-managed-model-support.mjs';
import {
  runtimeError,
  safeEnvironment,
  sha256,
} from './codex-openclaw-managed-runtime-common.mjs';
import {
  applyManagedEdits,
  buildManagedWorkspaceSnapshot,
  managedPrompt,
  normalizedModel,
  parseExecArguments,
  parseManagedStructuredOutput,
  parseOpenClawManagedExecutionMetadata,
  validateStructuredResponse,
  verifyManagedConfigurationUnchanged,
  verifyManagedWorkspaceSnapshot,
  verifyWorkspaceSeparatedFromManagedState,
} from './codex-openclaw-managed-workspace-repository.mjs';

const DEFAULT_MODEL_TIMEOUT_MS = 45 * 60 * 1000;

export {
  loadOpenClawModelRuntime,
  readCodexOpenClawManagedConfiguration,
};
export {
  provisionCodexOpenClawManagedHome,
} from './codex-openclaw-managed-home-repository.mjs';
export {
  OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD,
  OPENCLAW_MANAGED_EXECUTION_METADATA_PREFIX,
} from './codex-openclaw-managed-runtime-common.mjs';
export {
  withCodexOpenClawManagedSessionStoreLifecycleLock,
  withCodexOpenClawManagedStdoutIsolation,
} from './codex-openclaw-managed-lifecycle.mjs';
export {
  buildOpenClawManagedExecutionMetadata,
  buildManagedWorkspaceSnapshot,
  parseManagedStructuredOutput,
  applyManagedEdits,
} from './codex-openclaw-managed-workspace-repository.mjs';
export {
  buildOpenClawManagedFailureEvidence,
  verifyOpenClawManagedFailureEvidence,
} from './codex-openclaw-managed-usage-evidence.mjs';
export {
  verifyOpenClawManagedExecutionEvidence,
} from './codex-openclaw-managed-execution-evidence.mjs';

function bindManagedFailureExecution(error, failureExecutionBinding) {
  if (!failureExecutionBinding) return error;
  try {
    error.openClawManagedFailureExecutionBinding = failureExecutionBinding;
    return error;
  } catch {
    throw runtimeError(
      'codex_openclaw_managed_failure_execution_binding_attachment_failed',
    );
  }
}

function managedFailureExecutionBindingRequested(environment) {
  return Boolean(
    environment?.[OPENCLAW_MANAGED_INVOCATION_ID_ENV]
      || environment?.[OPENCLAW_MANAGED_PRINCIPAL_ID_ENV]
      || environment?.HEPTA_AUTOMATION_ROLE,
  );
}

export async function executeCodexOpenClawManaged({
  args,
  stdin,
  environment = process.env,
  timeoutMs = DEFAULT_MODEL_TIMEOUT_MS,
  signal = null,
  modelRuntimeLoader = loadOpenClawModelRuntime,
} = {}) {
  const configuration = readCodexOpenClawManagedConfiguration({ environment });
  const execution = parseExecArguments(args);
  verifyWorkspaceSeparatedFromManagedState({
    workspace: execution.workspace,
    configuration,
    environment,
  });
  const model = normalizedModel(execution.model, configuration.model);
  const originalPrompt = String(stdin || '');
  if (!originalPrompt.trim()) {
    throw runtimeError('codex_openclaw_managed_prompt_required');
  }
  if (isCodexAvailabilityCanary(originalPrompt, execution.sandbox)) {
    let failureExecutionBinding = null;
    if (managedFailureExecutionBindingRequested(environment)) {
      const executionMetadata = parseOpenClawManagedExecutionMetadata(
        originalPrompt,
        execution.sandbox,
      );
      const snapshot = buildManagedWorkspaceSnapshot({
        workspace: execution.workspace,
        maximumContextBytes: configuration.maximumContextBytes,
        maximumFileCount: configuration.maximumFileCount,
      });
      failureExecutionBinding = buildOpenClawManagedFailureExecutionBinding({
        environment,
        originalPrompt,
        execution,
        executionMetadata,
        configuration,
        snapshot,
      });
    }
    let managed;
    try {
      managed = await callManagedModel({
        configuration,
        model,
        prompt: originalPrompt,
        timeoutMs,
        signal,
        maximumAttempts: 1,
        modelRuntimeLoader,
      });
    } catch (error) {
      throw bindManagedFailureExecution(error, failureExecutionBinding);
    }
    if (!/^HEPTA_CODEX_CANARY_RESPONSE:-?\d+$/.test(managed.text)) {
      throw bindManagedFailureExecution(
        failureWithCompletedManagedUsage(
          runtimeError('codex_openclaw_managed_canary_response_invalid'),
          managed,
        ),
        failureExecutionBinding,
      );
    }
    return Object.freeze({ stdout: `${managed.text}\n`, changedPaths: Object.freeze([]) });
  }
  const executionMetadata = parseOpenClawManagedExecutionMetadata(
    originalPrompt,
    execution.sandbox,
  );
  const snapshot = buildManagedWorkspaceSnapshot({
    workspace: execution.workspace,
    maximumContextBytes: configuration.maximumContextBytes,
    maximumFileCount: configuration.maximumFileCount,
  });
  const failureExecutionBinding =
    buildOpenClawManagedFailureExecutionBinding({
      environment,
      originalPrompt,
      execution,
      executionMetadata,
      configuration,
      snapshot,
    });
  const prompt = managedPrompt({
    originalPrompt,
    snapshot,
    sandbox: execution.sandbox,
    configuration,
    model,
  });
  let managed;
  try {
    managed = await callManagedModel({
      configuration,
      model,
      prompt,
      timeoutMs,
      signal,
      modelRuntimeLoader,
    });
  } catch (error) {
    throw bindManagedFailureExecution(error, failureExecutionBinding);
  }
  try {
    const parsed = parseManagedStructuredOutput(managed.text);
    const validation = validateStructuredResponse(parsed);
    verifyManagedConfigurationUnchanged(configuration, environment);
    verifyManagedWorkspaceSnapshot({
      workspace: execution.workspace,
      snapshot,
    });
    const changedPaths = applyManagedEdits({
      workspace: execution.workspace,
      edits: parsed.edits,
      sandbox: execution.sandbox,
      snapshot,
      workspaceMutationPolicy: executionMetadata.workspaceMutationPolicy,
    });
    const managedAuth = managedAuthEvidence({
      managed,
      snapshot,
      configuration,
      changedPaths,
      validation,
      originalPromptHash: sha256(originalPrompt),
    });
    const output = normalizeStructuredResponse(parsed, validation, managedAuth);
    return Object.freeze({
      stdout: `${JSON.stringify(output)}\n`,
      changedPaths,
      managedAuth,
    });
  } catch (error) {
    throw bindManagedFailureExecution(
      failureWithCompletedManagedUsage(error, managed),
      failureExecutionBinding,
    );
  }
}

export async function verifyCodexOpenClawManagedLogin({
  environment = process.env,
  modelRuntimeLoader = loadOpenClawModelRuntime,
} = {}) {
  const configuration = readCodexOpenClawManagedConfiguration({ environment });
  let runtime;
  let primaryFailure = null;
  try {
    runtime = await modelRuntimeLoader(configuration);
    if (!verifyOpenClawModelRuntimeProvenance(runtime?.runtimeProvenance)) {
      throw runtimeError(
        'codex_openclaw_managed_model_runtime_provenance_invalid',
      );
    }
    verifyExplicitProfileAvailable({ runtime, configuration });
    return Object.freeze({ agentId: configuration.agentId });
  } catch (error) {
    primaryFailure = error?.code
      ? error
      : runtimeError(
        'codex_openclaw_managed_login_unavailable',
        { retryable: true },
      );
    throw primaryFailure;
  } finally {
    try {
      if (typeof runtime?.disposeRegisteredAgentHarnesses === 'function') {
        await runtime.disposeRegisteredAgentHarnesses();
      }
    } catch {
      if (!primaryFailure) {
        throw runtimeError(
          'codex_openclaw_managed_agent_runtime_disposal_failed',
          { retryable: true },
        );
      }
    }
  }
}

export function codexOpenClawManagedVersion({
  environment = process.env,
} = {}) {
  let openClawVersion = 'OpenClaw version unavailable';
  const bridgeIdentity = sha256(fs.readFileSync(new URL(import.meta.url)))
    .slice('sha256:'.length, 'sha256:'.length + 16);
  let runtimeIdentity = 'unavailable';
  try {
    const configuration = readCodexOpenClawManagedConfiguration({ environment });
    runtimeIdentity = openClawModelRuntimeProvenance(
      configuration.openclawBinary,
    ).openClawManagedRuntimeProvenanceHash
      .slice('sha256:'.length, 'sha256:'.length + 16);
    const result = spawnSync(configuration.openclawBinary, ['--version'], {
      encoding: 'utf8',
      env: safeEnvironment(environment),
      timeout: 5000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const line = String(result.stdout || result.stderr || '')
      .trim().split(/\r?\n/)[0].slice(0, 160);
    if (!result.error && result.status === 0 && /^OpenClaw\b/.test(line)) {
      openClawVersion = line;
    }
  } catch { /* the basic version surface remains available for diagnostics */ }
  return [
    'codex-openclaw-managed 3',
    `bridge=${bridgeIdentity}`,
    `runtime=${runtimeIdentity}`,
    `(${openClawVersion})`,
  ].join(' ');
}

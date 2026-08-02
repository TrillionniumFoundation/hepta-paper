import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

import {
  SAFE_AGENT_ID,
  SAFE_ROLE,
  runtimeError,
  sha256,
} from './codex-openclaw-managed-runtime-common.mjs';

export const OPENCLAW_MANAGED_INVOCATION_ID_ENV =
  'HEPTA_CODEX_OPENCLAW_MANAGED_INVOCATION_ID';
export const OPENCLAW_MANAGED_PRINCIPAL_ID_ENV =
  'HEPTA_CODEX_OPENCLAW_MANAGED_PRINCIPAL_ID';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const INVOCATION_ID =
  /^codex-exec:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRINCIPAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const BINDING_KEYS = Object.freeze([
  'agentId',
  'configurationHash',
  'executionInvocationId',
  'executionRole',
  'failureExecutionBindingHash',
  'kind',
  'openClawManagedAuthSourceIdentityHash',
  'originalPromptHash',
  'principalId',
  'principalRole',
  'sandbox',
  'sourceSnapshotBytes',
  'sourceSnapshotFileCount',
  'sourceSnapshotHash',
  'version',
  'workspacePathHash',
]);

function workspacePathHash(workspace) {
  return hashRecord('OpenClawManagedCodexWorkspacePath', {
    workspace: String(workspace || ''),
  });
}

function exactBindingShape(binding) {
  return Boolean(binding && typeof binding === 'object' && !Array.isArray(binding)
    && JSON.stringify(Object.keys(binding).sort())
      === JSON.stringify([...BINDING_KEYS].sort()));
}

export function buildOpenClawManagedFailureExecutionBinding({
  environment = process.env,
  originalPrompt,
  execution,
  executionMetadata,
  configuration,
  snapshot,
} = {}) {
  const executionInvocationId = String(
    environment?.[OPENCLAW_MANAGED_INVOCATION_ID_ENV] || '',
  ).trim();
  const principalId = String(
    environment?.[OPENCLAW_MANAGED_PRINCIPAL_ID_ENV] || '',
  ).trim();
  const executionRole = String(environment?.HEPTA_AUTOMATION_ROLE || '').trim();
  const bindingRequested = Boolean(
    executionInvocationId || principalId || executionRole,
  );
  if (!bindingRequested) return null;
  if (!INVOCATION_ID.test(executionInvocationId)
    || !PRINCIPAL_ID.test(principalId)
    || !SAFE_ROLE.test(executionRole)
    || executionRole !== executionMetadata?.role
    || !['read-only', 'workspace-write'].includes(execution?.sandbox)
    || execution?.sandbox !== executionMetadata?.sandbox
    || !SAFE_AGENT_ID.test(String(configuration?.agentId || ''))
    || !SAFE_ROLE.test(String(configuration?.principalRole || ''))
    || !SHA256.test(String(configuration?.configurationHash || ''))
    || !SHA256.test(String(
      configuration?.openClawManagedAuthSourceIdentityHash || '',
    ))
    || !SHA256.test(String(snapshot?.snapshotHash || ''))
    || !Number.isSafeInteger(snapshot?.fileCount) || snapshot.fileCount < 0
    || !Number.isSafeInteger(snapshot?.byteCount) || snapshot.byteCount < 0) {
    throw runtimeError(
      'codex_openclaw_managed_failure_execution_binding_invalid',
    );
  }
  const payload = {
    version: 1,
    kind: 'OpenClawManagedCodexFailureExecutionBinding',
    executionInvocationId,
    originalPromptHash: sha256(String(originalPrompt || '')),
    configurationHash: configuration.configurationHash,
    openClawManagedAuthSourceIdentityHash:
      configuration.openClawManagedAuthSourceIdentityHash,
    agentId: configuration.agentId,
    principalId,
    principalRole: configuration.principalRole,
    executionRole,
    sandbox: execution.sandbox,
    workspacePathHash: workspacePathHash(execution.workspace),
    sourceSnapshotHash: snapshot.snapshotHash,
    sourceSnapshotFileCount: snapshot.fileCount,
    sourceSnapshotBytes: snapshot.byteCount,
  };
  return Object.freeze({
    ...payload,
    failureExecutionBindingHash: hashRecord(
      'OpenClawManagedCodexFailureExecutionBinding',
      payload,
    ),
  });
}

export function expectedOpenClawManagedFailureExecutionBinding({
  executionInvocationId,
  originalPromptHash,
  configurationHash,
  expectedAuthSourceIdentityHash,
  principalId,
  principalRole,
  executionRole,
  sandbox,
  workspace,
} = {}) {
  return Object.freeze({
    executionInvocationId,
    originalPromptHash,
    configurationHash,
    openClawManagedAuthSourceIdentityHash: expectedAuthSourceIdentityHash,
    principalId,
    principalRole,
    executionRole,
    sandbox,
    workspacePathHash: workspacePathHash(workspace),
  });
}

export function openClawManagedFailureExecutorBinding({
  capabilityReceipt,
  executionInvocationId,
  executionRole,
  principalId,
  principalRole,
  originalPromptHash,
  sandbox,
  workspace,
} = {}) {
  return Object.freeze({
    environmentOverrides: Object.freeze({
      [OPENCLAW_MANAGED_INVOCATION_ID_ENV]: executionInvocationId,
      [OPENCLAW_MANAGED_PRINCIPAL_ID_ENV]: principalId,
    }),
    expectedFailureExecutionBinding:
      expectedOpenClawManagedFailureExecutionBinding({
        executionInvocationId,
        originalPromptHash,
        configurationHash:
          capabilityReceipt?.openClawManagedConfigurationHash,
        expectedAuthSourceIdentityHash:
          capabilityReceipt?.openClawManagedAuthSourceIdentityHash,
        principalId,
        principalRole,
        executionRole,
        sandbox,
        workspace,
      }),
  });
}

export function verifyOpenClawManagedFailureExecutionBinding(
  binding,
  { expected = null } = {},
) {
  if (!exactBindingShape(binding)) return false;
  const {
    failureExecutionBindingHash: claimedHash,
    ...payload
  } = binding;
  const structurallyValid = binding.version === 1
    && binding.kind === 'OpenClawManagedCodexFailureExecutionBinding'
    && INVOCATION_ID.test(String(binding.executionInvocationId || ''))
    && SHA256.test(String(binding.originalPromptHash || ''))
    && SHA256.test(String(binding.configurationHash || ''))
    && SHA256.test(String(
      binding.openClawManagedAuthSourceIdentityHash || '',
    ))
    && SAFE_AGENT_ID.test(String(binding.agentId || ''))
    && PRINCIPAL_ID.test(String(binding.principalId || ''))
    && SAFE_ROLE.test(String(binding.principalRole || ''))
    && SAFE_ROLE.test(String(binding.executionRole || ''))
    && ['read-only', 'workspace-write'].includes(binding.sandbox)
    && SHA256.test(String(binding.workspacePathHash || ''))
    && SHA256.test(String(binding.sourceSnapshotHash || ''))
    && Number.isSafeInteger(binding.sourceSnapshotFileCount)
    && binding.sourceSnapshotFileCount >= 0
    && Number.isSafeInteger(binding.sourceSnapshotBytes)
    && binding.sourceSnapshotBytes >= 0
    && claimedHash === hashRecord(
      'OpenClawManagedCodexFailureExecutionBinding',
      payload,
    );
  if (!structurallyValid) return false;
  if (expected === null) return true;
  const expectedKeys = [
    'configurationHash',
    'executionInvocationId',
    'executionRole',
    'openClawManagedAuthSourceIdentityHash',
    'originalPromptHash',
    'principalId',
    'principalRole',
    'sandbox',
    'workspacePathHash',
  ];
  return expectedKeys.every((key) => binding[key] === expected?.[key]);
}

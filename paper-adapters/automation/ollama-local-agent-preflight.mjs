import { spawnSync } from 'node:child_process';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const LOCAL_OLLAMA_HOST = 'http://127.0.0.1:11434';

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,255}$/;
const ROLE = new Set(['research-author', 'formal-reviewer']);

function errorCode(result) {
  return String(
    result?.error?.message
      || result?.stderr
      || result?.signal
      || `exit_${result?.status}`,
  ).trim().replace(/\s+/g, '_').slice(0, 240);
}

export function preflightLocalOllamaResearchAgent({
  role,
  model,
  ollamaBinary = '/usr/local/bin/ollama',
  environment = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const selectedRole = String(role || '').trim();
  const selectedModel = String(model || '').trim();
  if (!ROLE.has(selectedRole)) {
    throw new Error(`local_ollama_research_agent_role_invalid:${selectedRole || '<empty>'}`);
  }
  if (!MODEL.test(selectedModel)) {
    throw new Error(`local_ollama_research_agent_model_invalid:${selectedModel || '<empty>'}`);
  }
  const result = spawnSyncImpl(ollamaBinary, ['show', selectedModel, '--modelfile'], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: Object.freeze({
      ...process.env,
      ...environment,
      OLLAMA_HOST: LOCAL_OLLAMA_HOST,
    }),
  });
  const modelDefinition = String(result?.stdout || '').trim();
  if (result?.status !== 0 || result?.signal || result?.error || !modelDefinition) {
    throw new Error(`local_ollama_research_agent_unavailable:${errorCode(result)}`);
  }
  const modelIdentityHash = hashBytes(modelDefinition);
  const runtimeIdentityHash = hashRecord('LocalOllamaRuntimeIdentity', {
    host: LOCAL_OLLAMA_HOST,
    model: selectedModel,
    modelIdentityHash,
  });
  const roleConfigurationHash = hashRecord('LocalOllamaResearchAgentRoleConfiguration', {
    role: selectedRole,
    runtimeIdentityHash,
    statelessGenerateApi: true,
    isolatedWorkspaceRequired: true,
  });
  const principalHash = hashRecord('LocalOllamaResearchAgentPrincipal', {
    role: selectedRole,
    roleConfigurationHash,
  }).slice('sha256:'.length, 'sha256:'.length + 32);
  const effectivePrincipalId = `ollama-local-${selectedRole}:${principalHash}`;
  const payload = {
    version: 1,
    kind: 'LocalOllamaResearchAgentCapabilityReceipt',
    status: 'local_ollama_research_agent_capability_ready',
    localOnly: true,
    provider: 'ollama',
    role: selectedRole,
    model: selectedModel,
    ollamaHost: LOCAL_OLLAMA_HOST,
    modelIdentityHash,
    runtimeIdentityHash,
    roleConfigurationHash,
    effectivePrincipalId,
    statelessGenerateApi: true,
    isolatedWorkspaceRequired: true,
    externalActionPerformed: false,
  };
  const capabilityReceipt = Object.freeze({
    ...payload,
    localOllamaResearchAgentCapabilityReceiptHash: hashRecord(
      'LocalOllamaResearchAgentCapabilityReceipt',
      payload,
    ),
  });
  return Object.freeze({
    effectivePrincipalId,
    model: selectedModel,
    ollamaHost: LOCAL_OLLAMA_HOST,
    modelIdentityHash,
    capabilityReceipt,
  });
}

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { restrictedChildEnvironment, runBoundedChildProcess } from './bounded-child-process.mjs';

const SAFE_WORKSPACE_WRITE_TOOLS = Object.freeze([
  'apply_patch',
  'edit',
  'exec',
  'process',
  'read',
  'write',
]);
const SAFE_READ_ONLY_TOOLS = Object.freeze(['read']);
const MAXIMUM_PIDS = 128;
const MAXIMUM_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
const MAXIMUM_CPUS = 4;

function fail(code) {
  throw new Error(code);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyObject(value) {
  return Object.keys(object(value)).length > 0;
}

function nonEmptyArray(value) {
  return array(value).length > 0;
}

function parseJsonOutput(result, code) {
  if (!result || result.exitCode !== 0 || result.error || result.timedOut || result.aborted || result.outputTruncated) {
    fail(code);
  }
  try {
    const parsed = JSON.parse(String(result.stdout || '').trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(code);
    return parsed;
  } catch {
    fail(code);
  }
}

function isLoopbackGatewayUrl(value) {
  try {
    const candidate = new URL(value);
    return candidate.protocol === 'ws:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(candidate.hostname);
  } catch {
    return false;
  }
}

export function createOpenClawRuntimeConfigurationResolver({
  openclawBinary = 'openclaw',
  spawnImpl = spawn,
  timeoutMs = 15000,
  environment = restrictedChildEnvironment({
    allowedKeys: [
      'OPENCLAW_HOME',
      'OPENCLAW_CONFIG_PATH',
      'OPENCLAW_PROFILE',
      'OPENCLAW_GATEWAY_URL',
      'OPENCLAW_GATEWAY_TOKEN',
    ],
  }),
} = {}) {
  return async function resolveOpenClawRuntimeConfiguration({ cwd } = {}) {
    const probe = parseJsonOutput(await runBoundedChildProcess({
      spawnImpl,
      executable: openclawBinary,
      args: ['gateway', 'probe', '--json', '--timeout', String(Math.max(1000, Math.min(timeoutMs, 15000)))],
      cwd,
      env: environment,
      timeoutMs,
    }), 'openclaw_agent_gateway_probe_failed');
    const primaryTarget = array(probe.targets).find((target) => target?.id === probe.primaryTargetId);
    if (probe.ok !== true
      || probe.degraded === true
      || probe.primaryTargetId !== 'localLoopback'
      || primaryTarget?.kind !== 'localLoopback'
      || primaryTarget?.connect?.rpcOk !== true
      || typeof primaryTarget?.self?.instanceId !== 'string'
      || !primaryTarget.self.instanceId
      || !isLoopbackGatewayUrl(primaryTarget.url)) {
      fail('openclaw_agent_remote_gateway_workspace_scope_unverifiable');
    }
    const snapshot = parseJsonOutput(await runBoundedChildProcess({
      spawnImpl,
      executable: openclawBinary,
      args: [
        'gateway',
        'call',
        'config.get',
        '--url',
        primaryTarget.url,
        '--params',
        '{}',
        '--json',
        '--timeout',
        String(Math.max(1000, Math.min(timeoutMs, 15000))),
      ],
      cwd,
      env: environment,
      timeoutMs,
      maximumCapturedBytes: 4 * 1024 * 1024,
    }), 'openclaw_agent_runtime_configuration_resolution_failed');
    return Object.freeze({
      gatewayInstanceId: primaryTarget.self.instanceId,
      gatewayUrl: primaryTarget.url,
      gatewayConfigPath: primaryTarget.config?.path || snapshot.path || null,
      snapshot,
    });
  };
}

function selectAgentConfiguration(resolved, agentId) {
  const snapshot = object(resolved?.snapshot);
  const runtimeConfig = object(snapshot.runtimeConfig || snapshot.config);
  const agents = object(runtimeConfig.agents);
  const matches = array(agents.list).filter((candidate) => candidate?.id === agentId);
  if (snapshot.valid !== true
    || !/^[a-f0-9]{64}$/i.test(String(snapshot.hash || ''))
    || typeof resolved?.gatewayInstanceId !== 'string'
    || !resolved.gatewayInstanceId
    || !isLoopbackGatewayUrl(resolved?.gatewayUrl)) {
    fail('openclaw_agent_runtime_configuration_invalid');
  }
  if (matches.length === 0) fail('openclaw_agent_runtime_configuration_missing');
  if (matches.length !== 1) fail('openclaw_agent_runtime_configuration_ambiguous');
  return {
    gatewayConfigHash: `sha256:${snapshot.hash.toLowerCase()}`,
    gatewayInstanceId: resolved.gatewayInstanceId,
    gatewayUrl: resolved.gatewayUrl,
    globalTools: object(runtimeConfig.tools),
    defaults: object(agents.defaults),
    agent: matches[0],
  };
}

function securityProjection(selected) {
  const defaults = selected.defaults;
  return Object.freeze({
    version: 1,
    kind: 'OpenClawAgentRuntimeSecurityConfiguration',
    gatewayInstanceId: selected.gatewayInstanceId,
    agentId: selected.agent.id,
    agent: {
      runtime: selected.agent.runtime ?? null,
      workspace: selected.agent.workspace ?? null,
      skills: selected.agent.skills ?? null,
      subagents: selected.agent.subagents ?? null,
      sandbox: selected.agent.sandbox ?? null,
      tools: selected.agent.tools ?? null,
    },
    inherited: {
      sandbox: defaults.sandbox ?? null,
      tools: defaults.tools ?? null,
    },
    globalToolPolicy: selected.globalTools,
  });
}

export function openClawAgentConfigurationHash(resolvedConfiguration, agentId) {
  return hashRecord(
    'OpenClawAgentRuntimeSecurityConfiguration',
    securityProjection(selectAgentConfiguration(resolvedConfiguration, agentId)),
  );
}

export function openClawGatewayConfigurationHash(resolvedConfiguration, agentId) {
  return selectAgentConfiguration(resolvedConfiguration, agentId).gatewayConfigHash;
}

function deepMerge(left, right) {
  const merged = { ...object(left) };
  for (const [key, value] of Object.entries(object(right))) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = deepMerge(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function assertNoToolExpansion(tools) {
  const source = object(tools);
  if (nonEmptyArray(source.alsoAllow)
    || nonEmptyObject(source.byProvider)
    || nonEmptyObject(source.toolsBySender)
    || nonEmptyArray(source.sandbox?.tools?.alsoAllow)
    || nonEmptyArray(source.subagents?.tools?.alsoAllow)) {
    fail('openclaw_agent_configuration_tool_expansion_forbidden');
  }
}

function assertSafeToolList(value, allowed, required = false) {
  if (required && (!Array.isArray(value) || value.length === 0)) {
    fail('openclaw_agent_configuration_absolute_tool_allowlist_required');
  }
  const tools = array(value);
  if (new Set(tools).size !== tools.length
    || tools.some((tool) => typeof tool !== 'string' || !allowed.includes(tool))) {
    fail('openclaw_agent_configuration_tool_policy_not_least_authority');
  }
  return tools;
}

function dockerBytes(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const match = String(value || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)$/);
  if (!match) return NaN;
  const units = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3 };
  return Number(match[1]) * units[match[2]];
}

function assertExactWorkspace(configuredWorkspace, workspace) {
  if (typeof configuredWorkspace !== 'string' || !path.isAbsolute(configuredWorkspace)) {
    fail('openclaw_agent_workspace_scope_unverifiable');
  }
  let configured;
  let requested;
  try {
    configured = fs.realpathSync(configuredWorkspace);
    requested = fs.realpathSync(workspace);
  } catch {
    fail('openclaw_agent_workspace_scope_unverifiable');
  }
  if (configured !== requested) fail('openclaw_agent_dynamic_workspace_not_config_bound');
}

function assertSandboxPolicy({ defaults, agent, workspace, sandbox }) {
  const effective = deepMerge(defaults.sandbox, agent.sandbox);
  const docker = object(effective.docker);
  if (effective.mode !== 'all'
    || effective.backend !== 'docker'
    || effective.scope !== 'session'
    || effective.workspaceAccess !== (sandbox === 'read-only' ? 'ro' : 'rw')
    || docker.network !== 'none'
    || docker.readOnlyRoot !== true
    || !array(docker.capDrop).includes('ALL')
    || nonEmptyArray(object(defaults.sandbox).docker?.binds)
    || nonEmptyArray(object(agent.sandbox).docker?.binds)
    || nonEmptyArray(docker.binds)
    || nonEmptyObject(docker.env)
    || docker.setupCommand !== undefined
    || docker.seccompProfile !== undefined
    || docker.apparmorProfile !== undefined
    || nonEmptyArray(docker.dns)
    || nonEmptyArray(docker.extraHosts)
    || docker.dangerouslyAllowReservedContainerTargets === true
    || docker.dangerouslyAllowExternalBindSources === true
    || docker.dangerouslyAllowContainerNamespaceJoin === true
    || effective.ssh !== undefined
    || effective.browser?.enabled === true
    || effective.browser?.allowHostControl === true
    || nonEmptyArray(effective.browser?.binds)) {
    fail('openclaw_agent_configuration_sandbox_not_least_authority');
  }
  if (!Number.isInteger(docker.pidsLimit)
    || docker.pidsLimit <= 0
    || docker.pidsLimit > MAXIMUM_PIDS
    || !Number.isFinite(docker.cpus)
    || docker.cpus <= 0
    || docker.cpus > MAXIMUM_CPUS) {
    fail('openclaw_agent_configuration_resource_limits_invalid');
  }
  const memory = dockerBytes(docker.memory);
  const memorySwap = dockerBytes(docker.memorySwap);
  if (!Number.isFinite(memory)
    || memory <= 0
    || memory > MAXIMUM_MEMORY_BYTES
    || memorySwap !== memory
    || !/^[1-9]\d*(?::[1-9]\d*)?$/.test(String(docker.user || ''))
    || docker.gpus !== undefined) {
    fail('openclaw_agent_configuration_resource_limits_invalid');
  }
  assertExactWorkspace(agent.workspace, workspace);
}

function assertToolPolicy({ globalTools, defaults, agent, sandbox }) {
  assertNoToolExpansion(globalTools);
  assertNoToolExpansion(defaults.tools);
  assertNoToolExpansion(agent.tools);
  const tools = object(agent.tools);
  const allowed = sandbox === 'read-only' ? SAFE_READ_ONLY_TOOLS : SAFE_WORKSPACE_WRITE_TOOLS;
  const allow = assertSafeToolList(tools.allow, allowed, true);
  assertSafeToolList(tools.sandbox?.tools?.allow, allowed);
  assertSafeToolList(tools.subagents?.tools?.allow, [], false);
  const execAllowed = allow.includes('exec');
  const exec = object(tools.exec);
  if (tools.fs?.workspaceOnly !== true
    || tools.exec?.applyPatch?.workspaceOnly !== true
    || tools.elevated?.enabled !== false
    || nonEmptyObject(tools.elevated?.allowFrom)
    || exec.host !== 'sandbox'
    || exec.node !== undefined
    || nonEmptyArray(exec.pathPrepend)
    || nonEmptyArray(exec.safeBins)
    || nonEmptyArray(exec.safeBinTrustedDirs)
    || nonEmptyObject(exec.safeBinProfiles)
    || exec.reviewer !== undefined
    || exec.ask !== 'off') {
    fail('openclaw_agent_configuration_tool_policy_not_least_authority');
  }
  if (execAllowed) {
    if (exec.mode !== 'allowlist' || exec.security !== 'allowlist' || exec.strictInlineEval !== true) {
      fail('openclaw_agent_configuration_tool_policy_not_least_authority');
    }
  } else if (exec.mode !== 'deny' || exec.security !== 'deny') {
    fail('openclaw_agent_configuration_tool_policy_not_least_authority');
  }
}

export function verifyOpenClawAgentConfiguration({
  resolvedConfiguration,
  agentId,
  workspace,
  sandbox,
} = {}) {
  const selected = selectAgentConfiguration(resolvedConfiguration, agentId);
  const configurationHash = hashRecord(
    'OpenClawAgentRuntimeSecurityConfiguration',
    securityProjection(selected),
  );
  if (selected.agent.runtime?.type !== 'embedded'
    || !Array.isArray(selected.agent.skills)
    || selected.agent.skills.length !== 0
    || !Array.isArray(selected.agent.subagents?.allowAgents)
    || selected.agent.subagents.allowAgents.length !== 0) {
    fail('openclaw_agent_configuration_delegated_authority_forbidden');
  }
  assertSandboxPolicy({ defaults: selected.defaults, agent: selected.agent, workspace, sandbox });
  assertToolPolicy({ globalTools: selected.globalTools, defaults: selected.defaults, agent: selected.agent, sandbox });
  return Object.freeze({
    configurationHash,
    gatewayConfigHash: selected.gatewayConfigHash,
    gatewayInstanceId: selected.gatewayInstanceId,
    gatewayUrl: selected.gatewayUrl,
  });
}

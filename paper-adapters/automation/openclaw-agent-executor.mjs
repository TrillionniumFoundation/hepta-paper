import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { restrictedChildEnvironment, runBoundedChildProcess } from './bounded-child-process.mjs';
import { createAgentExecutorTemplate, isExternalAgentCancellation } from './agent-executor-template.mjs';
import {
  createOpenClawRuntimeConfigurationResolver,
  openClawAgentConfigurationHash,
  openClawGatewayConfigurationHash,
  verifyOpenClawAgentConfiguration,
} from './openclaw-agent-configuration.mjs';
import { readOnlyMutationBlockers } from './workspace-change-tracker.mjs';

function parseResult(stdout) {
  const source = String(stdout || '').trim();
  if (!source) return null;
  try { return JSON.parse(source); } catch { /* CLI diagnostics may precede JSON */ }
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines.slice(index).join('\n');
    try { return JSON.parse(candidate); } catch { /* continue */ }
  }
  return null;
}

function responseText(parsed, stdout) {
  const candidates = [
    parsed?.result?.payloads?.[0]?.text,
    parsed?.result?.meta?.finalAssistantVisibleText,
    parsed?.result?.meta?.finalAssistantRawText,
    parsed?.response,
    parsed?.reply,
    parsed?.message,
    parsed?.result?.response,
    parsed?.result?.reply,
    parsed?.result?.message,
    parsed?.payload?.text,
  ];
  const value = candidates.find((item) => typeof item === 'string');
  return value || String(stdout || '').slice(-16000);
}

function parseAgentOutput(text) {
  const source = String(text || '').trim();
  try { return JSON.parse(source); } catch { /* bounded agent output can contain prose */ }
  const match = source.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

export function openClawAgentCapabilityProfileHash(profile) {
  return hashRecord('OpenClawAgentCapabilityProfile', profile);
}

function assertExactKeys(value, expected, code) {
  const actual = Object.keys(value || {}).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(code);
  }
}

function resolveAgentCapabilityProfile({
  agentId,
  profile,
  profilePath,
  expectedHash,
}) {
  const source = profile || (profilePath
    ? JSON.parse(fs.readFileSync(path.resolve(profilePath), 'utf8'))
    : null);
  if (!source) throw new Error('openclaw_agent_capability_profile_required');
  assertExactKeys(source, [
    'version',
    'kind',
    'agentId',
    'enforcement',
    'delivery',
    'toolPolicy',
    'openClawAgentConfigurationHash',
    'openClawGatewayConfigurationHash',
  ], 'openclaw_agent_capability_profile_shape_invalid');
  assertExactKeys(source.toolPolicy, ['messaging', 'externalMutation', 'credentialAccess'], 'openclaw_agent_capability_profile_tool_policy_invalid');
  if (source.version !== 2
    || source.kind !== 'OpenClawAgentCapabilityProfile'
    || source.agentId !== agentId
    || source.enforcement !== 'openclaw-gateway-runtime-configuration'
    || source.delivery !== 'disabled'
    || source.toolPolicy.messaging !== 'denied'
    || source.toolPolicy.externalMutation !== 'denied'
    || source.toolPolicy.credentialAccess !== 'denied'
    || !/^sha256:[a-f0-9]{64}$/i.test(source.openClawAgentConfigurationHash)
    || !/^sha256:[a-f0-9]{64}$/i.test(source.openClawGatewayConfigurationHash)) {
    throw new Error('openclaw_agent_capability_profile_not_least_authority');
  }
  const profileHash = openClawAgentCapabilityProfileHash(source);
  if (!expectedHash || profileHash !== expectedHash) {
    throw new Error('openclaw_agent_capability_profile_hash_mismatch');
  }
  return Object.freeze({ profile: Object.freeze(source), profileHash });
}

export function createOpenClawAgentExecutor({
  openclawBinary = 'openclaw',
  agentId = process.env.HEPTA_OPENCLAW_AGENT || 'hepta-paper-worker',
  model = process.env.HEPTA_OPENCLAW_MODEL || null,
  thinking = process.env.HEPTA_OPENCLAW_THINKING || 'high',
  agentCapabilityProfile = null,
  agentCapabilityProfilePath = process.env.HEPTA_OPENCLAW_AGENT_CAPABILITY_PROFILE || null,
  expectedAgentCapabilityProfileHash = process.env.HEPTA_OPENCLAW_AGENT_CAPABILITY_PROFILE_HASH || null,
  openClawConfigurationResolver = null,
  spawnImpl = spawn,
  timeoutMs = 45 * 60 * 1000,
} = {}) {
  const executorId = 'openclaw-agent-executor-v1';
  const configurationResolver = openClawConfigurationResolver || createOpenClawRuntimeConfigurationResolver({
    openclawBinary,
  });
  return createAgentExecutorTemplate({
    kind: 'OpenClawAgentExecutor',
    executorId,
    capabilityDefinition: {
      networkPolicy: 'provider-controlled',
      maximumTimeoutMs: timeoutMs,
      maximumOutputTokens: null,
      provider: 'openclaw',
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
      workspace,
      promptHash,
      changedWorkspacePaths,
    }) {
      const verifiedCapabilityProfile = resolveAgentCapabilityProfile({
        agentId,
        profile: agentCapabilityProfile,
        profilePath: agentCapabilityProfilePath,
        expectedHash: expectedAgentCapabilityProfileHash,
      });
      const resolvedConfigurationBefore = await configurationResolver({ agentId, cwd: workspace });
      const verifiedConfiguration = verifyOpenClawAgentConfiguration({
        resolvedConfiguration: resolvedConfigurationBefore,
        agentId,
        workspace,
        sandbox,
      });
      if (verifiedCapabilityProfile.profile.openClawAgentConfigurationHash !== verifiedConfiguration.configurationHash
        || verifiedCapabilityProfile.profile.openClawGatewayConfigurationHash !== verifiedConfiguration.gatewayConfigHash) {
        throw new Error('openclaw_agent_configuration_hash_mismatch');
      }
      const sessionNonce = crypto.randomUUID();
      const sessionKey = `agent:${agentId}:hepta-paper-${String(context.campaignId || 'campaign').replace(/[^A-Za-z0-9_.-]/g, '_')}-${String(context.nodeId || role).replace(/[^A-Za-z0-9_.-]/g, '_')}-${sessionNonce}`;
      const prompt = [
        `You are the independent ${role} node in a hepta-paper automation campaign.`,
        `The paper workspace is ${workspace}.`,
        sandbox === 'read-only' ? 'Read and review only. Do not modify any file.' : 'Make only the requested changes inside that workspace.',
        'Do not submit papers, send messages, use credentials, or perform external mutations.',
        String(instructions),
        `Structured context: ${JSON.stringify({ ...context, workspacePath: workspace })}`,
        requiredChecks.length ? `Run applicable checks before finishing: ${requiredChecks.join(' ; ')}` : '',
        outputTokenBudget ? `Keep the final response within ${Math.max(128, Number(outputTokenBudget))} output tokens. Prefer editing files with tools over returning file bodies.` : '',
        'Finish with one compact JSON object containing status, summary, checksRun, and blockers. If the task instructions request role-specific JSON fields (for example verdict, score, criticalFindingCount, and findings), include those fields in the same final object.',
      ].filter(Boolean).join('\n\n');
      const promptDigest = promptHash(prompt);
      const requestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-openclaw-request-'));
      fs.chmodSync(requestRoot, 0o700);
      const requestPath = path.join(requestRoot, 'prompt.txt');
      const requestDescriptor = fs.openSync(
        requestPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      try {
        fs.writeSync(requestDescriptor, prompt, null, 'utf8');
        fs.fsyncSync(requestDescriptor);
      } finally {
        fs.closeSync(requestDescriptor);
      }
      const args = ['agent', '--agent', agentId, '--session-key', sessionKey, '--message-file', requestPath, '--json', '--thinking', thinking, '--timeout', String(Math.max(1, Math.ceil(Math.min(Number(requestedTimeout || timeoutMs), timeoutMs) / 1000)))];
      if (model) args.push('--model', model);
      const startedAt = new Date().toISOString();
      let processResult;
      try {
        processResult = await runBoundedChildProcess({
          spawnImpl,
          executable: openclawBinary,
          args,
          cwd: workspace,
          env: restrictedChildEnvironment({
            allowedKeys: [
              'OPENCLAW_HOME',
              'OPENCLAW_CONFIG_PATH',
              'OPENCLAW_PROFILE',
              'OPENCLAW_GATEWAY_URL',
              'OPENCLAW_GATEWAY_TOKEN',
            ],
            overrides: {
              OPENCLAW_GATEWAY_URL: verifiedConfiguration.gatewayUrl,
            },
          }),
          timeoutMs: Math.min(Number(requestedTimeout || timeoutMs), timeoutMs) + 5000,
          signal,
        });
      } finally {
        fs.rmSync(requestRoot, { recursive: true, force: true });
      }
      const completedAt = new Date().toISOString();
      const parsed = parseResult(processResult.stdout);
      const finalOutput = responseText(parsed, processResult.stdout);
      const structuredOutput = parseAgentOutput(finalOutput);
      const childSessionId = parsed?.sessionId || parsed?.session_id || parsed?.result?.sessionId || parsed?.result?.meta?.agentMeta?.sessionId || null;
      const resolvedModel = parsed?.result?.meta?.agentMeta?.model
        || parsed?.result?.meta?.agentMeta?.modelId
        || parsed?.model
        || model
        || null;
      const changedPaths = changedWorkspacePaths();
      const blockers = [];
      const cancelled = isExternalAgentCancellation(processResult);
      if (processResult.timedOut) blockers.push('openclaw_agent_timeout');
      if (cancelled) blockers.push('openclaw_agent_cancelled');
      if (!cancelled && (processResult.exitCode !== 0 || processResult.error)) blockers.push('openclaw_agent_process_failed');
      let configurationReverified = false;
      try {
        const resolvedConfigurationAfter = await configurationResolver({ agentId, cwd: workspace });
        const configurationHashAfter = openClawAgentConfigurationHash(resolvedConfigurationAfter, agentId);
        const gatewayConfigurationHashAfter = openClawGatewayConfigurationHash(resolvedConfigurationAfter, agentId);
        if (configurationHashAfter !== verifiedConfiguration.configurationHash
          || gatewayConfigurationHashAfter !== verifiedConfiguration.gatewayConfigHash) {
          blockers.push('openclaw_agent_configuration_drift_detected');
        } else {
          verifyOpenClawAgentConfiguration({
            resolvedConfiguration: resolvedConfigurationAfter,
            agentId,
            workspace,
            sandbox,
          });
          configurationReverified = true;
        }
      } catch {
        blockers.push('openclaw_agent_configuration_reverification_failed');
      }
      blockers.push(...readOnlyMutationBlockers({ sandbox, changedPaths }));
      const payload = {
        providerMode: 'openclaw:detached-child-session',
        agentId,
        model,
        resolvedModel,
        promptHash: promptDigest,
        maximumOutputTokens: outputTokenBudget ? Math.max(128, Number(outputTokenBudget)) : null,
        role,
        sessionKey,
        sessionId: childSessionId,
        childSessionId,
        status: blockers.length ? 'agent_execution_failed' : 'agent_execution_completed',
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        changedPaths,
        finalOutput: finalOutput.slice(-16000),
        structuredOutput,
        openClawRunId: parsed?.runId || null,
        usage: parsed?.result?.meta?.agentMeta?.usage || null,
        agentCapabilityProfileHash: verifiedCapabilityProfile.profileHash,
        openClawAgentConfigurationHash: verifiedConfiguration.configurationHash,
        openClawGatewayConfigurationHash: verifiedConfiguration.gatewayConfigHash,
        openClawGatewayInstanceId: verifiedConfiguration.gatewayInstanceId,
        openClawConfigurationReverified: configurationReverified,
        // Gateway runtime configuration is checked immediately before and
        // after the turn. This still does not observe every provider-side tool
        // invocation, so do not mint a false negative for external actions.
        externalActionPerformed: null,
        externalActionVerification: configurationReverified
          ? 'not_observed:openclaw_gateway_runtime_configuration_bound_pre_and_post'
          : 'not_observed:openclaw_gateway_runtime_configuration_not_reverified',
        blockers,
        stdoutHash: processResult.stdoutHash,
        stderrHash: processResult.stderrHash,
        outputTruncated: processResult.outputTruncated,
        stderrTail: processResult.stderr.slice(-8000),
        startedAt,
        completedAt,
      };
      return {
        payload,
        failureMessage: blockers.join(',') || processResult.error?.message || `openclaw agent exited ${processResult.exitCode}`,
        retryable: !cancelled && !blockers.includes('read_only_agent_modified_workspace'),
      };
    },
  });
}

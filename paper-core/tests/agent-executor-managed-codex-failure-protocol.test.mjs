import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import { preflightCodexFormalReviewer } from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
import {
  buildOpenClawManagedFailureExecutionBinding,
} from '../../paper-adapters/automation/codex-openclaw-managed-failure-execution-binding.mjs';
import {
  OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS,
  openClawModelRuntimeProvenance,
} from '../../paper-adapters/automation/codex-openclaw-managed-configuration.mjs';
import {
  buildOpenClawManagedFailureEvidence,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime.mjs';
import {
  meteredCampaignResultUsage,
} from '../../paper-application/automation/campaign-execution-budget-policy.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function executable(root, name, source) {
  const candidate = path.join(root, name);
  fs.writeFileSync(candidate, source);
  fs.chmodSync(candidate, 0o755);
  return candidate;
}

function fixtureOpenClawRuntimePackage(root) {
  const packageRoot = path.join(root, 'openclaw-runtime-package');
  const binaryDirectory = path.join(packageRoot, 'bin');
  fs.mkdirSync(binaryDirectory, { recursive: true });
  const openclawBinary = executable(
    binaryDirectory,
    'openclaw.mjs',
    '#!/usr/bin/env node\nprocess.exit(0);\n',
  );
  const packageExports = Object.fromEntries(
    OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS.map((descriptor) => {
      const target = `./dist/${descriptor.packageExport.split('/').at(-1)}.mjs`;
      const targetPath = path.join(packageRoot, target);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(
        targetPath,
        `${descriptor.requiredExports.map(
          (name) => `export function ${name}() { return null; }`,
        ).join('\n')}\n`,
      );
      return [descriptor.packageExport, { default: target }];
    }),
  );
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({
      name: 'openclaw',
      type: 'module',
      exports: packageExports,
    }, null, 2)}\n`,
  );
  return Object.freeze({
    openclawBinary,
    runtimeProvenance: openClawModelRuntimeProvenance(openclawBinary),
  });
}

function failedChildProcess(stderr, exitCode = 1, { environment = null } = {}) {
  const child = new EventEmitter();
  child.pid = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  const complete = (resolvedStderr) => {
    child.stdout.end();
    child.stderr.end(resolvedStderr);
    child.emit('close', exitCode, null);
  };
  if (typeof stderr === 'function') {
    let prompt = '';
    child.stdin.on('data', (chunk) => { prompt += chunk; });
    child.stdin.on('end', () => complete(stderr({ prompt, environment })));
  } else {
    queueMicrotask(() => complete(stderr));
  }
  return child;
}

function managedCodexFailureEvidence({
  failureCode = 'codex_openclaw_managed_transient_provider_response',
  model = 'fixture-managed-codex',
  authProfileIdentityHash,
  attemptCount = 2,
  retryable = true,
  toolCallsObserved = 0,
  pendingToolCallCount = 0,
  externalDeliveryObserved = false,
  runtimeProvenance = null,
  failureExecutionBinding = null,
} = {}) {
  const attemptTrace = Array.from({ length: attemptCount }, (_, index) => {
    const attemptId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const usage = {
      input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
    };
    return {
      attemptNumber: index + 1,
      attemptId,
      provider: 'openai',
      model,
      authProfileIdentityHash,
      usage,
      usageHash: hashRecord(
        'OpenClawManagedCodexAppServerAttemptUsage', { attemptId, usage },
      ),
      toolCallsObserved,
      pendingToolCallCount,
      externalDeliveryObserved,
    };
  });
  const error = Object.assign(new Error(failureCode), {
    code: failureCode,
    retryable,
    attemptTrace,
    attemptTraceHash: hashRecord(
      'OpenClawManagedCodexAppServerAttemptTrace', { attempts: attemptTrace },
    ),
    runtimeProvenance,
    ...(failureExecutionBinding ? {
      openClawManagedFailureExecutionBinding: failureExecutionBinding,
    } : {}),
  });
  return buildOpenClawManagedFailureEvidence(error);
}

function managedCodexIncompleteUsageEvidence({
  failureCode = 'codex_openclaw_managed_usage_invalid',
  model = 'fixture-managed-codex',
  authProfileIdentityHash,
  runtimeProvenance = null,
  failureExecutionBinding = null,
} = {}) {
  const attemptTrace = [{
    attemptNumber: 1,
    attemptId: '00000000-0000-4000-8000-000000000001',
    provider: 'openai',
    model,
    authProfileIdentityHash,
    usage: null,
    usageHash: null,
  }];
  const error = Object.assign(new Error(failureCode), {
    code: failureCode,
    attemptTrace,
    attemptTraceHash: hashRecord(
      'OpenClawManagedCodexAppServerAttemptTrace', { attempts: attemptTrace },
    ),
    runtimeProvenance,
    ...(failureExecutionBinding ? {
      openClawManagedFailureExecutionBinding: failureExecutionBinding,
    } : {}),
  });
  return buildOpenClawManagedFailureEvidence(error);
}

function managedFailureExecutionBinding({
  environment,
  prompt,
  workspace,
  capabilityReceipt,
  executionRole = 'formal-review',
  principalRole = 'formal-reviewer',
  sandbox = 'read-only',
} = {}) {
  return buildOpenClawManagedFailureExecutionBinding({
    environment,
    originalPrompt: prompt,
    execution: { workspace, sandbox },
    executionMetadata: { role: executionRole, sandbox },
    configuration: {
      agentId: 'fixture-managed-reviewer',
      principalRole,
      configurationHash:
        capabilityReceipt.openClawManagedConfigurationHash,
      openClawManagedAuthSourceIdentityHash:
        capabilityReceipt.openClawManagedAuthSourceIdentityHash,
    },
    snapshot: {
      snapshotHash: sha256('fixture-failure-source-snapshot'),
      fileCount: 1,
      byteCount: 64,
    },
  });
}

function managedFailureFixture(t) {
  const root = temporary(t, 'hepta-managed-codex-failure-protocol-');
  const codexHome = path.join(root, 'codex-home');
  const openClawRuntime = fixtureOpenClawRuntimePackage(root);
  fs.mkdirSync(codexHome, { mode: 0o700 });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'model = "fixture-managed-codex"',
    '[hepta_openclaw_managed]',
    'version = 4',
    'managed_auth = true',
    'agent_id = "fixture-managed-reviewer"',
    'principal_role = "formal-reviewer"',
    'auth_profile_id = "openai:fixture@example.test"',
    `openclaw_binary = ${JSON.stringify(openClawRuntime.openclawBinary)}`,
    'openclaw_config_path = "/fixture/openclaw/openclaw.json"',
    'openclaw_state_dir = "/fixture/openclaw"',
    '',
  ].join('\n'), { mode: 0o600 });
  const binary = executable(root, 'managed-codex', '#!/bin/sh\nexit 0\n');
  const spawnSyncImpl = (_executable, args) => {
    if (args[0] === '--version') {
      return {
        status: 0,
        signal: null,
        stdout: `codex-openclaw-managed 3 bridge=0123456789abcdef runtime=${openClawRuntime.runtimeProvenance.openClawManagedRuntimeProvenanceHash.slice(7, 23)}\n`,
        stderr: '',
      };
    }
    if (args[0] === 'exec' && args[1] === '--help') {
      return {
        status: 0,
        signal: null,
        stdout: 'Usage: codex exec --model MODEL\n',
        stderr: '',
      };
    }
    if (args[0] === 'login' && args[1] === 'status') {
      return {
        status: 0,
        signal: null,
        stdout: 'Logged in using OpenClaw-managed ChatGPT authentication\n',
        stderr: '',
      };
    }
    return {
      status: 2,
      signal: null,
      stdout: '',
      stderr: 'unexpected fixture command',
    };
  };
  const preflight = preflightCodexFormalReviewer({
    codexBinary: binary,
    codexHome,
    model: 'fixture-managed-codex',
    spawnSyncImpl,
  });
  const executor = (spawnImpl) => createCodexAgentExecutor({
    codexBinary: binary,
    codexHome,
    model: 'fixture-managed-codex',
    principalId: preflight.effectivePrincipalId,
    formalReviewerCapabilityReceipt: preflight.capabilityReceipt,
    spawnSyncImpl,
    spawnImpl,
    timeoutMs: 5000,
  });
  return { executor, openClawRuntime, preflight, root };
}

function executeFailure(executor, root, instructions) {
  return executor.execute({
    role: 'formal-review',
    workspacePath: root,
    instructions,
    sandbox: 'read-only',
    outputTokenBudget: 8192,
  });
}

test('managed Codex failure protocol binds usage evidence to one execution', async (t) => {
  const {
    executor,
    openClawRuntime,
    preflight,
    root,
  } = managedFailureFixture(t);
  const evidenceOptions = ({ environment, prompt }) => ({
    runtimeProvenance: openClawRuntime.runtimeProvenance,
    authProfileIdentityHash:
      preflight.capabilityReceipt.openClawManagedAuthProfileIdentityHash,
    failureExecutionBinding: managedFailureExecutionBinding({
      environment,
      prompt,
      workspace: root,
      capabilityReceipt: preflight.capabilityReceipt,
    }),
  });

  const incompleteCleanupFailureCode =
    'codex_openclaw_managed_session_cleanup_entry_disappeared_after_residue_verification';
  let incompleteCleanupEvidence = null;
  const incompleteCleanupFailureExecutor = executor(
    (_executable, _args, options) => failedChildProcess(
      ({ prompt, environment }) => {
        incompleteCleanupEvidence = managedCodexIncompleteUsageEvidence({
          ...evidenceOptions({ environment, prompt }),
          failureCode: incompleteCleanupFailureCode,
        });
        return [
          '[agent/embedded] embedded attempt failed before cleanup',
          '[diagnostic] lane task error: cleanup evidence incomplete',
          incompleteCleanupFailureCode,
          JSON.stringify(incompleteCleanupEvidence),
          '',
        ].join('\n');
      },
      1,
      { environment: options.env },
    ),
  );
  await assert.rejects(
    () => executeFailure(
      incompleteCleanupFailureExecutor,
      root,
      'Do not retry a cleanup failure with unknown model usage.',
    ),
    (error) => {
      assert.equal(error.message, incompleteCleanupFailureCode);
      assert.equal(error.retryable, false);
      assert.equal(
        error.receipt.managedRuntimeFailureDisposition,
        'permanent',
      );
      assert.equal(error.receipt.externalModelInvocationPerformed, true);
      assert.equal(error.receipt.usage, null);
      assert.equal(error.receipt.usageComplete, false);
      assert.equal(error.receipt.blockers.includes(
        'codex_openclaw_managed_execution_evidence_invalid',
      ), false);
      const meteredUsage = meteredCampaignResultUsage(error.receipt, {
        agentCall: true,
        failureReceipt: true,
      });
      assert.equal(meteredUsage.agentUsageComplete, false);
      assert.equal(
        meteredUsage.agentUsageStatus,
        'agent_usage_unknown_terminal',
      );
      assert.equal(
        error.receipt.openClawManagedFailureUsageEvidenceHash,
        incompleteCleanupEvidence.openClawManagedCodexFailureUsageEvidenceHash,
      );
      return true;
    },
  );

  const meteredFailureCode =
    'codex_openclaw_managed_transient_provider_response';
  let meteredFailureEvidence = null;
  const meteredFailureExecutor = executor(
    (_executable, _args, options) => failedChildProcess(
      ({ prompt, environment }) => {
        meteredFailureEvidence = managedCodexFailureEvidence({
          ...evidenceOptions({ environment, prompt }),
          failureCode: meteredFailureCode,
        });
        return [
          '[agent/embedded] provider attempt did not complete',
          '[agent/embedded] managed retry lane exhausted',
          '[diagnostic] lane task error: provider response unavailable',
          '[model-fallback/decision] no eligible fallback remained',
          meteredFailureCode,
          JSON.stringify(meteredFailureEvidence),
          '',
        ].join('\n');
      },
      1,
      { environment: options.env },
    ),
  );
  await assert.rejects(
    () => executeFailure(
      meteredFailureExecutor,
      root,
      'Review the frozen formal artifact.',
    ),
    (error) => {
      assert.equal(error.message, meteredFailureCode);
      assert.equal(error.retryable, true);
      assert.deepEqual(error.receipt.usage, {
        input: 20, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 40,
      });
      assert.equal(
        error.receipt.openClawManagedFailureUsageEvidenceHash,
        meteredFailureEvidence.openClawManagedCodexFailureUsageEvidenceHash,
      );
      assert.deepEqual(
        error.receipt.openClawManagedFailureUsageEvidence,
        meteredFailureEvidence,
      );
      assert.deepEqual(error.receipt.blockers, [
        'codex_agent_process_failed',
      ]);
      assert.equal(error.receipt.stderrTail, `${meteredFailureCode}\n`);
      assert.equal(error.receipt.externalModelInvocationPerformed, true);
      assert.equal(error.receipt.externalSideEffectPerformed, false);
      return true;
    },
  );

  const replayedFailureExecutor = executor(() => failedChildProcess(
    `${meteredFailureCode}\n${JSON.stringify(meteredFailureEvidence)}\n`,
  ));
  await assert.rejects(
    () => executeFailure(
      replayedFailureExecutor,
      root,
      'Reject a valid failure frame replayed from another invocation.',
    ),
    (error) => {
      assert.equal(error.message, meteredFailureCode);
      assert.equal(error.retryable, false);
      assert.ok(error.receipt.blockers.includes(
        'codex_openclaw_managed_failure_usage_evidence_invalid',
      ));
      assert.equal(
        Object.hasOwn(error.receipt, 'openClawManagedFailureUsageEvidence'),
        false,
      );
      assert.equal(error.receipt.externalModelInvocationPerformed, null);
      return true;
    },
  );

  const trailingJunkFailureExecutor = executor(() => failedChildProcess([
    '[diagnostic] managed failure protocol fixture',
    meteredFailureCode,
    JSON.stringify(meteredFailureEvidence),
    'trailing-junk',
    '',
  ].join('\n')));
  await assert.rejects(
    () => executeFailure(
      trailingJunkFailureExecutor,
      root,
      'Reject trailing data after managed failure evidence.',
    ),
    (error) => {
      assert.equal(error.retryable, false);
      assert.equal(
        Object.hasOwn(error.receipt, 'managedRuntimeFailureCode'),
        false,
      );
      assert.ok(error.receipt.blockers.includes(
        'codex_openclaw_managed_failure_protocol_invalid',
      ));
      assert.equal(
        Object.hasOwn(error.receipt, 'openClawManagedFailureUsageEvidence'),
        false,
      );
      return true;
    },
  );

  const managedCodeTailSmugglingExecutor = executor(
    () => failedChildProcess([
      meteredFailureCode,
      JSON.stringify(meteredFailureEvidence),
      'codex_openclaw_managed_required_snapshot_omitted',
      '',
    ].join('\n')),
  );
  await assert.rejects(
    () => executeFailure(
      managedCodeTailSmugglingExecutor,
      root,
      'Reject a managed-looking code appended after a complete frame.',
    ),
    (error) => {
      assert.equal(error.retryable, false);
      assert.equal(
        Object.hasOwn(error.receipt, 'managedRuntimeFailureCode'),
        false,
      );
      assert.ok(error.receipt.blockers.includes(
        'codex_openclaw_managed_failure_protocol_invalid',
      ));
      return true;
    },
  );

  const forgedFailureEvidence = {
    ...meteredFailureEvidence,
    openClawManagedCodexFailureUsageEvidenceHash: sha256(
      'forged-managed-failure-evidence',
    ),
  };
  const forgedFailureExecutor = executor(() => failedChildProcess(
    `${meteredFailureCode}\n${JSON.stringify(forgedFailureEvidence)}\n`,
  ));
  await assert.rejects(
    () => executeFailure(
      forgedFailureExecutor,
      root,
      'Reject forged managed failure evidence.',
    ),
    (error) => {
      assert.equal(error.message, meteredFailureCode);
      assert.equal(error.retryable, false);
      assert.equal(
        error.receipt.managedRuntimeFailureCode,
        meteredFailureCode,
      );
      assert.equal(
        error.receipt.managedRuntimeFailureDisposition,
        'permanent',
      );
      assert.ok(error.receipt.blockers.includes(
        'codex_openclaw_managed_failure_usage_evidence_invalid',
      ));
      assert.equal(
        Object.hasOwn(error.receipt, 'openClawManagedFailureUsageEvidence'),
        false,
      );
      return true;
    },
  );

  let incompleteUsageEvidence = null;
  const invalidUsageFailureExecutor = executor(
    (_executable, _args, options) => failedChildProcess(
      ({ prompt, environment }) => {
        incompleteUsageEvidence = managedCodexIncompleteUsageEvidence(
          evidenceOptions({ environment, prompt }),
        );
        return `codex_openclaw_managed_usage_invalid\n${JSON.stringify(incompleteUsageEvidence)}\n`;
      },
      1,
      { environment: options.env },
    ),
  );
  await assert.rejects(
    () => executeFailure(
      invalidUsageFailureExecutor,
      root,
      'Reject invalid managed usage without retrying the model call.',
    ),
    (error) => {
      assert.equal(error.message, 'codex_openclaw_managed_usage_invalid');
      assert.equal(error.retryable, false);
      assert.equal(
        error.receipt.managedRuntimeFailureCode,
        'codex_openclaw_managed_usage_invalid',
      );
      assert.equal(
        error.receipt.managedRuntimeFailureDisposition,
        'permanent',
      );
      assert.equal(error.receipt.externalModelInvocationPerformed, true);
      assert.equal(error.receipt.usage, null);
      assert.equal(error.receipt.usageComplete, false);
      assert.equal(
        error.receipt.openClawManagedFailureUsageEvidenceHash,
        incompleteUsageEvidence.openClawManagedCodexFailureUsageEvidenceHash,
      );
      return true;
    },
  );

  let policyFailureEvidence = null;
  const policyFailureExecutor = executor(
    (_executable, _args, options) => failedChildProcess(
      ({ prompt, environment }) => {
        policyFailureEvidence = managedCodexFailureEvidence({
          ...evidenceOptions({ environment, prompt }),
          failureCode: 'codex_openclaw_managed_agent_policy_violation',
          attemptCount: 1,
          retryable: false,
          externalDeliveryObserved: true,
        });
        return `codex_openclaw_managed_agent_policy_violation\n${JSON.stringify(policyFailureEvidence)}\n`;
      },
      1,
      { environment: options.env },
    ),
  );
  await assert.rejects(
    () => executeFailure(
      policyFailureExecutor,
      root,
      'Reject the observed external delivery.',
    ),
    (error) => {
      assert.equal(
        error.message,
        'codex_openclaw_managed_agent_policy_violation',
      );
      assert.equal(error.retryable, false);
      assert.equal(error.receipt.externalActionPerformed, true);
      assert.equal(error.receipt.externalSideEffectPerformed, true);
      assert.equal(
        error.receipt.externalActionVerification,
        'openclaw_user_locked_codex_app_server_failure_evidence',
      );
      return true;
    },
  );

  const noisyFailureExecutor = executor(() => failedChildProcess([
    'unexpected diagnostic',
    'codex_openclaw_managed_required_snapshot_omitted',
    '',
  ].join('\n')));
  await assert.rejects(
    () => executeFailure(
      noisyFailureExecutor,
      root,
      'Review the frozen formal artifact.',
    ),
    (error) => {
      assert.equal(error.retryable, false);
      assert.equal(
        Object.hasOwn(error.receipt, 'managedRuntimeFailureCode'),
        false,
      );
      assert.ok(error.receipt.blockers.includes(
        'codex_openclaw_managed_failure_protocol_invalid',
      ));
      return true;
    },
  );
});

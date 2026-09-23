import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCodexAgentExecutor } from '../../paper-adapters/automation/codex-agent-executor.mjs';
import { preflightCodexFormalReviewer } from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
import { probeCodexModelAvailability } from '../../paper-adapters/automation/codex-runtime-preflight.mjs';
import {
  buildOpenClawManagedFailureExecutionBinding,
} from '../../paper-adapters/automation/codex-openclaw-managed-failure-execution-binding.mjs';
import {
  OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS,
  openClawModelRuntimeProvenance,
} from '../../paper-adapters/automation/codex-openclaw-managed-configuration.mjs';
import {
  buildManagedWorkspaceSnapshot,
  buildOpenClawManagedFailureEvidence,
  verifyOpenClawManagedFailureEvidence,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime.mjs';
import {
  isKnownOpenClawManagedFailureCode,
  OPENCLAW_MANAGED_UNCLASSIFIED_FAILURE_CODE,
} from '../../paper-adapters/automation/codex-openclaw-managed-failure-code.mjs';
import {
  parseManagedRuntimeFailureProtocol,
} from '../../paper-adapters/automation/codex-openclaw-managed-failure-protocol.mjs';
import {
  autonomousResearchOneShotCampaignAttemptFailureOutcome,
} from '../../paper-composition/automation/autonomous-research-one-shot-campaign-attempt-failure.mjs';
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

function productionMjsFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) return productionMjsFiles(candidate);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [candidate] : [];
  });
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

function failedChildProcess(stderr, exitCode = 1, {
  environment = null, stdout = '', processError = null,
} = {}) {
  const child = new EventEmitter();
  child.pid = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  const complete = (resolvedStderr) => {
    child.stdout.end(stdout);
    child.stderr.end(resolvedStderr);
    if (processError) child.emit('error', processError);
    else child.emit('close', exitCode, null);
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

function captureSynchronousError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail('expected callback to throw');
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
  const snapshot = buildManagedWorkspaceSnapshot({
    workspace,
    maximumContextBytes:
      capabilityReceipt.openClawManagedMaximumContextBytes,
    maximumFileCount:
      capabilityReceipt.openClawManagedMaximumFileCount,
  });
  return buildOpenClawManagedFailureExecutionBinding({
    environment,
    originalPrompt: prompt,
    execution: { workspace, sandbox },
    executionMetadata: { role: executionRole, sandbox },
    configuration: {
      agentId: capabilityReceipt.openClawManagedAgentId,
      principalRole,
      configurationHash:
        capabilityReceipt.openClawManagedConfigurationHash,
      openClawManagedAuthSourceIdentityHash:
        capabilityReceipt.openClawManagedAuthSourceIdentityHash,
    },
    snapshot,
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
    timeoutMs: 300000,
  });
  return {
    binary,
    codexHome,
    executor,
    openClawRuntime,
    preflight,
    root,
    spawnSyncImpl,
  };
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
  const meteredFailureSensitiveDiagnostic =
    'Provider failure credential=sk-verified-failure-secret '
    + 'path=/private/verified-failure must not be persisted.';
  let meteredFailureEvidence = null;
  const meteredFailureExecutor = executor(
    (_executable, _args, options) => failedChildProcess(
      ({ prompt, environment }) => {
        meteredFailureEvidence = managedCodexFailureEvidence({
          ...evidenceOptions({ environment, prompt }),
          failureCode: meteredFailureCode,
        });
        return [
          meteredFailureSensitiveDiagnostic,
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
      assert.equal(error.receipt.finalOutput, '');
      assert.equal(error.receipt.structuredOutput, null);
      assert.equal(error.receipt.stderrTail, `${meteredFailureCode}\n`);
      assert.equal(error.receipt.externalModelInvocationPerformed, true);
      assert.equal(error.receipt.externalSideEffectPerformed, false);
      const serialized = JSON.stringify({ message: error.message, ...error });
      for (const sensitive of [
        'sk-verified-failure-secret',
        '/private/verified-failure',
        'Provider failure credential=',
      ]) assert.equal(serialized.includes(sensitive), false);
      return true;
    },
  );

  const replayedSensitiveDiagnostic =
    'provider prose credential=sk-replayed-secret path=/private/replayed';
  const replayedFailureExecutor = executor(() => failedChildProcess([
    replayedSensitiveDiagnostic,
    meteredFailureCode,
    JSON.stringify(meteredFailureEvidence),
    '',
  ].join('\n')));
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
      assert.equal(error.receipt.stderrTail, `${meteredFailureCode}\n`);
      assert.equal(
        JSON.stringify({ message: error.message, ...error })
          .includes(replayedSensitiveDiagnostic),
        false,
      );
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

test('unverified managed failures retain hashes without raw diagnostics', async (t) => {
  const { executor, root } = managedFailureFixture(t);
  const secret = 'sk-live-unverified-secret';
  const privatePath = '/private/provider/account.json';
  const providerProse = 'Provider rejected this account with an opaque response.';
  const rawStdout = JSON.stringify({ secret, privatePath, providerProse });
  const rawStderr = `${providerProse} credential=${secret} path=${privatePath}\n`;
  const processError = new Error(
    `${providerProse} credential=${secret} path=${privatePath}`,
  );
  const unverifiedExecutor = executor(() => failedChildProcess(rawStderr, 1, {
    stdout: rawStdout,
    processError,
  }));

  await assert.rejects(
    () => executeFailure(
      unverifiedExecutor,
      root,
      'Fail closed when managed output cannot be verified.',
    ),
    (error) => {
      assert.deepEqual(error.receipt.blockers, [
        'codex_agent_process_failed',
        'codex_openclaw_managed_execution_evidence_invalid',
      ]);
      assert.equal(error.receipt.stdoutHash, sha256(rawStdout));
      assert.equal(error.receipt.stderrHash, sha256(rawStderr));
      assert.equal(error.receipt.finalOutput, '');
      assert.equal(error.receipt.structuredOutput, null);
      assert.equal(error.receipt.stderrTail, '');
      assert.equal(error.receipt.error, null);
      const serialized = JSON.stringify({ message: error.message, ...error });
      for (const sensitive of [secret, privatePath, providerProse]) {
        assert.equal(serialized.includes(sensitive), false);
      }
      return true;
    },
  );
});

test('unknown managed-looking failure codes are projected before receipts', async (t) => {
  const { executor, root } = managedFailureFixture(t);
  const candidates = [
    'codex_openclaw_managed_sk-live-secret-token',
    'codex_openclaw_managed_sk_live_secret_token',
  ];
  for (const candidate of candidates) {
    for (const evidence of [null, {
      failureCode: candidate,
      providerDiagnostic: `credential=${candidate} path=/private/provider`,
    }]) {
      const rawStderr = evidence
        ? `${candidate}\n${JSON.stringify(evidence)}\n`
        : `${candidate}\n`;
      const unsafeExecutor = executor(
        () => failedChildProcess(rawStderr),
      );
      await assert.rejects(
        () => executeFailure(
          unsafeExecutor,
          root,
          'Fail closed without retaining an unregistered failure code.',
        ),
        (error) => {
          assert.equal(
            error.message,
            OPENCLAW_MANAGED_UNCLASSIFIED_FAILURE_CODE,
          );
          assert.equal(
            error.receipt.managedRuntimeFailureCode,
            OPENCLAW_MANAGED_UNCLASSIFIED_FAILURE_CODE,
          );
          assert.equal(
            error.receipt.stderrTail,
            `${OPENCLAW_MANAGED_UNCLASSIFIED_FAILURE_CODE}\n`,
          );
          assert.equal(error.receipt.stderrHash, sha256(rawStderr));
          assert.ok(error.receipt.blockers.includes(
            'codex_openclaw_managed_failure_protocol_invalid',
          ));
          assert.equal(
            Object.hasOwn(
              error.receipt,
              'openClawManagedFailureUsageEvidence',
            ),
            false,
          );
          const serialized = JSON.stringify({ message: error.message, ...error });
          assert.equal(serialized.includes(candidate), false);
          assert.equal(serialized.includes('/private/provider'), false);
          return true;
        },
      );
    }
  }
});

test('failure evidence builder projects unregistered codes to the closed registry', (t) => {
  const { openClawRuntime, preflight } = managedFailureFixture(t);
  const candidate = 'codex_openclaw_managed_sk_live_secret_token';
  const evidence = managedCodexFailureEvidence({
    failureCode: candidate,
    model: 'fixture-managed-codex',
    authProfileIdentityHash:
      preflight.capabilityReceipt.openClawManagedAuthProfileIdentityHash,
    attemptCount: 1,
    retryable: false,
    runtimeProvenance: openClawRuntime.runtimeProvenance,
  });
  assert.equal(
    evidence.failureCode,
    OPENCLAW_MANAGED_UNCLASSIFIED_FAILURE_CODE,
  );
  assert.equal(JSON.stringify(evidence).includes(candidate), false);
  assert.equal(verifyOpenClawManagedFailureEvidence(evidence, {
    failureCode: candidate,
    model: 'fixture-managed-codex',
    expectedAuthProfileIdentityHash:
      preflight.capabilityReceipt.openClawManagedAuthProfileIdentityHash,
    expectedRuntimeProvenanceHash:
      openClawRuntime.runtimeProvenance
        .openClawManagedRuntimeProvenanceHash,
    allowLegacyAudit: true,
  }), true);
  const {
    openClawManagedCodexFailureUsageEvidenceHash: _claimedHash,
    ...payload
  } = evidence;
  const unsafePayload = { ...payload, failureCode: candidate };
  const forged = {
    ...unsafePayload,
    openClawManagedCodexFailureUsageEvidenceHash: hashRecord(
      'OpenClawManagedCodexFailureUsageEvidence',
      unsafePayload,
    ),
  };
  assert.equal(verifyOpenClawManagedFailureEvidence(forged, {
    failureCode: candidate,
    model: 'fixture-managed-codex',
    expectedAuthProfileIdentityHash:
      preflight.capabilityReceipt.openClawManagedAuthProfileIdentityHash,
    expectedRuntimeProvenanceHash:
      openClawRuntime.runtimeProvenance
        .openClawManagedRuntimeProvenanceHash,
    allowLegacyAudit: true,
  }), false);
});

test('historical model-reported blocker remains exactly auditable', (t) => {
  const { openClawRuntime, preflight } = managedFailureFixture(t);
  const failureCode = 'codex_openclaw_managed_model_reported_blocked';
  assert.deepEqual(
    parseManagedRuntimeFailureProtocol(`${failureCode}\n`),
    { code: failureCode, evidence: null, valid: true },
  );
  const evidence = managedCodexFailureEvidence({
    failureCode,
    model: 'fixture-managed-codex',
    authProfileIdentityHash:
      preflight.capabilityReceipt.openClawManagedAuthProfileIdentityHash,
    attemptCount: 1,
    retryable: false,
    runtimeProvenance: openClawRuntime.runtimeProvenance,
  });
  assert.equal(evidence.version, 4);
  assert.equal(evidence.failureCode, failureCode);
  assert.equal(verifyOpenClawManagedFailureEvidence(evidence, {
    failureCode,
    model: 'fixture-managed-codex',
    expectedAuthProfileIdentityHash:
      preflight.capabilityReceipt.openClawManagedAuthProfileIdentityHash,
    expectedRuntimeProvenanceHash:
      openClawRuntime.runtimeProvenance
        .openClawManagedRuntimeProvenanceHash,
    allowLegacyAudit: true,
  }), true);
  assert.deepEqual(
    parseManagedRuntimeFailureProtocol(
      `${failureCode}\n${JSON.stringify(evidence)}\n`,
    ),
    { code: failureCode, evidence, valid: true },
  );
});

test('managed failure registry covers every production code literal', () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const registryPath = path.join(
    repositoryRoot,
    'paper-adapters/automation/codex-openclaw-managed-failure-code.mjs',
  );
  const productionRoots = [
    'paper-adapters',
    'paper-application',
    'paper-composition',
    'paper-core/bin',
    'paper-core/src',
    'paper-domain',
    'workflow-kernel',
  ].map((relativePath) => path.join(repositoryRoot, relativePath));
  const observed = new Map();
  for (const file of productionRoots.flatMap(productionMjsFiles)) {
    if (file === registryPath) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /(['"`])(codex_openclaw_managed_[a-z0-9_]+)\1/g,
    )) {
      const locations = observed.get(match[2]) || [];
      locations.push(path.relative(repositoryRoot, file));
      observed.set(match[2], locations);
    }
  }
  const missing = [...observed]
    .filter(([failureCode]) => !isKnownOpenClawManagedFailureCode(failureCode))
    .map(([failureCode, files]) => ({ failureCode, files }));
  assert.deepEqual(missing, []);
  assert.ok(observed.size >= 99);
});

test('live canary accepts quota only from invocation-bound managed v5 failure evidence', (t) => {
  const {
    binary,
    codexHome,
    openClawRuntime,
    preflight,
    spawnSyncImpl,
  } = managedFailureFixture(t);
  const failureCode = 'codex_openclaw_managed_profile_quota_exhausted';
  const legacyEvidence = managedCodexFailureEvidence({
    failureCode,
    model: 'fixture-managed-codex',
    authProfileIdentityHash:
      preflight.capabilityReceipt.openClawManagedAuthProfileIdentityHash,
    attemptCount: 1,
    retryable: false,
    runtimeProvenance: openClawRuntime.runtimeProvenance,
  });
  assert.equal(legacyEvidence.version, 4);
  let firstEvidence = null;
  const failureSpawn = (
    rawDiagnostic,
    evidenceResolver = (fresh) => fresh,
    suppliedFailureCode = failureCode,
  ) => (
    executablePath, args, options
  ) => {
    if (!args.includes('--ephemeral')) {
      return spawnSyncImpl(executablePath, args, options);
    }
    const freshEvidence = managedCodexFailureEvidence({
      failureCode: suppliedFailureCode,
      model: 'fixture-managed-codex',
      authProfileIdentityHash:
        preflight.capabilityReceipt.openClawManagedAuthProfileIdentityHash,
      attemptCount: 1,
      retryable: false,
      runtimeProvenance: openClawRuntime.runtimeProvenance,
      failureExecutionBinding: managedFailureExecutionBinding({
        environment: options.env,
        prompt: options.input,
        workspace: options.cwd,
        capabilityReceipt: preflight.capabilityReceipt,
        executionRole: 'model-availability-canary',
        principalRole: 'formal-reviewer',
      }),
    });
    assert.equal(freshEvidence.version, 5);
    const suppliedEvidence = evidenceResolver(freshEvidence);
    return {
      status: 86,
      signal: null,
      stdout: '',
      stderr: [
        rawDiagnostic,
        suppliedFailureCode,
        JSON.stringify(suppliedEvidence),
        '',
      ].join('\n'),
    };
  };
  const options = (spawn) => ({
    codexBinary: binary,
    codexHome,
    model: 'fixture-managed-codex',
    errorPrefix: 'managed_canary',
    spawnSyncImpl: spawn,
  });
  const firstQuota = captureSynchronousError(() => probeCodexModelAvailability(
    options(failureSpawn(
      'credential=sk-secret path=/private/a response=opaque-a',
      (fresh) => {
        firstEvidence = fresh;
        return fresh;
      },
    )),
  ));
  assert.equal(firstQuota.failureClass, 'quota');
  assert.deepEqual(
    autonomousResearchOneShotCampaignAttemptFailureOutcome(
      firstQuota,
      'provider_started',
    ),
    {
      version: 1,
      kind: 'AutonomousResearchOneShotCampaignAttemptFailure',
      errorCode: 'unknown_error',
      failureClass: 'quota',
      failingStage: 'provider_action',
      diagnosticHash: firstQuota.diagnosticHash,
    },
  );
  assert.equal(
    autonomousResearchOneShotCampaignAttemptFailureOutcome(
      firstQuota,
      'prepare_verified',
    ).failureClass,
    'unknown',
  );

  const replayed = captureSynchronousError(() => probeCodexModelAvailability(
    options(failureSpawn(
      'credential=sk-replay path=/private/replay response=opaque-replay',
      () => firstEvidence,
    )),
  ));
  assert.equal(replayed.failureClass, 'unknown');

  const secondQuota = captureSynchronousError(() => probeCodexModelAvailability(
    options(failureSpawn('credential=sk-other path=/private/b response=opaque-b')),
  ));
  assert.equal(secondQuota.failureClass, 'quota');
  assert.equal(secondQuota.diagnosticHash, firstQuota.diagnosticHash);

  const disposalFailure = captureSynchronousError(
    () => probeCodexModelAvailability(options(failureSpawn(
      'quota credential=sk-disposal path=/private/disposal',
      (fresh) => fresh,
      'codex_openclaw_managed_agent_runtime_disposal_failed',
    ))),
  );
  assert.equal(disposalFailure.failureClass, 'unknown');
  assert.notEqual(disposalFailure.diagnosticHash, firstQuota.diagnosticHash);

  const unknown = captureSynchronousError(() => probeCodexModelAvailability(
    options(failureSpawn(
      'insufficient_quota credential=sk-tampered path=/private/tampered',
      (fresh) => ({ ...fresh, failureDisposition: 'retryable' }),
    )),
  ));
  assert.equal(unknown.failureClass, 'unknown');
  assert.match(unknown.diagnosticHash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(unknown.diagnosticHash, firstQuota.diagnosticHash);

  const legacy = captureSynchronousError(() => probeCodexModelAvailability(
    options(failureSpawn(
      'insufficient_quota credential=sk-legacy path=/private/legacy',
      () => legacyEvidence,
    )),
  ));
  assert.equal(legacy.failureClass, 'unknown');
  assert.equal(legacy.diagnosticHash, unknown.diagnosticHash);

  for (const error of [
    firstQuota,
    replayed,
    secondQuota,
    disposalFailure,
    unknown,
    legacy,
  ]) {
    const serialized = JSON.stringify({ message: error.message, ...error });
    assert.equal(serialized.includes('sk-'), false);
    assert.equal(serialized.includes('/private/'), false);
    assert.equal(serialized.includes('response=opaque'), false);
    assert.equal(error.stderr, undefined);
    assert.equal(error.stdout, undefined);
  }
});

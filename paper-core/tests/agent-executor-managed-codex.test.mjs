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
  OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime.mjs';
import {
  OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS,
  openClawModelRuntimeProvenance,
} from '../../paper-adapters/automation/codex-openclaw-managed-configuration.mjs';
import {
  buildCampaignFormalReviewEnvelope,
} from '../../paper-adapters/automation/campaign-formal-review-envelope.mjs';
import {
  finalizeTheoremSpecification,
  readFinalizedTheoremSpecification,
} from '../../paper-adapters/automation/theorem-specification-finalizer.mjs';
import {
  verifyFreshIsolatedReviewerSessionReceipt,
} from '../../paper-domain/research/reviewer-semantic-evidence-contract.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { manuscriptClaimHash } from '../../paper-domain/research/formal-claim-contract.mjs';
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

function failedChildProcess(stderr, exitCode = 1) {
  const child = new EventEmitter();
  child.pid = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.end(stderr);
    child.emit('close', exitCode, null);
  });
  return child;
}

const MANAGED_APP_SERVER_ATTEMPT_ID =
  '00000000-0000-4000-8000-000000000001';
const MANAGED_APP_SERVER_INVOCATION_ID =
  `openclaw-codex-app-server:${MANAGED_APP_SERVER_ATTEMPT_ID}`;

function managedCodexChild({
  successfulAttemptId = MANAGED_APP_SERVER_ATTEMPT_ID,
  model = 'fixture-managed-codex',
  configurationHash = sha256('fixture-managed-configuration'),
  authProfileIdentityHash = sha256('fixture-managed-auth-profile'),
  authSourceIdentityHash = sha256('fixture-managed-auth-source'),
  evidenceVersion = 6,
  runtimeProvenance = null,
  structuredOutput = null,
  onPrompt = null,
} = {}) {
  const child = new EventEmitter();
  child.pid = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  let prompt = '';
  child.stdin.on('data', (chunk) => { prompt += chunk; });
  child.stdin.on('end', () => {
    if (onPrompt) onPrompt(prompt);
    const responseTextHash = sha256('fixture-managed-response-text');
    const sessionBindingHash = sha256('fixture-managed-session-binding');
    const executionTrace = {
      winnerProvider: 'openai',
      winnerModel: model,
      fallbackUsed: false,
      runner: 'embedded',
      attempts: [{
        provider: 'openai',
        model,
        result: 'success',
        stage: 'assistant',
        reason: null,
      }],
    };
    const sessionCleanup = {
      sessionEntryRemoved: true,
      artifactsRemoved: true,
      attemptWorkspaceRemoved: true,
    };
    const usage = {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
    };
    const version5AttemptTrace = [{
      attemptNumber: 1,
      attemptId: successfulAttemptId,
      provider: 'openai',
      model,
      authProfileIdentityHash,
      thinking: 'high',
      resolvedThinking: 'high',
      outcome: 'completed',
      stopReason: 'stop',
      errorClass: null,
      responseTextHash,
      responseErrorHash: null,
      authProfileOverrideSource: 'user',
      runtimeFallbackUsed: false,
      executionTrace,
      executionTraceHash: hashRecord(
        'OpenClawManagedCodexAppServerExecutionTrace',
        executionTrace,
      ),
      sessionBindingBeforeHash: sessionBindingHash,
      sessionBindingAfterHash: sessionBindingHash,
      agentHarnessId: 'codex',
      requestAuthMode: 'auth-profile',
      toolCallsObserved: 0,
      pendingToolCallCount: 0,
      externalDeliveryObserved: false,
      sessionCleanup,
      sessionCleanupHash: hashRecord(
        'OpenClawManagedCodexAppServerSessionCleanup',
        sessionCleanup,
      ),
      sessionCleanupVerified: true,
      usage,
      usageHash: hashRecord(
        'OpenClawManagedCodexAppServerAttemptUsage',
        { attemptId: successfulAttemptId, usage },
      ),
    }];
    const attemptTrace = evidenceVersion === 4
      ? version5AttemptTrace.map((attempt) => {
        const { usage: _usage, usageHash: _usageHash, ...legacyAttempt } = attempt;
        return legacyAttempt;
      })
      : version5AttemptTrace;
    const evidencePayload = {
      version: evidenceVersion,
      kind: 'OpenClawManagedCodexExecution',
      status: 'openclaw_managed_codex_execution_completed',
      provider: 'openai',
      model,
      agentId: 'fixture-managed-reviewer',
      principalRole: 'formal-reviewer',
      completionInvocationId:
        `openclaw-codex-app-server:${successfulAttemptId}`,
      successfulAttemptId,
      successfulResponseHash: responseTextHash,
      successfulSessionBindingHash: sessionBindingHash,
      attemptTrace,
      attemptTraceHash: hashRecord('OpenClawManagedCodexAppServerAttemptTrace', {
        attempts: attemptTrace,
      }),
      originalPromptHash: sha256(prompt),
      sourceSnapshotHash: sha256('fixture-source-snapshot'),
      sourceSnapshotFileCount: 1,
      sourceSnapshotBytes: 64,
      configurationHash,
      openClawManagedRuntimeProvenance: runtimeProvenance,
      openClawManagedAuthProfileIdentityHash: authProfileIdentityHash,
      openClawManagedAuthSourceIdentityHash: authSourceIdentityHash,
      changedPaths: [],
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
      sessionCleanupVerified: true,
      contextInheritance: 'forbidden',
      modelReportedChecks: [],
      ...(evidenceVersion >= 5 ? {
        usage,
        usageHash: hashRecord('OpenClawManagedCodexAppServerUsage', usage),
      } : {}),
      modelAttemptCount: 1,
      thinkingStrategy: 'fixed',
      resolvedThinkingLevel: 'high',
      externalModelInvocationPerformed: true,
      externalSideEffectPerformed: false,
      externalActionPerformed: false,
    };
    const managedEvidence = {
      ...evidencePayload,
      openClawManagedCodexExecutionHash:
        hashRecord('OpenClawManagedCodexAppServerExecution', evidencePayload),
    };
    child.stdout.end(JSON.stringify({
      ...(structuredOutput || {
        status: 'completed',
        summary: 'managed reviewer completed',
        checksRun: [],
        blockers: [],
      }),
      [OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD]: managedEvidence,
    }));
    child.stderr.end();
    child.emit('close', 0, null);
  });
  return child;
}

test('managed Codex receipts bind both session fields to the verified explicit-profile completion', async (t) => {
  const root = temporary(t, 'hepta-managed-codex-session-binding-');
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
  const proposalEnvelopeHash = hashRecord('ManagedReviewerProposalEnvelopeFixture', {});
  const productionPlanEnvelopeHash = hashRecord('ManagedReviewerProductionPlanFixture', {});
  const reviewGateHash = hashRecord('ManagedReviewerReviewGateFixture', {});
  const seedPayload = {
    version: 1,
    kind: 'PaperProposalSeedContractBundle',
    paperId: 'managed-reviewer-paper',
    taskKey: 'paper_factory:managed-reviewer-paper',
    status: 'proposal_seed_contracts_ready',
    proposalEnvelopeHash,
    productionPlanEnvelopeHash,
    reviewGateHash,
    claims: [{
      id: 'proposal:managed-reviewer-claim',
      kind: 'proposal_claim_seed',
      text: 'Every managed reviewer claim satisfies its bounded conclusion.',
      status: 'proposal_seed',
      scientificClaimKey: 'managed-reviewer-claim',
      assumptions: ['The reviewed object is in the bounded fixture domain.'],
      quantifiers: ['For every object in the bounded fixture domain.'],
      negativeBoundaries: ['No claim outside the bounded fixture domain is made.'],
      proofObligations: ['Prove the bounded managed reviewer conclusion.'],
    }],
    proof_obligations: [{
      id: 'proof:managed-reviewer-claim',
      text: 'Prove the bounded managed reviewer conclusion.',
    }],
    evidence: [],
    reproducibility: [],
    blockers: [],
    warnings: [],
  };
  const proposalSeedContractBundleHash =
    hashPaperRecord('PaperProposalSeedContractBundle', seedPayload);
  const seedBundle = {
    ...seedPayload,
    paperProposalSeedContractBundleHash: proposalSeedContractBundleHash,
  };
  fs.writeFileSync(
    path.join(root, 'SEED.json'),
    `${JSON.stringify(seedBundle, null, 2)}\n`,
  );
  const approvedSeedPayload = {
    version: 1,
    kind: 'ApprovedProposalSeedBinding',
    status: 'approved_proposal_seed_bound',
    contractPath: 'SEED.json',
    proposalEnvelopeHash,
    productionPlanEnvelopeHash,
    reviewGateHash,
    proposalSeedContractBundleHash,
  };
  const approvedProposalSeed = {
    ...approvedSeedPayload,
    approvedProposalSeedBindingHash:
      hashRecord('ApprovedProposalSeedBinding', approvedSeedPayload),
  };
  const claimStatement =
    'Every managed reviewer claim satisfies its bounded conclusion.';
  fs.writeFileSync(
    path.join(root, 'main.tex'),
    [
      `\\begin{theorem}${claimStatement}\\end{theorem}`,
      '\\begin{proof}By the bounded fixture hypothesis.\\end{proof}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'THEOREM_SPEC_DRAFT.json'), JSON.stringify({
    version: 1,
    kind: 'TheoremSpecificationDraft',
    claims: [{
      claimKey: 'managed-reviewer-claim',
      title: 'Managed reviewer claim',
      statement: claimStatement,
      assumptions: ['The reviewed object is in the bounded fixture domain.'],
      quantifiers: ['For every object in the bounded fixture domain.'],
      negativeBoundaries: ['No claim outside the bounded fixture domain is made.'],
      proofObligations: ['Prove the bounded managed reviewer conclusion.'],
      evidenceObligations: [],
      manuscriptIntent: 'existing',
      proposalClaimId: 'proposal:managed-reviewer-claim',
    }],
  }));
  finalizeTheoremSpecification({
    workspace: root,
    manuscriptPath: 'main.tex',
    paperId: 'managed-reviewer-paper',
    campaignId: 'managed-reviewer-campaign',
    approvedProposalSeed,
  });
  const theoremSpecification = readFinalizedTheoremSpecification({
    workspace: root,
    manuscriptPath: 'main.tex',
    paperId: 'managed-reviewer-paper',
    campaignId: 'managed-reviewer-campaign',
    approvedProposalSeed,
  });
  const [theoremClaim] = theoremSpecification.claims;
  const sourceLocator =
    `${theoremClaim.manuscriptSource.path}`
    + `#bytes=${theoremClaim.manuscriptSource.byteStart}`
    + `-${theoremClaim.manuscriptSource.byteEnd}`;
  const formalReviewDocument = {
    version: 2,
    kind: 'FormalClaimSemanticReview',
    theoremSpecificationHash:
      theoremSpecification.theoremSpecificationHash,
    reviews: [{
      claimId: theoremClaim.claimId,
      theoremName: 'managedReviewerClaim',
      manuscriptClaimHash: manuscriptClaimHash({
        claimId: theoremClaim.claimId,
        text: theoremClaim.statement,
        sourceLocator,
      }),
      theoremTypeHash: sha256('managed-reviewer-theorem-type'),
      sourceStatementHash: sha256('managed-reviewer-source-statement'),
      status: 'formal_semantic_review_verified',
      semanticEquivalenceVerified: true,
      verdict: 'equivalent',
      proposalClaimId:
        theoremClaim.proposalClaimSource.proposalClaimId,
      proposalClaimRecordHash:
        theoremClaim.proposalClaimSource.proposalClaimRecordHash,
      proposalClaimTextHash:
        theoremClaim.proposalClaimSource.proposalClaimTextHash,
      proposalToTheoremSemanticVerified: true,
      proposalToTheoremVerdict: 'equivalent',
      approvedNarrowingRationale: null,
    }],
  };
  fs.writeFileSync(
    path.join(root, 'RESEARCH_WORKER_PLAN.json'),
    `${JSON.stringify({ kind: 'ManagedReviewerWorkerPlanFixture' })}\n`,
  );
  const binary = executable(root, 'managed-codex', '#!/bin/sh\nexit 0\n');
  const preflightCalls = [];
  const spawnSyncImpl = (_executable, args, options) => {
    preflightCalls.push({ args: [...args], timeout: options?.timeout });
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
    return { status: 2, signal: null, stdout: '', stderr: 'unexpected fixture command' };
  };
  const preflight = preflightCodexFormalReviewer({
    codexBinary: binary,
    codexHome,
    model: 'fixture-managed-codex',
    spawnSyncImpl,
  });
  assert.equal(
    preflight.capabilityReceipt.executionTransport,
    'openclaw_user_locked_codex_app_server',
  );
  assert.equal(
    preflight.capabilityReceipt.authenticationAuthorityMode,
    'openclaw_user_locked_profile_fail_closed',
  );
  assert.equal(
    preflight.capabilityReceipt.managedRuntimeEvidenceRequired,
    true,
  );
  assert.throws(
    () => preflightCodexFormalReviewer({
      codexBinary: binary,
      codexHome,
      model: 'fixture-managed-codex',
      spawnSyncImpl(executablePath, args, options) {
        if (args[0] === '--version') {
          return {
            status: 0,
            signal: null,
            stdout: 'codex-openclaw-managed 3 bridge=0123456789abcdef runtime=unavailable\n',
            stderr: '',
          };
        }
        return spawnSyncImpl(executablePath, args, options);
      },
    }),
    /formal_review_codex_openclaw_managed_runtime_required/,
  );
  let managedPrompt = '';
  const executor = createCodexAgentExecutor({
    codexBinary: binary,
    codexHome,
    model: 'fixture-managed-codex',
    principalId: preflight.effectivePrincipalId,
    formalReviewerCapabilityReceipt: preflight.capabilityReceipt,
    spawnSyncImpl,
    spawnImpl: () => managedCodexChild({
      runtimeProvenance: openClawRuntime.runtimeProvenance,
      configurationHash:
        preflight.capabilityReceipt.openClawManagedConfigurationHash,
      authProfileIdentityHash:
        preflight.capabilityReceipt.openClawManagedAuthProfileIdentityHash,
      authSourceIdentityHash:
        preflight.capabilityReceipt.openClawManagedAuthSourceIdentityHash,
      structuredOutput: formalReviewDocument,
      onPrompt(prompt) { managedPrompt = prompt; },
    }),
    timeoutMs: 5000,
  });
  const receipt = await executor.execute({
    role: 'formal-review',
    workspacePath: root,
    instructions: 'Review the frozen formal artifact and return the structured result.',
    sandbox: 'read-only',
    outputTokenBudget: 8192,
  });
  assert.equal(
    preflightCalls.filter((call) => call.args[0] === 'login').length,
    2,
  );
  assert.equal(
    preflightCalls.filter((call) => call.args[0] === 'exec'
      && call.args[1] === '--help').length,
    2,
  );
  assert.equal(
    preflightCalls.filter((call) => call.args[0] === '--version').length,
    3,
  );
  assert.deepEqual(
    preflightCalls.filter((call) => call.args[0] === 'login')
      .map((call) => call.timeout),
    [60000, 60000],
  );
  assert.equal(receipt.sessionId, MANAGED_APP_SERVER_INVOCATION_ID);
  assert.equal(receipt.childSessionId, receipt.sessionId);
  assert.equal(
    receipt.codexExecutionTransport,
    'openclaw_user_locked_codex_app_server',
  );
  assert.equal(
    receipt.codexAuthenticationAuthorityMode,
    'openclaw_user_locked_profile_fail_closed',
  );
  assert.equal(
    receipt.openClawManagedExecutionEvidence.completionInvocationId,
    receipt.sessionId,
  );
  assert.equal(
    receipt.openClawManagedExecutionEvidence.successfulAttemptId,
    MANAGED_APP_SERVER_ATTEMPT_ID,
  );
  assert.equal(
    receipt.openClawManagedExecutionEvidence.attemptTrace.length,
    1,
  );
  assert.equal(
    receipt.openClawManagedExecutionEvidence.attemptTrace[0].outcome,
    'completed',
  );
  assert.equal(
    receipt.openClawManagedExecutionEvidence.simpleCompletionModelRun,
    false,
  );
  assert.equal(
    receipt.openClawManagedExecutionEvidence.codexAppServerOneShot,
    true,
  );
  assert.equal(
    receipt.openClawManagedExecutionEvidence.promptPersistence,
    'openclaw-user-turn-transcript-suppressed',
  );
  assert.equal(
    receipt.openClawManagedExecutionEvidence.sessionStatePersistence,
    'openclaw-entry-and-managed-artifacts-removed',
  );
  assert.equal(
    receipt.openClawManagedExecutionEvidence.sessionCleanupScope,
    'openclaw-session-store-artifacts-and-temporary-workspace-only',
  );
  assert.equal(
    receipt.openClawManagedExecutionEvidence.codexAppServerStateCleanupPerformed,
    false,
  );
  assert.equal(
    receipt.openClawManagedExecutionEvidence.sessionIsolation,
    'fresh_one_shot_codex_app_server_no_resume',
  );
  assert.equal(
    receipt.openClawManagedExecutionEvidence.sessionCleanupVerified,
    true,
  );
  assert.equal(
    receipt.openClawManagedExecutionEvidence.modelAttemptCount,
    1,
  );
  assert.equal(
    receipt.openClawManagedExecutionEvidence.openClawManagedAuthSourceIdentityHash,
    preflight.capabilityReceipt.openClawManagedAuthSourceIdentityHash,
  );
  assert.equal(
    preflight.capabilityReceipt.openClawManagedRuntimeProvenanceHash,
    openClawRuntime.runtimeProvenance.openClawManagedRuntimeProvenanceHash,
  );
  assert.equal(
    receipt.openClawManagedRuntimeProvenanceHash,
    openClawRuntime.runtimeProvenance.openClawManagedRuntimeProvenanceHash,
  );
  assert.deepEqual(
    receipt.openClawManagedExecutionEvidence.openClawManagedRuntimeProvenance,
    openClawRuntime.runtimeProvenance,
  );
  assert.equal(receipt.simpleCompletionModelRun, false);
  assert.equal(receipt.codexAppServerOneShot, true);
  assert.deepEqual(receipt.usage, {
    input: 10,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 20,
  });
  assert.equal(
    Object.hasOwn(receipt.openClawManagedExecutionEvidence, 'gatewaySessionKeyHash'),
    false,
  );
  assert.equal(
    Object.hasOwn(receipt.openClawManagedExecutionEvidence, 'openClawRunId'),
    false,
  );
  assert.equal(
    Object.hasOwn(receipt.openClawManagedExecutionEvidence, 'gatewayModelRun'),
    false,
  );
  assert.match(managedPrompt, /This managed transport is tool-free: do not call tools\./);
  assert.match(managedPrompt, /Return the required structured JSON directly\./);
  assert.doesNotMatch(managedPrompt, /Prefer editing files with tools/);

  let postflightVersionCalls = 0;
  let postflightModelCalls = 0;
  const postflightSensitiveStructuredOutput = {
    ...formalReviewDocument,
    summary: 'credential=sk-postflight-secret path=/private/postflight provider prose',
  };
  const postflightFailureExecutor = createCodexAgentExecutor({
    codexBinary: binary,
    codexHome,
    model: 'fixture-managed-codex',
    principalId: preflight.effectivePrincipalId,
    formalReviewerCapabilityReceipt: preflight.capabilityReceipt,
    spawnSyncImpl(executablePath, args, options) {
      if (args[0] === '--version') {
        postflightVersionCalls += 1;
        if (postflightVersionCalls > 1) {
          return {
            status: null,
            signal: 'SIGTERM',
            error: Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' }),
            stdout: '',
            stderr: '',
          };
        }
      }
      return spawnSyncImpl(executablePath, args, options);
    },
    spawnImpl: () => {
      postflightModelCalls += 1;
      return managedCodexChild({
        runtimeProvenance: openClawRuntime.runtimeProvenance,
        configurationHash:
          preflight.capabilityReceipt.openClawManagedConfigurationHash,
        authProfileIdentityHash:
          preflight.capabilityReceipt.openClawManagedAuthProfileIdentityHash,
        authSourceIdentityHash:
          preflight.capabilityReceipt.openClawManagedAuthSourceIdentityHash,
        structuredOutput: postflightSensitiveStructuredOutput,
      });
    },
    timeoutMs: 5000,
  });
  await assert.rejects(
    () => postflightFailureExecutor.execute({
      role: 'formal-review',
      workspacePath: root,
      instructions: 'Review the frozen formal artifact and preserve the postflight receipt.',
      sandbox: 'read-only',
      outputTokenBudget: 8192,
    }),
    (error) => {
      assert.equal(
        error.message,
        'formal_review_codex_capability_runtime_postflight_failed',
      );
      assert.equal(error.retryable, true);
      assert.deepEqual(error.receipt.blockers, [
        'formal_review_codex_capability_runtime_postflight_failed',
      ]);
      assert.equal(
        error.receipt.details.capabilityRuntimePostflight.failureCode,
        'formal_review_codex_version_unverified',
      );
      assert.equal(
        error.receipt.details.capabilityRuntimePostflight.disposition,
        'retryable',
      );
      assert.match(
        error.receipt.details.capabilityRuntimePostflight.outcomeHash,
        /^sha256:[a-f0-9]{64}$/,
      );
      assert.match(
        error.receipt.openClawManagedCodexExecutionHash,
        /^sha256:[a-f0-9]{64}$/,
      );
      assert.equal(
        error.receipt.openClawManagedExecutionEvidence.sessionCleanupVerified,
        true,
      );
      assert.equal(error.receipt.usage.totalTokens, 20);
      assert.equal(error.receipt.finalOutput, '');
      assert.equal(error.receipt.structuredOutput, null);
      const serialized = JSON.stringify({ message: error.message, ...error });
      for (const sensitive of [
        'sk-postflight-secret', '/private/postflight', 'provider prose',
      ]) assert.equal(serialized.includes(sensitive), false);
      return true;
    },
  );

  assert.equal(postflightModelCalls, 1);
  assert.equal(postflightVersionCalls, 3);

  const snapshotFailureExecutor = createCodexAgentExecutor({
    codexBinary: binary,
    codexHome,
    model: 'fixture-managed-codex',
    principalId: preflight.effectivePrincipalId,
    formalReviewerCapabilityReceipt: preflight.capabilityReceipt,
    spawnSyncImpl,
    spawnImpl: () => failedChildProcess(
      'codex_openclaw_managed_required_snapshot_omitted\n',
    ),
    timeoutMs: 5000,
  });
  await assert.rejects(
    () => snapshotFailureExecutor.execute({
      role: 'formal-review',
      workspacePath: root,
      instructions: 'Review the frozen formal artifact.',
      sandbox: 'read-only',
      outputTokenBudget: 8192,
    }),
    (error) => {
      assert.equal(
        error.message,
        'codex_openclaw_managed_required_snapshot_omitted',
      );
      assert.equal(error.retryable, false);
      assert.deepEqual(error.receipt.blockers, [
        'codex_agent_process_failed',
        'codex_openclaw_managed_execution_evidence_invalid',
      ]);
      assert.equal(
        error.receipt.managedRuntimeFailureCode,
        'codex_openclaw_managed_required_snapshot_omitted',
      );
      assert.equal(
        error.receipt.managedRuntimeFailureDisposition,
        'permanent',
      );
      assert.equal(
        error.receipt.stderrTail,
        'codex_openclaw_managed_required_snapshot_omitted\n',
      );
      return true;
    },
  );

  for (const truncatedFailureCode of [
    'codex_openclaw_managed_model_timeout',
    'codex_openclaw_managed_transient_provider_response',
  ]) {
    const truncatedFailureExecutor = createCodexAgentExecutor({
      codexBinary: binary,
      codexHome,
      model: 'fixture-managed-codex',
      principalId: preflight.effectivePrincipalId,
      formalReviewerCapabilityReceipt: preflight.capabilityReceipt,
      spawnSyncImpl,
      spawnImpl: () => failedChildProcess(`${truncatedFailureCode}\n`),
      timeoutMs: 5000,
    });
    await assert.rejects(
      () => truncatedFailureExecutor.execute({
        role: 'formal-review',
        workspacePath: root,
        instructions: 'Do not retry after the managed failure evidence stream is truncated.',
        sandbox: 'read-only',
        outputTokenBudget: 8192,
      }),
      (error) => {
        assert.equal(error.message, truncatedFailureCode);
        assert.equal(error.retryable, false);
        assert.equal(
          error.receipt.managedRuntimeFailureDisposition,
          'permanent',
        );
        assert.equal(error.receipt.externalModelInvocationPerformed, null);
        assert.equal(Object.hasOwn(error.receipt, 'usage'), false);
        return true;
      },
    );
  }

  for (const candidate of [
    {
      code: 'codex_openclaw_managed_configuration_changed',
      disposition: 'permanent',
      retryable: false,
    },
    {
      code: 'codex_openclaw_managed_structured_output_invalid',
      disposition: 'permanent',
      retryable: false,
    },
    {
      code: 'codex_openclaw_managed_session_cleanup_artifact_residue_detected',
      disposition: 'permanent',
      retryable: false,
    },
    {
      code: 'codex_openclaw_managed_session_cleanup_entry_disappeared_after_residue_verification',
      disposition: 'permanent',
      retryable: false,
    },
  ]) {
    const cleanupFailureExecutor = createCodexAgentExecutor({
      codexBinary: binary,
      codexHome,
      model: 'fixture-managed-codex',
      principalId: preflight.effectivePrincipalId,
      formalReviewerCapabilityReceipt: preflight.capabilityReceipt,
      spawnSyncImpl,
      spawnImpl: () => failedChildProcess(`${candidate.code}\n`),
      timeoutMs: 5000,
    });
    await assert.rejects(
      () => cleanupFailureExecutor.execute({
        role: 'formal-review',
        workspacePath: root,
        instructions: 'Review the frozen formal artifact.',
        sandbox: 'read-only',
        outputTokenBudget: 8192,
      }),
      (error) => {
        assert.equal(error.message, candidate.code);
        assert.equal(error.retryable, candidate.retryable);
        assert.equal(
          error.receipt.managedRuntimeFailureDisposition,
          candidate.disposition,
        );
        return true;
      },
    );
  }

  const legacyDowngradeExecutor = createCodexAgentExecutor({
    codexBinary: binary,
    codexHome,
    model: 'fixture-managed-codex',
    principalId: preflight.effectivePrincipalId,
    formalReviewerCapabilityReceipt: preflight.capabilityReceipt,
    spawnSyncImpl,
    spawnImpl: () => managedCodexChild({
      evidenceVersion: 4,
      runtimeProvenance: openClawRuntime.runtimeProvenance,
      configurationHash:
        preflight.capabilityReceipt.openClawManagedConfigurationHash,
      authProfileIdentityHash:
        preflight.capabilityReceipt.openClawManagedAuthProfileIdentityHash,
      authSourceIdentityHash:
        preflight.capabilityReceipt.openClawManagedAuthSourceIdentityHash,
      structuredOutput: formalReviewDocument,
    }),
    timeoutMs: 5000,
  });
  await assert.rejects(
    () => legacyDowngradeExecutor.execute({
      role: 'formal-review',
      workspacePath: root,
      instructions: 'Reject a usage-stripped managed evidence downgrade.',
      sandbox: 'read-only',
      outputTokenBudget: 8192,
    }),
    (error) => {
      assert.ok(error.receipt.blockers.includes(
        'codex_openclaw_managed_execution_evidence_invalid',
      ));
      assert.equal(Object.hasOwn(error.receipt, 'usage'), false);
      return true;
    },
  );

  const reviewerTrust = {
    reviewEvidenceMode: 'fresh-isolated-session',
    reviewerCryptographicAuthorityReady: false,
    reviewerIdentityIndependenceReady: true,
    reviewPrincipalId: preflight.effectivePrincipalId,
    reviewPrincipalDescriptorHash: sha256('fixture-review-principal-descriptor'),
    researchPrincipalPoolHash: sha256('fixture-research-principal-pool'),
    reviewerProviderAccountIdentityHash: sha256('fixture-provider-account'),
    reviewerCredentialRootIdentityHash: sha256('fixture-credential-root'),
    reviewerTrustDomainIdentityHash: sha256('fixture-trust-domain'),
    reviewerSignerIdentityHash: sha256('fixture-signer'),
    reviewerTrustSetHash: sha256('fixture-trust-set'),
    reviewerSignatureVerificationPolicyHash: sha256('fixture-signature-policy'),
  };
  const { agentExecutionReceiptHash: _receiptHash, ...receiptPayload } = receipt;
  const reviewerPayload = { ...receiptPayload, ...reviewerTrust };
  const reviewerReceipt = {
    ...reviewerPayload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', reviewerPayload),
  };
  assert.equal(verifyFreshIsolatedReviewerSessionReceipt(reviewerReceipt, {
    researchPrincipalPoolHash: reviewerTrust.researchPrincipalPoolHash,
  }), true);

  const authorPayload = {
    status: 'agent_execution_completed',
    providerMode: 'openai',
    executorId: 'fixture-managed-author-executor',
    agentId: 'fixture-managed-author',
    resolvedModel: 'fixture-managed-codex',
  };
  const authorReceipt = {
    ...authorPayload,
    agentExecutionReceiptHash:
      hashRecord('AgentExecutionReceipt', authorPayload),
  };
  const envelopeInput = {
    campaign: {
      campaignId: 'managed-reviewer-campaign',
      paperId: 'managed-reviewer-paper',
      spec: {
        approvedProposalSeed,
        autonomousResearchPreparation: {
          researchPrincipalPoolHash:
            reviewerTrust.researchPrincipalPoolHash,
        },
      },
    },
    node: {
      nodeId: 'managed-formal-review',
      attemptId: 'managed-formal-review-attempt',
    },
    authorNode: {
      nodeId: 'managed-formal-author',
      result: authorReceipt,
    },
    receipt: reviewerReceipt,
    workspace: root,
    manuscript: 'main.tex',
  };
  const managedEnvelope =
    buildCampaignFormalReviewEnvelope(envelopeInput);
  assert.match(
    managedEnvelope.reviewerPrincipalId,
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.notEqual(
    managedEnvelope.reviewerPrincipalId,
    managedEnvelope.authorPrincipalId,
  );
  assert.equal(
    managedEnvelope.blockers.includes(
      'formal_review_principal_independence_invalid',
    ),
    false,
  );
  assert.equal(
    managedEnvelope.blockers.includes(
      'proposal_claim_to_theorem_reviewerPrincipalId_invalid',
    ),
    false,
  );
  assert.match(
    managedEnvelope.proposalClaimToTheoremBindingHash,
    /^sha256:[0-9a-f]{64}$/,
  );

  const tamperedEvidence = {
    ...reviewerReceipt.openClawManagedExecutionEvidence,
    sessionCleanupVerified: false,
  };
  const {
    agentExecutionReceiptHash: _reviewerReceiptHash,
    ...tamperedReviewerPayload
  } = reviewerReceipt;
  const tamperedReceiptPayload = {
    ...tamperedReviewerPayload,
    openClawManagedExecutionEvidence: tamperedEvidence,
  };
  const tamperedReceipt = {
    ...tamperedReceiptPayload,
    agentExecutionReceiptHash:
      hashRecord('AgentExecutionReceipt', tamperedReceiptPayload),
  };
  const tamperedEnvelope = buildCampaignFormalReviewEnvelope({
    ...envelopeInput,
    receipt: tamperedReceipt,
  });
  assert.equal(tamperedEnvelope.reviewerPrincipalId, null);
  assert.ok(tamperedEnvelope.blockers.includes(
    'formal_review_principal_independence_invalid',
  ));
  assert.ok(tamperedEnvelope.blockers.includes(
    'proposal_claim_to_theorem_reviewerPrincipalId_invalid',
  ));
});

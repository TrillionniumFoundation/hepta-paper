import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { preflightCodexFormalReviewer } from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
import { bootstrapFormalReviewAgentExecutor } from '../../paper-composition/bootstrap/formal-review-agent-bootstrap.mjs';
import { relativeModuleSpecifiers } from '../verification/javascript-module-specifiers.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function directRelativeImports(file) {
  const source = fs.readFileSync(file, 'utf8');
  return new Set(relativeModuleSpecifiers(source).map((specifier) => {
    const candidate = path.resolve(path.dirname(file), specifier);
    return path.extname(candidate) ? candidate : `${candidate}.mjs`;
  }));
}

function privateCodexHome(root, name, { config = true } = {}) {
  const codexHome = path.join(root, name);
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(codexHome, 0o700);
  if (config) {
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_reasoning_effort = "high"\n', { mode: 0o600 });
    fs.chmodSync(path.join(codexHome, 'config.toml'), 0o600);
  }
  return codexHome;
}

function fakeCodexBinary(root, { loggedIn = true, rotateAuthDuringExec = false } = {}) {
  const executable = path.join(root, loggedIn ? 'codex-reviewer' : 'codex-reviewer-logged-out');
  fs.writeFileSync(executable, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { process.stdout.write('codex-cli 99.0.0\\n'); process.exit(0); }",
    "if (args[0] === 'exec' && args[1] === '--help') { process.stdout.write('Usage: codex exec --model MODEL\\n'); process.exit(0); }",
    `if (args[0] === 'login' && args[1] === 'status') { process.stdout.write('${loggedIn ? 'Logged in using fixture identity' : 'Not logged in'}\\n'); process.exit(${loggedIn ? 0 : 1}); }`,
    "process.stdin.resume();",
    "process.stdin.on('end', () => { if (" + JSON.stringify(rotateAuthDuringExec) + ") fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), '{\"fixture\":\"after0\"}\\n', {mode:0o600}); process.stdout.write(JSON.stringify({version:1,kind:'FormalClaimSemanticReview',reviews:[{claimId:'claim-1',theoremName:'verified',status:'formal_semantic_review_verified',semanticEquivalenceVerified:true,verdict:'equivalent'}]})); });",
  ].join('\n'));
  fs.chmodSync(executable, 0o700);
  return executable;
}

test('formal reviewer composition requires a distinct principal and preserves attempt isolation', () => {
  assert.throws(() => bootstrapFormalReviewAgentExecutor({
    authorAgentId: null,
    runtimeRoot: '/runtime',
  }), /formal_review_author_principal_required/);
  assert.throws(() => bootstrapFormalReviewAgentExecutor({
    provider: 'openclaw',
    authorAgentId: 'same-principal',
    reviewerAgentId: 'same-principal',
    runtimeRoot: '/runtime',
  }), /formal_review_agent_principal_must_be_distinct/);
  assert.throws(() => bootstrapFormalReviewAgentExecutor({
    provider: 'openclaw',
    authorAgentId: 'author-agent',
    reviewerAgentId: 'reviewer-agent',
    runtimeRoot: '/runtime',
  }), /formal_review_agent_capability_profile_required/);
  assert.throws(() => bootstrapFormalReviewAgentExecutor({
    provider: 'openclaw',
    authorAgentId: 'author-agent',
    reviewerAgentId: 'reviewer-agent',
    reviewerCapabilityProfilePath: '/profiles/reviewer.json',
    expectedReviewerCapabilityProfileHash: `sha256:${'a'.repeat(64)}`,
    runtimeRoot: '/runtime',
  }), /formal_review_openclaw_static_workspace_incompatible_with_attempt_isolation/);

  let codexOptions = null;
  let isolationOptions = null;
  let preflightOptions = null;
  const delegate = Object.freeze({ kind: 'reviewer-delegate' });
  const isolated = Object.freeze({ kind: 'isolated-reviewer' });
  const capabilityReceipt = Object.freeze({
    status: 'codex_formal_reviewer_capability_ready',
    codexFormalReviewerCapabilityReceiptHash: `sha256:${'a'.repeat(64)}`,
    credentialRootIdentityHash: `sha256:${'b'.repeat(64)}`,
    credentialConfigIdentityHash: `sha256:${'c'.repeat(64)}`,
    authorCredentialRootIdentityHash: null,
    credentialIndependenceVerified: true,
    providerCredentialSharingPermitted: true,
    freshEphemeralSessionRequired: true,
    authorContextInheritanceForbidden: true,
    frozenArtifactReviewRequired: true,
    reviewerMustDifferFromAuthorPrincipal: true,
    assuranceScope: 'ephemeral_session_frozen_artifact_and_role_separation',
    providerAccountIndependenceVerified: false,
    codexBinaryIdentityHash: `sha256:${'d'.repeat(64)}`,
    codexVersion: 'codex-cli fixture',
    authenticationStatus: 'codex_authentication_verified',
  });
  const result = bootstrapFormalReviewAgentExecutor({
    provider: 'codex',
    authorAgentId: 'author-agent',
    model: 'review-model',
    codexBinary: '/usr/bin/codex-reviewer',
    codexHome: '/reviewer-codex-home',
    runtimeRoot: '/runtime',
    workspaceRegistry: { kind: 'workspace-registry' },
    createCodexExecutor(options) { codexOptions = options; return delegate; },
    createIsolatedExecutor(options) { isolationOptions = options; return isolated; },
    preflightCodexReviewer(options) {
      preflightOptions = options;
      return {
        codexHome: '/reviewer-codex-home',
        effectivePrincipalId: 'codex-formal-reviewer:derived-identity',
        capabilityReceipt,
      };
    },
  });
  assert.equal(result, isolated);
  assert.deepEqual(preflightOptions, {
    codexBinary: '/usr/bin/codex-reviewer',
    codexHome: '/reviewer-codex-home',
    model: 'review-model',
    authorProvider: null,
    authorCodexHome: null,
  });
  assert.deepEqual(codexOptions, {
    codexBinary: '/usr/bin/codex-reviewer',
    codexHome: '/reviewer-codex-home',
    model: 'review-model',
    principalId: 'codex-formal-reviewer:derived-identity',
    formalReviewerCapabilityReceipt: capabilityReceipt,
  });
  assert.equal(isolationOptions.delegate, delegate);
  assert.equal(isolationOptions.isolationRoot, '/runtime/automation-formal-review-workspaces');
  assert.equal(isolationOptions.keepWorkspaces, false);
  assert.equal(isolationOptions.keepFailedWorkspaces, true);
});

test('formal reviewer positive path uses the real process-backed Codex composition without a stub executor', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-review-composition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'paper');
  const runtimeRoot = path.join(root, 'runtime');
  const codexHome = privateCodexHome(root, 'reviewer-codex-home');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.tex'), '\\begin{theorem}True.\\end{theorem}\n');
  fs.writeFileSync(path.join(workspace, 'RESEARCH_WORKER_PLAN.json'), '{"workers":[]}\n');
  const executable = fakeCodexBinary(root);

  const reviewer = bootstrapFormalReviewAgentExecutor({
    authorAgentId: 'author-principal',
    provider: 'codex',
    codexBinary: executable,
    codexHome,
    model: 'formal-review-model',
    authorProvider: 'openclaw',
    runtimeRoot,
  });
  const receipt = await reviewer.execute({
    role: 'formal-reviewer',
    workspacePath: workspace,
    instructions: 'Review the exact claim and return the required JSON.',
    context: { campaignId: 'campaign-1', nodeId: 'formal-review-1' },
    sandbox: 'read-only',
    timeoutMs: 5000,
  });
  assert.equal(receipt.status, 'agent_execution_completed');
  assert.equal(receipt.providerMode, 'openai');
  assert.match(receipt.agentId, /^codex-formal-reviewer:[a-f0-9]{32}$/);
  assert.match(receipt.executorId, /codex-formal-reviewer:[a-f0-9]{32}/);
  assert.match(receipt.codexFormalReviewerCapabilityReceiptHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(receipt.codexCredentialConfigIdentityHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(receipt.codexBinaryIdentityHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.codexCredentialIndependenceVerified, true);
  assert.equal(receipt.codexProviderCredentialSharingPermitted, true);
  assert.equal(receipt.codexFreshEphemeralSessionRequired, true);
  assert.equal(receipt.codexAuthorContextInheritanceForbidden, true);
  assert.equal(receipt.codexFrozenArtifactReviewRequired, true);
  assert.equal(receipt.sessionIsolation, 'fresh_ephemeral_no_resume');
  assert.equal(receipt.contextInheritance, 'forbidden');
  assert.equal(receipt.codexReviewerAssuranceScope,
    'ephemeral_session_frozen_artifact_and_role_separation');
  assert.equal(receipt.codexProviderAccountIndependenceVerified, false);
  assert.equal(receipt.codexAuthenticationStatus, 'codex_authentication_verified');
  assert.equal(receipt.codexVersion, 'codex-cli 99.0.0');
  assert.equal(JSON.stringify(receipt).includes(codexHome), false);
  assert.doesNotMatch(JSON.stringify(receipt), /Logged in using fixture identity/);
  assert.match(receipt.finalOutput, /FormalClaimSemanticReview/);
  assert.equal(receipt.structuredOutput.kind, 'FormalClaimSemanticReview');
  assert.deepEqual(receipt.changedPaths, []);
  assert.equal(fs.readFileSync(path.join(workspace, 'main.tex'), 'utf8'), '\\begin{theorem}True.\\end{theorem}\n');
});

test('formal reviewer rejects credential rotation during the Codex call', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-review-midflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'paper');
  const runtimeRoot = path.join(root, 'runtime');
  const codexHome = privateCodexHome(root, 'reviewer-codex-home');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"fixture":"before"}\n', {
    mode: 0o600,
  });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'unchanged\n');
  const executable = fakeCodexBinary(root, { rotateAuthDuringExec: true });
  const reviewer = bootstrapFormalReviewAgentExecutor({
    authorAgentId: 'author-principal',
    provider: 'codex',
    codexBinary: executable,
    codexHome,
    model: 'formal-review-model',
    authorProvider: 'openclaw',
    runtimeRoot,
  });
  await assert.rejects(() => reviewer.execute({
    role: 'formal-reviewer',
    workspacePath: workspace,
    instructions: 'Review without changing the workspace.',
    context: { campaignId: 'campaign-midflight', nodeId: 'formal-review-midflight' },
    sandbox: 'read-only',
    timeoutMs: 5000,
  }), (error) => {
    assert.match(error.message,
      /formal_review_codex_capability_runtime_identity_changed_during_execution/);
    assert.equal(error.retryable, false);
    return true;
  });
});

test('formal reviewer identity changes when auth material is rotated in place without reading it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-review-auth-rotation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = privateCodexHome(root, 'reviewer-home');
  const authPath = path.join(codexHome, 'auth.json');
  fs.writeFileSync(authPath, '{"fixture":"AAAAAAAA"}\n', { mode: 0o600 });
  fs.chmodSync(authPath, 0o600);
  const executable = fakeCodexBinary(root);
  const before = preflightCodexFormalReviewer({
    codexBinary: executable,
    codexHome,
    model: 'formal-review-model',
  });
  const originalTimes = fs.statSync(authPath);
  fs.writeFileSync(authPath, '{"fixture":"BBBBBBBB"}\n', { mode: 0o600 });
  fs.utimesSync(authPath, originalTimes.atime, originalTimes.mtime);
  const after = preflightCodexFormalReviewer({
    codexBinary: executable,
    codexHome,
    model: 'formal-review-model',
  });
  assert.notEqual(
    after.capabilityReceipt.credentialRootIdentityHash,
    before.capabilityReceipt.credentialRootIdentityHash,
  );
  assert.notEqual(
    after.capabilityReceipt.codexFormalReviewerCapabilityReceiptHash,
    before.capabilityReceipt.codexFormalReviewerCapabilityReceiptHash,
  );
  assert.notEqual(after.effectivePrincipalId, before.effectivePrincipalId);
});

test('formal reviewer preflight rejects unsafe roots while allowing shared provider credentials', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-review-preflight-negative-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missingConfigHome = privateCodexHome(root, 'missing-config', { config: false });
  const reviewerHome = privateCodexHome(root, 'reviewer-home');
  const authorHome = privateCodexHome(root, 'author-home');
  const executable = fakeCodexBinary(root);
  const loggedOutExecutable = fakeCodexBinary(root, { loggedIn: false });

  assert.throws(() => preflightCodexFormalReviewer({
    codexBinary: executable,
    model: 'formal-review-model',
  }), /formal_review_codex_home_required/);
  assert.throws(() => preflightCodexFormalReviewer({
    codexBinary: executable,
    codexHome: missingConfigHome,
    model: 'formal-review-model',
  }), /formal_review_codex_config_required/);
  assert.throws(() => preflightCodexFormalReviewer({
    codexBinary: loggedOutExecutable,
    codexHome: reviewerHome,
    model: 'formal-review-model',
  }), /formal_review_codex_authentication_required/);
  const sharedCredentialReviewer = preflightCodexFormalReviewer({
    codexBinary: executable,
    codexHome: reviewerHome,
    model: 'formal-review-model',
    authorProvider: 'codex',
    authorCodexHome: reviewerHome,
  });
  assert.equal(sharedCredentialReviewer.capabilityReceipt.credentialIndependenceVerified, false);
  assert.equal(
    sharedCredentialReviewer.capabilityReceipt.providerCredentialSharingPermitted,
    true,
  );
  assert.equal(
    sharedCredentialReviewer.capabilityReceipt.assuranceScope,
    'ephemeral_session_frozen_artifact_and_role_separation',
  );
  fs.chmodSync(path.join(reviewerHome, 'config.toml'), 0o644);
  assert.throws(() => preflightCodexFormalReviewer({
    codexBinary: executable,
    codexHome: reviewerHome,
    model: 'formal-review-model',
  }), /formal_review_codex_config_permissions_invalid/);
  fs.chmodSync(path.join(reviewerHome, 'config.toml'), 0o600);
  fs.chmodSync(authorHome, 0o755);
  assert.throws(() => preflightCodexFormalReviewer({
    codexBinary: executable,
    codexHome: reviewerHome,
    model: 'formal-review-model',
    authorProvider: 'codex',
    authorCodexHome: authorHome,
  }), /formal_review_codex_author_home_permissions_invalid/);
  fs.chmodSync(authorHome, 0o700);
  const reviewerAuthPath = path.join(reviewerHome, 'auth.json');
  fs.writeFileSync(reviewerAuthPath, '{}\n', { mode: 0o600 });
  fs.chmodSync(reviewerAuthPath, 0o600);
  const linkedAuthPath = path.join(root, 'linked-auth.json');
  fs.linkSync(reviewerAuthPath, linkedAuthPath);
  assert.throws(() => preflightCodexFormalReviewer({
    codexBinary: executable,
    codexHome: reviewerHome,
    model: 'formal-review-model',
  }), /formal_review_codex_credential_material_links_invalid/);
  fs.unlinkSync(linkedAuthPath);
  fs.chmodSync(reviewerAuthPath, 0o644);
  assert.throws(() => preflightCodexFormalReviewer({
    codexBinary: executable,
    codexHome: reviewerHome,
    model: 'formal-review-model',
  }), /formal_review_codex_credential_material_permissions_invalid/);
  fs.chmodSync(reviewerAuthPath, 0o600);
  const independent = preflightCodexFormalReviewer({
    codexBinary: executable,
    codexHome: reviewerHome,
    model: 'formal-review-model',
    authorProvider: 'codex',
    authorCodexHome: authorHome,
  });
  assert.equal(independent.capabilityReceipt.credentialIndependenceVerified, true);
  assert.equal(independent.capabilityReceipt.assuranceScope,
    'ephemeral_session_frozen_artifact_and_role_separation');
  assert.equal(independent.capabilityReceipt.providerAccountIndependenceVerified, false);
  assert.notEqual(
    independent.capabilityReceipt.credentialRootIdentityHash,
    independent.capabilityReceipt.authorCredentialRootIdentityHash,
  );
  assert.throws(() => preflightCodexFormalReviewer({
    codexBinary: executable,
    codexHome: reviewerHome,
  }), /formal_review_codex_model_required/);
});

test('paper campaign delegates concrete worker and reviewer assembly to composition', () => {
  const cliPath = path.resolve(testDirectory, '../bin/paper-campaign.mjs');
  const commandFacadePath = path.resolve(testDirectory, '../../paper-composition/automation/paper-campaign-command-composition.mjs');
  const workerCompositionPath = path.resolve(testDirectory, '../../paper-composition/automation/campaign-worker-composition.mjs');
  const executionContextPath = path.resolve(testDirectory, '../../paper-composition/bootstrap/campaign-execution-context-bootstrap.mjs');
  const formalReviewCompositionPath = path.resolve(testDirectory, '../../paper-composition/bootstrap/formal-review-agent-bootstrap.mjs');
  const cliSource = fs.readFileSync(cliPath, 'utf8');
  const commandFacadeSource = fs.readFileSync(commandFacadePath, 'utf8');
  const workerCompositionSource = fs.readFileSync(workerCompositionPath, 'utf8');
  const executionContextSource = fs.readFileSync(executionContextPath, 'utf8');

  assert.equal(directRelativeImports(cliPath).has(commandFacadePath), true);
  assert.equal(directRelativeImports(commandFacadePath).has(workerCompositionPath), true);
  assert.equal(directRelativeImports(commandFacadePath).has(executionContextPath), true);
  assert.equal(directRelativeImports(executionContextPath).has(formalReviewCompositionPath), true);
  assert.match(cliSource, /executePaperCampaignCommand\(\{/);
  assert.match(commandFacadeSource, /composeCampaignWorkerExecution\(\{/);
  assert.doesNotMatch(cliSource, /from ['"][^'"]*paper-adapters\//);
  assert.match(workerCompositionSource, /campaignExecutionContext\.createFormalReviewAgentExecutor\(\{/);
  assert.match(workerCompositionSource,
    /provider:\s*boundProviderConfiguration[\s\S]*formalReviewer\.provider/);
  assert.match(workerCompositionSource, /expectedProviderConfigurationHash/);
  assert.doesNotMatch(workerCompositionSource, /process\.env/);
  assert.match(executionContextSource, /return bootstrapFormalReviewAgentExecutor\(\{/);
  assert.match(executionContextSource, /workspaceRegistry:\s*context\.services\.workspaceRegistry/);
});

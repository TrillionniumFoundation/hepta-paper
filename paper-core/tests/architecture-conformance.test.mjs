import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { JOURNAL_PROFILE_DATASET } from '../../paper-adapters/journal-manage/journal-registry.mjs';
import { createSqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';
import { createLeanFormalVerifier } from '../../paper-adapters/research-verify/formal-verifier.mjs';
import { createSandboxedCommandRunner } from '../../paper-adapters/runtime/sandboxed-command-runner.mjs';
import { buildResearchGapPlan } from '../../paper-application/research/gap-planner.mjs';
import { createExecutionContext } from '../src/execution-context.mjs';
import { PAPER_BATCH_MODES, assertPaperMode } from '../src/mode-registry.mjs';
import { runWorkflowStages } from '../src/workflow-engine.mjs';
import { buildClaimRegistry } from '../../paper-domain/research/claim-registry.mjs';
import { buildEvidenceIntake } from '../../paper-domain/research/evidence-ingestor.mjs';
import { buildEvidenceQualityGate } from '../../paper-domain/research/evidence-quality-gate.mjs';
import {
  buildSubmissionDeliveryRuntime,
  buildSubmissionDispatchAuthorization,
} from '../../paper-domain/submission/delivery-runtime.mjs';
import { LEGACY_CAPABILITY_MATRIX_V3 } from '../../migration/legacy-capability-matrix-v3.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

test('workflow registry executes ordered stages and propagates action facts', async () => {
  const definition = assertPaperMode(PAPER_BATCH_MODES.LOCAL_PACKAGE);
  const context = createExecutionContext({
    root: workspaceRoot,
    runtimeRoot: path.join(workspaceRoot, 'runtime'),
    mode: definition.mode,
  });
  const execution = await runWorkflowStages({
    definition,
    context,
    handlers: {
      build: async () => ({ build: { status: 'ready', externalActionPerformed: false } }),
      package: async ({ state }) => ({ package: { status: state.build.status, externalActionPerformed: false } }),
    },
  });
  assert.deepEqual(execution.workflowReceipt.stages.map((stage) => stage.stage), ['build', 'package']);
  assert.equal(execution.workflowReceipt.externalActionPerformed, false);
  const actionExecution = await runWorkflowStages({
    definition: { mode: 'test-action', stages: ['action'] },
    context,
    handlers: { action: async () => ({ result: { externalActionPerformed: true } }) },
  });
  assert.equal(actionExecution.workflowReceipt.externalActionPerformed, true);
});

test('artifact repository enforces declared scope and emits atomic receipts', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-artifact-port-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repository = createFilesystemArtifactRepository({ scopeRoot: root });
  const target = path.join(root, 'nested', 'receipt.json');
  const receipt = await repository.writeJson(target, { ok: true }, { role: 'contract-test', atomic: true });
  assert.equal(receipt.kind, 'ArtifactWriteReceipt');
  assert.equal(receipt.atomic, true);
  assert.equal(receipt.externalActionPerformed, false);
  assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { ok: true });
  await assert.rejects(repository.writeText(path.join(root, '..', 'escape.txt'), 'blocked'));
});

test('SQLite adapter implements StorePort without leaking the process primitive', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-store-port-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = createSqliteStore({ dbPath: path.join(root, 'store.sqlite') });
  assert.equal(store.available(), true);
  assert.equal(store.execute('CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample(value) VALUES (\'ok\');').ok, true);
  assert.deepEqual(store.query('SELECT value FROM sample;').rows, [{ value: 'ok' }]);
});

test('submission delivery runtime remains fail-closed and has no executor implementation', () => {
  const paperTask = { paperId: 'paper-1', taskKey: 'paper:paper-1' };
  const inputs = {
    paperTask,
    outbox: { status: 'queued_for_dry_run_executor', externalExecutorHandoffOutboxHash: 'outbox-hash' },
    replayGuard: { status: 'dry_run_replay_allowed', submissionReplayGuardHash: 'replay-hash' },
    reviewedSubmitPreflightPacket: {
      status: 'reviewed_submit_preflight_ready_for_external_executor',
      reviewedSubmitPreflightPacketHash: 'preflight-hash',
    },
    controlledExecutorReceipt: {
      status: 'controlled_external_executor_receipt_recorded',
      controlledExternalExecutorReceiptHash: 'controlled-hash',
    },
    liveAuthorizationReceipt: {
      status: 'live_submission_authorization_verified',
      liveSubmissionAuthorizationReceiptHash: 'authorization-hash',
      provider: 'contract-test-provider',
      accountId: 'contract-test-account',
      nonce: 'contract-test-nonce',
    },
    reconciliation: { status: 'live_submission_reconciled', submissionReconciliationHash: 'reconcile-hash' },
  };
  const dispatch = buildSubmissionDispatchAuthorization(inputs);
  assert.equal(dispatch.status, 'submission_dispatch_authorization_ready');
  const runtime = buildSubmissionDeliveryRuntime({
    ...inputs,
    executorResponse: {
      responseId: 'response-1',
      outcome: 'submitted',
      dispatchAuthorizationHash: dispatch.submissionDispatchAuthorizationHash,
      providerReceiptHash: 'provider-receipt-hash',
      attempt: 1,
    },
  });
  assert.equal(runtime.status, 'submission_delivery_complete');
  assert.equal(runtime.executorImplementationPresent, false);
  assert.equal(runtime.externalActionPerformed, false);
  assert.equal(buildSubmissionDeliveryRuntime({ paperTask }).status, 'submission_delivery_blocked');
});

test('sandbox and formal verifier ports reject unbounded execution', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-formal-port-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const runner = createSandboxedCommandRunner({ allowedExecutables: ['lean'], allowedRoots: [root] });
  assert.deepEqual(runner.run({ executable: 'bash', cwd: root }).blockers, ['worker_executable_not_allowlisted']);
  const inputPath = path.join(root, 'Proof.lean');
  await fsp.writeFile(inputPath, 'theorem ok : True := by trivial\n');
  const verifier = createLeanFormalVerifier({
    sourceRoot: root,
    commandRunner: {
      run() {
        return { ok: true, exitCode: 0, stdout: '', stderr: '', blockers: [], safety: { externalActionPerformed: false } };
      },
    },
  });
  assert.equal(verifier.verify({
    inputRecords: [{ absolutePath: inputPath, path: 'Proof.lean', hash: 'sha256:test' }],
  }).status, 'formal_verifier_passed');
});

test('research bounded contexts require claim, artifact, and native receipt coverage', () => {
  const paperTask = { paperId: 'paper-1' };
  const claimRegistry = buildClaimRegistry({ paperTask, claims: [{ id: 'claim-1', text: 'claim' }] });
  const evidenceIntake = buildEvidenceIntake({
    paperTask,
    evidenceItems: [{ id: 'evidence-1', claimIds: ['claim-1'], path: 'artifact.json', hash: 'sha256:artifact' }],
  });
  const blocked = buildEvidenceQualityGate({ paperTask, claimRegistry, evidenceIntake, nativeWorkerReceipts: [] });
  assert.equal(blocked.status, 'evidence_quality_blocked');
  assert.equal(buildResearchGapPlan({ paperTask, claimRegistry, evidenceQualityGate: blocked }).jobs.length, 1);
  const ready = buildEvidenceQualityGate({
    paperTask,
    claimRegistry,
    evidenceIntake,
    nativeWorkerReceipts: [{ academicEvidenceEligible: true, claimIds: ['claim-1'] }],
  });
  assert.equal(ready.status, 'evidence_quality_ready');
});

test('capability and journal datasets are versioned and schema-valid', () => {
  assert.equal(LEGACY_CAPABILITY_MATRIX_V3.summary.entryCount, 249);
  assert.deepEqual(LEGACY_CAPABILITY_MATRIX_V3.summary.byDecision, {
    permanent_retirement: 88,
    superseded_with_coverage: 40,
    capability_reimplementation: 121,
  });
  assert.equal(LEGACY_CAPABILITY_MATRIX_V3.summary.ownerAcceptancePending, 249);
  assert.equal(JOURNAL_PROFILE_DATASET.version, 1);
  assert.equal(JOURNAL_PROFILE_DATASET.profiles.length, 97);
  assert.equal(JOURNAL_PROFILE_DATASET.validation.status, 'journal_profile_dataset_valid');
});

test('production modules do not bypass StorePort or restore autopilot acceptance', () => {
  const productionFiles = [
    ...fs.readdirSync(path.join(workspaceRoot, 'paper-core', 'src'), { recursive: true })
      .filter((entry) => typeof entry === 'string' && entry.endsWith('.mjs'))
      .map((entry) => path.join(workspaceRoot, 'paper-core', 'src', entry)),
    ...fs.readdirSync(path.join(workspaceRoot, 'paper-adapters'), { recursive: true })
      .filter((entry) => typeof entry === 'string' && entry.endsWith('.mjs'))
      .map((entry) => path.join(workspaceRoot, 'paper-adapters', entry)),
  ].filter((file) => !file.endsWith('selftest.mjs'));
  const source = productionFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.equal(/spawnSync\(['"]sqlite3['"]|spawn\(['"]sqlite3['"]/.test(source), false);
  assert.equal(source.includes('RefereeAutopilotAcceptanceReceipt'), false);
  assert.equal(source.includes('AUTOPILOT_ACCEPTANCE_RECEIPT'), false);
  assert.equal(source.includes('researchReady'), false);
  for (const file of productionFiles) {
    if (file.endsWith('filesystem-artifact-repository.mjs')) continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(/\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync)\(/.test(text), false, file);
  }
});

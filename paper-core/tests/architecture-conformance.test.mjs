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
  buildExecutorResponseIntake,
  buildSubmissionDeliveryRuntime,
  buildSubmissionDispatchAuthorization,
} from '../../paper-domain/submission/delivery-runtime.mjs';
import { createPaperArtifactPackage } from '../../paper-domain/contracts/workflow-contracts.mjs';
import { LEGACY_CAPABILITY_MATRIX_V3 } from '../../migration/legacy-capability-matrix-v3.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

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
      'research-verify': async ({ state }) => ({ research: { status: state.build.status, externalActionPerformed: false } }),
      package: async ({ state }) => ({ package: { status: state.build.status, externalActionPerformed: false } }),
    },
  });
  assert.deepEqual(execution.workflowReceipt.stages.map((stage) => stage.stage), ['build', 'research-verify', 'package']);
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
  const repository = createFilesystemArtifactRepository({
    scopeRoot: root,
    casRoot: path.join(root, 'cas'),
    clock: { nowIso: () => '2026-07-10T00:00:00.000Z' },
    receiptLedger: { record: (_receipt) => ({ receiptId: 'test-ledger-receipt' }) },
  });
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
  const artifactPackage = createPaperArtifactPackage({ paperTask, artifacts: [{ path: 'paper.pdf', hash: `sha256:${'a'.repeat(64)}` }], submitReady: true });
  const reviewedVenueEvidence = { status: 'reviewed_venue_evidence_verified', reviewedVenueEvidenceHash: `sha256:${'1'.repeat(64)}`, sourceVerificationReceiptHash: `sha256:${'2'.repeat(64)}`, observationSubjectHash: `sha256:${'4'.repeat(64)}`, reviewedBy: 'venue-observer', purpose: 'submission_preflight', portalRoute: '/submit' };
  const providerCapabilityVerificationReceipt = { status: 'provider_capability_verified', portalRoute: '/submit', providerCapabilityVerificationReceiptHash: `sha256:${'3'.repeat(64)}` };
  const inputs = {
    paperTask,
    artifactPackage,
    outbox: { status: 'queued_for_dry_run_executor', externalExecutorHandoffOutboxHash: 'outbox-hash' },
    replayGuard: { status: 'dry_run_replay_allowed', submissionReplayGuardHash: 'replay-hash', replayKey: `sha256:${'c'.repeat(64)}` },
    reviewedSubmitPreflightPacket: {
      status: 'reviewed_submit_preflight_ready_for_external_executor',
      reviewedSubmitPreflightPacketHash: 'preflight-hash',
      artifactPackageHash: artifactPackage.artifactPackageHash,
    },
    controlledExecutorReceipt: {
      status: 'controlled_external_executor_receipt_recorded',
      controlledExternalExecutorReceiptHash: 'controlled-hash',
      executorId: 'contract-executor',
      executorDescriptorHash: `sha256:${'d'.repeat(64)}`,
      executorCapabilitiesHash: `sha256:${'e'.repeat(64)}`,
    },
    liveAuthorizationReceipt: {
      status: 'live_submission_authorization_verified',
      liveSubmissionAuthorizationReceiptHash: 'authorization-hash',
      provider: 'contract-test-provider',
      accountId: 'contract-test-account',
      nonce: 'contract-test-nonce',
      authorizationSubject: { artifactPackageHash: artifactPackage.artifactPackageHash, executorDescriptorHash: `sha256:${'d'.repeat(64)}`, reviewedSubmissionDecisionPacketHash: `sha256:${'f'.repeat(64)}`, reviewedVenueEvidenceHash: reviewedVenueEvidence.reviewedVenueEvidenceHash, venueObservationSourceVerificationReceiptHash: reviewedVenueEvidence.sourceVerificationReceiptHash, venueTarget: 'Contract Venue', portalRoute: '/submit', providerCapabilityVerificationReceiptHash: providerCapabilityVerificationReceipt.providerCapabilityVerificationReceiptHash },
      responseDueAt: '2026-07-13T02:00:00.000Z',
    },
    submissionDecisionPacket: { status: 'reviewed_submission_decision_verified', reviewedSubmissionDecisionPacketHash: `sha256:${'f'.repeat(64)}` },
    reviewedVenueEvidence,
    providerCapabilityVerificationReceipt,
  };
  const dispatch = buildSubmissionDispatchAuthorization(inputs);
  assert.equal(dispatch.status, 'submission_dispatch_authorization_ready');
  const providerReceipt = { provider: 'contract-test-provider', accountId: 'contract-test-account', submissionId: 'submission-1', dispatchAuthorizationHash: dispatch.submissionDispatchAuthorizationHash, uploadedArtifactHashes: dispatch.expectedArtifactHashes };
  const executorResponse = {
    responseId: 'response-1',
    outcome: 'submitted',
    dispatchAuthorizationHash: dispatch.submissionDispatchAuthorizationHash,
    provider: 'contract-test-provider',
    accountId: 'contract-test-account',
    submissionId: 'submission-1',
    providerReceipt,
    providerReceiptHash: hashRecord('ProviderSubmissionReceipt', providerReceipt),
    uploadedArtifactHashes: dispatch.expectedArtifactHashes,
    performedAt: '2026-07-13T00:00:00.000Z',
    attempt: 1,
    executorId: dispatch.executorId,
    executorDescriptorHash: dispatch.executorDescriptorHash,
    capabilitiesHash: dispatch.executorCapabilitiesHash,
  };
  const executorResponseVerificationReceipt = { version: 1, kind: 'ExecutorResponseVerificationReceipt', status: 'executor_response_signature_verified', responseId: executorResponse.responseId, dispatchAuthorizationHash: dispatch.submissionDispatchAuthorizationHash, executorId: dispatch.executorId, executorDescriptorHash: dispatch.executorDescriptorHash, capabilitiesHash: dispatch.executorCapabilitiesHash, cryptographicSignaturesVerified: true, executorResponseVerificationReceiptHash: `sha256:${'9'.repeat(64)}` };
  const responseIntake = buildExecutorResponseIntake({ dispatchAuthorization: dispatch, response: executorResponse, responseVerificationReceipt: executorResponseVerificationReceipt });
  const runtime = buildSubmissionDeliveryRuntime({
    ...inputs,
    executorResponse,
    executorResponseVerificationReceipt,
    venueObservation: {
      dispatchAuthorizationHash: dispatch.submissionDispatchAuthorizationHash,
      executorResponseIntakeHash: responseIntake.executorResponseIntakeHash,
      provider: 'contract-test-provider',
      accountId: 'contract-test-account',
      submissionId: 'submission-1',
      providerReceiptHash: executorResponse.providerReceiptHash,
      observedState: 'received',
      observedAt: '2026-07-13T00:01:00.000Z',
      evidenceHashes: [`sha256:${'b'.repeat(64)}`],
    },
  });
  assert.equal(runtime.status, 'submission_delivery_complete');
  assert.equal(runtime.executorImplementationPresent, false);
  assert.equal(runtime.externalActionPerformed, true);
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

test('research bounded contexts apply typed worker requirements to formal claims', () => {
  const paperTask = { paperId: 'paper-1' };
  const claimRegistry = buildClaimRegistry({ paperTask, claims: [{
    id: 'claim-1',
    text: 'claim',
    sourceLocator: 'main.tex#claim-1',
    claimKind: 'formal',
    proofObligations: ['obligation-1'],
    verificationPlan: { kind: 'formal' },
  }] });
  const evidenceIntake = buildEvidenceIntake({
    paperTask,
    evidenceItems: [{ id: 'evidence-1', claimIds: ['claim-1'], path: 'artifact.json', hash: 'sha256:artifact', verifiedHash: 'sha256:artifact', verificationStatus: 'evidence_artifact_verified', provenanceReceiptHash: 'sha256:provenance', createdAt: new Date().toISOString() }],
  });
  const blocked = buildEvidenceQualityGate({ paperTask, claimRegistry, evidenceIntake, nativeWorkerReceipts: [] });
  assert.equal(blocked.status, 'evidence_quality_blocked');
  assert.equal(buildResearchGapPlan({ paperTask, claimRegistry, evidenceQualityGate: blocked }).jobs.length, 1);
  const forgedWorker = buildEvidenceQualityGate({
    paperTask,
    claimRegistry,
    evidenceIntake,
    nativeWorkerReceipts: [{ status: 'native_research_worker_receipt_verified', receiptHash: 'sha256:receipt', sourceSnapshotHash: 'sha256:source', claimIds: ['claim-1'] }],
  });
  assert.equal(forgedWorker.status, 'evidence_quality_blocked');
  assert.equal(forgedWorker.workerLedgerVerifications[0].status, 'trusted_ledger_receipt_blocked');
});

test('capability and journal datasets are versioned and schema-valid', () => {
  assert.equal(LEGACY_CAPABILITY_MATRIX_V3.summary.entryCount, 249);
  assert.deepEqual(LEGACY_CAPABILITY_MATRIX_V3.summary.byDecision, {
    permanent_retirement: 209,
    superseded_with_coverage: 40,
    capability_reimplementation: 0,
  });
  assert.equal(LEGACY_CAPABILITY_MATRIX_V3.summary.decisionMapped, 249);
  assert.equal(LEGACY_CAPABILITY_MATRIX_V3.summary.implementationNotApplicable, 209);
  assert.ok(Number.isInteger(LEGACY_CAPABILITY_MATRIX_V3.summary.implementationVerified));
  assert.ok(LEGACY_CAPABILITY_MATRIX_V3.summary.implementationVerified >= 0);
  assert.ok(LEGACY_CAPABILITY_MATRIX_V3.summary.implementationVerified <= 40);
  assert.ok(LEGACY_CAPABILITY_MATRIX_V3.summary.operationallyProven <= LEGACY_CAPABILITY_MATRIX_V3.summary.implementationVerified);
  assert.equal(
    LEGACY_CAPABILITY_MATRIX_V3.summary.operationallyProven + LEGACY_CAPABILITY_MATRIX_V3.summary.operationallyNotProven,
    40,
  );
  assert.equal(
    LEGACY_CAPABILITY_MATRIX_V3.summary.ownerAccepted + LEGACY_CAPABILITY_MATRIX_V3.summary.ownerAcceptancePending,
    LEGACY_CAPABILITY_MATRIX_V3.summary.entryCount,
  );
  assert.equal(JOURNAL_PROFILE_DATASET.version, 1);
  assert.equal(JOURNAL_PROFILE_DATASET.profiles.length, 97);
  assert.equal(JOURNAL_PROFILE_DATASET.validation.status, 'journal_profile_dataset_valid');
});

test('production modules do not bypass StorePort or restore autopilot acceptance', () => {
  const productionFiles = [
    'paper-core/src',
    'paper-application',
    'paper-composition',
    'paper-adapters',
    'paper-domain',
    'paper-ports',
    'workflow-kernel',
  ].flatMap((root) => fs.readdirSync(path.join(workspaceRoot, root), { recursive: true })
    .filter((entry) => typeof entry === 'string' && entry.endsWith('.mjs'))
    .map((entry) => path.join(workspaceRoot, root, entry)))
    .filter((file) => !file.endsWith('selftest.mjs') && !file.includes(`${path.sep}tests${path.sep}`));
  const source = productionFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.equal(/spawnSync\(['"]sqlite3['"]|spawn\(['"]sqlite3['"]/.test(source), false);
  assert.equal(source.includes('RefereeAutopilotAcceptanceReceipt'), false);
  assert.equal(source.includes('AUTOPILOT_ACCEPTANCE_RECEIPT'), false);
  assert.equal(source.includes('researchReady'), false);
  assert.equal(source.includes('./bin/paperctl merge-queue'), false);
  assert.equal(source.includes('hepta-paper://repair.safe-apply/v1'), true);
  assert.equal(source.includes("../../core/src/hash-utils.mjs"), false);
  const researchRuntime = fs.readFileSync(path.join(workspaceRoot, 'paper-adapters', 'research-verify', 'index.mjs'), 'utf8');
  assert.equal(researchRuntime.includes("path.join(root, 'paperctl_modules')"), false);
  assert.equal(source.includes("from './utils.mjs'"), false);
  const batchApplication = fs.readFileSync(path.join(workspaceRoot, 'paper-composition', 'batch', 'paper-batch-application.mjs'), 'utf8');
  assert.equal(/run(?:LatexBuild|Package|ResearchVerify|RefereeReview|RefereeRevise|EmpiricalAnalysis)Adapter/.test(batchApplication), false);
  assert.equal(batchApplication.includes('createDefaultPaperStore('), false);
  assert.equal(batchApplication.includes('function stateWithAdapterResults'), false);
  assert.equal(batchApplication.includes('writeJsonFile('), false);
  assert.equal(batchApplication.includes('bootstrapPaperExecutionContext'), true);
  const localLoop = fs.readFileSync(path.join(workspaceRoot, 'paper-application', 'use-cases', 'local-diagnostic-review-loop.mjs'), 'utf8');
  assert.equal(localLoop.includes('executeLocalDiagnosticRound'), true);
  assert.equal(/run(?:LatexBuild|Package|ResearchVerify|RefereeReview|RefereeRevise)Adapter/.test(localLoop), false);
  const domainSource = productionFiles.filter((file) => file.includes(`${path.sep}paper-domain${path.sep}`)).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.equal(domainSource.includes('paper-core/'), false);
  const adapterSource = productionFiles.filter((file) => file.includes(`${path.sep}paper-adapters${path.sep}`)).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.equal(adapterSource.includes('paper-application/'), false);
  assert.equal(/from ['"][^'"]*paper-core\/src\//.test(adapterSource), false);
  const applicationSource = productionFiles.filter((file) => file.includes(`${path.sep}paper-application${path.sep}`)).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.equal(/from ['"][^'"]*paper-core\/src\//.test(applicationSource), false);
  const applicationFiles = productionFiles.filter((file) => file.includes(`${path.sep}paper-application${path.sep}`));
  const directApplicationAdapterImports = applicationFiles.filter((file) => /from ['"][^'"]*paper-adapters\//.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(directApplicationAdapterImports, []);
  const directIssuerMintConsumers = productionFiles.filter((file) => {
    if (file.endsWith(`${path.sep}receipt-writer-broker.mjs`) || file.endsWith(`${path.sep}receipt-issuer-policy.mjs`)) return false;
    return fs.readFileSync(file, 'utf8').includes('issueReceiptWriterCapability');
  });
  assert.deepEqual(directIssuerMintConsumers, []);
  const brokerImporters = productionFiles
    .filter((file) => /from ['"][^'"]*receipt-writer-broker\.mjs['"]/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(workspaceRoot, file));
  assert.deepEqual(brokerImporters, ['paper-composition/bootstrap/receipt-ledger-composition.mjs']);
  const compositionSource = fs.readFileSync(path.join(workspaceRoot, brokerImporters[0]), 'utf8');
  assert.equal(compositionSource.includes('issuerCapability: issue()'), true);
  assert.equal(compositionSource.includes('issuerCapability:'), true);
  const trustedCompositionRoots = [
    'paper-core/bin',
    'paper-application',
    'paper-composition',
    'paper-adapters',
    'paper-domain',
    'paper-ports',
    'workflow-kernel',
    'migration/bin',
  ].flatMap((root) => fs.readdirSync(path.join(workspaceRoot, root), { recursive: true })
    .filter((entry) => typeof entry === 'string' && entry.endsWith('.mjs'))
    .map((entry) => path.join(workspaceRoot, root, entry)));
  const repositoryBrokerImporters = trustedCompositionRoots
    .filter((file) => /from ['"][^'"]*receipt-writer-broker\.mjs['"]/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(workspaceRoot, file))
    .sort();
  assert.deepEqual(repositoryBrokerImporters, [
    'migration/bin/refresh-production-capability-verification.mjs',
    'migration/bin/run-production-capability-replays.mjs',
    'paper-composition/bootstrap/receipt-ledger-composition.mjs',
    'paper-core/bin/automation-reconcile.mjs',
    'paper-core/bin/repair-receipt-ledger-integrity.mjs',
    'paper-core/bin/runtime-hygiene.mjs',
  ]);
  const writeFacade = fs.readFileSync(path.join(workspaceRoot, 'paper-adapters', 'artifacts', 'write-artifact.mjs'), 'utf8');
  assert.equal(writeFacade.includes('createFilesystemArtifactRepository'), false);
  assert.equal(writeFacade.includes('requires an ExecutionContext-backed persistent ledger'), true);
  const nonPersistenceAdapters = productionFiles
    .filter((file) => file.includes(`${path.sep}paper-adapters${path.sep}`))
    .filter((file) => !file.includes(`${path.sep}paper-adapters${path.sep}persistence${path.sep}`));
  for (const file of nonPersistenceAdapters) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes('createDefaultPaperStore('), false, file);
    assert.equal(text.includes('createSqliteStore('), false, file);
    assert.equal(text.includes('resolvePaperStore('), false, file);
  }
  for (const file of productionFiles) {
    if (file.endsWith('-repository.mjs')) continue;
    if (file.endsWith('ollama-structured-agent-executor.mjs')) continue;
    if (file.endsWith('generated-latex-sanitizer.mjs')) continue;
    if (file.endsWith('runtime-retention.mjs')) continue;
    if (file.endsWith('workspace-snapshot-exporter.mjs')) continue;
    // This module emits code that can write only inside the kernel-isolated
    // ephemeral work root; host materialization still goes through CAS.
    if (file.endsWith('empirical-analysis/experiment-runner.mjs')) continue;
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(/\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync)\(/.test(text), false, file);
  }
});

test('high-risk adapters remain split into bounded modules', () => {
  const boundedModules = [
    'paper-adapters/empirical-analysis/index.mjs',
    'paper-adapters/empirical-analysis/benchmark-contracts.mjs',
    'paper-adapters/empirical-analysis/execution-contracts.mjs',
    'paper-adapters/journal-manage/index.mjs',
    'paper-adapters/journal-manage/selection.mjs',
    'paper-adapters/journal-manage/contracts.mjs',
    'paper-adapters/referee-revise/index.mjs',
    'paper-adapters/referee-revise/planning-service.mjs',
    'paper-adapters/referee-revise/post-repair.mjs',
    'paper-adapters/referee-revise/reconciliation.mjs',
    'paper-adapters/proposal/index.mjs',
    'paper-adapters/proposal/proposal-generation.mjs',
    'paper-adapters/proposal/proposal-materialization.mjs',
    'paper-application/reporting/batch-result-summary.mjs',
    'paper-application/reporting/workflow-result-summary.mjs',
  ];
  const rows = boundedModules.map((relative) => ({
    relative,
    lines: fs.readFileSync(path.join(workspaceRoot, relative), 'utf8').split(/\n/).length - 1,
  }));
  assert.equal(Math.max(...rows.map((row) => row.lines)) <= 700, true, JSON.stringify(rows));
  for (const relative of [
    'paper-adapters/empirical-analysis/index.mjs',
    'paper-adapters/journal-manage/index.mjs',
    'paper-adapters/referee-revise/index.mjs',
    'paper-adapters/proposal/index.mjs',
  ]) {
    assert.equal(rows.find((row) => row.relative === relative).lines <= 400, true, relative);
  }
});

test('legacy cleanup is retired from the production adapter and mode surfaces', () => {
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'paper-adapters', 'legacy-cleanup')), false);
  const modeRegistry = fs.readFileSync(path.join(workspaceRoot, 'paper-core', 'src', 'mode-registry.mjs'), 'utf8');
  const batchApplication = fs.readFileSync(path.join(workspaceRoot, 'paper-composition', 'batch', 'paper-batch-application.mjs'), 'utf8');
  assert.equal(modeRegistry.includes('legacy-cleanup'), false);
  assert.equal(batchApplication.includes('runLegacyCleanupAdapter'), false);
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'migration', 'retirement', 'audit.mjs')), true);
});

test('contract implementations have one domain owner and the receipt ledger is immutable', () => {
  const compatibilityFiles = [
    'paper-core/src/paper-contracts.mjs',
    'paper-core/src/paper-contract-primitives.mjs',
    ...fs.readdirSync(path.join(workspaceRoot, 'paper-core', 'src', 'contracts')).map((name) => `paper-core/src/contracts/${name}`),
  ];
  for (const relative of compatibilityFiles) {
    const source = fs.readFileSync(path.join(workspaceRoot, relative), 'utf8').trim();
    assert.match(source, /^export \* from ['"][^'"]*paper-domain\/contracts\//, relative);
    assert.equal(source.split(/\r?\n/).length, 1, relative);
  }
  const immutableLedgerSources = ['paper-adapters', 'paper-application', 'paper-composition', 'paper-core/bin']
    .flatMap((root) => fs.readdirSync(path.join(workspaceRoot, root), { recursive: true })
      .filter((entry) => typeof entry === 'string' && entry.endsWith('.mjs'))
      .map((entry) => path.join(workspaceRoot, root, entry)));
  const source = immutableLedgerSources.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.equal(/(?:UPDATE|DELETE\s+FROM)\s+receipt_ledger\b/i.test(source), false);
});

test('TaskFlow remains an optional outer coordinator and workflow state remains native', () => {
  const controller = fs.readFileSync(path.join(workspaceRoot, 'paper-application', 'orchestration', 'reviewed-submit-taskflow.mjs'), 'utf8');
  const adapter = fs.readFileSync(path.join(workspaceRoot, 'paper-adapters', 'orchestration', 'openclaw-taskflow-adapter.mjs'), 'utf8');
  const domainSource = fs.readdirSync(path.join(workspaceRoot, 'paper-domain'), { recursive: true })
    .filter((entry) => typeof entry === 'string' && entry.endsWith('.mjs'))
    .map((entry) => fs.readFileSync(path.join(workspaceRoot, 'paper-domain', entry), 'utf8'))
    .join('\n');
  assert.equal(domainSource.includes('TaskFlow'), false);
  assert.equal(controller.includes('paper-domain/submission'), false);
  assert.equal(controller.includes('paper-adapters/persistence'), false);
  assert.equal(controller.includes('privateKeyPem'), false);
  assert.equal(controller.includes('providerCredential'), false);
  assert.equal(controller.includes('api.runtime.tasks.flow'), false);
  assert.equal(adapter.includes('api?.runtime?.tasks?.flow'), true);
  assert.equal(adapter.includes('grantsSubmissionAuthority: false'), true);
  const batch = fs.readFileSync(path.join(workspaceRoot, 'paper-composition', 'batch', 'paper-batch-application.mjs'), 'utf8');
  assert.equal(batch.includes('workflowStateStore.put'), true);
  assert.equal(batch.includes('const workflowStateProjection = execute'), true);
});

test('automation plane stays independent from submission governance', () => {
  const automationFiles = [
    'paper-domain/automation/campaign-plan.mjs',
    'paper-domain/automation/referee-convergence.mjs',
    'paper-application/automation/campaign-engine.mjs',
    'paper-adapters/automation/campaign-node-executor.mjs',
    'paper-adapters/automation/codex-agent-executor.mjs',
    'paper-adapters/automation/multi-language-empirical-executor.mjs',
    'paper-adapters/automation/ollama-structured-agent-executor.mjs',
    'paper-adapters/automation/generated-latex-sanitizer.mjs',
  ];
  for (const relative of automationFiles) {
    const text = fs.readFileSync(path.join(workspaceRoot, relative), 'utf8');
    assert.doesNotMatch(text, /authority|owner.acceptance|submission.release|live.authorization/i, relative);
    assert.ok(text.split(/\n/).length <= 500, `${relative} exceeds bounded automation module size`);
  }
  const migration = fs.readFileSync(path.join(workspaceRoot, 'store/migrations/004_automation_campaigns.sql'), 'utf8');
  assert.match(migration, /paper_campaigns/);
  assert.match(migration, /campaign_nodes/);
  assert.match(migration, /campaign_events/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { JOURNAL_PROFILE_DATASET } from '../../paper-domain/journal/journal-registry.mjs';
import { createSqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';
import { createLeanFormalVerifier } from '../../paper-adapters/research-verify/formal-verifier.mjs';
import { buildResearchGapPlan } from '../../paper-domain/research/gap-planner.mjs';
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
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { APPLICATION_SERVICE_PORT_CATALOG } from '../../paper-ports/application-service-port-catalog.mjs';
import { ARCHITECTURE_ENTRYPOINT_MANIFEST } from '../src/architecture-entrypoint-manifest.mjs';
import { relativeModuleSpecifiers } from '../verification/javascript-module-specifiers.mjs';
import { inspectProductionComplexity } from '../verification/production-complexity.mjs';
import { inspectTrackedProductionGraph } from '../verification/tracked-production-graph.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function resolveArchitectureImport(importer, specifier) {
  const candidate = path.resolve(path.dirname(importer), specifier);
  return [candidate, `${candidate}.mjs`, path.join(candidate, 'index.mjs')]
    .find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
}

function architectureReachability(entries) {
  const pending = entries.map((entry) => path.join(workspaceRoot, entry));
  const reached = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of relativeModuleSpecifiers(source)) {
      const resolved = resolveArchitectureImport(file, specifier);
      if (resolved && !reached.has(resolved)) pending.push(resolved);
    }
  }
  return [...reached].map((file) => path.relative(workspaceRoot, file).replace(/\\/g, '/'));
}

test('retired direct workflow implementation cannot return to the active tree', () => {
  for (const relative of [
    'workflow-kernel/workflow.mjs',
    'paper-application/workflow/workflow-engine.mjs',
    'paper-application/workflow/typed-stage-pipeline.mjs',
    'paper-application/use-cases/paper-stage-handlers.mjs',
    'paper-application/use-cases/local-diagnostic-review-loop.mjs',
    'paper-application/use-cases/local-diagnostic-round-executor.mjs',
    'paper-core/src/workflow-engine.mjs',
  ]) assert.equal(fs.existsSync(path.join(workspaceRoot, relative)), false, relative);
});

test('artifact repository enforces declared scope and emits atomic receipts', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-artifact-port-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repository = createFilesystemArtifactRepository({
    scopeRoot: root,
    casRoot: path.join(root, 'cas'),
    clock: { now: () => new Date('2026-07-10T00:00:00.000Z'), nowIso: () => '2026-07-10T00:00:00.000Z' },
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

test('formal verifier consumes a bounded command-runner port', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hepta-formal-port-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
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
    inputRecords: [{ absolutePath: inputPath, path: 'Proof.lean', hash: hashBytes('theorem ok : True := by trivial\n') }],
  }).status, 'formal_verifier_passed');
  await fsp.writeFile(inputPath, 'theorem impossible : False := by sorry\n');
  assert.equal(verifier.verify({
    inputRecords: [{ absolutePath: inputPath, path: 'Proof.lean', hash: hashBytes('theorem impossible : False := by sorry\n') }],
  }).status, 'formal_verifier_blocked');
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
  assert.equal(JOURNAL_PROFILE_DATASET.version, 2);
  assert.equal(JOURNAL_PROFILE_DATASET.profiles.length, 98);
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
  assert.equal(batchApplication.includes('bootstrapBatchInventoryContext'), true);
  assert.equal(batchApplication.includes('bootstrapAutomationContext'), true);
  const domainSource = productionFiles.filter((file) => file.includes(`${path.sep}paper-domain${path.sep}`)).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.equal(domainSource.includes('paper-core/'), false);
  const adapterSource = productionFiles.filter((file) => file.includes(`${path.sep}paper-adapters${path.sep}`)).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.equal(adapterSource.includes('paper-application/'), false);
  assert.equal(/from ['"][^'"]*paper-core\/src\//.test(adapterSource), false);
  const applicationSource = productionFiles.filter((file) => file.includes(`${path.sep}paper-application${path.sep}`)).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.equal(/from ['"][^'"]*paper-core\/src\//.test(applicationSource), false);
  assert.doesNotMatch(applicationSource, /from ['"][^'"]*store-port\.mjs['"]/);
  assert.doesNotMatch(applicationSource, /\b(?:sqlEscape|sqlText|sqlJson)\b/);
  assert.doesNotMatch(applicationSource, /\b(?:SELECT|INSERT\s+INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM|PRAGMA)\b/i);
  assert.doesNotMatch(applicationSource, /\.query\s*\(/);
  assert.doesNotMatch(applicationSource, /services(?:\?\.|\.)paperStageAdapters\b/);
  const injectedApplicationServices = [...new Set(
    [...applicationSource.matchAll(/\bservices(?:\?\.|\.)([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]),
  )].sort();
  const undeclaredApplicationServices = injectedApplicationServices
    .filter((name) => !APPLICATION_SERVICE_PORT_CATALOG[name]);
  assert.deepEqual(undeclaredApplicationServices, []);
  assert.equal(APPLICATION_SERVICE_PORT_CATALOG.refereeIssueQuery, 'RefereeIssueQueryPort');
  assert.equal(APPLICATION_SERVICE_PORT_CATALOG.unitOfWork, 'UnitOfWorkPort');
  assert.equal(APPLICATION_SERVICE_PORT_CATALOG.experimentRegistryAuthorityVerifier, 'ExperimentRegistryAuthorityVerifierPort');
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
    if (file.endsWith(`${path.sep}scoped-file-materialization-target-lock.mjs`)) {
      const directWriteCalls = [...text.matchAll(/\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync)\(/g)]
        .map((match) => match[1]);
      assert.deepEqual(directWriteCalls, ['renameSync'], file);
      assert.match(
        text,
        /fs\.renameSync\(\s*descriptorEntryPath\(openedParent\.descriptor, pendingName\),\s*descriptorEntryPath\(openedParent\.descriptor, lock\.name\),?\s*\)/s,
        file,
      );
      continue;
    }
    assert.equal(/\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync)\(/.test(text), false, file);
  }
});

test('domain consumes values and never observes filesystem or wall clock directly', () => {
  const domainFiles = fs.readdirSync(path.join(workspaceRoot, 'paper-domain'), { recursive: true })
    .filter((entry) => typeof entry === 'string' && entry.endsWith('.mjs'))
    .map((entry) => path.join(workspaceRoot, 'paper-domain', entry));
  const violations = [];
  for (const file of domainFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(workspaceRoot, file);
    if (/from\s+['"]node:(?:fs|path)(?:\/[^'"]*)?['"]|import\s*\(\s*['"]node:(?:fs|path)/.test(source)) {
      violations.push(`${relative}:node-filesystem-import`);
    }
    if (/workflow-kernel\/runtime\/(?:file-utils|scoped-file[^'"]*)\.mjs/.test(source)
      || /\b(?:readFile|readFileSync|readdir|readdirSync|stat|statSync|existsSync)\s*\(/.test(source)) {
      violations.push(`${relative}:filesystem-observation`);
    }
    if (/\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)/.test(source)) {
      violations.push(`${relative}:implicit-wall-clock`);
    }
    if (/workflow-kernel\/runtime\/time-utils\.mjs/.test(source)) {
      violations.push(`${relative}:wall-clock-facade-import`);
    }
  }
  assert.deepEqual(violations, []);
});

test('every reachable production module stays within layer-aware complexity budgets', () => {
  const productionGraph = inspectTrackedProductionGraph({ workspaceRoot });
  const report = inspectProductionComplexity({ workspaceRoot, graphReport: productionGraph });
  assert.equal(report.moduleCount, productionGraph.moduleCount);
  assert.equal(report.inspectedModuleCount + report.excludedModuleCount, productionGraph.moduleCount);
  assert.equal(
    report.status,
    'production_complexity_ready',
    JSON.stringify({ blockers: report.blockers, violations: report.violations }, null, 2),
  );
});

test('legacy cleanup is retired from the production adapter and mode surfaces', () => {
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'paper-adapters', 'legacy-cleanup')), false);
  const modeRegistry = fs.readFileSync(path.join(workspaceRoot, 'paper-domain', 'workflow', 'mode-registry.mjs'), 'utf8');
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

test('zero-consumer infrastructure facades and recovery APIs stay retired', () => {
  const retiredFacades = Object.freeze({
    'paper-core/src/execution-context.mjs': 'paper-application/execution-context.mjs',
    'paper-core/src/mode-registry.mjs': 'paper-domain/workflow/mode-registry.mjs',
    'paper-core/src/cold-volume-contract.mjs': 'paper-adapters/archives/cold-volume-contract.mjs',
    'paper-core/src/cold-volume-cas-repository.mjs': 'paper-adapters/archives/cold-volume-cas-repository.mjs',
    'paper-core/src/offhost-worm-repository.mjs': 'paper-adapters/archives/offhost-worm-repository.mjs',
    'paper-core/src/external-intake-verifier.mjs': 'paper-adapters/governance/external-intake-verifier.mjs',
    'paper-core/src/sqlite-logical-integrity.mjs': 'paper-adapters/persistence/sqlite-logical-integrity.mjs',
    'paper-adapters/journal-manage/contracts.mjs': 'paper-domain/journal/contracts.mjs',
    'paper-adapters/journal-manage/selection.mjs': 'paper-domain/journal/selection.mjs',
    'paper-adapters/journal-manage/review-authority.mjs': 'paper-domain/journal/review-authority.mjs',
    'paper-adapters/journal-manage/journal-registry.mjs': 'paper-domain/journal/journal-registry.mjs',
  });
  for (const [relative, owner] of Object.entries(retiredFacades)) {
    assert.equal(fs.existsSync(path.join(workspaceRoot, relative)), false, relative);
    assert.equal(fs.existsSync(path.join(workspaceRoot, owner)), true, owner);
  }
  const productionBins = fs.readdirSync(path.join(workspaceRoot, 'paper-core', 'bin'))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => fs.readFileSync(path.join(workspaceRoot, 'paper-core', 'bin', name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(productionBins, /\.\.\/src\/(?:execution-context|mode-registry|cold-volume-(?:contract|cas-repository)|offhost-worm-repository|external-intake-verifier|sqlite-logical-integrity)\.mjs/);
  const recoveryRecord = fs.readFileSync(
    path.join(workspaceRoot, 'paper-adapters/runtime/scoped-file-materialization-recovery-record.mjs'),
    'utf8',
  );
  assert.doesNotMatch(
    recoveryRecord,
    /scopedMaterializationRecoveryIntentName|buildScopedMaterializationRecoveryIntentRecord|verifyScopedMaterializationRecoveryIntentRecord/,
  );
});

test('active governance contracts never depend on migration support', () => {
  const governanceFiles = [
    ...fs.readdirSync(path.join(workspaceRoot, 'paper-domain', 'governance'))
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => path.join(workspaceRoot, 'paper-domain', 'governance', name)),
    ...fs.readdirSync(path.join(workspaceRoot, 'paper-adapters', 'governance'))
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => path.join(workspaceRoot, 'paper-adapters', 'governance', name)),
  ];
  for (const file of governanceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*migration\//, path.relative(workspaceRoot, file));
  }
});

test('TaskFlow remains explicitly experimental and workflow state remains native', () => {
  const controller = fs.readFileSync(path.join(workspaceRoot, 'paper-application', 'experimental', 'taskflow', 'reviewed-submit-taskflow.mjs'), 'utf8');
  const adapter = fs.readFileSync(path.join(workspaceRoot, 'paper-adapters', 'experimental', 'taskflow', 'openclaw-taskflow-adapter.mjs'), 'utf8');
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
  assert.equal(batch.includes('persistLegacyWorkflowStateProjection'), false);
  assert.equal(batch.includes('runWorkflowStages'), false);
  assert.equal(batch.includes('createPaperStageHandlers'), false);
  assert.equal(batch.includes("../compat/"), false);
});

test('automation plane stays independent from submission governance', () => {
  const automationFiles = [
    'paper-domain/automation/autonomous-research-campaign-execution-admission.mjs',
    'paper-domain/automation/campaign-plan.mjs',
    'paper-domain/automation/campaign-mode-graph.mjs',
    'paper-domain/automation/campaign-benchmark-selector.mjs',
    'paper-domain/automation/referee-convergence.mjs',
    'paper-application/automation/campaign-engine.mjs',
    'paper-application/automation/campaign-node-executor.mjs',
    'paper-application/automation/campaign-node-execution-context.mjs',
    'paper-application/automation/campaign-node-kind-policy.mjs',
    'paper-application/automation/campaign-agent-execution-boundary.mjs',
    'paper-application/automation/campaign-agent-node-orchestrator.mjs',
    'paper-application/automation/campaign-formal-verification-node-orchestrator.mjs',
    'paper-application/automation/campaign-empirical-node-orchestrator.mjs',
    'paper-application/automation/campaign-quality-release-orchestrator.mjs',
    'paper-adapters/automation/campaign-node-primitives-adapter.mjs',
    'paper-adapters/automation/campaign-research-verifier.mjs',
    'paper-adapters/automation/codex-agent-executor.mjs',
    'paper-adapters/automation/multi-language-empirical-executor.mjs',
    'paper-adapters/automation/ollama-structured-agent-executor.mjs',
    'paper-adapters/automation/generated-latex-sanitizer.mjs',
  ];
  for (const relative of automationFiles) {
    const text = fs.readFileSync(path.join(workspaceRoot, relative), 'utf8');
    assert.doesNotMatch(text, /submission(?:[-_. ]?)(?:authority|release)|owner.acceptance|live.authorization/i, relative);
    assert.doesNotMatch(text, /paper-(?:domain|adapters)\/submission/, relative);
    assert.ok(text.split(/\n/).length <= 500, `${relative} exceeds bounded automation module size`);
  }
  const migration = fs.readFileSync(path.join(workspaceRoot, 'store/migrations/004_automation_campaigns.sql'), 'utf8');
  assert.match(migration, /paper_campaigns/);
  assert.match(migration, /campaign_nodes/);
  assert.match(migration, /campaign_events/);
});

test('research executables cannot reach submission portal network authority', () => {
  const research = architectureReachability([
    'paper-composition/automation/autonomous-research-campaign-composition.mjs',
    'paper-composition/automation/autonomous-research-supervisor-composition.mjs',
    'paper-composition/automation/autonomous-research-machine-intake-enqueue-composition.mjs',
    'paper-composition/automation/autonomous-research-readiness-composition.mjs',
  ]);
  const dispatcher = architectureReachability([
    'paper-core/bin/autonomous-submission-dispatcher.mjs',
  ]);
  const networkAdapter =
    'paper-adapters/automation/http-autonomous-submission-portal-adapter.mjs';
  const dispatcherServices =
    'paper-composition/automation/autonomous-submission-dispatcher-services-composition.mjs';
  const dispatcherCycleSigner =
    'paper-adapters/automation/autonomous-submission-dispatcher-cycle-signer.mjs';
  assert.equal(research.includes(networkAdapter), false);
  assert.equal(research.includes(dispatcherServices), false);
  assert.equal(research.includes(dispatcherCycleSigner), false);
  assert.equal(dispatcher.includes(networkAdapter), true);
  assert.equal(dispatcher.includes(dispatcherServices), true);
  assert.equal(dispatcher.includes(dispatcherCycleSigner), true);
});

test('campaign node orchestration policy stays in application and adapters remain narrow primitives', () => {
  const applicationPaths = [
    'paper-application/automation/campaign-node-executor.mjs',
    'paper-application/automation/campaign-node-execution-context.mjs',
    'paper-application/automation/campaign-agent-execution-boundary.mjs',
    'paper-application/automation/campaign-agent-node-orchestrator.mjs',
    'paper-application/automation/campaign-formal-verification-node-orchestrator.mjs',
    'paper-application/automation/campaign-empirical-node-orchestrator.mjs',
    'paper-application/automation/campaign-quality-release-orchestrator.mjs',
  ];
  const primitivePaths = [
    'paper-adapters/automation/campaign-agent-primitives-adapter.mjs',
    'paper-adapters/automation/campaign-empirical-primitives-adapter.mjs',
    'paper-adapters/automation/campaign-quality-primitives-adapter.mjs',
    'paper-adapters/automation/campaign-release-primitives-adapter.mjs',
    'paper-adapters/automation/campaign-workspace-primitives-adapter.mjs',
  ];
  const application = applicationPaths.map((relative) => fs.readFileSync(path.join(workspaceRoot, relative), 'utf8')).join('\n');
  const primitives = primitivePaths.map((relative) => fs.readFileSync(path.join(workspaceRoot, relative), 'utf8')).join('\n');
  const context = fs.readFileSync(path.join(workspaceRoot, 'paper-application/automation/campaign-node-execution-context.mjs'), 'utf8');
  const empirical = fs.readFileSync(path.join(workspaceRoot, 'paper-application/automation/campaign-empirical-node-orchestrator.mjs'), 'utf8');
  const qualityRelease = fs.readFileSync(path.join(workspaceRoot, 'paper-application/automation/campaign-quality-release-orchestrator.mjs'), 'utf8');
  const composition = fs.readFileSync(path.join(workspaceRoot, 'paper-composition/automation/campaign-node-execution-composition.mjs'), 'utf8');
  const nodeKindPolicy = fs.readFileSync(path.join(workspaceRoot, 'paper-application/automation/campaign-node-kind-policy.mjs'), 'utf8');
  const agentPolicy = fs.readFileSync(path.join(workspaceRoot, 'paper-application/automation/campaign-agent-policy.mjs'), 'utf8');
  const agentOrchestrator = fs.readFileSync(path.join(workspaceRoot, 'paper-application/automation/campaign-agent-node-orchestrator.mjs'), 'utf8');
  const formalEvidence = fs.readFileSync(path.join(workspaceRoot, 'paper-adapters/automation/campaign-formal-verification-evidence.mjs'), 'utf8');
  assert.doesNotMatch(application, /paper-adapters\//);
  assert.match(context, /allNodes/);
  assert.match(empirical, /executeWithRepair/);
  assert.match(qualityRelease, /requiredRevalidationForChanges|evaluateManuscriptPromotion/);
  assert.doesNotMatch(primitives, /\ballNodes\b|requiredRevalidationForChanges|evaluateManuscriptPromotion|executeWithRepair|retryable\s*=\s*true/);
  assert.match(composition, /createCampaignNodePrimitivesAdapter/);
  assert.doesNotMatch(composition, /campaign-node-executor\.mjs.*paper-adapters/);
  assert.match(nodeKindPolicy, /function isCampaignRefereeNode|function campaignNodeOperation/);
  assert.doesNotMatch(`${context}\n${agentPolicy}`, /function isCampaignRefereeNode|function isCampaignAgentNode/);
  assert.match(`${agentOrchestrator}\n${formalEvidence}`, /agent-execution-receipt-contract\.mjs/);
  assert.doesNotMatch(`${agentOrchestrator}\n${formalEvidence}`, /function agentReceiptPayload/);
});

test('architecture production inventory follows declared executable reachability', () => {
  const automation = architectureReachability([
    'paper-composition/bootstrap/automation-context-bootstrap.mjs',
    'paper-core/bin/paper-campaign.mjs',
  ]);
  const compatibilityCapability = architectureReachability(ARCHITECTURE_ENTRYPOINT_MANIFEST.compatibility);
  const operatorCli = architectureReachability(['paper-core/bin/paper-production-core.mjs']);
  const batchProduction = architectureReachability(['paper-composition/batch/paper-batch-application.mjs']);
  const operatorCliSource = fs.readFileSync(path.join(workspaceRoot, 'paper-core/bin/paper-production-core.mjs'), 'utf8');
  const scopedBootstrapSource = fs.readFileSync(path.join(
    workspaceRoot,
    'paper-composition/bootstrap/capability-scoped-bootstrap.mjs',
  ), 'utf8');
  assert.ok(automation.length > 20);
  assert.ok(compatibilityCapability.length > 100);
  assert.deepEqual(automation.filter((relative) => relative.startsWith('paper-adapters/submission/')), []);
  assert.equal(compatibilityCapability.includes('paper-composition/compat/legacy-stage-port-composition.mjs'), true);
  assert.equal(compatibilityCapability.includes('paper-composition/compat/legacy-stage-adapter-registry.mjs'), true);
  assert.doesNotMatch(scopedBootstrapSource, /legacy-stage-(?:adapter-registry|port-composition)/);
  assert.equal(compatibilityCapability.includes('paper-adapters/experimental/taskflow/openclaw-taskflow-adapter.mjs'), false);
  assert.equal(operatorCli.includes('paper-composition/compat/legacy-context-bootstrap.mjs'), false);
  assert.equal(operatorCli.includes('paper-composition/compat/legacy-stage-adapter-registry.mjs'), false);
  assert.doesNotMatch(operatorCliSource, /paper-composition.*compat|compatibilityModule|await\s+import\s*\(/);
  assert.equal(operatorCli.includes('paper-composition/bootstrap/batch-inventory-context-bootstrap.mjs'), true);
  assert.equal(batchProduction.includes('paper-application/automation/batch-campaign-command.mjs'), true);
  assert.equal(batchProduction.includes('paper-composition/bootstrap/automation-context-bootstrap.mjs'), true);
  assert.equal(batchProduction.includes('paper-adapters/runtime/core-integrity.mjs'), false);
  assert.equal(batchProduction.includes('paper-application/reporting/batch-result-summary.mjs'), false);
  assert.equal(batchProduction.includes('paper-application/reporting/workflow-result-summary.mjs'), false);
  assert.equal(batchProduction.includes('paper-composition/compat/legacy-workflow-state-projection.mjs'), false);
  assert.equal(batchProduction.includes('paper-composition/compat/legacy-stage-port-composition.mjs'), false);
});

test('vendored reference and migration-support paths cannot enter the active production graph', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
  const reference = packageJson.heptaPaper?.referencePackages?.find((item) => item.path === 'core');
  assert.equal(reference?.classification, 'vendored_reference');
  assert.equal(reference?.productionImportPolicy, 'forbidden');
  assert.equal(reference?.baseline, 'core/CORE_BASELINE.json');

  const production = architectureReachability(ARCHITECTURE_ENTRYPOINT_MANIFEST.production);
  const compatibility = architectureReachability(ARCHITECTURE_ENTRYPOINT_MANIFEST.compatibility);
  assert.deepEqual(production.filter((relative) => relative === 'core/src' || relative.startsWith('core/src/')), []);
  assert.equal(production.includes('paper-adapters/runtime/core-integrity.mjs'), false);
  const productionSource = production
    .filter((relative) => relative.endsWith('.mjs'))
    .map((relative) => fs.readFileSync(path.join(workspaceRoot, relative), 'utf8'))
    .join('\n');
  assert.doesNotMatch(productionSource, /(?:from\s+|import\s*\()['"][^'"]*(?:core\/src|design-production-core)/);

  const classificationPath = path.join(workspaceRoot, packageJson.heptaPaper.compatibilityManifest);
  const classification = JSON.parse(fs.readFileSync(classificationPath, 'utf8'));
  assert.equal(classification.kind, 'HeptaCompatibilitySupportClassification');
  const rows = [
    ...classification.hashBoundCompatibility,
    ...classification.deprecatedCompatibility,
    ...classification.migrationSupport,
    ...classification.historicalTranslationSupport,
  ];
  assert.equal(new Set(rows.map((row) => row.path)).size, rows.length);
  for (const row of rows) assert.equal(fs.existsSync(path.join(workspaceRoot, row.path)), true, row.path);
  for (const row of rows.filter((item) => item.productionReachability === 'forbidden')) {
    assert.equal(production.includes(row.path), false, row.path);
  }
  const bridge = classification.hashBoundCompatibility.find((row) => row.path.endsWith('/decision-routing.mjs'));
  assert.equal(bridge?.productionReachability, 'intentional_referee_revise_bridge');
  assert.equal(production.includes(bridge.path), false);
  assert.equal(compatibility.includes(bridge.path), true);
  const salvage = JSON.parse(fs.readFileSync(path.join(workspaceRoot, bridge.bindingManifest), 'utf8'));
  for (const row of classification.hashBoundCompatibility) {
    assert.ok(salvage.files.some((item) => item.targets?.some((target) => target.path === row.path && /^sha256:[a-f0-9]{64}$/.test(target.hash))), row.path);
  }
  for (const row of classification.retiredCode) {
    assert.equal(fs.existsSync(path.join(workspaceRoot, row.path)), false, row.path);
    assert.equal(fs.existsSync(path.join(workspaceRoot, row.replacement)), true, row.replacement);
  }
});

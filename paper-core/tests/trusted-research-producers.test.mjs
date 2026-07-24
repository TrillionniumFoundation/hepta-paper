import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { verifyArtifactWriteReceiptSource } from '../../paper-adapters/artifacts/artifact-write-receipt-verifier.mjs';
import { produceTrustedExperimentEvidence } from '../../paper-adapters/empirical-analysis/trusted-experiment-producer.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { produceTrustedFormalEvidence } from '../../paper-adapters/research-verify/trusted-formal-producer.mjs';
import { composeTrustedReceiptLedgers } from '../../paper-composition/bootstrap/receipt-ledger-composition.mjs';
import {
  buildGenericFormalCertificateIntake,
  verifyGenericFormalCertificateIntakeClosureBinding,
  verifyNativeFormalResearchClosureBinding,
} from '../../paper-domain/research/formal-certificate-intake.mjs';
import { buildEvidenceQualityGate } from '../../paper-domain/research/evidence-quality-gate.mjs';
import { buildFormalVerifierRegistry } from '../../paper-domain/research/formal-verifier-registry.mjs';
import { buildExperimentRegistry } from '../../paper-domain/research/experiment-registry.mjs';
import { createProofObligationContracts } from '../../paper-domain/research/theorem-specification.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { sealReceiptHash } from '../../paper-domain/evidence/receipt-hash-policy.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-trusted-producer-'));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'store.sqlite') });
  const fixedNow = '2026-07-13T11:00:00.000Z';
  const clock = { now: () => new Date(fixedNow), nowIso: () => fixedNow };
  const ledgers = composeTrustedReceiptLedgers({ store, clock });
  const reader = createSqliteReceiptLedger({ store, clock });
  const artifactRepositoryFactory = (scopeRoot) => createFilesystemArtifactRepository({ scopeRoot, casRoot: path.join(root, 'cas'), receiptLedger: ledgers.artifact, clock });
  return { root, store, clock, ledgers, reader, artifactRepositoryFactory };
}

function nativeFormalFixture({
  f,
  paperId,
  campaignId,
  taskKey,
  statement,
  replayLabel = 'current',
} = {}) {
  const theoremClaimId = 'claim-1';
  const scientificClaimKey = 'truth-claim';
  const proofObligations = ['Construct a kernel-checked proof of truth.'];
  const proofObligationContracts = createProofObligationContracts({
    claimKey: scientificClaimKey,
    proofObligations,
  });
  const theoremSpecificationHash = hashRecord('TheoremSpecificationFixture', {
    paperId,
    statement,
  });
  const theoremSpecificationClaimHash = hashRecord(
    'TheoremSpecificationClaimFixture',
    { theoremClaimId, statement },
  );
  const proposalBinding = Object.freeze({
    campaignId,
    theoremSpecificationHash,
    entries: Object.freeze([Object.freeze({
      theoremClaimId,
      theoremStatement: statement,
      scientificClaimKey,
      proofObligations: Object.freeze(proofObligations),
      theoremSpecificationClaimHash,
    })]),
  });
  const expectedClaimBindings = Object.freeze(
    proofObligationContracts.map((contract) => Object.freeze({
      claimId: theoremClaimId,
      obligationId: contract.obligationId,
      statementHash: hashBytes(Buffer.from(statement, 'utf8')),
    })),
  );
  const replayPayload = {
    version: 1,
    kind: 'FormalCertificateReplayReceipt',
    status: 'formal_claim_replay_verified',
    blockers: Object.freeze([]),
    originalCertificateBundleHash:
      hashRecord('FormalBundleFixture', { replayLabel, phase: 'original' }),
    rerunCertificateBundleHash:
      hashRecord('FormalBundleFixture', { replayLabel, phase: 'rerun' }),
    projectManifestHash:
      hashRecord('FormalProjectManifestFixture', { replayLabel }),
    systemAuditHash: hashRecord('FormalSystemAuditFixture', { replayLabel }),
    toolchainHash: hashRecord('FormalToolchainFixture', { replayLabel }),
    formalProjectClosureHash:
      hashRecord('FormalProjectClosureFixture', { replayLabel }),
    leanReadableProofPrintAuditSetHash:
      hashRecord('FormalReadableProofFixture', { replayLabel }),
    externalActionPerformed: false,
  };
  const replayReceipt = Object.freeze({
    ...replayPayload,
    formalCertificateReplayReceiptHash: hashRecord(
      'FormalCertificateReplayReceipt',
      replayPayload,
    ),
  });
  const claimBindingReportPayload = {
    version: 1,
    kind: 'FormalClaimBindingReport',
    status: 'formal_claim_binding_verified',
    bindings: Object.freeze([Object.freeze({
      claimId: theoremClaimId,
      valid: true,
      expectedObligations: Object.freeze([...proofObligations].sort()),
      proofObligationContracts,
      verifiedObligations: Object.freeze(
        proofObligationContracts.map((item) => item.obligationId).sort(),
      ),
    })]),
    blockers: Object.freeze([]),
  };
  const claimBindingReport = Object.freeze({
    ...claimBindingReportPayload,
    formalClaimBindingHash: hashRecord(
      'FormalClaimBindingReport',
      claimBindingReportPayload,
    ),
  });
  const result = Object.freeze({
    status: 'formal_claim_verified',
    formalCertificateReplayReceiptHash:
      replayReceipt.formalCertificateReplayReceiptHash,
    replayReceipt,
    claimBindingReport,
  });
  const planHash = hashRecord('NativeFormalPlanFixture', { paperId });
  const engineHash = hashRecord('NativeFormalEngineFixture', { paperId });
  const sourceMerkleHash = hashRecord('NativeFormalSourceMerkleFixture', {
    paperId,
  });
  const receiptPayload = {
    version: 1,
    kind: 'NativeResearchWorkerExecutionReceipt',
    paperId,
    taskKey,
    workerId: `formal-verifier-${replayLabel}`,
    workerType: 'formal_verifier_lake',
    jobId: `${paperId}:formal-job:${replayLabel}`,
    attemptId: `${paperId}:formal-attempt:${replayLabel}`,
    leaseGeneration: 1,
    status: 'native_research_worker_execution_verified',
    planHash,
    engineHash,
    theoremSpecificationHash,
    workerDefinitionHash:
      hashRecord('NativeFormalWorkerDefinitionFixture', { replayLabel }),
    sourceSnapshotHash:
      hashRecord('NativeFormalSourceSnapshotFixture', { paperId, replayLabel }),
    sourceMerkleHashBefore: sourceMerkleHash,
    sourceMerkleHashAfter: sourceMerkleHash,
    sourceMutationDetected: false,
    claimIds: Object.freeze([theoremClaimId]),
    result,
    resultHash: hashPaperRecord('NativeResearchWorkerResult', result),
    academicEvidenceEligible: true,
    blockers: Object.freeze([]),
  };
  const sealedReceipt = sealReceiptHash(receiptPayload, {
    hashField: 'nativeResearchWorkerExecutionReceiptHash',
  });
  const ledgerReceipt = f.ledgers.nativeResearchWorker.record(sealedReceipt, {
    stream: 'jobs',
    paperId,
    strictInsert: true,
  });
  const receipt = Object.freeze({
    ...sealedReceipt,
    ledgerReceiptId: ledgerReceipt.receiptId,
  });
  const reportPayload = {
    version: 1,
    kind: 'NativeResearchWorkerExecutionReport',
    paperId,
    taskKey,
    status: 'native_research_workers_verified',
    executeRequested: true,
    planHash,
    engineHash,
    theoremSpecificationHash,
    theoremSpecificationClaimHashes:
      Object.freeze([theoremSpecificationClaimHash]),
    workerTypeFilter: Object.freeze(['formal_verifier_lake']),
    plannedResearchWorkerCount: 1,
    executedResearchWorkerCount: 1,
    verifiedAcademicEvidenceWorkerCount: 1,
    workerReceipts: Object.freeze([receipt]),
    workerReceiptHashes: Object.freeze([
      receipt.nativeResearchWorkerExecutionReceiptHash,
    ]),
    blockers: Object.freeze([]),
  };
  const nativeResearchWorkerExecution = Object.freeze({
    ...reportPayload,
    nativeResearchWorkerExecutionReportHash: hashPaperRecord(
      'NativeResearchWorkerExecutionReport',
      reportPayload,
    ),
  });
  return Object.freeze({
    proposalBinding,
    expectedClaimBindings,
    nativeResearchWorkerExecution,
    receipt,
  });
}

function resealNativeFormalExecution(value, mutate) {
  const report = structuredClone(value);
  mutate(report);
  const receipt = report.workerReceipts[0];
  const claimBindingReport = receipt.result.claimBindingReport;
  const { formalClaimBindingHash: _oldBindingHash, ...bindingPayload } =
    claimBindingReport;
  claimBindingReport.formalClaimBindingHash = hashRecord(
    'FormalClaimBindingReport',
    bindingPayload,
  );
  const replay = receipt.result.replayReceipt;
  const { formalCertificateReplayReceiptHash: _oldReplayHash, ...replayPayload } =
    replay;
  replay.formalCertificateReplayReceiptHash = hashRecord(
    'FormalCertificateReplayReceipt',
    replayPayload,
  );
  receipt.result.formalCertificateReplayReceiptHash =
    replay.formalCertificateReplayReceiptHash;
  receipt.resultHash = hashPaperRecord(
    'NativeResearchWorkerResult',
    receipt.result,
  );
  const {
    nativeResearchWorkerExecutionReceiptHash: _oldReceiptHash,
    ledgerReceiptId,
    ...receiptPayload
  } = receipt;
  const resealedReceipt = sealReceiptHash(receiptPayload, {
    hashField: 'nativeResearchWorkerExecutionReceiptHash',
  });
  report.workerReceipts[0] = { ...resealedReceipt, ledgerReceiptId };
  report.workerReceiptHashes = [
    resealedReceipt.nativeResearchWorkerExecutionReceiptHash,
  ];
  const {
    nativeResearchWorkerExecutionReportHash: _oldReportHash,
    ...reportPayload
  } = report;
  return {
    ...reportPayload,
    nativeResearchWorkerExecutionReportHash: hashPaperRecord(
      'NativeResearchWorkerExecutionReport',
      reportPayload,
    ),
  };
}

test('artifact repositories require the complete injected ClockPort', () => {
  assert.throws(() => createFilesystemArtifactRepository({
    scopeRoot: '.',
    receiptLedger: { record() {} },
    clock: { nowIso: () => '2026-07-13T11:00:00.000Z' },
  }), /requires an injected ClockPort/);
});

test('kernel-isolated experiment producer persists trusted CAS and ledger lineage', async () => {
  const f = fixture();
  try {
    const runDir = path.join(f.root, 'run');
    for (const relative of ['results/empirical_summary.json', 'results/empirical_results.csv', 'results/EMPIRICAL_EVIDENCE_MANIFEST.json', 'results/REPRODUCIBILITY_STATUS.md', 'tables/table_empirical_summary.tex', 'figures/figure_spec.json']) {
      fs.mkdirSync(path.dirname(path.join(runDir, relative)), { recursive: true });
      fs.writeFileSync(path.join(runDir, relative), relative.endsWith('.json') ? '{}\n' : 'verified\n');
    }
    const merkle = hashRecord('SourceMerkle', { stable: true });
    const sandboxReceipt = { ok: true, receiptHash: hashRecord('OsSandboxWorkerReceipt', { run: 1 }), sourceMerkleHashBefore: merkle, sourceMerkleHashAfter: merkle, datasetMounts: [], isolation: { kernelNetworkIsolationVerified: true, sourceReadOnlyVerified: true, ephemeralWorkRootVerified: true, separateOutputRootVerified: true } };
    const evidence = await produceTrustedExperimentEvidence({ paperTask: { paperId: 'paper-1' }, runDir, codeHash: hashRecord('Code', 'code'), datasetContract: { datasetMode: 'local_synthetic_generated' }, sandboxReceipt, artifactRepository: f.artifactRepositoryFactory(runDir), receiptWriters: f.ledgers.research, seed: 17, clock: f.clock });
    assert.equal(evidence.status, 'trusted_experiment_evidence_recorded');
    const registry = buildExperimentRegistry({ paperTask: { paperId: 'paper-1' }, artifacts: evidence.experiments, receiptLedger: f.reader, artifactVerifier: verifyArtifactWriteReceiptSource });
    assert.equal(registry.status, 'experiment_registry_ready', JSON.stringify(registry.experiments[0]?.evidenceBinding?.blockers));
  } finally {
    f.store.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('formal producer binds full v3 evidence and current native closure', async (t) => {
  const f = fixture();
  const outsideSource = path.join(path.dirname(f.root), `${path.basename(f.root)}-outside.lean`);
  try {
    const paperId = 'paper-1';
    const campaignId = 'campaign-1';
    const taskKey = `paper_factory:${paperId}`;
    const researchSourceSnapshotHash = hashRecord(
      'CampaignResearchSourceSnapshot',
      { paperId, campaignId },
    );
    const statement = 'Truth is inhabited.';
    const native = nativeFormalFixture({
      f,
      paperId,
      campaignId,
      taskKey,
      statement,
    });
    const source = path.join(f.root, 'proof.lean');
    fs.writeFileSync(source, 'theorem truth : True := by trivial\n');
    fs.writeFileSync(outsideSource, 'theorem escaped : True := by trivial\n');
    const merkle = hashRecord('SourceMerkle', { stable: true });
    const runner = { run: () => ({ ok: true, receiptHash: hashRecord('OsSandboxWorkerReceipt', { formal: 1 }), runnerId: 'test-kernel-runner', backend: 'test', sourceMerkleHashBefore: merkle, sourceMerkleHashAfter: merkle, exitCode: 0, stdout: '', stderr: '', isolation: { kernelNetworkIsolationVerified: true, sourceReadOnlyVerified: true, ephemeralWorkRootVerified: true, separateOutputRootVerified: true } }) };
    const { expectedClaimBindings } = native;
    const produced = await produceTrustedFormalEvidence({ root: f.root, runtimeRoot: path.join(f.root, 'runtime'), paperTask: { paperId }, campaignId, researchSourceSnapshotHash, request: { verifierKind: 'lean', sourceRecords: [{ path: 'proof.lean' }], claimBindings: expectedClaimBindings }, artifactRepositoryFactory: f.artifactRepositoryFactory, receiptWriters: f.ledgers.research, clock: f.clock, executableOverride: '/bin/true', runnerOverride: runner });
    assert.equal(produced.status, 'trusted_formal_evidence_recorded');
    const registry = buildFormalVerifierRegistry({ adapterReceipts: [produced.adapterReceipt], receiptLedger: f.reader });
    const request = produced.certificateRequest;
    const intake = buildGenericFormalCertificateIntake({ paperId: request.paperId, campaignId: request.campaignId, researchSourceSnapshotHash: request.researchSourceSnapshotHash, verifierKind: request.verifierKind, certificate: request.certificate, sourceRecords: request.sourceRecords, claimBindings: request.claimBindings, executionReceipt: request.executionReceipt, verifierRegistry: registry, receiptLedger: f.reader, artifactVerifier: verifyArtifactWriteReceiptSource }, { expectedPaperId: paperId, expectedCampaignId: campaignId, expectedResearchSourceSnapshotHash: researchSourceSnapshotHash, expectedClaimBindings, expectedTaskKey: taskKey, expectedProposalBinding: native.proposalBinding, nativeResearchWorkerExecution: native.nativeResearchWorkerExecution });
    assert.equal(intake.status, 'formal_certificate_intake_verified', JSON.stringify(intake.blockers));
    assert.equal(intake.version, 3);
    assert.equal(intake.executionReceipt.receiptHash, request.executionReceipt.receiptHash);
    assert.equal(intake.certificate.artifactWriteReceipt.writeReceiptHash,
      request.certificate.artifactWriteReceipt.writeReceiptHash);
    assert.equal(intake.sourceRecords[0].artifactWriteReceipt.writeReceiptHash,
      request.sourceRecords[0].artifactWriteReceipt.writeReceiptHash);
    assert.equal(intake.trustedNativeFormalReceiptVerified, true);
    const closureContext = {
      paperId,
      campaignId,
      researchSourceSnapshotHash,
      taskKey,
      expectedClaimBindings,
      proposalBinding: native.proposalBinding,
      nativeResearchWorkerExecution: native.nativeResearchWorkerExecution,
    };
    assert.equal(verifyGenericFormalCertificateIntakeClosureBinding(
      intake,
      closureContext,
    ).valid, true);
    const gateInput = {
      paperTask: { paperId, taskKey },
      claimRegistry: {
        status: 'claim_graph_valid',
        claims: [{
          claimId: 'claim-1',
          text: statement,
          sourceLocator: 'main.tex#truth',
          claimKind: 'research_claim',
          verificationPlan: { kind: 'formal', requiresEvidence: false },
        }],
      },
      evidenceIntake: { status: 'evidence_intake_ready', items: [] },
      nativeWorkerReceipts: [native.receipt],
      nativeResearchWorkerExecution: native.nativeResearchWorkerExecution,
      receiptLedger: f.reader,
      formalCertificateIntakes: [intake],
      campaignId,
      researchSourceSnapshotHash,
      expectedFormalClaimBindings: expectedClaimBindings,
      proposalClaimToTheoremBinding: native.proposalBinding,
    };
    const qualityGate = buildEvidenceQualityGate(gateInput);
    assert.equal(qualityGate.status, 'evidence_quality_ready',
      JSON.stringify(qualityGate.blockers));
    assert.deepEqual(qualityGate.verifiedFormalCertificateIntakeHashes,
      [intake.genericFormalCertificateIntakeHash]);

    const sealIntake = (value) => {
      const changed = structuredClone(value);
      delete changed.genericFormalCertificateIntakeHash;
      return {
        ...changed,
        genericFormalCertificateIntakeHash: hashRecord(
          'GenericFormalCertificateIntake',
          changed,
        ),
      };
    };
    const lineageAttacks = [
      ['same-paper old campaign', (value) => {
        value.campaignId = 'campaign-old';
      }, 'formal_certificate_intake_campaign_mismatch'],
      ['wrong source snapshot', (value) => {
        value.researchSourceSnapshotHash = hashRecord('WrongSourceSnapshot', {});
      }, 'formal_certificate_intake_research_source_snapshot_mismatch'],
      ['wrong statement', (value) => {
        value.claimBindings[0].statementHash = hashRecord('WrongStatement', {});
      }, 'formal_certificate_intake_claim_binding_mismatch'],
      ['wrong obligation', (value) => {
        value.claimBindings[0].obligationId = `obligation:${'b'.repeat(64)}`;
      }, 'formal_certificate_intake_claim_binding_mismatch'],
    ];
    for (const [label, mutate, expectedBlocker] of lineageAttacks) {
      await t.test(label, () => {
        const changed = structuredClone(intake);
        mutate(changed);
        const attacked = sealIntake(changed);
        const verification = verifyGenericFormalCertificateIntakeClosureBinding(
          attacked,
          closureContext,
        );
        assert.equal(verification.valid, false);
        assert.ok(verification.blockers.includes(expectedBlocker));
        const blockedGate = buildEvidenceQualityGate({
          ...gateInput,
          formalCertificateIntakes: [attacked],
        });
        assert.equal(blockedGate.status, 'evidence_quality_blocked');
        assert.deepEqual(blockedGate.verifiedFormalCertificateIntakeHashes, []);
      });
    }

    await t.test('synthetic thin v1/v2/v3 records receive no formal credit', () => {
      for (const version of [1, 2, 3]) {
        const thin = sealIntake({
          version,
          kind: 'GenericFormalCertificateIntake',
          status: 'formal_certificate_intake_verified',
          paperId,
          campaignId,
          researchSourceSnapshotHash,
          claimBindings: expectedClaimBindings,
          trustedLedgerReceiptsVerified: true,
          trustedNativeFormalReceiptVerified: true,
          artifactSourcesVerified: true,
          blockers: [],
          externalActionPerformed: false,
        });
        assert.equal(verifyGenericFormalCertificateIntakeClosureBinding(
          thin,
          closureContext,
        ).valid, false);
      }
    });

    await t.test('embedded formal receipt tamper is rejected after outer reseal', () => {
      const changed = structuredClone(intake);
      changed.certificate.artifactWriteReceipt.bytes += 1;
      const verification = verifyGenericFormalCertificateIntakeClosureBinding(
        sealIntake(changed),
        closureContext,
      );
      assert.equal(verification.valid, false);
      assert.ok(verification.blockers
        .includes('formal_certificate_intake_embedded_certificate_invalid'));
    });

    await t.test('valid-ledger alternate native replay cannot satisfy the anchor', () => {
      const alternate = nativeFormalFixture({
        f,
        paperId,
        campaignId,
        taskKey,
        statement,
        replayLabel: 'alternate',
      });
      const verification = verifyGenericFormalCertificateIntakeClosureBinding(
        intake,
        {
          ...closureContext,
          nativeResearchWorkerExecution:
            alternate.nativeResearchWorkerExecution,
        },
      );
      assert.equal(verification.valid, false);
      assert.ok(verification.blockers
        .includes('formal_certificate_intake_native_formal_anchor_invalid'));
      const blockedGate = buildEvidenceQualityGate({
        ...gateInput,
        nativeWorkerReceipts: [alternate.receipt],
        nativeResearchWorkerExecution:
          alternate.nativeResearchWorkerExecution,
      });
      assert.equal(blockedGate.status, 'evidence_quality_blocked');
    });

    await t.test('shared verifier preserves prior native execution semantics', () => {
      const mutations = [
        (value) => { value.status = 'native_research_workers_blocked'; },
        (value) => { value.paperId = 'paper-other'; },
        (value) => { value.taskKey = 'paper_factory:other'; },
        (value) => { value.workerTypeFilter = []; },
        (value) => { value.theoremSpecificationHash = hashRecord('WrongSpec', {}); },
        (value) => { value.theoremSpecificationClaimHashes = []; },
        (value) => { value.plannedResearchWorkerCount = 2; },
        (value) => { value.workerReceipts[0].status = 'blocked'; },
        (value) => { value.workerReceipts[0].academicEvidenceEligible = false; },
        (value) => { value.workerReceipts[0].sourceMutationDetected = true; },
        (value) => { value.workerReceipts[0].sourceMerkleHashAfter = hashRecord('ChangedMerkle', {}); },
        (value) => { value.workerReceipts[0].claimIds = ['claim-other']; },
        (value) => { value.workerReceipts[0].planHash = hashRecord('WrongPlan', {}); },
        (value) => { value.workerReceipts[0].engineHash = hashRecord('WrongEngine', {}); },
        (value) => { value.workerReceipts[0].result.status = 'formal_claim_blocked'; },
        (value) => { value.workerReceipts[0].result.replayReceipt.status = 'formal_claim_replay_blocked'; },
        (value) => { value.workerReceipts[0].result.replayReceipt.blockers = ['tampered']; },
        (value) => { value.workerReceipts[0].result.claimBindingReport.status = 'blocked'; },
        (value) => { value.workerReceipts[0].result.claimBindingReport.bindings[0].valid = false; },
        (value) => { value.workerReceipts[0].result.claimBindingReport.bindings[0].expectedObligations = []; },
        (value) => { value.workerReceipts[0].result.claimBindingReport.bindings[0].verifiedObligations = []; },
        (value) => { value.workerReceipts[0].blockers = ['tampered']; },
      ];
      for (const mutate of mutations) {
        const changed = resealNativeFormalExecution(
          native.nativeResearchWorkerExecution,
          mutate,
        );
        assert.equal(verifyNativeFormalResearchClosureBinding(changed, {
          ...closureContext,
          nativeResearchWorkerExecution: undefined,
        }).valid, false);
      }
    });
    const escaped = await produceTrustedFormalEvidence({ root: f.root, runtimeRoot: path.join(f.root, 'runtime'), paperTask: { paperId }, campaignId, researchSourceSnapshotHash, request: { verifierKind: 'lean', sourceRecords: [{ absolutePath: outsideSource }], claimBindings: expectedClaimBindings }, artifactRepositoryFactory: f.artifactRepositoryFactory, receiptWriters: f.ledgers.research, clock: f.clock, executableOverride: '/bin/true', runnerOverride: runner });
    assert.equal(escaped.status, 'trusted_formal_evidence_blocked');
    assert.ok(escaped.blockers.includes('scoped_path_lexical_escape'));
  } finally {
    f.store.close();
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(outsideSource, { force: true });
  }
});

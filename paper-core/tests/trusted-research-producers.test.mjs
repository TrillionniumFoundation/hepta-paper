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
import {
  inspectTrustedFormalNativeProjectionInputs,
  produceTrustedFormalEvidence,
} from '../../paper-adapters/research-verify/trusted-formal-producer.mjs';
import {
  blockedTrustedFormalEvidence,
  issueTrustedFormalCampaignExecutionAuthority,
  trustedFormalAuthorityBlockers,
  uniqueTrustedFormalBlockers,
} from '../../paper-adapters/research-verify/trusted-formal-producer-contract.mjs';
import { composeTrustedReceiptLedgers } from '../../paper-composition/bootstrap/receipt-ledger-composition.mjs';
import {
  buildNativeFormalCertificateIntake,
  verifyGenericFormalCertificateIntakeClosureBinding,
  verifyNativeFormalResearchClosureBinding,
} from '../../paper-domain/research/formal-certificate-intake.mjs';
import {
  buildCampaignResearchSourceSnapshot,
} from '../../paper-domain/automation/campaign-research-contract.mjs';
import { buildEvidenceQualityGate } from '../../paper-domain/research/evidence-quality-gate.mjs';
import { buildExperimentRegistry } from '../../paper-domain/research/experiment-registry.mjs';
import {
  PRODUCTION_LEAN_TOOLCHAIN,
  PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import { createProofObligationContracts } from '../../paper-domain/research/theorem-specification.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { sealReceiptHash } from '../../paper-domain/evidence/receipt-hash-policy.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  workspaceExecutionManifestHash,
  workspaceExecutionMerkleHash,
} from '../../workflow-kernel/runtime/workspace-execution-identity.mjs';

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
  const sourcePath = 'proof.lean';
  const sourceText = 'theorem truth : True := by trivial\n';
  const sourceHash = hashBytes(Buffer.from(sourceText, 'utf8'));
  const sourceBytes = Buffer.byteLength(sourceText);
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
    certificateBundleHash: replayReceipt.originalCertificateBundleHash,
    formalCertificateReplayReceiptHash:
      replayReceipt.formalCertificateReplayReceiptHash,
    projectManifestHash: replayReceipt.projectManifestHash,
    formalProjectClosureHash: replayReceipt.formalProjectClosureHash,
    toolchainHash: replayReceipt.toolchainHash,
    systemAuditHash: replayReceipt.systemAuditHash,
    leanReadableProofPrintAuditSetHash:
      replayReceipt.leanReadableProofPrintAuditSetHash,
    projectFiles: Object.freeze([Object.freeze({
      projectPath: sourcePath,
      hash: sourceHash,
      bytes: sourceBytes,
    })]),
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
    inputs: Object.freeze([Object.freeze({
      path: sourcePath,
      verified: true,
      hash: sourceHash,
      expectedHash: sourceHash,
    })]),
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
    sourcePath,
    sourceText,
    sourceHash,
    sourceBytes,
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

test('trusted formal execution authority is issuer-bound and exhaustively context-bound', () => {
  const digest = (label) => hashRecord('TrustedFormalAuthorityFixture', label);
  const context = {
    paperTask: { paperId: 'paper-authority' },
    campaignEvidenceContext: {
      campaignId: 'campaign-authority',
      researchNodeId: 'research-node-authority',
      researchAttemptId: 'research-attempt-authority',
      researchLeaseGeneration: 2,
    },
    campaignResearchSourceSnapshot: {
      campaignResearchSourceSnapshotHash: digest('source-snapshot'),
    },
    authoritativeFormalReceipt: {
      formalNodeId: 'formal-node-authority',
      formalAttemptId: 'formal-attempt-authority',
      formalLeaseGeneration: 3,
      campaignFormalVerificationReceiptHash: digest('formal-receipt'),
    },
    authoritativeFormalNode: {
      resultSha256: digest('formal-node-result'),
    },
    nativeResearchWorkerExecution: {
      nativeResearchWorkerExecutionReportHash: digest('native-execution'),
    },
  };
  const authority = issueTrustedFormalCampaignExecutionAuthority({
    paperId: context.paperTask.paperId,
    campaignId: context.campaignEvidenceContext.campaignId,
    researchNodeId: context.campaignEvidenceContext.researchNodeId,
    researchAttemptId: context.campaignEvidenceContext.researchAttemptId,
    researchLeaseGeneration:
      context.campaignEvidenceContext.researchLeaseGeneration,
    researchSourceSnapshotHash:
      context.campaignResearchSourceSnapshot
        .campaignResearchSourceSnapshotHash,
    formalNodeId: context.authoritativeFormalReceipt.formalNodeId,
    formalAttemptId: context.authoritativeFormalReceipt.formalAttemptId,
    formalLeaseGeneration:
      context.authoritativeFormalReceipt.formalLeaseGeneration,
    formalNodeResultHash: context.authoritativeFormalNode.resultSha256,
    formalVerificationReceiptHash:
      context.authoritativeFormalReceipt
        .campaignFormalVerificationReceiptHash,
    nativeResearchWorkerExecutionReportHash:
      context.nativeResearchWorkerExecution
        .nativeResearchWorkerExecutionReportHash,
  });
  assert.deepEqual(trustedFormalAuthorityBlockers({ authority, ...context }), []);
  assert.throws(
    () => issueTrustedFormalCampaignExecutionAuthority(),
    /trusted_formal_campaign_execution_authority_input_invalid/,
  );
  assert.deepEqual(uniqueTrustedFormalBlockers([
    null, 'duplicate', 'duplicate', 7, '', undefined,
  ]), ['duplicate', '7']);

  const forged = {
    ...authority,
    trustedFormalCampaignExecutionAuthorityHash:
      digest('forged-authority-hash'),
  };
  const forgedBlockers = trustedFormalAuthorityBlockers({
    authority: forged,
    paperTask: { paperId: 'paper-other' },
    campaignEvidenceContext: {
      campaignId: 'campaign-other',
      researchNodeId: 'research-node-other',
      researchAttemptId: 'research-attempt-other',
      researchLeaseGeneration: 99,
    },
    campaignResearchSourceSnapshot: {
      campaignResearchSourceSnapshotHash: digest('other-source-snapshot'),
    },
    authoritativeFormalReceipt: {
      formalNodeId: 'formal-node-other',
      formalAttemptId: 'formal-attempt-other',
      formalLeaseGeneration: 99,
      campaignFormalVerificationReceiptHash: digest('other-formal-receipt'),
    },
    authoritativeFormalNode: {
      resultSha256: digest('other-formal-node-result'),
    },
    nativeResearchWorkerExecution: {
      nativeResearchWorkerExecutionReportHash: digest('other-native-execution'),
    },
  });
  assert.deepEqual(forgedBlockers, [
    'trusted_formal_campaign_execution_authority_invalid',
    'trusted_formal_authority_paper_mismatch',
    'trusted_formal_authority_campaign_mismatch',
    'trusted_formal_authority_research_node_mismatch',
    'trusted_formal_authority_research_attempt_mismatch',
    'trusted_formal_authority_research_lease_mismatch',
    'trusted_formal_authority_source_snapshot_mismatch',
    'trusted_formal_authority_formal_node_mismatch',
    'trusted_formal_authority_formal_attempt_mismatch',
    'trusted_formal_authority_formal_lease_mismatch',
    'trusted_formal_authority_formal_node_result_mismatch',
    'trusted_formal_authority_formal_receipt_mismatch',
    'trusted_formal_authority_native_execution_mismatch',
  ]);

  const blocked = blockedTrustedFormalEvidence({
    phase: '',
    blockers: null,
    authorityHash: authority.trustedFormalCampaignExecutionAuthorityHash,
    canonicalRequestHash: digest('canonical-request'),
    externalActionId: 'external-action',
    requestHintCount: 1,
    executionPerformed: true,
    writesPerformed: true,
    partialMutation: true,
    sandboxReceipt: { status: 'fixture_sandbox_receipt' },
  });
  assert.equal(blocked.attempt.phase, 'preflight');
  assert.equal(blocked.attempt.executionPerformed, true);
  assert.equal(blocked.attempt.writesPerformed, true);
  assert.equal(blocked.attempt.partialMutation, true);
  assert.deepEqual(blocked.blockers, ['trusted_formal_evidence_blocked']);
  assert.equal(blocked.sandboxReceipt.status, 'fixture_sandbox_receipt');
});

test('trusted formal native projection inspection binds source, runtime, and request hints without issuing evidence', () => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-trusted-formal-projection-inspection-',
  ));
  try {
    const relativePath = 'proof.lean';
    const source = 'theorem inspectedTruth : True := by trivial\n';
    const sourceBytes = Buffer.byteLength(source);
    const sourceHash = hashBytes(Buffer.from(source));
    fs.writeFileSync(path.join(root, relativePath), source);
    const imageDigest = `sha256:${'a'.repeat(64)}`;
    const runtime = Object.freeze({
      image: `fixture@${imageDigest}`,
      imageDigest,
    });
    const toolchainRootMerkleHash =
      PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES[
        PRODUCTION_LEAN_TOOLCHAIN
      ];
    const toolchainContentIdentityHash = hashRecord(
      'TrustedFormalProjectionToolchainFixture',
      {},
    );
    const toolchainHash = hashRecord(
      'TrustedFormalProjectionToolchainFileFixture',
      {},
    );
    const projectManifestHash = hashRecord(
      'TrustedFormalProjectionManifestFixture',
      {},
    );
    const executionIdentity = Object.freeze({
      backend: 'docker',
      containerImageDigest: imageDigest,
    });
    const toolchainRuntimeIdentity = Object.freeze({
      status: 'lean_toolchain_identity_verified',
      toolchain: PRODUCTION_LEAN_TOOLCHAIN,
      toolchainRootMerkleHash,
      trustedToolchainRootMerkleHash: toolchainRootMerkleHash,
      leanToolchainContentIdentityHash: toolchainContentIdentityHash,
    });
    const result = Object.freeze({
      projectFiles: Object.freeze([Object.freeze({
        projectPath: relativePath,
        hash: sourceHash,
        bytes: sourceBytes,
      })]),
      projectManifestHash,
      executionIdentity,
      isolation: Object.freeze({
        immutableContainerImageVerified: true,
        kernelNetworkIsolationVerified: true,
        sourceReadOnlyVerified: true,
      }),
      toolchain: PRODUCTION_LEAN_TOOLCHAIN,
      toolchainHash,
      toolchainRuntimeIdentity,
      replayReceipt: Object.freeze({
        projectManifestHash,
        executionIdentity,
        toolchain: PRODUCTION_LEAN_TOOLCHAIN,
        toolchainHash,
        toolchainRuntimeIdentity: Object.freeze({
          leanToolchainContentIdentityHash: toolchainContentIdentityHash,
        }),
      }),
    });
    const nativeResearchWorkerExecution = Object.freeze({
      workerReceipts: Object.freeze([Object.freeze({
        workerType: 'formal_verifier_lake',
        inputs: Object.freeze([Object.freeze({
          path: relativePath,
          verified: true,
          hash: sourceHash,
          expectedHash: sourceHash,
        })]),
        result,
      })]),
    });
    const campaignResearchSourceSnapshot = Object.freeze({
      fileRecords: Object.freeze([Object.freeze({
        path: relativePath,
        hash: sourceHash,
        bytes: sourceBytes,
      })]),
    });
    const claimBindings = Object.freeze([Object.freeze({
      claimId: 'claim-inspected-truth',
      obligationId: 'obligation-inspected-truth',
      statementHash: hashRecord(
        'TrustedFormalProjectionStatementFixture',
        {},
      ),
    })]);
    const valid = inspectTrustedFormalNativeProjectionInputs({
      root,
      nativeResearchWorkerExecution,
      campaignResearchSourceSnapshot,
      runtime,
      claimBindings,
      requestHints: [Object.freeze({
        verifier_kind: 'lean',
        source_records: Object.freeze([Object.freeze({
          path: relativePath,
          sha256: sourceHash,
        })]),
        claim_bindings: Object.freeze(claimBindings.map((binding) => ({
          claim_id: binding.claimId,
          obligation_id: binding.obligationId,
          statement_hash: binding.statementHash,
        }))),
      })],
    });
    assert.deepEqual(valid.blockers, []);
    assert.equal(valid.source.absolutePath, path.join(root, relativePath));
    assert.equal(valid.source.read.hash, sourceHash);

    const malicious = inspectTrustedFormalNativeProjectionInputs({
      root,
      nativeResearchWorkerExecution,
      campaignResearchSourceSnapshot,
      runtime,
      claimBindings,
      requestHints: [
        {
          verifierKind: 'coq',
          command: '/tmp/untrusted-verifier',
          timeout_ms: 1,
          sourceRecords: [],
          claimBindings: [],
        },
        {},
      ],
    });
    for (const blocker of [
      'trusted_formal_request_hint_count_exceeded',
      'trusted_formal_request_verifier_authority_mismatch',
      'trusted_formal_request_execution_override_forbidden:command',
      'trusted_formal_request_execution_override_forbidden:timeout_ms',
      'trusted_formal_request_source_count_invalid',
      'trusted_formal_request_claim_bindings_mismatch',
    ]) assert.ok(malicious.blockers.includes(blocker), blocker);

    const mismatchedSource = inspectTrustedFormalNativeProjectionInputs({
      root,
      nativeResearchWorkerExecution,
      campaignResearchSourceSnapshot,
      runtime,
      claimBindings,
      requestHints: [{
        sourceRecords: [{ path: 'other.lean', hash: hashRecord(
          'TrustedFormalProjectionWrongSourceFixture',
          {},
        ) }],
      }],
    });
    assert.ok(mismatchedSource.blockers.includes(
      'trusted_formal_request_source_authority_mismatch',
    ));
    assert.ok(mismatchedSource.blockers.includes(
      'trusted_formal_request_source_hash_mismatch',
    ));

    const invalidNative = inspectTrustedFormalNativeProjectionInputs({
      root,
      nativeResearchWorkerExecution: { workerReceipts: [] },
      campaignResearchSourceSnapshot,
    });
    assert.ok(invalidNative.blockers.includes(
      'trusted_formal_authoritative_source_count_invalid',
    ));
    assert.ok(invalidNative.blockers.includes(
      'trusted_formal_native_docker_runtime_identity_mismatch',
    ));
    assert.ok(invalidNative.blockers.includes(
      'trusted_formal_native_toolchain_identity_mismatch',
    ));
    assert.equal(Object.hasOwn(valid, 'status'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('formal producer rejects legacy self-authorized execution', async (t) => {
  const f = fixture();
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
    const { expectedClaimBindings } = native;
    const produced = await produceTrustedFormalEvidence({
      root: f.root,
      paperTask: { paperId },
    });
    assert.equal(produced.status, 'trusted_formal_evidence_blocked');
    assert.equal(produced.attempt.executionPerformed, false);
    assert.equal(produced.attempt.writesPerformed, false);
    assert.ok(produced.blockers.includes(
      'trusted_formal_authoritative_formal_node_invalid',
    ));
    const fileRecords = [{
      path: native.sourcePath,
      mode: 0o644,
      hash: native.sourceHash,
      bytes: native.sourceBytes,
    }];
    const verifiedSourceMerkleHash =
      workspaceExecutionMerkleHash(fileRecords);
    const verifiedSourceWorkspaceManifestHash =
      workspaceExecutionManifestHash(fileRecords, []);
    const campaignResearchSourceSnapshot =
      buildCampaignResearchSourceSnapshot({
        campaignId,
        paperId,
        researchNodeId: 'research-node-1',
        researchAttemptId: 'research-attempt-1',
        researchLeaseGeneration: 1,
        verifiedSourceMerkleHash,
        verifiedSourceWorkspaceManifestHash,
        fileRecords,
        directoryRecords: [],
      });
    const campaignFormalSourceSnapshot =
      buildCampaignResearchSourceSnapshot({
        campaignId,
        paperId,
        researchNodeId: 'formal-node-1',
        researchAttemptId: 'formal-attempt-1',
        researchLeaseGeneration: 1,
        verifiedSourceMerkleHash,
        verifiedSourceWorkspaceManifestHash,
        fileRecords,
        directoryRecords: [],
      });
    const formalReceiptPayload = {
      version: 1,
      kind: 'CampaignFormalVerificationReceipt',
      status: 'campaign_formal_verification_completed',
      campaignId,
      paperId,
      formalNodeId: 'formal-node-1',
      formalAttemptId: 'formal-attempt-1',
      formalLeaseGeneration: 1,
      verifiedSourceMerkleHash,
      verifiedSourceWorkspaceManifestHash,
      campaignFormalSourceSnapshotHash:
        campaignFormalSourceSnapshot.campaignResearchSourceSnapshotHash,
      campaignFormalSourceSnapshot,
      nativeResearchWorkerExecutionReportHash:
        native.nativeResearchWorkerExecution
          .nativeResearchWorkerExecutionReportHash,
      nativeResearchWorkerExecution: native.nativeResearchWorkerExecution,
      proposalClaimToTheoremBinding: native.proposalBinding,
      blockers: [],
      externalActionPerformed: false,
    };
    const authoritativeFormalReceipt = Object.freeze({
      ...formalReceiptPayload,
      campaignFormalVerificationReceiptHash: hashRecord(
        'CampaignFormalVerificationReceipt',
        formalReceiptPayload,
      ),
    });
    const authoritativeFormalNode = Object.freeze({
      nodeId: 'formal-node-1',
      kind: 'formal-verify',
      status: 'completed',
      attemptId: 'formal-attempt-1',
      leaseGeneration: 1,
      resultSha256: hashRecord(
        'PaperCampaignNodeResult',
        authoritativeFormalReceipt,
      ),
      result: authoritativeFormalReceipt,
    });
    const intake = buildNativeFormalCertificateIntake({
      paperId,
      campaignId,
      researchSourceSnapshotHash:
        campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
      campaignResearchSourceSnapshot,
      claimBindings: expectedClaimBindings,
      authoritativeFormalReceipt,
      authoritativeFormalNode,
      authoritativeSource: {
        path: native.sourcePath,
        hash: native.sourceHash,
        bytes: native.sourceBytes,
        sourceReadReceiptHash: hashRecord('ScopedFileReadReceiptFixture', {
          path: native.sourcePath,
          hash: native.sourceHash,
        }),
      },
      nativeResearchWorkerExecution: native.nativeResearchWorkerExecution,
      receiptLedger: f.reader,
    }, {
      expectedPaperId: paperId,
      expectedCampaignId: campaignId,
      expectedResearchSourceSnapshotHash:
        campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
      expectedClaimBindings,
      expectedTaskKey: taskKey,
      expectedProposalBinding: native.proposalBinding,
      expectedAuthoritativeFormalNode: authoritativeFormalNode,
    });
    assert.equal(intake.status, 'formal_certificate_intake_verified', JSON.stringify(intake.blockers));
    assert.equal(intake.version, 4);
    assert.equal(intake.authoritativeFormalNodeResultHash,
      authoritativeFormalNode.resultSha256);
    assert.equal(intake.trustedNativeFormalReceiptVerified, true);
    const closureContext = {
      paperId,
      campaignId,
      researchSourceSnapshotHash:
        campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
      campaignResearchSourceSnapshot,
      taskKey,
      expectedClaimBindings,
      proposalBinding: native.proposalBinding,
      nativeResearchWorkerExecution: native.nativeResearchWorkerExecution,
      authoritativeFormalNode,
      trustedNativeFormalReceiptHashes: [
        native.receipt.nativeResearchWorkerExecutionReceiptHash,
      ],
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
      researchSourceSnapshotHash:
        campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
      campaignResearchSourceSnapshot,
      expectedFormalClaimBindings: expectedClaimBindings,
      proposalClaimToTheoremBinding: native.proposalBinding,
      authoritativeFormalNode,
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
      }, 'native_formal_intake_projection_binding_invalid'],
      ['wrong source snapshot', (value) => {
        value.researchSourceSnapshotHash = hashRecord('WrongSourceSnapshot', {});
      }, 'native_formal_intake_projection_binding_invalid'],
      ['wrong statement', (value) => {
        value.claimBindings[0].statementHash = hashRecord('WrongStatement', {});
      }, 'native_formal_intake_claim_bindings_invalid'],
      ['wrong obligation', (value) => {
        value.claimBindings[0].obligationId = `obligation:${'b'.repeat(64)}`;
      }, 'native_formal_intake_claim_bindings_invalid'],
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

    await t.test('outer reseal cannot alter the authoritative source', () => {
      const changed = structuredClone(intake);
      changed.authoritativeSource.bytes += 1;
      const verification = verifyGenericFormalCertificateIntakeClosureBinding(
        sealIntake(changed),
        closureContext,
      );
      assert.equal(verification.valid, false);
      assert.ok(verification.blockers
        .includes('native_formal_intake_authoritative_source_invalid'));
    });

    await t.test('deleted strong field is rejected after outer reseal', () => {
      const changed = structuredClone(intake);
      delete changed.authoritativeFormalNodeResultHash;
      const verification = verifyGenericFormalCertificateIntakeClosureBinding(
        sealIntake(changed),
        closureContext,
      );
      assert.equal(verification.valid, false);
      assert.ok(verification.blockers
        .includes('native_formal_intake_record_invalid'));
    });

    await t.test('replacement formal receipt cannot escape node binding', () => {
      const changed = structuredClone(intake);
      const replacement = structuredClone(
        changed.authoritativeFormalReceipt,
      );
      delete replacement.campaignFormalVerificationReceiptHash;
      replacement.formalAttemptId = 'formal-attempt-replacement';
      replacement.campaignFormalVerificationReceiptHash = hashRecord(
        'CampaignFormalVerificationReceipt',
        replacement,
      );
      changed.authoritativeFormalReceipt = replacement;
      changed.campaignFormalVerificationReceiptHash =
        replacement.campaignFormalVerificationReceiptHash;
      const verification = verifyGenericFormalCertificateIntakeClosureBinding(
        sealIntake(changed),
        closureContext,
      );
      assert.equal(verification.valid, false);
      assert.ok(verification.blockers.includes(
        'native_formal_intake_authoritative_formal_node_invalid',
      ));
    });

    await t.test('claim manifest and hash tamper fail after outer reseal', () => {
      const changed = structuredClone(intake);
      changed.claimBindingsManifest.bindings[0].statementHash =
        hashRecord('WrongStatement', { manifest: true });
      delete changed.claimBindingsManifest.formalClaimBindingsHash;
      changed.claimBindingsManifest.formalClaimBindingsHash = hashRecord(
        'FormalClaimBindingsManifest',
        changed.claimBindingsManifest,
      );
      changed.claimBindingsHash =
        changed.claimBindingsManifest.formalClaimBindingsHash;
      const verification = verifyGenericFormalCertificateIntakeClosureBinding(
        sealIntake(changed),
        closureContext,
      );
      assert.equal(verification.valid, false);
      assert.ok(verification.blockers
        .includes('native_formal_intake_claim_manifest_invalid'));
    });

    await t.test('claim hash tamper fails after outer reseal', () => {
      const changed = structuredClone(intake);
      changed.claimBindingsHash = hashRecord('WrongClaimManifest', {});
      const verification = verifyGenericFormalCertificateIntakeClosureBinding(
        sealIntake(changed),
        closureContext,
      );
      assert.equal(verification.valid, false);
      assert.ok(verification.blockers
        .includes('native_formal_intake_claim_manifest_invalid'));
    });

    await t.test('self-reported native ledger trust receives no credit', () => {
      const verification = verifyGenericFormalCertificateIntakeClosureBinding(
        intake,
        {
          ...closureContext,
          trustedNativeFormalReceiptHashes: [],
        },
      );
      assert.equal(verification.valid, false);
      assert.ok(verification.blockers
        .includes('native_formal_intake_native_ledger_trust_required'));
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
        .includes('native_formal_intake_native_ledger_trust_required'));
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
  } finally {
    f.store.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

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
import { buildGenericFormalCertificateIntake } from '../../paper-domain/research/formal-certificate-intake.mjs';
import { buildFormalVerifierRegistry } from '../../paper-domain/research/formal-verifier-registry.mjs';
import { buildExperimentRegistry } from '../../paper-domain/research/experiment-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-trusted-producer-'));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'store.sqlite') });
  const clock = { nowIso: () => '2026-07-13T11:00:00.000Z' };
  const ledgers = composeTrustedReceiptLedgers({ store, clock });
  const reader = createSqliteReceiptLedger({ store, clock });
  const artifactRepositoryFactory = (scopeRoot) => createFilesystemArtifactRepository({ scopeRoot, casRoot: path.join(root, 'cas'), receiptLedger: ledgers.artifact, clock });
  return { root, store, clock, ledgers, reader, artifactRepositoryFactory };
}

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

test('formal producer binds real source, sandbox receipt, certificate CAS and trusted ledgers', async () => {
  const f = fixture();
  const outsideSource = path.join(path.dirname(f.root), `${path.basename(f.root)}-outside.lean`);
  try {
    const source = path.join(f.root, 'proof.lean');
    fs.writeFileSync(source, 'theorem truth : True := by trivial\n');
    fs.writeFileSync(outsideSource, 'theorem escaped : True := by trivial\n');
    const merkle = hashRecord('SourceMerkle', { stable: true });
    const runner = { run: () => ({ ok: true, receiptHash: hashRecord('OsSandboxWorkerReceipt', { formal: 1 }), runnerId: 'test-kernel-runner', backend: 'test', sourceMerkleHashBefore: merkle, sourceMerkleHashAfter: merkle, exitCode: 0, stdout: '', stderr: '', isolation: { kernelNetworkIsolationVerified: true, sourceReadOnlyVerified: true, ephemeralWorkRootVerified: true, separateOutputRootVerified: true } }) };
    const statementHash = hashRecord('Statement', 'truth');
    const produced = await produceTrustedFormalEvidence({ root: f.root, runtimeRoot: path.join(f.root, 'runtime'), paperTask: { paperId: 'paper-1' }, request: { verifierKind: 'lean', sourceRecords: [{ path: 'proof.lean' }], claimBindings: [{ claimId: 'claim-1', obligationId: 'proof-1', statementHash }] }, artifactRepositoryFactory: f.artifactRepositoryFactory, receiptWriters: f.ledgers.research, clock: f.clock, executableOverride: '/bin/true', runnerOverride: runner });
    assert.equal(produced.status, 'trusted_formal_evidence_recorded');
    const registry = buildFormalVerifierRegistry({ adapterReceipts: [produced.adapterReceipt], receiptLedger: f.reader });
    const request = produced.certificateRequest;
    const intake = buildGenericFormalCertificateIntake({ verifierKind: request.verifierKind, certificate: request.certificate, sourceRecords: request.sourceRecords, claimBindings: request.claimBindings, executionReceipt: request.executionReceipt, verifierRegistry: registry, receiptLedger: f.reader, artifactVerifier: verifyArtifactWriteReceiptSource });
    assert.equal(intake.status, 'formal_certificate_intake_verified', JSON.stringify(intake.blockers));
    const escaped = await produceTrustedFormalEvidence({ root: f.root, runtimeRoot: path.join(f.root, 'runtime'), paperTask: { paperId: 'paper-1' }, request: { verifierKind: 'lean', sourceRecords: [{ absolutePath: outsideSource }], claimBindings: [{ claimId: 'claim-1', obligationId: 'proof-1', statementHash }] }, artifactRepositoryFactory: f.artifactRepositoryFactory, receiptWriters: f.ledgers.research, clock: f.clock, executableOverride: '/bin/true', runnerOverride: runner });
    assert.equal(escaped.status, 'trusted_formal_evidence_blocked');
    assert.ok(escaped.blockers.includes('scoped_path_lexical_escape'));
  } finally {
    f.store.close();
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(outsideSource, { force: true });
  }
});

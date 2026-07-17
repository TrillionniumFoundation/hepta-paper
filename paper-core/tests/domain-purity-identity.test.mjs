import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { evaluateEmpiricalResultContract } from '../../paper-adapters/automation/empirical-contract-reader.mjs';
import {
  buildSourcePackageManifest,
  resolveSourcePackageContract,
} from '../../paper-adapters/build-package/source-package-contract-reader.mjs';
import {
  hashPaperRecord,
  hashPaperSemanticIdentity,
  verifyPaperRecordHash,
} from '../../paper-domain/contracts/primitives.mjs';
import { createPaperTask } from '../../paper-domain/contracts/workflow-contracts.mjs';
import { evaluateEvidenceReferenceValidity } from '../../paper-domain/evidence/evidence-reference-validity.mjs';

test('workflow semantic identity excludes explicit observation time without dropping it', () => {
  const first = createPaperTask({
    paperId: 'deterministic-paper',
    title: 'Deterministic paper',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const second = createPaperTask({
    paperId: 'deterministic-paper',
    title: 'Deterministic paper',
    createdAt: '2026-02-01T00:00:00.000Z',
  });
  assert.notEqual(first.taskHash, second.taskHash);
  assert.equal(first.semanticIdentityHash, second.semanticIdentityHash);
  assert.equal(first.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(second.createdAt, '2026-02-01T00:00:00.000Z');
  assert.equal(
    hashPaperSemanticIdentity('Observation', { value: 1, observedAt: first.createdAt }),
    hashPaperSemanticIdentity('Observation', { value: 1, observedAt: second.createdAt }),
  );
  const { taskHash, ...persistedTaskPayload } = first;
  assert.equal(verifyPaperRecordHash({
    kind: 'PaperTask',
    payload: persistedTaskPayload,
    recordHash: taskHash,
  }).valid, true);
});

test('persisted paper-record-v1 hash remains readable against a golden vector', () => {
  const payload = {
    version: 1,
    kind: 'PaperTask',
    paperId: 'golden',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const recordHash = 'sha256:ad642d01ab5c2636e3a92aa187c9ebe0e04fea33a78bf66cbb4a2158c3ab6f87';
  assert.equal(hashPaperRecord('PaperTask', payload), recordHash);
  assert.deepEqual(verifyPaperRecordHash({ kind: 'PaperTask', payload, recordHash }), {
    version: 1,
    policy: 'paper-record-v1',
    valid: true,
  });
});

test('time-sensitive domain policy fails closed without an injected reference time', () => {
  const report = evaluateEvidenceReferenceValidity({
    reference: {
      kind: 'EvidenceReceipt',
      status: 'verified',
      hash: 'sha256:evidence',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  });
  assert.equal(report.status, 'evidence_reference_invalid');
  assert.ok(report.blockers.includes('evidence_reference_time_required'));
});

test('empirical filesystem reader supplies immutable values to the domain contract', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-domain-empirical-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(evaluateEmpiricalResultContract({ outputDirectory: root }).status, 'empirical_result_contract_blocked');
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ accuracy: 0.9, loss: 0.1 }));
  fs.writeFileSync(path.join(root, 'results.csv'), 'metric,value\naccuracy,0.9\nloss,0.1\n');
  const receipt = evaluateEmpiricalResultContract({ outputDirectory: root, metricSchema: { minimumMetricCount: 2 } });
  assert.equal(receipt.status, 'empirical_result_schema_verified');
  assert.deepEqual(receipt.metrics.map((item) => item.path), ['accuracy', 'loss']);
});

test('source package reader snapshots files before pure manifest evaluation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-domain-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n');
  fs.writeFileSync(path.join(root, 'SOURCE_PACKAGE_CONTRACT.json'), JSON.stringify({
    version: 1,
    kind: 'SourcePackageContract',
    paperId: 'paper-1',
    files: [{ path: 'main.tex', role: 'main_tex', required: true }],
  }));
  const sourcePackageContract = resolveSourcePackageContract({
    sourceRoot: root,
    paperTask: { paperId: 'paper-1', mainTex: path.join(root, 'main.tex') },
  });
  const manifest = buildSourcePackageManifest({ sourceRoot: root, sourcePackageContract });
  assert.equal(sourcePackageContract.status, 'source_package_contract_verified');
  assert.equal(manifest.status, 'scoped_source_tree_verified');
  assert.equal(manifest.rows[0].path, 'main.tex');
});

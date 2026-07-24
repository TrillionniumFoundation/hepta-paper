import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createIndependentPdfRebuildVerifier,
} from '../../paper-adapters/build-package/independent-pdf-rebuild-verifier.mjs';
import {
  inspectWorkspaceExecutionSnapshot,
  sourceTreeExcludedNames,
} from '../../paper-adapters/runtime/execution-snapshot.mjs';
import {
  DETERMINISTIC_PDF_PAGE_TREE_PARSER_POLICY,
  DETERMINISTIC_PDF_PAGE_TREE_PARSER_POLICY_HASH,
} from '../../paper-domain/automation/deterministic-pdf-page-inspection-contract.mjs';
import {
  verifyIndependentPdfRebuildVerificationReceipt,
} from '../../paper-domain/automation/independent-pdf-rebuild-contract.mjs';
import { buildExecutorCapabilities }
  from '../../paper-ports/executor-capabilities.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildDeterministicPdfFixture }
  from './support/deterministic-pdf-fixture.mjs';

const H = (label) => hashRecord('IndependentPdfRebuildSemanticsTest', { label });

function workerRunner(rebuiltPdfBytes) {
  const runnerId = 'independent-pdf-rebuild-semantics-fixture-runner';
  const executionIdentity = Object.freeze({
    available: true,
    allowlisted: true,
    runtimeIdentityHash: H('runtime-identity'),
    runtimeType: 'fixture-runtime',
    executionClass: 'fixture-isolated-process',
    executableHash: H('latexmk-executable'),
    runtimeExecutableSnapshotHash: H('latexmk-snapshot'),
  });
  return Object.freeze({
    version: 4,
    kind: 'WorkerRunnerPort',
    runnerId,
    capabilities() {
      return buildExecutorCapabilities({
        executorId: runnerId,
        sandboxModes: ['fixture-isolated-process'],
        networkPolicy: 'none',
        workspaceIsolation: true,
        languages: ['latex'],
        receiptKinds: ['OsSandboxWorkerReceipt'],
      });
    },
    resolveExecutionRuntimeIdentity() { return executionIdentity; },
    async run(request) {
      const outputName = request.outputPaths[0];
      fs.writeFileSync(
        path.join(request.outputDirectory, outputName),
        rebuiltPdfBytes,
        { flag: 'wx', mode: 0o600 },
      );
      const executionProcessIdentity = Object.freeze({
        version: 1,
        kind: 'OsSandboxWorkerProcessIdentity',
        runnerId,
        processId: 'fixture-process',
      });
      const artifact = Object.freeze({
        path: outputName,
        sha256: hashBytes(rebuiltPdfBytes),
        bytes: rebuiltPdfBytes.length,
      });
      const payload = {
        version: 4,
        kind: 'OsSandboxWorkerReceipt',
        runnerId,
        backend: 'fixture',
        status: 'os_sandbox_worker_passed',
        exitCode: 0,
        sourceMutationDetected: false,
        sourceMerkleHashBefore: request.expectedSourceMerkleHash,
        sourceMerkleHashAfter: request.expectedSourceMerkleHash,
        workSourceMerkleHash: request.expectedSourceMerkleHash,
        sourceWorkspaceManifestHashBefore:
          request.expectedSourceWorkspaceManifestHash,
        sourceWorkspaceManifestHashAfter:
          request.expectedSourceWorkspaceManifestHash,
        workWorkspaceManifestHash: request.expectedSourceWorkspaceManifestHash,
        expectedSourceMerkleHash: request.expectedSourceMerkleHash,
        expectedSourceWorkspaceManifestHash:
          request.expectedSourceWorkspaceManifestHash,
        runtimeIdentityHash: executionIdentity.runtimeIdentityHash,
        runtimeExecutableSnapshotHash:
          executionIdentity.runtimeExecutableSnapshotHash,
        containerImageDigest: null,
        executionProcessIdentity,
        executionProcessIdentityHash: hashRecord(
          'OsSandboxWorkerProcessIdentity',
          executionProcessIdentity,
        ),
        isolation: Object.freeze({
          kernelNetworkIsolationVerified: true,
          filesystemNamespaceVerified: true,
          sourceReadOnlyVerified: true,
          ephemeralWorkRootVerified: true,
          separateOutputRootVerified: true,
          runtimeExecutableSnapshotVerified: true,
          resourceLimitsVerified: true,
        }),
        externalActionPerformed: false,
        declaredOutputPaths: Object.freeze([outputName]),
        declaredOutputsRestrictedToSeparateRoot: true,
        limits: Object.freeze({
          timeoutMs: request.timeoutMs,
          memoryBytes: request.memoryBytes,
          cpuSeconds: request.cpuSeconds,
          maximumPids: request.maximumProcesses,
          maximumOutputBytes: request.requestedMaximumOutputBytes,
        }),
        artifacts: Object.freeze([artifact]),
      };
      return Object.freeze({
        ...payload,
        receiptHash: hashRecord('OsSandboxWorkerReceipt', payload),
        blockers: Object.freeze([]),
        ok: true,
      });
    },
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-pdf-rebuild-semantics-'));
  const sourceWorkspace = path.join(root, 'source');
  const runtimeRoot = path.join(root, 'runtime');
  const finalOutputRoot = path.join(sourceWorkspace, 'automation-results', 'final');
  fs.mkdirSync(finalOutputRoot, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sourceWorkspace, 'main.tex'),
    '\\documentclass{article}\\begin{document}Bound source.\\end{document}\n',
  );
  const authoritativePdfBytes = buildDeterministicPdfFixture({
    marker: 'authoritative-pdf-with-distinct-metadata',
  });
  const authoritativePath = path.join(finalOutputRoot, 'main.pdf');
  fs.writeFileSync(authoritativePath, authoritativePdfBytes);
  const snapshot = inspectWorkspaceExecutionSnapshot(sourceWorkspace, {
    excludeNames: sourceTreeExcludedNames(sourceWorkspace),
  });
  assert.deepEqual(snapshot.blockers, []);
  const sourcePackageContractHash = H('source-package-contract');
  const sourceTreeManifestPayload = {
    version: 1,
    kind: 'ScopedSourceTreeManifest',
    sourcePackageContractHash,
    rows: snapshot.fileRecords.map((record) => Object.freeze({
      path: record.path,
      role: record.path === 'main.tex' ? 'main_tex' : 'source_file',
      required: true,
      hash: record.hash,
      bytes: record.bytes,
    })),
  };
  const sourceArchiveDefinition = Object.freeze({
    sourcePackageContractHash,
    sourceTreeManifestHash: hashRecord(
      'ScopedSourceTreeManifest',
      sourceTreeManifestPayload,
    ),
    archivedSourceMerkleHash: snapshot.merkleHash,
    sourceWorkspaceManifestHash: snapshot.manifestHash,
    sourceTreeManifest: Object.freeze(sourceTreeManifestPayload),
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    sourceWorkspace,
    runtimeRoot,
    sourceArchiveDefinition,
    authoritativePdf: Object.freeze({
      role: 'compiled_pdf',
      path: 'automation-results/final/main.pdf',
      hash: hashBytes(authoritativePdfBytes),
      sizeBytes: authoritativePdfBytes.length,
    }),
  };
}

async function rebuild(t, rebuiltPdfBytes, label) {
  const input = fixture(t);
  const verifier = createIndependentPdfRebuildVerifier({
    workerRunner: workerRunner(rebuiltPdfBytes),
    runtimeRoot: input.runtimeRoot,
  });
  return verifier.rebuild({
    ...input,
    rebuildRoot: path.join(input.runtimeRoot, label),
    paperId: 'paper',
    mainTex: 'main.tex',
    createdAt: '2026-07-23T00:00:00.000Z',
  });
}

function rehashReceipt(receipt, patch) {
  const {
    independentPdfRebuildVerificationReceiptHash: _claimedHash,
    ...payload
  } = { ...receipt, ...patch };
  return Object.freeze({
    ...payload,
    independentPdfRebuildVerificationReceiptHash: hashRecord(
      'IndependentPdfRebuildVerificationReceipt',
      payload,
    ),
  });
}

test('independent rebuild accepts non-bitwise-equal PDFs with the same parsed page count', async (t) => {
  const rebuiltPdfBytes = buildDeterministicPdfFixture({
    marker: 'independent-pdf-with-a-different-timestamp-or-metadata',
  });
  const result = await rebuild(t, rebuiltPdfBytes, 'valid');
  assert.equal(result.status, 'independent_pdf_rebuild_verified');
  assert.equal(result.receipt.rebuiltPdf.pageCount, 1);
  assert.equal(result.receipt.authoritativePdfPageCount, 1);
  assert.equal(result.receipt.parserPolicy, DETERMINISTIC_PDF_PAGE_TREE_PARSER_POLICY);
  assert.equal(
    result.receipt.parserPolicyHash,
    DETERMINISTIC_PDF_PAGE_TREE_PARSER_POLICY_HASH,
  );
  assert.equal(result.receipt.pageCountEqualityVerified, true);
  assert.equal(result.receipt.bitwiseEqualityAssessed, false);
  assert.notEqual(
    result.receipt.rebuiltPdf.hash,
    result.receipt.authoritativePdfHash,
  );
  for (const forged of [
    rehashReceipt(result.receipt, { parserPolicy: 'prefix-only-parser' }),
    rehashReceipt(result.receipt, { authoritativePdfPageCount: 2 }),
    rehashReceipt(result.receipt, { rebuiltPdfPageTreeParseVerified: false }),
  ]) {
    assert.equal(
      verifyIndependentPdfRebuildVerificationReceipt(forged).valid,
      false,
    );
  }
});

test('independent rebuild rejects a PDF prefix without a parseable page tree', async (t) => {
  const result = await rebuild(
    t,
    Buffer.from('%PDF-1.4\nnot a parseable compiled document\n%%EOF\n', 'latin1'),
    'prefix-only',
  );
  assert.equal(result.status, 'independent_pdf_rebuild_blocked');
  assert.ok(result.blockers.includes(
    'independent_pdf_rebuild_rebuilt_pdf_semantic_invalid',
  ));
});

test('independent rebuild rejects a parseable output with a different page count', async (t) => {
  const result = await rebuild(t, buildDeterministicPdfFixture({
    pageCount: 2,
    marker: 'wrong-page-count',
  }), 'page-count-mismatch');
  assert.equal(result.status, 'independent_pdf_rebuild_blocked');
  assert.deepEqual(result.blockers, ['independent_pdf_rebuild_page_count_mismatch']);
});

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildIndependentPdfRebuildCommand,
  buildIndependentPdfRebuildToolIdentity,
  buildIndependentPdfRebuildVerificationReceipt,
} from '../../../paper-domain/automation/independent-pdf-rebuild-contract.mjs';
import { createIndependentPdfRebuildVerifierCapability }
  from '../../../paper-ports/independent-pdf-rebuild-verifier-port.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';
import {
  inspectDeterministicPdfPageTree,
} from '../../../paper-domain/automation/deterministic-pdf-page-tree-parser.mjs';
import {
  buildDeterministicPdfFixture,
} from '../support/deterministic-pdf-fixture.mjs';

function contentHash(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

// Test-only trusted seam for release-handoff state-machine tests. It creates a
// distinct file under the verifier-owned rebuild root and emits the same typed
// receipt consumed by the real packager. Production composition never imports
// this fixture and continues to require the OS-sandboxed latexmk verifier.
export function createTrustedIndependentPdfRebuildVerifierFixture({
  fixtureId = 'campaign-release-handoff',
} = {}) {
  const identitySuffix = String(fixtureId || 'campaign-release-handoff');
  return createIndependentPdfRebuildVerifierCapability(async ({
    sourceWorkspace,
    sourceArchiveDefinition,
    rebuildRoot,
    paperId,
    mainTex,
    authoritativePdf,
    createdAt,
    signal,
  } = {}) => {
    if (signal?.aborted) throw new Error('trusted_pdf_rebuild_fixture_aborted');
    const outputRoot = path.join(path.resolve(rebuildRoot), 'output');
    fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    const outputName = `${path.basename(mainTex, '.tex')}.pdf`;
    const output = path.join(outputRoot, outputName);
    const pdf = buildDeterministicPdfFixture({
      marker: `trusted independent rebuild fixture ${identitySuffix} ${sourceArchiveDefinition.archivedSourceMerkleHash}`,
    });
    fs.writeFileSync(output, pdf, { mode: 0o600, flag: 'wx' });
    const rebuiltPdfHash = contentHash(pdf);
    if (rebuiltPdfHash === authoritativePdf?.hash) {
      throw new Error('trusted_pdf_rebuild_fixture_not_independent');
    }
    const rebuiltPdfInspection = inspectDeterministicPdfPageTree(pdf);
    const authoritativePdfInspection = inspectDeterministicPdfPageTree(
      fs.readFileSync(path.resolve(sourceWorkspace, authoritativePdf.path)),
    );
    if (rebuiltPdfInspection.pageCount !== authoritativePdfInspection.pageCount) {
      throw new Error('trusted_pdf_rebuild_fixture_page_count_mismatch');
    }
    const receipt = buildIndependentPdfRebuildVerificationReceipt({
      paperId,
      sourcePackageContractHash: sourceArchiveDefinition.sourcePackageContractHash,
      sourceTreeManifestHash: sourceArchiveDefinition.sourceTreeManifestHash,
      sourceMerkleHash: sourceArchiveDefinition.archivedSourceMerkleHash,
      sourceWorkspaceManifestHash: sourceArchiveDefinition.sourceWorkspaceManifestHash,
      materializedSourceWorkspaceManifestHash:
        sourceArchiveDefinition.sourceWorkspaceManifestHash,
      mainTex,
      command: buildIndependentPdfRebuildCommand(mainTex),
      toolIdentity: buildIndependentPdfRebuildToolIdentity({
        runnerId: `trusted-test-fixture:${identitySuffix}`,
        runtimeIdentityHash: hashRecord('TrustedPdfRebuildFixtureRuntime', {
          fixtureId: identitySuffix,
        }),
        runtimeType: 'trusted-test-fixture',
        executionClass: 'test-only-independent-pdf-fixture',
        latexmkExecutableHash: hashRecord('TrustedPdfRebuildFixtureLatexmk', {
          fixtureId: identitySuffix,
        }),
      }),
      workerReceiptHash: hashRecord('TrustedPdfRebuildFixtureWorkerReceipt', {
        fixtureId: identitySuffix,
        rebuiltPdfHash,
      }),
      executionProcessIdentityHash: hashRecord(
        'TrustedPdfRebuildFixtureProcessIdentity',
        { fixtureId: identitySuffix },
      ),
      limits: {
        timeoutMs: 30_000,
        memoryBytes: 256 * 1024 * 1024,
        cpuSeconds: 30,
        maximumPids: 16,
        maximumOutputBytes: 16 * 1024 * 1024,
      },
      rebuiltPdf: {
        path: outputName,
        hash: rebuiltPdfHash,
        bytes: pdf.length,
        pageCount: rebuiltPdfInspection.pageCount,
      },
      authoritativePdfHash: authoritativePdf.hash,
      authoritativePdfPageCount: authoritativePdfInspection.pageCount,
      createdAt,
    });
    return Object.freeze({
      version: 1,
      kind: 'IndependentPdfRebuildVerificationResult',
      status: 'independent_pdf_rebuild_verified',
      receipt,
      rebuiltPdfPath: output,
      blockers: Object.freeze([]),
    });
  });
}

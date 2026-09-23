import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeManuscriptSurface } from '../../paper-domain/quality/manuscript-surface-analyzer.mjs';

test('manuscript analyzer extracts surfaces without a source mutation path', () => {
  const report = analyzeManuscriptSurface({ manuscriptText: '\\begin{theorem}T\\end{theorem}\nWe prove T from evidence receipt sha256:abc.', proofStatusText: 'Still Open: supporting lemma', evidenceManifestText: 'experiment artifact' });
  assert.ok(report.claimCount >= 1);
  assert.ok(report.proofObligationCount >= 1);
  assert.ok(report.evidenceReferenceCount >= 1);
  assert.equal(report.sourceMutationPerformed, false);
});

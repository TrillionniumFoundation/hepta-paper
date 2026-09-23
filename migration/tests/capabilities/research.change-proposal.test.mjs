import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResearchChangeProposal } from '../../../paper-domain/research/change-proposal.mjs';

test('research.change-proposal is hash-bound and never applies source', () => {
  const ready = buildResearchChangeProposal({ paperTask: { paperId: 'p' }, patches: [{ preimageHash: 'a', patchHash: 'b' }], evidenceQualityGate: { status: 'evidence_quality_ready' } });
  assert.equal(ready.status, 'research_change_proposal_ready');
  assert.equal(ready.sourceMutationPerformed, false);
  assert.equal(buildResearchChangeProposal({ patches: [{}], evidenceQualityGate: { status: 'evidence_quality_ready' } }).status, 'research_change_proposal_blocked');
});

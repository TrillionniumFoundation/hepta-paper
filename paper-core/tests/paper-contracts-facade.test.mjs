import assert from 'node:assert/strict';
import test from 'node:test';
import * as facade from '../../paper-domain/contracts/index.mjs';
import * as product from '../../paper-domain/contracts/product-profile.mjs';
import * as proposal from '../../paper-domain/contracts/proposal-contracts.mjs';
import * as research from '../../paper-domain/contracts/research-contracts.mjs';
import * as workflow from '../../paper-domain/contracts/workflow-contracts.mjs';
import * as venue from '../../paper-domain/contracts/venue-contracts.mjs';

test('paper-contracts remains a thin compatibility facade over bounded modules', () => {
  assert.equal(Object.keys(facade).length, 74);
  for (const module of [product, proposal, research, workflow, venue]) {
    for (const [name, value] of Object.entries(module)) assert.equal(facade[name], value, name);
  }
  const brief = proposal.createPaperIdeaBrief({ idea: 'Bounded contract modules' });
  assert.equal(brief.kind, 'PaperIdeaBrief');
  const task = workflow.createPaperTask({ paperId: 'fixture', canonicalDir: 'fixture' });
  assert.equal(task.kind, 'PaperTask');
  const claim = research.createClaimScopeContract({ paperTask: task, claims: ['claim'] });
  assert.equal(claim.kind, 'ClaimScopeContract');
});
